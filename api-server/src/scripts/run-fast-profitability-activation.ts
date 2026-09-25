import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ForwardObserverRuntimeState } from '../services/forward-recommendation-observer-runtime.service';
import {
  buildFastProfitabilityActivationBundleV1,
  verifyFastProfitabilityActivationBundleV1,
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
  if (!value) throw new Error(`FAST_PROFITABILITY_ACTIVATION_${name.toUpperCase().replace(/-/gu, '_')}_REQUIRED`);
  return value;
}

async function main(): Promise<void> {
  const targetSha = required('target-sha').toLowerCase();
  const observerStatePath = path.resolve(required('observer-state'));
  const outputDir = path.resolve(required('output-dir'));
  const keyOutput = path.resolve(required('key-output'));
  const approvalCommentId = required('approval-comment-id');
  const approvalActor = required('approval-actor');
  const approvalCommand = required('approval-command');
  const observerState = JSON.parse(await readFile(observerStatePath, 'utf8')) as ForwardObserverRuntimeState;
  const frozenAtMs = Date.now();

  const bundle = buildFastProfitabilityActivationBundleV1({
    targetSha,
    observerState,
    frozenAtMs,
    approval: {
      issueNumber: 1102,
      commentId: approvalCommentId,
      actor: approvalActor,
      command: approvalCommand,
    },
  });
  verifyFastProfitabilityActivationBundleV1(bundle);

  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(keyOutput), { recursive: true, mode: 0o700 });
  await mkdir(path.join(outputDir, 'fast-state', 'validation'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(outputDir, 'fast-state', 'sealed-oos'), { recursive: true, mode: 0o700 });

  const sealingKey = randomBytes(32).toString('base64');
  await writeFile(path.join(outputDir, 'binding.json'), `${JSON.stringify(bundle.binding, null, 2)}\n`, { mode: 0o600 });
  await writeFile(path.join(outputDir, 'policy.json'), `${JSON.stringify(bundle.policy, null, 2)}\n`, { mode: 0o600 });
  await writeFile(path.join(outputDir, 'observer-state.json'), `${JSON.stringify(observerState, null, 2)}\n`, { mode: 0o600 });
  await writeFile(keyOutput, `${sealingKey}\n`, { mode: 0o600 });

  const summary = Object.freeze({
    schemaVersion: 1,
    contract: 'fast-profitability-activation-summary-v1',
    status: 'ACTIVE_FUTURE_ONLY',
    targetSha: bundle.binding.targetSha,
    activationDigest: bundle.binding.activationDigest,
    policyDigest: bundle.binding.policyDigest,
    candidateDigest: bundle.binding.candidateDigest,
    candidateId: bundle.binding.candidateId,
    activationFrozenAtMs: bundle.binding.activationFrozenAtMs,
    eligibleAfterMs: bundle.binding.eligibleAfterMs,
    sourceObservationId: bundle.binding.sourceObservationId,
    selectionRule: bundle.binding.selectionRule,
    collectorCadenceMinutes: bundle.binding.collectorCadenceMinutes,
    validationCount: 0,
    sealedOosCount: 0,
    profitabilityCredit: 0,
    profitabilityProven: false,
    executionAuthority: 'NONE',
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
  });
  await writeFile(path.join(outputDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'FAST_PROFITABILITY_ACTIVATION_FAILED');
  process.exitCode = 1;
});
