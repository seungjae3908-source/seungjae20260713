import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(apiRoot, '..');
const outputRoot = resolve(
  process.argv[2] ?? join(repositoryRoot, 'market-prediction-lab', 'runtime', 'authoritative-paper-runtime-v1'),
);
const bundlePath = join(outputRoot, 'authoritative-paper-runtime-v1.mjs');
const manifestPath = join(outputRoot, 'authoritative-paper-runtime-v1.manifest.json');

const CANONICAL_PRODUCER_SOURCE_COMMIT_SHA = '3dae58f78d1118bc5b9f5b431adbfa50d63d4f5c';
const CANONICAL_PRODUCER_SOURCE_GIT_BLOB_SHA = '7dc275b70f9379e32f3fd6c718a612b06ceb1c46';
const CANONICAL_PRODUCER_SOURCE_SHA256 = '8c7563936de865e9103d73d15c0442a44f1cf33426315e758abad83d96880e0c';
const PRODUCER_SOURCE = 'src/services/scanner-crypto-futures-paper-admission-evidence-producer.service.ts';
const ALLOWED_INPUTS = Object.freeze([
  '../market-intelligence-sidecar/src/execution-quality.mjs',
  '../market-prediction-lab/src/bitget-position-tier-v1.js',
  'src/data/asset-type.ts',
  'src/lib/bounded-work-pool.ts',
  'src/lib/provider-admission-control.ts',
  'src/services/authoritative-paper-callback-owners.service.ts',
  'src/services/authoritative-paper-evidence-sources.service.ts',
  'src/services/authoritative-paper-runtime-package.entry.ts',
  'src/services/bitget-futures-public-evidence.service.ts',
  'src/services/crypto-signal-scanner.service.ts',
  'src/services/forward-recommendation-observer-runtime.service.ts',
  'src/services/forward-recommendation-observer.service.ts',
  'src/services/market-price-precision.service.ts',
  'src/services/paper-trading-core.service.ts',
  'src/services/paper-simulated-execution-evidence.service.ts',
  'src/services/paper-trading-state-snapshot.service.ts',
  'src/services/public-market-http.ts',
  'src/services/scanner-candidate-ranking.service.ts',
  'src/services/scanner-canonical-paper-identity.service.ts',
  'src/services/scanner-crypto-futures-paper-admission-composer.service.ts',
  'src/services/scanner-crypto-futures-paper-admission-evidence-producer.service.ts',
  'src/services/scanner-crypto-price-precision.service.ts',
  'src/services/scanner-data-quality.service.ts',
  'src/services/scanner-indicator-library.service.ts',
  'src/services/scanner-market-action.service.ts',
  'src/services/scanner-market-profile-overlay.service.ts',
  'src/services/scanner-paper-admission-evidence-bundle.service.ts',
  'src/services/scanner-profit-cost-evidence-adapter.service.ts',
  'src/services/scanner-quant-hardening.service.ts',
  'src/services/scanner-quant-strategy.service.ts',
  'src/services/scanner-signal-lifecycle.service.ts',
  'src/services/scanner-strategy-profile.service.ts',
  'src/services/signal-performance-learning.service.ts',
  'src/services/strategy-promotion.service.ts',
  'src/services/trade-paper-market-contract.service.ts',
  'src/services/trading-risk-engine.service.ts',
].sort());

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sourceSha256(value) {
  return sha256(value.toString('utf8').replace(/\r\n/gu, '\n'));
}

function portable(value) {
  return value.split(sep).join('/');
}

function repositoryPath(inputPath) {
  const value = portable(relative(repositoryRoot, resolve(apiRoot, inputPath)));
  if (value === '..' || value.startsWith('../')) throw new Error('AUTHORITATIVE_PAPER_RUNTIME_INPUT_OUTSIDE_REPOSITORY');
  return value;
}

await mkdir(outputRoot, { recursive: true });
const result = await build({
  absWorkingDir: apiRoot,
  entryPoints: [join(apiRoot, 'src', 'services', 'authoritative-paper-runtime-package.entry.ts')],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'bundle',
  legalComments: 'none',
  charset: 'utf8',
  minify: false,
  sourcemap: false,
  metafile: true,
  logLevel: 'silent',
});

const actualInputs = Object.keys(result.metafile.inputs).map(portable).sort();
if (JSON.stringify(actualInputs) !== JSON.stringify(ALLOWED_INPUTS)) {
  throw new Error(`AUTHORITATIVE_PAPER_RUNTIME_INPUT_ALLOWLIST_MISMATCH:${actualInputs.join(',')}`);
}
if (actualInputs.some((path) => /(private|credential|secret|order-execution|account-readonly|supabase)/iu.test(path))) {
  throw new Error('AUTHORITATIVE_PAPER_RUNTIME_PRIVATE_AUTHORITY_INCLUDED');
}

