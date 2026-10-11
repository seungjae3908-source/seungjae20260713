import { createHash } from "node:crypto";
import {
  resolveSelectedResearchWindowV1, UTC_DAY_MS_V1 as DAY,
} from "./research-selected-window-v1.js";

/**
 * One already-audited whole-PIT day -> compact immutable-receipt-style record
 * -> selected-period inventory. NO reloading 20-symbol raw receipt pages at
 * period report time. This removes the 256 page/chunk aggregation bottleneck
 * for a historical venue with >5,120 active stocks.
 *
 * SHA-256 is LOCAL ACCIDENTAL-TAMPER DETECTION, not a digital signature,
 * trusted publisher, official trading calendar or external PIT attestation.
 * A recap cannot certify scanner-time availability, fills, or OOS profits.
 */
const VENUES=Object.freeze({
  KR_STOCK:"KRX", US_STOCK:"US_SIP",
  CRYPTO_SPOT:"UPBIT_KRW", CRYPTO_FUTURES:"BITGET_USDT_FUTURES",
});
const STOCKS=new Set(["KR_STOCK","US_STOCK"]);
const SHA=/^[a-f0-9]{64}$/u;
const DAY_DATE=/^\d{4}-\d{2}-\d{2}$/u;
const COUNT_KEYS=Object.freeze([
  "archivedMembers","missingSourceMembers","sourceLimitedMembers",
  "revisedSourceMembers","unreadableMembers","lifecycleBlockedMembers",
  "sourceMinuteRows","sourceSessionsCovered","retrospectiveSourceMembers",
  "retrospectiveMinuteRows","missingSourceSessionCount",
]);
const STATUSES=new Set([
  "INCOMPLETE_SOURCE_ATTESTED_DAY_MINUTE_INVENTORY",
  "SOURCE_ATTESTED_DAY_MINUTE_INVENTORY_ONLY",
]);
const UINT=x=>Number.isSafeInteger(x)&&x>=0;
const HASH=x=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
const utc=x=>new Date(x).toISOString().slice(0,10);
const own=(obj,key)=>Object.prototype.hasOwnProperty.call(obj,key);
const fail=(why)=>{throw new TypeError(why);};
const safe=fields=>Object.freeze({
  schemaVersion:"four-market-pit-minute-compact-selected-window-v1",
  ...fields,sourceInventoryOnly:true,sourceReadinessOnly:true,
  compactDayReceiptSelfChecksumNotTrustedSignature:true,
  historicalPITUniverseIndependentlyAuthenticated:false,
  historicalOneMinuteSourceIndependentlyAuthenticated:false,
  officialStockSessionsIndependentlyVerified:false,
  originalScannerAsOfAvailabilityVerified:false,
  fullMarketOpportunityDenominatorVerified:false,
  actualMarketWideOpportunityCount:null,trueMarketWideRecall:null,
  actualFillCount:null,netProfitPct:null,OOSPassCount:0,
  profitabilityProven:false,executionAuthority:"NONE",
  liveTrading:false,autoTrading:false,realOrders:false,
  privateAccountAPIAllowed:false,
});
const blocked=(market,period,first,end,reason,more={})=>safe({
  status:"BLOCKED_DATA",reason,market,venue:VENUES[market],
  selectedResearchStartDate:period.startDate,
  selectedResearchEndDate:period.endDate,
  inspectedStartDate:utc(first),inspectedEndDate:utc(end-DAY),
  nextCursorDate:end<period.endExclusiveMs?utc(end):null,
  completeDateReceiptInventory:false,
  locallyCompleteMinuteSourceDays:null,
  missingSourceDays:null,sourceMinuteRows:null,...more,
});
function parseDay(x){
  if(typeof x!=="string"||!DAY_DATE.test(x))
    fail("PIT_COMPACT_EXPLICIT_DATE_INVALID");
  const ms=Date.parse(x+"T00:00:00.000Z");
  if(!Number.isSafeInteger(ms)||utc(ms)!==x)
    fail("PIT_COMPACT_EXPLICIT_DATE_INVALID");
  return ms;
}
function countCoherence(x){
  if(COUNT_KEYS.some(k=>!UINT(x?.[k])))return false;
  if(!UINT(x.inspectedPITMemberCount)||x.inspectedPITMemberCount<1
    ||!UINT(x.archiveReceiptPageCount)
    ||x.archiveReceiptPageCount<1||x.archiveReceiptPageCount>2500
    ||x.archiveReceiptPageCount*20<x.inspectedPITMemberCount
    ||x.archiveReceiptPageCount> x.inspectedPITMemberCount
    ||x.missingSourceMembers>x.inspectedPITMemberCount
    ||x.archivedMembers>x.inspectedPITMemberCount
    ||x.sourceLimitedMembers>x.archivedMembers
    ||x.revisedSourceMembers>x.inspectedPITMemberCount
    ||x.unreadableMembers>x.inspectedPITMemberCount
    ||x.lifecycleBlockedMembers>x.inspectedPITMemberCount
    ||x.retrospectiveSourceMembers>x.archivedMembers
    ||x.retrospectiveMinuteRows>x.sourceMinuteRows
    ||x.sourceMinuteRows>x.sourceSessionsCovered*1440
    ||x.sourceSessionsCovered>x.inspectedPITMemberCount*16
    ||x.missingSourceSessionCount>x.missingSourceMembers*16
    ||x.missingSourceMembers+x.lifecycleBlockedMembers
      +x.unreadableMembers+x.revisedSourceMembers>x.inspectedPITMemberCount*4)
    return false;
  const unresolved=x.missingSourceMembers+x.sourceLimitedMembers
    +x.revisedSourceMembers+x.unreadableMembers
    +x.lifecycleBlockedMembers;
  if((x.status==="SOURCE_ATTESTED_DAY_MINUTE_INVENTORY_ONLY")
      !==(unresolved===0)
    ||x.localArchiveRowsPresentForEverySelectedPITMember!==(unresolved===0))
    return false;
  return true;
}
function checkDaySummary(summary,manifest){
  if(!summary||typeof summary!=="object"||Array.isArray(summary)
    ||!manifest||typeof manifest!=="object"||Array.isArray(manifest)
    ||!own(VENUES,summary.market)
    ||summary.venue!==VENUES[summary.market]
    ||!STATUSES.has(summary.status)
    ||!countCoherence(summary)
    ||summary.completeDayPageAudit!==true
    ||summary.pitRosterDigestSha256!==manifest.rawMembershipDigestSha256
    ||summary.pitRosterSourceId!==manifest.sourceId
    ||summary.sourceStatus!==(manifest.sourceClass==="TEST_FIXTURE"
      ?"TEST_FIXTURE_ONLY":"SOURCE_ATTESTED_ONLY")
    ||summary.pitGateStatus!==(manifest.sourceClass==="TEST_FIXTURE"
      ?"TEST_FIXTURE_ONLY":"SOURCE_ATTESTED_PIT_COHORT_ONLY")
    ||!SHA.test(summary.pitRosterDigestSha256??"")
    ||!SHA.test(summary.sessionCalendarDigestSha256??"")
    ||!SHA.test(summary.pageReceiptDigestsSha256??"")
    ||summary.historicallyDelistedMembersPreservedInManifest!==true
    ||summary.checkedArchiveSourcesOnly!==true
    ||summary.fullMarketOpportunityDenominatorVerified!==false
    ||summary.profitabilityProven!==false
    ||summary.executionAuthority!=="NONE"
    ||summary.trueMarketWideRecall!==null
    ||summary.actualFillCount!==null
    ||summary.liveTrading!==false||summary.autoTrading!==false
    ||summary.realOrders!==false
    ||summary.stockCalendarIndependentlyAuthenticated!==false
    ||summary.retrospectiveMinutesAreNotAsOfScannerEvidence!==true
    ||!UINT(manifest.coverageStartMs)||!UINT(manifest.coverageEndMs)
    ||manifest.coverageEndMs<=manifest.coverageStartMs
    ||typeof manifest.sourceClass!=="string"
    ||typeof manifest.sourceId!=="string"||!manifest.sourceId
    ||typeof summary.tradingDate!=="string"
    ||!DAY_DATE.test(summary.tradingDate))
    fail("PIT_COMPACT_ORIGINAL_DAY_NOT_ACCEPTABLE");
  parseDay(summary.tradingDate);
  if(summary.dateBasis!==(STOCKS.has(summary.market)
      ?"EXCHANGE_LOCAL_TRADING_DATE":"UTC_CRYPTO_DAY"))
    fail("PIT_COMPACT_ORIGINAL_DATE_BASIS_INVALID");
}
/**
 * Seal a strict day ledger output from the existing per-20-member PIT audit.
 * The whole day MUST have already passed the existing per-page ledger gate.
 */
