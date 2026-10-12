import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync,
  chmodSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { digestPITMembershipRowsV1 } from "../src/historical-pit-venue-universe-gate-v1.js";
import { collectPITNativeCryptoMinuteSourceV1 as collect,
  normalizeRetrospectiveCryptoMinuteSourceV1 as normalize }
  from "../src/pit-native-crypto-minute-backfill-v1.js";
import { deriveArchivedResearchTimeframesV1 as derive, persistResearchMinuteSessionV1 }
  from "../src/research-minute-archive-v1.js";
import { collectUpbitSpotHistory } from "../src/upbit-spot-history.js";
import { collectBitgetCandles } from "../src/bitget-candle-collector.js";
import { parsePITNativeMinuteBackfillArgsV1 as parse,
  runPITNativeMinuteBackfillCliV1 as cli }
  from "../scripts/pit-native-crypto-minute-backfill-v1.mjs";

const DAY=86_400_000,MIN=60_000;
const START=Date.parse("2026-09-18T00:00:00Z");
const NOW=Date.parse("2026-10-11T00:00:00Z");
const SHA="a".repeat(64);
const tmp=()=>mkdtempSync(join(tmpdir(),"pit-native-public-1m-"));
const nowImpl=()=>NOW;
function manifest(market,symbol,sourceClass="EXCHANGE_DATED_ARCHIVE"){
  const id="TEST_RESEARCH_SOURCE_NOT_OFFICIAL_AUTHENTICATION";
  const members=[
    {symbol,listedAtMs:START-50*DAY,removedAtMs:null,halts:[],
      sourceId:id,evidenceSha256:SHA},
    {symbol:"OLD-DELST",listedAtMs:START-500*DAY,
      removedAtMs:START-100*DAY,halts:[],
      sourceId:id,evidenceSha256:SHA},
  ];
  return {
    schemaVersion:"historical-venue-pit-roster-v1",sourceClass,
    ...(sourceClass==="TEST_FIXTURE"?{testOnly:true}:{}),
    market,venue:market==="CRYPTO_SPOT"?"UPBIT_KRW":"BITGET_USDT_FUTURES",
    coverageStartMs:START-700*DAY,coverageEndMs:START+DAY,
    retrievedAtMs:START+2*DAY,sourceId:id,
    allListedAndRemovedAttested:true,suspensionsAttested:true,
    relistedIdentifiersResolved:true,memberships:members,
    rawMembershipDigestSha256:digestPITMembershipRowsV1(members),
  };
}
function config(root,market,symbol,options={}){
  const pit=options.manifest??manifest(market,symbol);
  return {
    root,market,symbol,dayStartMs:options.dayStartMs??START,
    manifest:pit,
    expectedRosterDigestSha256:options.digest??pit.rawMembershipDigestSha256,
    allowPublicReadOnlyFetch:options.allowPublicReadOnlyFetch??false,
    retryPartialSource:options.retryPartialSource??false,
    expectedExistingSourceDigestSha256:
      options.expectedExistingSourceDigestSha256??null,nowImpl,
    ...(options.upbitFetchImpl?{upbitFetchImpl:options.upbitFetchImpl}:{}),
    ...(options.bitgetClient?{bitgetClient:options.bitgetClient}:{}),
  };
}
function nativeMinute(ts,market="KRW-BTC"){
  return {market,candle_date_time_utc:new Date(ts).toISOString().slice(0,19),
    opening_price:100,high_price:104,low_price:99,
    trade_price:102,candle_acc_trade_volume:2.5,
    candle_acc_trade_price:255};
}
function upbitMock(calls) {
  return async (url,options)=>{
    calls.push({url,method:options?.method??"GET"});
    return {ok:true,status:200,json:async()=>[
      nativeMinute(START+2*MIN),nativeMinute(START+MIN),
      nativeMinute(START),nativeMinute(START-MIN),
    ]};
  };
}
function bitgetMock(calls){
  return {get:async(path,params)=>{
    calls.push({path,params});
    const row=ts=>[String(ts),"100","104","99","102","2.5","255"];
    return {code:"00000",data:[
      row(START+2*MIN),row(START+MIN),row(START),row(START-MIN),
    ]};
  }};
}

function collectedSource(market = "CRYPTO_SPOT", symbol = "KRW-BTC", offsets = [0, 1], overrides = {}) {
  return {
    market, timeframe: "1m", intervalMs: MIN,
    requestedStartTime: START, requestedEndTime: START + DAY,
    rawPageWindowTraversed: true, reachedRequestedStart: true,
    historicalSignalAvailabilityProven: false, actualFillProven: false,
    ...(market === "CRYPTO_SPOT"
      ? { providerMarket: symbol, exchange: "UPBIT", source: "upbit-public-candles" }
      : { symbol, productType: "usdt-futures", provider: "bitget-public-v2" }),
    candles: offsets.map(index => ({ timestamp: START + index * MIN,
      open: 100, high: 104, low: 99, close: 102, volume: 2.5 })),
    ...overrides,
  };
}

test("normalizer strict default still requires provider traversal and two candles", () => {
  const input = { market: "CRYPTO_SPOT", symbol: "KRW-BTC", dayStartMs: START, receivedAtMs: NOW };
  const boundaryMissing = collectedSource("CRYPTO_SPOT", "KRW-BTC", [720, 721], {
    rawPageWindowTraversed: false, reachedRequestedStart: false,
  });
  assert.equal(normalize({ ...input, collected: boundaryMissing }).error, "NATIVE_1M_PROVIDER_SCOPE_OR_HISTORY_UNVERIFIED");
  assert.equal(normalize({ ...input, collected: collectedSource("CRYPTO_SPOT", "KRW-BTC", [0]) }).error, "NATIVE_1M_PROVIDER_SCOPE_OR_HISTORY_UNVERIFIED");
  const strict = normalize({ ...input, collected: collectedSource() });
  assert.equal(strict.providerRequestWindowVerified, true);
  assert.equal(strict.source.minuteBars.length, 2);
  assert.equal(strict.sourcePartialReason, "MISSING_MINUTE_SLOTS_NOT_PROVEN_NO_TRADES");
  assert.equal(strict.missingUnverifiedMinuteSlots, 1438);
  assert.equal(normalize({ ...input, allowPartialSource: "true", collected: boundaryMissing }).error, "NATIVE_1M_PARTIAL_SOURCE_OPTION_INVALID");
});

