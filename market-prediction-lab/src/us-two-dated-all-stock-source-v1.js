import {createHash} from "node:crypto";
import {collectUSAsOfActiveGroupedDailyV1}
  from "./us-asof-all-stock-grouped-daily-v1.js";

/**
 * Prior actual US venue trading session candidate + today's FULL as-of ticker
 * population, joined to genuine provider GROUPED day candles for each date.
 *
 * Does NOT assume prior calendar day = previous trading session. Date pair
 * still needs licensed exchange-session-calendar attestation, stable FIGI
 * lifecycle, delisting/corporate actions and original scanner watch logs.
 * No current survivor list, future high/low for signal features, or trades.
 */
const MAX_GAP=16*86_400_000;
const FIGI=/^[A-Z0-9]{12}$/;
const h=x=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
const safe=(result={})=>Object.freeze({
 schemaVersion:"us-two-dated-asof-all-stocks-price-source-v1",
 market:"US_STOCK",venue:"US_SIP",
 status:"BLOCKED_DATA",reason:"MISSING_HISTORICAL_SOURCE",
 requestedTradingDates:null,readOnlyProviderGETs:0,
 observedCurrentAsOfTickerCount:null,joinedPriorDailyPriceCount:null,
 missingPriorPriceOrIdentityCount:null,identityBlockerCounts:null,
 symbolsNeedingPriorReviewPreview:null,rows:null,
 sourceRowsSha256:null,
 originalScannerAvailabilityVerified:false,
 adjacentStockTradingSessionsAuthenticated:false,
 corporateActionsAndTickerChangesCanonicallyResolved:false,
 permanentShareClassIdentityComplete:false,
 fullThreeYearListedAndDelistedRosterVerified:false,
 fullMarketOpportunityDenominatorVerified:false,
 actualMarketWideOpportunityCount:null,trueMarketWideRecall:null,
 actualFillCount:null,netProfitPct:null,
 OOSPassCount:0,profitabilityProven:false,executionAuthority:"NONE",
 liveTrading:false,autoTrading:false,realOrders:false,
 providerKeyPersisted:false,privateTradingAPI:false,
 ...result,
});
export async function collectUSTwoDatedAsOfAllStockPricesV1({
 currentDate,priorCandidateTradingDate,apiKey=null,
 fetchImpl=globalThis.fetch,sleepImpl,
 minIntervalMs=150,maxRosterPages=64,
}={}){
 const t=Date.parse(String(currentDate)+"T00:00:00Z");
 const prior=Date.parse(String(priorCandidateTradingDate)+"T00:00:00Z");
 if(!Number.isSafeInteger(t)||!Number.isSafeInteger(prior)
    ||t<=prior||t-prior>MAX_GAP
    ||new Date(t).toISOString().slice(0,10)!==currentDate
    ||new Date(prior).toISOString().slice(0,10)!==priorCandidateTradingDate)
   throw new TypeError("US_TWO_DATED_SESSION_WINDOW_INVALID");
 if(typeof apiKey!=="string"||!apiKey.trim())
   return safe({requestedTradingDates:[
     priorCandidateTradingDate,currentDate,
   ],reason:"US_PROVIDER_HISTORICAL_AUTH_NOT_CONNECTED"});
 if(apiKey.length>256)throw new TypeError("US_TWO_DATED_AUTH_LENGTH_INVALID");
 const common={
   apiKey,fetchImpl,minIntervalMs,maxRosterPages,
   ...(sleepImpl?{sleepImpl}:{}),
 };
 const priorDay=await collectUSAsOfActiveGroupedDailyV1({
   ...common,date:priorCandidateTradingDate,
 });
 if(priorDay.status!=="SOURCE_LIMITED_ASOF_ROSTER_GROUPED_PRICES_JOIN_ONLY"){
   return safe({requestedTradingDates:[priorCandidateTradingDate,currentDate],
     reason:"US_PRIOR_DAY_ALL_NAME_SOURCE_NOT_COMPLETE",
     priorDaySourceStatus:priorDay.status,
     priorDaySourceReason:priorDay.reason,
     readOnlyProviderGETs:priorDay.providerReadOnlyGETs,
   });
 }
 if(sleepImpl)await sleepImpl(minIntervalMs);
 const currentDay=await collectUSAsOfActiveGroupedDailyV1({
   ...common,date:currentDate,
 });
 const requests=priorDay.providerReadOnlyGETs+currentDay.providerReadOnlyGETs;
 if(currentDay.status!=="SOURCE_LIMITED_ASOF_ROSTER_GROUPED_PRICES_JOIN_ONLY")
   return safe({requestedTradingDates:[priorCandidateTradingDate,currentDate],
     reason:"US_CURRENT_DAY_ALL_NAME_SOURCE_NOT_COMPLETE",
     currentDaySourceStatus:currentDay.status,
     currentDaySourceReason:currentDay.reason,
     readOnlyProviderGETs:requests,
   });
 const prevRoster=new Map(priorDay.datedRoster.map(x=>[x.ticker,x]));
 const prevByFigi=new Map(priorDay.datedRoster
   .filter(x=>FIGI.test(x.shareClassFIGI??""))
   .map(x=>[x.shareClassFIGI,x]));
 const prevPrice=new Map(priorDay.matchedPriceRows.map(x=>[x.symbol,x]));
 const nowPrice=new Map(currentDay.matchedPriceRows.map(x=>[x.symbol,x]));
 const rows=[],failures=[],reasons={};
 const error=(s,reason)=>{
   failures.push({symbol:s,reason});
   reasons[reason]=(reasons[reason]??0)+1;
 };
 for(const current of currentDay.datedRoster){
   const ticker=current.ticker,priorIdentity=prevRoster.get(ticker);
   const today=nowPrice.get(ticker);
   if(!today){error(ticker,"CURRENT_DAY_PRICE_MISSING");continue;}
   if(!FIGI.test(current.shareClassFIGI??"")){
     error(ticker,"CURRENT_STABLE_SHARE_CLASS_ID_NOT_ATTESTED");continue;
   }
   if(!priorIdentity){
     const old=prevByFigi.get(current.shareClassFIGI);
     error(ticker,old?"TICKER_RENAME_REQUIRES_LIFECYCLE_MAPPING":
       "NO_PRIOR_ACTIVE_LISTING_OR_NEW_STOCK");
     continue;
   }
   if(priorIdentity.shareClassFIGI!==current.shareClassFIGI){
     error(ticker,"REUSED_TICKER_OR_CHANGED_STABLE_ID");continue;
   }
   if(priorIdentity.primaryExchangeMIC!==current.primaryExchangeMIC||
      priorIdentity.securityType!==current.securityType){
     error(ticker,"EXCHANGE_OR_INSTRUMENT_TYPE_CHANGED");continue;
   }
   const last=prevPrice.get(ticker);
   if(!last){error(ticker,"PREVIOUS_DAY_PROVIDER_BAR_MISSING");continue;}
   rows.push(Object.freeze({
     market:"US_STOCK",venue:"US_SIP",symbol:ticker,
     shareClassFIGI:current.shareClassFIGI,
     asOfDate:currentDate,priorCandidateTradingDate,
     primaryExchangeMIC:current.primaryExchangeMIC,
     securityType:current.securityType,
     priorBarSourceTimestampMs:last.sourceTimestampMs,
     priorBarUSLocalDate:last.usEasternTradingDate,
     priorOpen:last.open,priorHigh:last.high,priorLow:last.low,
     priorClose:last.close,priorVolume:last.volume,
     currentBarSourceTimestampMs:today.sourceTimestampMs,
     currentBarUSLocalDate:today.usEasternTradingDate,
     open:today.open,high:today.high,low:today.low,
     close:today.close,volume:today.volume,
     venueTimeZone:"America/New_York",
     sourceAdjustedForSplits:false,
     corporateActionAdjustmentAuthenticated:false,
     previousSessionCalendarAuthenticated:false,
   }));
 }
 rows.sort((a,b)=>a.symbol.localeCompare(b.symbol));
 const complete=failures.length===0 &&
   rows.length===currentDay.datedRoster.length;
 const sourceId=h({
   date:currentDate,prior:priorCandidateTradingDate,
   priorRoster:priorDay.asOfRosterSha256,
   currentRoster:currentDay.asOfRosterSha256,
   priorPrice:priorDay.groupedDailySourceSha256,
   currentPrice:currentDay.groupedDailySourceSha256,rows,
 });
 return safe({
   status:complete?"SOURCE_LIMITED_TWO_US_ASOF_DATES_JOINED_ONLY":
     "PARTIAL_US_PRIOR_PRICE_OR_LIFECYCLE_BLOCKED",
   reason:complete?
     "OFFICIAL_SESSION_ADJACENCY_AND_CORPORATE_ACTION_UNVERIFIED":
     "US_STABLE_ID_OR_PRIOR_PRICE_NOT_AVAILABLE_FOR_EVERY_ASOF_TICKER",
   requestedTradingDates:[priorCandidateTradingDate,currentDate],
   readOnlyProviderGETs:requests,
   observedCurrentAsOfTickerCount:currentDay.datedRoster.length,
   joinedPriorDailyPriceCount:rows.length,
   missingPriorPriceOrIdentityCount:failures.length,
   identityBlockerCounts:reasons,
   symbolsNeedingPriorReviewPreview:failures.slice(0,30),
   rows:Object.freeze(rows),
   sourceRowsSha256:sourceId,
   originalScannerAvailabilityVerified:false,
   adjacentStockTradingSessionsAuthenticated:false,
   corporateActionsAndTickerChangesCanonicallyResolved:false,
   permanentShareClassIdentityComplete:false,
   twoDatedSourceShareClassIdentityMatched:complete,
   fullThreeYearListedAndDelistedRosterVerified:false,
   fullMarketOpportunityDenominatorVerified:false,
   actualMarketWideOpportunityCount:null,trueMarketWideRecall:null,
   profitabilityProven:false,executionAuthority:"NONE",
 });
}