export function sealPITMinuteDayCompactReceiptV1({summary,manifest}={}){
  checkDaySummary(summary,manifest);
  const rows=Object.fromEntries(COUNT_KEYS.map(k=>[k,summary[k]]));
  const plain={
    schemaVersion:"four-market-pit-minute-compact-day-receipt-v1",
    market:summary.market,venue:summary.venue,
    tradingDate:summary.tradingDate,dateBasis:summary.dateBasis,
    status:summary.status,reason:summary.reason,
    sourceStatus:summary.sourceStatus,sourceClass:manifest.sourceClass,
    sourceId:manifest.sourceId,
    pitRosterDigestSha256:summary.pitRosterDigestSha256,
    sessionCalendarDigestSha256:summary.sessionCalendarDigestSha256,
    pageReceiptDigestsSha256:summary.pageReceiptDigestsSha256,
    originalDaySummarySha256:HASH(summary),
    archiveCoverageStartMs:manifest.coverageStartMs,
    archiveCoverageEndMs:manifest.coverageEndMs,
    inspectedPITMemberCount:summary.inspectedPITMemberCount,
    archiveReceiptPageCount:summary.archiveReceiptPageCount,
    localArchiveRowsPresentForEverySelectedPITMember:
      summary.localArchiveRowsPresentForEverySelectedPITMember,
    ...rows,
    originalDayPagesWereValidated:true,
    originalHistoricalScannerAsOfAvailabilityVerified:false,
    historicalAllSymbolPITIndependentlyVerified:false,
    independentVendorLicenseAndRedistributionVerified:false,
    historicalFullMarketOpportunityDenominatorVerified:false,
    actualMarketWideOpportunityCount:null,trueMarketWideRecall:null,
    profitabilityProven:false,actualFillCount:null,executionAuthority:"NONE",
    liveTrading:false,autoTrading:false,realOrders:false,
  };
  return Object.freeze({...plain,receiptSha256:HASH(plain)});
}
function verifyCompactDay(r,market){
  if(!r||typeof r!=="object"||Array.isArray(r)
    ||r.schemaVersion!=="four-market-pit-minute-compact-day-receipt-v1"
    ||r.market!==market||r.venue!==VENUES[market]
    ||!DAY_DATE.test(r.tradingDate??"")
    ||!STATUSES.has(r.status)||!countCoherence(r)
    ||r.sourceStatus!==(r.sourceClass==="TEST_FIXTURE"
      ?"TEST_FIXTURE_ONLY":"SOURCE_ATTESTED_ONLY")
    ||typeof r.sourceClass!=="string"||!r.sourceClass
    ||typeof r.sourceId!=="string"||!r.sourceId
    ||r.dateBasis!==(STOCKS.has(market)
      ?"EXCHANGE_LOCAL_TRADING_DATE":"UTC_CRYPTO_DAY")
    ||!SHA.test(r.pitRosterDigestSha256??"")
    ||!SHA.test(r.sessionCalendarDigestSha256??"")
    ||!SHA.test(r.pageReceiptDigestsSha256??"")
    ||!SHA.test(r.originalDaySummarySha256??"")
    ||!SHA.test(r.receiptSha256??"")
    ||!UINT(r.archiveCoverageStartMs)||!UINT(r.archiveCoverageEndMs)
    ||r.archiveCoverageEndMs<=r.archiveCoverageStartMs
    ||r.originalDayPagesWereValidated!==true
    ||r.originalHistoricalScannerAsOfAvailabilityVerified!==false
    ||r.historicalAllSymbolPITIndependentlyVerified!==false
    ||r.independentVendorLicenseAndRedistributionVerified!==false
    ||r.historicalFullMarketOpportunityDenominatorVerified!==false
    ||r.actualMarketWideOpportunityCount!==null
    ||r.trueMarketWideRecall!==null||r.actualFillCount!==null
    ||r.profitabilityProven!==false||r.executionAuthority!=="NONE"
    ||r.liveTrading!==false||r.autoTrading!==false
    ||r.realOrders!==false)
    return false;
  const {receiptSha256,...unsigned}=r;
  const fields=Object.keys(sealShapeForValidation(r));
  if(Object.keys(r).length!==fields.length
    ||fields.some(k=>!own(r,k))
    ||Object.keys(r).some(k=>!fields.includes(k))) return false;
  return HASH(unsigned)===receiptSha256;
}
function sealShapeForValidation(r){
  // Exact keys; no "model PASS" or materialized price rows can be smuggled
  // into a compact-day report.
  const base=[
    "schemaVersion","market","venue","tradingDate","dateBasis",
    "status","reason","sourceStatus","sourceClass","sourceId",
    "pitRosterDigestSha256","sessionCalendarDigestSha256",
    "pageReceiptDigestsSha256","originalDaySummarySha256",
    "archiveCoverageStartMs","archiveCoverageEndMs",
    "inspectedPITMemberCount","archiveReceiptPageCount",
    "localArchiveRowsPresentForEverySelectedPITMember",
    ...COUNT_KEYS,"originalDayPagesWereValidated",
    "originalHistoricalScannerAsOfAvailabilityVerified",
    "historicalAllSymbolPITIndependentlyVerified",
    "independentVendorLicenseAndRedistributionVerified",
    "historicalFullMarketOpportunityDenominatorVerified",
    "actualMarketWideOpportunityCount","trueMarketWideRecall",
    "profitabilityProven","actualFillCount","executionAuthority",
    "liveTrading","autoTrading","realOrders","receiptSha256",
  ];
  return Object.fromEntries(base.map(k=>[k,r[k]]));
}
function tradingDatesForChunk(market,w,start,end,stockTradingDates){
  if(!STOCKS.has(market)){
    if(stockTradingDates!=null)
      fail("PIT_COMPACT_CRYPTO_STOCK_DATES_FORBIDDEN");
    return Array.from({length:(end-start)/DAY},(_,i)=>utc(start+i*DAY));
  }
  if(stockTradingDates==null) return null;
  if(!Array.isArray(stockTradingDates)||stockTradingDates.length>36600)
    fail("PIT_COMPACT_STOCK_DATES_INVALID");
  let before=0;
  for(const date of stockTradingDates){
    const ms=parseDay(date);
    // The server keeps ONE archive of exchange-local trading dates for
    // many years, rather than constructing a new calendar per HTTP query.
    // Validate the entire supplied list for sorted unique dates, but only
    // consume the selected request chunk. Missing dates remain unknown.
    if(ms<=before)
      fail("PIT_COMPACT_STOCK_DATES_INVALID");
    before=ms;
  }
  return stockTradingDates.filter(date=>
    date>=utc(start)&&date<utc(end)
    &&date>=w.startDate&&date<=w.endDate);
}
/**
 * A range may span 1..36,600 selected days; process at most 31 dates per
 * call. Each day report is tiny even if its source inventory had >256 pages.
 */
