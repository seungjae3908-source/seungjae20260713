import { createHash } from "node:crypto";
import { summarizeHistoricalPITMinuteDayPagesV1 } from "./four-market-pit-minute-day-ledger-v1.js";

/**
 * OFFLINE source-gap queue page. Never derive tasks from the truncated
 * missingSourcePlanPreview (100 items): re-verify ALL day page receipts and
 * select an exact 20-PIT-member receipt. This can discover 1,000s of missing
 * names across pages without placing their prices in a GitHub artifact.
 *
 * The tasks are PRIVATE research collection proposals, not jobs, orders,
 * automatic GET requests or claims that historical data/rights are available.
 * Stocks stay blocked until a licensed provider/session source is connected.
 */
const MARKETS = Object.freeze({
  KR_STOCK: { venue: "KRX", provider: null },
  US_STOCK: { venue: "US_SIP", provider: null },
  CRYPTO_SPOT: { venue: "UPBIT_KRW", provider: "UPBIT_PUBLIC_REST" },
  CRYPTO_FUTURES: { venue: "BITGET_USDT_FUTURES", provider: "BITGET_PUBLIC_V2" },
});
const SHA = /^[0-9a-f]{64}$/u;
const sha = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const safety = value => Object.freeze({
  schemaVersion: "four-market-pit-minute-gap-queue-v1",
  ...value,
  planOnly: true,
  providerGETCount: 0,
  providerReadAuthorized: false,
  autoExecuteAllowed: false,
  privateAccountAPIAllowed: false,
  venuePITIndependentlyAuthenticated: false,
  historicalSourceRedistributionAuthorized: false,
  longTermServerStorageConfigured: false,
  fullMarketOpportunityDenominatorVerified: false,
  trueMarketWideRecall: null,
  actualMarketWideOpportunityCount: null,
  actualFillCount: null,
  netProfitPct: null,
  profitabilityProven: false,
  executionAuthority: "NONE",
  liveTrading: false, autoTrading: false, realOrders: false,
});
const error = reason => { throw new TypeError(reason); };

