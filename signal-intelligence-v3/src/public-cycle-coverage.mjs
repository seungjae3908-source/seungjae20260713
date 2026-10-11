/**
 * Public-only Signal V3 coverage planning. Discovery status and prospective
 * trading signal authority are separate. A KRX roster with explicitly
 * excluded unsupported symbols cannot count as ALL MARKET COMPLETE, but
 * its fully attempted eligible pages need not starve forever at cursor 0.
 */
export const PUBLIC_CYCLE_COVERAGE_POLICY_VERSION = 'public-cycle-coverage-v1';
// The Signal V3 research-only Spot cycle makes several public Upbit
// candle/context/book reads per symbol. This is the bounded stage-2 budget,
// NOT the all-eligible-KRW ticker roster size (discovered independently).
export const PUBLIC_V3_SPOT_STAGE_TWO_LIMIT = 5;
const TRUSTED_ROSTER_SOURCES = new Set([
  'krx-symbol-master', 'finnhub-symbol-master',
  'nasdaq-trader-public-directory', 'upbit-public', 'bitget-public',
]);
const INVALID_SOURCE_OUTCOMES = new Set([
  'PROVIDER_FAILURE', 'REQUEST_TIMEOUT', 'UNIVERSE_EMPTY',
  'SYMBOL_MAPPING_FAILURE', 'DATA_QUALITY_REJECT', 'FRONTEND_RENDER_FAILURE',
]);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const nonNegative = (value) => typeof value === 'number'
  && Number.isFinite(value) && value >= 0;

// HTTP Retry-After is either nonnegative delay seconds or an HTTP date.
// Invalid/overflow provider instructions must stop retries, never cause a
// high-rate fallback burst after a public HTTP 429.
export function parsePublicRetryAfterMs(value, nowMs = Date.now()) {
  if (value == null || String(value).trim() === '') return null;
  if (!Number.isFinite(nowMs) || nowMs < 0)
    throw new Error('PUBLIC_RETRY_AFTER_CLOCK_INVALID');
  const raw = String(value).trim();
  if (/^(?:0|[1-9]\\d*)(?:\\.\\d+)?$/u.test(raw)) {
    const delay = Math.ceil(Number(raw) * 1000);
    return Number.isSafeInteger(delay) ? delay : Number.POSITIVE_INFINITY;
  }
  const date = /^.+ GMT$/iu.test(raw) ? Date.parse(raw) : NaN;
  return Number.isFinite(date) ? Math.max(0, date - nowMs) : Number.POSITIVE_INFINITY;
}

// A full/no-trade classification requires proof that the requested source
// page was actually completed. A page that silently skips instruments must
// not be advertised as a completed zero-opportunity scan.
function pageEvidenceComplete(universe, execution) {
  if (!integer(universe?.totalCount) || universe.totalCount === 0
    || !integer(universe.cursor) || universe.cursor >= universe.totalCount
    || !integer(execution?.requestedCount) || execution.requestedCount === 0
    || !integer(execution.startedCount) || !integer(execution.completedCount)
    || execution.startedCount !== execution.requestedCount
    || execution.completedCount !== execution.requestedCount
    || execution.partial === true) return false;
  const end = universe.cursor + execution.requestedCount;
  if (end > universe.totalCount) return false;
  if (universe.nextCursor === null) return end === universe.totalCount;
  return integer(universe.nextCursor) && universe.nextCursor === end
    && end < universe.totalCount;
}

