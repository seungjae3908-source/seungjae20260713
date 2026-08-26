import {
  FORWARD_OBSERVATION_SOURCE,
  forwardObservationIdentityKey,
  type ForwardObservationIdentity,
  type ForwardObservationProfitCalibration,
} from './forward-recommendation-observer.service';

export type ForwardGrossEdgeEvidenceStatus = 'READY' | 'NOT_AVAILABLE';

export type ForwardGrossEdgeEvidence = Readonly<{
  schemaVersion: 'forward-calibration-gross-edge-v1';
  source: typeof FORWARD_OBSERVATION_SOURCE;
  status: ForwardGrossEdgeEvidenceStatus;
  reasons: readonly string[];
  identity: ForwardObservationIdentity | null;
  identityKey: string | null;
  sampleSize: number;
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

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
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

function immutable<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) immutable(child);
  return value;
}

export function buildForwardCalibrationGrossEdgeEvidence(input: {
  calibration: ForwardObservationProfitCalibration;
  asOf: string;
}): ForwardGrossEdgeEvidence {
  const { calibration } = input;
  const reasons: string[] = [];
  const asOfMs = parseTime(input.asOf);
  const identity = calibration.identity ?? null;
  const sampleSize = calibration.calibration?.sampleSize ?? 0;
  const counts = calibration.counts;
  const probabilities = calibration.probabilities;
  const returns = calibration.returns;

  if (calibration.source !== FORWARD_OBSERVATION_SOURCE) reasons.push('FORWARD_CALIBRATION_SOURCE_MISMATCH');
  if (calibration.status !== 'READY' || calibration.calibration?.status !== 'READY') reasons.push('FORWARD_CALIBRATION_NOT_READY');
  if (!identity) reasons.push('FORWARD_CALIBRATION_IDENTITY_REQUIRED');
  if (!Number.isInteger(sampleSize) || sampleSize < 1) reasons.push('FORWARD_CALIBRATION_SAMPLE_SIZE_INVALID');
  if (!counts || counts.tp + counts.sl + counts.expire !== sampleSize) reasons.push('FORWARD_CALIBRATION_COUNT_MISMATCH');
  if (asOfMs == null) reasons.push('FORWARD_CALIBRATION_AS_OF_INVALID');

  const probabilityValues = [probabilities?.tp, probabilities?.sl, probabilities?.expire];
  if (probabilityValues.some((value) => !finite(value))) {
    reasons.push('FORWARD_CALIBRATION_PROBABILITY_INCOMPLETE');
  } else {
    const values = probabilityValues as number[];
    if (values.some((value) => value < 0 || value > 1)) reasons.push('FORWARD_CALIBRATION_PROBABILITY_INVALID');
    const total = values.reduce((sum, value) => sum + value, 0);
    if (Math.abs(total - 1) > PROBABILITY_TOLERANCE) reasons.push('FORWARD_CALIBRATION_PROBABILITY_SUM_INVALID');
  }

  if (!finite(returns?.target) || returns.target <= 0) reasons.push('FORWARD_CALIBRATION_TARGET_RETURN_INVALID');
  if (!finite(returns?.stop) || returns.stop >= 0) reasons.push('FORWARD_CALIBRATION_STOP_RETURN_INVALID');
  if (!finite(returns?.expire)) reasons.push('FORWARD_CALIBRATION_EXPIRE_RETURN_INVALID');

  const ready = reasons.length === 0
    && finite(probabilities.tp)
    && finite(probabilities.sl)
    && finite(probabilities.expire)
    && finite(returns.target)
    && finite(returns.stop)
    && finite(returns.expire);

  const expectedGrossEdgeBps = ready
    ? round((
      probabilities.tp * returns.target
      + probabilities.sl * returns.stop
      + probabilities.expire * returns.expire
    ) * 10_000)
    : null;

  const uniqueReasons = Object.freeze([...new Set(reasons)]);
  const evidenceReady = ready && expectedGrossEdgeBps != null && finite(expectedGrossEdgeBps);
  const netAlphaInput = Object.freeze({
    evidenceReady,
    market: identity?.market ?? null,
    source: SOURCE,
    asOf: asOfMs,
    expectedGrossEdgeBps: evidenceReady ? expectedGrossEdgeBps : null,
    conformalLowerEdgeBps: null,
    costPolicyVersion: null,
    costs: null,
  });

  return immutable({
    schemaVersion: 'forward-calibration-gross-edge-v1' as const,
    source: FORWARD_OBSERVATION_SOURCE,
    status: evidenceReady ? 'READY' as const : 'NOT_AVAILABLE' as const,
    reasons: uniqueReasons,
    identity,
    identityKey: identity ? forwardObservationIdentityKey(identity) : null,
    sampleSize,
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