export function planPITNativeMinuteSourceGapsV1({
  market, day, manifest = null, stockCalendar = null,
  pages = [], taskPageIndex = 0,
} = {}) {
  if (!Object.prototype.hasOwnProperty.call(MARKETS, market)
    || !Array.isArray(pages) || pages.length < 1 || pages.length > 2500
    || !Number.isSafeInteger(taskPageIndex)
    || taskPageIndex < 0 || taskPageIndex >= pages.length) {
    error("PIT_MINUTE_GAP_QUEUE_ARGUMENTS_INVALID");
  }
  const audit = summarizeHistoricalPITMinuteDayPagesV1({
    market, day, manifest, stockCalendar, pages,
  });
  if (audit.completeDayPageAudit !== true
    || !["INCOMPLETE_SOURCE_ATTESTED_DAY_MINUTE_INVENTORY",
      "SOURCE_ATTESTED_DAY_MINUTE_INVENTORY_ONLY"].includes(audit.status)
    || audit.fullMarketOpportunityDenominatorVerified !== false
    || audit.executionAuthority !== "NONE"
    || !SHA.test(audit.pitRosterDigestSha256 ?? "")
    || !SHA.test(audit.sessionCalendarDigestSha256 ?? "")) {
    return safety({
      status: "BLOCKED_DAY_SOURCE_LEDGER",
      reason: audit.reason ?? "SOURCE_DAY_AUDIT_INVALID",
      market, venue: MARKETS[market].venue, tradingDate: day,
      taskPageIndex, candidateTasks: [], blockedMemberReview: [],
      totalMissingSourceSessions: null,
      nextTaskPageIndex: null, completeDayPageAudit: false,
    });
  }
  const page = pages[taskPageIndex];
  const members = new Set(page.memberSourceStatuses.map(x => x.symbol));
  // Full ledger has already checked exact member order, source SHA, day,
  // venue, session boundaries, status counters and missing requests.
  const raw = page.missingSourcePlan;
  if (!Array.isArray(raw) || raw.length > 320
    || raw.some(x => !members.has(x.symbol)
      || x.market !== market || x.venue !== MARKETS[market].venue
      || x.reason !== "MISSING_ORIGINAL_ONE_MINUTE_SESSION"
      || x.selectionDate !== day)) {
    error("PIT_MINUTE_GAP_QUEUE_RECEIPT_REJECTED");
  }
  const provider = MARKETS[market].provider;
  const fixture = audit.sourceStatus === "TEST_FIXTURE_ONLY";
  const eligibleForProposedPublicRead = provider !== null && !fixture;
  const allMissing = raw.map(item => ({
    market, venue: MARKETS[market].venue, symbol: item.symbol,
    tradingDate: day, selectionDate: item.selectionDate,
    sessionStartMs: item.sessionStartMs,
    sessionEndMs: item.sessionEndMs, sessionKind: item.sessionKind,
    ...(market === "CRYPTO_SPOT" || market === "CRYPTO_FUTURES"
      ? { utcDay: item.dayUtc } : { tradingDateLocal: item.tradingDateLocal }),
    sourcePlanReason: item.reason,
    proposedProvider: provider,
    sourceReadRequiresExplicitConsent: true,
    independentlyAuthenticatedPIT: false,
    historicalMinuteAvailabilityProven: false,
  }));
  const candidateTasks = eligibleForProposedPublicRead ? allMissing : [];
  const unsupportedCount = allMissing.length - candidateTasks.length;
  const blockedMemberReview = page.memberSourceStatuses.filter(row =>
    !["MISSING_ORIGINAL_MINUTE_ARCHIVE",
      "SOURCE_MINUTE_SESSIONS_PRESENT_ONLY",
      "SOURCE_MINUTE_SLOTS_PRESENT_RETROSPECTIVE_ONLY"].includes(row.status))
    .map(row => ({ symbol: row.symbol, sourceStatus: row.status,
      reason: row.reason ?? "REQUIRES_MANUAL_PROVENANCE_REVIEW" }));
  let status, reason;
  if (fixture) {
    status = "BLOCKED_FIXTURE_PIT_PUBLIC_COLLECTION";
    reason = "TEST_FIXTURE_CANNOT_AUTHORIZE_PUBLIC_HISTORY_READ";
  } else if (provider === null) {
    status = "BLOCKED_LICENSED_STOCK_ONE_MINUTE_SOURCE";
    reason = "LICENSED_HISTORIC_STOCK_ONE_MINUTE_FEED_NOT_CONNECTED";
  } else if (blockedMemberReview.length) {
    status = "PLANNED_MISSING_SOURCES_WITH_MANUAL_REVIEW";
    reason = "SOME_MEMBERS_NEED_SEPARATE_PROVENANCE_REVIEW";
  } else {
    status = candidateTasks.length
      ? "PLANNED_EXPLICIT_PUBLIC_READ_ONLY"
      : "NO_MISSING_PUBLIC_MINUTE_SOURCE_IN_SELECTED_PAGE";
    reason = candidateTasks.length ? "NO_PROVIDER_GET_EXECUTED"
      : "NO_MISSING_SOURCE_REQUESTS_FROM_VERIFIED_PAGE";
  }
  return safety({
    status, reason, market, venue: MARKETS[market].venue,
    tradingDate: day, sourceStatus: audit.sourceStatus,
    pitRosterDigestSha256: audit.pitRosterDigestSha256,
    sessionCalendarDigestSha256: audit.sessionCalendarDigestSha256,
    pageReceiptDigestsSha256: audit.pageReceiptDigestsSha256,
    archiveReceiptPageCount: audit.archiveReceiptPageCount,
    taskPageIndex, nextTaskPageIndex:
      taskPageIndex+1 < pages.length ? taskPageIndex+1 : null,
    inspectedMemberCount: page.inspectedMemberCount,
    completeDayPageAudit: true,
    historicalMemberCount: audit.inspectedPITMemberCount,
    totalMissingSourceSessions: audit.missingSourceSessionCount,
    sourceRowsCurrentlyPresent: audit.sourceMinuteRows,
    missingSourceSessionsInSelectedPage: allMissing.length,
    unsupportedOrFixtureTaskCount: unsupportedCount,
    manualReviewMemberCount: blockedMemberReview.length,
    blockedMemberReview, candidateTasks,
    candidateTaskDigestSha256: sha(candidateTasks),
  });
}
