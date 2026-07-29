import test from "node:test";
import assert from "node:assert/strict";
import { collectBitgetCandles, collectBitgetFuturesContext, normalizeBitgetCandle } from "../src/bitget-candle-collector.js";

const INTERVAL = 15 * 60 * 1000;
const START = Date.UTC(2026, 0, 1);

function rows(count = 260) {
  return Array.from({ length: count }, (_, index) => {
    const timestamp = START + index * INTERVAL;
    const open = 100 + index * 0.1;
    const close = open + Math.sin(index) * 0.2;
    return [String(timestamp), String(open), String(Math.max(open, close) + 0.4), String(Math.min(open, close) - 0.4), String(close), String(1000 + index), String((1000 + index) * close)];
  });
}

test("normalizer validates Bitget array candles", () => {
  const candle = normalizeBitgetCandle(rows(1)[0]);
  assert.equal(candle.timestamp, START);
  assert.ok(candle.high >= candle.close);
  assert.throws(() => normalizeBitgetCandle(["1", "10", "8", "9", "10", "1"]), /invalid OHLCV/);
});

test("collector paginates backward, sorts and removes duplicates", async () => {
  const source = rows();
  let calls = 0;
  const client = {
    get: async (_path, params) => {
      calls += 1;
      const end = Number(params.endTime);
      const eligible = source.filter((row) => Number(row[0]) <= end);
      const page = eligible.slice(-200);
      return { code: "00000", data: calls === 1 ? [...page, page[0]] : page };
    },
  };
  const result = await collectBitgetCandles({
    client,
    market: "CRYPTO_FUTURES",
    symbol: "BTCUSDT",
    timeframe: "15m",
    startTime: START,
    endTime: START + 259 * INTERVAL,
  });
  assert.equal(result.candles.length, 260);
  assert.equal(new Set(result.candles.map((c) => c.timestamp)).size, 260);
  assert.ok(calls >= 2);
});

test("collector rejects stalled pagination", async () => {
  const page = rows(200);
  const client = { get: async () => ({ code: "00000", data: page }) };
  await assert.rejects(() => collectBitgetCandles({
    client, market: "CRYPTO_FUTURES", symbol: "BTCUSDT", timeframe: "15m",
    startTime: START - 1000 * INTERVAL, endTime: START + 500 * INTERVAL,
  }), /pagination did not move backward/);
});

test("futures context combines OI, funding and mark/index prices", async () => {
  const client = {
    get: async (path) => {
      if (path.endsWith("open-interest")) return { data: { openInterestList: [{ symbol: "BTCUSDT", size: "123.4" }], ts: "1000" } };
      if (path.endsWith("current-fund-rate")) return { data: [{ fundingRate: "0.0001", fundingRateInterval: "8" }] };
      if (path.endsWith("history-fund-rate")) return { data: [{ fundingRate: "0.0002", fundingTime: "900" }] };
      if (path.endsWith("symbol-price")) return { data: [{ price: "10", markPrice: "10.1", indexPrice: "9.9" }] };
      throw new Error("unexpected path");
    },
  };
  const context = await collectBitgetFuturesContext({ client, symbol: "BTCUSDT" });
  assert.equal(context.openInterest, 123.4);
  assert.equal(context.fundingIntervalHours, 8);
  assert.equal(context.markPrice, 10.1);
  assert.equal(context.fundingHistory.length, 1);
});
