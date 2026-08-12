import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryPredictionLedger } from './public-prediction.ledger';
import { assessModelDrift, predictionGapPercentagePoints, summarizePredictionPerformance } from './public-prediction.metrics';
import { createPublicPrediction } from './public-prediction.service';
import type { CreatePredictionInput, FrozenPredictionCandidate, PredictionMetricSet } from './public-prediction.types';

const metrics: PredictionMetricSet = {
  directionAccuracy: 0.64,
  balancedAccuracy: 0.62,
  precision: 0.63,
  recall: 0.61,
  brierScore: 0.48,
  calibrationError: 0.04,
  expectedReturn: 0.002,
  tradingExpectancy: 0.001,
  profitFactor: 1.2,
  maxDrawdown: 0.08,
  sampleSize: 500,
};

function candidate(overrides: Partial<FrozenPredictionCandidate> = {}): FrozenPredictionCandidate {
  return {
    predictionModelId: 'btc-v3-15m',
    predictionModelVersion: '1.0.0',
    strategyFamily: 'SCALPING',
    parameterHash: 'params-abc',
    featureHash: 'features-abc',
    datasetDigest: 'dataset-abc',
    researchCodeSha: 'ba181123e6b03c880d9c70174b16ae6eb528700b',
    market: 'CRYPTO_FUTURES',
    symbolGroup: 'BTCUSDT',
    timeframe: '15m',
    predictionHorizon: '15m',
    trainingWindow: { start: '2020-01-01T00:00:00.000Z', end: '2026-07-01T00:00:00.000Z' },
    developmentMetrics: metrics,
    oosMetrics: metrics,
    walkForwardMetrics: metrics,
    holdoutMetrics: metrics,
    costStress: { stable: true, scenarios: 4, sensitivity: 0.1, provenance: 'fixture' },
    regimeStress: { stable: true, scenarios: 5, sensitivity: 0.12, provenance: 'fixture' },
    confidencePolicy: {
      formulaVersion: 'frozen-v1',
      weights: {
        calibration: 1,
        oosStability: 1,
        walkForwardStability: 1,
        regimeAgreement: 1,
        dataQuality: 1,
        uncertaintyPenalty: 1,
        costSensitivityPenalty: 1,
      },
    },
    minimumDataQuality: 0.8,
    minimumRegimeConfidence: 0.6,
    status: 'PREDICTION_CANDIDATE',
    ...overrides,
  };
}

function input(overrides: Partial<CreatePredictionInput> = {}): CreatePredictionInput {
  return {
    predictionId: 'pred-1',
    timestamp: '2026-08-12T06:00:00.000Z',
    symbol: 'BTCUSDT',
    market: 'CRYPTO_FUTURES',
    timeframe: '15m',
    horizon: '15m',
    candidate: candidate(),
    marketSnapshot: {
      observedAt: '2026-08-12T05:59:59.000Z',
      stale: false,
      dataQuality: 0.98,
      regime: 'BULL',
      regimeConfidence: 0.8,
    },
    featureCutoffTimestamp: '2026-08-12T05:59:59.000Z',
    featuresDigest: 'runtime-features-abc',
    features: [
      { family: 'MOMENTUM', name: 'rsi', timestamp: '2026-08-12T05:45:00.000Z', value: 58 },
      { family: 'DERIVATIVES', name: 'funding', timestamp: '2026-08-12T05:00:00.000Z', value: 0.0001 },
    ],
    probabilities: { UP: 0.64, DOWN: 0.23, SIDEWAYS: 0.13 },
    confidenceInputs: {
      calibration: 0.9,
      oosStability: 0.8,
      walkForwardStability: 0.82,
      regimeAgreement: 0.85,
      dataQuality: 0.98,
      uncertainty: 0.2,
      costSensitivity: 0.15,
    },
    expectedReturn: 0.004,
    expectedRange: { low: -0.006, high: 0.012 },
    expectedVolatility: 0.008,
    riskLevel: 'MEDIUM',
    ...overrides,
  };
}

test('only frozen Prediction Lab candidates can enter the public Prediction Engine', () => {
  const result = createPublicPrediction(input({ candidate: candidate({ status: 'WF_VALIDATED' }) }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'UNVERIFIED_MODEL');
});

test('future features are blocked instead of producing a prediction', () => {
  const request = input({
    features: [{ family: 'MOMENTUM', name: 'future-rsi', timestamp: '2026-08-12T06:01:00.000Z', value: 70 }],
  });
  const result = createPublicPrediction(request);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'FEATURE_LEAKAGE');
});

