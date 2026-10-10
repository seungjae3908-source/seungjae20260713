import {createHash} from "node:crypto";
import {auditHistoricalPITVenueUniverseV1} from "./historical-pit-venue-universe-gate-v1.js";

/**
 * Source-coverage gate for the user's ACTUAL four venues and their historical
 * all-name lists. It does not duplicate the existing daily OHLC event scorer
 * (opportunity_coverage_audit_v1.py), scanner-quality, or execution engines.
 *
 * All receipts are retrospective and self-attested until separately verified
 * against licensed/official originals. An archive hash is integrity evidence,
 * NEVER proof of exchange completeness or an as-of scanner observation.
 */
const DAY=86_400_000;
export const FOUR_MARKET_WHOLE_SCOPE_V1=Object.freeze({
  KR_STOCK:Object.freeze({
    venue:"KRX",scope:"ALL_HISTORIC_KOSPI_KOSDAQ_KONEX",
    directions:Object.freeze(["LONG"]),thresholdsPct:Object.freeze([5,10,20]),
  }),
  US_STOCK:Object.freeze({
    venue:"US_SIP",scope:"ALL_HISTORIC_US_LISTED_INCLUDING_DELISTED_AND_RENAMED",
    directions:Object.freeze(["LONG"]),thresholdsPct:Object.freeze([5,10,20]),
  }),
  CRYPTO_SPOT:Object.freeze({
    venue:"UPBIT_KRW",scope:"ALL_HISTORIC_UPBIT_KRW_PAIRS_INCLUDING_DELISTED",
    directions:Object.freeze(["LONG"]),thresholdsPct:Object.freeze([5,10,20]),
  }),
  CRYPTO_FUTURES:Object.freeze({
    venue:"BITGET_USDT_FUTURES",scope:"ALL_HISTORIC_BITGET_USDT_PERPETUAL_CONTRACTS",
    directions:Object.freeze(["LONG","SHORT"]),thresholdsPct:Object.freeze([5,10,20]),
  }),
});
const MARKETS=Object.keys(FOUR_MARKET_WHOLE_SCOPE_V1);
const SHA=/^[0-9a-f]{64}$/;
const SYMBOL=/^[A-Z0-9][A-Z0-9._:-]{0,39}$/;
const valid=n=>Number.isSafeInteger(n)&&n>0;
const object=v=>v!==null&&typeof v==="object"&&!Array.isArray(v);
const normalize=v=>String(v??"").trim().toUpperCase();

