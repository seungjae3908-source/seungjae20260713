export type ScannerSignalState =
  | 'DETECTED'
  | 'WATCHING'
  | 'READY_FOR_APPROVAL'
  | 'WEAKENED'
  | 'INVALIDATED'
  | 'EXPIRED';

export type ScannerDataState = 'complete' | 'partial' | 'stale' | 'unavailable';
export type ScannerChaseRisk = 'LOW' | 'ELEVATED' | 'UNAVAILABLE';

export type ScannerSignalObservation = {
  approvalCandidate: boolean;
  coreConditionsMaintained: boolean;
  dataState: ScannerDataState;
  observedAt: string;
  score: number;
  confidence: number;
  riskScore: number;
  dataCompleteness: number;
  chaseRisk: ScannerChaseRisk;
  reason: string;
};

export type ScannerSignalLifecycleEvent = {
  cycle: number;
  fromState: ScannerSignalState;
  toState: ScannerSignalState;
  reason: string;
  observedAt: string;
  createdAt: string;
};

export type ScannerSignalLifecycle = {
  ownerId: string;
  signalId: string;
  market: string;
  symbol: string;
  timeframe: string;
  cycle: number;
  state: ScannerSignalState;
  signalAt: string;
  expiresAt: string;
  lastObservedAt: string;
  score: number;
  confidence: number;
  riskScore: number;
  dataCompleteness: number;
  dataState: ScannerDataState;
  chaseRisk: ScannerChaseRisk;
  orderSubmitted: false;
  exchangeRequestSent: false;
  history: ScannerSignalLifecycleEvent[];
};

export type ScannerApprovalValidation = {
  allowed: boolean;
  reason: string | null;
  state: ScannerSignalState;
  cycle: number;
  orderSubmitted: false;
  exchangeRequestSent: false;
};

export const SCANNER_OBSERVATION_MAX_AGE_MS = 60_000;
const FUTURE_CLOCK_SKEW_MS = 60_000;

function timestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function event(
  signal: ScannerSignalLifecycle,
  toState: ScannerSignalState,
  reason: string,
  observedAt: string,
  now: number,
): ScannerSignalLifecycleEvent {
  return {
    cycle: signal.cycle,
    fromState: signal.state,
    toState,
    reason,
    observedAt,
    createdAt: new Date(now).toISOString(),
  };
}

function transition(
  signal: ScannerSignalLifecycle,
  toState: ScannerSignalState,
  observation: ScannerSignalObservation,
  now: number,
): ScannerSignalLifecycle {
  const changed = signal.state !== toState;
  return {
    ...signal,
    state: toState,
    lastObservedAt: observation.observedAt,
    score: observation.score,
    confidence: observation.confidence,
    riskScore: observation.riskScore,
    dataCompleteness: observation.dataCompleteness,
    dataState: observation.dataState,
    chaseRisk: observation.chaseRisk,
    orderSubmitted: false,
    exchangeRequestSent: false,
    history: changed
      ? [...signal.history, event(signal, toState, observation.reason, observation.observedAt, now)]
      : signal.history,
  };
}

function observationFailure(observation: ScannerSignalObservation, now: number): string | null {
  const observedAt = timestamp(observation.observedAt);
  if (observation.dataState !== 'complete') return `SIGNAL_DATA_${observation.dataState.toUpperCase()}`;
  if (!observation.coreConditionsMaintained) return 'SIGNAL_CORE_CONDITION_BROKEN';
  if (observedAt == null) return 'SIGNAL_OBSERVED_AT_INVALID';
  if (observedAt > now + FUTURE_CLOCK_SKEW_MS) return 'SIGNAL_OBSERVED_AT_FUTURE';
  if (now - observedAt > SCANNER_OBSERVATION_MAX_AGE_MS) return 'SIGNAL_DATA_STALE';
  return null;
}

