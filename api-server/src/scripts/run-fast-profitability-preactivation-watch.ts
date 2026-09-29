import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ForwardObserverRuntimeState } from '../services/forward-recommendation-observer-runtime.service';
import {
  inspectFastProfitabilityPreActivationCandidatesV1,
  type FastProfitabilityPreActivationCandidateV1,
} from '../services/fast-profitability-activation.service';

const WATCH_STATE_CONTRACT = 'fast-profitability-preactivation-watch-state-v1' as const;
const WATCH_SUMMARY_CONTRACT = 'fast-profitability-preactivation-watch-summary-v1' as const;

type WatchState = Readonly<{
  schemaVersion: 1;
  contract: typeof WATCH_STATE_CONTRACT;
  targetSha: string;
  updatedAtMs: number;
  notifiedObservationIds: readonly string[];
  safety: Readonly<{
    publicDataOnly: true;
    autoActivationAllowed: false;
    activationBindingCreated: false;
    replayCredit: 0;
    backfillCredit: 0;
    syntheticCredit: 0;
    manualCredit: 0;
    profitabilityClaimAllowed: false;
    executionAuthority: 'NONE';
    liveTrading: false;
    autoTrading: false;
    realOrderEnabled: false;
    privateTradingApiAllowed: false;
  }>;
}>;

function argument(name: string): string | null {
  const prefix = `--${name}=`;
  const direct = process.argv.find((value) => value.startsWith(prefix));
  if (direct) return direct.slice(prefix.length).trim();
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] ?? '').trim() : null;
}

function required(name: string): string {
  const value = argument(name);
  if (!value) throw new Error(`FAST_PROFITABILITY_PREACTIVATION_WATCH_${name.toUpperCase().replace(/-/gu, '_')}_REQUIRED`);
  return value;
}

function validatePrevious(value: unknown, targetSha: string): WatchState {
  const state = value as Partial<WatchState>;
  if (state?.schemaVersion !== 1
    || state.contract !== WATCH_STATE_CONTRACT
    || state.targetSha !== targetSha
    || !Number.isSafeInteger(state.updatedAtMs)
    || Number(state.updatedAtMs) <= 0
    || !Array.isArray(state.notifiedObservationIds)
    || state.safety?.publicDataOnly !== true
    || state.safety?.autoActivationAllowed !== false
    || state.safety?.activationBindingCreated !== false
    || state.safety?.replayCredit !== 0
    || state.safety?.backfillCredit !== 0
    || state.safety?.syntheticCredit !== 0
    || state.safety?.manualCredit !== 0
    || state.safety?.profitabilityClaimAllowed !== false
    || state.safety?.executionAuthority !== 'NONE'
    || state.safety?.liveTrading !== false
    || state.safety?.autoTrading !== false
    || state.safety?.realOrderEnabled !== false
    || state.safety?.privateTradingApiAllowed !== false) {
    throw new Error('FAST_PROFITABILITY_PREACTIVATION_WATCH_PREVIOUS_STATE_INVALID');
  }
  return state as WatchState;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => String(value).trim()).filter(Boolean))].sort();
}

async function main(): Promise<void> {
  const targetSha = required('target-sha').toLowerCase();
  const observerStatePath = path.resolve(required('observer-state'));
  const outputDir = path.resolve(required('output-dir'));
  const previousWatchStatePath = argument('previous-watch-state');

  const observerState = JSON.parse(
    await readFile(observerStatePath, 'utf8'),
  ) as ForwardObserverRuntimeState;

  const inspectedAtMs = Date.now();
  const inspection = inspectFastProfitabilityPreActivationCandidatesV1({
    targetSha,
    observerState,
    inspectedAtMs,
  });

  let previous: WatchState | null = null;
  if (previousWatchStatePath) {
    previous = validatePrevious(
      JSON.parse(await readFile(path.resolve(previousWatchStatePath), 'utf8')),
      targetSha,
    );
  }

  const alreadyNotified = new Set(previous?.notifiedObservationIds ?? []);
  const newCandidates = inspection.candidates
    .filter((candidate) => !alreadyNotified.has(candidate.observationId));
  const notifiedObservationIds = uniqueSorted([
    ...alreadyNotified,
    ...inspection.candidates.map((candidate) => candidate.observationId),
  ]);

  const watchState: WatchState = Object.freeze({
    schemaVersion: 1,
    contract: WATCH_STATE_CONTRACT,
    targetSha,
    updatedAtMs: inspectedAtMs,
    notifiedObservationIds: Object.freeze(notifiedObservationIds),
    safety: Object.freeze({
      publicDataOnly: true,
      autoActivationAllowed: false,
      activationBindingCreated: false,
      replayCredit: 0,
      backfillCredit: 0,
      syntheticCredit: 0,
      manualCredit: 0,
      profitabilityClaimAllowed: false,
      executionAuthority: 'NONE',
      liveTrading: false,
      autoTrading: false,
      realOrderEnabled: false,
      privateTradingApiAllowed: false,
    }),
  });

  const selectedNewCandidate: FastProfitabilityPreActivationCandidateV1 | null =
    newCandidates[0] ?? null;
  const summary = Object.freeze({
    schemaVersion: 1 as const,
    contract: WATCH_SUMMARY_CONTRACT,
    targetSha,
    inspectedAtMs,
    selectionRule: inspection.selectionRule,
    candidateCount: inspection.candidateCount,
    newCandidateCount: newCandidates.length,
    selectedCandidate: inspection.selectedCandidate,
    selectedNewCandidate,
    newCandidates: Object.freeze(newCandidates),
    publicDataOnly: true as const,
    autoActivationAllowed: false as const,
    activationCommandCreated: false as const,
    activationBindingCreated: false as const,
    economicCreditCreated: 0 as const,
    validationCredit: 0 as const,
    oosCredit: 0 as const,
    profitabilityCredit: 0 as const,
    replayCredit: 0 as const,
    backfillCredit: 0 as const,
    syntheticCredit: 0 as const,
    manualCredit: 0 as const,
    profitabilityClaimAllowed: false as const,
    executionAuthority: 'NONE' as const,
    liveTrading: false as const,
    autoTrading: false as const,
    realOrderEnabled: false as const,
    privateTradingApiAllowed: false as const,
  });

  await mkdir(outputDir, { recursive: true });
  await writeFile(
    path.join(outputDir, 'watch-state.json'),
    `${JSON.stringify(watchState, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.join(outputDir, 'summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf8',
  );
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

main().catch((error) => {
  console.error(
    error instanceof Error
      ? error.message
      : 'FAST_PROFITABILITY_PREACTIVATION_WATCH_FAILED',
  );
  process.exitCode = 1;
});