test('stale public market data produces an explicit block', () => {
  const request = input({ marketSnapshot: { ...input().marketSnapshot, stale: true } });
  const result = createPublicPrediction(request);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'STALE_MARKET_DATA');
});

test('prediction output is public-only and has no order or signal authority', () => {
  const result = createPublicPrediction(input());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.prediction.probabilities, { UP: 0.64, DOWN: 0.23, SIDEWAYS: 0.13 });
  assert.equal(result.prediction.safety.LIVE_ORDER_ALLOWED, false);
  assert.equal(result.prediction.safety.PRIVATE_TRADING_API_ALLOWED, false);
  assert.equal(result.prediction.safety.REAL_ORDER_COUNT, 0);
  assert.equal(result.prediction.safety.REAL_CANCEL_COUNT, 0);
  assert.equal(result.prediction.safety.AUTO_TRADING_ENABLED, false);
  assert.equal('order' in result.prediction, false);
  assert.equal('side' in result.prediction, false);
  assert.equal('signal' in result.prediction, false);
  assert.equal(result.prediction.confidenceProvenance.formulaVersion, 'frozen-v1');
});

test('ledger is append-only and realization is a separate paper/shadow event', () => {
  const created = createPublicPrediction(input());
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const ledger = new InMemoryPredictionLedger();
  ledger.appendPrediction(created.prediction);
  const externalCopy = ledger.getPrediction(created.prediction.predictionId)!;
  externalCopy.probabilities.UP = 0;
  assert.equal(ledger.getPrediction(created.prediction.predictionId)!.probabilities.UP, 0.64);
  assert.throws(() => ledger.appendPrediction(created.prediction), /PREDICTION_ALREADY_EXISTS/);

  const outcome = ledger.appendOutcome({
    outcomeEventId: 'outcome-1',
    predictionId: created.prediction.predictionId,
    observedAt: '2026-08-12T06:15:00.000Z',
    actualReturn: 0.005,
    actualDirection: 'UP',
    paperOutcome: { mode: 'PAPER', return: 0.004, profitFactorContribution: 1.1, maxAdverseExcursion: 0.002, fillModel: 'sim-v1' },
    shadowOutcome: { mode: 'SHADOW', return: 0.005, profitFactorContribution: 1.15, maxAdverseExcursion: 0.001 },
  });
  assert.equal(outcome.correct, true);
  assert.equal(ledger.getPrediction(created.prediction.predictionId)!.probabilities.UP, 0.64);
  assert.throws(() => ledger.appendOutcome({
    outcomeEventId: 'outcome-2', predictionId: created.prediction.predictionId,
    observedAt: '2026-08-12T06:16:00.000Z', actualReturn: 0, actualDirection: 'SIDEWAYS',
  }), /PREDICTION_ALREADY_REALIZED/);
});

test('calibration, prediction gap, and caller-configured drift gates are measurable without retuning', () => {
  const created = createPublicPrediction(input());
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const ledger = new InMemoryPredictionLedger();
  ledger.appendPrediction(created.prediction);
  const outcome = ledger.appendOutcome({
    outcomeEventId: 'outcome-1', predictionId: created.prediction.predictionId,
    observedAt: '2026-08-12T06:15:00.000Z', actualReturn: 0.005, actualDirection: 'UP',
  });

  const summary = summarizePredictionPerformance(ledger.listPredictions(), ledger.listOutcomes());
  assert.equal(summary.samples, 1);
  assert.equal(summary.directionAccuracy, 1);
  assert.equal(summary.calibrationBuckets.find((bucket) => bucket.label === '60-65%')?.samples, 1);
  assert.equal(predictionGapPercentagePoints(0.64, 0.56), -8);

  const insufficient = assessModelDrift({ historicalAccuracy: 0.65, recentOutcomes: [outcome], minimumRecentSamples: 100, warningDropPercentagePoints: 10 });
  assert.equal(insufficient.status, 'INSUFFICIENT_DATA');

  const warning = assessModelDrift({
    historicalAccuracy: 0.65,
    recentOutcomes: Array.from({ length: 100 }, (_, index) => ({ ...outcome, outcomeEventId: `o-${index}`, correct: index < 51 })),
    minimumRecentSamples: 100,
    warningDropPercentagePoints: 10,
  });
  assert.equal(warning.status, 'MODEL_DRIFT_WARNING');
  assert.equal(warning.recentAccuracy, 0.51);
});
