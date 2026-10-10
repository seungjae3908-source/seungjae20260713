import {createHash} from "node:crypto";
import {collectKrxDatedRosterV1} from "./krx-dated-roster-public-read-v1.js";
import {auditKrxDatedRosterTimelineV1} from "./krx-dated-roster-timeline-v1.js";

/**
 * Bounded KRX dated securities-source intake.
 *
 * Sequential, read-only authorized market-data requests are possible ONLY
 * when a caller explicitly passes a KRX market-data AUTH_KEY. This module
 * NEVER reads process.env, stores a key, calls private broker/order APIs,
 * changes production configuration, or claims a live scan existed in 2025.
 * A supplied array of dates is NOT independently authenticated as a market
 * trading calendar. A missing date blocks transitions across the gap.
 */
export const KRX_ARCHIVE_BATCH_POLICY_V1=Object.freeze({
  maxDates:6,maxMarketBoards:3,maxPublicMarketDataRequests:18,
  minRequestGapMs:150,
  supportedMarkets:Object.freeze(["KOSPI","KOSDAQ","KONEX"]),
});
const VALID_DATE=/^\d{8}$/;
function dateOk(s) {
  if(typeof s!=="string"||!VALID_DATE.test(s)||s<"20130701")return false;
  const year=+s.slice(0,4),month=+s.slice(4,6),day=+s.slice(6,8);
  const d=new Date(Date.UTC(year,month-1,day));
  return !Number.isNaN(d.getTime())
    &&d.toISOString().slice(0,10).replace(/-/g,"")===s;
}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function immutableReceipt({requestedDates,receipts,failures,timeline,requests,sourceStatus}){
  const summaryDigests=receipts.map(row=>({
    dateYmd:row.dateYmd,sourceSha256:row.sourceSha256,
    dateScopedSymbolCount:row.dateScopedSymbolCount,
  }));
  const digest=createHash("sha256")
    .update(JSON.stringify({requestedDates,summaryDigests,failures})).digest("hex");
  return Object.freeze({
    schemaVersion:"krx-readonly-bounded-archive-batch-v1",
    status:sourceStatus,requestedTradingDates:Object.freeze([...requestedDates]),
    requestedDatesAreIndependentlyAuthenticatedTradingCalendar:false,
    source:"KRX_OPENAPI_ISSUE_BASE_INFO",
    sourceKeyInMemoryOnly:true,sourceKeyPersisted:false,
    marketDataGETOnly:true,requestsPerformed:requests,
    requestedMarketDataCallCap:KRX_ARCHIVE_BATCH_POLICY_V1.maxPublicMarketDataRequests,
    sourceDayReceipts:Object.freeze(receipts),
    blockedDateReceipts:Object.freeze(failures),
    observedDateCount:receipts.length,
    missingDateCount:timeline.missingRequestedDates?.length??null,
    sourceReceiptsSha256:digest,
    historicalIdentityTimeline:timeline,
    delistedHistoryVerified:false,
    independentlyVerifiedFullMarketPIT:false,
    fullMarketOpportunityDenominatorVerified:false,
    trueMarketWideRecall:null,
    originalHistoricalScannerCoverageVerified:false,
    realFillCount:null,netProfitPct:null,OOSPassCount:0,
    profitabilityProven:false,executionAuthority:"NONE",
    liveTrading:false,autoTrading:false,realOrders:false,
    privateProviderTradeApi:false,
  });
}
export async function collectKrxDatedRosterBatchV1({
  requestedTradingDates=[],authKey=null,
  fetchImpl=globalThis.fetch,
  sleepImpl=delay,
  minIntervalMs=KRX_ARCHIVE_BATCH_POLICY_V1.minRequestGapMs,
  boards=["KOSPI","KOSDAQ","KONEX"],
}={}){
  if(!Array.isArray(requestedTradingDates)
    ||requestedTradingDates.length<2
    ||requestedTradingDates.length>KRX_ARCHIVE_BATCH_POLICY_V1.maxDates
    ||requestedTradingDates.some((d,i)=>
      !dateOk(d)||(i>0&&d<=requestedTradingDates[i-1])))
    throw new TypeError("KRX_BATCH_DATE_RANGE_INVALID");
  if(!Array.isArray(boards)||boards.length!==3
    ||new Set(boards).size!==3
    ||boards.some(b=>!KRX_ARCHIVE_BATCH_POLICY_V1.supportedMarkets.includes(b)))
    throw new TypeError("KRX_BATCH_MARKETS_REQUIRE_ALL_THREE");
  if(typeof fetchImpl!=="function"||typeof sleepImpl!=="function"
    ||!Number.isInteger(minIntervalMs)||minIntervalMs<150||minIntervalMs>2000)
    throw new TypeError("KRX_BATCH_PUBLIC_IO_POLICY_INVALID");
  const requestedDates=Object.freeze([...requestedTradingDates]);
  const callsBudget=requestedDates.length*boards.length;
  if(callsBudget>KRX_ARCHIVE_BATCH_POLICY_V1.maxPublicMarketDataRequests)
    throw new TypeError("KRX_BATCH_SOURCE_REQUEST_BUDGET_EXCEEDED");
  if(typeof authKey!=="string"||!authKey.trim()){
    const timeline=auditKrxDatedRosterTimelineV1({
      requestedTradingDates:requestedDates,datedReceipts:[],
    });
    return immutableReceipt({
      requestedDates,receipts:[],failures:[],timeline,requests:0,
      sourceStatus:"BLOCKED_MARKET_DATA_ENTITLEMENT",
    });
  }
  if(authKey.length>256)throw new TypeError("KRX_BATCH_AUTH_KEY_LENGTH_INVALID");
  const receipts=[],failures=[];
  let requests=0;
  // Source accessor receives a wrapper to enforce a global 18-call ceiling
  // and minimum interval even when one date fails partway through.
  const safeFetch=async(url,opts)=>{
    if(requests>=KRX_ARCHIVE_BATCH_POLICY_V1.maxPublicMarketDataRequests)
      throw new Error("KRX_BATCH_SOURCE_CALL_CAP_REACHED");
    if(requests>0)await sleepImpl(minIntervalMs);
    requests++;
    return fetchImpl(url,opts);
  };
  for(const day of requestedDates){
    const report=await collectKrxDatedRosterV1({
      dateYmd:day,boards,authKey,fetchImpl:safeFetch,
    });
    if(report.status==="OBSERVED_KRX_DAY_ROSTER_ONLY"){
      receipts.push(report);
    }else{
      failures.push(Object.freeze({
        dateYmd:day,status:"BLOCKED_DATA",reason:report.reason,
        // No auth key or original network error details in retained output.
        publicMarketDataOnly:true,
      }));
    }
  }
  const timeline=auditKrxDatedRosterTimelineV1({
    requestedTradingDates:requestedDates,datedReceipts:receipts,
  });
  return immutableReceipt({
    requestedDates,receipts,failures,timeline,requests,
    sourceStatus:timeline.status==="OBSERVED_REQUESTED_DATES_ONLY"
      ?"SOURCE_LIMITED_DATED_SNAPSHOTS_ONLY"
      :"PARTIAL_DATED_SNAPSHOTS_BLOCKED",
  });
}
