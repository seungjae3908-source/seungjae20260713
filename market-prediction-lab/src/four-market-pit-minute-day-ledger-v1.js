import { createHash } from "node:crypto";
import { auditHistoricalPITVenueUniverseV1 } from "./historical-pit-venue-universe-gate-v1.js";
import { validateResearchStockSessionsForDateV1 } from "./research-minute-archive-window-v1.js";
import { digestPITMinuteSessionSelectionV1 } from "./four-market-pit-minute-archive-join-v1.js";
import { resolveSelectedResearchWindowV1, UTC_DAY_MS_V1 as DAY }
  from "./research-selected-window-v1.js";

/**
 * Read-only DAY aggregation of sequential, bounded PIT->original 1m page
 * receipts. This does not download a bar or claim independently authenticated
 * exchange-wide PIT membership, scanner discovery, OOS or actual fills.
 *
 * All source data remain in their existing private archive; only digests and
 * bounded status summaries are returned. Fail closed on missing or duplicate
 * pages, roster/calendar revisions, tampering or contradictory counters.
 */
const VENUES = Object.freeze({
  KR_STOCK: "KRX", US_STOCK: "US_SIP",
  CRYPTO_SPOT: "UPBIT_KRW", CRYPTO_FUTURES: "BITGET_USDT_FUTURES",
});
const STOCKS = new Set(["KR_STOCK", "US_STOCK"]);
const MEMBER_STATUSES = new Set([
  "BLOCKED_PIT_PARTIAL_LIFECYCLE", "MISSING_ORIGINAL_MINUTE_ARCHIVE",
  "SOURCE_REVISION_CONFLICT", "UNREADABLE_OR_INVALID_SOURCE",
  "SOURCE_LIMITED_MINUTE_INTERVALS", "SOURCE_MINUTE_SESSIONS_PRESENT_ONLY",
]);
const COUNTERS = ["archivedMembers", "missingSourceMembers",
  "sourceLimitedMembers", "revisedSourceMembers", "unreadableMembers",
  "lifecycleBlockedMembers", "sourceMinuteRows", "sourceSessionsCovered"];
const SHA = /^[a-f0-9]{64}$/u;
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const safe = extra => Object.freeze({
  schemaVersion: "four-market-pit-minute-day-ledger-v1",
  status: "BLOCKED_DATA", reason: null,
  historicalFullMarketPopulationIndependentlyVerified: false,
  sourceManifestAndMinuteRowsIndependentlyAuthenticated: false,
  originalScannerEarlyDiscoveryVerified: false,
  historicalFullMarketOpportunityDenominatorVerified: false,
  fullMarketOpportunityDenominatorVerified: false,
  actualMarketWideOpportunityCount: null, trueMarketWideRecall: null,
  actualFillCount: null, netProfitPct: null, OOSPassCount: 0,
  profitabilityProven: false, executionAuthority: "NONE",
  liveTrading: false, autoTrading: false, realOrders: false,
  privateTradingApiAllowed: false, ...extra,
});
const blocked = (market, day, reason) => safe({
  market, venue: VENUES[market] ?? null, tradingDate: day,
  reason, expectedHistoricalActiveMembers: null, completeDayPageAudit: false,
  archiveSourceCompletenessEstablished: false,
});
const number = value => Number.isSafeInteger(value) && value >= 0;
const validPageSafety = p => p?.executionAuthority === "NONE"
  && p.profitabilityProven === false
  && p.fullMarketOpportunityDenominatorVerified === false
  && p.historicalFullMarketPopulationIndependentlyVerified === false
  && p.historicalPITAndMinuteSourcesIndependentlyAuthenticated === false
  && p.originalScannerEarlyDiscoveryVerified === false
  && p.actualMarketWideOpportunityCount === null
  && p.trueMarketWideRecall === null && p.actualFillCount === null
  && p.netProfitPct === null && p.OOSPassCount === 0
  && p.liveTrading === false && p.autoTrading === false
  && p.realOrders === false && p.privateTradingApiAllowed === false;

