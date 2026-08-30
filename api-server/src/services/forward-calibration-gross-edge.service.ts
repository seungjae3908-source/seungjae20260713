import {
  FORWARD_OBSERVATION_MINIMUM_SAMPLE_SIZE,
  FORWARD_OBSERVATION_SOURCE,
  buildForwardObservationProfitCalibration,
  forwardObservationIdentityKey,
  type ForwardObservationIdentity,
  type ForwardObservationProfitCalibration,
  type ForwardRecommendationObservation,
} from './forward-recommendation-observer.service';

export type ForwardGrossEdgeEvidenceStatus = 'READY' | 'NOT_AVAILABLE';

export type ForwardGrossEdgeObservationProvenance = Readonly<{
  observationCount: number;
  observationIds: readonly string[];
  strategyHorizon: 'SCALP' | 'SWING' | 'POSITION' | null;
  signalFrom: string | null;
  signalTo: string | null;
  sourceDataFrom: string | null;
  sourceDataTo: string | null;
  settledFrom: string | null;
  settledTo: string | null;
  calculatedAt: string;
  dataSources: readonly string[];
}>;

export type ForwardGrossEdgeEvidence = Readonly<{
  schemaVersion: 'forward-calibration-gross-edge-v2';
  source: typeof FORWARD_OBSERVATION_SOURCE;
  status: ForwardGrossEdgeEvidenceStatus;
  reasons: readonly string[];
  identity: ForwardObservationIdentity | null;
  identityKey: string | null;
  sampleSize: number;
  counts: Readonly<{ tp: number; sl: number; expire: number; conservativeConflicts: number }> | null;
  probabilities: Readonly<{ tp: number; sl: number; expire: number }> | null;
  returns: Readonly<{ target: number; stop: number; expire: number }> | null;
  observationProvenance: ForwardGrossEdgeObservationProvenance | null;
  asOf: string | null;
  asOfMs: number | null;
  expectedGrossEdgeBps: number | null;
  conformalLowerEdgeBps: null;
  costAdjusted: false;
  netAlphaReady: false;
  netAlphaInput: Readonly<{
    evidenceReady: boolean;
    market: string | null;
    source: string;
    asOf: number | null;
    expectedGrossEdgeBps: number | null;
    conformalLowerEdgeBps: null;
    costPolicyVersion: null;
    costs: null;
  }>;
  executionAuthority: 'NONE';
  financialMutationAllowed: false;
  liveOrderAllowed: false;
  privateTradingApiAllowed: false;
  profitabilityClaimAllowed: false;
}>;

const SOURCE = 'forward-recommendation-profit-calibration-v2';
const PROBABILITY_TOLERANCE = 1e-6;
const RETURN_TOLERANCE = 1e-12;

type CanonicalProbabilities = Readonly<{ tp: number; sl: number; expire: number }>;
type CanonicalReturns = Readonly<{ target: number; stop: number; expire: number }>;

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function immutableSha(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/iu.test(value);
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function parseTime(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sameNumber(left: number | null | undefined, right: number | null | undefined, tolerance: number): boolean {
  if (!finite(left) || !finite(right)) return left == null && right == null;
  return Math.abs(left - right) <= tolerance;
}

function immutable<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) immutable(child);
  return value;
}

function validIdentity(identity: ForwardObservationIdentity | null): identity is ForwardObservationIdentity {
  if (!identity) return false;
  if (!nonEmpty(identity.strategyId)
    || !nonEmpty(identity.strategyVersion)
    || !nonEmpty(identity.parameterHash)
    || !immutableSha(identity.researchCodeSha)
    || !nonEmpty(identity.symbol)
    || !nonEmpty(identity.timeframe)
    || !positiveInteger(identity.horizon)) return false;
  if (identity.market === 'CRYPTO_FUTURES') return identity.direction === 'LONG' || identity.direction === 'SHORT';
  if (identity.market === 'KR_STOCK' || identity.market === 'US_STOCK' || identity.market === 'CRYPTO_SPOT') {
    return identity.direction === 'BUY';
  }
  return false;
}

function classifyObservation(row: ForwardRecommendationObservation): 'TP' | 'SL' | 'EXPIRE' | null {
  const outcome = row.outcome;
  if (!outcome) return null;
  if (outcome.target1Hit && !outcome.stopLossHit && outcome.outcome === 'WIN') return 'TP';
  if (outcome.stopLossHit && outcome.outcome === 'LOSS') return 'SL';
  if (!outcome.target1Hit && !outcome.stopLossHit && outcome.outcome === 'EXPIRED') return 'EXPIRE';
  return null;
}

