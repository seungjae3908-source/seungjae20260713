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
  if (/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(raw)) {
    const delay = Math.ceil(Number(raw) * 1000);
    return Number.isSafeInteger(delay) ? delay : Number.POSITIVE_INFINITY;
  }
  const date = /^.+ GMT$/iu.test(raw) ? Date.parse(raw) : NaN;
  return Number.isFinite(date) ? Math.max(0, date - nowMs) : Number.POSITIVE_INFINITY;
}


// Upbit public quotation quotas are independent per endpoint/IP group.
// These conservative limits only apply to the isolated V3 Research worker.
export const PUBLIC_V3_UPBIT_GROUP_INTERVAL_MS = Object.freeze({
  market: 350, ticker: 350, candle: 250, orderbook: 350,
});

export function publicUpbitGroupForUrl(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  if (url.hostname !== 'api.upbit.com') return null;
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash)
    throw new Error('PUBLIC_V3_UPBIT_UNSAFE_ENDPOINT');
  const path = url.pathname;
  if (/^\/v1\/candles\/(?:days|minutes\/[0-9]+)$/u.test(path)) return 'candle';
  if (path === '/v1/orderbook' || path === '/v1/orderbook/instruments') return 'orderbook';
  if (path === '/v1/ticker') return 'ticker';
  if (path === '/v1/market/all') return 'market';
  throw new Error('PUBLIC_V3_UPBIT_UNSAFE_ENDPOINT');
}

function abortReason(signal) {
  return signal?.reason instanceof Error
    ? signal.reason : new Error('PUBLIC_V3_UPBIT_REQUEST_ABORTED');
}

function abortableGroupWait(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => { cleanup(); reject(abortReason(signal)); };
    timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export function createPublicUpbitGroupPacer({
  now = Date.now,
  wait = abortableGroupWait,
} = {}) {
  const states = new Map(Object.keys(PUBLIC_V3_UPBIT_GROUP_INTERVAL_MS).map(group =>
    [group, { nextAt: 0, tail: Promise.resolve() }]));
  const getState = group => {
    if (!states.has(group)) throw new Error('PUBLIC_V3_UPBIT_GROUP_UNSUPPORTED');
    return states.get(group);
  };
  return Object.freeze({
    async schedule(group, operation, signal) {
      const state = getState(group);
      const previous = state.tail;
      let unlock;
      state.tail = new Promise(resolve => { unlock = resolve; });
      await previous;
      try {
        if (signal?.aborted) throw abortReason(signal);
        while (now() < state.nextAt) {
          await wait(state.nextAt - now(), signal);
          if (signal?.aborted) throw abortReason(signal);
        }
        state.nextAt = now() + PUBLIC_V3_UPBIT_GROUP_INTERVAL_MS[group];
      } finally {
        // Rate-limit request STARTS; in-flight public transfers can overlap.
        unlock();
      }
      return operation();
    },
    cooldown(group, delayMs) {
      const state = getState(group);
      if (!Number.isFinite(delayMs) || delayMs < 0)
        throw new Error('PUBLIC_V3_UPBIT_COOLDOWN_INVALID');
      state.nextAt = Math.max(state.nextAt, now() + Math.ceil(delayMs));
    },
  });
}


// Single conservative IP market-data request lane for V3 public Bitget reads.
// The official market candle endpoint permits up to 20 requests/second per IP;
// use <=10 starts/second to leave headroom, with no member/Forward/Paper changes.
export const PUBLIC_V3_BITGET_MARKET_INTERVAL_MS = 100;
export function publicBitgetMarketEndpoint(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  if (url.hostname !== 'api.bitget.com') return null;
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash)
    throw new Error('PUBLIC_V3_BITGET_UNSAFE_ENDPOINT');
  if (!/^\/api\/v2\/mix\/market\/(?:tickers|candles|contracts|query-position-lever)$/u.test(url.pathname))
    throw new Error('PUBLIC_V3_BITGET_UNSAFE_ENDPOINT');
  return 'public-market';
}

export function createPublicBitgetMarketPacer({
  now = Date.now,
  wait = abortableGroupWait,
} = {}) {
  let nextStartAt = 0;
  let tail = Promise.resolve();
  return Object.freeze({
    async schedule(operation, signal) {
      const previous = tail;
      let unlock;
      tail = new Promise(resolve => { unlock = resolve; });
      await previous;
      try {
        if (signal?.aborted) throw abortReason(signal);
        while (now() < nextStartAt) {
          await wait(nextStartAt - now(), signal);
          if (signal?.aborted) throw abortReason(signal);
        }
        nextStartAt = now() + PUBLIC_V3_BITGET_MARKET_INTERVAL_MS;
      } finally {
        unlock();
      }
      return operation();
    },
    cooldown(delayMs) {
      if (!Number.isFinite(delayMs) || delayMs < 0)
        throw new Error('PUBLIC_V3_BITGET_COOLDOWN_INVALID');
      nextStartAt = Math.max(nextStartAt, now() + Math.ceil(delayMs));
    },
  });
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
    // Stock Scanner deliberately computes execution.partial as
    // raw.partial || universe.partial. A verified fully-attempted eligible
    // page with a known partial KRX roster is still BLOCKED_DATA, not a
    // technical SEARCH_FAILURE. Permit only its research-only cursor; never
    // grant a no-trade verdict, candidate or economic credit.
    || (execution.partial === true && universe.partial !== true)
    || execution.cancelled === true || execution.timedOut === true
    || execution.duplicate === true) return false;
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
  // An as-of/source roster may still be current while the underlying
  // candles/quotes are stale. Never skip those symbols or call the page
  // explored merely because the public ticker roster was reachable.
  if (status === 'BLOCKED_DATA' && response.dataState === 'stale')
    return hold('STALE_CANDLE_HOLD');
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
