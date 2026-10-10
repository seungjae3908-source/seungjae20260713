import test from "node:test";
import assert from "node:assert/strict";
import {
 diagnoseUpbitMinuteRangeV1 as audit,
 diagnosePublicUpbitMinuteGapsV1 as probe,
 recheckMissingUpbitMinuteSlotsV1 as recheck,
 auditPublicUpbitGapTicksV1 as tickAudit,
} from "../scripts/diagnose-upbit-two-alt-minute-gaps-v1.mjs";
import {WATCH_MATCHED_UTC_DAY_V1 as DAY}
  from "../scripts/probe-watch-matching-utc-day-v1.mjs";
const M=60_000;
function sample(symbol="KRW-ETH",{missing=[],mangle=null,untraversed=false}={}){
 const banned=new Set(missing);
 const candles=Array.from({length:1500},(_,i)=>({
   timestamp:DAY.historyStartMs+i*M,
   open:100,high:101,low:99,close:100,volume:3,
 })).filter((_,i)=>!banned.has(i));
 if(mangle!==null)candles[mangle].timestamp=candles[mangle-1].timestamp;
 return {
   market:"CRYPTO_SPOT",exchange:"UPBIT",providerMarket:symbol,
   timeframe:"1m",intervalMs:M,requestedStartTime:DAY.historyStartMs,
   requestedEndTime:DAY.utcDayEndMs,rawPageWindowTraversed:!untraversed,
   historicalSignalAvailabilityProven:false,actualFillProven:false,
   candles,pageCount:8,
 };
}
test("fully tiled, verified native-minute source permits sample-only completion",()=>{
 const r=audit({symbol:"KRW-ETH",source:sample()});
 assert.equal(r.status,"VERIFIED_CONTIGUOUS_SOURCE_MINUTES");
 assert.equal(r.requestedMinuteSlots,1500);
 assert.equal(r.observedMinuteRows,1500);
 assert.equal(r.missingMinuteCount,0);
 assert.equal(r.missingIntervals.length,0);
 assert.equal(r.priorUTCClosingMinuteReceived,true);
 assert.equal(r.missingMinuteCannotBeTreatedAsNoTrades,true);
 assert.equal(r.sourceMissingMinuteCauseVerified,false);
 assert.equal(r.actualFillCount,null);
 assert.equal(r.trueMarketWideRecall,null);
});
test("a single genuine missing minute is UNKNOWN_CAUSE, not no-trade proof",()=>{
 const r=audit({symbol:"KRW-SOL",source:sample("KRW-SOL",{missing:[423]})});
 assert.equal(r.status,"BLOCKED_UNVERIFIED_ONE_MINUTE_GAPS");
 assert.equal(r.missingMinuteCount,1);
 assert.equal(r.missingIntervals.length,1);
 assert.equal(r.missingIntervals[0].startMs,DAY.historyStartMs+423*M);
 assert.equal(r.missingIntervals[0].utcStart,
   new Date(DAY.historyStartMs+423*M).toISOString());
 assert.equal(r.sourceMissingMinuteCauseVerified,false);
 assert.equal(r.actualFillCount,null);
});
test("contiguous multi-minute missing interval does not fabricate separate trades",()=>{
 const r=audit({symbol:"KRW-ETH",source:sample("KRW-ETH",{missing:[500,501,502]})});
 assert.equal(r.missingMinuteCount,3);
 assert.equal(r.missingIntervalCount,1);
 assert.equal(r.missingIntervals[0].minutes,3);
 assert.equal(r.missingIntervals[0].endMs,DAY.historyStartMs+503*M);
});
test("missing previous UTC 23:59 close blocks causal prior-day baseline",()=>{
 const r=audit({symbol:"KRW-ETH",source:sample("KRW-ETH",{missing:[59]})});
 assert.equal(r.status,"BLOCKED_UNVERIFIED_ONE_MINUTE_GAPS");
 assert.equal(r.priorUTCClosingMinuteReceived,false);
 assert.equal(r.missingMinuteCount,1);
});
test("duplicate or shifted timestamp never gets counted as trading evidence",()=>{
 const r=audit({symbol:"KRW-SOL",source:sample("KRW-SOL",{mangle:405})});
 assert.equal(r.status,"BLOCKED_DATA");
 assert.equal(r.reason,"UPBIT_MINUTE_SOURCE_BAR_INVALID");
 assert.equal(r.missingMinuteCount,null);
});
test("incomplete page traversal or cross-venue symbol is BLOCKED_DATA",()=>{
 const x=audit({symbol:"KRW-ETH",source:sample("KRW-ETH",{untraversed:true})});
 assert.equal(x.reason,"UPBIT_MINUTE_SOURCE_PROVENANCE_INVALID");
 const y=audit({symbol:"KRW-ETH",source:sample("KRW-SOL")});
 assert.equal(y.reason,"UPBIT_MINUTE_SOURCE_PROVENANCE_INVALID");
});
test("public HTTP outage is NOT a market with zero observed opportunities",async()=>{
 const r=await probe({fetchImpl:async()=>({ok:false,status:451})});
 assert.equal(r.upstreamFailurePairs,2);
 assert.equal(r.consecutiveSourcePairs,0);
 assert.equal(r.markets["KRW-ETH"].missingMinuteCount,null);
 assert.equal(r.markets["KRW-SOL"].observedMinuteRows,null);
 assert.equal(r.trueMarketWideRecall,null);
 assert.equal(r.profitabilityProven,false);
 assert.equal(r.executionAuthority,"NONE");
});