function cohortForSessions(manifest, sessions) {
  const rows = manifest.memberships.filter(row => sessions.some(s =>
    row.listedAtMs < s.endMs && (row.removedAtMs ?? Infinity) > s.startMs))
    .map(row => ({ symbol: String(row.symbol).trim().toUpperCase(),
      listedAtMs: row.listedAtMs }))
    .sort((a,b) => a.symbol.localeCompare(b.symbol)
      || a.listedAtMs - b.listedAtMs);
  if (new Set(rows.map(x => x.symbol)).size !== rows.length) return null;
  return rows.map(x => x.symbol);
}
function inspectMember(member, expectedSymbol, sessionCount) {
  if (!member || member.symbol !== expectedSymbol
    || !MEMBER_STATUSES.has(member.status)) return null;
  const counts = Object.fromEntries(COUNTERS.map(k => [k, 0]));
  if (member.status === "BLOCKED_PIT_PARTIAL_LIFECYCLE") {
    if (!["PIT_LISTING_OR_DELISTING_CROSSES_SESSION", "PIT_HALT_CROSSES_SESSION"]
      .includes(member.reason) || member.sourceMinuteRows !== null)
      return null;
    counts.lifecycleBlockedMembers = 1;
    return { counts, expectedMissing: 0 };
  }
  const keys = ["sourceSessionCount", "archivedSessionCount",
    "missingSessionCount", "sourceLimitedSessionCount",
    "revisionConflictSessionCount", "unreadableSessionCount",
    "verifiedLocalOriginalOneMinuteRows"];
  if (keys.some(key => !number(member[key]))
    || member.reason !== null
    || member.sourceSessionCount !== sessionCount
    || member.archivedSessionCount + member.missingSessionCount
      + member.revisionConflictSessionCount + member.unreadableSessionCount
        !== sessionCount
    || member.sourceLimitedSessionCount > member.archivedSessionCount
    || member.verifiedLocalOriginalOneMinuteRows
      < member.archivedSessionCount
    || member.verifiedLocalOriginalOneMinuteRows
      > member.archivedSessionCount * 1440) return null;
  const status = member.missingSessionCount
    ? "MISSING_ORIGINAL_MINUTE_ARCHIVE"
    : member.revisionConflictSessionCount ? "SOURCE_REVISION_CONFLICT"
    : member.unreadableSessionCount ? "UNREADABLE_OR_INVALID_SOURCE"
    : member.sourceLimitedSessionCount ? "SOURCE_LIMITED_MINUTE_INTERVALS"
    : "SOURCE_MINUTE_SESSIONS_PRESENT_ONLY";
  if (status !== member.status) return null;
  counts.archivedMembers = Number(member.archivedSessionCount > 0);
  counts.missingSourceMembers = Number(member.missingSessionCount > 0);
  counts.sourceLimitedMembers = Number(member.sourceLimitedSessionCount > 0);
  counts.revisedSourceMembers = Number(member.revisionConflictSessionCount > 0);
  counts.unreadableMembers = Number(member.unreadableSessionCount > 0);
  counts.sourceMinuteRows = member.verifiedLocalOriginalOneMinuteRows;
  counts.sourceSessionsCovered = member.archivedSessionCount;
  return { counts, expectedMissing: member.missingSessionCount };
}
function inspectPlan(plan, membership, expectedCountsBySymbol, market, date, sessions) {
  const expectedCount=[...expectedCountsBySymbol.values()].reduce((a,b)=>a+b,0);
  if (!Array.isArray(plan) || plan.length !== expectedCount
    || plan.length > membership.length * 16) return false;
  const bySymbol = new Map(), actualCounts = new Map();
  const byStart = new Map(sessions.map(x => [x.startMs,x]));
  for (const p of plan) {
    if (p?.market !== market || p.venue !== VENUES[market]
      || !membership.includes(p.symbol)
      || p.reason !== "MISSING_ORIGINAL_ONE_MINUTE_SESSION"
      || p.selectionDate !== date
      || !number(p.sessionStartMs) || !number(p.sessionEndMs)
      || p.sessionEndMs <= p.sessionStartMs
      || !byStart.has(p.sessionStartMs)
      || p.sessionEndMs !== byStart.get(p.sessionStartMs).endMs
      || p.sessionKind !== byStart.get(p.sessionStartMs).kind
      || (STOCKS.has(market)
        ? p.tradingDateLocal !== date || Object.hasOwn(p,"dayUtc")
        : p.dayUtc !== date || Object.hasOwn(p,"tradingDateLocal")))
      return false;
    const id = p.symbol + ":" + p.sessionStartMs;
    if (bySymbol.has(id)) return false;
    bySymbol.set(id, true);
    actualCounts.set(p.symbol,(actualCounts.get(p.symbol)??0)+1);
  }
  return membership.every(symbol=>
    (actualCounts.get(symbol)??0)===(expectedCountsBySymbol.get(symbol)??0));
}

