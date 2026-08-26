import test from "node:test";
import assert from "node:assert/strict";

import { buildShadowBacktestGapDiagnostic, buildShadowDirectionalMetrics } from "../src/shadow-backtest-gap-diagnostics.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function row(index, { timeframe = "15m", actual, predicted } = {}) {
  return { id: `${timeframe}-${index}`, timeframe, actualDirection: actual, candidateClass: predicted };
}

function current15mFixture() {
  return Array.from({ length: 32 }, (_, index) => {
    const actual = index < 8 ? "bullish" : index < 24 ? "neutral" : "bearish";
    const predicted = index < 6 ? "bullish" : index < 8 ? "bearish" : "neutral";
    return row(index, { actual, predicted });
  });
}

function current1hFixture() {
  return Array.from({ length: 64 }, (_, index) => {
    const actual = index < 36 ? "bullish" : "neutral";
    const predicted = index < 16 ? "bullish" : index < 48 ? "neutral" : "bearish";
    return row(index, { timeframe: "1h", actual, predicted });
  });
}

test("15m neutral dominance and zero bear recall are reported only with real bearish support", () => {
  const metrics = buildShadowDirectionalMetrics(current15mFixture());
  assert.deepEqual(metrics.predictedCounts, { bullish: 6, neutral: 24, bearish: 2, abstain: 0 });
  assert.equal(metrics.predictedShares.neutral, 0.75);
  assert.equal(metrics.evidence.actualBearishSupport, 8);
  assert.equal(metrics.bearRecallEvaluable, true);
  assert.equal(metrics.bearRecall, 0);
  assert.equal(metrics.evidence.neutralDominanceObserved, true);
});

test("1h with zero actual bearish samples reports bear recall as null instead of fabricated zero", () => {
  const metrics = buildShadowDirectionalMetrics(current1hFixture());
  assert.equal(metrics.actualCounts.bearish, 0);
  assert.equal(metrics.bearRecallEvaluable, false);
  assert.equal(metrics.bearRecall, null);
  assert.equal(metrics.balancedAccuracyAllClasses, null);
});

test("Backtest economic metrics are never subtracted from Shadow directional metrics", () => {
  const diagnostic = buildShadowBacktestGapDiagnostic({
    shadowRecords: current15mFixture(),
    backtestEconomicSummary: { totalTrades: 44, totalReturnPercent: 8.2, profitFactor: 1.3, maximumDrawdownPercent: 4.1, expectancy: 2.7 },
    timeframe: "15m",
    researchCodeSha: SHA_A,
    shadowResearchCodeSha: SHA_B,
  });
  assert.equal(diagnostic.backtestEconomic.available, true);
  assert.equal(diagnostic.backtestEconomic.comparableToShadowDirectionalMetrics, false);
  assert.equal(diagnostic.directionalComparison.available, false);
  assert.ok(diagnostic.missingEvidence.includes("backtest_directional_records_missing"));
});

test("same-semantic directional evidence can describe a Shadow degradation without claiming causality", () => {
  const backtest = Array.from({ length: 32 }, (_, index) => {
    const actual = index < 8 ? "bullish" : index < 24 ? "neutral" : "bearish";
    return row(index, { actual, predicted: actual });
  });
  const diagnostic = buildShadowBacktestGapDiagnostic({ shadowRecords: current15mFixture(), backtestDirectionalRecords: backtest, timeframe: "15m", researchCodeSha: SHA_A, shadowResearchCodeSha: SHA_B });
  assert.equal(diagnostic.directionalComparison.available, true);
  assert.equal(diagnostic.directionalComparison.bearRecallComparable, true);
  assert.ok(diagnostic.directionalComparison.bearRecallDelta < 0);
  assert.equal(diagnostic.directionalComparison.descriptiveVerdict, "SHADOW_DIRECTIONAL_DEGRADATION_OBSERVED");
  assert.equal(diagnostic.directionalComparison.causalityEstablished, false);
  assert.equal(diagnostic.rootCauseVerdict, "INSUFFICIENT_EVIDENCE_FOR_CAUSAL_ROOT_CAUSE");
});

test("missing 1h bearish support remains explicit through the combined gap diagnostic", () => {
  const diagnostic = buildShadowBacktestGapDiagnostic({ shadowRecords: current1hFixture(), timeframe: "1h", researchCodeSha: SHA_A, shadowResearchCodeSha: SHA_B });
  assert.equal(diagnostic.collapseObservation.bearRecall, null);
  assert.equal(diagnostic.collapseObservation.bearRecallEvaluable, false);
  assert.ok(diagnostic.missingEvidence.includes("shadow_actual_bearish_sample_missing"));
  assert.equal(diagnostic.safety.thresholdModified, false);
  assert.equal(diagnostic.safety.finalHoldoutUsedForSelection, false);
});