function response(rows,status=200){
 return {ok:status>=200&&status<300,status,async json(){return rows;}};
}
function nativeRequeryRow(symbol,ms){
 return {market:symbol,candle_date_time_utc:new Date(ms).toISOString().slice(0,19),
  opening_price:100,high_price:101,low_price:99,trade_price:100,
  candle_acc_trade_volume:3};
}
test("narrow native re-query distinguishes source absence from pagination recovery",async()=>{
 const symbol="KRW-ETH",ms=DAY.historyStartMs+423*M;
 const diagnostic=audit({symbol,source:sample(symbol,{missing:[423]})});
 const calls=[];
 const present=await recheck({symbol,diagnostic,minIntervalMs:0,
   fetchImpl:async(url)=>{
     calls.push(new URL(url));
     return response([nativeRequeryRow(symbol,ms)]);
   }});
 assert.equal(present.status,"TARGETED_NATIVE_RECHECK_COMPLETE");
 assert.equal(present.presentOnRequery,1);
 assert.equal(present.absentOnRequery,0);
 assert.equal(present.observations[0].outcome,"NATIVE_CANDLE_PRESENT_ON_REQUERY");
 assert.match(present.observations[0].rawMatchedCandleSha256,/^[0-9a-f]{64}$/);
 assert.equal(calls[0].searchParams.get("to"),new Date(ms+M).toISOString());
 assert.equal(present.noTradeProof,false);
 assert.equal(present.sourceWindowComplete,false);
 assert.equal(present.trueMarketWideRecall,null);
 const absent=await recheck({symbol,diagnostic,minIntervalMs:0,
   fetchImpl:async()=>response([nativeRequeryRow(symbol,ms-M)])});
 assert.equal(absent.absentOnRequery,1);
 assert.equal(absent.presentOnRequery,0);
 assert.equal(absent.sourceMissingMinuteCauseVerified,false);
 assert.equal(absent.observations[0].outcome,"NATIVE_CANDLE_ABSENT_ON_REQUERY");
});
test("narrow re-query HTTP failures remain blocked, not no-trade proof",async()=>{
 const symbol="KRW-SOL";
 const diagnostic=audit({symbol,source:sample(symbol,{missing:[350]})});
 const r=await recheck({symbol,diagnostic,minIntervalMs:0,
   fetchImpl:async()=>response([],429)});
 assert.equal(r.status,"TARGETED_NATIVE_RECHECK_INCOMPLETE");
 assert.equal(r.failedRequeries,1);
 assert.equal(r.completeRecheck,false);
 assert.equal(r.noTradeProof,false);
 assert.equal(r.profitabilityProven,false);
 assert.match(r.observations[0].errorCode,/UPBIT_REQUERY_HTTP_429/);
});
test("bounded re-query never fans out across an unbounded missing window",async()=>{
 const symbol="KRW-ETH";
 const diagnostic=audit({symbol,source:sample(symbol,{
   missing:Array.from({length:25},(_,i)=>i+100),
 })});
 let calls=0;
 const r=await recheck({symbol,diagnostic,minIntervalMs:0,
   fetchImpl:async()=>{calls++;return response([])}});
 assert.equal(r.status,"BLOCKED_RECHECK_BUDGET_EXCEEDED");
 assert.equal(calls,0);
 assert.equal(r.noTradeProof,false);
});
test("invalid re-query response never becomes an accepted minute",async()=>{
 const symbol="KRW-SOL",ms=DAY.historyStartMs+105*M;
 const diagnostic=audit({symbol,source:sample(symbol,{missing:[105]})});
 const r=await recheck({symbol,diagnostic,minIntervalMs:0,
   fetchImpl:async()=>response([nativeRequeryRow("KRW-ETH",ms)])});
 assert.equal(r.failedRequeries,1);
 assert.equal(r.presentOnRequery,0);
 assert.equal(r.observations[0].outcome,"REQUERY_SOURCE_ERROR");
});