const sourceDigests = {};
for (const source of actualInputs) {
  sourceDigests[source] = sourceSha256(await readFile(join(apiRoot, source)));
}
if (sourceDigests[PRODUCER_SOURCE] !== CANONICAL_PRODUCER_SOURCE_SHA256) {
  throw new Error('CANONICAL_PAPER_PRODUCER_SOURCE_SHA_MISMATCH');
}
const sourceRecords = actualInputs.map((inputPath) => ({
  inputPath,
  repositoryPath: repositoryPath(inputPath),
  sha256: sourceDigests[inputPath],
})).sort((left, right) => left.repositoryPath.localeCompare(right.repositoryPath));
const sourceGraphSha256 = sha256(sourceRecords.map((source) => `${source.repositoryPath}\0${source.sha256}\n`).join(''));
const bundle = await readFile(bundlePath);
const bundleSha256 = sha256(bundle);
const manifest = {
  schemaVersion: 'authoritative-paper-runtime-package-manifest-v1',
  artifactFile: portable(relative(outputRoot, bundlePath)),
  canonicalProducer: {
    version: 'scanner-crypto-futures-paper-admission-evidence-producer-v1',
    sourceFile: `api-server/${PRODUCER_SOURCE}`,
    sourceCommitSha: CANONICAL_PRODUCER_SOURCE_COMMIT_SHA,
    sourceGitBlobSha: CANONICAL_PRODUCER_SOURCE_GIT_BLOB_SHA,
    sourceSha256: CANONICAL_PRODUCER_SOURCE_SHA256,
  },
  sourceGraphSha256,
  sourceFiles: sourceRecords.map((source) => source.repositoryPath),
  sourceFileSha256: Object.fromEntries(sourceRecords.map((source) => [source.repositoryPath, source.sha256])),
  bundleSha256,
  admissionBundleSchemaVersion: 'scanner-paper-admission-evidence-bundle-v1',
  paperStateSnapshotSchemaVersion: 'paper-trading-state-snapshot-v2',
  callbackOwnerContractSchemaVersion: 'authoritative-paper-callback-owner-contract-v1',
  blockedDataSourceContractSchemaVersion: 'authoritative-paper-blocked-data-source-contract-v1',
  simulatedExecutionEvidenceSchemaVersion: 'paper-simulated-execution-evidence-v1',
  costPolicyVersion: null,
  costPolicyVersionBinding: {
    status: 'RUNTIME_EXACT_REQUIRED',
    candidateField: 'candidate.signal.strategyIdentity.costPolicyVersion',
    bundleField: 'bundle.executionEvidence.costPolicy.version',
    unknownIsZero: false,
  },
  exports: [
    'AUTHORITATIVE_PAPER_CALLBACK_OWNER_CONTRACT_VERSION',
    'AUTHORITATIVE_PAPER_CALLBACK_OWNERS_SAFETY',
    'AUTHORITATIVE_PAPER_CALLBACK_OWNERS_VERSION',
    'AUTHORITATIVE_PAPER_BLOCKED_DATA_SOURCE_CONTRACT_VERSION',
    'AUTHORITATIVE_PAPER_EVIDENCE_SOURCES_SAFETY',
    'AUTHORITATIVE_PAPER_EVIDENCE_SOURCES_VERSION',
    'AUTHORITATIVE_PAPER_RUNTIME_PACKAGE_SAFETY',
    'PAPER_TRADING_STATE_SNAPSHOT_VERSION',
    'PAPER_SIMULATED_EXECUTION_EVIDENCE_SAFETY',
    'PAPER_SIMULATED_EXECUTION_EVIDENCE_VERSION',
    'SCANNER_CRYPTO_FUTURES_PAPER_ADMISSION_EVIDENCE_PRODUCER_VERSION',
    'createAuthoritativePaperEvidenceSourceWiring',
    'createImmutablePaperTradingStateSnapshot',
    'buildPaperSimulatedExecutionEvidence',
    'buildAuthoritativePaperExecutionObservation',
    'buildAuthoritativeSizedContractRules',
    'buildAuthoritativeSupplementalCostEvidence',
    'createScannerCryptoFuturesPaperAdmissionEvidenceProducer',
    'validateImmutablePaperTradingStateSnapshot',
    'paperStateFromAuthoritativeSnapshot',
  ],
  safety: {
    executionAuthority: 'NONE',
    privateApiAllowed: false,
    liveTrading: false,
    scheduleActivationAuthority: false,
    financialMutationAllowed: false,
  },
};
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ bundlePath, manifestPath, bundleSha256, sourceGraphSha256 })}\n`);