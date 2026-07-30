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

test("shadow prediction is deterministic and classified by regime", () => {
  const first = pending();
  const second = pending();
  assert.equal(first.id, second.id);
  assert.equal(first.regime.key, "bull_trend:normal_volatility");
  assert.equal(first.candidateClass, "bullish");
});

test("settlement uses only future candles after the anchor", () => {
  const record = pending();
  const settled = settleShadowPrediction(record, [
    { timestamp: START + INTERVAL, close: 101 },
    { timestamp: START + 2 * INTERVAL, close: 102 },
  ], START + 3 * INTERVAL);
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
    settleShadowPrediction(pending(), [
      { timestamp: START + INTERVAL, close: 101 },
      { timestamp: START + 2 * INTERVAL, close: 102 },
    ]),
    settleShadowPrediction(pending({
      symbol: "ETHUSDT",
      anchorTimestamp: START + 3 * INTERVAL,
      lastClose: 100,
      candidateProbabilities: { bullish: 0.1, neutral: 0.2, bearish: 0.7 },
      referenceProbabilities: { bullish: 0.4, neutral: 0.4, bearish: 0.2 },
      features: { emaGap: -0.01, trendSlope: -0.002, atrPct: 0.02 },
    }), [
      { timestamp: START + 4 * INTERVAL, close: 99 },
      { timestamp: START + 5 * INTERVAL, close: 98 },
    ]),
  ];
  const summary = summarizeShadowState({ records });
  assert.equal(summary.settled, 2);
  assert.equal(summary.candidate.accuracy, 1);
  assert.equal(Object.keys(summary.bySymbol).length, 2);
  assert.ok(summary.comparison.logLossImprovement > 0);
});

test("promotion remains blocked before enough elapsed live evidence", () => {
  const summary = summarizeShadowState({ records: [
    settleShadowPrediction(pending(), [
      { timestamp: START + INTERVAL, close: 101 },
      { timestamp: START + 2 * INTERVAL, close: 102 },
    ]),
  ] });
  const decision = evaluateShadowPromotion(summary);
  assert.equal(decision.approved, false);
  assert.ok(decision.reasons.includes("insufficient_settled_samples"));
  assert.ok(decision.reasons.includes("insufficient_elapsed_shadow_period"));
});
