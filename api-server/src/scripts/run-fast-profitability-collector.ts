import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ForwardObserverRuntimeState } from '../services/forward-recommendation-observer-runtime.service';
import {
  createFastProfitabilityCanonicalShadowReadbackAdapter,
  createFastProfitabilityEvidenceStore,
  createFastProfitabilityNaturalPaperReadbackAdapter,
  type FastProfitabilityPolicy,
} from '../services/fast-profitability-evidence-runtime.service';
import {
  collectFastProfitabilityForwardEvidenceV1,
  verifyFastProfitabilityActivationBundleV1,
  type FastProfitabilityActivationBinding,
  type FastProfitabilityActivationBundle,
} from '../services/fast-profitability-activation.service';

function argument(name: string): string | null {
  const prefix = `--${name}=`;
  const direct = process.argv.find((value) => value.startsWith(prefix));
  if (direct) return direct.slice(prefix.length).trim();
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] ?? '').trim() : null;
}

function required(name: string): string {
  const value = argument(name);
  if (!value) throw new Error(`FAST_PROFITABILITY_COLLECTOR_${name.toUpperCase().replace(/-/gu, '_')}_REQUIRED`);
  return value;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function countJsonFiles(root: string): Promise<number> {
  if (!(await exists(root))) return 0;
  const stack = [root];
  let count = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith('.json')) count += 1;
    }
  }
  return count;
}

async function readBundle(activationRoot: string): Promise<FastProfitabilityActivationBundle> {
  const binding = JSON.parse(
    await readFile(path.join(activationRoot, 'binding.json'), 'utf8'),
  ) as FastProfitabilityActivationBinding;
  const policy = JSON.parse(
    await readFile(path.join(activationRoot, 'policy.json'), 'utf8'),
  ) as FastProfitabilityPolicy;
  const bundle = Object.freeze({ binding, policy });
  verifyFastProfitabilityActivationBundleV1(bundle);
  return bundle;
}

async function parallelReadback(
  bundle: FastProfitabilityActivationBundle,
  parallelStateRoot: string | null,
  nowMs: number,
) {
  if (!parallelStateRoot) {
    return Object.freeze({
      status: 'DATA_BLOCKED',
      shadow: null,
      naturalPaper: null,
      settlement: null,
      fullCost: null,
      blockers: Object.freeze([
        'FAST_PROFITABILITY_SHADOW_OWNER_STATE_ROOT_MISSING',
        'FAST_PROFITABILITY_NATURAL_PAPER_OWNER_STATE_ROOT_MISSING',
        'FAST_PROFITABILITY_SETTLEMENT_AUTHORITATIVE_INPUT_MISSING',
        'FAST_PROFITABILITY_FULL_COST_AUTHORITATIVE_INPUT_MISSING',
      ]),
      profitabilityCredit: 0,
      executionAuthority: 'NONE',
    });
  }

  const context = Object.freeze({
    policy: bundle.policy,
    policyDigest: bundle.binding.policyDigest,
    candidateDigest: bundle.binding.candidateDigest,
    candidateId: bundle.binding.candidateId,
  });
  let shadow: unknown = null;
  let naturalPaper: unknown = null;
  const blockers: string[] = [];
  try {
    shadow = await createFastProfitabilityCanonicalShadowReadbackAdapter({
      stateRoot: parallelStateRoot,
      clock: () => nowMs,
    })(context);
  } catch {
    blockers.push('FAST_PROFITABILITY_SHADOW_OWNER_EVIDENCE_UNAVAILABLE');
  }
  try {
    naturalPaper = await createFastProfitabilityNaturalPaperReadbackAdapter({
      stateRoot: parallelStateRoot,
      clock: () => nowMs,
    })(context);
  } catch {
    blockers.push('FAST_PROFITABILITY_NATURAL_PAPER_EVIDENCE_UNAVAILABLE');
  }
  blockers.push(
    'FAST_PROFITABILITY_SETTLEMENT_AUTHORITATIVE_INPUT_MISSING',
    'FAST_PROFITABILITY_FULL_COST_AUTHORITATIVE_INPUT_MISSING',
  );
  return Object.freeze({
    status: blockers.length === 0 ? 'PRESENT' : 'DATA_BLOCKED',
    shadow,
    naturalPaper,
    settlement: null,
    fullCost: null,
    blockers: Object.freeze([...new Set(blockers)]),
    profitabilityCredit: 0,
    executionAuthority: 'NONE',
  });
}

