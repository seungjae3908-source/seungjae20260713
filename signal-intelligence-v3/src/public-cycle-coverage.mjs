/**
 * Public-only Signal V3 coverage planning. Discovery status and prospective
 * trading signal authority are separate. A KRX roster with explicitly
 * excluded unsupported symbols cannot count as ALL MARKET COMPLETE, but
 * its fully attempted eligible pages need not starve forever at cursor 0.
 */
export const PUBLIC_CYCLE_COVERAGE_POLICY_VERSION = 'public-cycle-coverage-v1';
const TRUSTED_ROSTER_SOURCES = new Set([
  'krx-symbol-master', 'finnhub-symbol-master',
  'nasdaq-trader-public-directory', 'upbit-public', 'bitget-public',
]);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const nonNegative = (value) => typeof value === 'number'
  && Number.isFinite(value) && value >= 0;

export function classifyPublicCycleLaneStatus(response) {
  if (!response || typeof response !== 'object') return 'SEARCH_FAILURE';
  const universe = response.universe;
  const execution = response.execution;
  if (!universe || !execution) return 'SEARCH_FAILURE';
  if (response.outcome === 'PROVIDER_FAILURE' || response.outcome === 'REQUEST_TIMEOUT'
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
  if (universe.partial === true || execution.partial === true
    || response.dataState === 'untrusted' || response.dataState === 'stale'
    || response.dataState === 'partial') return 'BLOCKED_DATA';
  if (response.dataState !== 'complete') return 'BLOCKED_DATA';
  if (!Array.isArray(response.cards)) return 'SEARCH_FAILURE';
  return response.cards.length ? 'CANDIDATES_AVAILABLE' : 'VALID_NO_TRADE';
}

export function decidePublicCycleCursor({ response, status, cursor }) {
  const hold = (reason) => Object.freeze({
    nextCursor: cursor, blockedObservationOnly: false, reason,
  });
  if (!integer(cursor)) throw new Error('PUBLIC_CYCLE_CURSOR_INVALID');
  if (!response || typeof response !== 'object') return hold('SOURCE_MISSING');
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
  const after = universe.nextCursor === null ? 0 : universe.nextCursor;
  if (!integer(after) || after > universe.totalCount
    || (after !== 0 && after <= cursor)) return hold('CURSOR_NOT_MONOTONIC');
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
