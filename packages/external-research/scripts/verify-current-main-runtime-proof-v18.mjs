import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const DEPENDENCIES = Object.freeze({
  formulaCompiler: Object.freeze({
    ownerRef: '#550',
    capability: 'BOUNDED_FORMULA_COMPILER_V1',
    implementationPath: 'market-prediction-lab/src/autonomous-strategy-formula-generator-v1.js',
  }),
  canonicalBacktester: Object.freeze({
    ownerRef: '#690',
    capability: 'ONE_PASS_EXECUTION_EQUIVALENT_BACKTESTER_V1',
    implementationPath: 'market-prediction-lab/src/independent-strategy-backtest.js',
  }),
  statisticalFirewall: Object.freeze({
    ownerRef: '#547',
    capability: 'CANONICAL_STATISTICAL_FIREWALL_V1',
    implementationPath: 'market-prediction-lab/src/global-strategy-statistical-firewall-v1.js',
  }),
  statisticalFirewallAdapter: Object.freeze({
    ownerRef: '#547',
    capability: 'TOURNAMENT_STATISTICAL_FIREWALL_ADAPTER_V1',
    implementationPath: 'market-prediction-lab/src/research-tournament-statistical-firewall-adapter-v1.js',
  }),
});

const canonical = (value) => Array.isArray(value)
  ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    : value;

const digest = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const sha40 = (value) => typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

export function buildCurrentMainRuntimeProofV18({ currentMainSha, prHeadSha, verifiedAt }) {
  if (!sha40(currentMainSha) || !sha40(prHeadSha)) throw new Error('V18_RUNTIME_PROOF_SHA_INVALID');
  if (!Number.isFinite(Date.parse(verifiedAt)) || new Date(verifiedAt).toISOString() !== verifiedAt) {
    throw new Error('V18_RUNTIME_PROOF_TIME_INVALID');
  }

  const dependencies = {};
  for (const [key, expected] of Object.entries(DEPENDENCIES)) {
    let blobSha = null;
    try {
      blobSha = git(['rev-parse', `${currentMainSha}:${expected.implementationPath}`]).toLowerCase();
    } catch {
      blobSha = null;
    }
    dependencies[key] = Object.freeze({
      status: sha40(blobSha) ? 'PRESENT' : 'MISSING',
      ownerRef: expected.ownerRef,
      capability: expected.capability,
      implementationPath: expected.implementationPath,
      implementationBlobSha: sha40(blobSha) ? blobSha : null,
    });
  }

  const allPresent = Object.values(dependencies).every((row) => row.status === 'PRESENT');
  const core = {
    schemaVersion: 'research-canonical-evaluation-current-main-runtime-proof-v18',
    currentMainSha,
    prHeadSha,
    verifiedAt,
    dependencies,
    currentMainDependenciesPresent: allPresent,
    prHeadReconciliationRequired: currentMainSha !== prHeadSha,
    providerCalls: 0,
    compilerRuns: 0,
    backtestRuns: 0,
    finalHoldoutPreAccess: false,
    automaticAdoption: false,
    paperActivation: false,
    liveActivation: false,
    profitabilityProven: false,
    executionAuthority: 'NONE',
  };

  return Object.freeze({
    ...core,
    proofDigest: digest(core),
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const currentMainSha = String(process.argv[2] ?? '').trim().toLowerCase();
  const prHeadSha = String(process.argv[3] ?? '').trim().toLowerCase();
  const output = String(process.argv[4] ?? '').trim();
  if (!output) throw new Error('V18_RUNTIME_PROOF_OUTPUT_REQUIRED');
  const proof = buildCurrentMainRuntimeProofV18({
    currentMainSha,
    prHeadSha,
    verifiedAt: new Date().toISOString(),
  });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(output, `${JSON.stringify(proof, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({
    currentMainSha: proof.currentMainSha,
    prHeadSha: proof.prHeadSha,
    currentMainDependenciesPresent: proof.currentMainDependenciesPresent,
    prHeadReconciliationRequired: proof.prHeadReconciliationRequired,
    compilerRuns: proof.compilerRuns,
    backtestRuns: proof.backtestRuns,
    executionAuthority: proof.executionAuthority,
  })}\n`);
}
