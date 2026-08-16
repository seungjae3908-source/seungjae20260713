import { createHash } from 'node:crypto';
import {
  createImmutableSignalSnapshot,
  evaluateSignalOutcome,
  type SignalMarketRegime,
  type SignalOutcomeBar,
  type SignalOutcomeEvaluation,
  type SignalPerformanceDirection,
  type SignalPerformanceHorizon,
  type SignalPerformanceMarket,
  type SignalSnapshot,
} from './signal-performance-learning.service';
import type { ScannerSignalCard, ScannerStrategyMode } from './scanner-signal.types';

export const FORWARD_OBSERVATION_SOURCE = 'LIVE_RECOMMENDATION' as const;
export const FORWARD_OBSERVATION_MINIMUM_SAMPLE_SIZE = 30;

const TERMINAL_SIGNAL_STATES = new Set([
  'CLOSED',
  'INVALIDATED',
  'EXPIRED',
  'REJECTED',
  'CANCELLED',
]);

export type ForwardObservationStatus = 'PENDING' | 'SETTLED';
export type ForwardObservationDecisionStatus = 'OBSERVATION_READY' | 'NO_TRADE' | 'BLOCKED';
export type ForwardCalibrationStatus = 'NOT_EVIDENCED' | 'INSUFFICIENT_SAMPLE' | 'INCOMPLETE_OUTCOME_CLASSES' | 'READY';

export type ForwardObservationIdentity = Readonly<{
  market: SignalPerformanceMarket;
  horizon: SignalPerformanceHorizon;
  direction: SignalPerformanceDirection;
  timeframe: string;
  strategyProfileVersion: string;
}>;

export type ForwardRecommendationObservation = Readonly<{
  schemaVersion: 'forward-recommendation-observation-v1';
  observationId: string;
  source: typeof FORWARD_OBSERVATION_SOURCE;
  status: ForwardObservationStatus;
  identity: ForwardObservationIdentity;
  signalGrade: 'S' | 'A';
  expiresAt: string;
  snapshot: SignalSnapshot;
  outcome: SignalOutcomeEvaluation | null;
  settledAt: string | null;
  executionAuthority: 'NONE';
  simulatedOnly: true;
  financialMutationAllowed: false;
  liveOrderAllowed: false;
  privateTradingApiAllowed: false;
  orderSubmitted: false;
  exchangeRequestSent: false;
  profitabilityClaimAllowed: false;
}>;

export type ForwardObservationDecision = Readonly<{
  schemaVersion: 'forward-recommendation-observer-decision-v1';
  status: ForwardObservationDecisionStatus;
  blockers: readonly string[];
  observation: ForwardRecommendationObservation | null;
  executionAuthority: 'NONE';
  financialMutationAllowed: false;
  liveOrderAllowed: false;
  privateTradingApiAllowed: false;
  orderSubmitted: false;
  exchangeRequestSent: false;
  profitabilityClaimAllowed: false;
}>;

export type ForwardObservationAdvance = Readonly<{
  schemaVersion: 'forward-recommendation-observer-advance-v1';
  status: 'PENDING' | 'SETTLED' | 'REPLAYED';
  blockers: readonly string[];
  observation: ForwardRecommendationObservation;
  executionAuthority: 'NONE';
  financialMutationAllowed: false;
  liveOrderAllowed: false;
  privateTradingApiAllowed: false;
  orderSubmitted: false;
  exchangeRequestSent: false;
}>;

