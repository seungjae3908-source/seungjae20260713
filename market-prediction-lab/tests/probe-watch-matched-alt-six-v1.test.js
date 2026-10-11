import test from "node:test";
import assert from "node:assert/strict";
import {BitgetPublicApiError} from "../src/bitget-public-client.js";
import {
 WATCH_MATCH_ALT_PILOT_V1 as DAY,
 auditMatchedAltDayFromCollectedV1 as audit,
 probeMatchedAltSymbolsNativeDayV1 as probe,
} from "../scripts/probe-watch-matched-alt-six-v1.mjs";
import {diagnoseUpbitMinuteRangeV1} from "../scripts/diagnose-upbit-two-alt-minute-gaps-v1.mjs";
const M=60_000;
function fixture(market,symbol,{up=0,down=0,spikeAt=300,gap=null}={}){
 const rows=Array.from({length:1500},(_,i)=>{
   const high=i===60+spikeAt?100*(1+up/100):100;
   const low=i===60+spikeAt?100*(1-down/100):100;
   return {timestamp:DAY.historyStartMs+i*M,
     open:100,high,low,close:100,volume:2};
 });
 if(gap!==null)rows.splice(gap,1);
 const spot=market==="CRYPTO_SPOT";
 return {
   market,timeframe:"1m",
   requestedStartTime:DAY.historyStartMs,requestedEndTime:DAY.utcDayEndMs,
   rawPageWindowTraversed:true,
   historicalSignalAvailabilityProven:false,actualFillProven:false,
   candles:rows,
   ...(spot?{source:"upbit-public-candles",exchange:"UPBIT",
     providerMarket:symbol,symbol:symbol.slice(4),intervalMs:M
   }:{provider:"bitget-public-v2",symbol}),
 };
}
function run(market,symbol,opts={}){
 return audit({market,symbol,venue:market==="CRYPTO_SPOT"?"UPBIT_KRW":
   "BITGET_USDT_FUTURES",collected:fixture(market,symbol,opts)});
}
test("exact matching source day has 3 spot and 3 futures alts, BTC excluded",()=>{
 assert.equal(DAY.dayUtc,"2026-10-09");
 assert.deepEqual(DAY.CRYPTO_SPOT,["KRW-ETH","KRW-XRP","KRW-SOL"]);
 assert.deepEqual(DAY.CRYPTO_FUTURES,["ETHUSDT","XRPUSDT","SOLUSDT"]);
 assert.ok(![...DAY.CRYPTO_SPOT,...DAY.CRYPTO_FUTURES].some(s=>s.includes("BTC")));
});
test("Upbit selected KRW-XRP +5/10/20 first native high crossings",()=>{
 const r=run("CRYPTO_SPOT","KRW-XRP",{up:23});
 assert.equal(r.status,"OBSERVED_SELECTED_SYMBOL_DAY");
 assert.equal(r.priorHourObservedMinuteCount,60);
 assert.equal(r.observedMinuteCount,1440);
 assert.equal(r.previousUtcClose,100);
 assert.deepEqual(r.opportunities.map(e=>e.thresholdPct),[5,10,20]);
 assert.ok(r.opportunities.every(e=>e.direction==="LONG"));
 assert.equal(r.opportunities[0].firstCrossingBarStartMs,DAY.utcDayStartMs+300*M);
 assert.equal(r.realTickFirstCrossingTimeVerified,false);
 assert.equal(r.actualFillCount,null);
 assert.equal(r.trueMarketWideRecall,null);
});
test("Bitget selected ETHUSDT down -5/10/20 is SHORT-only bounded price evidence",()=>{
 const r=run("CRYPTO_FUTURES","ETHUSDT",{down:23});
 assert.equal(r.status,"OBSERVED_SELECTED_SYMBOL_DAY");
 assert.deepEqual(r.opportunities.map(e=>e.thresholdPct),[5,10,20]);
 assert.ok(r.opportunities.every(e=>e.direction==="SHORT"));
 assert.match(r.rawCandleSha256,/^[0-9a-f]{64}$/);
 assert.equal(r.profitabilityProven,false);
 assert.equal(r.executionAuthority,"NONE");
});
test("Upbit downward excursion remains SPOT LONG-only (no false short)",()=>{
 const r=run("CRYPTO_SPOT","KRW-SOL",{down:24});
 assert.equal(r.status,"OBSERVED_SELECTED_SYMBOL_DAY");
 assert.equal(r.observedDayCrossingCount,0);
 assert.equal(r.opportunities.length,0);
 assert.equal(r.trueMarketWideRecall,null);
});
test("Upbit missing minute is BLOCKED_DATA rather than no opportunities",()=>{
 const r=run("CRYPTO_SPOT","KRW-ETH",{gap:400,up:24});
 assert.equal(r.status,"BLOCKED_DATA");
 assert.equal(r.observedDayCrossingCount,null);
 assert.equal(r.reason,"ALT_NATIVE_MINUTE_ROW_COUNT_INCOMPLETE");
 assert.equal(r.observedNativeSourceRows,1499);
 assert.equal(r.requestedMinuteSlots,1500);
 assert.equal(r.minuteGapCauseIndependentlyVerified,false);
 assert.equal(r.absentMinuteIsNotZeroOpportunity,true);
 assert.equal(r.netProfitPct,null);
});
test("same market but another actual symbol cannot contaminate result",()=>{
 const expected="KRW-ETH",collected=fixture("CRYPTO_SPOT","KRW-SOL",{up:24});
 const r=audit({market:"CRYPTO_SPOT",symbol:expected,
   venue:"UPBIT_KRW",collected});
 assert.equal(r.status,"BLOCKED_DATA");
 assert.equal(r.reason,"ALT_NATIVE_SOURCE_OR_WINDOW_UNVERIFIED");
});
test("futures wrong source date, unsupported pair and invalid timestamp fail closed",()=>{
 const source=fixture("CRYPTO_FUTURES","SOLUSDT",{down:25});
 source.requestedStartTime+=M;
 let r=audit({market:"CRYPTO_FUTURES",symbol:"SOLUSDT",
   venue:"BITGET_USDT_FUTURES",collected:source});
 assert.equal(r.status,"BLOCKED_DATA");
 source.requestedStartTime-=M;
 source.candles[600].timestamp=source.candles[599].timestamp;
 r=audit({market:"CRYPTO_FUTURES",symbol:"SOLUSDT",
   venue:"BITGET_USDT_FUTURES",collected:source});
 assert.equal(r.reason,"SAMPLE_MINUTE_PRICE_OR_TIMESTAMP_INVALID");
 r=audit({market:"CRYPTO_FUTURES",symbol:"BTCUSDT",
   venue:"BITGET_USDT_FUTURES",collected:source});
 assert.equal(r.reason,"ALT_NATIVE_SOURCE_OR_WINDOW_UNVERIFIED");
});
test("6 public provider outages never turn missing source into zero profit/trades",async()=>{
 const r=await probe({
  upbitFetch:async()=>({ok:false,status:451}),
  bitgetClient:{get:async()=>{throw new BitgetPublicApiError("denied")}},
 });
 assert.equal(r.selectedAltSymbolDays,6);
 assert.equal(r.observedSelectedAltSymbolDays,0);
 assert.equal(r.blockedSelectedAltSymbolDays,6);
 assert.equal(r.status,"BLOCKED_DATA");
 assert.ok(r.markets.CRYPTO_SPOT.every(x=>x.status==="BLOCKED_DATA"));
 assert.ok(r.markets.CRYPTO_FUTURES.every(x=>x.status==="BLOCKED_DATA"));
 assert.equal(r.thresholdCrossingsInVerifiedSelectedDays,null);
 assert.equal(r.fivePctDirectionalEpisodesInVerifiedSelectedDays,null);
 assert.equal(r.verifiedEntireChosenSixCount,null);
 assert.equal(r.fullMarketPITUniverseAndDelistingsVerified,false);
 assert.equal(r.trueMarketWideRecall,null);
 assert.equal(r.realOrders,false);
 assert.equal(r.profitabilityProven,false);
 assert.equal(r.executionAuthority,"NONE");
});

