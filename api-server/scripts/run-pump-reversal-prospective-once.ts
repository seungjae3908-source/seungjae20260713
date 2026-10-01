import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  createPumpReversalProspectiveRuntimeDependencies,
} from '../src/services/pump-reversal-prospective-runtime-dependencies.service';
import type {
  SupplementalExecutionCostEvidence,
} from '../src/services/scanner-profit-cost-evidence-adapter.service';

// @ts-ignore -- canonical Prediction Lab JS is exact-head contract tested.
import { createPumpProspectivePaperRuntimeV1 as createRuntimeDefault } from '../../market-prediction-lab/src/crypto-pump-reversal-prospective-runtime-v1.js';
// @ts-ignore -- canonical Prediction Lab JS is exact-head contract tested.
import { runPumpProspectiveScheduledInvocationV1 as runInvocationDefault } from '../../market-prediction-lab/src/crypto-pump-reversal-prospective-store-v1.js';
// @ts-ignore -- canonical Prediction Lab JS is exact-head contract tested.
import { verifyPumpProspectivePolicyV1 as verifyPolicyDefault } from '../../market-prediction-lab/src/crypto-pump-reversal-prospective-policy-v1.js';

export const PUMP_REVERSAL_ONE_SHOT_RUNNER_VERSION =
  'pump-reversal-prospective-one-shot-v1' as const;

type JsonRecord = Record<string, any>;
type ReadJson = (path: string) => Promise<JsonRecord>;

type RuntimeDependenciesFactory =
  typeof createPumpReversalProspectiveRuntimeDependencies;

type RuntimeFactory = (input: Readonly<{
  sizePaperRisk: (...args: any[]) => any;
  settleFullCost: (...args: any[]) => any;
}>) => Readonly<{ run(input: any): Promise<any> }>;

type InvocationRunner = (input: Readonly<Record<string, any>>) => Promise<Readonly<Record<string, any>>>;

type PolicyVerifier = (policy: unknown) => Readonly<{
  valid: boolean;
  blockers: readonly string[];
}>;

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function absolutePath(value: unknown, code: string): string {
  if (!nonEmpty(value) || !isAbsolute(value)) throw new Error(code);
  return resolve(value);
}

async function defaultReadJson(path: string): Promise<JsonRecord> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new Error('PUMP_ONE_SHOT_READONLY_INPUT_UNREADABLE');
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('invalid');
    }
    return value as JsonRecord;
  } catch {
    throw new Error('PUMP_ONE_SHOT_READONLY_INPUT_JSON_INVALID');
  }
}

function safeOutput(result: Readonly<Record<string, any>>) {
  const runtime = result?.runtime;
  const summary = runtime?.summary ?? result?.receipt?.runtimeSummary ?? null;
  return Object.freeze({
    schemaVersion: PUMP_REVERSAL_ONE_SHOT_RUNNER_VERSION,
    status: result?.status ?? 'UNKNOWN',
    cycleId: result?.cycleId ?? null,
    runtimeStatus: runtime?.status ?? null,
    blockers: Array.isArray(runtime?.blockers) ? runtime.blockers : [],
    summary: summary == null ? null : Object.freeze({
      records: Number(summary.records ?? 0),
      waitingNextBar: Number(summary.waitingNextBar ?? 0),
      entryMissed: Number(summary.entryMissed ?? 0),
      openPositions: Number(summary.openPositions ?? 0),
      exitTriggered: Number(summary.exitTriggered ?? 0),
      riskSized: Number(summary.riskSized ?? 0),
      riskSizingExpired: Number(summary.riskSizingExpired ?? 0),
      prospectiveExecutionSamples: Number(summary.prospectiveExecutionSamples ?? 0),
      fullCostSettled: Number(summary.fullCostSettled ?? 0),
      netEconomicOutcomesAvailable: Number(summary.netEconomicOutcomesAvailable ?? 0),
      profitabilityProven: false,
      currentValidatedChampion: 'NONE',
    }),
    scheduleActive: false,
    financialMutationCount: 0,
    realOrderCount: 0,
    privateRequestCount: 0,
    executionAuthority: 'NONE',
    liveTrading: false,
    autoTrading: false,
    privateTradingApiAllowed: false,
    profitabilityProven: false,
    profitabilityClaimAllowed: false,
    sensitiveValuesEmitted: false,
  });
}

