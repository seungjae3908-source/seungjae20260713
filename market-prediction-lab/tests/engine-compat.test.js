import test from "node:test";
import assert from "node:assert/strict";
import { analyzeMarket } from "../src/engine.js";
import { generateCandles } from "../src/synthetic-data.js";

for (const market of ["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"]) {
  test(`engine remains compatible with normalized ${market} snapshots`, () => {
    const input = {
      market,
      symbol: market === "KR_STOCK" ? "005930" : "BTCUSDT",
      timeframe: "15m",
      horizon: 5,
      candles: generateCandles({ count: 200 }),
      marketFeatures: market.includes("STOCK") ? { foreignNetRatio: 0.1, institutionNetRatio: 0.05 } : {},
      derivativesFeatures: market === "CRYPTO_FUTURES" ? { openInterestChange: 0.02, fundingRate: 0.0001 } : {},
      collectedAt: 1_700_000_000_000,
      source: "compat-test",
    };
    const result = analyzeMarket(input);
    const total = result.probabilities.bullish + result.probabilities.neutral + result.probabilities.bearish;
    assert.ok(Math.abs(total - 1) < 0.00001);
    assert.equal(result.forecastCandles.length, 5);
    assert.ok(result.forecastCandles.every((candle) => candle.low <= Math.min(candle.open, candle.close) && candle.high >= Math.max(candle.open, candle.close)));
  });
}
