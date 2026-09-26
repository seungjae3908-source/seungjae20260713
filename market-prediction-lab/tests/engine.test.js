import test from "node:test";
import assert from "node:assert/strict";
import { analyzeMarket } from "../src/engine.js";
import { PredictionInputError } from "../src/contracts.js";
import { evaluatePrediction } from "../src/outcomes.js";

function createCandles({ count = 180, trend = 0.001, volatility = 0.004, startPrice = 100 } = {}) {
  const candles = [];
  let close = startPrice;
  const start = Date.UTC(2025, 0, 1);
  for (let index = 0; index < count; index += 1) {
    const open = close;
    const change = trend + Math.sin(index * 0.41) * volatility * 0.45;
    close = Math.max(1, open * (1 + change));
    const wick = volatility * (0.7 + Math.abs(Math.cos(index)) * 0.3);
    candles.push({
      timestamp: start + index * 15 * 60 * 1000,
      open,
      high: Math.max(open, close) * (1 + wick),
      low: Math.min(open, close) * (1 - wick),
      close,
      volume: 1000 + index + Math.abs(Math.sin(index)) * 400,
    });
  }
  return candles;
}

function baseInput(overrides = {}) {
  return {
    market: "CRYPTO_FUTURES",
    symbol: "BTCUSDT",
    timeframe: "15m",
    horizon: 8,
    candles: createCandles(),
    marketFeatures: { sentimentScore: 0.1, benchmarkReturn: 0.01 },
    derivativesFeatures: { openInterestChange: 0.05, fundingRate: 0.0005, longShortRatio: 1.1 },
    collectedAt: Date.UTC(2026, 6, 30),
    source: "unit-test",
    ...overrides,
  };
}

test("analysis returns finite deterministic probabilities and valid forecast candles", () => {
  const first = analyzeMarket(baseInput());
  const second = analyzeMarket(baseInput());
  assert.deepEqual(first.probabilities, second.probabilities);
  assert.deepEqual(first.forecastCandles, second.forecastCandles);
  const sum = Object.values(first.probabilities).reduce((total, value) => total + value, 0);
  assert.ok(Math.abs(sum - 1) < 0.00001);
  assert.equal(first.forecastCandles.length, 8);
  assert.ok(first.confidence >= 0.25 && first.confidence <= 0.72);
  assert.ok(Object.values(first.features).every(Number.isFinite));
  for (const candle of first.forecastCandles) {
    assert.ok(candle.high >= Math.max(candle.open, candle.close));
    assert.ok(candle.low <= Math.min(candle.open, candle.close));
    assert.ok(candle.low > 0);
    assert.ok(Number.isFinite(candle.volume));
  }
});

test("invalid OHLC input is rejected before analysis", () => {
  const candles = createCandles();
  candles[80] = { ...candles[80], high: candles[80].low - 1 };
  assert.throws(() => analyzeMarket(baseInput({ candles })), PredictionInputError);
});

test("timestamps must be strictly increasing", () => {
  const candles = createCandles();
  candles[100] = { ...candles[100], timestamp: candles[99].timestamp };
  assert.throws(() => analyzeMarket(baseInput({ candles })), /strictly ordered/);
});

test("futures overheat produces a funding warning", () => {
  const result = analyzeMarket(baseInput({
    derivativesFeatures: { openInterestChange: 0.3, fundingRate: 0.02, longShortRatio: 2.1 },
  }));
  assert.ok(result.warnings.some((warning) => warning.includes("펀딩비")));
  assert.ok(result.warnings.some((warning) => warning.includes("포지션 편향")));
});

test("stock mode works without derivatives fields and reports partial health", () => {
  const result = analyzeMarket(baseInput({
    market: "KR_STOCK",
    symbol: "005930",
    timeframe: "1d",
    derivativesFeatures: undefined,
    marketFeatures: { sentimentScore: 0.2 },
  }));
  assert.equal(result.dataHealth.status, "partial");
  assert.ok(result.dataHealth.warnings.includes("flow_data_missing"));
});

test("prediction outcome evaluation returns bounded finite metrics", () => {
  const prediction = analyzeMarket(baseInput());
  const actual = prediction.forecastCandles.map((candle) => ({ ...candle, estimated: undefined }));
  const outcome = evaluatePrediction(prediction, actual);
  assert.equal(typeof outcome.directionHit, "boolean");
  assert.equal(typeof outcome.rangeHit80, "boolean");
  assert.ok(Number.isFinite(outcome.actualReturn));
  assert.ok(Number.isFinite(outcome.maxFavorableMove));
  assert.ok(Number.isFinite(outcome.maxAdverseMove));
});