export function summarizeHistoricalPITMinuteDayPagesV1({
  market, day, manifest = null, stockCalendar = null, pages = [],
} = {}) {
  if (!Object.hasOwn(VENUES, market)) throw new TypeError("PIT_MINUTE_DAY_MARKET_INVALID");
  const window = resolveSelectedResearchWindowV1({startDate:day,endDate:day});
  const start = window.startMs, end = window.endExclusiveMs;
  const stock = STOCKS.has(market);
  if (stock && stockCalendar == null)
    return blocked(market, day, "STOCK_DATED_SESSION_CALENDAR_REQUIRED");
  if (!stock && stockCalendar != null)
    return blocked(market, day, "CRYPTO_STOCK_CALENDAR_UNEXPECTED");
  const pit = auditHistoricalPITVenueUniverseV1({
    market, dayStartMs:start, dayEndMs:end, selectedRows:[], manifest,
  });
  if (!["TEST_FIXTURE_ONLY","SOURCE_ATTESTED_PIT_COHORT_ONLY"]
    .includes(pit.status)) return blocked(market, day, "PIT_"+pit.reason);
  const sessions = stock
    ? validateResearchStockSessionsForDateV1(market,stockCalendar,day,day)
    : [{ startMs:start, endMs:end, kind:"UTC_24H",
      tradingDateLocal:null, timeZone:"UTC" }];
  if (!sessions.length || sessions.length>16)
    return blocked(market,day,"PIT_MINUTE_DAY_SESSION_LIST_INVALID");
  if (sessions[0].startMs < manifest.coverageStartMs
      || sessions.at(-1).endMs > manifest.coverageEndMs)
    return blocked(market,day,"PIT_MINUTE_DAY_SOURCE_SPAN_INVALID");
  const cohort = cohortForSessions(manifest,sessions);
  if (!cohort) return blocked(market,day,"PIT_SAME_DAY_TICKER_REUSE_NEEDS_STABLE_ID");
  const utcDaySymbols = new Set(manifest.memberships.filter(row =>
    row.listedAtMs<end && (row.removedAtMs ?? Infinity)>start)
    .map(row => String(row.symbol).trim().toUpperCase()));
  if (cohort.length !== pit.dayActiveArchivedMembers
    || cohort.length !== utcDaySymbols.size
    || cohort.some(symbol=>!utcDaySymbols.has(symbol)))
    return blocked(market,day,"PIT_LOCAL_SESSION_MEMBERSHIP_DIFFERS_FROM_DAY_GATE");
  if (!cohort.length) return blocked(market,day,"PIT_NO_HISTORICAL_ACTIVE_MEMBERS");
  if (!Array.isArray(pages) || !pages.length || pages.length > 2500)
    return blocked(market,day,"PIT_MINUTE_DAY_RECEIPT_PAGES_REQUIRED");
  const calendarDigest = digestPITMinuteSessionSelectionV1(sessions);
  const expectedStatus = pit.status==="TEST_FIXTURE_ONLY"
    ? "TEST_FIXTURE_ONLY" : "SOURCE_ATTESTED_ONLY";
  const dateBasis = stock ? "EXCHANGE_LOCAL_TRADING_DATE" : "UTC_CRYPTO_DAY";
  const summed = Object.fromEntries(COUNTERS.map(k=>[k,0]));
  const statusCounts = Object.create(null), monthlyMissingPreview = [];
  let offset=0, missingPlanTotal=0, complete=true;
  const pageDigestInputs = [];
  for (const page of pages) {
    if (!page || !validPageSafety(page)
      || page.schemaVersion!=="four-market-pit-minute-archive-join-v1"
      || !["INCOMPLETE_PIT_MINUTE_SOURCE_CHUNK",
        "PIT_MINUTE_SOURCE_CHUNK_PRESENT_NOT_INDEPENDENTLY_VERIFIED"]
        .includes(page.status)
      || page.market!==market || page.venue!==VENUES[market]
      || page.tradingDate!==day || page.dateBasis!==dateBasis
      || page.pitGateStatus!==pit.status || page.sourceStatus!==expectedStatus
      || page.pitSourceClass!==manifest.sourceClass
      || page.pitRosterSourceId!==manifest.sourceId
      || page.pitRosterDigestSha256!==manifest.rawMembershipDigestSha256
      || page.sessionCalendarDigestSha256!==calendarDigest
      || page.expectedHistoricalActiveMembers!==cohort.length
      || !number(page.requestedOffset) || page.requestedOffset!==offset
      || !number(page.requestedLimit) || page.requestedLimit<1
      || page.requestedLimit>20
      || !Array.isArray(page.memberSourceStatuses)
      || !page.memberSourceStatuses.length
      || page.memberSourceStatuses.length>20
      || page.memberSourceStatuses.length
        !==Math.min(page.requestedLimit,cohort.length-offset)
      || page.inspectedMemberCount!==page.memberSourceStatuses.length
      || page.historicalDelistedSymbolsRetainedInRoster!==true
      || page.stockCalendarIndependentlyAuthenticated!==false)
      return blocked(market,day,"PIT_MINUTE_DAY_PAGE_IDENTITY_OR_SEQUENCE_INVALID");
    const local = Object.fromEntries(COUNTERS.map(k=>[k,0]));
    const expectedMissingBySymbol=new Map();
    const memberNames=[];
    for (const member of page.memberSourceStatuses) {
      const expectedSymbol=cohort[offset+memberNames.length];
      const inspected=inspectMember(member,expectedSymbol,sessions.length);
      if (!inspected)
        return blocked(market,day,"PIT_MINUTE_DAY_MEMBER_SOURCE_CONTRADICTION");
      expectedMissingBySymbol.set(expectedSymbol,inspected.expectedMissing);
      memberNames.push(expectedSymbol);
      statusCounts[member.status]=(statusCounts[member.status]??0)+1;
      for (const counter of COUNTERS) local[counter]+=inspected.counts[counter];
    }
    const missing=page.missingSourcePlan;
    if (!inspectPlan(missing,memberNames,expectedMissingBySymbol,market,day,sessions))
      return blocked(market,day,"PIT_MINUTE_DAY_MISSING_PLAN_INVALID");
    for (const item of missing) {
      if (monthlyMissingPreview.length<100)
        monthlyMissingPreview.push({
          symbol:item.symbol, selectionDate:item.selectionDate,
          sessionStartMs:item.sessionStartMs, sessionKind:item.sessionKind,
        });
    }
    missingPlanTotal+=missing.length;
    for (const k of COUNTERS) {
      if (!number(page[k])||page[k]!==local[k])
        return blocked(market,day,"PIT_MINUTE_DAY_PAGE_COUNTER_CONTRADICTION");
      summed[k]+=local[k];
    }
    const failed=local.missingSourceMembers+local.sourceLimitedMembers
      +local.revisedSourceMembers+local.unreadableMembers
      +local.lifecycleBlockedMembers>0;
    if (page.status !== (failed
      ?"INCOMPLETE_PIT_MINUTE_SOURCE_CHUNK"
      :"PIT_MINUTE_SOURCE_CHUNK_PRESENT_NOT_INDEPENDENTLY_VERIFIED")
      || page.completeRequestedMarketDayChecked!==
        (offset===0&&offset+memberNames.length===cohort.length))
      return blocked(market,day,"PIT_MINUTE_DAY_PAGE_STATUS_CONTRADICTION");
    const next=offset+memberNames.length;
    if (page.nextOffset!==(next<cohort.length?next:null))
      return blocked(market,day,"PIT_MINUTE_DAY_NEXT_CURSOR_INVALID");
    pageDigestInputs.push(hash(page));
    offset=next;
  }
  if (offset!==cohort.length)
    return blocked(market,day,"PIT_MINUTE_DAY_PAGE_COVERAGE_GAP");
  const unresolved=summed.missingSourceMembers+summed.sourceLimitedMembers
    +summed.revisedSourceMembers+summed.unreadableMembers
    +summed.lifecycleBlockedMembers;
  complete=unresolved===0;
  return safe({
    market, venue:VENUES[market], tradingDate:day, dateBasis,
    status:complete?"SOURCE_ATTESTED_DAY_MINUTE_INVENTORY_ONLY"
      :"INCOMPLETE_SOURCE_ATTESTED_DAY_MINUTE_INVENTORY",
    reason:complete?"RETROSPECTIVE_SOURCE_INVENTORY_NOT_CANONICAL_PIT_PROOF"
      :"HISTORICAL_MEMBER_MINUTE_SOURCE_MISSING_PARTIAL_OR_BLOCKED",
    pitGateStatus:pit.status, sourceStatus:expectedStatus,
    pitRosterDigestSha256:manifest.rawMembershipDigestSha256,
    sessionCalendarDigestSha256:calendarDigest,
    pageReceiptDigestsSha256:hash(pageDigestInputs),
    completeDayPageAudit:true,
    // Even all locally present fixture/self-attested rows do not authenticate
    // historical venue membership or source completeness independently.
    archiveSourceCompletenessEstablished:false,
    localArchiveRowsPresentForEverySelectedPITMember:complete,
    inspectedPITMemberCount:cohort.length,
    expectedHistoricalActiveMembers:cohort.length,
    archiveReceiptPageCount:pages.length,
    historicallyDelistedMembersPreservedInManifest:true,
    missingSourceSessionCount:missingPlanTotal,
    missingSourcePlanPreview:monthlyMissingPreview,
    omittedMissingSourcePlanItems:Math.max(0,missingPlanTotal-100),
    memberSourceStatusCounts:{...statusCounts},
    ...summed,
    checkedArchiveSourcesOnly:true,
    stockCalendarIndependentlyAuthenticated:false,
  });
}