export function digestWholeVenueDailyRowsV1(rows){
  if(!Array.isArray(rows)||rows.length>50000)
    throw new TypeError("WHOLE_DAILY_ROWS_INVALID");
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}
function blocked(market,reason,extra={}){
  return Object.freeze({
    market,venue:FOUR_MARKET_WHOLE_SCOPE_V1[market].venue,
    intendedUniverse:FOUR_MARKET_WHOLE_SCOPE_V1[market].scope,
    allowedDirections:FOUR_MARKET_WHOLE_SCOPE_V1[market].directions,
    eventThresholdsPct:FOUR_MARKET_WHOLE_SCOPE_V1[market].thresholdsPct,
    status:"BLOCKED_WHOLE_MARKET_COVERAGE",reason,
    sourceAttestedHistoricalActiveSymbols:null,
    sourceAttestedDailyBars:null,missingDailyBarCount:null,
    missingDailyBarSymbolsPreview:null,
    sourceAttestedFullSymbolDayPriceJoin:false,
    existingOpportunityEngineInputEligible:false,
    actualMarketWideOpportunityCount:null,actualMarketWideRecall:null,
    trueMarketWideRecall:null,
    originalScannerObservationsVerified:false,actualFillCount:null,
    netProfitPct:null,profitabilityProven:false,
    fullMarketOpportunityDenominatorVerified:false,
    independentlyAuthenticatedPITAndPriceEvidence:false,
    executionAuthority:"NONE",liveTrading:false,autoTrading:false,
    realOrders:false,privateTradingApiAllowed:false,...extra,
  });
}
function dayValid(ms){return valid(ms)&&ms%DAY===0;}
function sourceValid(d,market,start){
  const policy=FOUR_MARKET_WHOLE_SCOPE_V1[market],end=start+DAY;
  if(!object(d)||d.schemaVersion!=="venue-native-historical-all-names-daily-v1"
     ||d.market!==market||d.venue!==policy.venue
     ||d.dayStartMs!==start||d.dayEndMs!==end
     ||!["VENUE_NATIVE_DAILY_ARCHIVE","LICENSED_PIT_DAILY_VENDOR","TEST_FIXTURE"].includes(d.sourceClass)
     ||typeof d.sourceId!=="string"||!d.sourceId.trim()
     ||!valid(d.retrievedAtMs)||d.retrievedAtMs<end
     ||d.exhaustiveActiveSymbolsRequested!==true
     ||d.priceSelectionUsedFutureDayOHLC!==false
     ||!Array.isArray(d.rows)||d.rows.length>50000
     ||!SHA.test(d.rowsSha256??"")
     ||d.rowsSha256!==digestWholeVenueDailyRowsV1(d.rows))
    return false;
  if(["KR_STOCK","US_STOCK"].includes(market)
     &&d.corporateActionAdjustmentEvidenceAttached!==true)
    return false;
  if(["CRYPTO_SPOT","CRYPTO_FUTURES"].includes(market)
     &&d.sourcePriceConvention!=="NATIVE_UNADJUSTED")
    return false;
  return true;
}
function activeDayMembers(manifest,start){
  const end=start+DAY,active=new Map(),intraday=[];
  for(const row of manifest.memberships){
    const symbol=normalize(row.symbol);
    if(row.listedAtMs>=end||(row.removedAtMs??Infinity)<=start)continue;
    // Non-overlapping lives of the SAME code can both occur in this day:
    // a Map would otherwise silently collapse the first listing/exit.
    if(active.has(symbol))
      return {error:"PIT_SAME_DAY_IDENTIFIER_REUSE_REQUIRES_SESSION_PROOF",
        symbol};
    active.set(symbol,row);
    if(row.listedAtMs>=start||(row.removedAtMs??Infinity)<end
       ||row.halts.some(h=>h.startMs<end&&h.endMs>start))
      intraday.push(symbol);
  }
  return {active,intraday};
}
export function auditWholeVenuePITDailyCoverageV1({
  market,dayStartMs,manifest=null,dailySource=null,
}={}){
  if(!Object.hasOwn(FOUR_MARKET_WHOLE_SCOPE_V1,market))
    throw new TypeError("WHOLE_PIT_MARKET_INVALID");
  if(!dayValid(dayStartMs))throw new TypeError("WHOLE_PIT_DAY_INVALID");
  const dayEndMs=dayStartMs+DAY;
  const pit=auditHistoricalPITVenueUniverseV1({
    market,dayStartMs,dayEndMs,selectedRows:[],manifest,
  });
  if(!["TEST_FIXTURE_ONLY","SOURCE_ATTESTED_PIT_COHORT_ONLY"].includes(pit.status))
    return blocked(market,"PIT_"+pit.reason,{
      pitSourceStatus:pit.status,dayStartMs,
    });
  const count=pit.dayActiveArchivedMembers;
  const base={dayStartMs,pitSourceStatus:pit.status,
    sourceAttestedHistoricalActiveSymbols:count};
  if(dailySource==null)
    return blocked(market,"VENUE_NATIVE_FULL_DAY_PRICE_DATA_NOT_CONNECTED",base);
  if(!sourceValid(dailySource,market,dayStartMs))
    return blocked(market,"FULL_DAILY_SOURCE_PROVENANCE_OR_CORPORATE_ACTION_INVALID",base);
  if((pit.status==="TEST_FIXTURE_ONLY") !==
     (dailySource.sourceClass==="TEST_FIXTURE"))
    return blocked(market,"PIT_AND_DAILY_SOURCE_CLASS_MISMATCH",base);
  const {active,intraday,error:activeError}=activeDayMembers(manifest,dayStartMs);
  if(activeError)
    return blocked(market,activeError,{
      ...base,sourceAttestedDailyBars:dailySource.rows.length,
    });
  if(active.size!==count)
    return blocked(market,"PIT_LIFECYCLE_ACTIVE_COUNT_MISMATCH",base);
  const seen=new Set(),unexpected=[],invalid=[],futureBaseline=[];
  for(const row of dailySource.rows){
    const symbol=normalize(row?.symbol);
    if(!SYMBOL.test(symbol)||seen.has(symbol)
       ||row?.market!==market||row?.venue!==dailySource.venue
       ||row?.timestampMs!==dayStartMs
       ||typeof row?.sourceId!=="string"||row.sourceId!==dailySource.sourceId
       ||!SHA.test(row?.evidenceSha256??"")){
      invalid.push(symbol||"INVALID");continue;
    }
    seen.add(symbol);
    if(!active.has(symbol)){unexpected.push(symbol);continue;}
    const prices=[row?.open,row?.high,row?.low,row?.close,row?.priorClose];
    if(!prices.every(x=>typeof x==="number"&&Number.isFinite(x)&&x>0)
       ||row.high<Math.max(row.open,row.close)
       ||row.low>Math.min(row.open,row.close)
       ||row.low>row.high
       ||typeof row.volume!=="number"||!Number.isFinite(row.volume)
       ||row.volume<0){
      invalid.push(symbol);continue;
    }
    if(!valid(row.priorCloseAsOfMs)||row.priorCloseAsOfMs>dayStartMs)
      futureBaseline.push(symbol);
  }
  if(invalid.length||unexpected.length||futureBaseline.length)
    return blocked(market,invalid.length?"DAILY_OHLC_OR_IDENTITY_INVALID":
      unexpected.length?"VENUE_PRICE_OUTSIDE_HISTORICAL_PIT_MEMBERSHIP":
      "PRIOR_CLOSE_NOT_AVAILABLE_AT_DECISION_TIME",{
      ...base,sourceAttestedDailyBars:dailySource.rows.length,
      invalidBarCount:invalid.length,outsidePITCount:unexpected.length,
      futureBaselineCount:futureBaseline.length,
      exampleSymbols:[...invalid,...unexpected,...futureBaseline].slice(0,20),
    });
  const missing=[...active.keys()].filter(s=>!seen.has(s));
  if(missing.length)
    return blocked(market,"PIT_ACTIVE_NAMES_MISSING_VENUE_DAILY_PRICES",{
      ...base,sourceAttestedDailyBars:seen.size,
      missingDailyBarCount:missing.length,
      missingDailyBarSymbolsPreview:missing.slice(0,25),
    });
  if(intraday.length)
    return blocked(market,"PIT_INTRADAY_LISTING_DELISTING_OR_HALT_NEEDS_SESSION_PROOF",{
      ...base,sourceAttestedDailyBars:seen.size,
      partialSessionMemberCount:intraday.length,
      partialSessionSymbolPreview:intraday.slice(0,25),
    });
  // This is only a SOURCE-ATTESTED coverage join. The existing Python audit
  // owns daily high/low opportunity labels and eligibility for later 1m joins.
  return Object.freeze({
    ...blocked(market,null,{
      ...base,sourceAttestedDailyBars:seen.size,missingDailyBarCount:0,
      missingDailyBarSymbolsPreview:[],
    }),
    status:pit.status==="TEST_FIXTURE_ONLY"
      ?"TEST_FIXTURE_FULL_NAME_DAILY_JOIN_ONLY"
      :"SOURCE_ATTESTED_FULL_NAME_DAILY_JOIN_ONLY",
    reason:pit.status==="TEST_FIXTURE_ONLY"?"CONTRACT_TEST_ONLY":
      "ARCHIVE_AND_PRICES_NOT_INDEPENDENTLY_AUTHENTICATED",
    sourceAttestedFullSymbolDayPriceJoin:true,
    existingOpportunityEngineInputEligible:true,
    nextExistingOpportunityEngine:"market-prediction-lab/scripts/opportunity_coverage_audit_v1.py",
    actualMarketWideOpportunityCount:null,actualMarketWideRecall:null,
    fullMarketOpportunityDenominatorVerified:false,
    independentlyAuthenticatedPITAndPriceEvidence:false,
    profitabilityProven:false,executionAuthority:"NONE",
  });
}
export function auditFourMarketHistoricalWholeUniverseV1({
  requestedTradingDaysByMarket={},dailyReceiptsByMarket={},
}={}){
  if(!object(requestedTradingDaysByMarket)||!object(dailyReceiptsByMarket))
    throw new TypeError("WHOLE_FOUR_MARKET_INPUT_INVALID");
  const results={};
  for(const market of MARKETS){
    const days=requestedTradingDaysByMarket[market];
    if(!Array.isArray(days)||!days.length||days.length>1100
       ||days.some((d,i)=>!dayValid(d)||(i>0&&d<=days[i-1]))){
      results[market]={
        ...blocked(market,"HISTORICAL_TRADING_SESSION_CALENDAR_NOT_CONNECTED"),
        requestedTradingDays:null,sourceAttestedPriceJoinedDays:0,days:[],
      };
      continue;
    }
    const receipts=dailyReceiptsByMarket[market];
    const input=object(receipts)?receipts:{};
    const dayResults=days.map(dayStartMs=>{
      const item=input[String(dayStartMs)];
      return auditWholeVenuePITDailyCoverageV1({
        market,dayStartMs,
        manifest:item?.manifest??null,dailySource:item?.dailySource??null,
      });
    });
    const covered=dayResults.filter(r=>r.sourceAttestedFullSymbolDayPriceJoin).length;
    results[market]={
      ...blocked(market,covered===days.length?
        "SOURCE_ATTESTED_NOT_INDEPENDENTLY_AUTHENTICATED":
        "SOME_HISTORIC_TRADING_SESSIONS_OR_NAMES_UNVERIFIED"),
      requestedTradingDays:days.length,sourceAttestedPriceJoinedDays:covered,
      blockedOrIncompleteDays:days.length-covered,
      days:dayResults.map(r=>({
        dateUtc:new Date(r.dayStartMs??0).toISOString().slice(0,10),
        status:r.status,reason:r.reason,
        sourceAttestedActiveMembers:r.sourceAttestedHistoricalActiveSymbols,
        sourceAttestedDailyBars:r.sourceAttestedDailyBars,
        missingDailyBars:r.missingDailyBarCount,
        missingSymbolsPreview:r.missingDailyBarSymbolsPreview,
      })),
    };
  }
  return Object.freeze({
    schemaVersion:"four-market-whole-historical-pit-price-coverage-v1",
    scope:"ALL_HISTORIC_SYMBOLS_NOT_SIX_SELECTED_ALTS",
    markets:results,allMarketsSourceAttestedPriceJoined:
      MARKETS.every(m=>results[m].requestedTradingDays!=null
        &&results[m].sourceAttestedPriceJoinedDays===results[m].requestedTradingDays),
    historicalFullMarketOpportunityDenominatorVerified:false,
    historicalScannerRecall:null,actualFillCount:null,
    trueMarketWideRecall:null,netProfitPct:null,OOSPassCount:0,
    profitabilityProven:false,executionAuthority:"NONE",
    liveTrading:false,autoTrading:false,realOrders:false,
  });
}