async function main(): Promise<void> {
  const activationRoot = path.resolve(required('activation-root'));
  const observerStatePath = path.resolve(required('observer-state'));
  const outputDir = path.resolve(required('output-dir'));
  const previousStateRootRaw = argument('previous-state-root');
  const parallelStateRootRaw = argument('parallel-state-root');
  const previousStateRoot = previousStateRootRaw ? path.resolve(previousStateRootRaw) : null;
  const parallelStateRoot = parallelStateRootRaw ? path.resolve(parallelStateRootRaw) : null;

  const bundle = await readBundle(activationRoot);
  const observerState = JSON.parse(
    await readFile(observerStatePath, 'utf8'),
  ) as ForwardObserverRuntimeState;
  const sealingKeyText = (
    await readFile(path.join(activationRoot, 'private', 'sealing-key.b64'), 'utf8')
  ).trim();
  const sealingKey = Buffer.from(sealingKeyText, 'base64');
  if (sealingKey.length !== 32) throw new Error('FAST_PROFITABILITY_COLLECTOR_SEALING_KEY_INVALID');

  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const outputFastState = path.join(outputDir, 'fast-state');
  if (previousStateRoot) {
    const priorFastState = path.join(previousStateRoot, 'fast-state');
    if (await exists(priorFastState)) {
      await cp(priorFastState, outputFastState, { recursive: true, force: false, errorOnExist: false });
    }
  }
  await mkdir(path.join(outputFastState, 'validation'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(outputFastState, 'sealed-oos'), { recursive: true, mode: 0o700 });

  const store = createFastProfitabilityEvidenceStore({
    validationRoot: path.join(outputFastState, 'validation'),
    sealedOosRoot: path.join(outputFastState, 'sealed-oos'),
    sealingKey,
  });
  const nowMs = Date.now();
  const collection = await collectFastProfitabilityForwardEvidenceV1({
    bundle,
    observerState,
    store,
    recordedAtMs: nowMs,
  });
  const readiness = await store.summarize(bundle.policy);
  const validationCount = await countJsonFiles(path.join(outputFastState, 'validation'));
  const sealedOosCount = await countJsonFiles(path.join(outputFastState, 'sealed-oos'));
  const parallel = await parallelReadback(bundle, parallelStateRoot, nowMs);

  await writeFile(
    path.join(outputDir, 'observer-state.json'),
    `${JSON.stringify(observerState, null, 2)}\n`,
    { mode: 0o600 },
  );
  const summary = Object.freeze({
    schemaVersion: 1,
    contract: 'fast-profitability-collector-summary-v1',
    generatedAtMs: nowMs,
    targetSha: bundle.binding.targetSha,
    activationDigest: bundle.binding.activationDigest,
    policyDigest: bundle.binding.policyDigest,
    candidateDigest: bundle.binding.candidateDigest,
    candidateId: bundle.binding.candidateId,
    eligibleAfterMs: bundle.binding.eligibleAfterMs,
    collection,
    readiness,
    validationCount,
    sealedOosCount,
    parallel,
    replayCredit: 0,
    backfillCredit: 0,
    syntheticCredit: 0,
    manualCredit: 0,
    profitabilityCredit: 0,
    profitabilityProven: false,
    executionAuthority: 'NONE',
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
  });
  await writeFile(
    path.join(outputDir, 'summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    { mode: 0o600 },
  );
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  store.destroyKeyCopy();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'FAST_PROFITABILITY_COLLECTOR_FAILED');
  process.exitCode = 1;
});
