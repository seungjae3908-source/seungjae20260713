import { createHash } from "node:crypto";
import { resolveSelectedResearchWindowV1, UTC_DAY_MS_V1 as DAY }
  from "./research-selected-window-v1.js";
import { summarizeHistoricalPITMinuteDayPagesV1 }
  from "./four-market-pit-minute-day-ledger-v1.js";

/**
 * Research-only selected date window -> bounded 1-31 calendar day PIT-native
 * minute source readiness summary. This joins the EXISTING strict one-day
 * PIT->20-symbol pages->immutable 1m ledger; it never accepts its truncated
 * 100-entry missing preview as a full historical denominator.
 *
 * Stock dates are exchange-LOCAL calendar dates supplied by the caller;
 * crypto dates are UTC. Neither self-attested stock schedules nor archived
 * retrospective minutes authenticate market-wide PIT/source coverage,
 * historical scanner alerts, real fills or cost-adjusted OOS profitability.
 */
const VENUES = Object.freeze({
  KR_STOCK: "KRX", US_STOCK: "US_SIP",
  CRYPTO_SPOT: "UPBIT_KRW", CRYPTO_FUTURES: "BITGET_USDT_FUTURES",
});
const STOCK = new Set(["KR_STOCK", "US_STOCK"]);
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const MAX_DAYS = 31;
const MAX_RECEIPT_PAGES_PER_CHUNK = 256;
const hash = rows => createHash("sha256").update(JSON.stringify(rows)).digest("hex");
const utcDay = n => new Date(n).toISOString().slice(0, 10);
const safe = value => Object.freeze({
  schemaVersion: "four-market-pit-minute-selected-window-v1",
  ...value,
  sourceReadinessOnly: true,
  originalStockExchangeCalendarIndependentlyVerified: false,
  historicalVenuePITUniverseIndependentlyVerified: false,
  sourceMinuteRowsIndependentlyAuthenticated: false,
  marketWideSourceCoverageVerified: false,
  originalHistoricalScannerAvailabilityVerified: false,
  fullMarketOpportunityDenominatorVerified: false,
  actualMarketWideOpportunityCount: null,
  trueMarketWideRecall: null, actualFillCount: null, netProfitPct: null,
  OOSPassCount: 0, profitabilityProven: false,
  executionAuthority: "NONE", liveTrading: false,
  autoTrading: false, realOrders: false,
});
const stop = (market, w, first, last, next, reason, extra={}) => safe({
  status: "BLOCKED_DATA", reason, market, venue:VENUES[market],
  selectedResearchStartDate:w.startDate,
  selectedResearchEndDate:w.endDate,
  selectedResearchCalendarDays:w.requestedUtcDayCount,
  inspectedStartDate:utcDay(first),
  inspectedEndDate:utcDay(last-DAY),
  nextCursorDate:next,
  completeCalendarDayChunk:false,
  dateInventoryEvidencePresent:false,
  fullPeriodHistoricalSourceAuthenticated:false,
  ...extra,
});
function dayMs(date) {
  if (typeof date!=="string" || !DATE.test(date))
    throw new TypeError("PIT_MINUTE_WINDOW_EXPLICIT_DATE_INVALID");
  const ms=Date.parse(date+"T00:00:00.000Z");
  if (!Number.isSafeInteger(ms) || utcDay(ms)!==date)
    throw new TypeError("PIT_MINUTE_WINDOW_EXPLICIT_DATE_INVALID");
  return ms;
}
function requireStockCalendar(market, stockTradingDates, w) {
  if (!STOCK.has(market)) {
    if (stockTradingDates != null)
      throw new TypeError("PIT_MINUTE_WINDOW_CRYPTO_STOCK_CALENDAR_FORBIDDEN");
    return null;
  }
  if (stockTradingDates === null)
    return null;
  if (!Array.isArray(stockTradingDates)
    || stockTradingDates.length > 36600)
    throw new TypeError("PIT_MINUTE_WINDOW_STOCK_CALENDAR_INVALID");
  let prior=-1;
  for(const date of stockTradingDates) {
    const ms=dayMs(date);
    if (ms<=prior || ms<w.startMs || ms>=w.endExclusiveMs)
      throw new TypeError("PIT_MINUTE_WINDOW_STOCK_CALENDAR_INVALID");
    prior=ms;
  }
  return stockTradingDates;
}
function validSourceDay(day, expected, market) {
  return day && typeof day==="object" && !Array.isArray(day)
    && day.date===expected && day.market===market
    && Array.isArray(day.pages)
    && day.pages.length>0 && day.pages.length<=2500
    && day.manifest !== undefined;
}
const COUNTS = [
  "archivedMembers", "missingSourceMembers", "sourceLimitedMembers",
  "revisedSourceMembers", "unreadableMembers", "lifecycleBlockedMembers",
  "sourceMinuteRows", "sourceSessionsCovered",
  "retrospectiveSourceMembers", "retrospectiveMinuteRows",
  "missingSourceSessionCount",
];
const isCount = n => Number.isSafeInteger(n) && n>=0;

