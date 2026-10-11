import {createHash} from "node:crypto";
import {
 auditWholeVenuePITDailyCoverageV1,
 FOUR_MARKET_WHOLE_SCOPE_V1,
} from "./four-market-whole-pit-price-coverage-v1.js";
import {
 isValidHistoricalUtcDayV1,
 resolveSelectedResearchWindowV1,
 RESEARCH_WINDOW_MAX_UTC_DAYS_V1,
} from "./research-selected-window-v1.js";

/**
 * Bounded inventory of ALREADY audited date-native PIT+OHLC sources. The
 * existing PIT coverage gate remains the only day-level source of truth.
 *
 * One private daily original source is processed, and its compact receipt
 * can be indexed without ever loading three years of OHLC into one JSON.
 * Receipts are hashes for local integrity, NEVER independent exchange
 * authentication, a contemporaneous scanner log, first-crossing, fills,
 * cost-adjusted profitability or actual whole-market opportunity counts.
 */
const DAY=86_400_000, SHA=/^[0-9a-f]{64}$/;
const VENUES=FOUR_MARKET_WHOLE_SCOPE_V1;
const own=(x,k)=>Object.prototype.hasOwnProperty.call(x,k);
const obj=x=>x!=null&&typeof x==="object"&&!Array.isArray(x);
const hash=x=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
const day=isValidHistoricalUtcDayV1;
const crypto=x=>x==="CRYPTO_SPOT"||x==="CRYPTO_FUTURES";

function safety(data={}){
 return {
  actualMarketWideOpportunityCount:null,
  trueMarketWideRecall:null,
  originalHistoricalScannerRecall:null,
  actualFillCount:null,netProfitPct:null,OOSPassCount:0,
  fullMarketOpportunityDenominatorVerified:false,
  historicalFullMarketOpportunityDenominatorVerified:false,
  sourceIndependentlyAuthenticated:false,profitabilityProven:false,
  executionAuthority:"NONE",liveTrading:false,autoTrading:false,
  realOrders:false,...data,
 };
}
function digestFields(receipt){
 const {receiptSha256,...unsigned}=receipt;
 return hash(unsigned);
}
export function auditOnePITDayIntoCompactReceiptV1({
 market,dayStartMs,manifest=null,dailySource=null,
}={}){
 if(!own(VENUES,market)||!day(dayStartMs))
   throw new TypeError("PIT_LEDGER_DAY_SCOPE_INVALID");
 const audited=auditWholeVenuePITDailyCoverageV1({
  market,dayStartMs,manifest,dailySource,
 });
 const fixture=audited.status==="TEST_FIXTURE_FULL_NAME_DAILY_JOIN_ONLY";
 const sourceAttested=audited.status==="SOURCE_ATTESTED_FULL_NAME_DAILY_JOIN_ONLY";
 const successful=fixture||sourceAttested;
 const raw=safety({
  schemaVersion:"four-market-compact-pit-day-receipt-v1",
  market,venue:VENUES[market].venue,
  dayStartMs,dayEndMs:dayStartMs+DAY,
  status:successful
   ?(fixture?"TEST_FIXTURE_PIT_PRICE_JOIN_ONLY":"SOURCE_ATTESTED_PIT_PRICE_JOIN_ONLY")
   :"BLOCKED_DATA",
  reason:audited.reason,
  underlyingDayGateStatus:audited.status,
  sourceAttestedFullSymbolDayPriceJoin:successful,
  sourceActiveSymbols:audited.sourceAttestedHistoricalActiveSymbols??null,
  sourceDailyPriceRows:audited.sourceAttestedDailyBars??null,
  missingDailyPriceRows:audited.missingDailyBarCount??null,
  sourceClass:successful?manifest.sourceClass:null,
  archiveSourceId:successful?manifest.sourceId:null,
  archiveMembershipSha256:successful?manifest.rawMembershipDigestSha256:null,
  archiveCoverageStartMs:successful?manifest.coverageStartMs:null,
  archiveCoverageEndMs:successful?manifest.coverageEndMs:null,
  dailySourceRowsSha256:successful?dailySource.rowsSha256:null,
  sourceFileNotRepublished:true,
  independentHistoricalPITAndDelistingsVerified:false,
  originalAsOfScannerLogVerified:false,
 });
 return Object.freeze({...raw,receiptSha256:hash(raw)});
}

