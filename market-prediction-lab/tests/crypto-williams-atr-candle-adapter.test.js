import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateKst09Sessions,
  buildCryptoWilliamsAtrInputFromCandles,
  evaluateCryptoWilliamsAtrFromCandles,
} from "../src/crypto-williams-atr-candle-adapter.js";

function makeDailyCandles(count = 16) {
  const start = Date.parse("2026-07-28T12:00:00.000Z");
  return Array.from({ length: count }, (_, index) => ({
    timestamp: start + index * 86_400_000,
    open: 100 + index,
    high: index === count - 1 ? 103 + index : 102 + index,
    low: 99 + index,
    close: index === count - 1 ? 102 + index : 101 + index,
  }));
}

test("aggregates candles at the exact KST 09:00 / UTC 00:00 boundary", () => {
  const sessions = aggregateKst09Sessions([
    { timestamp: Date.parse("2026-08-12T23:59:59.000Z"), open: 100, high: 102, low: 99, close: 101 },
    { timestamp: Date.parse("2026-08-13T00:00:00.000Z"), open: 103, high: 104, low: 102, close: 103.5 },
  ]);

  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].sessionKey, "2026-08-12");
  assert.equal(sessions[1].sessionKey, "2026-08-13");
});

test("builds previous-session range, MA5 and ATR14 from completed sessions only", () => {
  const built = buildCryptoWilliamsAtrInputFromCandles({
    market: "CRYPTO_SPOT",
    candles: makeDailyCandles(),
    capital: 10_000,
  });

  assert.equal(built.indicators.previousHigh, 116);
  assert.equal(built.indicators.previousLow, 113);
  assert.equal(built.indicators.sessionOpen, 115);
  assert.equal(built.indicators.currentPrice, 117);
  assert.equal(built.indicators.movingAverage, 113);
  assert.equal(built.indicators.movingAveragePeriod, 5);
  assert.equal(built.indicators.atr, 3);
  assert.equal(built.indicators.atrPeriod, 14);
  assert.equal(built.indicators.atrDefinition, "SMA_OF_LAST_14_COMPLETED_SESSION_TRUE_RANGES");
});

test("current-session high and low cannot leak into MA or ATR", () => {
  const base = makeDailyCandles();
  const extreme = base.map((candle) => ({ ...candle }));
  extreme.at(-1).high = 10_000;
  extreme.at(-1).low = 1;

  const first = buildCryptoWilliamsAtrInputFromCandles({ market: "CRYPTO_SPOT", candles: base, capital: 10_000 });
  const second = buildCryptoWilliamsAtrInputFromCandles({ market: "CRYPTO_SPOT", candles: extreme, capital: 10_000 });

  assert.equal(second.indicators.movingAverage, first.indicators.movingAverage);
  assert.equal(second.indicators.atr, first.indicators.atr);
  assert.equal(second.indicators.previousHigh, first.indicators.previousHigh);
  assert.equal(second.indicators.previousLow, first.indicators.previousLow);
});

test("configured MA and ATR periods are used by both adapter and strategy diagnostics", () => {
  const candles = makeDailyCandles(20);
  const evaluated = evaluateCryptoWilliamsAtrFromCandles({
    market: "CRYPTO_SPOT",
    symbol: "BTC-KRW",
    candles,
    capital: 10_000,
  }, { maPeriod: 10, atrPeriod: 5 });

  assert.equal(evaluated.indicators.movingAveragePeriod, 10);
  assert.equal(evaluated.indicators.atrPeriod, 5);
  assert.equal(evaluated.strategyResult.diagnostics.maPeriod, 10);
  assert.equal(evaluated.strategyResult.diagnostics.atrPeriod, 5);
});

test("same candle snapshot produces scanner output and a simulated spot Shadow plan", () => {
  const evaluated = evaluateCryptoWilliamsAtrFromCandles({
    market: "CRYPTO_SPOT",
    symbol: "BTC-KRW",
    candles: makeDailyCandles(),
    capital: 10_000,
    feeRate: 0.001,
    spreadRate: 0.001,
    slippageRate: 0.001,
  });

  assert.equal(evaluated.strategyResult.status, "ENTRY");
  assert.equal(evaluated.strategyResult.direction, "LONG");
  assert.equal(evaluated.strategyResult.levels.longTarget, 116.5);
  assert.equal(evaluated.strategyResult.levels.stopPrice, 111);
  assert.equal(evaluated.scannerSignal.symbol, "BTC-KRW");
  assert.equal(evaluated.shadowOrderPlan.mode, "SHADOW");
  assert.equal(evaluated.shadowOrderPlan.orderType, "MARKET_SIMULATED");
  assert.equal(evaluated.shadowOrderPlan.liveExecutionAllowed, false);
  assert.equal(evaluated.shadowOrderPlan.privateExchangeApiAllowed, false);
});

test("futures Shadow is created only with complete safe derivatives context", () => {
  const full = evaluateCryptoWilliamsAtrFromCandles({
    market: "CRYPTO_FUTURES",
    symbol: "BTCUSDT",
    candles: makeDailyCandles(),
    capital: 10_000,
    markPrice: 117,
    fundingRate: 0.0001,
    leverage: 2,
    liquidationPrice: 90,
  });
  assert.equal(full.strategyResult.eligibleForShadow, true);
  assert.equal(full.shadowOrderPlan.positionDirection, "LONG");

  const incomplete = evaluateCryptoWilliamsAtrFromCandles({
    market: "CRYPTO_FUTURES",
    symbol: "BTCUSDT",
    candles: makeDailyCandles(),
    capital: 10_000,
    fundingRate: 0.0001,
    leverage: 2,
    liquidationPrice: 90,
  });
  assert.equal(incomplete.strategyResult.eligibleForPaper, true);
  assert.equal(incomplete.strategyResult.eligibleForShadow, false);
  assert.equal(incomplete.shadowOrderPlan, null);
});

test("insufficient history fails closed", () => {
  assert.throws(
    () => buildCryptoWilliamsAtrInputFromCandles({ market: "CRYPTO_SPOT", candles: makeDailyCandles(15), capital: 10_000 }),
    /at least 16 KST09 sessions/,
  );
});

test("malformed OHLC and non-monotonic timestamps fail closed", () => {
  const malformed = makeDailyCandles();
  malformed[3] = { ...malformed[3], high: malformed[3].low - 1 };
  assert.throws(() => aggregateKst09Sessions(malformed), /high is inconsistent with OHLC/);

  const duplicate = makeDailyCandles();
  duplicate[4] = { ...duplicate[4], timestamp: duplicate[3].timestamp };
  assert.throws(() => aggregateKst09Sessions(duplicate), /strictly increasing/);
});
