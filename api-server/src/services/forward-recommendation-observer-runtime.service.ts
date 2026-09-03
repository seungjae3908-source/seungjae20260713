import {
  FORWARD_OBSERVATION_SOURCE,
  advanceForwardRecommendationObservation,
  buildForwardObservationProfitCalibration,
  forwardObservationIdentityKey,
  prepareForwardRecommendationObservation,
  type ForwardObservationIdentity,
  type ForwardObservationProfitCalibration,
  type ForwardRecommendationObservation,
} from './forward-recommendation-observer.service';
import {
  buildForwardCalibrationGrossEdgeEvidence,
  type ForwardGrossEdgeEvidence,
} from './forward-calibration-gross-edge.service';
import type { ScannerResponse, ScannerSignalCard } from './scanner-signal.types';
import type { SignalOutcomeBar } from './signal-performance-learning.service';

export const FORWARD_OBSERVER_RUNTIME_SCHEMA_VERSION = 1 as const;
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
  grossEdgeEvidence: ForwardGrossEdgeEvidence[];
  settlementErrors: Array<{ observationId: string; code: string }>;
  safety: ForwardObserverRuntimeState['safety'];
};

export type ForwardObserverRuntimeDependencies = {
  scanLane(lane: ForwardObserverLane, cursor: number): Promise<ScannerResponse>;
  loadFutureBars(observation: ForwardRecommendationObservation): Promise<SignalOutcomeBar[]>;
  now(): Date;
};

type CanonicalPaperCandidate = Readonly<{
  signal?: Readonly<{
    signalId?: unknown;
    market?: unknown;
    symbol?: unknown;
    timeframe?: unknown;
    horizon?: unknown;
    direction?: unknown;
    signalDirection?: unknown;
    style?: unknown;
    strategyIdentity?: Readonly<{
      strategyId?: unknown;
      strategyVersion?: unknown;
      parameterHash?: unknown;
      researchCodeSha?: unknown;
    }>;
  }>;
  paperIdentity?: Readonly<{
    signalId?: unknown;
    strategyId?: unknown;
    strategyVersion?: unknown;
    parameterHash?: unknown;
    researchCodeSha?: unknown;
    market?: unknown;
    symbol?: unknown;
    timeframe?: unknown;
    horizon?: unknown;
    direction?: unknown;
    executionAuthority?: unknown;
  }>;
  executionAuthority?: unknown;
  liveOrderAllowed?: unknown;
  privateTradingApiAllowed?: unknown;
  orderSubmitted?: unknown;
  exchangeRequestSent?: unknown;
}>;

type ForwardObservableScannerCard = ScannerSignalCard & Readonly<{
  paperCandidate?: CanonicalPaperCandidate;
}>;

export type ForwardCanonicalIdentityResolution = Readonly<{
  identity: ForwardObservationIdentity | null;
  blockers: readonly string[];
}>;

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

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function iso(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

function paperIdentityMismatch(blockers: string[], field: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) blockers.push(`PAPER_IDENTITY_${field}_MISMATCH`);
}

