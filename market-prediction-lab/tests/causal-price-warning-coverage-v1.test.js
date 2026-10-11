import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {evaluateCausalPriceWarningCoverageV1 as evaluate}
  from "../src/causal-price-warning-coverage-v1.js";
import {summarizeSelectedNativeUtcDayV1,SELECTED_NATIVE_DAY_PILOT_V1}
  from "../scripts/probe-native-selected-day-v1.mjs";
const M=60_000,start=SELECTED_NATIVE_DAY_PILOT_V1.historyStartMs,
 end=SELECTED_NATIVE_DAY_PILOT_V1.endMs;
function candleRows({signalAt=20,hitAt=40,direction="SHORT",
  signalPct=2,hitPct=5.5}={}){
 const factor=direction==="SHORT"?-1:1;
 return Array.from({length:(end-start)/M},(_,i)=>{
   let o=100,h=100,l=100,c=100;
   if(i>=60+signalAt)c=100*(1+factor*signalPct/100);
   if(i===60+hitAt){
     h=direction==="LONG"?Math.max(100,c,100*(1+hitPct/100)):Math.max(100,c);
     l=direction==="SHORT"?Math.min(100,c,100*(1-hitPct/100)):Math.min(100,c);
   } else {h=Math.max(100,c);l=Math.min(100,c);}
   return {timestamp:start+i*M,open:o,high:h,low:l,close:c,volume:10};
 });
}
function rawSha(candles){
 const hash=createHash("sha256");
 for(const c of candles)hash.update([
   c.timestamp,c.open,c.high,c.low,c.close,c.volume
 ].join(",")+"\n");
 return hash.digest("hex");
}
function fixture({direction="SHORT",signalAt=20,hitAt=40,signalPct=2,hitPct=5.5}={}){
 const candles=candleRows({direction,signalAt,hitAt,signalPct,hitPct});
 const symbol=direction==="SHORT"?"BTCUSDT":"KRW-XRP";
 const market=direction==="SHORT"?"CRYPTO_FUTURES":"CRYPTO_SPOT";
 const collected={
   market,timeframe:"1m",requestedStartTime:start,requestedEndTime:end,
   rawPageWindowTraversed:true,historicalSignalAvailabilityProven:false,
   actualFillProven:false,candles,
   ...(market==="CRYPTO_SPOT"?{
     source:"upbit-public-candles",exchange:"UPBIT",providerMarket:symbol,
     intervalMs:M,symbol:symbol.slice(4),
   }:{provider:"bitget-public-v2",symbol}),
 };
 const report=summarizeSelectedNativeUtcDayV1({market,symbol,collected});
 if(report.status!=="OBSERVED_SELECTED_SYMBOL_DAY")throw Error(report.reason);
 const markets={
   KR_STOCK:{status:"BLOCKED_DATA"},
   US_STOCK:{status:"BLOCKED_DATA"},
   CRYPTO_SPOT:market==="CRYPTO_SPOT"?[report]:[],
   CRYPTO_FUTURES:market==="CRYPTO_FUTURES"?[report]:[],
 };
 return {
   selectedSummary:{
     schemaVersion:"native-selected-historical-utc-day-1m-pilot-v1",
     executionAuthority:"NONE",profitabilityProven:false,
     historicalPointInTimeUniverseVerified:false,trueMarketWideRecall:null,
     markets,
   },
   selectedRaw:{
     schemaVersion:"native-selected-public-historical-raw-1m-v1",
     raw:{[symbol]:{
       venue:report.venue,sourceSha256:rawSha(candles),candles,
     }},
   },
 };
}
test("2pct price-only early signal is scored only before historical 5pct first bar",()=>{
 const x=fixture();
 const r=evaluate({...x,thresholds:[2]});
 assert.equal(r.selectedSymbolDays,1);
 assert.equal(r.results["2"].observedEventCount,1);
 assert.equal(r.results["2"].candidateCount,1);
 assert.equal(r.results["2"].observedEarlyMatchedEvents,1);
 assert.equal(r.results["2"].falsePositiveCandidates,0);
 assert.equal(r.results["2"].withinSelectedCohortRecall,1);
 assert.equal(r.results["2"].withinSelectedCohortPrecision,1);
 assert.ok(Math.abs(r.results["2"].meanObservedLeadMinutes-(19-2/60))<1e-9);
 assert.equal(r.realHistoricalScannerRecall,null);
 assert.equal(r.actualFills,null);
 assert.equal(r.profitabilityProven,false);
});
test("same minute high hit precedes close alert so no early credit",()=>{
 const x=fixture({signalAt:20,hitAt:20});
 const r=evaluate({...x,thresholds:[2]});
 assert.equal(r.results["2"].observedEarlyMatchedEvents,0);
 assert.equal(r.results["2"].falsePositiveCandidates,1);
 assert.equal(r.results["2"].missedObservedEvents,1);
});
test("LONG is evaluated for spot but never fictitious spot SHORT",()=>{
 const x=fixture({direction:"LONG"});
 const r=evaluate({...x,thresholds:[2]});
 assert.equal(r.markets.CRYPTO_SPOT[0].priceSignals.length,1);
 assert.equal(r.markets.CRYPTO_SPOT[0].priceSignals[0].direction,"LONG");
 assert.equal(r.results["2"].observedEarlyMatchedEvents,1);
});
test("raw SHA integrity mismatch blocks only affected selected symbol",()=>{
 const x=fixture();
 x.selectedRaw.raw.BTCUSDT.candles[10].close=101;
 const r=evaluate({...x,thresholds:[2]});
 assert.equal(r.markets.CRYPTO_FUTURES[0].status,"BLOCKED_DATA");
 assert.equal(r.results["2"].observedEventCount,0);
 assert.equal(r.results["2"].candidateCount,0);
 assert.equal(r.results["2"].withinSelectedCohortRecall,null);
});
test("no historical target may be mislabeled as economic winner",()=>{
 const x=fixture({hitPct:0});
 const r=evaluate({...x,thresholds:[2]});
 assert.equal(r.results["2"].observedEventCount,0);
 assert.equal(r.results["2"].candidateCount,1);
 assert.equal(r.results["2"].falsePositiveCandidates,1);
 assert.equal(r.results["2"].withinSelectedCohortRecall,null);
 assert.equal(r.netProfitPct,null);
});
test("the price sweep cannot turn into real scanner, OOS, or order authority",()=>{
 const x=fixture();
 const r=evaluate({...x});
 assert.deepEqual(r.thresholdsPct,[1,2,3,4]);
 assert.equal(r.originalHistoricalScannerDetectionProven,undefined);
 assert.equal(r.realHistoricalScannerPrecision,null);
 assert.equal(r.OOSPassCount,0);
 assert.equal(r.executionAuthority,"NONE");
 assert.equal(r.liveTrading,false);
 assert.equal(r.decisionUsedFutureBarHighLow,false);
 assert.equal(r.futureHighLowUsedOnlyForScoring,true);
});