export type ForwardObservationProfitCalibration = Readonly<{
  schemaVersion: 'forward-recommendation-profit-calibration-v1';
  source: typeof FORWARD_OBSERVATION_SOURCE;
  status: ForwardCalibrationStatus;
  identity: ForwardObservationIdentity | null;
  calibration: Readonly<{
    status: ForwardCalibrationStatus;
    sampleSize: number;
    tpFirstCount: number;
  }>;
  probabilities: Readonly<{ tp: number | null; sl: number | null; expire: number | null }>;
  returns: Readonly<{ target: number | null; stop: number | null; expire: number | null }>;
  counts: Readonly<{ tp: number; sl: number; expire: number; conservativeConflicts: number }>;
  costAdjusted: false;
  executionAuthority: 'NONE';
  financialMutationAllowed: false;
  liveOrderAllowed: false;
  privateTradingApiAllowed: false;
  profitabilityClaimAllowed: false;
}>;

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseTime(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a valid ISO timestamp`);
  return parsed;
}

function marketFromCard(card: ScannerSignalCard): SignalPerformanceMarket | null {
  const market = String(card.market ?? '').toUpperCase();
  if (card.assetClass === 'coin_spot') return 'CRYPTO_SPOT';
  if (card.assetClass === 'coin_futures') return 'CRYPTO_FUTURES';
  if (card.assetClass !== 'stock') return null;
  if (market === 'KR' || market === 'KR_STOCK') return 'KR_STOCK';
  if (market === 'US' || market === 'US_STOCK') return 'US_STOCK';
  return null;
}

function directionFromCard(card: ScannerSignalCard, market: SignalPerformanceMarket): SignalPerformanceDirection | null {
  const action = card.action;
  if (market === 'CRYPTO_FUTURES') return action === 'LONG' || action === 'SHORT' ? action : null;
  return action === 'BUY' || action === 'SELL' ? action : null;
}

function horizonFromMode(mode: ScannerStrategyMode | undefined): SignalPerformanceHorizon | null {
  if (mode === 'scalping') return 'SCALP';
  if (mode === 'swing') return 'SWING';
  if (mode === 'position') return 'POSITION';
  return null;
}

function regimeFromCard(card: ScannerSignalCard): SignalMarketRegime {
  switch (card.backtestQuality?.regime) {
    case 'Strong Bull':
    case 'Bull': return 'UPTREND';
    case 'Bear': return 'DOWNTREND';
    case 'Sideways': return 'SIDEWAYS';
    case 'High Volatility': return 'HIGH_VOL';
    case 'Low Volatility': return 'LOW_VOL';
    default: return 'UNKNOWN';
  }
}

function directionSign(direction: SignalPerformanceDirection): 1 | -1 {
  return direction === 'BUY' || direction === 'LONG' ? 1 : -1;
}

function priceStructureValid(entry: number, stop: number, target1: number, target2: number | null, direction: SignalPerformanceDirection): boolean {
  const sign = directionSign(direction);
  if ((target1 - entry) * sign <= 0 || (stop - entry) * sign >= 0) return false;
  if (target2 != null && (target2 - target1) * sign <= 0) return false;
  return true;
}

function decision(status: ForwardObservationDecisionStatus, blockers: string[], observation: ForwardRecommendationObservation | null = null): ForwardObservationDecision {
  return Object.freeze({
    schemaVersion: 'forward-recommendation-observer-decision-v1',
    status,
    blockers: Object.freeze([...new Set(blockers)]),
    observation,
    executionAuthority: 'NONE',
    financialMutationAllowed: false,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    profitabilityClaimAllowed: false,
  });
}

function observationId(snapshot: SignalSnapshot, timeframe: string): string {
  return createHash('sha256')
    .update(`${FORWARD_OBSERVATION_SOURCE}|${snapshot.signalId}|${snapshot.strategyProfileVersion}|${snapshot.timestamp}|${timeframe}`)
    .digest('hex');
}

export function prepareForwardRecommendationObservation(input: {
  card: ScannerSignalCard;
  timeframe: string;
  strategyProfileVersion: string;
  dataTimestamp: string;
}): ForwardObservationDecision {
  const { card } = input;
  if (card.signalGrade !== 'S' && card.signalGrade !== 'A') {
    return decision('NO_TRADE', ['SCANNER_GRADE_NOT_FORWARD_OBSERVABLE']);
  }
  if (card.strongSignalEligible !== true || TERMINAL_SIGNAL_STATES.has(card.signalState)) {
    return decision('NO_TRADE', ['SCANNER_SIGNAL_NOT_ACTIVE_STRONG']);
  }

  const blockers: string[] = [];
  const market = marketFromCard(card);
  if (!market) blockers.push('MARKET_UNSUPPORTED');
  const direction = market ? directionFromCard(card, market) : null;
  if (!direction) blockers.push('EXPLICIT_ACTION_REQUIRED');
  const horizon = horizonFromMode(card.strategyMode);
  if (!horizon) blockers.push('STRATEGY_HORIZON_REQUIRED');
  if (!nonEmpty(input.timeframe)) blockers.push('TIMEFRAME_REQUIRED');
  if (!nonEmpty(input.strategyProfileVersion)) blockers.push('STRATEGY_PROFILE_VERSION_REQUIRED');
  if (!nonEmpty(card.signalId) || !nonEmpty(card.symbol)) blockers.push('SIGNAL_IDENTITY_REQUIRED');
  if (!Array.isArray(card.dataSources) || card.dataSources.length === 0 || card.dataSources.some((source) => !nonEmpty(source))) blockers.push('DATA_PROVENANCE_REQUIRED');
  if (card.dataState !== 'complete') blockers.push('DATA_STATE_NOT_COMPLETE');
  if (card.dataQuality?.state === 'DATA_UNTRUSTED' || card.dataQuality?.strongSignalAllowed === false) blockers.push('DATA_QUALITY_BLOCKED');

  const observedAtMs = parseTime(card.observedAt, 'observedAt');
  const dataTimestampMs = parseTime(input.dataTimestamp, 'dataTimestamp');
  const expiresAtMs = parseTime(card.expiresAt, 'expiresAt');
  if (dataTimestampMs > observedAtMs) blockers.push('LOOKAHEAD_DATA_TIMESTAMP');
  if (expiresAtMs <= observedAtMs) blockers.push('INVALID_SIGNAL_EXPIRY');

  const entry = card.price;
  const stop = card.pricePlan?.stopLoss;
  const target1 = card.pricePlan?.targets?.[0];
  const target2 = card.pricePlan?.targets?.[1] ?? null;
  if (!positive(entry)) blockers.push('REFERENCE_PRICE_REQUIRED');
  if (!positive(stop)) blockers.push('STOP_LOSS_REQUIRED');
  if (!positive(target1)) blockers.push('TARGET1_REQUIRED');
  if (target2 != null && !positive(target2)) blockers.push('TARGET2_INVALID');
  if (positive(entry) && positive(stop) && positive(target1) && direction
    && !priceStructureValid(entry, stop, target1, positive(target2) ? target2 : null, direction)) {
    blockers.push('PRICE_PLAN_DIRECTION_MISMATCH');
  }
  if (blockers.length > 0 || !market || !direction || !horizon || !positive(entry) || !positive(stop) || !positive(target1)) {
    return decision('BLOCKED', blockers);
  }

  const snapshot = createImmutableSignalSnapshot({
    signalId: card.signalId,
    timestamp: card.observedAt,
    market,
    symbol: card.symbol,
    symbolName: nonEmpty(card.name) ? card.name : null,
    strategyHorizon: horizon,
    direction,
    signalScore: card.score,
    displayConfidence: finiteOrNull(card.confidence),
    referencePrice: entry,
    entryPrice: entry,
    stopLoss: stop,
    target1,
    target2: positive(target2) ? target2 : null,
    riskReward: finiteOrNull(card.pricePlan.riskReward),
    timeframes: [input.timeframe],
    strategyProfileVersion: input.strategyProfileVersion,
    indicatorSnapshot: {
      matched: [...card.matched],
      notMatched: [...card.notMatched],
      unverified: [...card.unverified],
    },
    indicatorScores: card.quantScore ? { ...card.quantScore } : {},
    patternSnapshot: {},
    volumeContext: { volume: finiteOrNull(card.volume), tradingValue: finiteOrNull(card.tradingValue) },
    volatilityContext: { volatilityPercent: finiteOrNull(card.volatilityPercent) },
    trendContext: { direction: card.direction, action: card.action ?? null },
    marketRegime: regimeFromCard(card),
    liquidityContext: { liquidity: finiteOrNull(card.liquidity), spreadPercent: finiteOrNull(card.spreadPercent) },
    aiValidatorResult: card.aiValidation ? { ...card.aiValidation } : null,
    riskEngineResult: { riskScore: finiteOrNull(card.riskScore), riskLevel: card.riskLevel },
    dataProvenance: [...card.dataSources],
    dataTimestamp: input.dataTimestamp,
  });

  const identity = Object.freeze({
    market,
    horizon,
    direction,
    timeframe: input.timeframe,
    strategyProfileVersion: input.strategyProfileVersion,
  });
  const observation: ForwardRecommendationObservation = Object.freeze({
    schemaVersion: 'forward-recommendation-observation-v1',
    observationId: observationId(snapshot, input.timeframe),
    source: FORWARD_OBSERVATION_SOURCE,
    status: 'PENDING',
    identity,
    signalGrade: card.signalGrade,
    expiresAt: card.expiresAt,
    snapshot,
    outcome: null,
    settledAt: null,
    executionAuthority: 'NONE',
    simulatedOnly: true,
    financialMutationAllowed: false,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    profitabilityClaimAllowed: false,
  });
  return decision('OBSERVATION_READY', [], observation);
}

function advanceResult(status: ForwardObservationAdvance['status'], observation: ForwardRecommendationObservation, blockers: string[] = []): ForwardObservationAdvance {
  return Object.freeze({
    schemaVersion: 'forward-recommendation-observer-advance-v1',
    status,
    blockers: Object.freeze([...new Set(blockers)]),
    observation,
    executionAuthority: 'NONE',
    financialMutationAllowed: false,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
  });
}

export function advanceForwardRecommendationObservation(input: {
  observation: ForwardRecommendationObservation;
  bars: readonly SignalOutcomeBar[];
  evaluatedAt: string;
  evidenceCompleteThrough: string;
}): ForwardObservationAdvance {
  if (input.observation.source !== FORWARD_OBSERVATION_SOURCE) throw new Error('FORWARD_OBSERVATION_SOURCE_MISMATCH');
  if (input.observation.status === 'SETTLED') return advanceResult('REPLAYED', input.observation);

  const evaluatedAtMs = parseTime(input.evaluatedAt, 'evaluatedAt');
  const expiresAtMs = parseTime(input.observation.expiresAt, 'expiresAt');
  const completeThroughMs = parseTime(input.evidenceCompleteThrough, 'evidenceCompleteThrough');
  const expired = evaluatedAtMs >= expiresAtMs;
  const cutoffMs = expired ? expiresAtMs : evaluatedAtMs;
  const cutoffIso = new Date(cutoffMs).toISOString();

  const outcome = evaluateSignalOutcome({
    snapshot: input.observation.snapshot,
    bars: input.bars,
    evaluationHorizon: `${input.observation.identity.horizon}:${input.observation.identity.timeframe}`,
    evaluatedAt: cutoffIso,
    expiredWhenNoDecisiveHit: expired,
  });

  if (outcome.usableBars === 0) return advanceResult('PENDING', input.observation, ['FUTURE_BARS_REQUIRED']);
  if (completeThroughMs < cutoffMs) return advanceResult('PENDING', input.observation, ['FUTURE_EVIDENCE_INCOMPLETE']);

  const decisive = outcome.target1Hit || outcome.stopLossHit;
  if (!decisive && !expired) return advanceResult('PENDING', input.observation);
  if (!decisive && expired && outcome.outcome !== 'EXPIRED') {
    throw new Error('FORWARD_OBSERVATION_EXPIRY_CLASSIFICATION_MISMATCH');
  }

  const settled: ForwardRecommendationObservation = Object.freeze({
    ...input.observation,
    status: 'SETTLED',
    outcome: Object.freeze({ ...outcome }),
    settledAt: cutoffIso,
  });
  return advanceResult('SETTLED', settled);
}

function identityKey(identity: ForwardObservationIdentity): string {
  return [identity.market, identity.horizon, identity.direction, identity.timeframe, identity.strategyProfileVersion].join('|');
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function barrierReturn(snapshot: SignalSnapshot, price: number): number {
  return ((price - snapshot.entryPrice) / snapshot.entryPrice) * directionSign(snapshot.direction);
}

export function buildForwardObservationProfitCalibration(
  observations: readonly ForwardRecommendationObservation[],
  minimumSampleSize = FORWARD_OBSERVATION_MINIMUM_SAMPLE_SIZE,
): ForwardObservationProfitCalibration {
  if (!Number.isInteger(minimumSampleSize) || minimumSampleSize < 1) throw new Error('minimumSampleSize must be a positive integer');
  const settled = observations.filter((row) => row.status === 'SETTLED' && row.outcome != null);
  const identity = settled[0]?.identity ?? null;
  if (identity) {
    const expected = identityKey(identity);
    if (settled.some((row) => identityKey(row.identity) !== expected)) throw new Error('FORWARD_OBSERVATION_IDENTITY_MIXING_FORBIDDEN');
  }

  const tp: ForwardRecommendationObservation[] = [];
  const sl: ForwardRecommendationObservation[] = [];
  const expire: ForwardRecommendationObservation[] = [];
  let conservativeConflicts = 0;
  for (const row of settled) {
    const outcome = row.outcome!;
    if (outcome.conservativeIntrabarConflict) conservativeConflicts += 1;
    if (outcome.target1Hit && !outcome.stopLossHit && outcome.outcome === 'WIN') tp.push(row);
    else if (outcome.stopLossHit && outcome.outcome === 'LOSS') sl.push(row);
    else if (!outcome.target1Hit && !outcome.stopLossHit && outcome.outcome === 'EXPIRED') expire.push(row);
    else throw new Error('FORWARD_OBSERVATION_OUTCOME_UNCLASSIFIED');
  }

  const sampleSize = settled.length;
  let status: ForwardCalibrationStatus = sampleSize === 0
    ? 'NOT_EVIDENCED'
    : sampleSize < minimumSampleSize
      ? 'INSUFFICIENT_SAMPLE'
      : tp.length === 0 || sl.length === 0 || expire.length === 0
        ? 'INCOMPLETE_OUTCOME_CLASSES'
        : 'READY';

  let probabilities: ForwardObservationProfitCalibration['probabilities'] = Object.freeze({ tp: null, sl: null, expire: null });
  let returns: ForwardObservationProfitCalibration['returns'] = Object.freeze({ target: null, stop: null, expire: null });
  if (status === 'READY') {
    const targetReturns = tp.map((row) => barrierReturn(row.snapshot, row.snapshot.target1!));
    const stopReturns = sl.map((row) => barrierReturn(row.snapshot, row.snapshot.stopLoss!));
    const expireReturns = expire.map((row) => (row.outcome!.returnPercent as number) / 100);
    const target = mean(targetReturns);
    const stop = mean(stopReturns);
    const expiredReturn = mean(expireReturns);
    if (target == null || stop == null || expiredReturn == null || !(target > 0) || !(stop < 0)) {
      status = 'INCOMPLETE_OUTCOME_CLASSES';
    } else {
      probabilities = Object.freeze({ tp: tp.length / sampleSize, sl: sl.length / sampleSize, expire: expire.length / sampleSize });
      returns = Object.freeze({ target, stop, expire: expiredReturn });
    }
  }

  return Object.freeze({
    schemaVersion: 'forward-recommendation-profit-calibration-v1',
    source: FORWARD_OBSERVATION_SOURCE,
    status,
    identity,
    calibration: Object.freeze({ status, sampleSize, tpFirstCount: tp.length }),
    probabilities,
    returns,
    counts: Object.freeze({ tp: tp.length, sl: sl.length, expire: expire.length, conservativeConflicts }),
    costAdjusted: false,
    executionAuthority: 'NONE',
    financialMutationAllowed: false,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    profitabilityClaimAllowed: false,
  });
}
