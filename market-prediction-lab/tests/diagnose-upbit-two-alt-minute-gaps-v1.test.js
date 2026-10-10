import test from "node:test";
import assert from "node:assert/strict";
import {
 diagnoseUpbitMinuteRangeV1 as audit,
 diagnosePublicUpbitMinuteGapsV1 as probe,
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