export async function runPumpReversalProspectiveOnce(input: Readonly<{
  stateRoot: string;
  policyPath: string;
  paperStateSnapshotPath: string;
  supplementalCostEvidencePath: string;
  ownerId?: string;
  now?: () => number;
  readJson?: ReadJson;
  runtimeDependenciesFactory?: RuntimeDependenciesFactory;
  runtimeFactory?: RuntimeFactory;
  invocationRunner?: InvocationRunner;
  verifyPolicy?: PolicyVerifier;
}>): Promise<ReturnType<typeof safeOutput>> {
  const stateRoot = absolutePath(input?.stateRoot, 'PUMP_ONE_SHOT_STATE_ROOT_REQUIRED');
  const policyPath = absolutePath(input?.policyPath, 'PUMP_ONE_SHOT_POLICY_PATH_REQUIRED');
  const paperStateSnapshotPath = absolutePath(
    input?.paperStateSnapshotPath,
    'PUMP_ONE_SHOT_PAPER_STATE_PATH_REQUIRED',
  );
  const supplementalCostEvidencePath = absolutePath(
    input?.supplementalCostEvidencePath,
    'PUMP_ONE_SHOT_SUPPLEMENTAL_COST_PATH_REQUIRED',
  );
  const ownerId = nonEmpty(input?.ownerId)
    ? input.ownerId.trim()
    : `pump-one-shot:${process.pid}`;
  const now = input?.now ?? Date.now;
  const readJson = input?.readJson ?? defaultReadJson;
  const runtimeDependenciesFactory = input?.runtimeDependenciesFactory
    ?? createPumpReversalProspectiveRuntimeDependencies;
  const runtimeFactory = input?.runtimeFactory
    ?? ((options) => createRuntimeDefault(options) as Readonly<{ run(input: any): Promise<any> }>);
  const invocationRunner = input?.invocationRunner ?? runInvocationDefault as InvocationRunner;
  const verifyPolicy = input?.verifyPolicy ?? verifyPolicyDefault as PolicyVerifier;

  if (typeof now !== 'function'
    || typeof readJson !== 'function'
    || typeof runtimeDependenciesFactory !== 'function'
    || typeof runtimeFactory !== 'function'
    || typeof invocationRunner !== 'function'
    || typeof verifyPolicy !== 'function') {
    throw new TypeError('Pump one-shot runner dependencies are required');
  }

  // Preflight every read-only input before a lease/cycle can be created.
  const [policy, paperStateSnapshot, supplementalCostEvidence] = await Promise.all([
    readJson(policyPath),
    readJson(paperStateSnapshotPath),
    readJson(supplementalCostEvidencePath),
  ]);
  const verdict = verifyPolicy(policy);
  if (!verdict?.valid) {
    throw new Error(`PUMP_ONE_SHOT_POLICY_INVALID:${(verdict?.blockers ?? []).join(',')}`);
  }
  if (!nonEmpty(policy?.candidate?.researchCodeSha)) {
    throw new Error('PUMP_ONE_SHOT_RESEARCH_SHA_REQUIRED');
  }

  // The callbacks intentionally re-read their source on each use so entry and
  // exit evidence cannot silently reuse a stale object captured at process start.
  const runtimeDependencies = runtimeDependenciesFactory({
    researchCodeSha: policy.candidate.researchCodeSha,
    paperStateSnapshotForRecord: async () => readJson(paperStateSnapshotPath),
    supplementalCostEvidenceForRecord: async () => (
      await readJson(supplementalCostEvidencePath)
    ) as SupplementalExecutionCostEvidence,
    now,
  });
  if (runtimeDependencies?.executionAuthority !== 'NONE'
    || runtimeDependencies?.liveTrading !== false
    || runtimeDependencies?.privateTradingApiAllowed !== false
    || runtimeDependencies?.financialMutationAllowed !== false
    || runtimeDependencies?.scheduleActivationAuthority !== false) {
    throw new Error('PUMP_ONE_SHOT_RUNTIME_AUTHORITY_INVALID');
  }

  // Preflight objects are intentionally referenced only to guarantee they were
  // readable before lease acquisition; authoritative validation remains owned
  // by the existing Paper state / cost evidence validators.
  void paperStateSnapshot;
  void supplementalCostEvidence;

  const runtime = runtimeFactory({
    sizePaperRisk: runtimeDependencies.sizePaperRisk,
    settleFullCost: runtimeDependencies.settleFullCost,
  });
  const nowMs = now();
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
    throw new Error('PUMP_ONE_SHOT_CLOCK_INVALID');
  }

  const result = await invocationRunner({
    rootDirectory: stateRoot,
    policy,
    nowMs,
    ownerId,
    runtime,
  });
  return safeOutput(result);
}

const invokedAsScript = Boolean(process.argv[1])
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  runPumpReversalProspectiveOnce({
    stateRoot: process.env.PUMP_PROSPECTIVE_STATE_ROOT ?? '',
    policyPath: process.env.PUMP_PROSPECTIVE_POLICY_PATH ?? '',
    paperStateSnapshotPath: process.env.PUMP_PAPER_STATE_SNAPSHOT_PATH ?? '',
    supplementalCostEvidencePath: process.env.PUMP_SUPPLEMENTAL_COST_EVIDENCE_PATH ?? '',
    ownerId: process.env.PUMP_PROSPECTIVE_OWNER_ID,
  }).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      schemaVersion: PUMP_REVERSAL_ONE_SHOT_RUNNER_VERSION,
      status: 'BLOCKED_DATA',
      code: error instanceof Error ? error.message : 'PUMP_ONE_SHOT_FAILED',
      executionAuthority: 'NONE',
      liveTrading: false,
      privateTradingApiAllowed: false,
      sensitiveValuesEmitted: false,
    })}\n`);
    process.exitCode = 1;
  });
}
