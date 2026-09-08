import test from "node:test";
import assert from "node:assert/strict";

import { analyzeMarket } from "../src/engine.js";

function buildCandles(count = 80) {
  const start = 1_700_000_000_000;
  return Array.from({ length: count }, (_, index) => {
    const base = 100 + (index * 0.15) + Math.sin(index / 4);
    const close = base + Math.sin(index / 7) * 0.3;
    return {
      timestamp: start + (index * 15 * 60 * 1000),
      open: base,
      high: Math.max(base, close) + 0.5,
      low: Math.min(base, close) - 0.5,
      close,
      volume: 1_000 + (index * 3),
    };
  });
}

function inputWithMarketFeatures(marketFeatures) {
  return {
    market: "CRYPTO_SPOT",
    symbol: "BTC_USDT",
    timeframe: "15m",
    horizon: 5,
    candles: buildCandles(),
    marketFeatures,
    derivativesFeatures: {},
    source: "shadow-feature-availability-observability-test",
  };
}

test("missing benchmarkReturn is non-evaluable and cannot receive model or policy credit", () => {
  const missingBenchmark = analyzeMarket(inputWithMarketFeatures({ sentimentScore: 0 }));
  const explicitZeroBenchmark = analyzeMarket(inputWithMarketFeatures({
    sentimentScore: 0,
    benchmarkReturn: 0,
  }));

  assert.equal(missingBenchmark.features.benchmarkReturn, 0);
  assert.equal(explicitZeroBenchmark.features.benchmarkReturn, 0);

  assert.ok(missingBenchmark.dataHealth.warnings.includes("benchmark_return_missing"));
  assert.equal(missingBenchmark.dataHealth.status, "partial");
  assert.ok(!explicitZeroBenchmark.dataHealth.warnings.includes("benchmark_return_missing"));
  assert.equal(explicitZeroBenchmark.dataHealth.status, "complete");

  assert.deepEqual(missingBenchmark.inferenceEvaluation, {
    status: "NOT_EVALUABLE",
    missingRequiredFeatures: ["benchmarkReturn"],
    blockers: ["MISSING_REQUIRED_FEATURE:benchmarkReturn"],
    modelObservationEligible: false,
    policyCreditEligible: false,
  });
  assert.equal(missingBenchmark.ruleScore, null);
  assert.equal(missingBenchmark.probabilities, null);
  assert.equal(missingBenchmark.stance, null);
  assert.equal(missingBenchmark.confidence, null);
  assert.deepEqual(missingBenchmark.forecastCandles, []);

  assert.equal(explicitZeroBenchmark.inferenceEvaluation.status, "EVALUABLE");
  assert.equal(explicitZeroBenchmark.inferenceEvaluation.modelObservationEligible, true);
  assert.equal(explicitZeroBenchmark.inferenceEvaluation.policyCreditEligible, true);
  assert.ok(Number.isFinite(explicitZeroBenchmark.ruleScore));
  assert.ok(explicitZeroBenchmark.probabilities);
  assert.notEqual(explicitZeroBenchmark.stance, null);
});

test("empty Shadow marketFeatures blocks every missing active-reference feature", () => {
  const result = analyzeMarket(inputWithMarketFeatures({}));

  assert.ok(result.dataHealth.warnings.includes("news_sentiment_missing"));
  assert.ok(result.dataHealth.warnings.includes("benchmark_return_missing"));
  assert.equal(result.dataHealth.status, "partial");
  assert.equal(result.inferenceEvaluation.status, "NOT_EVALUABLE");
  assert.deepEqual(result.inferenceEvaluation.missingRequiredFeatures, ["benchmarkReturn", "sentimentScore"]);
  assert.equal(result.inferenceEvaluation.modelObservationEligible, false);
  assert.equal(result.inferenceEvaluation.policyCreditEligible, false);
  assert.equal(result.probabilities, null);
});

test("futures active-reference evidence blocks missing zero-imputed derivatives", () => {
  const result = analyzeMarket({
    ...inputWithMarketFeatures({ sentimentScore: 0, benchmarkReturn: 0 }),
    market: "CRYPTO_FUTURES",
    derivativesFeatures: { fundingRate: 0 },
  });

  assert.deepEqual(result.inferenceEvaluation.missingRequiredFeatures, ["longShortBias", "openInterestChange"]);
  assert.equal(result.inferenceEvaluation.status, "NOT_EVALUABLE");
  assert.equal(result.ruleScore, null);
  assert.equal(result.probabilities, null);
});
