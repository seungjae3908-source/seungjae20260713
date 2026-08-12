import {
  PUBLIC_PREDICTION_SAFETY,
  type ConfidencePolicy,
  type CreatePredictionInput,
  type PredictionAttempt,
  type PredictionConfidenceInputs,
  type PredictionConfidenceProvenance,
  type PredictionHorizon,
  type PredictionProbabilities,
  type PredictionStrategyFamily,
} from './public-prediction.types';

const SCALPING_HORIZONS = new Set<PredictionHorizon>(['5m', '15m', '30m', '1h']);
const SWING_HORIZONS = new Set<PredictionHorizon>(['4h', '1d', '3d', '5d']);
const ENGINE_ALLOWED_STATUSES = new Set(['PREDICTION_CANDIDATE', 'PAPER_PREDICTION_VALIDATED']);
const PROBABILITY_TOLERANCE = 1e-9;

function finiteUnit(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function timestampMs(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validHorizon(strategyFamily: PredictionStrategyFamily, horizon: PredictionHorizon): boolean {
  return strategyFamily === 'SCALPING' ? SCALPING_HORIZONS.has(horizon) : SWING_HORIZONS.has(horizon);
}

function validProbabilities(probabilities: PredictionProbabilities): boolean {
  const values = [probabilities.UP, probabilities.DOWN, probabilities.SIDEWAYS];
  if (!values.every(finiteUnit)) return false;
  return Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) <= PROBABILITY_TOLERANCE;
}

function validWeights(policy: ConfidencePolicy): boolean {
  const weights = Object.values(policy.weights);
  return weights.every((value) => Number.isFinite(value) && value >= 0) && weights.some((value) => value > 0);
}

function validConfidenceInputs(inputs: PredictionConfidenceInputs): boolean {
  return Object.values(inputs).every(finiteUnit);
}

export function calculatePredictionConfidence(
  policy: ConfidencePolicy,
  inputs: PredictionConfidenceInputs,
): PredictionConfidenceProvenance | null {
  if (!policy.formulaVersion || !validWeights(policy) || !validConfidenceInputs(inputs)) return null;

  const { weights } = policy;
  const support =
    inputs.calibration * weights.calibration +
    inputs.oosStability * weights.oosStability +
    inputs.walkForwardStability * weights.walkForwardStability +
    inputs.regimeAgreement * weights.regimeAgreement +
    inputs.dataQuality * weights.dataQuality;
  const penalty =
    inputs.uncertainty * weights.uncertaintyPenalty +
    inputs.costSensitivity * weights.costSensitivityPenalty;
  const totalWeight = Object.values(weights).reduce((sum, value) => sum + value, 0);
  const penaltyCapacity = weights.uncertaintyPenalty + weights.costSensitivityPenalty;
  const normalizedScore = Math.max(0, Math.min(100, ((support + penaltyCapacity - penalty) / totalWeight) * 100));

  return {
    formulaVersion: policy.formulaVersion,
    weights: { ...weights },
    inputs: { ...inputs },
    normalizedScore,
  };
}

export function createPublicPrediction(input: CreatePredictionInput): PredictionAttempt {
  const { candidate } = input;

  if (!ENGINE_ALLOWED_STATUSES.has(candidate.status)) {
    return { ok: false, code: 'UNVERIFIED_MODEL', reason: `Model status ${candidate.status} is not eligible for Prediction Engine.` };
  }

  if (
    !candidate.predictionModelId ||
    !candidate.predictionModelVersion ||
    !candidate.parameterHash ||
    !candidate.featureHash ||
    !candidate.datasetDigest ||
    !candidate.researchCodeSha ||
    !input.featuresDigest
  ) {
    return { ok: false, code: 'UNVERIFIED_MODEL', reason: 'Immutable model or feature provenance is incomplete.' };
  }

  if (
    candidate.market !== input.market ||
    candidate.timeframe !== input.timeframe ||
    candidate.predictionHorizon !== input.horizon ||
    !validHorizon(candidate.strategyFamily, input.horizon)
  ) {
    return { ok: false, code: 'UNVERIFIED_MODEL', reason: 'Prediction request does not match the frozen market/timeframe/horizon contract.' };
  }

  const predictionMs = timestampMs(input.timestamp);
  const snapshotMs = timestampMs(input.marketSnapshot.observedAt);
  const cutoffMs = timestampMs(input.featureCutoffTimestamp);
  if (predictionMs === null || snapshotMs === null || cutoffMs === null) {
    return { ok: false, code: 'INSUFFICIENT_DATA', reason: 'Prediction, snapshot, or feature cutoff timestamp is invalid.' };
  }

  if (input.marketSnapshot.stale) {
    return { ok: false, code: 'STALE_MARKET_DATA', reason: 'Public market snapshot is marked stale.' };
  }

  if (!finiteUnit(input.marketSnapshot.dataQuality) || input.marketSnapshot.dataQuality < candidate.minimumDataQuality) {
    return { ok: false, code: 'INSUFFICIENT_DATA', reason: 'Market data quality is below the frozen candidate threshold.' };
  }

  if (!finiteUnit(input.marketSnapshot.regimeConfidence) || input.marketSnapshot.regimeConfidence < candidate.minimumRegimeConfidence) {
    return { ok: false, code: 'LOW_REGIME_CONFIDENCE', reason: 'Regime confidence is below the frozen candidate threshold.' };
  }

  if (snapshotMs > predictionMs || cutoffMs > predictionMs) {
    return { ok: false, code: 'FEATURE_LEAKAGE', reason: 'Snapshot or feature cutoff occurs after the prediction timestamp.' };
  }

  if (input.features.length === 0) {
    return { ok: false, code: 'INSUFFICIENT_DATA', reason: 'No timestamped public features were supplied.' };
  }

  for (const feature of input.features) {
    const featureMs = timestampMs(feature.timestamp);
    if (featureMs === null) {
      return { ok: false, code: 'INSUFFICIENT_DATA', reason: `Feature ${feature.name} has an invalid timestamp.` };
    }
    if (featureMs > cutoffMs || featureMs > predictionMs) {
      return { ok: false, code: 'FEATURE_LEAKAGE', reason: `Feature ${feature.name} is newer than the permitted cutoff.` };
    }
    if (feature.family === 'DERIVATIVES' && input.market !== 'CRYPTO_FUTURES') {
      return { ok: false, code: 'UNVERIFIED_MODEL', reason: 'Derivatives features are restricted to CRYPTO_FUTURES.' };
    }
  }

  if (!validProbabilities(input.probabilities)) {
    return { ok: false, code: 'UNVERIFIED_MODEL', reason: 'Model probabilities must be finite, within [0,1], and sum to 1.' };
  }

  if (
    !Number.isFinite(input.expectedReturn) ||
    !Number.isFinite(input.expectedRange.low) ||
    !Number.isFinite(input.expectedRange.high) ||
    input.expectedRange.low > input.expectedRange.high ||
    !Number.isFinite(input.expectedVolatility) ||
    input.expectedVolatility < 0
  ) {
    return { ok: false, code: 'INSUFFICIENT_DATA', reason: 'Expected return/range/volatility is invalid.' };
  }

  const confidenceProvenance = calculatePredictionConfidence(candidate.confidencePolicy, input.confidenceInputs);
  if (!confidenceProvenance) {
    return { ok: false, code: 'UNVERIFIED_MODEL', reason: 'Confidence policy or inputs are invalid.' };
  }

  return {
    ok: true,
    prediction: {
      predictionId: input.predictionId,
      timestamp: input.timestamp,
      featureCutoffTimestamp: input.featureCutoffTimestamp,
      symbol: input.symbol,
      market: input.market,
      timeframe: input.timeframe,
      horizon: input.horizon,
      modelId: candidate.predictionModelId,
      modelVersion: candidate.predictionModelVersion,
      researchCodeSha: candidate.researchCodeSha,
      parameterHash: candidate.parameterHash,
      featureHash: candidate.featureHash,
      datasetDigest: candidate.datasetDigest,
      featuresDigest: input.featuresDigest,
      probabilities: { ...input.probabilities },
      confidence: confidenceProvenance.normalizedScore,
      confidenceProvenance,
      regime: input.marketSnapshot.regime,
      expectedReturn: input.expectedReturn,
      expectedRange: { ...input.expectedRange },
      expectedVolatility: input.expectedVolatility,
      riskLevel: input.riskLevel,
      safety: PUBLIC_PREDICTION_SAFETY,
    },
  };
}

export function dominantPredictionDirection(probabilities: PredictionProbabilities): 'UP' | 'DOWN' | 'SIDEWAYS' {
  const entries = Object.entries(probabilities) as Array<['UP' | 'DOWN' | 'SIDEWAYS', number]>;
  entries.sort((left, right) => right[1] - left[1]);
  return entries[0]![0];
}
