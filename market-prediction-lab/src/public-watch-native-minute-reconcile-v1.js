import {createHash} from "node:crypto";

/**
 * Source-limited comparison of genuine public-watch event/cadence JSONL
 * with an independently observed SAME-DATE native minute price crossing.
 *
 * The contemporary 2-minute coarse public-watch DOES NOT provide 1-minute
 * negative scanner heartbeats, a full PIT universe, broker quote/fill data,
 * or operational as-of evidence for a 2025 event. NEVER count absent
 * event logs as missed opportunities or a calculated 0% market recall.
 *
 * This adapter is intentionally independent of the newer main-only watcher:
 * the stacked Draft research branch cannot import its production worker.
 * The hash contracts are reproduced exactly from the read-only main code.
 */
const MARKETS=Object.freeze({
 KR_STOCK:null, US_STOCK:null,
 CRYPTO_SPOT:{venue:"UPBIT_KRW",source:"UPBIT_PUBLIC_TICKERS"},
 CRYPTO_FUTURES:{venue:"BITGET_USDT_FUTURES",source:"BITGET_PUBLIC_TICKERS"},
});
const MARKET_ORDER=Object.freeze(["KR_STOCK","US_STOCK","CRYPTO_SPOT","CRYPTO_FUTURES"]);
const WATCH="lightweight-market-opportunity-watch-v1";
const CADENCE="public-watch-cadence-observation-v1";
const HASH=/^[0-9a-f]{64}$/u,RELEASE=/^[0-9a-f]{40}$/u;
const SAFE_SYMBOL=/^[A-Z0-9][A-Z0-9._-]{0,31}$/u;
const SAFE_SOURCE=/^[A-Za-z0-9._-]{3,80}$/u;
const UP_DOWN=new Set(["UP","DOWN"]);
const HEALTHY=new Set(["READY","PARTIAL_TICKERS","PARTIAL_UNIVERSE"]);
const WATCH_CYCLE=new Set(["OBSERVING_ALL_FOUR","PARTIAL_MARKET_COVERAGE","BLOCKED_DATA","THROTTLED","HOLD"]);
const BUDGET=new Set(["RUN","THROTTLED","HOLD"]);
const minute=60_000,dayMs=86_400_000;
const record=x=>x!==null&&typeof x==="object"&&!Array.isArray(x);
const int=x=>Number.isSafeInteger(x)&&x>0;
const sha=s=>createHash("sha256").update(s).digest("hex");
function ms(s){
 if(typeof s!=="string"||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s))
   return null;
 const at=Date.parse(s);
 return int(at)&&new Date(at).toISOString()===s?at:null;
}
export function publicWatchEventIdV1(e){
 return sha(JSON.stringify({
   researchSha:e.researchSha,market:e.market,symbol:e.symbol,
   direction:e.direction,source:e.source,
   sourceAtMs:e.sourceAtMs,priorSourceAtMs:e.priorSourceAtMs,
 }));
}
export function publicWatchCadenceIdV1(e){
 return sha(CADENCE+":"+JSON.stringify([
   e.researchSha,e.observedAt,e.cycleStatus,
   e.resourceBudget,e.markets,
 ]));
}
function fail(market,reason,knownEventCount=null,additional={}){
 return Object.freeze({
   market,status:"BLOCKED_DATA",reason,
   observedNativeCrossingCount:knownEventCount,
   originalPublicWatchEventCount:null,
   corroboratedPositiveWatchEvents:null,
   sourceTimedEarlyWatchCandidates:null,
   sourceTimedLeadMinutes:null,
   publicWatchIsTradingSignal:false,
   negativeWatchlistCoverageVerified:false,
   genuineHistoricalScannerAsOfVerified:false,
   marketWideEarlyRecall:null,
   verifiedFalseNegativeCount:null,
   realFilledOrders:null,netReturnPct:null,
   ...additional,
 });
}
function checkCadence(c,dayStartMs,dayEndMs){
 if(!record(c)||c.schemaVersion!==CADENCE
   ||!RELEASE.test(c.researchSha??"")||!HASH.test(c.eventId??"")
   ||c.eventId!==publicWatchCadenceIdV1(c)
   ||!int(ms(c.observedAt))
   ||ms(c.observedAt)<dayStartMs||ms(c.observedAt)>=dayEndMs
   ||!WATCH_CYCLE.has(c.cycleStatus)||!BUDGET.has(c.resourceBudget)
   ||c.publicPriceObservationOnly!==true
   ||c.executionAuthority!=="NONE"
   ||c.paperCredit!==0||c.oosCredit!==0||c.economicEvidenceCredit!==0
   ||!Array.isArray(c.markets)||c.markets.length!==4)
   return false;
 for(let i=0;i<MARKET_ORDER.length;i++){
   const v=c.markets[i];
   if(!record(v)||v.market!==MARKET_ORDER[i]
     ||!Number.isSafeInteger(v.observedCount)||v.observedCount<0||v.observedCount>8000
     ||typeof v.status!=="string")return false;
 }
 return true;
}
function checkEvent(e,dayStartMs,dayEndMs){
 const at=ms(e?.observedAt);
 if(!record(e)||e.schemaVersion!==WATCH||e.kind!=="PROVISIONAL_PRICE_ACCELERATION"
   ||!HASH.test(e.eventId??"")||e.eventId!==publicWatchEventIdV1(e)
   ||!RELEASE.test(e.researchSha??"")||!MARKET_ORDER.includes(e.market)
   ||!SAFE_SYMBOL.test(e.symbol??"")||!SAFE_SOURCE.test(e.source??"")
   ||!UP_DOWN.has(e.direction)||!int(at)
   ||at<dayStartMs||at>=dayEndMs
   ||!int(e.sourceAtMs)||e.sourceAtMs>at
   ||at-e.sourceAtMs>6*minute
   ||!int(e.priorSourceAtMs)||e.priorSourceAtMs>=e.sourceAtMs
   ||!Number.isFinite(e.movePercent)
   ||e.executionAuthority!=="NONE"||e.isTradingSignal!==false
   ||e.aiReviewed!==false||e.oosPassed!==false||e.paperAdmitted!==false)
  return false;
 return true;
}
function inspectNative(market,source){
 if(!source||source.status!=="OBSERVED_DAY_ONLY")
   return {error:"NATIVE_PRICE_DAY_UNAVAILABLE"};
 const meta=MARKETS[market];
 if(!meta)return {error:"STOCK_PIT_ONE_MINUTE_DAY_UNAVAILABLE"};
 const symbol=source.symbol,expectedSymbol=market==="CRYPTO_SPOT"
   ?symbol?.replace(/^KRW-/,""):symbol;
 if(source.market!==market||source.venue!==meta.venue
   ||!SAFE_SYMBOL.test(expectedSymbol??"")
   ||!int(source.utcDayStartMs)||source.utcDayStartMs%dayMs!==0
   ||source.utcDayEndMs!==source.utcDayStartMs+dayMs
   ||source.observedMinuteCount!==1440
   ||source.priorHourObservedMinuteCount!==60
   ||!HASH.test(source.rawCandleSha256??"")
   ||!Array.isArray(source.opportunities)
   ||source.observedDayCrossingCount!==source.opportunities.length
   ||source.actualFillCount!==null||source.trueMarketWideRecall!==null
   ||source.historicalScannerAsOfAvailabilityVerified!==false)
   return {error:"NATIVE_PRICE_PROVENANCE_INVALID"};
 for(const e of source.opportunities){
   if(e.market!==market||e.symbol!==symbol||e.venue!==meta.venue
     ||!["LONG","SHORT"].includes(e.direction)
     ||(market==="CRYPTO_SPOT"&&e.direction!=="LONG")
     ||!int(e.firstCrossingBarStartMs)
     ||e.firstCrossingBarStartMs<source.utcDayStartMs
     ||e.firstCrossingBarStartMs>=source.utcDayEndMs
     ||e.firstCrossingBarEndMs!==e.firstCrossingBarStartMs+minute)
     return {error:"NATIVE_CROSSING_PROVENANCE_INVALID"};
 }
 return {start:source.utcDayStartMs,end:source.utcDayEndMs,
   symbol:expectedSymbol,market,source:meta.source,
   events:source.opportunities};
}
export function reconcileOriginalPublicWatchV1({
 nativeUtcDayReport,watchEvents=[],cadenceRows=[],
}={}){
 if(!record(nativeUtcDayReport)
   ||nativeUtcDayReport.schemaVersion!=="native-utc-day-historical-public-1m-audit-v1"
   ||nativeUtcDayReport.executionAuthority!=="NONE"
   ||nativeUtcDayReport.profitabilityProven!==false
   ||nativeUtcDayReport.marketWideOpportunityDenominatorVerified!==false
   ||!record(nativeUtcDayReport.markets)
   ||!Array.isArray(watchEvents)||watchEvents.length>10000
   ||!Array.isArray(cadenceRows)||cadenceRows.length>2000)
   throw new TypeError("WATCH_RESEARCH_INPUT_INVALID");
 const markets={},records=[...watchEvents];
 // Validate source records before matching: an untrusted 2026 record cannot
 // be silently shifted to match a 2025 historical price event.
 const noLedger=!watchEvents.length||!cadenceRows.length;
 for(const market of MARKET_ORDER){
   const native=nativeUtcDayReport.markets[market];
   const day=inspectNative(market,native);
   if(day.error){
     markets[market]=fail(market,day.error,null);
     continue;
   }
   const n=day.events.length;
   if(noLedger){
     markets[market]=fail(market,"HISTORICAL_WATCH_EVENT_AND_CADENCE_LOGS_NOT_ATTACHED",n);
     continue;
   }
   // Logs are read from one bounded day; out-of-day rows are never allowed to
   // become retrospective evidence for the 2025 native candle source.
   if(watchEvents.some(e=>!checkEvent(e,day.start,day.end))
      ||cadenceRows.some(e=>!checkCadence(e,day.start,day.end))){
     markets[market]=fail(market,"WATCH_LOG_SOURCE_DAY_OR_IDENTITY_MISMATCH",n);
     continue;
   }
   const release=new Set([...watchEvents,...cadenceRows].map(r=>r.researchSha));
   if(release.size!==1){
     markets[market]=fail(market,"CROSS_RELEASE_LOG_COHORT_NOT_COMPARABLE",n);
     continue;
   }
   const seenIds=new Map(),cycleByAt=new Map(),positive=[];
   let reason=null;
   for(const row of cadenceRows){
     const key=row.observedAt;
     if(cycleByAt.has(key)&&cycleByAt.get(key).eventId!==row.eventId){
       reason="CADENCE_TIMESTAMP_CONFLICT";break;
     }
     cycleByAt.set(key,row);
   }
   if(!reason)for(const e of watchEvents){
     const previous=seenIds.get(e.eventId);
     if(previous && JSON.stringify(previous)!==JSON.stringify(e)){
       reason="WATCH_EVENT_ID_REPLAY_CONFLICT";break;
     }
     if(previous)continue;
     seenIds.set(e.eventId,e);
     if(e.market!==market||e.symbol!==day.symbol||e.source!==day.source)
       continue;
     const cadence=cycleByAt.get(e.observedAt);
     const member=cadence?.markets?.find(x=>x.market===market);
     if(!cadence||!member||!HEALTHY.has(member.status)||member.observedCount===0
       ||cadence.resourceBudget!=="RUN"){
       reason="WATCH_POSITIVE_EVENT_MISSING_SAME_CYCLE_CADENCE";break;
     }
     positive.push(e);
   }
   if(reason){
     markets[market]=fail(market,reason,n);
     continue;
   }
   const matches=[];
   for(const event of day.events){
     const direction=event.direction==="LONG"?"UP":"DOWN";
     const prior=positive.filter(e=>e.direction===direction
       &&ms(e.observedAt)<event.firstCrossingBarStartMs)
       .sort((a,b)=>ms(a.observedAt)-ms(b.observedAt));
     if(prior.length){
       const first=prior[0];
       matches.push(Object.freeze({
         observedPriceEventId:event.eventId,
         watcherEventId:first.eventId,
         direction:event.direction,
         publicWatchObservedAt:first.observedAt,
         firstCrossingBarStartMs:event.firstCrossingBarStartMs,
         reconstructedLeadMinutes:(event.firstCrossingBarStartMs-ms(first.observedAt))/minute,
         // Event was logged after detection cycle; persistence and actual
         // as-of historical scanner feed delivery are NOT independently proven.
         historicalScannerPersistedAtProven:false,
         tradableSignal:false,actualFillProven:false,
       }));
     }
   }
   markets[market]=Object.freeze({
     market,status:"SOURCE_TIMED_PUBLIC_WATCH_POSITIVES_ONLY",
     nativeSourceSymbol:day.symbol,
     observedNativeCrossingCount:n,
     originalPublicWatchEventCount:positive.length,
     corroboratedPositiveWatchEvents:matches.length,
     sourceTimedEarlyWatchCandidates:matches,
     sourceTimedLeadMinutes:matches.map(m=>m.reconstructedLeadMinutes),
     publicWatchIsTradingSignal:false,
     negativeWatchlistCoverageVerified:false,
     genuineHistoricalScannerAsOfVerified:false,
     marketWideEarlyRecall:null,
     verifiedFalseNegativeCount:null,
     realFilledOrders:null,netReturnPct:null,
   });
 }
 return Object.freeze({
   schemaVersion:"public-watch-to-native-minute-evidence-v1",
   status:"RESEARCH_SOURCE_MATCH_ONLY",
   sourceWindow:nativeUtcDayReport.sampledDay,
   markets,
   originalWatchEventRowsSupplied:records.length,
   originalCadenceRowsSupplied:cadenceRows.length,
   allMarketsNegativeEvidenceCoverageVerified:false,
   historicalMarketWideOpportunityDenominatorVerified:false,
   historicalMarketWideRecall:null,
   originalHistoricalScannerAsOfAvailabilityVerified:false,
   actualFillCount:null,netProfitPct:null,
   OOSPassCount:0,profitabilityProven:false,
   executionAuthority:"NONE",liveTrading:false,autoTrading:false,realOrders:false,
   privateProviderApi:false,
 });
}
