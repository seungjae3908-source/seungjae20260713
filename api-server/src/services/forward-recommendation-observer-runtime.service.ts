import { createHash } from 'node:crypto';
import {
  FORWARD_OBSERVATION_SOURCE,
  advanceForwardRecommendationObservation,
  buildForwardObservationProfitCalibration,
  prepareForwardRecommendationObservation,
  type ForwardObservationProfitCalibration,
  type ForwardRecommendationObservation,
} from './forward-recommendation-observer.service';
import type { ScannerResponse, ScannerSignalCard } from './scanner-signal.types';
import type { SignalOutcomeBar } from './signal-performance-learning.service';

export const FORWARD_OBSERVER_RUNTIME_SCHEMA_VERSION = 1 as const;
export const FORWARD_OBSERVER_PROFILE_VERSION = 'forward-observer-swing-60m-v1' as const;
export const FORWARD_OBSERVER_TIMEFRAME = '60m' as const;
export const FORWARD_OBSERVER_DATA_MAX_AGE_MS = 90 * 60 * 1000;

export type ForwardObserverLaneId = 'KR_SWING_60M' | 'US_SWING_60M' | 'SPOT_SWING_60M' | 'FUTURES_SWING_60M';
export type ForwardObserverMarket = 'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES';

export type ForwardObserverLane = Readonly<{
  id: ForwardObserverLaneId;
  market: ForwardObserverMarket;
  scannerMarket: 'KR' | 'US' | 'spot' | 'futures';
  batchSize: number;
  timeframe: typeof FORWARD_OBSERVER_TIMEFRAME;
}>;

export const FORWARD_OBSERVER_LANES: readonly ForwardObserverLane[] = Object.freeze([
  { id: 'KR_SWING_60M', market: 'KR_STOCK', scannerMarket: 'KR', batchSize: 20, timeframe: FORWARD_OBSERVER_TIMEFRAME },
  { id: 'US_SWING_60M', market: 'US_STOCK', scannerMarket: 'US', batchSize: 20, timeframe: FORWARD_OBSERVER_TIMEFRAME },
  { id: 'SPOT_SWING_60M', market: 'CRYPTO_SPOT', scannerMarket: 'spot', batchSize: 20, timeframe: FORWARD_OBSERVER_TIMEFRAME },
  { id: 'FUTURES_SWING_60M', market: 'CRYPTO_FUTURES', scannerMarket: 'futures', batchSize: 20, timeframe: FORWARD_OBSERVER_TIMEFRAME },
]);

export type ForwardObserverRuntimeState = {
  schemaVersion: typeof FORWARD_OBSERVER_RUNTIME_SCHEMA_VERSION;
  researchCodeSha: string;
  createdAt: string;
  updatedAt: string;
  cursors: Record<ForwardObserverLaneId, number>;
  observations: ForwardRecommendationObservation[];
  safety: {
    publicDataOnly: true;
    artifactOnly: true;
    executionAuthority: 'NONE';
    financialMutationAllowed: false;
    liveOrderAllowed: false;
    privateTradingApiAllowed: false;
    profitabilityClaimAllowed: false;
  };
};

export type ForwardObserverLaneSummary = {
  laneId: ForwardObserverLaneId;
  cursorBefore: number;
  cursorAfter: number;
  scannerOutcome: string;
  scannedCards: number;
  readyObservations: number;
  noTrade: number;
  blocked: number;
  blockers: Record<string, number>;
};

export type ForwardObserverRuntimeSummary = {
  schemaVersion: 1;
  researchCodeSha: string;
  generatedAt: string;
  coverage: {
    markets: ForwardObserverMarket[];
    strategies: ['SWING'];
    timeframes: ['60m'];
    fullStrategyCoverage: false;
  };
  counts: {
    total: number;
    pending: number;
    settled: number;
    settledThisCycle: number;
    createdThisCycle: number;
    replayedThisCycle: number;
  };
  lanes: ForwardObserverLaneSummary[];
  calibrations: ForwardObservationProfitCalibration[];
  settlementErrors: Array<{ observationId: string; code: string }>;
  safety: ForwardObserverRuntimeState['safety'];
};