/**
 * Start/end date are user-selected, not hard-coded to three years.
 * Date-scoped source inputs are mandatory per counted day; missing days have
 * null source counters (NEVER zero events). Large ranges use nextCursorDate.
 */
export function auditPITMinuteSelectedWindowChunkV1({
  market, researchWindow, cursorDate=null, chunkCalendarDays=7,
  stockTradingDates=null, dateSources=[],
} = {}) {
  if (!Object.hasOwn(VENUES,market)
    || !researchWindow
    || !Number.isSafeInteger(chunkCalendarDays)
    || chunkCalendarDays<1 || chunkCalendarDays>MAX_DAYS
    || !Array.isArray(dateSources) || dateSources.length>MAX_DAYS)
    throw new TypeError("PIT_MINUTE_WINDOW_INPUT_OR_CHUNK_INVALID");
  const window=resolveSelectedResearchWindowV1(researchWindow);
  const start=cursorDate==null?window.startMs:dayMs(cursorDate);
  if(start<window.startMs || start>=window.endExclusiveMs)
    throw new TypeError("PIT_MINUTE_WINDOW_CURSOR_OUTSIDE_SELECTION");
  const end=Math.min(window.endExclusiveMs,start+chunkCalendarDays*DAY);
  const next=end<window.endExclusiveMs?utcDay(end):null;
  const stockCalendar=requireStockCalendar(market,stockTradingDates,window);
  if(STOCK.has(market)&&stockCalendar==null)
    return stop(market,window,start,end,next,
      "HISTORIC_EXCHANGE_LOCAL_STOCK_TRADING_DATES_NOT_CONNECTED",{
        requestedTradingDays:null,missingDaySourceCount:null,
        dateBasis:"EXCHANGE_LOCAL_TRADING_DATE",
        monthlyCoverage:{},reasonCounts:{},
      });
  const expected=STOCK.has(market)
    ?stockCalendar.filter(d=>d>=utcDay(start)&&d<utcDay(end))
    :Array.from({length:(end-start)/DAY},(_,i)=>utcDay(start+i*DAY));
  if(STOCK.has(market)&&expected.length===0)
    return stop(market,window,start,end,next,
      "STOCK_DATE_CHUNK_HAS_NO_CALENDAR_SESSIONS_ATTESTED",{
        requestedTradingDays:null,missingDaySourceCount:null,
        dateBasis:"EXCHANGE_LOCAL_TRADING_DATE",
        monthlyCoverage:{},reasonCounts:{},
      });
  const eligible=new Set(expected), entries=new Map();
  let pageTotal=0;
  for(const item of dateSources) {
    if(!item||!eligible.has(item.date)||entries.has(item.date)
      ||!validSourceDay(item,item.date,market))
      return stop(market,window,start,end,next,
        "DUPLICATE_OUT_OF_RANGE_OR_WRONG_MARKET_SOURCE_DATE");
    pageTotal+=item.pages.length;
    if(pageTotal>MAX_RECEIPT_PAGES_PER_CHUNK)
      return stop(market,window,start,end,next,
        "MINUTE_RECEIPT_PAGE_BUDGET_EXCEEDED_USE_SHORTER_CHUNK",{
          maximumPageReceiptsPerChunk:MAX_RECEIPT_PAGES_PER_CHUNK,
        });
    entries.set(item.date,item);
  }
  const totals=Object.fromEntries(COUNTS.map(k=>[k,0]));
  const monthly=Object.create(null),reasons=Object.create(null);
  const preview=[],daily=[];
  let completeObservedDays=0,missingDays=0,blockedDays=0,partialDays=0;
  let fixtureDays=0,sourceObservedDays=0;
  const lineages=new Set(),archiveSpansWindow=new Set();
  const perDaySha=[];
  for(const date of expected){
    const month=date.slice(0,7);
    const bucket=monthly[month] ??={
      expectedTradingDates:0,missingSourceDays:0,blockedSourceDays:0,
      locallyCompleteMinuteSourceDays:0,partialMinuteSourceDays:0,
      fixtureSourceDays:0,sourceMinuteRows:0,
      retrospectiveMinuteRows:0,
    };
    bucket.expectedTradingDates++;
    const entry=entries.get(date);
    if(!entry){
      missingDays++;bucket.missingSourceDays++;
      reasons.MISSING_HISTORIC_DAY_MINUTE_PAGES=
        (reasons.MISSING_HISTORIC_DAY_MINUTE_PAGES??0)+1;
      if(preview.length<30)
        preview.push({date,reason:"MISSING_HISTORIC_DAY_MINUTE_PAGES"});
      daily.push({date,status:"BLOCKED_DATA",
        reason:"MISSING_HISTORIC_DAY_MINUTE_PAGES",
        memberCount:null,sourceMinuteRows:null,
        missingSourceSessions:null});
      continue;
    }
    let r;
    try {
      r=summarizeHistoricalPITMinuteDayPagesV1({
        market,day:date,manifest:entry.manifest,
        stockCalendar:STOCK.has(market)?entry.stockCalendar??null:null,
        pages:entry.pages,
      });
    }catch(e) {
      // Invalid/missing local calendar or corrupt source should never be
      // silently interpreted as an exchange holiday or no-trade day.
      r={status:"BLOCKED_DATA",reason:"PIT_DAY_SOURCE_VALIDATION_EXCEPTION"};
    }
    if(!r.completeDayPageAudit){
      blockedDays++;bucket.blockedSourceDays++;
      const why=r.reason??"PIT_DAY_MINUTE_GATE_BLOCKED";
      reasons[why]=(reasons[why]??0)+1;
      if(preview.length<30)preview.push({date,reason:why});
      daily.push({date,status:"BLOCKED_DATA",reason:why,
        memberCount:null,sourceMinuteRows:null,
        missingSourceSessions:null});
      continue;
    }
    if(COUNTS.some(k=>!isCount(r[k]))){
      blockedDays++;bucket.blockedSourceDays++;
      reasons.MINUTE_DAY_COUNTER_INVALID=(reasons.MINUTE_DAY_COUNTER_INVALID??0)+1;
      if(preview.length<30)
        preview.push({date,reason:"MINUTE_DAY_COUNTER_INVALID"});
      daily.push({date,status:"BLOCKED_DATA",
        reason:"MINUTE_DAY_COUNTER_INVALID",
        memberCount:null,sourceMinuteRows:null,
        missingSourceSessions:null});
      continue;
    }
    const fixture=r.sourceStatus==="TEST_FIXTURE_ONLY";
    if(fixture){fixtureDays++;bucket.fixtureSourceDays++;}
    else sourceObservedDays++;
    for(const key of COUNTS)totals[key]+=r[key];
    bucket.sourceMinuteRows+=r.sourceMinuteRows;
    bucket.retrospectiveMinuteRows+=r.retrospectiveMinuteRows;
    const fullLocal=r.status==="SOURCE_ATTESTED_DAY_MINUTE_INVENTORY_ONLY"
      && r.localArchiveRowsPresentForEverySelectedPITMember===true;
    if(fullLocal){
      completeObservedDays++;bucket.locallyCompleteMinuteSourceDays++;
    }else{
      partialDays++;bucket.partialMinuteSourceDays++;
      reasons.INCOMPLETE_PIT_OR_MINUTE_NATIVE_SOURCE=
        (reasons.INCOMPLETE_PIT_OR_MINUTE_NATIVE_SOURCE??0)+1;
      if(preview.length<30)
        preview.push({date,reason:"INCOMPLETE_PIT_OR_MINUTE_NATIVE_SOURCE"});
    }
    const fingerprint=[
      r.pitRosterDigestSha256,entry.manifest?.sourceId,
      entry.manifest?.sourceClass,
    ];
    lineages.add(JSON.stringify(fingerprint));
    archiveSpansWindow.add(
      Boolean(entry.manifest?.coverageStartMs<=window.startMs
        && entry.manifest?.coverageEndMs>=window.endExclusiveMs));
    perDaySha.push(hash([
      date,r.pitRosterDigestSha256,r.sessionCalendarDigestSha256,
      r.pageReceiptDigestsSha256,r.sourceMinuteRows,r.missingSourceSessionCount,
      r.retrospectiveMinuteRows,
    ]));
    daily.push({
      date,status:r.status,reason:r.reason,
      memberCount:r.inspectedPITMemberCount,
      sourceMinuteRows:r.sourceMinuteRows,
      missingSourceSessions:r.missingSourceSessionCount,
      retrospectiveMinuteRows:r.retrospectiveMinuteRows,
      localOneMinuteSlotsObservedForAllRosterMembers:fullLocal,
      notHistoricalScannerSignalProof:true,
    });
  }
  const allDatesWithCompleteLocalRows=expected.length>0
    &&completeObservedDays===expected.length;
  const archiveLineageConsistent=sourceObservedDays+fixtureDays>0
    &&lineages.size===1;
  const archiveClaimsWholeSelectedSpan=archiveSpansWindow.size===1
    &&archiveSpansWindow.has(true)
    &&completeObservedDays>0;
  const crypto= !STOCK.has(market);
  const status=missingDays||blockedDays||partialDays
    ?"INCOMPLETE_OR_BLOCKED_PIT_MINUTE_DATE_CHUNK"
    :fixtureDays
      ?"TEST_FIXTURE_COMPLETE_LOCAL_MINUTE_DATE_CHUNK_ONLY"
    :!archiveLineageConsistent||!archiveClaimsWholeSelectedSpan
      ?"PIT_SOURCE_LINEAGE_OR_SPAN_NOT_ATTESTED"
    :"SOURCE_ATTESTED_LOCAL_MINUTE_DATE_CHUNK_ONLY";
  const reason=missingDays?"MISSING_HISTORIC_SOURCE_DATES"
    :blockedDays?"PIT_DAY_EVIDENCE_BLOCKED"
    :partialDays?"INCOMPLETE_NATIVE_MINUTE_SOURCE_DATES"
    :fixtureDays?"TEST_FIXTURE_IS_NOT_HISTORIC_SOURCE"
    :!archiveLineageConsistent?"PIT_LIFECYCLE_DIGEST_OR_SOURCE_CHANGED"
    :!archiveClaimsWholeSelectedSpan?"PIT_ARCHIVE_DOES_NOT_SPAN_SELECTED_WINDOW"
    :"LOCAL_SOURCE_INVENTORY_NOT_INDEPENDENT_HISTORICAL_PROOF";
  return safe({
    status,reason,market,venue:VENUES[market],
    dateBasis:crypto?"UTC_CRYPTO_DAY":"EXCHANGE_LOCAL_TRADING_DATE",
    selectedResearchStartDate:window.startDate,
    selectedResearchEndDate:window.endDate,
    selectedResearchCalendarDays:window.requestedUtcDayCount,
    inspectedStartDate:utcDay(start),
    inspectedEndDate:utcDay(end-DAY),
    maximumChunkCalendarDays:MAX_DAYS,
    maximumPageReceiptsPerChunk:MAX_RECEIPT_PAGES_PER_CHUNK,
    nextCursorDate:next,
    requestedTradingDays:expected.length,
    receivedDaySourceCount:entries.size,
    locallyCompleteMinuteSourceDays:completeObservedDays,
    missingDaySourceCount:missingDays,
    blockedDaySourceCount:blockedDays,
    partialDaySourceCount:partialDays,
    fixtureDaySourceCount:fixtureDays,
    sourceAttestedDaySourceCount:sourceObservedDays,
    completeCalendarDayChunk:missingDays===0&&blockedDays===0,
    localMinuteInventoryCompleteForSelectedChunk:allDatesWithCompleteLocalRows,
    archiveLineageConsistentForCheckedDays:archiveLineageConsistent,
    archiveSourceSpansEntireSelectedWindowSelfAttested:archiveClaimsWholeSelectedSpan,
    sourceOnlyDayReceiptChainSha256:hash(perDaySha),
    requestedTradeSessionCalendarIndependentlyVerified:false,
    historicalAllSymbolOHLCVPriceSourceIndependentlyVerified:false,
    monthlyCoverage:Object.fromEntries(Object.entries(monthly)),
    blockedReasonCounts:reasons,
    previewIncompleteDates:preview,
    additionalIncompleteDatePreviewsOmitted:
      Math.max(0,missingDays+blockedDays+partialDays-preview.length),
    dailyReadiness:daily,totals,
    // Even 31 fixture days of 1440 bars are NOT a full-market or scanner PASS.
    fullPeriodHistoricalSourceAuthenticated:false,
  });
}