export function createDetectedScannerSignal(input: {
  ownerId: string;
  signalId: string;
  market: string;
  symbol: string;
  timeframe: string;
  signalAt: string;
  expiresAt: string;
  observation: ScannerSignalObservation;
}, now = Date.now()): ScannerSignalLifecycle {
  if (!input.ownerId.trim()) throw new Error('SCANNER_SIGNAL_OWNER_REQUIRED');
  if (!input.signalId.trim()) throw new Error('SCANNER_SIGNAL_ID_REQUIRED');
  if (!input.market.trim() || !input.symbol.trim() || !input.timeframe.trim()) {
    throw new Error('SCANNER_SIGNAL_IDENTITY_REQUIRED');
  }
  const signalAt = timestamp(input.signalAt);
  const expiresAt = timestamp(input.expiresAt);
  if (signalAt == null || expiresAt == null || expiresAt <= signalAt || expiresAt <= now) {
    throw new Error('SCANNER_SIGNAL_EXPIRY_INVALID');
  }
  return {
    ownerId: input.ownerId,
    signalId: input.signalId,
    market: input.market,
    symbol: input.symbol,
    timeframe: input.timeframe,
    cycle: 1,
    state: 'DETECTED',
    signalAt: input.signalAt,
    expiresAt: input.expiresAt,
    lastObservedAt: input.observation.observedAt,
    score: input.observation.score,
    confidence: input.observation.confidence,
    riskScore: input.observation.riskScore,
    dataCompleteness: input.observation.dataCompleteness,
    dataState: input.observation.dataState,
    chaseRisk: input.observation.chaseRisk,
    orderSubmitted: false,
    exchangeRequestSent: false,
    history: [],
  };
}

export function applyScannerSignalObservation(
  signal: ScannerSignalLifecycle,
  observation: ScannerSignalObservation,
  now = Date.now(),
): ScannerSignalLifecycle {
  if (signal.state === 'INVALIDATED' || signal.state === 'EXPIRED') return signal;
  const expiresAt = timestamp(signal.expiresAt);
  if (expiresAt == null || expiresAt <= now) {
    return transition(signal, 'EXPIRED', { ...observation, reason: 'SIGNAL_EXPIRED' }, now);
  }
  const failure = observationFailure(observation, now);
  if (failure) {
    return transition(signal, 'INVALIDATED', { ...observation, reason: failure }, now);
  }
  if (signal.state === 'WEAKENED') return transition(signal, 'WEAKENED', observation, now);
  if (observation.approvalCandidate) {
    if (signal.state === 'DETECTED') return transition(signal, 'WATCHING', observation, now);
    if (signal.state === 'WATCHING') return transition(signal, 'READY_FOR_APPROVAL', observation, now);
    return transition(signal, 'READY_FOR_APPROVAL', observation, now);
  }
  if (signal.state === 'WATCHING' || signal.state === 'READY_FOR_APPROVAL') {
    return transition(signal, 'WEAKENED', observation, now);
  }
  return transition(signal, 'DETECTED', observation, now);
}

export function startNextScannerSignalCycle(
  signal: ScannerSignalLifecycle,
  observation: ScannerSignalObservation,
  now = Date.now(),
): ScannerSignalLifecycle {
  if (signal.state !== 'WEAKENED') throw new Error('SCANNER_NEW_CYCLE_REQUIRES_WEAKENED');
  const expiresAt = timestamp(signal.expiresAt);
  if (expiresAt == null || expiresAt <= now) throw new Error('SCANNER_SIGNAL_EXPIRED');
  const failure = observationFailure(observation, now);
  if (failure) throw new Error(failure);
  const next: ScannerSignalLifecycle = {
    ...signal,
    cycle: signal.cycle + 1,
    state: 'DETECTED',
    lastObservedAt: observation.observedAt,
    score: observation.score,
    confidence: observation.confidence,
    riskScore: observation.riskScore,
    dataCompleteness: observation.dataCompleteness,
    dataState: observation.dataState,
    chaseRisk: observation.chaseRisk,
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
  return {
    ...next,
    history: [...signal.history, event({ ...next, state: signal.state }, 'DETECTED', 'SIGNAL_NEW_CYCLE', observation.observedAt, now)],
  };
}

export function validateScannerSignalApproval(
  signal: ScannerSignalLifecycle,
  requestedCycle: number,
  now = Date.now(),
): ScannerApprovalValidation {
  let reason: string | null = null;
  if (requestedCycle !== signal.cycle) reason = 'SCANNER_PREVIOUS_CYCLE_REJECTED';
  else if (signal.state !== 'READY_FOR_APPROVAL') reason = `SCANNER_SIGNAL_${signal.state}`;
  else if (signal.dataState !== 'complete') reason = 'SCANNER_SIGNAL_DATA_NOT_COMPLETE';
  else if ((timestamp(signal.expiresAt) ?? 0) <= now) reason = 'SCANNER_SIGNAL_EXPIRED';
  else if (signal.orderSubmitted || signal.exchangeRequestSent) reason = 'SCANNER_ORDER_SIDE_EFFECT_DETECTED';
  return {
    allowed: reason == null,
    reason,
    state: signal.state,
    cycle: signal.cycle,
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
}

export function scannerSignalIdentity(signal: Pick<ScannerSignalLifecycle, 'ownerId' | 'market' | 'symbol' | 'timeframe' | 'signalId'>) {
  return [signal.ownerId, signal.market, signal.symbol, signal.timeframe, signal.signalId].join('|');
}