test("explicit source-only normalization preserves a single listing-edge candle without fabricating traversal", async () => {
  const root = tmp();
  try {
    for (const [market, symbol] of [["CRYPTO_SPOT", "KRW-BTC"], ["CRYPTO_FUTURES", "龙虾USDT"]]) {
      const collected = collectedSource(market, symbol, [1439], {
        rawPageWindowTraversed: false, reachedRequestedStart: false,
      });
      const parsed = normalize({ market, symbol, dayStartMs: START, receivedAtMs: NOW, collected, allowPartialSource: true });
      assert.ok(parsed.source);
      assert.equal(parsed.providerRequestWindowVerified, false);
      assert.equal(parsed.providerRawPageWindowTraversed, false);
      assert.equal(parsed.providerReachedRequestedStart, false);
      assert.equal(parsed.sourcePartialReason, "PROVIDER_REQUEST_WINDOW_NOT_FULLY_TRAVERSED");
      assert.equal(parsed.missingUnverifiedMinuteSlots, 1439);
      assert.equal(parsed.source.minuteBars[0].timestampMs, START + 1439 * MIN);
      assert.equal(parsed.source.minuteBars[0].availableAtMs, NOW);
      assert.equal(collected.rawPageWindowTraversed, false);
      assert.equal(Object.hasOwn(parsed.source, "providerRequestWindowVerified"), false);
      await persistResearchMinuteSessionV1({ root, source: parsed.source });
      const saved = await derive({ root, market, symbol, sessionStartMs: START, asOfMs: NOW, timeframes: ["1m", "3m"] });
      assert.equal(saved.sourceMinuteRows, 1);
      assert.equal(saved.intervalData["1m"].bars.length, 1);
      assert.equal(saved.intervalData["3m"].bars.length, 0);
      assert.equal(saved.historicalWholeMarketSourceCoverageVerified, false);
      assert.equal(saved.profitabilityProven, false);
      const historical = await derive({ root, market, symbol, sessionStartMs: START, asOfMs: START + DAY, timeframes: ["1m"] });
      assert.equal(historical.intervalData["1m"].bars.length, 0);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("partial option preserves each pagination boolean and distinguishes missing slots from a complete source window", () => {
  const input = { market: "CRYPTO_SPOT", symbol: "KRW-BTC", dayStartMs: START, receivedAtMs: NOW, allowPartialSource: true };
  const partial = normalize({ ...input, collected: collectedSource("CRYPTO_SPOT", "KRW-BTC", [0], {
    rawPageWindowTraversed: false, reachedRequestedStart: true,
  }) });
  assert.equal(partial.providerRequestWindowVerified, false);
  assert.equal(partial.providerRawPageWindowTraversed, false);
  assert.equal(partial.providerReachedRequestedStart, true);
  const complete = normalize({ ...input, collected: collectedSource("CRYPTO_SPOT", "KRW-BTC", Array.from({ length: 1440 }, (_, i) => i)) });
  assert.equal(complete.providerRequestWindowVerified, true);
  assert.equal(complete.sourcePartialReason, null);
  assert.equal(complete.missingUnverifiedMinuteSlots, 0);
  for (const overrides of [
    { rawPageWindowTraversed: undefined }, { reachedRequestedStart: undefined },
    { rawPageWindowTraversed: "true" }, { rawPageWindowTraversed: true, reachedRequestedStart: false },
  ]) {
    assert.equal(normalize({ ...input, collected: collectedSource("CRYPTO_SPOT", "KRW-BTC", [0], overrides) }).error, "NATIVE_1M_PROVIDER_SCOPE_OR_HISTORY_UNVERIFIED");
  }
});

test("source-only normalization never relaxes capture clock, UTC day, venue or candle integrity", () => {
  const input = { market: "CRYPTO_SPOT", symbol: "KRW-BTC", dayStartMs: START, receivedAtMs: NOW, allowPartialSource: true, collected: collectedSource() };
  for (const receivedAtMs of [undefined, null, Number.NaN, -1, NOW + 0.5, START + DAY - 1, 8_640_000_000_000_001])
    assert.equal(normalize({ ...input, receivedAtMs }).error, "NATIVE_1M_CAPTURE_CLOCK_OR_DAY_INVALID");
  for (const dayStartMs of [undefined, null, 0, START + 1, START + MIN, Number.NaN])
    assert.equal(normalize({ ...input, dayStartMs }).error, "NATIVE_1M_CAPTURE_CLOCK_OR_DAY_INVALID");
  for (const override of [{ market: "US_STOCK" }, { market: "__proto__" }, { symbol: "../BTC" }, { symbol: "USDT-BTC" }])
    assert.equal(normalize({ ...input, ...override }).error, "NATIVE_1M_SOURCE_IDENTITY_INVALID");
  for (const override of [
    { exchange: "OTHER" }, { providerMarket: "KRW-ETH" }, { source: "binance-spot" },
    { timeframe: "5m" }, { intervalMs: 300_000 }, { requestedStartTime: START + MIN },
    { requestedEndTime: START + DAY + MIN }, { historicalSignalAvailabilityProven: true },
    { actualFillProven: true }, { candles: [] },
  ]) assert.equal(normalize({ ...input, collected: { ...input.collected, ...override } }).error, "NATIVE_1M_PROVIDER_SCOPE_OR_HISTORY_UNVERIFIED");
  for (const bad of [
    { timestamp: START - MIN }, { timestamp: START + DAY }, { timestamp: START + 1 },
    { open: 0 }, { high: 99 }, { low: 104 }, { close: Number.NaN }, { volume: null }, { volume: -1 },
  ]) {
    const collected = { ...input.collected, candles: [{ ...input.collected.candles[0], ...bad }] };
    assert.equal(normalize({ ...input, collected }).error, "NATIVE_1M_ROW_ORDER_OR_OHLC_INVALID");
  }
  const duplicate = { ...input.collected, candles: [input.collected.candles[0], input.collected.candles[0]] };
  assert.equal(normalize({ ...input, collected: duplicate }).error, "NATIVE_1M_ROW_ORDER_OR_OHLC_INVALID");
});

test("one-candle native collectors require explicit source-only opt-in while canonical PIT remains strict", async () => {
  const ts = START + 720 * MIN;
  const spotConfig = { symbol: "KRW-BTC", timeframe: "1m", startTime: START, endTime: START + DAY,
    minCandles: 1, minIntervalMs: 0, requireFullWindow: false,
    fetchImpl: async url => ({ ok: true, status: 200, json: async () =>
      Date.parse(new URL(url).searchParams.get("to")) > ts ? [nativeMinute(ts)] : [] }),
  };
  await assert.rejects(() => collectUpbitSpotHistory(spotConfig), /minCandles/);
  await assert.rejects(() => collectUpbitSpotHistory({ ...spotConfig, allowPartialSource: true, requireFullWindow: true }), /allowPartialSource/);
  const spot = await collectUpbitSpotHistory({ ...spotConfig, allowPartialSource: true });
  assert.equal(spot.candles.length, 1);
  assert.equal(spot.reachedRequestedStart, false);
  assert.equal(spot.rawPageWindowTraversed, false);
  const futuresConfig = { client: { get: async (_path,params) => ({
      code: "00000",
      // endTime is exclusive. The prior single candle is NOT a new response.
      data: Number(params.endTime)>ts
        ?[[String(ts), "100", "104", "99", "102", "2.5"]]:[],
    }) },
    market: "CRYPTO_FUTURES", symbol: "BTCUSDT", timeframe: "1m", startTime: START, endTime: START + DAY,
    minCandles: 1, requireFullWindow: false,
  };
  await assert.rejects(() => collectBitgetCandles(futuresConfig), /minCandles/);
  await assert.rejects(() => collectBitgetCandles({ ...futuresConfig, allowPartialSource: true, requireFullWindow: true }), /allowPartialSource/);
  const future = await collectBitgetCandles({ ...futuresConfig, allowPartialSource: true });
  assert.equal(future.candles.length, 1);
  assert.equal(future.rawPageWindowTraversed, false);
  const parsed = normalize({ market: "CRYPTO_FUTURES", symbol: "BTCUSDT", dayStartMs: START, receivedAtMs: NOW, collected: future, allowPartialSource: true });
  assert.ok(parsed.source);
  const root = tmp();
  try {
    const canonical = await collect({ ...config(root, "CRYPTO_SPOT", "KRW-BTC", {
      allowPublicReadOnlyFetch: true, upbitFetchImpl: spotConfig.fetchImpl,
    }), allowPartialSource: true });
    assert.equal(canonical.status, "BLOCKED_DATA");
    assert.equal(canonical.reason, "NATIVE_1M_PROVIDER_DATA_UNAVAILABLE");
    assert.equal(canonical.providerReason, "UPBIT_HISTORY_RANGE_INCOMPLETE");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Upbit PIT public 1m opt-in stores private source, no historical as-of fabrication",async()=>{
  const root=tmp(),calls=[];
  try{
    const denied=await collect(config(root,"CRYPTO_SPOT","KRW-BTC",{
      upbitFetchImpl:upbitMock(calls)}));
    assert.equal(denied.reason,"EXPLICIT_PUBLIC_READ_ONLY_OPT_IN_REQUIRED");
    assert.equal(calls.length,0);
    const result=await collect(config(root,"CRYPTO_SPOT","KRW-BTC",{
      allowPublicReadOnlyFetch:true,upbitFetchImpl:upbitMock(calls)}));
    assert.equal(result.status,"RETROSPECTIVE_PRIVATE_SOURCE_RETAINED_ONLY");
    assert.equal(result.sourceMinuteCount,3);
    assert.equal(result.venue,"UPBIT_KRW");
    assert.equal(result.sourceHistoricalPublicationTimeProven,false);
    assert.equal(result.historicalFullMarketPITUniverseVerified,false);
    assert.equal(result.actualMarketWideOpportunityCount,null);
    assert.equal(result.trueMarketWideRecall,null);
    assert.equal(result.executionAuthority,"NONE");
    assert.equal(calls.length,1);
    assert.match(calls[0].url,/api\.upbit\.com\/v1\/candles\/minutes\/1/);
    const original=await derive({root,market:"CRYPTO_SPOT",
      symbol:"KRW-BTC",sessionStartMs:START,asOfMs:NOW,timeframes:["1m","3m"]});
    assert.equal(original.sourceMinuteRows,3);
    assert.equal(original.intervalData["1m"].completeBarCount,3);
    assert.equal(original.intervalData["3m"].completeBarCount,1);
    assert.equal(original.intervalData["1m"].bars[0].availableAtMs,NOW);
    assert.equal(original.fullMarketOpportunityDenominatorVerified,false);
    const atHistoricalEnd=await derive({root,market:"CRYPTO_SPOT",
      symbol:"KRW-BTC",sessionStartMs:START,asOfMs:START+DAY,timeframes:["1m"]});
    assert.equal(atHistoricalEnd.intervalData["1m"].completeBarCount,0);
    assert.equal(atHistoricalEnd.intervalData["1m"].barDataUnavailableAtCutoffBuckets,3);
    assert.equal(atHistoricalEnd.profitabilityProven,false);
    const skipped=await collect(config(root,"CRYPTO_SPOT","KRW-BTC",{
      allowPublicReadOnlyFetch:true,upbitFetchImpl:upbitMock(calls)}));
    assert.equal(skipped.reason,"EXISTING_PARTIAL_SOURCE_NEEDS_EXPLICIT_RETRY");
    assert.equal(calls.length,1);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("Bitget public FUTURES 1m uses only Bitget native history, never Binance",async()=>{
  const root=tmp(),calls=[];
  try{
    const result=await collect(config(root,"CRYPTO_FUTURES","BTCUSDT",{
      allowPublicReadOnlyFetch:true,bitgetClient:bitgetMock(calls)}));
    assert.equal(result.status,"RETROSPECTIVE_PRIVATE_SOURCE_RETAINED_ONLY");
    assert.equal(result.venue,"BITGET_USDT_FUTURES");
    assert.equal(result.sourceMinuteCount,3);
    assert.equal(calls.length,1);
    assert.equal(calls[0].path,"/api/v2/mix/market/history-candles");
    assert.equal(calls[0].params.productType,"usdt-futures");
    assert.equal(calls[0].params.granularity,"1m");
    assert.equal(calls[0].params.symbol,"BTCUSDT");
    const r=await derive({root,market:"CRYPTO_FUTURES",symbol:"BTCUSDT",
      sessionStartMs:START,asOfMs:NOW,timeframes:["1m","5m"]});
    assert.equal(r.sourceMinuteIntegrityVerified,true);
    assert.equal(r.sourceMinuteRows,3);
    assert.equal(r.intervalData["5m"].completeBarCount,0);
    assert.equal(r.historicalWholeMarketSourceCoverageVerified,false);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("missing PIT roster blocks all public GETs even with explicit opt-in",async()=>{
  const root=tmp(),calls=[],market="CRYPTO_SPOT",symbol="KRW-BTC";
  try{
    const opts=config(root,market,symbol,{
      allowPublicReadOnlyFetch:true,upbitFetchImpl:upbitMock(calls),
    });
    const missing=await collect({...opts,manifest:null});
    assert.equal(missing.status,"BLOCKED_DATA");
    assert.equal(missing.reason,"PIT_ROSTER_DIGEST_LEASE_MISMATCH");
    assert.equal(calls.length,0);
    assert.equal(missing.executionAuthority,"NONE");
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("invalid PIT and provider errors never save unsafe source as a normal history",async()=>{
  const root=tmp(),calls=[],market="CRYPTO_SPOT",sym="KRW-BTC";
  try{
    const base=manifest(market,sym);
    const options={allowPublicReadOnlyFetch:true,upbitFetchImpl:upbitMock(calls)};
    const wrongDigest=await collect(config(root,market,sym,{
      ...options,digest:"f".repeat(64)}));
    assert.equal(wrongDigest.reason,"PIT_ROSTER_DIGEST_LEASE_MISMATCH");
    const fixture=await collect(config(root,market,sym,{
      ...options,manifest:manifest(market,sym,"TEST_FIXTURE")}));
    assert.equal(fixture.reason,"PIT_FIXTURE_NOT_ELIGIBLE_FOR_PUBLIC_SOURCE_BACKFILL");
    const wrongVenue=await collect(config(root,market,sym,{
      ...options,manifest:{...base,venue:"BINANCE_SPOT"}}));
    assert.equal(wrongVenue.reason,"PIT_PIT_ARCHIVE_SOURCE_ATTESTATION_INVALID");
    const survivor=await collect(config(root,market,sym,{
      ...options,manifest:{...base,sourceClass:"CURRENT_SNAPSHOT"}}));
    assert.equal(survivor.reason,"PIT_CURRENT_SURVIVOR_LIST_NOT_HISTORICAL_PIT");
    const removedMembers=structuredClone(base);
    removedMembers.memberships[0].removedAtMs=START-MIN;
    removedMembers.rawMembershipDigestSha256=digestPITMembershipRowsV1(removedMembers.memberships);
    const absent=await collect(config(root,market,sym,{
      ...options,manifest:removedMembers}));
    assert.equal(absent.reason,"HISTORIC_SYMBOL_NOT_IN_PIT_DAY");
    const halted=structuredClone(base);
    halted.memberships[0].halts=[{
      startMs:START+MIN,endMs:START+2*MIN,reason:"EXCHANGE_HALT",
    }];
    halted.rawMembershipDigestSha256=digestPITMembershipRowsV1(halted.memberships);
    const halt=await collect(config(root,market,sym,{
      ...options,manifest:halted}));
    assert.equal(halt.reason,"PIT_HISTORIC_TRADING_HALT_NEEDS_SOURCE_PROOF");
    const providerFail=await collect(config(root,market,sym,{
      ...options,upbitFetchImpl:async()=>{
        calls.push("429");return {ok:false,status:429};
      },
    }));
    assert.equal(providerFail.reason,"NATIVE_1M_PROVIDER_DATA_UNAVAILABLE");
    assert.equal(providerFail.status,"BLOCKED_DATA");
    assert.equal(calls.length,1);
    await assert.rejects(()=>collect(config(root,"CRYPTO_FUTURES","BTCUSD",{})),
      /PIT_NATIVE_MINUTE_BACKFILL_ARGUMENTS_INVALID/);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("wrong source identity, unavailable historical window and malformed candles block",async()=>{
  const root=tmp(),market="CRYPTO_SPOT",sym="KRW-BTC";
  try{
    const result=await collect(config(root,market,sym,{
      allowPublicReadOnlyFetch:true,
      upbitFetchImpl:async()=>({ok:true,status:200,json:async()=>[
        nativeMinute(START+2*MIN,"KRW-ETH"),
        nativeMinute(START+MIN,"KRW-ETH"),
        nativeMinute(START,"KRW-ETH"),
        nativeMinute(START-MIN,"KRW-ETH"),
      ]}),
    }));
    assert.equal(result.status,"BLOCKED_DATA");
    assert.equal(result.reason,"NATIVE_PROVIDER_MARKET_IDENTITY_INVALID");
    const none=await derive({root,market,symbol:sym,sessionStartMs:START,
      asOfMs:NOW,timeframes:["1m"]});
    assert.equal(none.reason,"ARCHIVED_SESSION_NOT_FOUND");
    const future=await collect(config(root,market,sym,{
      dayStartMs:START+40*DAY,allowPublicReadOnlyFetch:true,
      upbitFetchImpl:()=>{throw new Error("must not GET future");},
    }));
    assert.equal(future.reason,"HISTORIC_UTC_DAY_NOT_CLOSED");
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("PIT minute source records known malformed provider data but surfaces unknown implementation errors", async () => {
  const root = tmp();
  try {
    const spot = await collect(config(root, "CRYPTO_SPOT", "KRW-BTC", {
      allowPublicReadOnlyFetch: true,
      upbitFetchImpl: async () => ({ ok: true, status: 200, json: async () => [
        nativeMinute(START), { ...nativeMinute(START + MIN), candle_acc_trade_volume: null },
      ] }),
    }));
    assert.equal(spot.status, "BLOCKED_DATA");
    assert.equal(spot.reason, "NATIVE_1M_PROVIDER_DATA_UNAVAILABLE");
    assert.equal(spot.providerReason, "UPBIT_HISTORY_INVALID_OHLCV");
    const future = await collect(config(root, "CRYPTO_FUTURES", "BTCUSDT", {
      allowPublicReadOnlyFetch: true,
      bitgetClient: { get: async () => ({ code: "00000", data: [
        [String(START), "100", "104", "99", "102", "2.5", "255"],
        [String(START + MIN), "100", "104", "99", "102", "2.5", "-255"],
      ] }) },
    }));
    assert.equal(future.status, "BLOCKED_DATA");
    assert.equal(future.reason, "NATIVE_1M_PROVIDER_DATA_UNAVAILABLE");
    assert.equal(future.netProfitPct, null);
    const timeout = await collect(config(root, "CRYPTO_SPOT", "KRW-BTC", {
      allowPublicReadOnlyFetch: true,
      upbitFetchImpl: async () => { throw Object.assign(new Error("request timeout: UPBIT_HISTORY_TIMEOUT"), { code: "UPBIT_HISTORY_TIMEOUT" }); },
    }));
    assert.equal(timeout.reason, "NATIVE_1M_PROVIDER_DATA_UNAVAILABLE");
    const defect = Object.assign(new TypeError("unexpected local defect"), { code: "UPBIT_HISTORY_UNKNOWN_DEFECT" });
    await assert.rejects(() => collect(config(root, "CRYPTO_SPOT", "KRW-BTC", {
      allowPublicReadOnlyFetch: true, upbitFetchImpl: async () => { throw defect; },
    })), (error) => error === defect);
    const archived = await derive({ root, market: "CRYPTO_SPOT", symbol: "KRW-BTC", sessionStartMs: START, asOfMs: NOW, timeframes: ["1m"] });
    assert.equal(archived.reason, "ARCHIVED_SESSION_NOT_FOUND");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("private CLI dry-run outputs blocked receipt; explicit GET stores and duplicate receipt fails",async()=>{
  const root=tmp(),sym="KRW-BTC",market="CRYPTO_SPOT",m=manifest(market,sym);
  try{
    const manifestPath=join(root,"manifest.json"),out=join(root,"result.json");
    writeFileSync(manifestPath,JSON.stringify(m),{mode:0o600});
    const tokens=["--root",root,"--market",market,"--symbol",sym,
      "--day","2026-09-18","--manifest",manifestPath,
      "--expected-roster-sha",m.rawMembershipDigestSha256,
      "--output",out];
    const dry=await cli(parse(tokens),{nowImpl});
    assert.equal(dry.reason,"EXPLICIT_PUBLIC_READ_ONLY_OPT_IN_REQUIRED");
    assert.equal(dry.executionAuthority,"NONE");
    const saved=JSON.parse(readFileSync(out,"utf8"));
    assert.equal(saved.privateTradingApiAllowed,false);
    assert.equal(statSync(out).mode&0o077,0);
    await assert.rejects(()=>cli(parse(tokens),{nowImpl}),
      /PIT_NATIVE_MINUTE_CLI_OUTPUT_EXISTS/);
    const full=await cli(parse([...tokens.slice(0,-2),
      "--output",join(root,"fetched.json"),"--read-public"]),{
      nowImpl,upbitFetchImpl:upbitMock([]),
    });
    assert.equal(full.status,"RETROSPECTIVE_PRIVATE_SOURCE_RETAINED_ONLY");
    assert.equal(full.sourceMinuteCount,3);
    assert.throws(()=>parse([...tokens,"--retry-partial"]),
      /PIT_NATIVE_MINUTE_CLI_SCOPE_INVALID/);
    chmodSync(manifestPath,0o644);
    await assert.rejects(()=>cli(parse([...tokens.slice(0,-2),
      "--output",join(root,"private-error.json")]),{nowImpl}),
      /PIT_NATIVE_MINUTE_CLI_PRIVATE_INPUT_REQUIRED/);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("reviewed retry never rereads a missing or wrong immutable 1m revision",async()=>{
 const root=tmp(),calls=[];
 try{
   const premature=await collect(config(root,"CRYPTO_SPOT","KRW-BTC",{
     allowPublicReadOnlyFetch:true,retryPartialSource:true,
     expectedExistingSourceDigestSha256:SHA,
     upbitFetchImpl:upbitMock(calls),
   }));
   assert.equal(premature.reason,"RETRY_EXISTING_PARTIAL_ARCHIVE_REQUIRED");
   assert.equal(calls.length,0);
   const initial=await collect(config(root,"CRYPTO_SPOT","KRW-BTC",{
     allowPublicReadOnlyFetch:true,upbitFetchImpl:upbitMock(calls)}));
   const oldDigest=initial.archiveSourceDigestSha256;
   assert.match(oldDigest,/^[0-9a-f]{64}$/u);
   const wrong=await collect(config(root,"CRYPTO_SPOT","KRW-BTC",{
     allowPublicReadOnlyFetch:true,retryPartialSource:true,
     expectedExistingSourceDigestSha256:SHA,upbitFetchImpl:upbitMock(calls),
   }));
   assert.equal(wrong.reason,"RETRY_SOURCE_REVISION_DIGEST_MISMATCH");
   assert.equal(calls.length,1,"wrong or stale lease must not make GET");
   await assert.rejects(()=>collect(config(root,"CRYPTO_SPOT","KRW-BTC",{
     allowPublicReadOnlyFetch:true,retryPartialSource:true,
     upbitFetchImpl:upbitMock(calls),
   })),/PIT_NATIVE_MINUTE_BACKFILL_ARGUMENTS_INVALID/);
   assert.equal(calls.length,1);
   const same=await collect(config(root,"CRYPTO_SPOT","KRW-BTC",{
     allowPublicReadOnlyFetch:true,retryPartialSource:true,
     expectedExistingSourceDigestSha256:oldDigest,
     upbitFetchImpl:upbitMock(calls),
   }));
   assert.equal(same.reason,"RETRY_NO_ADDITIONAL_ORIGINAL_MINUTES");
   const still=await derive({root,market:"CRYPTO_SPOT",symbol:"KRW-BTC",
     sessionStartMs:START,asOfMs:NOW,timeframes:["1m"]});
   assert.equal(still.archiveRevisionCount,1);
   assert.equal(still.sourceMinuteRows,3);
   assert.equal(still.profitabilityProven,false);
   assert.equal(calls.length,2);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("retry conflicts/erased minutes are blocked without creating a second archive revision",async()=>{
 const root=tmp(),calls=[];
 try{
   const original=await collect(config(root,"CRYPTO_SPOT","KRW-BTC",{
     allowPublicReadOnlyFetch:true,upbitFetchImpl:upbitMock(calls)}));
   const reviewed=original.archiveSourceDigestSha256;
   const newer=rows=>async(url,options)=>{
     calls.push({url,method:options?.method??"GET"});
     return {ok:true,status:200,json:async()=>rows};
   };
   const conflict=await collect(config(root,"CRYPTO_SPOT","KRW-BTC",{
     allowPublicReadOnlyFetch:true,retryPartialSource:true,
     expectedExistingSourceDigestSha256:reviewed,
     upbitFetchImpl:newer([
       nativeMinute(START+MIN),
       nativeMinute(START),nativeMinute(START-MIN),
     ]),
   }));
   assert.equal(conflict.reason,"RETRY_PRIOR_MINUTE_DISAPPEARED");
   const adjusted=await collect(config(root,"CRYPTO_SPOT","KRW-BTC",{
     allowPublicReadOnlyFetch:true,retryPartialSource:true,
     expectedExistingSourceDigestSha256:reviewed,
     upbitFetchImpl:newer([
       nativeMinute(START+3*MIN),
       {...nativeMinute(START+2*MIN),high_price:108},
       nativeMinute(START+MIN),nativeMinute(START),nativeMinute(START-MIN),
     ]),
   }));
   assert.equal(adjusted.reason,"RETRY_HISTORICAL_PRICE_CONFLICT");
   const read=await derive({root,market:"CRYPTO_SPOT",symbol:"KRW-BTC",
     sessionStartMs:START,asOfMs:NOW,timeframes:["1m"]});
   assert.equal(read.archiveRevisionCount,1);
   assert.equal(read.sourceMinuteRows,3);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("strictly extended native 1m retry preserves old source and requires explicit SHA selection",async()=>{
 const root=tmp(),calls=[];
 const more=async(url,options)=>{
   calls.push({url,method:options?.method??"GET"});
   return {ok:true,status:200,json:async()=>[
     nativeMinute(START+3*MIN),nativeMinute(START+2*MIN),
     nativeMinute(START+MIN),nativeMinute(START),nativeMinute(START-MIN),
   ]};
 };
 try{
   const first=await collect(config(root,"CRYPTO_SPOT","KRW-BTC",{
     allowPublicReadOnlyFetch:true,upbitFetchImpl:upbitMock(calls),
   }));
   const retry=await collect(config(root,"CRYPTO_SPOT","KRW-BTC",{
     allowPublicReadOnlyFetch:true,retryPartialSource:true,
     expectedExistingSourceDigestSha256:first.archiveSourceDigestSha256,
     upbitFetchImpl:more,
   }));
   assert.equal(retry.status,"RETROSPECTIVE_IMMUTABLE_SUPERSET_AWAITING_REVISION_REVIEW");
   assert.equal(retry.reason,"EXPLICIT_ARCHIVE_REVISION_SELECTION_REQUIRED");
   assert.equal(retry.sourceMinuteCount,4);
   assert.equal(retry.priorSourceDigestSha256,first.archiveSourceDigestSha256);
   assert.equal(retry.sourceRevisionAutoSelected,false);
   assert.notEqual(retry.archiveSourceDigestSha256,first.archiveSourceDigestSha256);
   const undecided=await derive({root,market:"CRYPTO_SPOT",symbol:"KRW-BTC",
     sessionStartMs:START,asOfMs:NOW,timeframes:["1m"]});
   assert.equal(undecided.status,"BLOCKED_DATA");
   assert.equal(undecided.reason,"MULTIPLE_SOURCE_REVISIONS_REQUIRE_EXPLICIT_SELECTION");
   const previous=await derive({root,market:"CRYPTO_SPOT",symbol:"KRW-BTC",
     sessionStartMs:START,sourceDigestSha256:first.archiveSourceDigestSha256,
     asOfMs:NOW,timeframes:["1m"]});
   const expanded=await derive({root,market:"CRYPTO_SPOT",symbol:"KRW-BTC",
     sessionStartMs:START,sourceDigestSha256:retry.archiveSourceDigestSha256,
     asOfMs:NOW,timeframes:["1m"]});
   assert.equal(previous.sourceMinuteRows,3);
   assert.equal(expanded.sourceMinuteRows,4);
   assert.equal(expanded.profitabilityProven,false);
   const noFurther=await collect(config(root,"CRYPTO_SPOT","KRW-BTC",{
     allowPublicReadOnlyFetch:true,retryPartialSource:true,
     expectedExistingSourceDigestSha256:retry.archiveSourceDigestSha256,
     upbitFetchImpl:more,
   }));
   assert.equal(noFurther.reason,"EXISTING_ARCHIVE_REQUIRES_MANUAL_SOURCE_REVIEW");
   assert.equal(calls.length,2);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("PIT native 1m CLI retry requires explicit public read and prior immutable digest",()=>{
 const root=tmp(),m=manifest("CRYPTO_SPOT","KRW-BTC");
 const args=["--market","CRYPTO_SPOT","--symbol","KRW-BTC","--day","2026-09-18",
   "--manifest",join(root,"manifest.json"),
   "--expected-roster-sha",m.rawMembershipDigestSha256,
   "--root",root,"--output",join(root,"result.json")];
 try{
   assert.throws(()=>parse([...args,"--retry-partial"]),
     /PIT_NATIVE_MINUTE_CLI_SCOPE_INVALID/);
   assert.throws(()=>parse([...args,"--read-public","--retry-partial"]),
     /PIT_NATIVE_MINUTE_CLI_SCOPE_INVALID/);
   assert.throws(()=>parse([...args,"--expected-existing-sha",SHA]),
     /PIT_NATIVE_MINUTE_CLI_SCOPE_INVALID/);
   const accepted=parse([...args,"--read-public","--retry-partial",
     "--expected-existing-sha",SHA]);
   assert.equal(accepted.retryPartialSource,true);
   assert.equal(accepted.expectedExistingSourceDigestSha256,SHA);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("direct native 1m private CLI previews reviewed partial source without a GET",async()=>{
 const root=tmp(),calls=[],market="CRYPTO_SPOT",symbol="KRW-BTC";
 try{
  const m=manifest(market,symbol);
  const first=await collect(config(root,market,symbol,{
   allowPublicReadOnlyFetch:true,upbitFetchImpl:upbitMock(calls)}));
  assert.equal(first.status,"RETROSPECTIVE_PRIVATE_SOURCE_RETAINED_ONLY");
  const manifestPath=join(root,"dry-roster.json");
  const output=join(root,"dry-preflight.json");
  writeFileSync(manifestPath,JSON.stringify(m),{mode:0o600});
  const args=["--root",root,"--market",market,"--symbol",symbol,
   "--day","2026-09-18","--manifest",manifestPath,
   "--expected-roster-sha",m.rawMembershipDigestSha256,
   "--output",output,"--retry-partial","--expected-existing-sha",
   first.archiveSourceDigestSha256];
  const cfg=parse(args);
  assert.equal(cfg.allowPublicReadOnlyFetch,false);
  assert.equal(cfg.retryPartialSource,true);
  const preview=await cli(cfg,{nowImpl,
   upbitFetchImpl:async()=>{throw Error("PUBLIC_FETCH_FORBIDDEN");}});
  assert.equal(preview.status,"BLOCKED_DATA");
  assert.equal(preview.reason,"EXPLICIT_PUBLIC_READ_ONLY_OPT_IN_REQUIRED");
  assert.equal(preview.executionAuthority,"NONE");
  assert.equal(calls.length,1);
  assert.equal(statSync(output).mode&0o077,0);
 }finally{rmSync(root,{recursive:true,force:true});}
});


test("opt-in source-limited capture retains one genuine listing-edge 1m, never claims a complete PIT day",async()=>{
 const seen=[];
 for(const [market,symbol] of [["CRYPTO_SPOT","KRW-BTC"],["CRYPTO_FUTURES","BTCUSDT"]]){
  const root=tmp(),at=START+720*MIN,requests=[];
  try{
   const row=market==="CRYPTO_SPOT"
    ?{upbitFetchImpl:async(url,opt)=>{
      requests.push({url});
      const endTime=Date.parse(new URL(url).searchParams.get("to"));
      return {ok:true,status:200,json:async()=>
        endTime>at?[nativeMinute(at)]:[]};
     }}
    :{bitgetClient:{get:async(path,params)=>{
      requests.push({path,params});
      return {code:"00000",data:Number(params.endTime)>at
        ?[[String(at),"100","104","99","102","2.5"]]:[]};
     }}};
   const strict=await collect(config(root,market,symbol,{
     allowPublicReadOnlyFetch:true,...row,
   }));
   assert.equal(strict.status,"BLOCKED_DATA");
   assert.equal(strict.reason,"NATIVE_1M_PROVIDER_DATA_UNAVAILABLE");
   assert.equal(requests.length,2);
   const retained=await collect({...config(root,market,symbol,{
     allowPublicReadOnlyFetch:true,...row,
   }),allowSourceLimitedArchive:true});
   assert.equal(retained.status,"RETROSPECTIVE_SOURCE_LIMITED_RETAINED_REVIEW_ONLY");
   assert.equal(retained.reason,"SOURCE_LIMITED_ORIGINAL_1M_REQUIRES_MANUAL_REVIEW");
   assert.equal(retained.providerRequestWindowVerified,false);
   assert.equal(retained.providerRawPageWindowTraversed,false);
   assert.equal(retained.sourceLimitedOnly,true);
   assert.equal(retained.sourceMinuteCount,1);
   assert.equal(retained.missingUnverifiedMinuteSlots,1439);
   assert.equal(retained.requestedProviderPages,2);
   assert.equal(retained.allowSourceLimitedArchiveUsed,true);
   assert.equal(retained.historicalFullMarketPITUniverseVerified,false);
   assert.equal(retained.nativeMinutesNoTradeGapVerified,false);
   assert.equal(retained.sourceHistoricalPublicationTimeProven,false);
   assert.equal(retained.profitabilityProven,false);
   assert.equal(retained.actualFillCount,null);
   assert.equal(retained.executionAuthority,"NONE");
   assert.equal(requests.length,4);
   const retainedRows=await derive({root,market,symbol,sessionStartMs:START,
     asOfMs:NOW,timeframes:["1m","5m"]});
   assert.equal(retainedRows.sourceMinuteRows,1);
   assert.equal(retainedRows.archiveRevisionCount,1);
   assert.equal(retainedRows.intervalData["1m"].sourceSessionCoverageComplete,false);
   assert.equal(retainedRows.intervalData["1m"].bars[0].startMs,at);
   assert.equal(retainedRows.profitabilityProven,false);
   const replay=await derive({root,market,symbol,sessionStartMs:START,
     asOfMs:START+DAY,timeframes:["1m"]});
   assert.equal(replay.intervalData["1m"].bars.length,0,
     "retrospective retrieval MUST NOT create historical scanner-time observations");
   seen.push({market,digest:retained.archiveSourceDigestSha256});
  }finally{rmSync(root,{recursive:true,force:true});}
 }
 assert.equal(seen.length,2);
});

test("limited native archive mode is explicitly opt-in and does not authorize public reads alone",async()=>{
 const root=tmp(),market="CRYPTO_SPOT",symbol="KRW-BTC",calls=[];
 try{
  const opts={...config(root,market,symbol,{
    upbitFetchImpl:async()=>{calls.push(1);throw Error("NO_PUBLIC_FETCH_PERMITTED");},
  }),allowSourceLimitedArchive:true};
  const preview=await collect(opts);
  assert.equal(preview.status,"BLOCKED_DATA");
  assert.equal(preview.reason,"EXPLICIT_PUBLIC_READ_ONLY_OPT_IN_REQUIRED");
  assert.equal(calls.length,0);
  const manifestData=manifest(market,symbol);
  const path=join(root,"limited-manifest.json"),out=join(root,"limited-preview.json");
  writeFileSync(path,JSON.stringify(manifestData),{mode:0o600});
  const args=["--market",market,"--symbol",symbol,"--day","2026-09-18",
   "--manifest",path,"--expected-roster-sha",manifestData.rawMembershipDigestSha256,
   "--root",root,"--output",out,"--retain-source-limited"];
  const parsed=parse(args);
  assert.equal(parsed.allowSourceLimitedArchive,true);
  assert.equal(parsed.allowPublicReadOnlyFetch,false);
  assert.throws(()=>parse([...args,"--retain-source-limited"]),
    /PIT_NATIVE_MINUTE_CLI_DUPLICATE_FLAG/);
  const r=await cli(parsed,{nowImpl,
   upbitFetchImpl:async()=>{calls.push(1);throw Error("NO_PUBLIC_FETCH_PERMITTED");}});
  assert.equal(r.status,"BLOCKED_DATA");
  assert.equal(r.reason,"EXPLICIT_PUBLIC_READ_ONLY_OPT_IN_REQUIRED");
  assert.equal(r.executionAuthority,"NONE");
  assert.equal(calls.length,0);
  assert.equal(statSync(out).mode&0o077,0);
 }finally{rmSync(root,{recursive:true,force:true});}
});


test("historically dated Han Bitget USDT perpetual is accepted in private native 1m without PIT/profit promotion",async()=>{
 const root=tmp(),symbol="龙虾USDT",calls=[];
 try{
  const m=manifest("CRYPTO_FUTURES",symbol);
  const first=await collect(config(root,"CRYPTO_FUTURES",symbol,{
   allowPublicReadOnlyFetch:true,manifest:m,
   bitgetClient:{get:async(path,params)=>{
    calls.push({path,params});
    assert.equal(params.symbol,symbol);
    return {code:"00000",data:Number(params.endTime)>START
      ?[[String(START+MIN),"100","104","99","102","2.5"],
        [String(START),"100","104","99","102","2.5"]]:[]};
   }},
  }));
  assert.equal(first.status,"RETROSPECTIVE_PRIVATE_SOURCE_RETAINED_ONLY");
  assert.equal(first.market,"CRYPTO_FUTURES");
  assert.equal(first.symbol,symbol);
  assert.equal(first.sourceMinuteCount,2);
  assert.equal(first.profitabilityProven,false);
  assert.equal(first.historicalFullMarketPITUniverseVerified,false);
  assert.equal(first.executionAuthority,"NONE");
  const stored=await derive({root,market:"CRYPTO_FUTURES",symbol,
   sessionStartMs:START,asOfMs:NOW,timeframes:["1m"]});
  assert.equal(stored.sourceMinuteRows,2);
  assert.equal(stored.sourceMinuteIntegrityVerified,true);
  assert.equal(stored.profitabilityProven,false);
  const historical=await derive({root,market:"CRYPTO_FUTURES",symbol,
   sessionStartMs:START,asOfMs:START+DAY,timeframes:["1m"]});
  assert.equal(historical.intervalData["1m"].bars.length,0);
  assert.equal(calls.length,1);
  await assert.rejects(()=>collect(config(root,"CRYPTO_FUTURES","龙虾/USDT",{
   allowPublicReadOnlyFetch:true,manifest:m,
   bitgetClient:{get:async()=>{throw Error("unsafe symbol reached provider");}},
  })),/PIT_NATIVE_MINUTE_BACKFILL_ARGUMENTS_INVALID/);
  assert.equal(calls.length,1);
 }finally{rmSync(root,{recursive:true,force:true});}
});
