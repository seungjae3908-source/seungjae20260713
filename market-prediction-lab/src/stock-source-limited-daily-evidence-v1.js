import {createHash} from "node:crypto";

/**
 * Four-market research's STOCK-only price-event intake, reusing the real
 * source-limited KR/US whole-as-of-date two-session adapters.
 *
 * Downstream Python MUST use opportunity_coverage_audit_v1.py (single truth).
 * A valid two-date OHLC join is NOT an authenticated historical PIT market
 * denominator, an original scanner observation, a corporate action adjusted
 * entry, fill, or profitability proof. All outputs remain research-only.
 */
const VENUE=Object.freeze({KR_STOCK:"KRX",US_STOCK:"US_SIP"});
const SHA=/^[0-9a-f]{64}$/;
const ISIN=/^[A-Z0-9]{12}$/;
const NAME=/^[A-Z0-9][A-Z0-9.:-]{0,39}$/;
const BOARDS=new Set(["KOSPI","KOSDAQ","KONEX"]);
const object=x=>x!=null&&typeof x==="object"&&!Array.isArray(x);
const sha=x=>createHash("sha256").update(x).digest("hex");
const clean=x=>String(x??"").trim().toUpperCase();
function isoDay(input){
 if(typeof input!=="string")return null;
 const iso=/^\d{8}$/.test(input)
   ?input.slice(0,4)+"-"+input.slice(4,6)+"-"+input.slice(6):input;
 if(!/^\d{4}-\d{2}-\d{2}$/.test(iso))return null;
 const t=Date.parse(iso+"T00:00:00.000Z");
 return Number.isSafeInteger(t)&&new Date(t).toISOString().slice(0,10)===iso
   ?iso:null;
}
const eastern=new Intl.DateTimeFormat("en-US",{
  timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit",
});
function usETDay(t){
 if(!Number.isSafeInteger(t)||t<=0)return null;
 const parts=eastern.formatToParts(new Date(t));
 const x=name=>parts.find(z=>z.type===name)?.value;
 return [x("year"),x("month"),x("day")].join("-");
}
function validOHLC(o,h,l,c,v){
 return [o,h,l,c].every(x=>typeof x==="number"&&Number.isFinite(x)&&x>0)
   &&typeof v==="number"&&Number.isFinite(v)&&v>=0
   &&h>=Math.max(o,c)&&l<=Math.min(o,c)&&l>0;
}
function hold(market,reason,extra={}){
 return Object.freeze({
  schemaVersion:"four-market-stock-source-limited-daily-evidence-v1",
  status:"BLOCKED_DATA",market,venue:VENUE[market]??null,reason,
  date:null,priorCandidateDate:null,sourceAttestedNameCount:null,
  sourceRowsSha256:null,sourceJoinedRowsSha256:null,
  canonicalRowsJSON:null,rows:null,
  sourceObservedDailyEvents:null,originalScannerEventRecall:null,
  fullMarketOpportunityDenominatorVerified:false,
  actualMarketWideOpportunityCount:null,trueMarketWideRecall:null,
  originalAsOfScannerWatchVerified:false,
  independentlyAuthenticHistoricPITAndDelistings:false,
  officialAdjacentSessionsVerified:false,
  corporateActionAdjustmentVerified:false,
  actualFillCount:null,netProfitPct:null,OOSPassCount:0,
  profitabilityProven:false,executionAuthority:"NONE",
  liveTrading:false,autoTrading:false,realOrders:false,
  ...extra,
 });
}
function safeSource(source,market){
 const kr=market==="KR_STOCK";
 const expected=kr?"SOURCE_LIMITED_TWO_KRX_DATES_JOINED_ONLY":
   "SOURCE_LIMITED_TWO_US_ASOF_DATES_JOINED_ONLY";
 if(!object(source)||source.market!==market||source.venue!==VENUE[market]
    ||source.schemaVersion!==(kr?"krx-authorized-two-session-all-stock-intake-v1":
      "us-two-dated-asof-all-stocks-price-source-v1")
    ||source.status!==expected||source.executionAuthority!=="NONE"
    ||source.profitabilityProven!==false
    ||source.trueMarketWideRecall!==null
    ||source.actualMarketWideOpportunityCount!==null
    ||source.fullMarketOpportunityDenominatorVerified!==false
    ||!SHA.test(source[kr?"recordSha256":"sourceRowsSha256"]??"")
    ||!Array.isArray(source.records??source.rows)
    ||!Array.isArray(source.requestedTradingDates)
    ||source.requestedTradingDates.length!==2)
    return {error:"STOCK_ALL_NAME_TWO_DATE_SOURCE_NOT_COMPLETE"};
 if(kr){
   if(source.officialAdjacentTradingSessionCalendarVerified!==false
      ||source.corporateActionsAdjustedAndVerified!==false
      ||source.fullMarketHistoricDelistedUniverseVerified!==false
      ||!Number.isSafeInteger(source.observedCurrentSymbols)
      ||source.joinedPriorPriceSymbols!==source.observedCurrentSymbols
      ||source.missingPreviousPriceCount!==0)
      return {error:"STOCK_KRX_PREVIOUS_SESSION_OR_ALL_NAMES_NOT_ATTESTED"};
 }else{
   if(source.adjacentStockTradingSessionsAuthenticated!==false
      ||source.corporateActionsAndTickerChangesCanonicallyResolved!==false
      ||source.fullThreeYearListedAndDelistedRosterVerified!==false
      ||source.permanentShareClassIdentityComplete!==false
      ||source.twoDatedSourceShareClassIdentityMatched!==true
      ||!Number.isSafeInteger(source.observedCurrentAsOfTickerCount)
      ||source.joinedPriorDailyPriceCount!==source.observedCurrentAsOfTickerCount
      ||source.missingPriorPriceOrIdentityCount!==0)
      return {error:"STOCK_US_PREVIOUS_SESSION_OR_STABLE_ID_NOT_ATTESTED"};
 }
 const values=source.requestedTradingDates.map(isoDay);
 if(values.some(x=>x==null)||values[0]>=values[1])
   return {error:"STOCK_SOURCE_TRADING_DATES_INVALID"};
 const dates=source.requestedTradingDates;
 const currentDate=values[1],priorDate=values[0];
 const rows=kr?source.records:source.rows;
 const n=kr?source.observedCurrentSymbols:source.observedCurrentAsOfTickerCount;
 if(!Array.isArray(rows)||!n||n>50000||rows.length!==n)
   return {error:"STOCK_DATED_ACTIVE_UNIVERSE_PRICE_ROWS_INCOMPLETE"};
 if(kr?dates.some(d=>!/^\d{8}$/.test(d)):
   dates.some(d=>!/^\d{4}-\d{2}-\d{2}$/.test(d)))
   return {error:"STOCK_SOURCE_MARKET_DATE_FORMAT_INVALID"};
 return {rows,n,kr,currentDate,priorDate};
}
export function prepareStockSourceLimitedDailyEvidenceV1({
 market,source=null,testFixtureOnly=false,
}={}){
 if(!Object.hasOwn(VENUE,market))throw new TypeError("STOCK_DAILY_MARKET_INVALID");
 if(typeof testFixtureOnly!=="boolean")throw new TypeError("STOCK_DAILY_FIXTURE_FLAG_INVALID");
 const base=safeSource(source,market);
 if(base.error)return hold(market,base.error);
 const {rows,n,kr,currentDate,priorDate}=base;
 const seenNames=new Set(),seenIDs=new Set(),normalized=[];
 for(const row of rows){
   const symbol=clean(row?.symbol);
   const id=kr?row?.isin:row?.shareClassFIGI;
   if(!NAME.test(symbol)||kr&&!/^\d{6}$/.test(symbol)
      ||typeof id!=="string"||!ISIN.test(id)
      ||seenNames.has(symbol)||seenIDs.has(id)
      ||row.market!==market||row.venue!==VENUE[market]
      ||!validOHLC(row.priorOpen,row.priorHigh,row.priorLow,
        row.priorClose,row.priorVolume)
      ||!validOHLC(row.open,row.high,row.low,row.close,row.volume))
     return hold(market,"STOCK_DAILY_BAR_OR_STABLE_ID_INVALID");
   if(kr){
     if(row.currentTradingDateYmd!==source.requestedTradingDates[1]
       ||row.priorCandidateTradingDateYmd!==source.requestedTradingDates[0]
       ||!BOARDS.has(row.marketBoard)
       ||row.sourceIdentity!=="KRX_OFFICIAL_DATED_TRADING_INFO"
       ||row.automaticCorporateActionAdjustmentApplied!==false)
       return hold(market,"STOCK_KRX_HISTORIC_DATE_VENUE_OR_ADJUSTMENT_INVALID");
   }else{
     if(row.asOfDate!==currentDate||row.priorCandidateTradingDate!==priorDate
       ||row.currentBarUSLocalDate!==currentDate
       ||row.priorBarUSLocalDate!==priorDate
       ||row.venueTimeZone!=="America/New_York"
       ||usETDay(row.currentBarSourceTimestampMs)!==currentDate
       ||usETDay(row.priorBarSourceTimestampMs)!==priorDate
       ||row.sourceAdjustedForSplits!==false
       ||row.corporateActionAdjustmentAuthenticated!==false
       ||row.previousSessionCalendarAuthenticated!==false)
       return hold(market,"STOCK_US_ET_SOURCE_OR_ADJUSTMENT_INVALID");
   }
   seenNames.add(symbol);seenIDs.add(id);
   normalized.push({
     symbol,market,venue:VENUE[market],
     stableIssueId:id,sourceCurrentTradingDate:currentDate,
     sourcePriorCandidateDate:priorDate,
     priorOpen:row.priorOpen,priorHigh:row.priorHigh,
     priorLow:row.priorLow,priorClose:row.priorClose,
     priorVolume:row.priorVolume,
     open:row.open,high:row.high,low:row.low,
     close:row.close,volume:row.volume,
   });
 }
 // The upstream lineage digest also includes provider roster/prices. That
 // composite is not recalculable from a standalone saved receipt; bind every
 // serialized joined row separately so silently changed OHLC cannot score.
 // Integrity hash != official source authenticity or full historic PIT.
 if(!SHA.test(source.joinedSourceRowsSha256??"")
    ||source.joinedSourceRowsSha256!==sha(JSON.stringify(rows)))
   return hold(market,"STOCK_JOINED_SOURCE_ROWS_DIGEST_MISSING_OR_CHANGED");
 normalized.sort((a,b)=>a.symbol.localeCompare(b.symbol));
 const canonicalRowsJSON=JSON.stringify(normalized);
 return Object.freeze({
  ...hold(market,null),
  status:testFixtureOnly?"TEST_FIXTURE_TWO_DATED_STOCK_PRICE_BARS_ONLY":
    "SOURCE_ATTESTED_TWO_DATED_STOCK_PRICE_BARS_ONLY",
  reason:testFixtureOnly?"CONTRACT_TEST_ONLY":
    "DATE_PIT_AND_CORPORATE_ACTION_NOT_INDEPENDENTLY_AUTHENTICATED",
  date:currentDate,priorCandidateDate:priorDate,
  sourceAttestedNameCount:normalized.length,
  sourceProvider:kr?"KRX_OPENAPI_AUTHORIZED_THREE_BOARDS":
    "MASSIVE_US_ASOF_ACTIVE_GROUPED_UNADJUSTED",
  sourceReferenceSha256:source[kr?"recordSha256":"sourceRowsSha256"],
  sourceJoinedRowsSha256:source.joinedSourceRowsSha256,
  sourceRowsSha256:sha(canonicalRowsJSON),
  canonicalRowsJSON,
  rows:Object.freeze(normalized),
  sourceObservedDailyEvents:null,originalScannerEventRecall:null,
  priorCandidateIsOfficialPreviousSessionVerified:false,
  historicalFullDelistedSecurityMasterVerified:false,
  trueMarketWideRecall:null,fullMarketOpportunityDenominatorVerified:false,
  profitabilityProven:false,executionAuthority:"NONE",
 });
}
