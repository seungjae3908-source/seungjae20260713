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

test("missing benchmarkReturn is observable without changing neutral scoring semantics", () => {
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

  assert.equal(missingBenchmark.ruleScore, explicitZeroBenchmark.ruleScore);
  assert.deepEqual(missingBenchmark.probabilities, explicitZeroBenchmark.probabilities);
  assert.equal(missingBenchmark.stance, explicitZeroBenchmark.stance);
});

test("empty Shadow marketFeatures exposes both missing sentiment and benchmark evidence", () => {
  const result = analyzeMarket(inputWithMarketFeatures({}));

  assert.ok(result.dataHealth.warnings.includes("news_sentiment_missing"));
  assert.ok(result.dataHealth.warnings.includes("benchmark_return_missing"));
  assert.equal(result.dataHealth.status, "partial");
});
