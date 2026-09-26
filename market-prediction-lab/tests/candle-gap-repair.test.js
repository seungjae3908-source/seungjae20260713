import test from "node:test";
import assert from "node:assert/strict";
import { findCandleGaps, repairBitgetCandleGaps } from "../src/candle-gap-repair.js";

const INTERVAL = 15 * 60 * 1000;
const START = Date.UTC(2026, 0, 1);

function candle(index) {
  const open = 100 + index;
  return {
    timestamp: START + index * INTERVAL,
    open,
    high: open + 2,
    low: open - 2,
    close: open + 1,
    volume: 1000 + index,
  };
}

function row(index) {
  const item = candle(index);
  return [
    String(item.timestamp),
    String(item.open),
    String(item.high),
    String(item.low),
    String(item.close),
    String(item.volume),
  ];
}

test("gap detector reports exact missing ranges", () => {
  const result = findCandleGaps([candle(0), candle(1), candle(4)], INTERVAL);
  assert.equal(result.gapCount, 1);
  assert.equal(result.missingCandleCount, 2);
  assert.equal(result.gaps[0].firstMissingTimestamp, START + 2 * INTERVAL);
  assert.equal(result.gaps[0].lastMissingTimestamp, START + 3 * INTERVAL);
});

test("repairer merges only candles returned by Bitget and uses a bounded query", async () => {
  const base = [candle(0), candle(1), candle(3), candle(4)];
  let request;
  const client = {
    get: async (path, params) => {
      request = { path, params };
      return { data: [row(1), row(2), row(3)] };
    },
  };

  const result = await repairBitgetCandleGaps({
    client,
    market: "CRYPTO_FUTURES",
    symbol: "BTCUSDT",
    timeframe: "15m",
    candles: base,
  });

  assert.equal(result.repairedCandleCount, 1);
  assert.equal(result.remainingGapCount, 0);
  assert.equal(result.candles.length, 5);
  assert.match(request.path, /history-candles$/);
  assert.equal(request.params.startTime, START + INTERVAL);
  assert.equal(request.params.endTime, START + 4 * INTERVAL);
  assert.equal(request.params.productType, "usdt-futures");
});

test("repairer never synthesizes an unresolved candle", async () => {
  const base = [candle(0), candle(2)];
  const client = { get: async () => ({ data: [] }) };
  const result = await repairBitgetCandleGaps({
    client,
    market: "CRYPTO_FUTURES",
    symbol: "BTCUSDT",
    timeframe: "15m",
    candles: base,
  });

  assert.equal(result.repairedCandleCount, 0);
  assert.equal(result.remainingMissingCandleCount, 1);
  assert.equal(result.candles.length, 2);
});

test("repairer fails closed when a returned finished candle conflicts", async () => {
  const base = [candle(0), candle(2)];
  const conflicting = row(0);
  conflicting[4] = "100.5";
  const client = { get: async () => ({ data: [conflicting, row(1)] }) };

  await assert.rejects(() => repairBitgetCandleGaps({
    client,
    market: "CRYPTO_FUTURES",
    symbol: "BTCUSDT",
    timeframe: "15m",
    candles: base,
  }), /conflicts/);
});

test("gap detector rejects misaligned timestamps instead of guessing", () => {
  assert.throws(() => findCandleGaps([
    candle(0),
    { ...candle(1), timestamp: START + INTERVAL + 1 },
  ], INTERVAL), /not aligned/);
});