function tickFixture(symbol,ms){
 return {market:symbol,trade_date_utc:new Date(ms).toISOString().slice(0,10),
  timestamp:ms,trade_price:100,trade_volume:1};
}
function nativeAbsent(symbol,ms){
 const diagnostic=audit({symbol,source:sample(symbol,{
  missing:[(ms-DAY.historyStartMs)/M],
 })});
 return {diagnostic,targetedRecheck:{
   status:"TARGETED_NATIVE_RECHECK_COMPLETE",
   absentOnRequery:1,observations:[{
     timestampMs:ms,outcome:"NATIVE_CANDLE_ABSENT_ON_REQUERY",
   }],
 }};
}
test("public tick endpoint confirms a latest prior tick, not a synthetic minute candle",async()=>{
 const symbol="KRW-ETH",ms=DAY.utcDayStartMs+10*M;
 const {diagnostic,targetedRecheck}=nativeAbsent(symbol,ms);
 const calls=[];
 const r=await tickAudit({symbol,diagnostic,targetedRecheck,
  nowMs:Date.UTC(2026,9,10,9),minIntervalMs:0,
  fetchImpl:async(url)=>{calls.push(new URL(url));
   return response([tickFixture(symbol,ms-8000)]);
  }});
 assert.equal(calls[0].searchParams.get("days_ago"),"1");
 assert.equal(calls[0].searchParams.get("to"),"00:11:00");
 assert.equal(r.status,"TICK_CROSSCHECK_COMPLETE");
 assert.equal(r.latestTickPrecedesMissingMinute,1);
 assert.equal(r.tickInsideMissingCandleMinute,0);
 assert.equal(r.independentFullHistoryVerified,false);
 assert.equal(r.noSyntheticMinuteBars,true);
 assert.equal(r.marketWideRecall,null);
});
test("public tick found in missing minute flags native candle contradiction",async()=>{
 const symbol="KRW-SOL",ms=DAY.utcDayStartMs+31*M;
 const {diagnostic,targetedRecheck}=nativeAbsent(symbol,ms);
 const r=await tickAudit({symbol,diagnostic,targetedRecheck,
   nowMs:Date.UTC(2026,9,10,9),minIntervalMs:0,
   fetchImpl:async()=>response([tickFixture(symbol,ms+5000)])});
 assert.equal(r.status,"TICK_CROSSCHECK_COMPLETE");
 assert.equal(r.tickInsideMissingCandleMinute,1);
 assert.equal(r.latestTickPrecedesMissingMinute,0);
 assert.equal(r.profitabilityProven,false);
});
test("aged or denied tick history does not fabricate proof of no trades",async()=>{
 const symbol="KRW-ETH",ms=DAY.utcDayStartMs+30*M;
 const {diagnostic,targetedRecheck}=nativeAbsent(symbol,ms);
 let calls=0;
 const aged=await tickAudit({symbol,diagnostic,targetedRecheck,
  nowMs:Date.UTC(2026,9,18),minIntervalMs:0,
  fetchImpl:async()=>{calls++;return response([])}});
 assert.equal(calls,0);
 assert.equal(aged.unverifiedMinutes,1);
 const denied=await tickAudit({symbol,diagnostic,targetedRecheck,
  nowMs:Date.UTC(2026,9,10),minIntervalMs:0,
  fetchImpl:async()=>response([],429)});
 assert.equal(denied.unverifiedMinutes,1);
 assert.equal(denied.latestTickPrecedesMissingMinute,0);
 assert.match(denied.observations[0].errorCode,/UPBIT_TICKS_HTTP_429/);
});