export function classifyPublicCycleLaneStatus(response) {
  if (!response || typeof response !== 'object') return 'SEARCH_FAILURE';
  const universe = response.universe;
  const execution = response.execution;
  if (!universe || !execution) return 'SEARCH_FAILURE';
  if (INVALID_SOURCE_OUTCOMES.has(response.outcome)
    || response.dataState === 'unavailable'
    || universe.stale === true
    || !nonNegative(execution.providerErrorCount) || execution.providerErrorCount > 0
    || !nonNegative(execution.timeoutCount) || execution.timeoutCount > 0
    || (universe.providerErrorCount != null
      && (!nonNegative(universe.providerErrorCount) || universe.providerErrorCount > 0))) {
    return 'SEARCH_FAILURE';
  }
  // A declared partial universe is an acknowledged data-coverage blocker,
  // not proof that ALL providers failed. NEVER silently create a PASS or a
  // no-trade result from excluded/unverified instruments.
  if (!pageEvidenceComplete(universe, execution)) return 'SEARCH_FAILURE';
  // A curated or stale fallback cannot certify an entire market, even if
  // another caller mislabels its aggregate dataState as complete.
  if (!TRUSTED_ROSTER_SOURCES.has(universe.source)) return 'BLOCKED_DATA';
  if (universe.partial === true
    || response.dataState === 'untrusted' || response.dataState === 'stale'
    || response.dataState === 'partial') return 'BLOCKED_DATA';
  if (response.dataState !== 'complete') return 'BLOCKED_DATA';
  if (!Array.isArray(response.cards)) return 'SEARCH_FAILURE';
  // Fail closed on a response whose declared outcome contradicts its cards;
  // do not create economic or no-trade evidence from a malformed envelope.
  if ((response.outcome === 'VALID_ZERO_SIGNAL' && response.cards.length > 0)
    || (response.outcome === 'CANDIDATES_AVAILABLE' && response.cards.length === 0))
    return 'SEARCH_FAILURE';
  return response.cards.length ? 'CANDIDATES_AVAILABLE' : 'VALID_NO_TRADE';
}

export function decidePublicCycleCursor({ response, status, cursor }) {
  const hold = (reason) => Object.freeze({
    nextCursor: cursor, blockedObservationOnly: false, reason,
  });
  if (!integer(cursor)) throw new Error('PUBLIC_CYCLE_CURSOR_INVALID');
  if (!response || typeof response !== 'object') return hold('SOURCE_MISSING');
  if (status !== classifyPublicCycleLaneStatus(response))
    return hold('STATUS_EVIDENCE_MISMATCH');
  const { universe, execution } = response;
  if (!universe || !execution) return hold('EVIDENCE_MISSING');
  if (status === 'SEARCH_FAILURE') return hold('PROVIDER_FAILURE');
  if (!integer(universe.totalCount) || universe.totalCount === 0
    || !integer(universe.cursor) || universe.cursor !== cursor
    || !integer(execution.requestedCount) || execution.requestedCount === 0
    || !integer(execution.startedCount)
    || !integer(execution.completedCount)
    || execution.startedCount !== execution.requestedCount
    || execution.completedCount !== execution.requestedCount
    || !integer(execution.providerErrorCount) || execution.providerErrorCount !== 0
    || !integer(execution.timeoutCount) || execution.timeoutCount !== 0
    || universe.stale === true) return hold('INCOMPLETE_OR_STALE_BATCH');
  const expectedEnd = cursor + execution.requestedCount;
  if (expectedEnd > universe.totalCount) return hold('BATCH_EXCEEDS_UNIVERSE');
  if (universe.nextCursor === null && expectedEnd !== universe.totalCount)
    return hold('PREMATURE_UNIVERSE_END');
  const after = universe.nextCursor === null ? 0 : universe.nextCursor;
  if (!integer(after) || after > universe.totalCount
    || (after !== 0 && after !== expectedEnd))
    return hold('CURSOR_NOT_MONOTONIC');
  if (status === 'CANDIDATES_AVAILABLE' || status === 'VALID_NO_TRADE') {
    if (universe.partial === true || execution.partial === true
      || response.dataState !== 'complete') return hold('NOT_FULLY_VERIFIED');
    return Object.freeze({
      nextCursor: after, blockedObservationOnly: false, reason: 'VERIFIED_BATCH',
    });
  }
  // Resource-limited full-universe research: record that this batch was
  // ATTEMPTED but explicitly blocked. Never create candidates or earnings
  // credit from these pages. Stale fallback and unknown sources cannot rotate.
  if (status === 'BLOCKED_DATA'
    && typeof universe.source === 'string'
    && TRUSTED_ROSTER_SOURCES.has(universe.source)) {
    return Object.freeze({
      nextCursor: after, blockedObservationOnly: true,
      reason: 'BLOCKED_RESEARCH_ROTATION_ONLY',
    });
  }
  return hold('BLOCKED_WITHOUT_PROVEN_ROSTER');
}
