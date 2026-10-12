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
      // The endpoint permits at most 200 rows, including an exact duplicate.
      const page = eligible.slice(-(calls === 1 ? 199 : 200));
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


test("Bitget USDT futures 1m history uses the existing historical public client", async () => {
  const M=60_000;
  const candles=Array.from({length:250},(_,i)=>[String(START+i*M),"100","101","99","100","50","5000"]);
  const seen=[];
  const client={get:async(path,params)=>{
    seen.push({path,params});
    return {code:"00000",data:candles.filter(r=>Number(r[0])<Number(params.endTime)).slice(-200)};
  }};
  const result=await collectBitgetCandles({
    client,market:"CRYPTO_FUTURES",symbol:"BTCUSDT",timeframe:"1m",
    startTime:START,endTime:START+250*M,minCandles:2,
  });
  assert.equal(result.candles.length,250);
  assert.equal(result.rawPageWindowTraversed,true);
  assert.equal(result.historicalSignalAvailabilityProven,false);
  assert.equal(result.historicPointInTimeContractUniverseComplete,false);
  assert.ok(seen.length>=2);
  assert.ok(seen.every(p=>p.path.endsWith("/mix/market/history-candles") &&
    p.params.granularity==="1m" && p.params.productType==="usdt-futures"));
});

test("Bitget 1m truncation must not be reported as complete history", async () => {
  const M=60_000;
  const candles=Array.from({length:300},(_,i)=>[String(START+i*M),"100","101","99","100","50","5000"]);
  const client={get:async(_path,params)=>({
    code:"00000",data:candles.filter(r=>Number(r[0])<Number(params.endTime)).slice(-200)
  })};
  await assert.rejects(()=>collectBitgetCandles({
    client,market:"CRYPTO_FUTURES",symbol:"BTCUSDT",timeframe:"1m",
    startTime:START,endTime:START+300*M,maxCandles:60,minCandles:2,
  }),/BITGET_HISTORY_RANGE_INCOMPLETE/);
});

test("Bitget rejects missing or coerced numeric fields and negative quote volume", () => {
  const valid = rows(1)[0];
  for (const index of [0, 1, 2, 3, 4, 5, 6]) {
    for (const malformed of [null, "", " ", false, [], {}, "NaN", "Infinity"]) {
      const corrupt = [...valid]; corrupt[index] = malformed;
      assert.throws(() => normalizeBitgetCandle(corrupt), { code: "BITGET_HISTORY_INVALID_CANDLE" });
    }
  }
  const negativeQuote = [...valid]; negativeQuote[6] = "-1";
  assert.throws(() => normalizeBitgetCandle(negativeQuote), { code: "BITGET_HISTORY_INVALID_CANDLE" });
  // A provider may omit its optional quote-volume column; missing base volume
  // must never be interpreted as a genuine zero-volume minute.
  assert.equal(normalizeBitgetCandle(valid.slice(0, 6)).quoteVolume, undefined);
});

test("Bitget rejects misaligned minute candles instead of accepting last-trade timestamps", async () => {
  const M = 60_000;
  const source = Array.from({ length: 3 }, (_, index) => [String(START + index * M), "100", "101", "99", "100", "10"]);
  source[1][0] = String(START + M + 17_000);
  await assert.rejects(() => collectBitgetCandles({
    client: { get: async () => ({ code: "00000", data: source }) },
    market: "CRYPTO_FUTURES", symbol: "BTCUSDT", timeframe: "1m",
    startTime: START, endTime: START + 3 * M, minCandles: 2,
  }), { code: "BITGET_HISTORY_INVALID_CANDLE_BOUNDARY" });
});

test("Bitget excludes unfinished candles while retaining the generic exchange-day timezone", async () => {
  const M = 60_000, D = 86_400_000;
  for (const [timeframe, interval, start, endTime, expectedCount] of [
    ["1m", M, START, START + 3.5 * M, 3],
    ["15m", INTERVAL, START, START + 3.5 * INTERVAL, 3],
    // 1D is a different contract from 1Dutc. At 12:00 UTC the 16:00 UTC
    // exchange-day bar from yesterday remains unfinished until 16:00 UTC.
    ["1d", D, START + 16 * 3_600_000, START + 3 * D + 12 * 3_600_000, 2],
  ]) {
    const source = Array.from({ length: 4 }, (_, index) => [String(start + index * interval), "100", "101", "99", "100", "10"]);
    const result = await collectBitgetCandles({
      client: { get: async (_path, params) => {
        if (timeframe === "1d") assert.equal(params.granularity, "1D");
        return { code: "00000", data: source };
      } },
      market: "CRYPTO_FUTURES", symbol: "BTCUSDT", timeframe,
      startTime: start, endTime, minCandles: 2, requireFullWindow: true,
    });
    assert.equal(result.candles.length, expectedCount);
    assert.ok(result.candles.every((candle) => candle.timestamp + interval <= endTime));
    assert.equal(result.candles[0].timestamp, start);
  }
});