test("two distinct symbols crossing same minute are not merged into one opportunity",()=>{
  const x=fixture({direction:"LONG",hitAt:40});
  const source=x.selectedRaw.raw["KRW-XRP"];
  const collected={
    market:"CRYPTO_SPOT",timeframe:"1m",
    requestedStartTime:start,requestedEndTime:end,
    rawPageWindowTraversed:true,
    historicalSignalAvailabilityProven:false,actualFillProven:false,
    source:"upbit-public-candles",exchange:"UPBIT",
    providerMarket:"KRW-SOL",intervalMs:M,symbol:"SOL",
    candles:source.candles,
  };
  const second=summarizeSelectedNativeUtcDayV1({
    market:"CRYPTO_SPOT",symbol:"KRW-SOL",collected,
  });
  assert.equal(second.status,"OBSERVED_SELECTED_SYMBOL_DAY");
  x.selectedSummary.markets.CRYPTO_SPOT.push(second);
  x.selectedRaw.raw["KRW-SOL"]={...source};
  const r=evaluate({...x,thresholds:[2]});
  assert.equal(r.results["2"].observedEventCount,2);
  assert.equal(r.results["2"].observedEarlyMatchedEvents,2);
  assert.equal(r.results["2"].missedObservedEvents,0);
  assert.equal(r.results["2"].withinSelectedCohortRecall,1);
});
