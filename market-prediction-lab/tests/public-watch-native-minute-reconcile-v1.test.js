import test from "node:test";
import assert from "node:assert/strict";
import {
  publicWatchEventIdV1,publicWatchCadenceIdV1,
  reconcileOriginalPublicWatchV1 as reconcile,
} from "../src/public-watch-native-minute-reconcile-v1.js";
const DAY=Date.parse("2025-02-03T00:00:00Z");
const CROSS=Date.parse("2025-02-03T01:49:00Z");
const SHA="a".repeat(40);
const ISSUES="native-utc-day-historical-public-1m-audit-v1";
function priceReport() {
 const market="CRYPTO_FUTURES",venue="BITGET_USDT_FUTURES",symbol="BTCUSDT";
 return {
  schemaVersion:ISSUES,executionAuthority:"NONE",profitabilityProven:false,
  fullMarketOpportunityDenominatorVerified:false,
  sampledDay:{utcDayStartMs:DAY,utcDayEndMs:DAY+86_400_000},
  markets:{
   KR_STOCK:{status:"BLOCKED_DATA",market:"KR_STOCK"},
   US_STOCK:{status:"BLOCKED_DATA",market:"US_STOCK"},
   CRYPTO_SPOT:{
     status:"OBSERVED_DAY_ONLY",market:"CRYPTO_SPOT",venue:"UPBIT_KRW",
     symbol:"KRW-BTC",utcDayStartMs:DAY,utcDayEndMs:DAY+86_400_000,
     observedMinuteCount:1440,priorHourObservedMinuteCount:60,
     rawCandleSha256:"c".repeat(64),observedDayCrossingCount:0,
     opportunities:[],historicalScannerAsOfAvailabilityVerified:false,
     actualFillCount:null,trueMarketWideRecall:null,
   },
   CRYPTO_FUTURES:{
     status:"OBSERVED_DAY_ONLY",market,venue,symbol,
     utcDayStartMs:DAY,utcDayEndMs:DAY+86_400_000,
     observedMinuteCount:1440,priorHourObservedMinuteCount:60,
     rawCandleSha256:"d".repeat(64),observedDayCrossingCount:1,
     historicalScannerAsOfAvailabilityVerified:false,
     actualFillCount:null,trueMarketWideRecall:null,
     opportunities:[{
       eventId:"PRICE-NATIVE-BTC-5-DOWN",market,venue,symbol,
       direction:"SHORT",thresholdPct:5,
       firstCrossingBarStartMs:CROSS,
       firstCrossingBarEndMs:CROSS+60_000,
     }],
   },
  },
 };
}
function at(mm="2025-02-03T01:40:00.000Z") { return Date.parse(mm); }
function marketStatuses(){
 return [
  {market:"KR_STOCK",status:"BLOCKED_PUBLIC_STOCK_FEED_MISSING",observedCount:0},
  {market:"US_STOCK",status:"BLOCKED_PUBLIC_STOCK_FEED_MISSING",observedCount:0},
  {market:"CRYPTO_SPOT",status:"READY",observedCount:5},
  {market:"CRYPTO_FUTURES",status:"READY",observedCount:5},
 ];
}
function watchEvent({when="2025-02-03T01:40:00.000Z",
   market="CRYPTO_FUTURES",symbol="BTCUSDT",
   direction="DOWN",source="BITGET_PUBLIC_TICKERS"}={}){
 const now=at(when);
 const x={
   schemaVersion:"lightweight-market-opportunity-watch-v1",
   kind:"PROVISIONAL_PRICE_ACCELERATION",
   researchSha:SHA,
   market,symbol,direction,source,observedAt:when,
   sourceAtMs:now-1000,priorSourceAtMs:now-121000,
   movePercent:-2.45,
   executionAuthority:"NONE",isTradingSignal:false,
   aiReviewed:false,oosPassed:false,paperAdmitted:false,
 };
 x.eventId=publicWatchEventIdV1(x);
 return x;
}
function cadence({when="2025-02-03T01:40:00.000Z",
 markets=marketStatuses(),researchSha=SHA}={}){
 const x={
   schemaVersion:"public-watch-cadence-observation-v1",
   researchSha,observedAt:when,
   cycleStatus:"PARTIAL_MARKET_COVERAGE",
   resourceBudget:"RUN",markets,
   publicPriceObservationOnly:true,economicEvidenceCredit:0,
   paperCredit:0,oosCredit:0,executionAuthority:"NONE",
 };
 x.eventId=publicWatchCadenceIdV1(x);
 return x;
}
test("genuine native price event without original watcher logs is UNKNOWN not missed",()=>{
 const r=reconcile({nativeUtcDayReport:priceReport()});
 assert.equal(r.markets.CRYPTO_FUTURES.status,"BLOCKED_DATA");
 assert.equal(r.markets.CRYPTO_FUTURES.observedNativeCrossingCount,1);
 assert.equal(r.markets.CRYPTO_FUTURES.corroboratedPositiveWatchEvents,null);
 assert.equal(r.markets.CRYPTO_FUTURES.verifiedFalseNegativeCount,null);
 assert.equal(r.historicalMarketWideRecall,null);
 assert.equal(r.profitabilityProven,false);
 assert.equal(r.executionAuthority,"NONE");
});
test("source event hash agrees with original public watcher JSON identity contract",()=>{
 const x=watchEvent();
 assert.match(x.eventId,/^[0-9a-f]{64}$/);
 assert.equal(publicWatchEventIdV1(x),x.eventId);
 const c=cadence();
 assert.equal(publicWatchCadenceIdV1(c),c.eventId);
});
test("corroborated same-cycle public watch event is source-leading only, not a fill",()=>{
 const evt=watchEvent(),tick=cadence();
 const r=reconcile({nativeUtcDayReport:priceReport(),
   watchEvents:[evt],cadenceRows:[tick]});
 const f=r.markets.CRYPTO_FUTURES;
 assert.equal(f.status,"SOURCE_TIMED_PUBLIC_WATCH_POSITIVES_ONLY");
 assert.equal(f.corroboratedPositiveWatchEvents,1);
 assert.equal(f.sourceTimedEarlyWatchCandidates.length,1);
 assert.equal(f.sourceTimedLeadMinutes[0],9);
 assert.equal(f.sourceTimedEarlyWatchCandidates[0].historicalScannerPersistedAtProven,false);
 assert.equal(f.marketWideEarlyRecall,null);
 assert.equal(f.negativeWatchlistCoverageVerified,false);
 assert.equal(r.actualFillCount,null);
 assert.equal(r.OOSPassCount,0);
});
test("not-yet-available cadence blocks positive credit",()=>{
 const evt=watchEvent(),tick=cadence({when:"2025-02-03T01:42:00.000Z"});
 const r=reconcile({nativeUtcDayReport:priceReport(),
   watchEvents:[evt],cadenceRows:[tick]});
 assert.equal(r.markets.CRYPTO_FUTURES.reason,
   "WATCH_POSITIVE_EVENT_MISSING_SAME_CYCLE_CADENCE");
 assert.equal(r.markets.CRYPTO_FUTURES.sourceTimedEarlyWatchCandidates,null);
});
test("2026 prospective logs cannot be matched to 2025 historical candle window",()=>{
 const evt=watchEvent({when:"2026-10-10T07:00:00.000Z"});
 const tick=cadence({when:"2026-10-10T07:00:00.000Z"});
 const r=reconcile({nativeUtcDayReport:priceReport(),
   watchEvents:[evt],cadenceRows:[tick]});
 assert.equal(r.markets.CRYPTO_FUTURES.reason,"WATCH_LOG_SOURCE_DAY_OR_IDENTITY_MISMATCH");
 assert.equal(r.markets.CRYPTO_FUTURES.corroboratedPositiveWatchEvents,null);
 assert.equal(r.historicalMarketWideRecall,null);
});
test("same first minute as +5pct high is not an earlier watcher discovery",()=>{
 const when="2025-02-03T01:49:00.000Z";
 const r=reconcile({nativeUtcDayReport:priceReport(),
   watchEvents:[watchEvent({when})],cadenceRows:[cadence({when})]});
 assert.equal(r.markets.CRYPTO_FUTURES.corroboratedPositiveWatchEvents,0);
 assert.equal(r.markets.CRYPTO_FUTURES.verifiedFalseNegativeCount,null);
});
test("duplicate identical event is idempotent; changed contents same ID fail closed",()=>{
 const a=watchEvent(),c=cadence();
 const ok=reconcile({nativeUtcDayReport:priceReport(),
   watchEvents:[a,{...a}],cadenceRows:[c]});
 assert.equal(ok.markets.CRYPTO_FUTURES.originalPublicWatchEventCount,1);
 const changed={...a,movePercent:a.movePercent-1};
 const bad=reconcile({nativeUtcDayReport:priceReport(),
   watchEvents:[a,changed],cadenceRows:[c]});
 assert.equal(bad.markets.CRYPTO_FUTURES.reason,"WATCH_EVENT_ID_REPLAY_CONFLICT");
});
test("tampered event hash or fake trading signal is rejected",()=>{
 const e=watchEvent(),c=cadence();
 e.eventId="0".repeat(64);
 let r=reconcile({nativeUtcDayReport:priceReport(),
   watchEvents:[e],cadenceRows:[c]});
 assert.equal(r.markets.CRYPTO_FUTURES.reason,"WATCH_LOG_SOURCE_DAY_OR_IDENTITY_MISMATCH");
 const e2=watchEvent();e2.isTradingSignal=true;
 r=reconcile({nativeUtcDayReport:priceReport(),
   watchEvents:[e2],cadenceRows:[c]});
 assert.equal(r.markets.CRYPTO_FUTURES.reason,"WATCH_LOG_SOURCE_DAY_OR_IDENTITY_MISMATCH");
});
test("cadence from other research release cannot prove current event",()=>{
 const e=watchEvent(),c=cadence({researchSha:"f".repeat(40)});
 const r=reconcile({nativeUtcDayReport:priceReport(),
   watchEvents:[e],cadenceRows:[c]});
 assert.equal(r.markets.CRYPTO_FUTURES.reason,"CROSS_RELEASE_LOG_COHORT_NOT_COMPARABLE");
});
test("cadence source state must be usable for matching exact market",()=>{
 const e=watchEvent(),statuses=marketStatuses();
 statuses[3]={market:"CRYPTO_FUTURES",status:"BLOCKED_DATA",observedCount:0};
 const r=reconcile({nativeUtcDayReport:priceReport(),
   watchEvents:[e],cadenceRows:[cadence({markets:statuses})]});
 assert.equal(r.markets.CRYPTO_FUTURES.reason,
   "WATCH_POSITIVE_EVENT_MISSING_SAME_CYCLE_CADENCE");
});
test("stock markets remain blocked without authentic PIT 1m source",()=>{
 const r=reconcile({nativeUtcDayReport:priceReport()});
 assert.equal(r.markets.KR_STOCK.reason,"NATIVE_PRICE_DAY_UNAVAILABLE");
 assert.equal(r.markets.US_STOCK.reason,"NATIVE_PRICE_DAY_UNAVAILABLE");
 assert.equal(r.markets.KR_STOCK.marketWideEarlyRecall,null);
});
test("missing original cadence cannot make event-only list a historical recall",()=>{
 const r=reconcile({nativeUtcDayReport:priceReport(),
   watchEvents:[watchEvent()]});
 assert.equal(r.markets.CRYPTO_FUTURES.reason,
   "HISTORICAL_WATCH_EVENT_AND_CADENCE_LOGS_NOT_ATTACHED");
 assert.equal(r.markets.CRYPTO_FUTURES.verifiedFalseNegativeCount,null);
});
test("native source cannot be changed into trade-filled or profitability evidence",()=>{
 const x=priceReport();x.profitabilityProven=true;
 assert.throws(()=>reconcile({nativeUtcDayReport:x}),/WATCH_RESEARCH_INPUT_INVALID/);
});
