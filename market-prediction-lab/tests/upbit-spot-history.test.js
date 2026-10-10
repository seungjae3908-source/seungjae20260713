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
    candle_acc_trade_price: price * 10,
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


test("collector supports exact 60m Scanner context history without relabeling", async () => {
  const endTime = Date.UTC(2026, 7, 12, 0, 0);
  const interval = 60 * 60 * 1000;
  const all = Array.from({ length: 130 }, (_, index) => row(endTime - (index + 1) * interval, 200 + index));
  const calls = [];
  const result = await collectUpbitSpotHistory({
    symbol: "BTC", timeframe: "60m", startTime: endTime - 130 * interval, endTime, minIntervalMs: 0,
    fetchImpl: async (url) => { calls.push(url); return response(all); },
  });
  assert.equal(result.timeframe, "60m");
  assert.equal(result.intervalMs, interval);
  assert.ok(calls.every((url) => url.includes("/v1/candles/minutes/60?")));
  assert.ok(result.candles.every((item) => item.quoteVolume != null && item.quoteVolume >= 0));
});

test("collector rejects unsupported timeframe instead of silently rewriting it", async () => {
  await assert.rejects(
    collectUpbitSpotHistory({ symbol: "BTC", timeframe: "1h", startTime: 1, endTime: 2 }),
    /unsupported Upbit history timeframe/,
  );
});


test("Upbit KRW native 1m history traces bounded pages but not historical scanner availability", async () => {
  const end=Date.UTC(2026,7,12);
  const all=Array.from({length:130},(_,i)=>row(end-(i+1)*60_000,100+i));
  const result=await collectUpbitSpotHistory({
    symbol:"KRW-BTC",timeframe:"1m",startTime:end-120*60_000,endTime:end,
    minCandles:2,minIntervalMs:0,
    fetchImpl:async(url)=>{
      assert.ok(url.includes("/v1/candles/minutes/1?"));
      const to=Date.parse(new URL(url).searchParams.get("to"));
      return response(all.filter(r=>r.timestamp<to).slice(0,200));
    },
  });
  assert.equal(result.providerMarket,"KRW-BTC");
  assert.equal(result.intervalMs,60_000);
  assert.equal(result.candleCount,120);
  assert.equal(result.rawPageWindowTraversed,true);
  assert.equal(result.historicalSignalAvailabilityProven,false);
  assert.equal(result.historicPointInTimeListingComplete,false);
  assert.equal(result.missingMinuteNoTradeProof,false);
});

test("Upbit 1m partial maximum-page range fails closed", async () => {
  const end=Date.UTC(2026,7,12);
  const all=Array.from({length:200},(_,i)=>row(end-(i+1)*60_000,100+i));
  await assert.rejects(()=>collectUpbitSpotHistory({
    symbol:"ETH",timeframe:"1m",startTime:end-2_000*60_000,endTime:end,
    maxPages:1,minCandles:2,minIntervalMs:0,
    fetchImpl:async()=>response(all),
  }),/UPBIT_HISTORY_RANGE_INCOMPLETE/);
});
