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

test("Upbit propagates an unexpected fetch implementation SyntaxError unchanged", async () => {
  const defect = new SyntaxError("UNEXPECTED_FETCH_ADAPTER_IMPLEMENTATION_DEFECT");
  let calls = 0;
  await assert.rejects(() => collectUpbitSpotHistory({
    symbol: "BTC", timeframe: "1m", startTime: Date.UTC(2026, 0, 1),
    endTime: Date.UTC(2026, 0, 2), minCandles: 2, minIntervalMs: 0,
    fetchImpl: async () => { calls++; throw defect; },
  }), (error) => error === defect && error.code === undefined);
  assert.equal(calls, 1);
});

test("Upbit classifies malformed response JSON as a known source failure", async () => {
  let calls = 0;
  await assert.rejects(() => collectUpbitSpotHistory({
    symbol: "BTC", timeframe: "1m", startTime: Date.UTC(2026, 0, 1),
    endTime: Date.UTC(2026, 0, 2), minCandles: 2, minIntervalMs: 0,
    fetchImpl: async () => {
      calls++;
      return new Response("{invalid-json", { headers: { "content-type": "application/json" } });
    },
  }), { code: "UPBIT_HISTORY_INVALID_RESPONSE" });
  assert.equal(calls, 1);
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

test("Upbit 1d venue-native history reuses page collector and exact UTC day candles",async()=>{
  const D=86_400_000,day=Date.UTC(2025,9,9),start=day-D,end=day+D;
  const native=[row(day,105),row(day-D,100)].map(x=>({...x,market:"KRW-ETH"}));
  let calls=0;
  const result=await collectUpbitSpotHistory({
    symbol:"KRW-ETH",timeframe:"1d",startTime:start,endTime:end,
    minCandles:2,maxPages:2,minIntervalMs:0,
    requireFullWindow:true,requireMarketIdentity:true,
    fetchImpl:async(url)=>{
      calls++;
      const u=new URL(url);
      assert.equal(u.pathname,"/v1/candles/days");
      assert.equal(u.searchParams.get("market"),"KRW-ETH");
      const cutoff=Date.parse(u.searchParams.get("to"));
      return response(native.filter(x=>Date.parse(x.candle_date_time_utc+"Z")<cutoff));
    },
  });
  assert.equal(result.candleCount,2);
  assert.equal(result.candles[0].timestamp,start);
  assert.equal(result.candles[1].timestamp,day);
  assert.equal(result.rawPageWindowTraversed,true);
  assert.equal(result.historicPointInTimeListingComplete,false);
  assert.equal(result.actualFillProven,false);
  assert.ok(calls>=1);
});
test("Upbit all-name native 1d intake rejects wrong or missing response market",async()=>{
  const D=86_400_000,day=Date.UTC(2025,9,9);
  for(const payload of [
    [{...row(day),market:"KRW-SOL"}],
    [row(day)],
  ]) {
    await assert.rejects(()=>collectUpbitSpotHistory({
      symbol:"KRW-ETH",timeframe:"1d",
      startTime:day-D,endTime:day+D,minCandles:2,minIntervalMs:0,
      requireMarketIdentity:true,
      fetchImpl:async()=>response(payload),
    }),/UPBIT_HISTORY_MARKET_IDENTITY_UNVERIFIED/);
  }
});

test("Upbit rejects missing, impossible or misaligned candle starts even with a plausible trade timestamp", async () => {
  const start = Date.UTC(2026, 0, 1), interval = 60_000;
  const good = [row(start), row(start + interval), row(start + 2 * interval)];
  for (const boundary of [undefined, "", "not-a-date", "2026-02-30T00:00:00", "2026-01-01T00:02:01", "2026-01-01T09:02:00+09:00"]) {
    await assert.rejects(() => collectUpbitSpotHistory({
      symbol: "BTC", timeframe: "1m", startTime: start, endTime: start + 4 * interval,
      minCandles: 2, minIntervalMs: 0,
      fetchImpl: async () => response([...good, { ...row(start + 3 * interval), candle_date_time_utc: boundary }]),
    }), { code: "UPBIT_HISTORY_INVALID_CANDLE_BOUNDARY" });
  }
});

test("Upbit blocks malformed OHLCV instead of silently dropping the corrupt candle", async () => {
  const start = Date.UTC(2026, 0, 1), interval = 60_000;
  for (const corrupt of [
    { high_price: 99 }, { low_price: 102 }, { opening_price: 0 },
    { candle_acc_trade_volume: null }, { candle_acc_trade_volume: "" },
    { candle_acc_trade_volume: false }, { candle_acc_trade_volume: [] },
    { candle_acc_trade_volume: -1 }, { candle_acc_trade_price: -1 },
    { candle_acc_trade_price: null }, { trade_price: Number.NaN },
  ]) {
    await assert.rejects(() => collectUpbitSpotHistory({
      symbol: "ETH", timeframe: "1m", startTime: start, endTime: start + 3 * interval,
      minCandles: 2, minIntervalMs: 0,
      fetchImpl: async () => response([row(start), { ...row(start + interval), ...corrupt }, row(start + 2 * interval)]),
    }), { code: "UPBIT_HISTORY_INVALID_OHLCV" });
  }
});

test("Upbit excludes the unfinished final candle for every supported timeframe", async () => {
  const start = Date.UTC(2026, 0, 1);
  for (const [timeframe, interval] of [["1m", 60_000], ["60m", 3_600_000], ["4h", 14_400_000], ["1d", 86_400_000]]) {
    const endTime = start + 3.5 * interval;
    const result = await collectUpbitSpotHistory({
      symbol: "BTC", timeframe, startTime: start, endTime,
      minCandles: 2, minIntervalMs: 0, requireFullWindow: true,
      fetchImpl: async (url) => {
        assert.equal(Date.parse(new URL(url).searchParams.get("to")), start + 3 * interval);
        // Include the open row even if an upstream server ignores the boundary.
        return response(Array.from({ length: 4 }, (_, index) => row(start + index * interval)));
      },
    });
    assert.deepEqual(result.candles.map((candle) => candle.timestamp), [start, start + interval, start + 2 * interval]);
    assert.ok(result.candles.every((candle) => candle.timestamp + interval <= endTime));
  }
});

test("Upbit future end times cannot include future candles or claim complete traversal", async () => {
  const interval = 60_000, now = Date.now(), boundary = Math.floor(now / interval) * interval;
  const start = boundary - 5 * interval, endTime = boundary + 10 * interval;
  const source = Array.from({ length: 15 }, (_, index) => row(start + index * interval));
  const config = {
    symbol: "BTC", timeframe: "1m", startTime: start, endTime, minCandles: 2, minIntervalMs: 0,
    fetchImpl: async () => response(source),
  };
  const result = await collectUpbitSpotHistory({ ...config, requireFullWindow: false });
  assert.ok(result.candles.every((candle) => candle.timestamp + interval <= result.collectedAt));
  assert.equal(result.rawPageWindowTraversed, false);
  await assert.rejects(() => collectUpbitSpotHistory(config), { code: "UPBIT_HISTORY_RANGE_INCOMPLETE" });
});

test("Upbit accepts exact duplicates and rejects conflicts within or across response pages", async () => {
  const start = Date.UTC(2026, 0, 1), interval = 60_000;
  const config = { symbol: "BTC", timeframe: "1m", startTime: start, endTime: start + 4 * interval, minCandles: 2, minIntervalMs: 0 };
  const source = Array.from({ length: 4 }, (_, index) => row(start + index * interval));
  const good = await collectUpbitSpotHistory({ ...config, fetchImpl: async () => response([...source, source[1]]) });
  assert.equal(good.candleCount, 4);
  await assert.rejects(() => collectUpbitSpotHistory({
    ...config, fetchImpl: async () => response([...source, { ...source[1], candle_acc_trade_volume: 12 }]),
  }), { code: "UPBIT_HISTORY_DUPLICATE_CONFLICT" });
  let calls = 0;
  await assert.rejects(() => collectUpbitSpotHistory({
    ...config,
    fetchImpl: async () => response(++calls === 1
      ? source.slice(2)
      : [source[0], source[1], { ...source[2], trade_price: 100.5 }]),
  }), { code: "UPBIT_HISTORY_DUPLICATE_CONFLICT" });
  assert.equal(calls, 2);
});

test("Upbit rejects oversized pages, stalled cursors, invalid JSON and an explicit wrong market", async () => {
  const start = Date.UTC(2026, 0, 1), interval = 60_000;
  const config = { symbol: "BTC", timeframe: "1m", startTime: start, endTime: start + 4 * interval, minCandles: 2, minIntervalMs: 0 };
  await assert.rejects(() => collectUpbitSpotHistory({
    ...config, fetchImpl: async () => response(Array(201).fill(row(start))),
  }), { code: "UPBIT_HISTORY_INVALID_PAGE_SIZE" });
  await assert.rejects(() => collectUpbitSpotHistory({
    ...config, fetchImpl: async () => response([row(start + 2 * interval), row(start + 3 * interval)]),
  }), { code: "UPBIT_HISTORY_PAGINATION_STALLED" });
  await assert.rejects(() => collectUpbitSpotHistory({
    ...config, fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad JSON"); } }),
  }), { code: "UPBIT_HISTORY_INVALID_RESPONSE" });
  await assert.rejects(() => collectUpbitSpotHistory({
    ...config, fetchImpl: async () => response([{ ...row(start), market: "KRW-ETH" }, row(start + interval)]),
  }), { code: "UPBIT_HISTORY_MARKET_IDENTITY_UNVERIFIED" });
});

test("Upbit applies a bounded request signal and preserves caller cancellation", async () => {
  const start = Date.UTC(2026, 0, 1), interval = 60_000;
  const config = { symbol: "BTC", timeframe: "1m", startTime: start, endTime: start + 2 * interval, minCandles: 2, minIntervalMs: 0 };
  const controller = new AbortController();
  const reason = new Error("caller cancelled acquisition");
  const pending = collectUpbitSpotHistory({
    ...config, signal: controller.signal,
    fetchImpl: async (_url, options) => {
      assert.ok(options.signal instanceof AbortSignal);
      return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
    },
  });
  controller.abort(reason);
  await assert.rejects(() => pending, (error) => error === reason);
  await assert.rejects(() => collectUpbitSpotHistory({ ...config, timeoutMs: 0 }), /timeoutMs/);
  await assert.rejects(() => collectUpbitSpotHistory({ ...config, minIntervalMs: Number.NaN }), /minIntervalMs/);
});
