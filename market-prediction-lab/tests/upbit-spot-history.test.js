import test from "node:test";
import assert from "node:assert/strict";
import { collectUpbitSpotHistory, upbitKrwMarketCode } from "../src/upbit-spot-history.js";

function row(timestamp, price = 100) {
  return {
    timestamp,
    candle_date_time_utc: new Date(timestamp).toISOString().slice(0, 19),
    opening_price: price,
    high_price: price + 1,
    low_price: price - 1,
    trade_price: price + 0.2,
    candle_acc_trade_volume: 10,
  };
}

function response(rows, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return rows; } };
}

test("Upbit market normalization is KRW spot only", () => {
  assert.equal(upbitKrwMarketCode("BTC"), "KRW-BTC");
  assert.equal(upbitKrwMarketCode("KRW-ETH"), "KRW-ETH");
  assert.throws(() => upbitKrwMarketCode("BTC/USDT"), /invalid Upbit/);
});

test("collector paginates backwards with exclusive to cursor and returns increasing 4h candles", async () => {
  const endTime = Date.UTC(2026, 7, 12, 0, 0);
  const all = Array.from({ length: 260 }, (_, index) => row(endTime - (index + 1) * 4 * 60 * 60 * 1000, 100 + index));
  const calls = [];
  const result = await collectUpbitSpotHistory({
    symbol: "BTC",
    startTime: endTime - 250 * 4 * 60 * 60 * 1000,
    endTime,
    minIntervalMs: 0,
    fetchImpl: async (url) => {
      calls.push(url);
      const parsed = new URL(url);
      const to = Date.parse(parsed.searchParams.get("to"));
      return response(all.filter((item) => item.timestamp < to).slice(0, 200));
    },
  });
  assert.equal(result.exchange, "UPBIT");
  assert.equal(result.providerMarket, "KRW-BTC");
  assert.ok(result.candleCount >= 240);
  assert.ok(calls.length >= 2);
  assert.ok(result.candles.every((item, index) => index === 0 || item.timestamp > result.candles[index - 1].timestamp));
  assert.equal(result.liveOrderAllowed, false);
  assert.equal(result.privateAccountRequestAllowed, false);
});

test("collector rejects a public provider HTTP failure", async () => {
  await assert.rejects(
    collectUpbitSpotHistory({
      symbol: "ETH",
      startTime: Date.UTC(2026, 0, 1),
      endTime: Date.UTC(2026, 7, 1),
      minIntervalMs: 0,
      fetchImpl: async () => response([], 429),
    }),
    /UPBIT_HISTORY_HTTP_429/,
  );
});

test("collector uses the candle boundary rather than an intra-candle trade timestamp", async () => {
  const endTime = Date.UTC(2026, 7, 12, 0, 0);
  const all = Array.from({ length: 130 }, (_, index) => {
    const boundary = endTime - (index + 1) * 4 * 60 * 60 * 1000;
    return { ...row(boundary, 100 + index), timestamp: boundary + 73_456 };
  });
  const result = await collectUpbitSpotHistory({
    symbol: "BTC",
    startTime: endTime - 130 * 4 * 60 * 60 * 1000,
    endTime,
    minIntervalMs: 0,
    fetchImpl: async () => response(all),
  });
  assert.ok(result.candles.every((item) => item.timestamp % (4 * 60 * 60 * 1000) === 0));
});
