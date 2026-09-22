import test from "node:test";
import assert from "node:assert/strict";
import { collectBitgetCandles, collectBitgetFuturesContext, collectBitgetFuturesReferenceCandles, normalizeBitgetCandle } from "../src/bitget-candle-collector.js";

const INTERVAL = 15 * 60 * 1000;
const START = Date.UTC(2026, 0, 1);

function rows(count = 5_000) {
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

test("collector crosses 25 pages without page-boundary gaps, sorts and deduplicates", async () => {
  const source = rows();
  let calls = 0;
  const client = {
    get: async (_path, params) => {
      calls += 1;
      const end = Number(params.endTime);
      const eligible = source.filter((row) => Number(row[0]) < end);
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
    endTime: START + 5_000 * INTERVAL,
  });
  assert.equal(result.candles.length, 5_000);
  assert.equal(new Set(result.candles.map((candle) => candle.timestamp)).size, 5_000);
  for (let index = 1; index < result.candles.length; index += 1) {
    assert.equal(result.candles[index].timestamp - result.candles[index - 1].timestamp, INTERVAL);
  }
  assert.ok(calls >= 25);
});

test("collector rejects stalled pagination", async () => {
  const page = rows(200);
  const client = { get: async () => ({ code: "00000", data: page }) };
  await assert.rejects(() => collectBitgetCandles({
    client, market: "CRYPTO_FUTURES", symbol: "BTCUSDT", timeframe: "15m",
    startTime: START - 1000 * INTERVAL, endTime: START + 500 * INTERVAL,
  }), /pagination did not move backward/);
});

test("reference history collector uses public mark/index endpoints and preserves closed candle continuity", async () => {
  const source = rows(450);
  for (const priceType of ["mark", "index"]) {
    const paths = [];
    const client = {
      get: async (path, params) => {
        paths.push(path);
        const end = Number(params.endTime);
        const eligible = source.filter((row) => Number(row[0]) < end);
        return { code: "00000", data: eligible.slice(-200) };
      },
    };
    const result = await collectBitgetFuturesReferenceCandles({
      client,
      priceType,
      symbol: "BTCUSDT",
      timeframe: "15m",
      startTime: START,
      endTime: START + 450 * INTERVAL,
    });
    assert.equal(result.priceType, priceType);
    assert.equal(result.market, "CRYPTO_FUTURES");
    assert.equal(result.candles.length, 450);
    assert.ok(paths.length >= 3);
    assert.ok(paths.every((path) => path.endsWith(
      priceType === "mark" ? "history-mark-candles" : "history-index-candles",
    )));
    for (let index = 1; index < result.candles.length; index += 1) {
      assert.equal(result.candles[index].timestamp - result.candles[index - 1].timestamp, INTERVAL);
    }
  }
});

test("reference history collector rejects unsupported price type and stalled pagination", async () => {
  const page = rows(200);
  const client = { get: async () => ({ code: "00000", data: page }) };
  await assert.rejects(() => collectBitgetFuturesReferenceCandles({
    client,
    priceType: "premium",
    symbol: "BTCUSDT",
    timeframe: "15m",
    startTime: START,
    endTime: START + 300 * INTERVAL,
  }), /priceType/);
  await assert.rejects(() => collectBitgetFuturesReferenceCandles({
    client,
    priceType: "mark",
    symbol: "BTCUSDT",
    timeframe: "15m",
    startTime: START - 1000 * INTERVAL,
    endTime: START + 500 * INTERVAL,
  }), /pagination did not move backward/);
});

test("futures context combines values and preserves exact decimal strings", async () => {
  const client = {
    get: async (path) => {
      if (path.endsWith("open-interest")) return { data: { openInterestList: [{ symbol: "BTCUSDT", size: "33111.5767" }], ts: "1000" } };
      if (path.endsWith("current-fund-rate")) return { data: [{ fundingRate: "0.000060", fundingRateInterval: "8" }] };
      if (path.endsWith("history-fund-rate")) return { data: [{ fundingRate: "0.000200", fundingTime: "900" }] };
      if (path.endsWith("symbol-price")) return { data: [{ price: "10.0000", markPrice: "10.1000", indexPrice: "9.9000" }] };
      throw new Error("unexpected path");
    },
  };
  const context = await collectBitgetFuturesContext({ client, symbol: "BTCUSDT" });
  assert.equal(context.openInterestRaw, "33111.5767");
  assert.equal(context.openInterest, 33111.5767);
  assert.equal(context.fundingRateRaw, "0.000060");
  assert.equal(context.fundingIntervalHours, 8);
  assert.equal(context.markPriceRaw, "10.1000");
  assert.equal(context.markPrice, 10.1);
  assert.equal(context.fundingHistory[0].rateRaw, "0.000200");
  assert.equal(context.fundingHistory.length, 1);
});