export function auditCompactPITMinuteSelectedWindowChunkV1({
  market,researchWindow,cursorDate=null,chunkCalendarDays=7,
  stockTradingDates=null,dayReceipts=[],
}={}){
  if(!own(VENUES,market)||!researchWindow
    ||!Number.isSafeInteger(chunkCalendarDays)
    ||chunkCalendarDays<1||chunkCalendarDays>31
    ||!Array.isArray(dayReceipts)||dayReceipts.length>31)
    fail("PIT_COMPACT_SELECTED_WINDOW_SCOPE_INVALID");
  const w=resolveSelectedResearchWindowV1(researchWindow);
  const start=cursorDate==null?w.startMs:parseDay(cursorDate);
  if(start<w.startMs||start>=w.endExclusiveMs)
    fail("PIT_COMPACT_WINDOW_CURSOR_OUTSIDE_SELECTED_RANGE");
  const end=Math.min(w.endExclusiveMs,start+chunkCalendarDays*DAY);
  const next=end<w.endExclusiveMs?utc(end):null;
  const expected=tradingDatesForChunk(market,w,start,end,stockTradingDates);
  if(expected==null||expected.length===0)
    return blocked(market,w,start,end,"STOCK_EXCHANGE_LOCAL_DATES_NOT_CONNECTED_OR_EMPTY",{
      expectedHistoricalTradingDays:null,
    });
  const target=new Set(expected),receipts=new Map();
  for(const receipt of dayReceipts){
    if(!verifyCompactDay(receipt,market)
      ||!target.has(receipt.tradingDate)
      ||receipts.has(receipt.tradingDate))
      return blocked(market,w,start,end,
        "COMPACT_DAY_RECEIPT_DUPLICATE_WRONG_DATE_OR_TAMPERED");
    receipts.set(receipt.tradingDate,receipt);
  }
  const total=Object.fromEntries(COUNT_KEYS.map(k=>[k,0]));
  const daily=[],monthly=Object.create(null),reasons=Object.create(null);
  const preview=[],digestChain=[],lineage=new Set();
  let missing=0,partial=0,completeLocal=0,fixture=0;
  let sourceOnly=0,sourceSpanShort=0,retrospectiveDays=0;
  for(const date of expected){
    const m=date.slice(0,7),bucket=monthly[m]??={
      expectedTradingDays:0,missingSourceDays:0,partialSourceDays:0,
      locallyCompleteDays:0,fixtureDays:0,retrospectiveDays:0,
      originalMinuteRows:0,
    };
    bucket.expectedTradingDays++;
    const rec=receipts.get(date);
    if(!rec){
      missing++;bucket.missingSourceDays++;
      reasons.MISSING_COMPACT_PIT_MINUTE_DAY_RECEIPT=
        (reasons.MISSING_COMPACT_PIT_MINUTE_DAY_RECEIPT??0)+1;
      if(preview.length<30)preview.push({date,
        reason:"MISSING_COMPACT_PIT_MINUTE_DAY_RECEIPT"});
      daily.push({date,status:"BLOCKED_DATA",
        reason:"MISSING_COMPACT_PIT_MINUTE_DAY_RECEIPT",
        historicalMemberCount:null,originalMinuteRows:null,
        missingSourceSessions:null});
      continue;
    }
    if(rec.sourceStatus==="TEST_FIXTURE_ONLY"){
      fixture++;bucket.fixtureDays++;
    }else sourceOnly++;
    if(rec.retrospectiveMinuteRows>0){
      retrospectiveDays++;bucket.retrospectiveDays++;
    }
    if(rec.archiveCoverageStartMs>w.startMs
      ||rec.archiveCoverageEndMs<w.endExclusiveMs)sourceSpanShort++;
    lineage.add(JSON.stringify([rec.pitRosterDigestSha256,
      rec.sourceClass,rec.sourceId]));
    for(const key of COUNT_KEYS)total[key]+=rec[key];
    bucket.originalMinuteRows+=rec.sourceMinuteRows;
    const complete=rec.status==="SOURCE_ATTESTED_DAY_MINUTE_INVENTORY_ONLY"
      &&rec.localArchiveRowsPresentForEverySelectedPITMember===true;
    if(complete){
      completeLocal++;bucket.locallyCompleteDays++;
    }else{
      partial++;bucket.partialSourceDays++;
      reasons.PARTIAL_PIT_OR_ORIGINAL_MINUTE_SOURCE=
        (reasons.PARTIAL_PIT_OR_ORIGINAL_MINUTE_SOURCE??0)+1;
      if(preview.length<30)preview.push({date,
        reason:"PARTIAL_PIT_OR_ORIGINAL_MINUTE_SOURCE"});
    }
    digestChain.push(rec.receiptSha256);
    daily.push({
      date,status:rec.status,sourceClass:rec.sourceClass,
      historicalMemberCount:rec.inspectedPITMemberCount,
      originalMinuteRows:rec.sourceMinuteRows,
      missingSourceSessions:rec.missingSourceSessionCount,
      retrospectiveMinuteRows:rec.retrospectiveMinuteRows,
      localOriginalMinuteRowsComplete:complete,
      historicalScannerAsOfEvidenceVerified:false,
    });
  }
  const allFull=completeLocal===expected.length;
  const stable=lineage.size===1 && missing===0;
  const ownSpan=sourceSpanShort===0 && missing===0;
  const status=(missing||partial)
    ?"INCOMPLETE_OR_BLOCKED_COMPACT_PIT_MINUTE_DATE_CHUNK"
    :fixture?"TEST_FIXTURE_COMPACT_SOURCE_CHUNK_ONLY"
    :!stable||!ownSpan?"SOURCE_LINEAGE_OR_SELECTED_SPAN_UNATTESTED"
    :"SOURCE_ATTESTED_COMPACT_MINUTE_SOURCE_CHUNK_ONLY";
  const reason=missing?"MISSING_HISTORICAL_MINUTE_DATE_RECEIPT"
    :partial?"INCOMPLETE_ORIGINAL_MINUTE_SOURCE_DAYS"
    :fixture?"FIXTURE_NOT_INDEPENDENT_HISTORICAL_SOURCE"
    :!stable?"PIT_MEMBERSHIP_SOURCE_LINEAGE_CHANGED"
    :!ownSpan?"HISTORICAL_ROSTER_ARCHIVE_SPAN_TOO_SHORT"
    :"COMPACT_INVENTORY_ONLY_NOT_HISTORICAL_SCANNER_EVIDENCE";
  return safe({
    status,reason,market,venue:VENUES[market],
    dateBasis:STOCKS.has(market)
      ?"EXCHANGE_LOCAL_TRADING_DATE":"UTC_CRYPTO_DAY",
    selectedResearchStartDate:w.startDate,
    selectedResearchEndDate:w.endDate,
    selectedResearchCalendarDays:w.requestedUtcDayCount,
    inspectedStartDate:utc(start),inspectedEndDate:utc(end-DAY),
    maximumCalendarDatesPerChunk:31,
    loadedSourcePageReceiptsAtPeriodLevel:0,
    checkedCompactDayReceipts:receipts.size,
    sourceDayReceiptDigestChainSha256:HASH(digestChain),
    nextCursorDate:next,expectedHistoricalTradingDays:expected.length,
    missingSourceDays:missing,partialSourceDays:partial,
    locallyCompleteMinuteSourceDays:completeLocal,
    sourceOnlyDayCount:sourceOnly,fixtureDayCount:fixture,
    retrospectiveSourceDayCount:retrospectiveDays,
    completeDateReceiptInventory:missing===0,
    localOriginalMinuteInventoryCompleteForCheckedDates:allFull,
    sourceLineageConsistentForCheckedDates:stable,
    selfAttestedHistoricalRosterSpansWholeSelectedWindow:ownSpan,
    monthlyCoverage:Object.fromEntries(Object.entries(monthly)),
    dailyReadiness:daily,previewIncompleteDates:preview,
    blockedReasonCounts:reasons,
    ...total,
    originalScannerAsOfEvidenceVerified:false,
    externalMarketWidePITAndPriceSourceNotProven:true,
  });
}
