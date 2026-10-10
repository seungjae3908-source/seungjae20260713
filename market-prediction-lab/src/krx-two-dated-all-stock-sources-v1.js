import {createHash} from "node:crypto";
import {collectKrxDatedRosterV1} from "./krx-dated-roster-public-read-v1.js";
import {collectKrxThreeBoardDatedOHLCV1} from "./krx-dated-all-stock-ohlcv-v1.js";

/**
 * Source-limited stock daily-price pair intake for two actual dated KRX
 * SOURCE snapshots. The caller nominates a preceding trading session;
 * consecutive official trading-session evidence is NOT assumed.
 * 
 * Same-ISIN cross-date join prevents a ticker rename/reuse being conflated
 * with a normal previous closing price. All KOSPI/KOSDAQ/KONEX symbols
 * participate; no current app catalog or 6-name fixture as a market scope.
 * No private brokerage API, secrets, orders, LIVE/AUTO or DB changes.
 */
const DAY=86_400_000;
const DIGEST=/^[a-f0-9]{64}$/;
const ymdDate=v=>{
 if(typeof v!=="string"||!/^\d{8}$/.test(v))return null;
 const str=v.slice(0,4)+"-"+v.slice(4,6)+"-"+v.slice(6,8)+"T00:00:00.000Z";
 const t=Date.parse(str);
 if(!Number.isFinite(t)||new Date(t).toISOString().slice(0,10).replace(/-/g,"")!==v)
   return null;
 return t;
};
const sha=v=>createHash("sha256").update(JSON.stringify(v)).digest("hex");
const safe=(fields={})=>Object.freeze({
 schemaVersion:"krx-authorized-two-session-all-stock-intake-v1",
 market:"KR_STOCK",venue:"KRX",status:"BLOCKED_DATA",
 reason:"UNKNOWN",requestedTradingDates:null,
 records:null,joinedSourceRowsSha256:null,
 observedCurrentSymbols:null,joinedPriorPriceSymbols:null,
 unmatchedPriorISINsPreview:null,missingPreviousPriceCount:null,
 authorizedKRXDailyGETs:0,authorizedKRXGETLimit:12,
 sourceKeyPersisted:false,sourceKeyInMemoryOnly:true,
 officialAdjacentTradingSessionCalendarVerified:false,
 corporateActionsAdjustedAndVerified:false,
 fullMarketHistoricDelistedUniverseVerified:false,
 venueNativeIntradayEvidenceAvailable:false,
 fullMarketOpportunityDenominatorVerified:false,
 trueMarketWideRecall:null,actualMarketWideOpportunityCount:null,
 actualFillCount:null,netProfitPct:null,OOSPassCount:0,
 profitabilityProven:false,executionAuthority:"NONE",
 liveTrading:false,autoTrading:false,realOrders:false,
 ...fields,
});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export const KRX_TWO_DATED_SESSION_PRICE_POLICY_V1=Object.freeze({
  maxDates:2,markets:["KOSPI","KOSDAQ","KONEX"],
  maxPublicReadOnlyGETs:12,minGapMs:150,
  previousOfficialSessionProven:false,
  noKeyMeansNoGETs:true,
});
export async function collectKrxTwoDatedFullStockDailySourcesV1({
  currentDateYmd,priorTradingDateYmd,
  authKey=null,fetchImpl=globalThis.fetch,
  sleepImpl=sleep,minGapMs=150,
}={}){
 const end=ymdDate(currentDateYmd),prior=ymdDate(priorTradingDateYmd);
 if(end==null||prior==null||prior>=end
   ||end-prior>16*DAY||currentDateYmd<"20130701")
   throw new TypeError("KRX_TWO_DAY_WINDOW_OR_PRIOR_SESSION_CLAIM_INVALID");
 if(typeof fetchImpl!=="function"||typeof sleepImpl!=="function"
   ||!Number.isSafeInteger(minGapMs)||minGapMs<150||minGapMs>2000)
   throw new TypeError("KRX_TWO_DAY_SOURCE_IO_POLICY_INVALID");
 const dates=Object.freeze([priorTradingDateYmd,currentDateYmd]);
 if(typeof authKey!=="string"||!authKey.trim())
   return safe({status:"BLOCKED_MARKET_DATA_ENTITLEMENT",
     reason:"APPROVED_KRX_MARKET_DATA_KEY_NOT_CONNECTED",
     requestedTradingDates:dates});
 if(authKey.length>256)throw new TypeError("KRX_TWO_DAY_AUTH_KEY_TOO_LONG");
 let calls=0;
 // Both KRX adapters use the SAME read-only GET ceiling / gap budget.
 const safeFetch=async (url,opts)=>{
   if(calls>=12)throw new Error("KRX_TWO_DAY_SOURCE_REQUEST_BUDGET_EXCEEDED");
   if(calls>0)await sleepImpl(minGapMs);
   calls++;
   return fetchImpl(url,opts);
 };
 const out={};
 for(const d of dates){
   const roster=await collectKrxDatedRosterV1({
     dateYmd:d,authKey,fetchImpl:safeFetch,
   });
   if(roster.status!=="OBSERVED_KRX_DAY_ROSTER_ONLY")
     return safe({status:"BLOCKED_DATA",reason:roster.reason,
       sourceFailureStage:"DATED_THREE_BOARD_ROSTER",
       sourceFailureDate:d,
       authorizedKRXDailyGETs:calls,requestedTradingDates:dates});
   const quotes=await collectKrxThreeBoardDatedOHLCV1({
     dateYmd:d,datedRoster:roster,authKey,fetchImpl:safeFetch,
     sleepImpl:async()=>{},minGapMs,
   });
   if(quotes.status!=="SOURCE_LIMITED_DATED_QUOTES_MATCHED_ONLY")
     return safe({status:"BLOCKED_DATA",reason:quotes.reason,
       sourceFailureStage:"DATED_THREE_BOARD_OHLC",
       sourceFailureDate:d,
       authorizedKRXDailyGETs:calls,requestedTradingDates:dates});
   out[d]={roster,quotes};
 }
 // The source feed and its roster are dated snapshots, NOT evidence that
 // no trading sessions existed between the two requested user dates.
 const prev=out[priorTradingDateYmd],today=out[currentDateYmd];
 if(!DIGEST.test(prev.quotes.sourceDailyRowsSha256)
   ||!DIGEST.test(today.quotes.sourceDailyRowsSha256))
   return safe({reason:"KRX_DATED_PRICE_DIGEST_INVALID",
     authorizedKRXDailyGETs:calls,requestedTradingDates:dates});
 const priorByISIN=new Map(prev.quotes.rows.map(r=>[r.isin,r]));
 const currentRows=[],missingPrior=[];
 for(const current of today.quotes.rows){
   const previous=priorByISIN.get(current.isin);
   if(!previous){
     missingPrior.push({symbol:current.symbol,isin:current.isin});continue;
   }
   // Ticker migrations must preserve the same short code for the automatic
   // close-to-close join. Other cases need a corporate-action/source mapping.
   if(current.symbol!==previous.symbol||current.marketBoard!==previous.marketBoard){
     missingPrior.push({symbol:current.symbol,isin:current.isin});continue;
   }
   currentRows.push(Object.freeze({
     market:"KR_STOCK",venue:"KRX",symbol:current.symbol,isin:current.isin,
     marketBoard:current.marketBoard,
     currentTradingDateYmd:currentDateYmd,priorCandidateTradingDateYmd:priorTradingDateYmd,
     priorOpen:previous.open,priorHigh:previous.high,
     priorLow:previous.low,priorClose:previous.close,priorVolume:previous.volume,
     open:current.open,high:current.high,low:current.low,
     close:current.close,volume:current.volume,
     sourceIdentity:"KRX_OFFICIAL_DATED_TRADING_INFO",
     automaticCorporateActionAdjustmentApplied:false,
   }));
 }
 const full=missingPrior.length===0&&
   currentRows.length===today.quotes.rows.length;
 const records=Object.freeze(currentRows.sort((a,b)=>a.symbol.localeCompare(b.symbol)));
 return safe({
   status:full?"SOURCE_LIMITED_TWO_KRX_DATES_JOINED_ONLY":
     "PARTIAL_PRIOR_SESSION_STOCK_SOURCE_BLOCKED",
   reason:full?"OFFICIAL_TRADING_SESSION_ADJACENCY_AND_CORPORATE_ACTION_UNVERIFIED":
     "HISTORICAL_PRIOR_SESSION_SYMBOL_OR_ISIN_NOT_AVAILABLE",
   requestedTradingDates:dates,authorizedKRXDailyGETs:calls,
   observedCurrentSymbols:today.quotes.rows.length,
   joinedPriorPriceSymbols:records.length,
   missingPreviousPriceCount:missingPrior.length,
   unmatchedPriorISINsPreview:Object.freeze(missingPrior.slice(0,20)),
   recordSha256:sha({dates,records,
     priorRosterDigest:prev.roster.sourceSha256,
     currentRosterDigest:today.roster.sourceSha256,
     priorQuoteDigest:prev.quotes.sourceDailyRowsSha256,
     currentQuoteDigest:today.quotes.sourceDailyRowsSha256}),
   records,
   joinedSourceRowsSha256:sha(records),
   officialAdjacentTradingSessionCalendarVerified:false,
   corporateActionsAdjustedAndVerified:false,
   fullMarketHistoricDelistedUniverseVerified:false,
   trueMarketWideRecall:null,profitabilityProven:false,
   executionAuthority:"NONE",
 });
}
