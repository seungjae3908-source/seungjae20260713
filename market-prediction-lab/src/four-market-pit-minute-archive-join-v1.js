import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { auditHistoricalPITVenueUniverseV1 } from "./historical-pit-venue-universe-gate-v1.js";
import {
  auditResearchMinuteArchiveWindowV1,
  validateResearchStockSessionsForDateV1,
} from "./research-minute-archive-window-v1.js";
import { resolveSelectedResearchWindowV1, UTC_DAY_MS_V1 as DAY }
  from "./research-selected-window-v1.js";

/**
 * PIT historical membership -> immutable local native 1m archive join.
 *
 * Research-only, ONE market + ONE historic venue-local day + <=20 members.
 * The existing PIT gate validates the full original lifecycle archive;
 * the existing minute-window gate verifies stored 1m source per member.
 *
 * This DOES NOT fetch missing files, infer historical listing from today's
 * watchlist, overwrite data, create fills/orders or claim real-market recall.
 * Every 20-member page is source evidence only, not all-market coverage.
 */
const VENUES = Object.freeze({
  KR_STOCK: "KRX", US_STOCK: "US_SIP",
  CRYPTO_SPOT: "UPBIT_KRW", CRYPTO_FUTURES: "BITGET_USDT_FUTURES",
});
const SHA = /^[0-9a-f]{64}$/u;
const STOCK = new Set(["KR_STOCK", "US_STOCK"]);
/** A local integrity fence, not independent calendar authentication. */
export function digestPITMinuteSessionSelectionV1(sessions) {
  if (!Array.isArray(sessions) || sessions.length < 1 || sessions.length > 16)
    throw new TypeError("PIT_MINUTE_SESSION_SELECTION_INVALID");
  return createHash("sha256").update(JSON.stringify(sessions.map(s => [
    s.startMs, s.endMs, s.kind, s.timeZone, s.tradingDateLocal ?? null,
  ]))).digest("hex");
}
const safety = extra => Object.freeze({
  schemaVersion: "four-market-pit-minute-archive-join-v1",
  status: "BLOCKED_DATA", reason: null,
  historicalFullMarketPopulationIndependentlyVerified: false,
  historicalPITAndMinuteSourcesIndependentlyAuthenticated: false,
  fullMarketOpportunityDenominatorVerified: false,
  originalScannerEarlyDiscoveryVerified: false,
  actualMarketWideOpportunityCount: null, trueMarketWideRecall: null,
  actualFillCount: null, netProfitPct: null, OOSPassCount: 0,
  profitabilityProven: false, executionAuthority: "NONE",
  liveTrading: false, autoTrading: false, realOrders: false,
  privateTradingApiAllowed: false,
  ...extra,
});
const stop = (market, day, reason, extra = {}) =>
  safety({ market, venue: VENUES[market], tradingDate: day,
    reason, expectedHistoricalActiveMembers: null, ...extra });
function validInputs(input) {
  if (!input || !Object.hasOwn(VENUES, input.market)
    || typeof input.root !== "string" || !isAbsolute(input.root)
    || resolve(input.root) !== input.root
    || !Number.isSafeInteger(input.offset) || input.offset < 0
    || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 20
    || !SHA.test(input.expectedRosterDigestSha256 ?? "")) {
    throw new TypeError("PIT_MINUTE_JOIN_ARGUMENT_INVALID");
  }
}
function inAnySession(member, sessions) {
  return sessions.some(s => member.listedAtMs < s.endMs
    && (member.removedAtMs ?? Infinity) > s.startMs);
}
function lifecycleBlock(member, sessions) {
  if (sessions.some(s => member.listedAtMs > s.startMs
    || (member.removedAtMs ?? Infinity) < s.endMs)) {
    return "PIT_LISTING_OR_DELISTING_CROSSES_SESSION";
  }
  if (member.halts.some(h => sessions.some(s =>
    h.startMs < s.endMs && h.endMs > s.startMs))) {
    return "PIT_HALT_CROSSES_SESSION";
  }
  return null;
}
function count(report) {
  return {
    sourceSessionCount: report.requestedSessionCount,
    archivedSessionCount: report.archivedSessionCount,
    missingSessionCount: report.missingSessionCount,
    sourceLimitedSessionCount: report.sourceLimitedSessionCount,
    revisionConflictSessionCount: report.revisionConflictSessionCount,
    unreadableSessionCount: report.unreadableSessionCount,
    verifiedLocalOriginalOneMinuteRows: report.originalOneMinuteRows,
    retrospectiveSourceSessionCount: report.retrospectiveSourceSessionCount,
    retrospectiveUnavailableOneMinuteRows:
      report.retrospectiveUnavailableOneMinuteRows,
  };
}

/**
 * For stocks, day is the KRX / New York LOCAL trading date and the caller
 * must supply a date-specific, locally aligned session calendar.
 * Crypto day is a UTC day. Retrospective dates are not scanner-time evidence.
 */