export function auditCompactPITReceiptLedgerV1({
 market,dayReceipts=[],expectedStockDays=null,researchWindow=null,
}={}){
 if(!own(VENUES,market)||!Array.isArray(dayReceipts)
    ||dayReceipts.length>RESEARCH_WINDOW_MAX_UTC_DAYS_V1)
   throw new TypeError("PIT_LEDGER_MARKET_OR_SOURCE_LIMIT_INVALID");
 const window=resolveSelectedResearchWindowV1(researchWindow);
 if(expectedStockDays!=null&&(!Array.isArray(expectedStockDays)
    ||expectedStockDays.length<1
    ||expectedStockDays.length>RESEARCH_WINDOW_MAX_UTC_DAYS_V1
    ||expectedStockDays.some((d,i)=>!day(d)
      ||d<window.startMs||d>=window.endExclusiveMs
      ||(i>0&&d<=expectedStockDays[i-1]))))
   throw new TypeError("PIT_LEDGER_STOCK_CALENDAR_INVALID");
 if(crypto(market)&&expectedStockDays!=null)
   throw new TypeError("PIT_LEDGER_CRYPTO_CANNOT_SUPPLY_STOCK_CALENDAR");
 const days=crypto(market)
   ?Array.from({length:window.requestedUtcDayCount},
      (_,i)=>window.startMs+i*DAY)
   :expectedStockDays;
 const base=safety({
  schemaVersion:"four-market-compact-pit-receipt-ledger-v1",
  market,venue:VENUES[market].venue,
  fixedStartUtc:window.selectedByUser?null:"2023-09-26",
  fixedEndUtcInclusive:window.selectedByUser?null:"2026-09-25",
  selectedResearchStartUtc:window.startDate,
  selectedResearchEndInclusiveUtc:window.endDate,
  selectedResearchUtcDayCount:window.requestedUtcDayCount,
  researchRangeSelectionMode:window.selectionMode,
  intendedMarketScope:VENUES[market].scope,
  stockOfficialTradingCalendarIndependentlyVerified:false,
  requestedTradingDays:days?.length??null,
  suppliedSourceReceiptCount:dayReceipts.length,
  sourceAttestedPriceJoinedDays:0,fixtureJoinedDays:0,
  missingDayReceiptCount:null,blockedDayReceiptCount:null,
  completeRequestedDayReceiptCoverage:false,
  sourceAttestedFullBenchmarkReceiptCoverage:false,
  sourceAttestedFullSelectedWindowReceiptCoverage:false,
  sourceArchiveLineageConsistent:false,
  sourceArchiveFullBenchmarkWindowCovered:false,
  sourceArchiveFullSelectedWindowCovered:false,
  dailyReceiptsAreCompactIntegrityProofOnly:true,
  sourceDailyRawOHLCAllLoadedInOneFile:false,
  sourceObservedPriceEvents:null,
  dayPreview:[],monthlyCoverage:{},blockedReasonCounts:{},
  archiveLineageCount:null,
  status:"BLOCKED_DATA",reason:"HISTORICAL_RECEIPTS_NOT_CONNECTED",
 });
 const blocked=(reason,more={})=>Object.freeze({...base,reason,...more});
 if(!days) return blocked("STOCK_OFFICIAL_HISTORICAL_TRADING_CALENDAR_NOT_CONNECTED");
 const required=new Set(days),records=new Map();
 for(const item of dayReceipts){
  if(!obj(item)||item.schemaVersion!=="four-market-compact-pit-day-receipt-v1"
     ||item.market!==market||item.venue!==VENUES[market].venue
     ||!day(item.dayStartMs)||item.dayEndMs!==item.dayStartMs+DAY
     ||!SHA.test(item.receiptSha256??"")||digestFields(item)!==item.receiptSha256
     ||!required.has(item.dayStartMs)||records.has(item.dayStartMs)
     ||item.executionAuthority!=="NONE"||item.liveTrading!==false
     ||item.autoTrading!==false||item.realOrders!==false
     ||item.profitabilityProven!==false||item.trueMarketWideRecall!==null
     ||item.actualMarketWideOpportunityCount!==null
     ||item.fullMarketOpportunityDenominatorVerified!==false){
   return blocked("LEDGER_DATE_DUPLICATE_WRONG_MARKET_OR_DIGEST_INVALID");
  }
  const accepted=new Set([
   "SOURCE_ATTESTED_PIT_PRICE_JOIN_ONLY",
   "TEST_FIXTURE_PIT_PRICE_JOIN_ONLY","BLOCKED_DATA"]);
  if(!accepted.has(item.status)
     ||item.sourceAttestedFullSymbolDayPriceJoin!==(item.status!=="BLOCKED_DATA")
     ||(item.status!=="BLOCKED_DATA"&&(
       !SHA.test(item.archiveMembershipSha256??"")
       ||!SHA.test(item.dailySourceRowsSha256??"")
       ||typeof item.archiveSourceId!=="string"||!item.archiveSourceId
       ||!Number.isSafeInteger(item.archiveCoverageStartMs)
       ||!Number.isSafeInteger(item.archiveCoverageEndMs)
       ||item.archiveCoverageEndMs<=item.archiveCoverageStartMs
       ||!Number.isSafeInteger(item.sourceActiveSymbols)
       ||item.sourceActiveSymbols<1
       ||item.sourceDailyPriceRows!==item.sourceActiveSymbols
       ||item.missingDailyPriceRows!==0
       ||(item.status==="TEST_FIXTURE_PIT_PRICE_JOIN_ONLY")
         !==(item.sourceClass==="TEST_FIXTURE")))){
   return blocked("LEDGER_SOURCE_PROVENANCE_OR_COUNTS_INVALID");
  }
  records.set(item.dayStartMs,item);
 }
 const months={},reasons={},preview=[],sources=new Set(),joined=new Set();
 let fixtureCount=0,sourceCount=0,missingCount=0,blockedCount=0,fullSpan=true;
 for(const d of days){
  const id=new Date(d).toISOString().slice(0,10);
  const month=id.slice(0,7);
  const bucket=months[month]??={requestedDays:0,
   sourceAttestedPriceJoinedDays:0,fixtureJoinedDays:0,
   missingDays:0,blockedDays:0};
  bucket.requestedDays++;
  const rec=records.get(d);
  if(!rec){
   missingCount++;bucket.missingDays++;
   reasons.MISSING_COMPACT_DAY_RECEIPT=(reasons.MISSING_COMPACT_DAY_RECEIPT??0)+1;
   if(preview.length<16)preview.push({dateUtc:id,reason:"MISSING_COMPACT_DAY_RECEIPT"});
   continue;
  }
  if(rec.status==="SOURCE_ATTESTED_PIT_PRICE_JOIN_ONLY"){
   sourceCount++;bucket.sourceAttestedPriceJoinedDays++;
  }else if(rec.status==="TEST_FIXTURE_PIT_PRICE_JOIN_ONLY"){
   fixtureCount++;bucket.fixtureJoinedDays++;
  }else{
   blockedCount++;bucket.blockedDays++;
   const reason=rec.reason||"BLOCKED_ORIGINAL_DAILY_SOURCE";
   reasons[reason]=(reasons[reason]??0)+1;
   if(preview.length<16)preview.push({dateUtc:id,reason});
   continue;
  }
  const lineage=JSON.stringify([
   rec.archiveMembershipSha256,rec.archiveSourceId,rec.sourceClass]);
  sources.add(lineage);
  joined.add(rec.dailySourceRowsSha256);
  if(rec.archiveCoverageStartMs>window.startMs
     ||rec.archiveCoverageEndMs<window.endExclusiveMs)
   fullSpan=false;
 }
 const allSource=sourceCount===days.length;
 const stableLineage=sources.size===1&&sourceCount+fixtureCount>0;
 const full=crypto(market)&&allSource&&stableLineage&&fullSpan;
 const status=full?(window.selectedByUser
   ?"SOURCE_ATTESTED_COMPACT_SELECTED_WINDOW_ONLY"
   :"SOURCE_ATTESTED_COMPACT_3Y_LEDGER_ONLY"):
   "INCOMPLETE_OR_SOURCE_LIMITED_PIT_LEDGER";
 const reason=full?(window.selectedByUser
   ?"ONE_SOURCE_ATTESTED_PIT_ARCHIVE_WITH_ALL_SELECTED_DATES"
   :"ONE_SOURCE_ATTESTED_PIT_ARCHIVE_WITH_ALL_DATES"):
   !crypto(market)?"STOCK_EXCHANGE_CALENDAR_NOT_INDEPENDENTLY_VERIFIED":
   missingCount?"MISSING_HISTORICAL_DAY_RECEIPTS":
   blockedCount?"BLOCKED_DAY_SOURCES":
   fixtureCount?"TEST_FIXTURE_DAYS_CANNOT_PROVE_SOURCE":
   !stableLineage?"PIT_SOURCE_LINEAGE_CHANGED":
   !fullSpan?(window.selectedByUser
     ?"PIT_SOURCE_NOT_FULL_SELECTED_WINDOW"
     :"PIT_SOURCE_NOT_FULL_THREE_YEAR_WINDOW"):
   "INCOMPLETE_DATE_RECEIPT_COVERAGE";
 return Object.freeze(safety({
  ...base,status,reason,
  suppliedSourceReceiptCount:records.size,
  sourceAttestedPriceJoinedDays:sourceCount,fixtureJoinedDays:fixtureCount,
  missingDayReceiptCount:missingCount,blockedDayReceiptCount:blockedCount,
  completeRequestedDayReceiptCoverage:records.size===days.length,
  sourceArchiveLineageConsistent:stableLineage,
  sourceArchiveFullBenchmarkWindowCovered:fullSpan&&sources.size>0,
  sourceArchiveFullSelectedWindowCovered:fullSpan&&sources.size>0,
  sourceAttestedFullBenchmarkReceiptCoverage:full,
  sourceAttestedFullSelectedWindowReceiptCoverage:full,
  archiveLineageCount:sources.size,
  distinctDailyPriceSourceDigestCount:joined.size,
  dayPreview:preview,monthlyCoverage:months,blockedReasonCounts:reasons,
 }));
}
