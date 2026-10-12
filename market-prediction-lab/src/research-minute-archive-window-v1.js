import { isAbsolute, resolve } from "node:path";
import {
  resolveSelectedResearchWindowV1, UTC_DAY_MS_V1 as DAY,
} from "./research-selected-window-v1.js";
import { inspectArchivedResearchMinuteSessionV1 } from "./research-minute-archive-v1.js";

/**
 * Read-only, bounded source-inventory audit for ONE market/symbol per call.
 *
 * Crypto UTC days are enumerated from the user-selected range; stock sessions
 * MUST be supplied by a dated calendar source and remain unverified until
 * separately authenticated. An archived file is not an exhaustive PIT universe
 * or complete tick/orderbook data. No provider/network/order/DB operations.
 *
 * A 10-year request is processed as sequential <=31-day chunks; the caller
 * can resume at nextCursorDate without loading years of minute bars into RAM.
 */
const MARKETS = Object.freeze({
  KR_STOCK: "KRX", US_STOCK: "US_SIP",
  CRYPTO_SPOT: "UPBIT_KRW", CRYPTO_FUTURES: "BITGET_USDT_FUTURES",
});
const SYMBOL = /^[A-Z0-9][A-Z0-9._:-]{0,39}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const MINUTE = 60_000;
const PROPOSED_PROVIDERS = Object.freeze({
  KR_STOCK: null, US_STOCK: null,
  CRYPTO_SPOT: "UPBIT_PUBLIC_REST", CRYPTO_FUTURES: "BITGET_PUBLIC_V2",
});
const SESSION_KINDS = new Set(["REGULAR", "PREMARKET", "AFTERMARKET"]);
const utc = ms => new Date(ms).toISOString().slice(0, 10);
// Market-local trading dates, not arbitrary UTC-midnight calendar dates.
const LOCAL_DATES = Object.freeze({
  "Asia/Seoul": new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }),
  "America/New_York": new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }),
});
function localDay(ms, zone) {
  const parts = Object.fromEntries(LOCAL_DATES[zone].formatToParts(new Date(ms))
    .map(x => [x.type, x.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
const fail = (reason) => { throw new TypeError(reason); };
const safe = values => Object.freeze({
  schemaVersion: "research-minute-archive-window-coverage-v1",
  ...values,
  sourceInventoryOnly: true,
  stockCalendarIndependentlyVerified: false,
  venuePITUniverseIndependentlyVerified: false,
  wholeHistoricMarketPopulationVerified: false,
  historicalFullMarketOpportunityDenominatorVerified: false,
  fullMarketOpportunityDenominatorVerified: false,
  actualMarketWideOpportunityCount: null,
  trueMarketWideRecall: null, actualFillCount: null, netProfitPct: null,
  profitabilityProven: false, executionAuthority: "NONE",
  liveTrading: false, autoTrading: false, realOrders: false,
});
function parseDate(value) {
  if (typeof value !== "string" || !DATE.test(value)) fail("MINUTE_WINDOW_DATE_INVALID");
  const valueMs = Date.parse(value + "T00:00:00.000Z");
  if (!Number.isSafeInteger(valueMs) || utc(valueMs) !== value)
    fail("MINUTE_WINDOW_DATE_INVALID");
  return valueMs;
}
export function validateResearchStockSessionsForDateV1(market, stockCalendar, startDate, endDate) {
  if (!stockCalendar || typeof stockCalendar !== "object"
    || Array.isArray(stockCalendar) || stockCalendar.market !== market
    || !Array.isArray(stockCalendar.sessions)
    || stockCalendar.sessions.length > 50_000)
    fail("MINUTE_WINDOW_STOCK_CALENDAR_INVALID");
  const timeZone = market === "KR_STOCK" ? "Asia/Seoul" : "America/New_York";
  const source = stockCalendar.sessions;
  // Validate the complete multi-year exchange calendar, then select only
  // the requested local dates. Never treat unrelated stored sessions as errors.
  let previousEndMs = Number.NEGATIVE_INFINITY;
  const validated = [];
  for (const x of source) {
    if (!x || typeof x !== "object" || Array.isArray(x)
      || !Number.isSafeInteger(x.startMs) || x.startMs < previousEndMs
      || x.startMs % 60_000 !== 0 || !Number.isSafeInteger(x.endMs)
      || x.endMs % 60_000 !== 0 || x.endMs <= x.startMs
      || x.endMs - x.startMs > DAY || !SESSION_KINDS.has(x.kind)
      || x.timeZone !== timeZone
      || typeof x.tradingDateLocal !== "string"
      || !DATE.test(x.tradingDateLocal)
      || x.tradingDateLocal !== localDay(x.startMs, timeZone))
      fail("MINUTE_WINDOW_STOCK_CALENDAR_INVALID");
    previousEndMs = x.endMs;
    validated.push({ selectionDate: x.tradingDateLocal,
      tradingDateLocal: x.tradingDateLocal, startMs: x.startMs,
      endMs: x.endMs, kind: x.kind, timeZone: x.timeZone });
  }
  return validated.filter(x => x.tradingDateLocal >= startDate
    && x.tradingDateLocal <= endDate);
}
function base(market, symbol, window, chunkStartMs, chunkEndExclusiveMs) {
  return {
    market, venue: MARKETS[market], symbol,
    researchDateBasis: market.startsWith("CRYPTO_")
      ? "UTC_CRYPTO_DAY" : "EXCHANGE_LOCAL_TRADING_DATE",
    selectedResearchStartDate: window.startDate,
    selectedResearchEndDate: window.endDate,
    selectedResearchStartUtc: market.startsWith("CRYPTO_") ? window.startDate : null,
    selectedResearchEndInclusiveUtc: market.startsWith("CRYPTO_") ? window.endDate : null,
    selectedResearchUtcDayCount: window.requestedUtcDayCount,
    inspectedStartDate: utc(chunkStartMs),
    inspectedEndInclusiveDate: utc(chunkEndExclusiveMs - DAY),
    inspectedStartUtc: market.startsWith("CRYPTO_") ? utc(chunkStartMs) : null,
    inspectedEndInclusiveUtc: market.startsWith("CRYPTO_")
      ? utc(chunkEndExclusiveMs - DAY) : null,
    maximumChunkCalendarDays: 31,
    nextCursorDate: chunkEndExclusiveMs < window.endExclusiveMs
      ? utc(chunkEndExclusiveMs) : null,
  };
}

/**
 * Produce resumable per-symbol archive coverage. Missing-day records are a
 * collection TODO, NEVER zero-opportunity days. No file or raw price rows
 * are emitted. Invalid archive revisions are not silently accepted.
 */
export async function auditResearchMinuteArchiveWindowV1({
  root, market, symbol, researchWindow = null, cursorDate = null,
  chunkUtcDays = 7, stockCalendar = null,
} = {}) {
  if (!Object.prototype.hasOwnProperty.call(MARKETS, market)
    || typeof symbol !== "string" || !SYMBOL.test(symbol)
    || typeof root !== "string" || !isAbsolute(root)
    || resolve(root) !== root)
    fail("MINUTE_WINDOW_SCOPE_INVALID");
  if (!Number.isSafeInteger(chunkUtcDays) || chunkUtcDays < 1 || chunkUtcDays > 31)
    fail("MINUTE_WINDOW_CHUNK_DAYS_OUT_OF_BOUNDS");
  const window = resolveSelectedResearchWindowV1(researchWindow);
  const chunkStartMs = cursorDate == null ? window.startMs : parseDate(cursorDate);
  if (chunkStartMs < window.startMs || chunkStartMs >= window.endExclusiveMs)
    fail("MINUTE_WINDOW_CURSOR_OUTSIDE_SELECTION");
  const chunkEndExclusiveMs = Math.min(window.endExclusiveMs,
    chunkStartMs + chunkUtcDays * DAY);
  const summary = base(market, symbol, window, chunkStartMs, chunkEndExclusiveMs);
  const isCrypto = market === "CRYPTO_SPOT" || market === "CRYPTO_FUTURES";
  if (!isCrypto && stockCalendar == null) {
    return safe({ ...summary, status: "BLOCKED_STOCK_SESSION_CALENDAR_MISSING",
      requestedSessionCount: null, archivedSessionCount: 0,
      sourceLimitedSessionCount: 0, missingSessionCount: null,
      revisionConflictSessionCount: 0, unreadableSessionCount: 0,
      noTradeMinuteEvidenceVerified: false,
      missingCollectionPlan: null, partialRetryReviewPlan: null,
      revisionReviewPlan: null, unreadableSourceReviewPlan: null,
      monthlyCoverage: {},
    });
  }
  if (isCrypto && stockCalendar != null) fail("MINUTE_WINDOW_CRYPTO_CALENDAR_UNEXPECTED");
  const selectedSessions = isCrypto
    ? Array.from({ length: (chunkEndExclusiveMs - chunkStartMs) / DAY },
      (_, i) => {
        const startMs = chunkStartMs + i * DAY;
        return { selectionDate: utc(startMs), dayUtc: utc(startMs),
          startMs, endMs: startMs + DAY,
          kind: "UTC_24H", timeZone: "UTC" };
      })
    : validateResearchStockSessionsForDateV1(market, stockCalendar,
      window.startDate, window.endDate).filter(x =>
      x.tradingDateLocal >= utc(chunkStartMs)
      && x.tradingDateLocal < utc(chunkEndExclusiveMs));
  if (!isCrypto && selectedSessions.length === 0) {
    return safe({ ...summary, status: "BLOCKED_STOCK_SESSION_CALENDAR_EMPTY",
      requestedSessionCount: null, archivedSessionCount: 0,
      sourceLimitedSessionCount: 0, missingSessionCount: null,
      revisionConflictSessionCount: 0, unreadableSessionCount: 0,
      missingCollectionPlan: null, partialRetryReviewPlan: null,
      revisionReviewPlan: null, unreadableSourceReviewPlan: null,
      monthlyCoverage: {},
      noTradeMinuteEvidenceVerified: false,
    });
  }
  const totals = {
    archivedSessionCount: 0, sourceLimitedSessionCount: 0,
    missingSessionCount: 0, revisionConflictSessionCount: 0,
    unreadableSessionCount: 0, originalOneMinuteRows: 0,
    sourceUnverifiedOneMinuteSlots: 0,
    retrospectiveSourceSessionCount: 0,
    retrospectiveUnavailableOneMinuteRows: 0,
  };
  const missingCollectionPlan = [], partialRetryReviewPlan = [];
  const revisionReviewPlan = [], unreadableSourceReviewPlan = [];
  const warnings = [], monthly = Object.create(null);
  const planIdentity = session => ({
    selectionDate: session.selectionDate,
    sessionStartMs: session.startMs, sessionEndMs: session.endMs,
    sessionKind: session.kind,
    ...(isCrypto ? { dayUtc: session.dayUtc }
      : { tradingDateLocal: session.tradingDateLocal }),
    market, symbol,
  });
  const proposedProvider=PROPOSED_PROVIDERS[market];
  for (const session of selectedSessions) {
    const month = session.selectionDate.slice(0, 7);
    const bucket = monthly[month] ??= {
      requestedSessions: 0, sourcePresent: 0, sourceLimited: 0,
      missing: 0, revisionConflict: 0, unreadable: 0,
      retrospectiveSourceSessions: 0,
    };
    bucket.requestedSessions++;
    let result;
    try {
      result = await inspectArchivedResearchMinuteSessionV1({
        root, market, symbol, sessionStartMs: session.startMs,
      });
    } catch (error) {
      totals.unreadableSessionCount++; bucket.unreadable++;
      const warning={...planIdentity(session),
        reason:"ARCHIVED_ORIGINAL_UNREADABLE_OR_INVALID",
        errorCode:String(error?.message??"ERROR").slice(0,100)};
      warnings.push(warning);
      unreadableSourceReviewPlan.push(Object.freeze({...warning,
        action:"REVIEW_UNREADABLE_ORIGINAL_BEFORE_ANY_REDOWNLOAD",
        providerGETCount:0,autoExecuteAllowed:false}));
      continue;
    }
    if (result.status === "BLOCKED_DATA") {
      if (result.reason === "ARCHIVED_SESSION_NOT_FOUND"
        || result.reason === "ARCHIVED_REVISION_NOT_FOUND") {
        totals.missingSessionCount++; bucket.missing++;
        missingCollectionPlan.push(Object.freeze({
          ...planIdentity(session),
          reason:"MISSING_ORIGINAL_ONE_MINUTE_SESSION",
          proposedProvider,sourceReadRequiresExplicitConsent:true,
          independentPITRosterRequired:true,
          historicalNoTradeEvidenceVerified:false,
          providerGETCount:0,autoExecuteAllowed:false,
        }));
      } else if (result.reason ===
        "MULTIPLE_SOURCE_REVISIONS_REQUIRE_EXPLICIT_SELECTION") {
        totals.revisionConflictSessionCount++; bucket.revisionConflict++;
        warnings.push({ selectionDate: session.selectionDate, sessionStartMs: session.startMs,
          reason:"REVISIONS_REQUIRE_EXPLICIT_SOURCE_SELECTION" });
        revisionReviewPlan.push(Object.freeze({
          ...planIdentity(session),
          action:"AUDIT_IMMUTABLE_REVISIONS_MANUALLY",
          reason:"REVISIONS_REQUIRE_EXPLICIT_SOURCE_SELECTION",
          sourceRevisionAutoSelected:false,
          existingSourceDigestSha256:null,
          providerGETCount:0,autoExecuteAllowed:false,
        }));
      } else {
        totals.unreadableSessionCount++; bucket.unreadable++;
        const warning={...planIdentity(session),
          reason:"ARCHIVE_BLOCKED",errorCode:String(result.reason).slice(0,100)};
        warnings.push(warning);
        unreadableSourceReviewPlan.push(Object.freeze({...warning,
          action:"REVIEW_UNTRUSTED_ORIGINAL_BEFORE_ANY_REDOWNLOAD",
          providerGETCount:0,autoExecuteAllowed:false}));
      }
      continue;
    }
    if (result.sourceMinuteIntegrityVerified !== true
      || result.market !== market || result.symbol !== symbol
      || result.sessionKind !== session.kind
      || result.sessionTimeZone !== session.timeZone
      || result.archiveSessionEndMs !== session.endMs
      || !Number.isSafeInteger(result.missingUnverifiedSourceMinuteSlots)
      || !Number.isSafeInteger(result.originalRowsUnavailableBySessionEnd)
      || result.missingUnverifiedSourceMinuteSlots < 0
      || result.originalRowsUnavailableBySessionEnd > result.sourceMinuteRows
      || result.archivedRevisionCount !== 1
      || !SHA.test(result.archiveSourceDigestSha256??"")
      || !Number.isSafeInteger(result.sourceMinuteRows)
      || result.sourceMinuteRows < 1
      || result.sourceMinuteRows > 1440
      || result.sessionExpectedMinuteSlots !==
         (session.endMs-session.startMs)/MINUTE
      || result.sourceMinuteRows + result.missingUnverifiedSourceMinuteSlots
         !== result.sessionExpectedMinuteSlots) {
      totals.unreadableSessionCount++; bucket.unreadable++;
      warnings.push({ selectionDate: session.selectionDate, sessionStartMs: session.startMs,
        reason:"ARCHIVE_SESSION_PROVENANCE_MISMATCH" });
      unreadableSourceReviewPlan.push(Object.freeze({
        ...planIdentity(session),action:"REVIEW_SOURCE_PROVENANCE_MISMATCH",
        providerGETCount:0,autoExecuteAllowed:false,
      }));
      continue;
    }
    totals.archivedSessionCount++; bucket.sourcePresent++;
    totals.originalOneMinuteRows += result.sourceMinuteRows;
    // Presence of an original OHLCV row is distinct from its historical
    // as-of availability. Never relabel later-fetched rows as missing files.
    totals.sourceUnverifiedOneMinuteSlots +=
      result.missingUnverifiedSourceMinuteSlots;
    totals.retrospectiveUnavailableOneMinuteRows +=
      result.originalRowsUnavailableBySessionEnd;
    if (result.originalMinuteObservationTimesRetrospective) {
      totals.retrospectiveSourceSessionCount++;
      bucket.retrospectiveSourceSessions++;
    }
    if (!result.nativeMinuteSlotInventoryComplete) {
      totals.sourceLimitedSessionCount++; bucket.sourceLimited++;
      // The existing --retry-partial requires this exact immutable SHA.
      // Missing minute slots are not independently proven zero-trade gaps.
      partialRetryReviewPlan.push(Object.freeze({
        ...planIdentity(session),
        action:"REVIEW_PARTIAL_NATIVE_MINUTE_RETRY",
        reason:"UNVERIFIED_MISSING_NATIVE_MINUTE_SLOTS",
        expectedExistingSourceDigestSha256:result.archiveSourceDigestSha256,
        priorOriginalMinuteRows:result.sourceMinuteRows,
        missingUnverifiedMinuteSlots:result.missingUnverifiedSourceMinuteSlots,
        captureIsRetrospective:result.originalMinuteObservationTimesRetrospective,
        proposedProvider,sourceReadRequiresExplicitConsent:true,
        independentPITRosterRequired:true,
        sourceNoTradeGapEvidenceVerified:false,
        sourceRevisionAutoSelected:false,
        providerGETCount:0,autoExecuteAllowed:false,
      }));
    }
  }
  const issues = totals.missingSessionCount + totals.revisionConflictSessionCount
    + totals.unreadableSessionCount + totals.sourceLimitedSessionCount;
  return safe({
    ...summary,
    status: issues ? "SOURCE_WINDOW_INCOMPLETE_OR_CONFLICTED"
      : "SOURCE_PRESENT_BUT_NOT_INDEPENDENTLY_AUTHENTICATED",
    stockCalendarStatus: isCrypto
      ? "CRYPTO_UTC_DATES_ONLY_NOT_PIT_MEMBERSHIP"
      : "CALLER_PROVIDED_STOCK_SESSIONS_UNAUTHENTICATED",
    requestedSessionCount: selectedSessions.length,
    ...totals, missingCollectionPlan:Object.freeze(missingCollectionPlan),
    partialRetryReviewPlan:Object.freeze(partialRetryReviewPlan),
    revisionReviewPlan:Object.freeze(revisionReviewPlan),
    unreadableSourceReviewPlan:Object.freeze(unreadableSourceReviewPlan),
    incrementalRecoveryStatus:issues
      ?"REVIEW_MISSING_PARTIAL_OR_CONFLICTED_ORIGINALS"
      :"NO_MISSING_NATIVE_MINUTE_SLOTS_ON_REPORTED_SESSIONS",
    proposedProvider,
    publicHistoryGETAuthorized:false,
    providerGETCount:0,autoExecuteAllowed:false,
    sourceLicenseAndReuseRightsIndependentlyVerified:false,
    warningsPreview: warnings.slice(0, 50),
    additionalWarningsOmitted: Math.max(0, warnings.length - 50),
    monthlyCoverage: Object.fromEntries(Object.entries(monthly)),
    noTradeMinuteEvidenceVerified: false,
    sourceSlotInventoryIsNotAsOfScannerAvailabilityProof: true,
    originalScannerEarlyDiscoveryVerified: false,
  });
}