function fixtureNativeSparseEvidence(symbol,collected,{alterTick=false,wrongHash=false}={}){
 const diagnostic=diagnoseUpbitMinuteRangeV1({symbol,source:collected});
 const missing=diagnostic.missingIntervals.flatMap(range=>
  Array.from({length:range.minutes},(_,i)=>range.startMs+i*M));
 const page=missing.map(ms=>({timestampMs:ms,
  outcome:"NATIVE_CANDLE_ABSENT_ON_REQUERY"}));
 const tick=missing.map(ms=>({
  timestampMs:ms,utcMinute:new Date(ms).toISOString(),
  latestTickAtMs:alterTick?ms+1000:ms-1000,
  outcome:"PUBLIC_LATEST_TICK_PRECEDES_MISSING_MINUTE",
  errorCode:null,
 }));
 return {diagnostic:wrongHash?{...diagnostic,rawCandleSha256:"0".repeat(64)}:diagnostic,
  targetedRecheck:{
   status:"TARGETED_NATIVE_RECHECK_COMPLETE",checkedGapMinutes:missing.length,
   presentOnRequery:0,absentOnRequery:missing.length,failedRequeries:0,
   observations:page,
  },
  publicTickCrosscheck:{
   status:"TICK_CROSSCHECK_COMPLETE",checkedMinutes:missing.length,
   latestTickPrecedesMissingMinute:missing.length,
   tickInsideMissingCandleMinute:0,unverifiedMinutes:0,
   independentFullHistoryVerified:false,observations:tick,
  },
 };
}
test("verified sparse Upbit minute cohort counts actual first crossing with no synthetic bars",()=>{
 const symbol="KRW-ETH",collected=fixture("CRYPTO_SPOT",symbol,
  {gap:450,up:23,spikeAt:300});
 const evidence=fixtureNativeSparseEvidence(symbol,collected);
 const r=audit({market:"CRYPTO_SPOT",symbol,venue:"UPBIT_KRW",
  collected,sparseGapEvidence:evidence});
 assert.equal(r.status,"OBSERVED_SPARSE_UPBIT_TICK_CORROBORATED_DAY");
 assert.equal(r.expectedMinuteCount,1440);
 assert.equal(r.observedMinuteCount,1439);
 assert.equal(r.corroboratedNativeNoTradeMinuteCount,1);
 assert.equal(r.nativeSourceRowCount,1499);
 assert.equal(r.sourceEvidenceTier,"NATIVE_SPARSE_SAME_PROVIDER_TICK_CORROBORATED_ONLY");
 assert.deepEqual(r.opportunities.map(x=>x.thresholdPct),[5,10,20]);
 assert.equal(r.opportunities[0].firstCrossingBarStartMs,DAY.utcDayStartMs+300*M);
 assert.equal(r.trueMarketWideRecall,null);
 assert.equal(r.actualFillCount,null);
 assert.equal(r.profitabilityProven,false);
});
test("sparse spot proof must match exact source digest and not contain a trade within a gap",()=>{
 const symbol="KRW-SOL",collected=fixture("CRYPTO_SPOT",symbol,{gap:500});
 const base={market:"CRYPTO_SPOT",symbol,venue:"UPBIT_KRW",collected};
 const valid=fixtureNativeSparseEvidence(symbol,collected);
 assert.equal(audit({...base}).reason,"ALT_NATIVE_MINUTE_ROW_COUNT_INCOMPLETE");
 assert.equal(audit({...base,sparseGapEvidence:fixtureNativeSparseEvidence(symbol,collected,{
  wrongHash:true})}).status,"BLOCKED_DATA");
 assert.equal(audit({...base,sparseGapEvidence:fixtureNativeSparseEvidence(symbol,collected,{
  alterTick:true})}).status,"BLOCKED_DATA");
 const swapped={...valid,publicTickCrosscheck:{
  ...valid.publicTickCrosscheck,
  observations:valid.publicTickCrosscheck.observations.map(o=>({...o,
   timestampMs:o.timestampMs+M,utcMinute:new Date(o.timestampMs+M).toISOString()}))}};
 assert.equal(audit({...base,sparseGapEvidence:swapped}).status,"BLOCKED_DATA");
});
test("missing prior day close cannot be rescued by observed gaps in the current day",()=>{
 const symbol="KRW-ETH",collected=fixture("CRYPTO_SPOT",symbol,{gap:59});
 const evidence=fixtureNativeSparseEvidence(symbol,collected);
 const r=audit({market:"CRYPTO_SPOT",symbol,venue:"UPBIT_KRW",
  collected,sparseGapEvidence:evidence});
 assert.equal(r.status,"BLOCKED_DATA");
 assert.equal(r.trueMarketWideRecall,null);
});