export function canonicalForwardStrategyIdentityFromCard(
  card: ScannerSignalCard,
  lane: ForwardObserverLane,
  researchCodeSha: string,
): ForwardCanonicalIdentityResolution {
  const blockers: string[] = [];
  const candidate = (card as ForwardObservableScannerCard).paperCandidate;
  if (!candidate || typeof candidate !== 'object') {
    return Object.freeze({ identity: null, blockers: Object.freeze(['CANONICAL_PAPER_CANDIDATE_REQUIRED']) });
  }

  if (candidate.executionAuthority != null && candidate.executionAuthority !== 'NONE') blockers.push('PAPER_CANDIDATE_EXECUTION_AUTHORITY_FORBIDDEN');
  if (candidate.liveOrderAllowed === true) blockers.push('PAPER_CANDIDATE_LIVE_ORDER_FORBIDDEN');
  if (candidate.privateTradingApiAllowed === true) blockers.push('PAPER_CANDIDATE_PRIVATE_API_FORBIDDEN');
  if (candidate.orderSubmitted === true) blockers.push('PAPER_CANDIDATE_REAL_ORDER_FORBIDDEN');
  if (candidate.exchangeRequestSent === true) blockers.push('PAPER_CANDIDATE_EXCHANGE_REQUEST_FORBIDDEN');

  const signal = candidate.signal;
  const strategy = signal?.strategyIdentity;
  if (!signal || typeof signal !== 'object') blockers.push('CANONICAL_PAPER_SIGNAL_REQUIRED');
  if (!strategy || typeof strategy !== 'object') blockers.push('CANONICAL_STRATEGY_IDENTITY_REQUIRED');

  const signalId = signal?.signalId;
  const market = signal?.market;
  const symbol = signal?.symbol;
  const timeframe = signal?.timeframe;
  const horizon = signal?.horizon;
  const direction = signal?.signalDirection ?? signal?.direction;
  const style = signal?.style;
  const strategyId = strategy?.strategyId;
  const strategyVersion = strategy?.strategyVersion;
  const parameterHash = strategy?.parameterHash;
  const strategyResearchSha = strategy?.researchCodeSha;

  if (!nonEmpty(signalId)) blockers.push('PAPER_SIGNAL_ID_REQUIRED');
  else if (signalId !== card.signalId) blockers.push('PAPER_SIGNAL_ID_MISMATCH');
  if (market !== lane.market) blockers.push('PAPER_MARKET_MISMATCH');
  if (!nonEmpty(symbol)) blockers.push('PAPER_SYMBOL_REQUIRED');
  else if (symbol !== card.symbol) blockers.push('PAPER_SYMBOL_MISMATCH');
  if (!nonEmpty(timeframe)) blockers.push('PAPER_TIMEFRAME_REQUIRED');
  else if (timeframe !== lane.timeframe) blockers.push('PAPER_TIMEFRAME_MISMATCH');
  if (!positiveInteger(horizon)) blockers.push('PAPER_HORIZON_REQUIRED');
  if (style != null && String(style).toUpperCase() !== 'SWING') blockers.push('PAPER_STRATEGY_STYLE_MISMATCH');
  if (!['BUY', 'SELL', 'LONG', 'SHORT'].includes(String(direction ?? ''))) blockers.push('PAPER_DIRECTION_REQUIRED');
  if (!nonEmpty(strategyId)) blockers.push('STRATEGY_ID_REQUIRED');
  if (!nonEmpty(strategyVersion)) blockers.push('STRATEGY_VERSION_REQUIRED');
  if (!nonEmpty(parameterHash)) blockers.push('PARAMETER_HASH_REQUIRED');
  if (!nonEmpty(strategyResearchSha) || !/^[0-9a-f]{40}$/iu.test(strategyResearchSha)) blockers.push('RESEARCH_CODE_SHA_REQUIRED');
  else if (strategyResearchSha.toLowerCase() !== researchCodeSha.toLowerCase()) blockers.push('RESEARCH_CODE_SHA_MISMATCH');

  if (blockers.length > 0
    || !nonEmpty(strategyId)
    || !nonEmpty(strategyVersion)
    || !nonEmpty(parameterHash)
    || !nonEmpty(strategyResearchSha)
    || !nonEmpty(symbol)
    || !nonEmpty(timeframe)
    || !positiveInteger(horizon)
    || !['BUY', 'SELL', 'LONG', 'SHORT'].includes(String(direction ?? ''))
    || market !== lane.market) {
    return Object.freeze({ identity: null, blockers: Object.freeze([...new Set(blockers)]) });
  }

  const identity: ForwardObservationIdentity = Object.freeze({
    strategyId,
    strategyVersion,
    parameterHash,
    researchCodeSha: strategyResearchSha.toLowerCase(),
    market: lane.market,
    symbol,
    timeframe,
    horizon,
    direction: direction as ForwardObservationIdentity['direction'],
  });

  const paper = candidate.paperIdentity;
  if (paper && typeof paper === 'object') {
    paperIdentityMismatch(blockers, 'SIGNAL_ID', paper.signalId, card.signalId);
    paperIdentityMismatch(blockers, 'STRATEGY_ID', paper.strategyId, identity.strategyId);
    paperIdentityMismatch(blockers, 'STRATEGY_VERSION', paper.strategyVersion, identity.strategyVersion);
    paperIdentityMismatch(blockers, 'PARAMETER_HASH', paper.parameterHash, identity.parameterHash);
    paperIdentityMismatch(blockers, 'MARKET', paper.market, identity.market);
    paperIdentityMismatch(blockers, 'SYMBOL', paper.symbol, identity.symbol);
    paperIdentityMismatch(blockers, 'TIMEFRAME', paper.timeframe, identity.timeframe);
    paperIdentityMismatch(blockers, 'HORIZON', paper.horizon, identity.horizon);
    paperIdentityMismatch(blockers, 'DIRECTION', paper.direction, identity.direction);
    const paperResearchSha = nonEmpty(paper.researchCodeSha) ? paper.researchCodeSha.toLowerCase() : paper.researchCodeSha;
    paperIdentityMismatch(blockers, 'RESEARCH_CODE_SHA', paperResearchSha, identity.researchCodeSha);
    if (paper.executionAuthority != null && paper.executionAuthority !== 'NONE') blockers.push('PAPER_IDENTITY_EXECUTION_AUTHORITY_FORBIDDEN');
  }

  return Object.freeze({
    identity: blockers.length === 0 ? identity : null,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

function assertObservationStateEnvelope(observation: ForwardRecommendationObservation, researchCodeSha: string): void {
  if (observation.schemaVersion !== 'forward-recommendation-observation-v2'
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
    || observation.snapshot.symbol !== observation.identity.symbol
    || observation.snapshot.direction !== observation.identity.direction
    || observation.snapshot.strategyProfileVersion !== observation.identity.strategyVersion
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

function settledObservationGroups(
  observations: readonly ForwardRecommendationObservation[],
): ForwardRecommendationObservation[][] {
  const groups = new Map<string, ForwardRecommendationObservation[]>();
  for (const observation of observations) {
    if (observation.status !== 'SETTLED') continue;
    const key = forwardObservationIdentityKey(observation.identity);
    const rows = groups.get(key) ?? [];
    rows.push(observation);
    groups.set(key, rows);
  }
  return [...groups.values()];
}

function calibrationGroups(observations: readonly ForwardRecommendationObservation[]): ForwardObservationProfitCalibration[] {
  return settledObservationGroups(observations)
    .map((rows) => buildForwardObservationProfitCalibration(rows));
}

export function buildForwardObserverRuntimeGrossEdgeEvidence(
  observations: readonly ForwardRecommendationObservation[],
  asOf: string,
): ForwardGrossEdgeEvidence[] {
  return settledObservationGroups(observations).map((rows) => {
    const calibration = buildForwardObservationProfitCalibration(rows);
    return buildForwardCalibrationGrossEdgeEvidence({ observations: rows, calibration, asOf });
  });
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

    const candidateCursor = nextCursor(response);
    let holdCursorForIdentity = false;
    let readyObservations = 0;
    let noTrade = 0;
    let blocked = 0;
    const blockers: Record<string, number> = {};
    for (const card of response.cards) {
      const identityResolution = canonicalForwardStrategyIdentityFromCard(card, lane, researchCodeSha);
      if (!identityResolution.identity) {
        blocked += 1;
        holdCursorForIdentity = true;
        for (const blocker of identityResolution.blockers) countBlocker(blockers, blocker);
        continue;
      }

      const dataTimestamp = latestCardEvidenceTimestamp(card);
      if (!dataTimestamp) {
        blocked += 1;
        countBlocker(blockers, 'DATA_TIMESTAMP_FROM_MATCHED_EVIDENCE_REQUIRED');
        continue;
      }
      const decision = prepareForwardRecommendationObservation({
        card,
        strategyIdentity: identityResolution.identity,
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
    cursors[lane.id] = holdCursorForIdentity ? cursorBefore : candidateCursor;
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
    grossEdgeEvidence: buildForwardObserverRuntimeGrossEdgeEvidence(observations, evaluatedAt),
    settlementErrors,
    safety: { ...SAFETY },
  };
  return { state, summary };
}