export type ForwardObserverRuntimeDependencies = {
  scanLane(lane: ForwardObserverLane, cursor: number): Promise<ScannerResponse>;
  loadFutureBars(observation: ForwardRecommendationObservation): Promise<SignalOutcomeBar[]>;
  now(): Date;
};

const SAFETY = Object.freeze({
  publicDataOnly: true as const,
  artifactOnly: true as const,
  executionAuthority: 'NONE' as const,
  financialMutationAllowed: false as const,
  liveOrderAllowed: false as const,
  privateTradingApiAllowed: false as const,
  profitabilityClaimAllowed: false as const,
});

function exactSha(value: string): boolean {
  return /^[0-9a-f]{40}$/u.test(value);
}

function iso(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

function assertObservationStateEnvelope(observation: ForwardRecommendationObservation, researchCodeSha: string): void {
  if (observation.schemaVersion !== 'forward-recommendation-observation-v1'
    || observation.source !== FORWARD_OBSERVATION_SOURCE
    || observation.identity.researchCodeSha !== researchCodeSha
    || observation.publicDataOnly !== true
    || observation.simulatedOnly !== true
    || observation.executionAuthority !== 'NONE'
    || observation.financialMutationAllowed !== false
    || observation.liveOrderAllowed !== false
    || observation.privateTradingApiAllowed !== false
    || observation.orderSubmitted !== false
    || observation.exchangeRequestSent !== false
    || observation.profitabilityClaimAllowed !== false
    || observation.snapshot.executionAuthority !== 'NONE') {
    throw new Error('FORWARD_OBSERVER_OBSERVATION_SAFETY_ENVELOPE_INVALID');
  }
  if (observation.snapshot.market !== observation.identity.market
    || observation.snapshot.strategyHorizon !== observation.identity.horizon
    || observation.snapshot.direction !== observation.identity.direction
    || observation.snapshot.strategyProfileVersion !== observation.identity.strategyProfileVersion
    || observation.snapshot.timeframes[0] !== observation.identity.timeframe) {
    throw new Error('FORWARD_OBSERVER_OBSERVATION_IDENTITY_MISMATCH');
  }
  if (observation.status === 'PENDING') {
    if (observation.outcome !== null || observation.settledAt !== null) throw new Error('FORWARD_OBSERVER_PENDING_STATE_INVALID');
  } else if (observation.status === 'SETTLED') {
    if (observation.outcome == null || iso(observation.settledAt) == null) throw new Error('FORWARD_OBSERVER_SETTLED_STATE_INVALID');
  } else {
    throw new Error('FORWARD_OBSERVER_OBSERVATION_STATUS_INVALID');
  }
}

export function createForwardObserverRuntimeState(researchCodeSha: string, now = new Date()): ForwardObserverRuntimeState {
  const sha = researchCodeSha.trim().toLowerCase();
  if (!exactSha(sha)) throw new Error('FORWARD_OBSERVER_IMMUTABLE_RESEARCH_SHA_REQUIRED');
  const at = now.toISOString();
  return {
    schemaVersion: FORWARD_OBSERVER_RUNTIME_SCHEMA_VERSION,
    researchCodeSha: sha,
    createdAt: at,
    updatedAt: at,
    cursors: { KR_SWING_60M: 0, US_SWING_60M: 0, SPOT_SWING_60M: 0, FUTURES_SWING_60M: 0 },
    observations: [],
    safety: { ...SAFETY },
  };
}

export function validateForwardObserverRuntimeState(state: ForwardObserverRuntimeState, researchCodeSha: string): void {
  const sha = researchCodeSha.trim().toLowerCase();
  if (state.schemaVersion !== FORWARD_OBSERVER_RUNTIME_SCHEMA_VERSION) throw new Error('FORWARD_OBSERVER_STATE_SCHEMA_UNSUPPORTED');
  if (!exactSha(sha) || state.researchCodeSha !== sha) throw new Error('FORWARD_OBSERVER_RESEARCH_SHA_MISMATCH');
  if (state.safety.publicDataOnly !== true || state.safety.artifactOnly !== true
    || state.safety.executionAuthority !== 'NONE' || state.safety.financialMutationAllowed !== false
    || state.safety.liveOrderAllowed !== false || state.safety.privateTradingApiAllowed !== false
    || state.safety.profitabilityClaimAllowed !== false) {
    throw new Error('FORWARD_OBSERVER_STATE_SAFETY_CONTRACT_VIOLATION');
  }
  for (const lane of FORWARD_OBSERVER_LANES) {
    const cursor = state.cursors[lane.id];
    if (!Number.isInteger(cursor) || cursor < 0) throw new Error('FORWARD_OBSERVER_CURSOR_INVALID');
  }
  const ids = new Set<string>();
  for (const observation of state.observations) {
    assertObservationStateEnvelope(observation, sha);
    if (ids.has(observation.observationId)) throw new Error('FORWARD_OBSERVER_DUPLICATE_STATE_ID');
    ids.add(observation.observationId);
  }
}

export function latestCardEvidenceTimestamp(card: ScannerSignalCard): string | null {
  const signalAt = Date.parse(card.observedAt);
  if (!Number.isFinite(signalAt)) return null;
  const matched = card.evidence.filter((item) => item.status === 'matched');
  if (matched.length === 0) return null;
  const values = matched.map((item) => iso(item.observedAt));
  if (values.some((value) => value == null)) return null;
  const timestamps = values as string[];
  if (timestamps.some((value) => Date.parse(value) > signalAt)) return null;
  timestamps.sort((left, right) => Date.parse(left) - Date.parse(right));
  return timestamps[0] ?? null;
}

export function laneParameterHash(lane: ForwardObserverLane): string {
  return createHash('sha256').update(JSON.stringify({
    schemaVersion: FORWARD_OBSERVER_RUNTIME_SCHEMA_VERSION,
    laneId: lane.id,
    market: lane.market,
    timeframe: lane.timeframe,
    strategy: 'SWING',
    batchSize: lane.batchSize,
    profile: FORWARD_OBSERVER_PROFILE_VERSION,
  })).digest('hex');
}

function countBlocker(target: Record<string, number>, blocker: string): void {
  target[blocker] = (target[blocker] ?? 0) + 1;
}

function nextCursor(response: ScannerResponse): number {
  const next = response.universe.nextCursor;
  return Number.isInteger(next) && Number(next) >= 0 ? Number(next) : 0;
}

function scannerOutcome(response: ScannerResponse): string {
  if (typeof response.outcome === 'string') return response.outcome;
  if (response.cards.length > 0) return 'CANDIDATES_AVAILABLE';
  return response.dataState === 'complete' ? 'VALID_ZERO_SIGNAL' : `DATA_${response.dataState.toUpperCase()}`;
}

function scannerResponseBlockers(response: ScannerResponse): string[] {
  const blockers: string[] = [];
  if (response.orderSubmitted !== false || response.exchangeRequestSent !== false) blockers.push('SCANNER_EXECUTION_SAFETY_VIOLATION');
  if (response.dataState !== 'complete') blockers.push('SCANNER_DATA_NOT_COMPLETE');
  if (response.execution.partial) blockers.push('SCANNER_PARTIAL_RESULT');
  if (response.execution.timedOut || response.execution.timeoutCount > 0) blockers.push('SCANNER_TIMEOUT');
  if (response.execution.cancelled) blockers.push('SCANNER_CANCELLED');
  if (response.execution.duplicate) blockers.push('SCANNER_DUPLICATE_RESULT');
  if (response.execution.providerErrorCount > 0 || response.failures.some((failure) => failure.reason === 'provider_error')) blockers.push('SCANNER_PROVIDER_ERROR');
  if (response.failures.length > 0) blockers.push('SCANNER_FAILURES_PRESENT');
  if (response.universe.partial) blockers.push('SCANNER_UNIVERSE_PARTIAL');
  if (response.universe.stale) blockers.push('SCANNER_UNIVERSE_STALE');
  return [...new Set(blockers)];
}

function calibrationGroups(observations: ForwardRecommendationObservation[]): ForwardObservationProfitCalibration[] {
  const groups = new Map<string, ForwardRecommendationObservation[]>();
  for (const observation of observations) {
    if (observation.status !== 'SETTLED') continue;
    const key = JSON.stringify(observation.identity);
    const rows = groups.get(key) ?? [];
    rows.push(observation);
    groups.set(key, rows);
  }
  return [...groups.values()].map((rows) => buildForwardObservationProfitCalibration(rows));
}

function futureOnlyBars(observation: ForwardRecommendationObservation, bars: SignalOutcomeBar[]): SignalOutcomeBar[] {
  const signalAt = Date.parse(observation.snapshot.timestamp);
  const seen = new Set<number>();
  return bars
    .filter((bar) => {
      const at = Date.parse(bar.timestamp);
      if (!Number.isFinite(at) || at <= signalAt || seen.has(at)) return false;
      if (![bar.high, bar.low, bar.close].every((value) => Number.isFinite(value) && value > 0)) return false;
      seen.add(at);
      return true;
    })
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
}

export async function runForwardRecommendationObserverCycle(input: {
  state: ForwardObserverRuntimeState;
  researchCodeSha: string;
  dependencies: ForwardObserverRuntimeDependencies;
}): Promise<{ state: ForwardObserverRuntimeState; summary: ForwardObserverRuntimeSummary }> {
  const researchCodeSha = input.researchCodeSha.trim().toLowerCase();
  validateForwardObserverRuntimeState(input.state, researchCodeSha);
  const now = input.dependencies.now();
  const evaluatedAt = now.toISOString();
  const settlementErrors: Array<{ observationId: string; code: string }> = [];
  let settledThisCycle = 0;
  let replayedThisCycle = 0;

  const observations: ForwardRecommendationObservation[] = [];
  for (const observation of input.state.observations) {
    if (observation.status === 'SETTLED') {
      observations.push(observation);
      continue;
    }
    try {
      const bars = futureOnlyBars(observation, await input.dependencies.loadFutureBars(observation));
      const evidenceCompleteThrough = bars.at(-1)?.timestamp ?? observation.snapshot.timestamp;
      const advanced = advanceForwardRecommendationObservation({ observation, bars, evaluatedAt, evidenceCompleteThrough });
      observations.push(advanced.observation);
      if (advanced.status === 'SETTLED') settledThisCycle += 1;
      if (advanced.status === 'REPLAYED') replayedThisCycle += 1;
    } catch (error) {
      observations.push(observation);
      settlementErrors.push({
        observationId: observation.observationId,
        code: error instanceof Error ? error.message.split(':')[0] : 'SETTLEMENT_FAILED',
      });
    }
  }

  const existingIds = new Set(observations.map((item) => item.observationId));
  const cursors = { ...input.state.cursors };
  const lanes: ForwardObserverLaneSummary[] = [];
  let createdThisCycle = 0;

  for (const lane of FORWARD_OBSERVER_LANES) {
    const cursorBefore = cursors[lane.id] ?? 0;
    let response: ScannerResponse;
    try {
      response = await input.dependencies.scanLane(lane, cursorBefore);
    } catch (error) {
      lanes.push({
        laneId: lane.id,
        cursorBefore,
        cursorAfter: cursorBefore,
        scannerOutcome: `SCAN_FAILURE:${error instanceof Error ? error.message.split(':')[0] : 'UNKNOWN'}`,
        scannedCards: 0,
        readyObservations: 0,
        noTrade: 0,
        blocked: 1,
        blockers: { SCAN_FAILURE: 1 },
      });
      continue;
    }

    const responseBlockers = scannerResponseBlockers(response);
    if (responseBlockers.length > 0) {
      lanes.push({
        laneId: lane.id,
        cursorBefore,
        cursorAfter: cursorBefore,
        scannerOutcome: scannerOutcome(response),
        scannedCards: response.cards.length,
        readyObservations: 0,
        noTrade: 0,
        blocked: 1,
        blockers: Object.fromEntries(responseBlockers.map((blocker) => [blocker, 1])),
      });
      continue;
    }

    cursors[lane.id] = nextCursor(response);
    let readyObservations = 0;
    let noTrade = 0;
    let blocked = 0;
    const blockers: Record<string, number> = {};
    for (const card of response.cards) {
      const dataTimestamp = latestCardEvidenceTimestamp(card);
      if (!dataTimestamp) {
        blocked += 1;
        countBlocker(blockers, 'DATA_TIMESTAMP_FROM_MATCHED_EVIDENCE_REQUIRED');
        continue;
      }
      const decision = prepareForwardRecommendationObservation({
        card,
        timeframe: lane.timeframe,
        strategyProfileVersion: FORWARD_OBSERVER_PROFILE_VERSION,
        parameterHash: laneParameterHash(lane),
        researchCodeSha,
        dataTimestamp,
        dataMaxAgeMs: FORWARD_OBSERVER_DATA_MAX_AGE_MS,
        publicDataOnly: true,
      });
      if (decision.status === 'NO_TRADE') {
        noTrade += 1;
        for (const blocker of decision.blockers) countBlocker(blockers, blocker);
        continue;
      }
      if (decision.status === 'BLOCKED' || !decision.observation) {
        blocked += 1;
        for (const blocker of decision.blockers) countBlocker(blockers, blocker);
        continue;
      }
      readyObservations += 1;
      if (!existingIds.has(decision.observation.observationId)) {
        observations.push(decision.observation);
        existingIds.add(decision.observation.observationId);
        createdThisCycle += 1;
      } else {
        replayedThisCycle += 1;
      }
    }
    lanes.push({
      laneId: lane.id,
      cursorBefore,
      cursorAfter: cursors[lane.id],
      scannerOutcome: scannerOutcome(response),
      scannedCards: response.cards.length,
      readyObservations,
      noTrade,
      blocked,
      blockers,
    });
  }

  const state: ForwardObserverRuntimeState = {
    schemaVersion: FORWARD_OBSERVER_RUNTIME_SCHEMA_VERSION,
    researchCodeSha,
    createdAt: input.state.createdAt,
    updatedAt: evaluatedAt,
    cursors,
    observations,
    safety: { ...SAFETY },
  };
  validateForwardObserverRuntimeState(state, researchCodeSha);
  const settled = observations.filter((item) => item.status === 'SETTLED').length;
  const summary: ForwardObserverRuntimeSummary = {
    schemaVersion: 1,
    researchCodeSha,
    generatedAt: evaluatedAt,
    coverage: {
      markets: FORWARD_OBSERVER_LANES.map((lane) => lane.market),
      strategies: ['SWING'],
      timeframes: ['60m'],
      fullStrategyCoverage: false,
    },
    counts: {
      total: observations.length,
      pending: observations.length - settled,
      settled,
      settledThisCycle,
      createdThisCycle,
      replayedThisCycle,
    },
    lanes,
    calibrations: calibrationGroups(observations),
    settlementErrors,
    safety: { ...SAFETY },
  };
  return { state, summary };
}