function timestampRange(values: number[]): { from: string | null; to: string | null } {
  if (!values.length) return { from: null, to: null };
  const from = Math.min(...values);
  const to = Math.max(...values);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return { from: null, to: null };
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

function validateObservationSet(input: {
  observations: readonly ForwardRecommendationObservation[];
  identity: ForwardObservationIdentity | null;
  sampleSize: number;
  asOfMs: number | null;
  reasons: string[];
}): ForwardGrossEdgeObservationProvenance | null {
  const { observations, identity, sampleSize, asOfMs, reasons } = input;
  if (observations.length !== sampleSize) reasons.push('FORWARD_OBSERVATION_SAMPLE_COUNT_MISMATCH');
  if (!identity || asOfMs == null) return null;

  const expectedIdentityKey = forwardObservationIdentityKey(identity);
  const observationIds = new Set<string>();
  const signalTimes: number[] = [];
  const dataTimes: number[] = [];
  const settledTimes: number[] = [];
  const horizons = new Set<'SCALP' | 'SWING' | 'POSITION'>();
  const dataSources = new Set<string>();

  for (const row of observations) {
    if (row.schemaVersion !== 'forward-recommendation-observation-v2') reasons.push('FORWARD_OBSERVATION_SCHEMA_UNSUPPORTED');
    if (row.source !== FORWARD_OBSERVATION_SOURCE) reasons.push('FORWARD_OBSERVATION_SOURCE_MISMATCH');
    if (row.status !== 'SETTLED' || row.outcome == null) reasons.push('FORWARD_OBSERVATION_NOT_SETTLED');
    if (!nonEmpty(row.observationId)) reasons.push('FORWARD_OBSERVATION_ID_REQUIRED');
    else if (observationIds.has(row.observationId)) reasons.push('FORWARD_OBSERVATION_DUPLICATE');
    else observationIds.add(row.observationId);

    if (forwardObservationIdentityKey(row.identity) !== expectedIdentityKey) reasons.push('FORWARD_OBSERVATION_IDENTITY_MISMATCH');
    if (row.publicDataOnly !== true
      || row.executionAuthority !== 'NONE'
      || row.financialMutationAllowed !== false
      || row.liveOrderAllowed !== false
      || row.privateTradingApiAllowed !== false
      || row.orderSubmitted !== false
      || row.exchangeRequestSent !== false
      || row.profitabilityClaimAllowed !== false) {
      reasons.push('FORWARD_OBSERVATION_SAFETY_ENVELOPE_INVALID');
    }

    const signalMs = parseTime(row.snapshot.timestamp);
    const dataMs = parseTime(row.dataTimestamp);
    const snapshotDataMs = parseTime(row.snapshot.dataTimestamp);
    const expiryMs = parseTime(row.expiresAt);
    const settledMs = parseTime(row.settledAt);
    const outcomeMs = parseTime(row.outcome?.evaluatedAt);
    if (signalMs == null || dataMs == null || snapshotDataMs == null || expiryMs == null || settledMs == null || outcomeMs == null) {
      reasons.push('FORWARD_OBSERVATION_TIMESTAMP_INVALID');
    } else {
      signalTimes.push(signalMs);
      dataTimes.push(dataMs);
      settledTimes.push(settledMs);
      if (dataMs !== snapshotDataMs) reasons.push('FORWARD_OBSERVATION_DATA_TIMESTAMP_MISMATCH');
      if (dataMs > signalMs) reasons.push('FORWARD_OBSERVATION_LOOKAHEAD_DATA');
      if (!positiveInteger(row.dataMaxAgeMs) || signalMs - dataMs > row.dataMaxAgeMs) reasons.push('FORWARD_OBSERVATION_SOURCE_DATA_STALE');
      if (expiryMs <= signalMs) reasons.push('FORWARD_OBSERVATION_WINDOW_INVALID');
      if (settledMs < signalMs || settledMs > expiryMs) reasons.push('FORWARD_OBSERVATION_SETTLED_OUTSIDE_WINDOW');
      if (outcomeMs !== settledMs) reasons.push('FORWARD_OBSERVATION_OUTCOME_TIMESTAMP_MISMATCH');
      if (settledMs > asOfMs || signalMs > asOfMs || dataMs > asOfMs) reasons.push('FORWARD_OBSERVATION_FUTURE_TIMESTAMP');
    }

    if (row.snapshot.market !== row.identity.market
      || row.snapshot.symbol !== row.identity.symbol
      || row.snapshot.direction !== row.identity.direction
      || row.snapshot.strategyProfileVersion !== row.identity.strategyVersion
      || row.snapshot.timeframes[0] !== row.identity.timeframe
      || row.outcome?.signalId !== row.snapshot.signalId) {
      reasons.push('FORWARD_OBSERVATION_LINEAGE_MISMATCH');
    }

    if (!row.outcome || !positiveInteger(row.outcome.usableBars) || !finite(row.outcome.returnPercent)) {
      reasons.push('FORWARD_OBSERVATION_OUTCOME_EVIDENCE_INCOMPLETE');
    }
    if (classifyObservation(row) == null) reasons.push('FORWARD_OBSERVATION_OUTCOME_UNCLASSIFIED');

    horizons.add(row.snapshot.strategyHorizon);
    for (const source of row.snapshot.dataProvenance) {
      if (!nonEmpty(source)) reasons.push('FORWARD_OBSERVATION_DATA_PROVENANCE_INVALID');
      else dataSources.add(source);
    }
    if (row.snapshot.dataProvenance.length === 0) reasons.push('FORWARD_OBSERVATION_DATA_PROVENANCE_REQUIRED');
  }

  if (horizons.size !== 1) reasons.push('FORWARD_OBSERVATION_STRATEGY_HORIZON_MISMATCH');
  const signalRange = timestampRange(signalTimes);
  const dataRange = timestampRange(dataTimes);
  const settledRange = timestampRange(settledTimes);

  return immutable({
    observationCount: observations.length,
    observationIds: [...observationIds],
    strategyHorizon: horizons.size === 1 ? [...horizons][0]! : null,
    signalFrom: signalRange.from,
    signalTo: signalRange.to,
    sourceDataFrom: dataRange.from,
    sourceDataTo: dataRange.to,
    settledFrom: settledRange.from,
    settledTo: settledRange.to,
    calculatedAt: new Date(asOfMs).toISOString(),
    dataSources: [...dataSources].sort(),
  });
}

function validateAggregateCalibration(calibration: ForwardObservationProfitCalibration, reasons: string[]): void {
  const sampleSize = calibration.calibration?.sampleSize;
  const counts = calibration.counts;
  const probabilities = calibration.probabilities;
  const returns = calibration.returns;

  if (calibration.schemaVersion !== 'forward-recommendation-profit-calibration-v2') reasons.push('FORWARD_CALIBRATION_SCHEMA_UNSUPPORTED');
  if (calibration.source !== FORWARD_OBSERVATION_SOURCE) reasons.push('FORWARD_CALIBRATION_SOURCE_MISMATCH');
  if (calibration.status !== 'READY' || calibration.calibration?.status !== 'READY') reasons.push('FORWARD_CALIBRATION_NOT_READY');
  if (!validIdentity(calibration.identity)) reasons.push('FORWARD_CALIBRATION_IDENTITY_INVALID');
  if (!Number.isInteger(sampleSize) || Number(sampleSize) < FORWARD_OBSERVATION_MINIMUM_SAMPLE_SIZE) reasons.push('FORWARD_CALIBRATION_SAMPLE_SIZE_INSUFFICIENT');

  if (!counts
    || !nonNegativeInteger(counts.tp)
    || !nonNegativeInteger(counts.sl)
    || !nonNegativeInteger(counts.expire)
    || !nonNegativeInteger(counts.conservativeConflicts)) {
    reasons.push('FORWARD_CALIBRATION_COUNTS_INVALID');
  } else if (Number.isInteger(sampleSize)) {
    if (counts.tp + counts.sl + counts.expire !== sampleSize) reasons.push('FORWARD_CALIBRATION_COUNT_MISMATCH');
    if (counts.conservativeConflicts > sampleSize) reasons.push('FORWARD_CALIBRATION_CONFLICT_COUNT_INVALID');
    if (calibration.calibration.tpFirstCount !== counts.tp) reasons.push('FORWARD_CALIBRATION_TP_COUNT_MISMATCH');
  }

  const probabilityValues = [probabilities?.tp, probabilities?.sl, probabilities?.expire];
  if (probabilityValues.some((value) => !finite(value))) {
    reasons.push('FORWARD_CALIBRATION_PROBABILITY_INCOMPLETE');
  } else {
    const values = probabilityValues as number[];
    if (values.some((value) => value < 0 || value > 1)) reasons.push('FORWARD_CALIBRATION_PROBABILITY_INVALID');
    const total = values.reduce((sum, value) => sum + value, 0);
    if (Math.abs(total - 1) > PROBABILITY_TOLERANCE) reasons.push('FORWARD_CALIBRATION_PROBABILITY_SUM_INVALID');
    if (counts && Number.isInteger(sampleSize) && sampleSize > 0) {
      if (Math.abs(values[0]! - counts.tp / sampleSize) > PROBABILITY_TOLERANCE
        || Math.abs(values[1]! - counts.sl / sampleSize) > PROBABILITY_TOLERANCE
        || Math.abs(values[2]! - counts.expire / sampleSize) > PROBABILITY_TOLERANCE) {
        reasons.push('FORWARD_CALIBRATION_PROBABILITY_COUNT_MISMATCH');
      }
    }
  }

  if (!finite(returns?.target) || returns.target <= 0) reasons.push('FORWARD_CALIBRATION_TARGET_RETURN_INVALID');
  if (!finite(returns?.stop) || returns.stop >= 0) reasons.push('FORWARD_CALIBRATION_STOP_RETURN_INVALID');
  if (!finite(returns?.expire)) reasons.push('FORWARD_CALIBRATION_EXPIRE_RETURN_INVALID');

  if (calibration.costAdjusted !== false
    || calibration.executionAuthority !== 'NONE'
    || calibration.financialMutationAllowed !== false
    || calibration.liveOrderAllowed !== false
    || calibration.privateTradingApiAllowed !== false
    || calibration.profitabilityClaimAllowed !== false) {
    reasons.push('FORWARD_CALIBRATION_AUTHORITY_INVALID');
  }
}

function compareCanonicalCalibration(
  supplied: ForwardObservationProfitCalibration,
  rebuilt: ForwardObservationProfitCalibration,
  reasons: string[],
): void {
  if (rebuilt.status !== 'READY' || rebuilt.calibration.status !== 'READY') reasons.push('FORWARD_OBSERVATION_REBUILT_CALIBRATION_NOT_READY');
  if (!supplied.identity || !rebuilt.identity
    || forwardObservationIdentityKey(supplied.identity) !== forwardObservationIdentityKey(rebuilt.identity)) {
    reasons.push('FORWARD_CALIBRATION_REBUILT_IDENTITY_MISMATCH');
  }
  if (supplied.calibration.sampleSize !== rebuilt.calibration.sampleSize
    || supplied.calibration.tpFirstCount !== rebuilt.calibration.tpFirstCount
    || supplied.counts.tp !== rebuilt.counts.tp
    || supplied.counts.sl !== rebuilt.counts.sl
    || supplied.counts.expire !== rebuilt.counts.expire
    || supplied.counts.conservativeConflicts !== rebuilt.counts.conservativeConflicts) {
    reasons.push('FORWARD_CALIBRATION_REBUILT_COUNT_MISMATCH');
  }
  if (!sameNumber(supplied.probabilities.tp, rebuilt.probabilities.tp, PROBABILITY_TOLERANCE)
    || !sameNumber(supplied.probabilities.sl, rebuilt.probabilities.sl, PROBABILITY_TOLERANCE)
    || !sameNumber(supplied.probabilities.expire, rebuilt.probabilities.expire, PROBABILITY_TOLERANCE)) {
    reasons.push('FORWARD_CALIBRATION_REBUILT_PROBABILITY_MISMATCH');
  }
  if (!sameNumber(supplied.returns.target, rebuilt.returns.target, RETURN_TOLERANCE)
    || !sameNumber(supplied.returns.stop, rebuilt.returns.stop, RETURN_TOLERANCE)
    || !sameNumber(supplied.returns.expire, rebuilt.returns.expire, RETURN_TOLERANCE)) {
    reasons.push('FORWARD_CALIBRATION_REBUILT_PAYOFF_MISMATCH');
  }
}

export function buildForwardCalibrationGrossEdgeEvidence(input: {
  calibration: ForwardObservationProfitCalibration;
  observations: readonly ForwardRecommendationObservation[];
  asOf: string;
}): ForwardGrossEdgeEvidence {
  const { calibration, observations } = input;
  const reasons: string[] = [];
  const asOfMs = parseTime(input.asOf);
  const identity = calibration.identity ?? null;
  const sampleSize = calibration.calibration?.sampleSize ?? 0;

  validateAggregateCalibration(calibration, reasons);
  if (asOfMs == null) reasons.push('FORWARD_CALIBRATION_AS_OF_INVALID');
  const provenance = validateObservationSet({ observations, identity, sampleSize, asOfMs, reasons });

  let rebuilt: ForwardObservationProfitCalibration | null = null;
  const canRebuild = reasons.every((reason) => ![
    'FORWARD_OBSERVATION_SCHEMA_UNSUPPORTED',
    'FORWARD_OBSERVATION_SOURCE_MISMATCH',
    'FORWARD_OBSERVATION_NOT_SETTLED',
    'FORWARD_OBSERVATION_IDENTITY_MISMATCH',
    'FORWARD_OBSERVATION_LINEAGE_MISMATCH',
    'FORWARD_OBSERVATION_OUTCOME_UNCLASSIFIED',
  ].includes(reason));
  if (canRebuild) {
    rebuilt = buildForwardObservationProfitCalibration(observations, FORWARD_OBSERVATION_MINIMUM_SAMPLE_SIZE);
    compareCanonicalCalibration(calibration, rebuilt, reasons);
  }

  const uniqueReasons = Object.freeze([...new Set(reasons)]);
  const canonicalProbabilities = rebuilt?.probabilities;
  const canonicalReturns = rebuilt?.returns;
  const ready = uniqueReasons.length === 0
    && rebuilt?.status === 'READY'
    && finite(canonicalProbabilities?.tp)
    && finite(canonicalProbabilities?.sl)
    && finite(canonicalProbabilities?.expire)
    && finite(canonicalReturns?.target)
    && finite(canonicalReturns?.stop)
    && finite(canonicalReturns?.expire);

  const probabilities: CanonicalProbabilities | null = ready
    ? Object.freeze({ tp: canonicalProbabilities.tp, sl: canonicalProbabilities.sl, expire: canonicalProbabilities.expire })
    : null;
  const returns: CanonicalReturns | null = ready
    ? Object.freeze({ target: canonicalReturns.target, stop: canonicalReturns.stop, expire: canonicalReturns.expire })
    : null;
  const counts = ready && rebuilt ? rebuilt.counts : null;
  const expectedGrossEdgeBps = ready && probabilities && returns
    ? round((
      probabilities.tp * returns.target
      + probabilities.sl * returns.stop
      + probabilities.expire * returns.expire
    ) * 10_000)
    : null;
  const evidenceReady = ready && expectedGrossEdgeBps != null && finite(expectedGrossEdgeBps);

  const netAlphaInput = Object.freeze({
    evidenceReady,
    market: evidenceReady ? identity?.market ?? null : null,
    source: SOURCE,
    asOf: evidenceReady ? asOfMs : null,
    expectedGrossEdgeBps: evidenceReady ? expectedGrossEdgeBps : null,
    conformalLowerEdgeBps: null,
    costPolicyVersion: null,
    costs: null,
  });

  return immutable({
    schemaVersion: 'forward-calibration-gross-edge-v2' as const,
    source: FORWARD_OBSERVATION_SOURCE,
    status: evidenceReady ? 'READY' as const : 'NOT_AVAILABLE' as const,
    reasons: uniqueReasons,
    identity: validIdentity(identity) ? identity : null,
    identityKey: validIdentity(identity) ? forwardObservationIdentityKey(identity) : null,
    sampleSize,
    counts: evidenceReady ? counts : null,
    probabilities: evidenceReady ? probabilities : null,
    returns: evidenceReady ? returns : null,
    observationProvenance: evidenceReady ? provenance : null,
    asOf: asOfMs == null ? null : new Date(asOfMs).toISOString(),
    asOfMs,
    expectedGrossEdgeBps: evidenceReady ? expectedGrossEdgeBps : null,
    conformalLowerEdgeBps: null,
    costAdjusted: false as const,
    netAlphaReady: false as const,
    netAlphaInput,
    executionAuthority: 'NONE' as const,
    financialMutationAllowed: false as const,
    liveOrderAllowed: false as const,
    privateTradingApiAllowed: false as const,
    profitabilityClaimAllowed: false as const,
  });
}