test("Bitget future requests stay source-limited and cannot include future candles", async () => {
  const M = 60_000, boundary = Math.floor(Date.now() / M) * M;
  const start = boundary - 5 * M;
  const source = Array.from({ length: 15 }, (_, index) => [String(start + index * M), "100", "101", "99", "100", "10"]);
  const config = {
    client: { get: async () => ({ code: "00000", data: source }) },
    market: "CRYPTO_FUTURES", symbol: "BTCUSDT", timeframe: "1m",
    startTime: start, endTime: boundary + 10 * M, minCandles: 2,
  };
  const result = await collectBitgetCandles({ ...config, requireFullWindow: false });
  assert.ok(result.candles.every((candle) => candle.timestamp + M <= result.collectedAt));
  assert.equal(result.rawPageWindowTraversed, false);
  await assert.rejects(() => collectBitgetCandles(config), { code: "BITGET_HISTORY_RANGE_INCOMPLETE" });
});

test("Bitget detects conflicting duplicates inside a page and across overlapping pages", async () => {
  const M = 60_000;
  const source = Array.from({ length: 300 }, (_, index) => [String(START + index * M), "100", "101", "99", "100", "10", "1000"]);
  const config = { market: "CRYPTO_FUTURES", symbol: "BTCUSDT", timeframe: "1m", startTime: START, endTime: START + 300 * M, minCandles: 2 };
  const samePageConflict = [...source[1]]; samePageConflict[5] = "12";
  await assert.rejects(() => collectBitgetCandles({
    ...config, client: { get: async () => ({ code: "00000", data: [...source.slice(0, 3), samePageConflict] }) },
  }), { code: "BITGET_HISTORY_DUPLICATE_CONFLICT" });
  for (const conflicting of [false, true]) {
    let calls = 0;
    const overlap = [...source[100]];
    if (conflicting) overlap[4] = "100.5";
    const pending = collectBitgetCandles({
      ...config, client: { get: async () => ({
        code: "00000", data: ++calls === 1 ? source.slice(100) : [...source.slice(0, 100), overlap],
      }) },
    });
    if (conflicting) await assert.rejects(() => pending, { code: "BITGET_HISTORY_DUPLICATE_CONFLICT" });
    else {
      const result = await pending;
      assert.equal(result.candles.length, 300);
      assert.equal(result.rawPageWindowTraversed, true);
    }
    assert.equal(calls, 2);
  }
});

test("Bitget rejects oversized or malformed pages in traded and mark/index history", async () => {
  for (const data of [rows(201), null, {}]) {
    const expectedCode = Array.isArray(data) ? "BITGET_HISTORY_INVALID_PAGE_SIZE" : "BITGET_HISTORY_INVALID_RESPONSE";
    const client = { get: async () => ({ code: "00000", data }) };
    await assert.rejects(() => collectBitgetCandles({
      client, market: "CRYPTO_FUTURES", symbol: "BTCUSDT", timeframe: "15m", startTime: START, endTime: START + 300 * INTERVAL,
    }), { code: expectedCode });
    for (const priceType of ["mark", "index"]) {
      await assert.rejects(() => collectBitgetFuturesReferenceCandles({
        client, priceType, symbol: "BTCUSDT", timeframe: "15m", startTime: START, endTime: START + 300 * INTERVAL,
      }), { code: expectedCode });
    }
  }
});

test("Bitget preserves native Han contract symbols and rejects unsafe symbol characters", async () => {
  const M = 60_000;
  const source = Array.from({ length: 2 }, (_, index) => [String(START + index * M), "100", "101", "99", "100", "10"]);
  for (const symbol of ["龙虾USDT", "牛来USDT", "哈基米USDT"]) {
    const result = await collectBitgetCandles({
      client: { get: async (_path, params) => {
        assert.equal(params.symbol, symbol);
        return { code: "00000", data: source };
      } },
      market: "CRYPTO_FUTURES", symbol, timeframe: "1m", startTime: START, endTime: START + 2 * M, minCandles: 2,
    });
    assert.equal(result.symbol, symbol);
  }
  for (const symbol of ["btcusdt", "BTC/USDT", "BTC USDT", "BTC\nUSDT", "../USDT", "龙虾?USDT"]) {
    await assert.rejects(() => collectBitgetCandles({
      client: { get: async () => { throw new Error("unsafe symbol must not reach a provider"); } },
      market: "CRYPTO_FUTURES", symbol, timeframe: "1m", startTime: START, endTime: START + 2 * M, minCandles: 2,
    }), /symbol must contain/);
  }
});