export async function auditHistoricalPITMinuteArchiveChunkV1({
  root, market, day, manifest = null, stockCalendar = null,
  offset = 0, limit = 20, expectedRosterDigestSha256 = null,
} = {}) {
  validInputs({ root, market, offset, limit, expectedRosterDigestSha256 });
  const window = resolveSelectedResearchWindowV1({
    startDate: day, endDate: day,
  });
  const startMs = window.startMs, endMs = startMs + DAY;
  const isStock = STOCK.has(market);
  const dateBasis = isStock ? "EXCHANGE_LOCAL_TRADING_DATE" : "UTC_CRYPTO_DAY";
  if (manifest?.rawMembershipDigestSha256 !== expectedRosterDigestSha256) {
    return stop(market, day, "PIT_ROSTER_DIGEST_LEASE_MISMATCH", {
      dateBasis, requestedOffset: offset, requestedLimit: limit,
    });
  }
  const pit = auditHistoricalPITVenueUniverseV1({
    market, dayStartMs: startMs, dayEndMs: endMs,
    selectedRows: [], manifest,
  });
  if (!["SOURCE_ATTESTED_PIT_COHORT_ONLY", "TEST_FIXTURE_ONLY"]
    .includes(pit.status)) {
    return stop(market, day, "PIT_" + pit.reason, {
      dateBasis, pitGateStatus: pit.status, requestedOffset: offset,
      requestedLimit: limit,
    });
  }
  if (isStock && stockCalendar == null) {
    return stop(market, day, "STOCK_DATED_SESSION_CALENDAR_REQUIRED", {
      dateBasis, pitGateStatus: pit.status,
      expectedHistoricalActiveMembers: pit.dayActiveArchivedMembers,
      requestedOffset: offset, requestedLimit: limit,
    });
  }
  if (!isStock && stockCalendar != null) {
    return stop(market, day, "CRYPTO_STOCK_CALENDAR_UNEXPECTED", {
      dateBasis, pitGateStatus: pit.status,
    });
  }
  const sessions = isStock
    ? validateResearchStockSessionsForDateV1(
      market, stockCalendar, day, day)
    : [{ startMs, endMs, kind: "UTC_24H",
      tradingDateLocal: null, timeZone: "UTC" }];
  if (!sessions.length) {
    return stop(market, day, "STOCK_DATED_SESSION_CALENDAR_EMPTY", {
      dateBasis, pitGateStatus: pit.status,
    });
  }
  if (isStock && sessions.length > 16) {
    return stop(market, day, "STOCK_SESSION_COUNT_EXCEEDS_BOUNDED_DAY", {
      dateBasis, pitGateStatus: pit.status,
    });
  }
  const sessionCalendarDigestSha256 = digestPITMinuteSessionSelectionV1(sessions);
  if (sessions[0].startMs < manifest.coverageStartMs
    || sessions.at(-1).endMs > manifest.coverageEndMs) {
    return stop(market, day, "PIT_ARCHIVE_DOES_NOT_SPAN_EXACT_SESSIONS", {
      dateBasis, pitGateStatus: pit.status,
    });
  }
  const rows = manifest.memberships.filter(row => inAnySession(row, sessions))
    // PIT gate permits normalization; use the same exact symbol identity when
    // addressing private minute archives, without modifying the original SHA.
    .map(row => ({ ...row, symbol: String(row.symbol).trim().toUpperCase() }))
    .sort((a,b) => a.symbol.localeCompare(b.symbol)
      || a.listedAtMs - b.listedAtMs);
  const ids = new Set(rows.map(row => row.symbol));
  // Existing full PIT gate reports UTC-day active identities; the separate
  // local-date session filter must not silently add/drop an identity.
  if (ids.size !== rows.length) {
    return stop(market, day, "PIT_SAME_DAY_TICKER_REUSE_NEEDS_STABLE_ID", {
      dateBasis, pitGateStatus: pit.status,
    });
  }
  const utcDayIds=new Set(manifest.memberships.filter(row=>
    row.listedAtMs<endMs&&(row.removedAtMs??Infinity)>startMs)
    .map(row=>String(row.symbol).trim().toUpperCase()));
  if (ids.size !== pit.dayActiveArchivedMembers
    || ids.size !== utcDayIds.size
    || [...ids].some(symbol=>!utcDayIds.has(symbol))) {
    return stop(market, day, "PIT_LOCAL_SESSION_MEMBERSHIP_DIFFERS_FROM_DAY_GATE", {
      dateBasis, pitGateStatus: pit.status,
      pitGateDayActiveMembers: pit.dayActiveArchivedMembers,
      localSessionIntersectingMembers: ids.size,
    });
  }
  if (!rows.length) {
    return stop(market, day, "PIT_NO_HISTORICAL_ACTIVE_MEMBERS", {
      dateBasis, pitGateStatus: pit.status,
    });
  }
  if (offset >= rows.length) {
    return stop(market, day, "PIT_ACTIVE_MEMBER_CURSOR_OUT_OF_BOUNDS", {
      dateBasis, pitGateStatus: pit.status,
      expectedHistoricalActiveMembers: rows.length,
      requestedOffset: offset,
    });
  }
  const selected = rows.slice(offset, offset + limit);
  const nextOffset = offset + selected.length < rows.length
    ? offset + selected.length : null;
  const counters = {
    archivedMembers: 0, missingSourceMembers: 0,
    sourceLimitedMembers: 0, revisedSourceMembers: 0,
    unreadableMembers: 0, lifecycleBlockedMembers: 0,
    sourceMinuteRows: 0, sourceSessionsCovered: 0,
    retrospectiveSourceMembers: 0, retrospectiveMinuteRows: 0,
  };
  const members = [], missingSourcePlan = [];
  for (const row of selected) {
    const symbol = row.symbol;
    const lifecycle = lifecycleBlock(row, sessions);
    if (lifecycle) {
      counters.lifecycleBlockedMembers++;
      members.push({ symbol, status: "BLOCKED_PIT_PARTIAL_LIFECYCLE",
        reason: lifecycle, sourceMinuteRows: null });
      continue;
    }
    const r = await auditResearchMinuteArchiveWindowV1({
      root, market, symbol, researchWindow: {
        startDate: day, endDate: day,
      }, stockCalendar: isStock ? stockCalendar : null,
      chunkUtcDays: 1,
    });
    if (r.requestedSessionCount !== sessions.length) {
      counters.unreadableMembers++;
      members.push({ symbol, status: "BLOCKED_SESSION_AUDIT_MISMATCH",
        reason: r.status, sourceMinuteRows: null });
      continue;
    }
    if (r.missingSessionCount > 0) {
      counters.missingSourceMembers++;
      missingSourcePlan.push(...r.missingCollectionPlan.map(item => ({
        market, venue: VENUES[market], symbol, ...item,
      })));
    }
    if (r.revisionConflictSessionCount > 0) counters.revisedSourceMembers++;
    if (r.unreadableSessionCount > 0) counters.unreadableMembers++;
    if (r.sourceLimitedSessionCount > 0) counters.sourceLimitedMembers++;
    if (r.archivedSessionCount > 0) counters.archivedMembers++;
    if (r.retrospectiveSourceSessionCount > 0)
      counters.retrospectiveSourceMembers++;
    counters.retrospectiveMinuteRows +=
      r.retrospectiveUnavailableOneMinuteRows;
    counters.sourceMinuteRows += r.originalOneMinuteRows;
    counters.sourceSessionsCovered += r.archivedSessionCount;
    const status = r.missingSessionCount
      ? "MISSING_ORIGINAL_MINUTE_ARCHIVE" :
      r.revisionConflictSessionCount
      ? "SOURCE_REVISION_CONFLICT" :
      r.unreadableSessionCount
      ? "UNREADABLE_OR_INVALID_SOURCE" :
      r.sourceLimitedSessionCount
      ? "SOURCE_LIMITED_MINUTE_INTERVALS" :
      r.retrospectiveSourceSessionCount
      ? "SOURCE_MINUTE_SLOTS_PRESENT_RETROSPECTIVE_ONLY" :
      "SOURCE_MINUTE_SESSIONS_PRESENT_ONLY";
    members.push({ symbol, status, reason: null,
      ...count(r) });
  }
  const failures = counters.missingSourceMembers
    + counters.sourceLimitedMembers + counters.revisedSourceMembers
    + counters.unreadableMembers + counters.lifecycleBlockedMembers;
  const sourceStatus = pit.status === "TEST_FIXTURE_ONLY"
    ? "TEST_FIXTURE_ONLY" : "SOURCE_ATTESTED_ONLY";
  return safety({
    status: failures ? "INCOMPLETE_PIT_MINUTE_SOURCE_CHUNK"
      : "PIT_MINUTE_SOURCE_CHUNK_PRESENT_NOT_INDEPENDENTLY_VERIFIED",
    reason: failures ? "MISSING_PARTIAL_CONFLICTING_OR_BLOCKED_MEMBERS"
      : "SOURCE_RECEIPTS_NOT_INDEPENDENT_PIT_OR_SCANNER_PROOF",
    market, venue: VENUES[market], tradingDate: day, dateBasis,
    pitGateStatus: pit.status, pitSourceClass: manifest.sourceClass,
    pitRosterSourceId: manifest.sourceId,
    pitRosterDigestSha256: expectedRosterDigestSha256,
    sessionCalendarDigestSha256,
    sourceStatus, expectedHistoricalActiveMembers: rows.length,
    requestedOffset: offset, requestedLimit: limit,
    inspectedMemberCount: selected.length, nextOffset,
    historicalDelistedSymbolsRetainedInRoster: true,
    memberSourceStatuses: members, missingSourcePlan, ...counters,
    completeRequestedMarketDayChecked: nextOffset === null
      && offset === 0,
    stockCalendarIndependentlyAuthenticated: false,
    retrospectiveOriginalRowsAreNotScannerAsOfEvidence: true,
    actualMarketWideOpportunityCount: null,
    trueMarketWideRecall: null, profitabilityProven: false,
    executionAuthority: "NONE",
  });
}
