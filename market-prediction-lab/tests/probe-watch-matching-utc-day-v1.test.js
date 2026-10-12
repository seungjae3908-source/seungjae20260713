import test from "node:test";
import assert from "node:assert/strict";
import {BitgetPublicApiError} from "../src/bitget-public-client.js";
import {
 WATCH_MATCHED_UTC_DAY_V1 as DAY,
 nativeMatchedWatchDayFromCollectedV1 as validate,
 probeNativeMatchingWatchDayV1 as probe,
} from "../scripts/probe-watch-matching-utc-day-v1.mjs";
import {reconcileOriginalPublicWatchV1 as reconcile}
 from "../src/public-watch-native-minute-reconcile-v1.js";
const M=60_000;
function fixtures(market,{upPct=0,downPct=0,gap=null,spikeMinute=500}={}){
 const spot=market==="CRYPTO_SPOT";
 const candles=Array.from({length:1500},(_,i)=>{
   const high=i===60+spikeMinute?100*(1+upPct/100):100;
   const low=i===60+spikeMinute?100*(1-downPct/100):100;
   return {timestamp:DAY.historyStartMs+i*M,open:100,close:100,
     high,low,volume:1};
 });
 if(gap!==null)candles.splice(gap,1);
 return {
   market,timeframe:"1m",requestedStartTime:DAY.historyStartMs,
   requestedEndTime:DAY.utcDayEndMs,
   rawPageWindowTraversed:true,
   historicalSignalAvailabilityProven:false,actualFillProven:false,
   candles,
   ...(spot?{
     source:"upbit-public-candles",exchange:"UPBIT",providerMarket:"KRW-BTC",
     intervalMs:M,symbol:"BTC",
   }:{
     provider:"bitget-public-v2",symbol:"BTCUSDT",
   }),
 };
}
const safe=(market,x)=>validate({
 market,venue:market==="CRYPTO_SPOT"?"UPBIT_KRW":"BITGET_USDT_FUTURES",
 collected:x,
});
test("fixed public source day is complete 2026-10-09 UTC, not 2025 hindsight",()=>{
 assert.equal(DAY.dayUtc,"2026-10-09");
 assert.equal(DAY.utcDayEndMs-DAY.utcDayStartMs,86_400_000);
 assert.equal(DAY.utcDayStartMs-DAY.historyStartMs,60*M);
});
test("source spot native prior UTC close yields only LONG +5 and +10 bounded bars",()=>{
 const r=safe("CRYPTO_SPOT",fixtures("CRYPTO_SPOT",{upPct:12}));
 assert.equal(r.status,"OBSERVED_DAY_ONLY");
 assert.equal(r.previousUtcClose,100);
 assert.equal(r.observedMinuteCount,1440);
 assert.equal(r.priorHourObservedMinuteCount,60);
 assert.deepEqual(r.opportunities.map(e=>e.thresholdPct),[5,10]);
 assert.ok(r.opportunities.every(e=>e.direction==="LONG"));
 assert.equal(r.opportunities[0].firstCrossingBarStartMs,DAY.utcDayStartMs+500*M);
 assert.equal(r.opportunities[0].exactTradeTimestampMs,null);
 assert.match(r.rawCandleSha256,/^[a-f0-9]{64}$/);
 assert.equal(r.trueMarketWideRecall,null);
 assert.equal(r.actualFillCount,null);
 assert.equal(r.executionAuthority,"NONE");
});
test("Bitget futures SHORT -5/-10/-20 first crossing never implies executable fill",()=>{
 const r=safe("CRYPTO_FUTURES",fixtures("CRYPTO_FUTURES",{downPct:22}));
 assert.equal(r.status,"OBSERVED_DAY_ONLY");
 assert.deepEqual(r.opportunities.map(e=>e.direction),["SHORT","SHORT","SHORT"]);
 assert.deepEqual(r.opportunities.map(e=>e.thresholdPct),[5,10,20]);
 assert.equal(r.historicalScannerAsOfAvailabilityVerified,false);
 assert.equal(r.actualFillCount,null);
 assert.equal(r.profitabilityProven,false);
});
test("source one-minute gap blocks a candidate from being presumed absent",()=>{
 const r=safe("CRYPTO_SPOT",fixtures("CRYPTO_SPOT",{gap:555,upPct:12}));
 assert.equal(r.status,"BLOCKED_DATA");
 assert.equal(r.observedDayCrossingCount,null);
 assert.equal(r.trueMarketWideRecall,null);
});
test("duplicate one minute timestamp fails closed even with count unchanged",()=>{
 const x=fixtures("CRYPTO_FUTURES");
 x.candles[420].timestamp=x.candles[419].timestamp;
 const r=safe("CRYPTO_FUTURES",x);
 assert.equal(r.status,"BLOCKED_DATA");
 assert.equal(r.reason,"SAMPLE_MINUTE_PRICE_OR_TIMESTAMP_INVALID");
});
test("venue mismatch, foreign market and fake historical signal credit blocked",()=>{
 const x=fixtures("CRYPTO_SPOT");
 let r=validate({market:"CRYPTO_SPOT",venue:"BITGET_USDT_FUTURES",collected:x});
 assert.equal(r.status,"BLOCKED_DATA");
 x.historicalSignalAvailabilityProven=true;
 r=safe("CRYPTO_SPOT",x);
 assert.equal(r.status,"BLOCKED_DATA");
 r=validate({market:"KR_STOCK",venue:"KRX",collected:x});
 assert.equal(r.status,"BLOCKED_DATA");
});
test("a 2025 original public-watch probe cannot match this newer native day",()=>{
 const up=safe("CRYPTO_SPOT",fixtures("CRYPTO_SPOT"));
 const fut=safe("CRYPTO_FUTURES",fixtures("CRYPTO_FUTURES",{downPct:7}));
 const sample={
   schemaVersion:"native-utc-day-historical-public-1m-audit-v1",
   sampledDay:DAY,executionAuthority:"NONE",
   profitabilityProven:false,fullMarketOpportunityDenominatorVerified:false,
   markets:{
     KR_STOCK:{status:"BLOCKED_DATA"},
     US_STOCK:{status:"BLOCKED_DATA"},
     CRYPTO_SPOT:up,CRYPTO_FUTURES:fut,
   },
 };
 const report=reconcile({nativeUtcDayReport:sample});
 assert.equal(report.markets.CRYPTO_FUTURES.observedNativeCrossingCount,1);
 assert.equal(report.markets.CRYPTO_FUTURES.corroboratedPositiveWatchEvents,null);
 assert.equal(report.markets.CRYPTO_FUTURES.verifiedFalseNegativeCount,null);
 assert.equal(report.historicalMarketWideRecall,null);
});
test("both public source outages are BLOCKED_DATA rather than zero PnL",async()=>{
 const r=await probe({
   upbitFetch:async()=>({ok:false,status:451}),
   bitgetClient:{get:async()=>{throw new BitgetPublicApiError("source unavailable")}},
 });
 assert.equal(r.observedMarketSamples,0);
 assert.equal(r.markets.CRYPTO_SPOT.status,"BLOCKED_DATA");
 assert.equal(r.markets.CRYPTO_FUTURES.status,"BLOCKED_DATA");
 assert.equal(r.markets.CRYPTO_SPOT.observedDayCrossingCount,null);
 assert.equal(r.markets.CRYPTO_FUTURES.observedDayCrossingCount,null);
 assert.equal(r.profitabilityProven,false);
 assert.equal(r.realOrders,false);
});
