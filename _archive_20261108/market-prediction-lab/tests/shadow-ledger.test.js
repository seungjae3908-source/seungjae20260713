import test from "node:test";
import assert from "node:assert/strict";
import {
  createShadowPrediction,
  evaluateShadowPromotion,
  settleShadowPrediction,
  summarizeShadowState,
  upsertShadowPrediction,
} from "../src/shadow-ledger.js";

const START = Date.UTC(2026, 0, 1);
const INTERVAL = 15 * 60 * 1000;

function pending(overrides = {}) {
  return createShadowPrediction({
    modelGroup: "crypto-futures-15m",
    modelId: "candidate-v2",
    referenceModelId: "candidate-v1",
    symbol: "BTCUSDT",
    timeframe: "15m",
    anchorTimestamp: START,
    horizon: 2,
    lastClose: 100,
    atrPct: 0.01,
    candidateProbabilities: { bullish: 0.7, neutral: 0.2, bearish: 0.1 },
    referenceProbabilities: { bullish: 0.4, neutral: 0.4, bearish: 0.2 },
    features: { emaGap: 0.01, trendSlope: 0.002, atrPct: 0.01 },
    featureAvailability: { fundingKnown: true, openInterestKnown: false },
    generatedAt: START,
    ...overrides,
  });
}

function settle(record, closes = [101, 102]) {
  return settleShadowPrediction(record, closes.map((close, index) => ({ timestamp: record.anchorTimestamp + (index + 1) * INTERVAL, close })));
}

test("shadow prediction is deterministic and classified by regime", () => {
  const first = pending();
  const second = pending();
  assert.equal(first.id, second.id);
  assert.equal(first.regime.key, "bull_trend:normal_volatility");
  assert.equal(first.candidateClass, "bullish");
  assert.equal(first.modelPair, "candidate-v2::candidate-v1");
});

test("settlement uses only future candles after the anchor", () => {
  const record = pending();
  const settled = settle(record);
  assert.equal(settled.status, "settled");
  assert.equal(settled.actualDirection, "bullish");
  assert.equal(settled.candidateHit, true);
  assert.ok(settled.candidateLogLoss < settled.referenceLogLoss);
  assert.throws(() => settleShadowPrediction(record, [{ timestamp: START, close: 101 }, { timestamp: START + INTERVAL, close: 102 }]), /invalid/);
});

test("ledger deduplicates exact predictions and rejects conflicts", () => {
  const record = pending();
  const first = upsertShadowPrediction({ records: [] }, record);
  const second = upsertShadowPrediction(first, record);
  assert.equal(second.records.length, 1);
  assert.throws(() => upsertShadowPrediction(first, { ...record, lastClose: 99 }), /conflict/);
});

test("summary reports candidate and reference metrics by symbol and regime", () => {
  const records = [
    settle(pending()),
    settle(pending({
      symbol: "ETHUSDT",
      anchorTimestamp: START + 3 * INTERVAL,
      lastClose: 100,
      candidateProbabilities: { bullish: 0.1, neutral: 0.2, bearish: 0.7 },
      referenceProbabilities: { bullish: 0.4, neutral: 0.4, bearish: 0.2 },
      features: { emaGap: -0.01, trendSlope: -0.002, atrPct: 0.02 },
    }), [99, 98]),
  ];
  const summary = summarizeShadowState({ records });
  assert.equal(summary.settled, 2);
  assert.equal(summary.candidate.accuracy, 1);
  assert.deepEqual(summary.candidate.actualCounts, { bullish: 1, neutral: 0, bearish: 1 });
  assert.deepEqual(summary.candidate.predictedCounts, { bullish: 1, neutral: 0, bearish: 1 });
  assert.equal(summary.candidate.actualShares.bullish, 0.5);
  assert.equal(summary.candidate.predictedShares.bearish, 0.5);
  assert.equal(summary.candidate.predictionHealth.collapsed, false);
  assert.equal(Object.keys(summary.bySymbol).length, 2);
  assert.equal(Object.keys(summary.byRegime).length, 2);
  assert.ok(summary.comparison.logLossImprovement > 0);
});

test("active model-pair filtering prevents old and new candidates from mixing", () => {
  const oldRecord = settle(pending());
  const newRecord = settle(pending({
    modelId: "candidate-v3",
    referenceModelId: "candidate-v2",
    anchorTimestamp: START + 5 * INTERVAL,
  }));
  const summary = summarizeShadowState({ records: [oldRecord, newRecord] }, {
    modelId: "candidate-v3",
    referenceModelId: "candidate-v2",
  });
  assert.equal(summary.totalAllModelPairs, 2);
  assert.equal(summary.total, 1);
  assert.equal(summary.settled, 1);
  assert.equal(Object.keys(summary.byModelPair).length, 2);
});

test("promotion remains blocked before samples, elapsed time and regime coverage", () => {
  const summary = summarizeShadowState({ records: [settle(pending())] });
  const decision = evaluateShadowPromotion(summary);
  assert.equal(decision.approved, false);
  assert.ok(decision.reasons.includes("insufficient_settled_samples"));
  assert.ok(decision.reasons.includes("insufficient_elapsed_shadow_period"));
  assert.ok(decision.reasons.includes("insufficient_regime_coverage"));
});

test("neutral prediction collapse is visible and explicitly blocks promotion", () => {
  const neutral = settle(pending({
    candidateProbabilities: { bullish: 0.05, neutral: 0.9, bearish: 0.05 },
    referenceProbabilities: { bullish: 0.1, neutral: 0.8, bearish: 0.1 },
  }), [100.05, 100.1]);
  const summary = summarizeShadowState({ records: [neutral] });
  assert.equal(summary.candidate.actualShares.neutral, 1);
  assert.equal(summary.candidate.predictedShares.neutral, 1);
  assert.equal(summary.candidate.predictionHealth.collapsed, true);
  assert.ok(summary.candidate.predictionHealth.reasons.includes("dominant_prediction_share:neutral"));

  const decision = evaluateShadowPromotion(summary, {
    minSettled: 1,
    minPerSymbol: 1,
    minElapsedMs: 0,
    minRegimeSamples: 1,
    minQualifiedRegimes: 1,
  });
  assert.equal(decision.approved, false);
  assert.ok(decision.reasons.includes("candidate:prediction_collapse:dominant_prediction_share:neutral"));
  assert.ok(decision.reasons.includes("BTCUSDT:prediction_collapse:dominant_prediction_share:neutral"));
});