test("Bitget short 1m history pages continue backward until the actual requested start", async()=>{
 const MIN=60_000, all=Array.from({length:260},(_,i)=>
  [String(START+i*MIN),"100","101","99","100","5","500"]);
 const seen=[];
 const client={get:async(path,params)=>{
  seen.push({path,params});
  const rows=all.filter(x=>Number(x[0])<Number(params.endTime)).slice(-71);
  assert.ok(rows.length<=71&&rows.length<=Number(params.limit));
  return {code:"00000",data:rows};
 }};
 const result=await collectBitgetCandles({
  client,market:"CRYPTO_FUTURES",symbol:"BTCUSDT",timeframe:"1m",
  startTime:START,endTime:START+260*MIN,minCandles:2,maxPages:12,
 });
 assert.equal(result.candles.length,260);
 assert.equal(result.candles[0].timestamp,START);
 assert.equal(result.candles.at(-1).timestamp,START+259*MIN);
 assert.equal(result.rawPageWindowTraversed,true);
 assert.equal(result.reachedRequestedStart,true);
 assert.equal(result.requestedProviderPages,4);
 assert.equal(seen.length,4);
 assert.ok(seen.every(e=>e.path.endsWith("/mix/market/history-candles")));
 assert.equal(result.missingMinuteNoTradeProof,false);
 assert.equal(result.historicalSignalAvailabilityProven,false);
});

test("short history page followed by empty page is incomplete, not a no-trade or profitability proof", async()=>{
 const MIN=60_000;
 const last=Array.from({length:70},(_,i)=>
  [String(START+(200+i)*MIN),"100","101","99","100","3"]);
 let calls=0;
 const client={get:async()=>({
  code:"00000",data:++calls===1?last:[],
 })};
 await assert.rejects(()=>collectBitgetCandles({
  client,market:"CRYPTO_FUTURES",symbol:"BTCUSDT",timeframe:"1m",
  startTime:START,endTime:START+270*MIN,minCandles:2,maxPages:5,
 }),{code:"BITGET_HISTORY_RANGE_INCOMPLETE"});
 assert.equal(calls,2);
 calls=0;
 const partial=await collectBitgetCandles({
  client,market:"CRYPTO_FUTURES",symbol:"BTCUSDT",timeframe:"1m",
  startTime:START,endTime:START+270*MIN,minCandles:2,maxPages:5,
  requireFullWindow:false,allowPartialSource:true,
 });
 assert.equal(partial.rawPageWindowTraversed,false);
 assert.equal(partial.reachedRequestedStart,false);
 assert.equal(partial.requestedProviderPages,2);
 assert.equal(partial.candles.length,70);
 assert.equal(partial.missingMinuteNoTradeProof,false);
 assert.equal(partial.actualFillProven,false);
});

test("an underfilled 1m provider never exceeds maxPages or fabricates a completed window", async()=>{
 const MIN=60_000;
 const all=Array.from({length:270},(_,i)=>
  [String(START+i*MIN),"100","101","99","100","5"]);
 let calls=0;
 const client={get:async(_path,params)=>{
  calls++;
  return {code:"00000",
   data:all.filter(x=>Number(x[0])<Number(params.endTime)).slice(-60)};
 }};
 await assert.rejects(()=>collectBitgetCandles({
  client,market:"CRYPTO_FUTURES",symbol:"BTCUSDT",timeframe:"1m",
  startTime:START,endTime:START+270*MIN,minCandles:2,maxPages:3,
 }),{code:"BITGET_HISTORY_PAGE_BUDGET_EXCEEDED"});
 assert.equal(calls,3);
 for(const pages of [0,-1,2.5,2049,Number.NaN]){
  calls=0;
  await assert.rejects(()=>collectBitgetCandles({
   client,market:"CRYPTO_FUTURES",symbol:"BTCUSDT",timeframe:"1m",
   startTime:START,endTime:START+270*MIN,maxPages:pages,
  }),/maxPages must be 1..2048/);
  assert.equal(calls,0,"malformed budget must fail BEFORE network I/O");
 }
});

test("Bitget mark/index reference collectors traverse underfilled history pages and bound requests",async()=>{
 const all=rows(450);
 for(const priceType of ["mark","index"]){
  let calls=0;
  const client={get:async(_path,params)=>{
   calls++;
   return {code:"00000",data:all.filter(x=>Number(x[0])<Number(params.endTime)).slice(-83)};
  }};
  const result=await collectBitgetFuturesReferenceCandles({
   client,priceType,symbol:"BTCUSDT",timeframe:"15m",
   startTime:START,endTime:START+450*INTERVAL,maxPages:12,
  });
  assert.equal(result.candles.length,450);
  assert.equal(result.candles[0].timestamp,START);
  assert.equal(result.requestedProviderPages,6);
  assert.equal(calls,6);
  assert.equal(result.candles.at(-1).timestamp,START+449*INTERVAL);
 }
 let calls=0;
 const client={get:async(_path,params)=>{
  calls++;
  return {code:"00000",data:all.filter(x=>Number(x[0])<Number(params.endTime)).slice(-71)};
 }};
 await assert.rejects(()=>collectBitgetFuturesReferenceCandles({
  client,priceType:"mark",symbol:"BTCUSDT",timeframe:"15m",
  startTime:START,endTime:START+450*INTERVAL,maxPages:2,
 }),{code:"BITGET_HISTORY_PAGE_BUDGET_EXCEEDED"});
 assert.equal(calls,2);
});
