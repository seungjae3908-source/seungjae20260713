import { createHash } from 'node:crypto';

// Prospective, coarse public-ticker excursion study. NOT a broker fill,
// realized return, bar high/low, order-flow proof, or trading admission.
export const WATCH_PROSPECTIVE_CONTRACT = 'public-watch-prospective-price-study-v1';
export const WATCH_PROSPECTIVE_POLICY = Object.freeze({
  targetMs: 20 * 60_000,
  closeToleranceMs: 3 * 60_000,
  minFutureSamples: 4,
  maxGapMs: 6 * 60_000,
  maxPending: 1_024,
});
const MARKETS = new Set(['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES']);
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_SYMBOL = /^[A-Z0-9][A-Z0-9._-]{0,31}$/u;
const SAFE_SOURCE = /^[A-Za-z0-9._-]{3,80}$/u;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const pos = (v) => finite(v) && v > 0;
const validAt = (v) => Number.isSafeInteger(v) && v > 0;
function round(value) { return Math.round(value * 10_000) / 10_000; }
function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
function freshPending(p, nowMs) {
  if (!object(p) || !SHA256.test(String(p.eventId ?? ''))
    || !MARKETS.has(p.market) || !SAFE_SYMBOL.test(String(p.symbol ?? ''))
    || !SAFE_SOURCE.test(String(p.source ?? ''))
    || !['UP', 'DOWN'].includes(p.direction)
    || !pos(p.referencePrice) || !pos(p.minSamplePrice) || !pos(p.maxSamplePrice)
    || !validAt(p.eventAtMs) || p.eventAtMs > nowMs + 5_000
    || !validAt(p.lastQuoteAtMs) || p.lastQuoteAtMs < p.eventAtMs
    || p.lastQuoteAtMs > nowMs + 5_000
    || !Number.isSafeInteger(p.sampleCount) || p.sampleCount < 0
    || p.sampleCount > 32
    || !Number.isSafeInteger(p.maxObservedGapMs) || p.maxObservedGapMs < 0
    || p.maxObservedGapMs > WATCH_PROSPECTIVE_POLICY.targetMs + WATCH_PROSPECTIVE_POLICY.closeToleranceMs) {
    throw new Error('WATCH_PROSPECTIVE_PENDING_INVALID');
  }
  return p;
}
function blocked(p, nowMs, reason) {
  const id = createHash('sha256')
    .update(WATCH_PROSPECTIVE_CONTRACT + ':' + p.eventId).digest('hex');
  return Object.freeze({
    contract: WATCH_PROSPECTIVE_CONTRACT, outcomeId: id,
    eventId: p.eventId, market: p.market, symbol: p.symbol,
    direction: p.direction, source: p.source,
    kind: 'PUBLIC_PRICE_OBSERVATION_ONLY', status: 'BLOCKED_DATA', reason,
    eventAtMs: p.eventAtMs, evaluatedAtMs: nowMs,
    horizonTargetMs: WATCH_PROSPECTIVE_POLICY.targetMs,
    sampledElapsedMs: null, sampledFutureN: p.sampleCount,
    sampledFavorableExcursionPercent: null,
    sampledAdverseExcursionPercent: null,
    referencePrice: p.referencePrice, sourceTimeBound: true,
    economicEvidenceCredit: 0, paperCredit: 0, oosCredit: 0,
    executionAuthority: 'NONE', isTradingSignal: false,
    orderAllowed: false, profitabilityProven: false,
  });
}
function study(p, nowMs) {
  const gapToTarget = p.eventAtMs + WATCH_PROSPECTIVE_POLICY.targetMs - p.lastQuoteAtMs;
  if (p.sampleCount < WATCH_PROSPECTIVE_POLICY.minFutureSamples
    || p.maxObservedGapMs > WATCH_PROSPECTIVE_POLICY.maxGapMs
    || gapToTarget < 0 || gapToTarget > WATCH_PROSPECTIVE_POLICY.closeToleranceMs) {
    return blocked(p, nowMs, 'COARSE_CADENCE_OR_FRESHNESS_UNVERIFIED');
  }
  const up = p.direction === 'UP';
  const favorable = up ? (p.maxSamplePrice / p.referencePrice - 1) * 100
    : (1 - p.minSamplePrice / p.referencePrice) * 100;
  const adverse = up ? (p.minSamplePrice / p.referencePrice - 1) * 100
    : (1 - p.maxSamplePrice / p.referencePrice) * 100;
  const id = createHash('sha256')
    .update(WATCH_PROSPECTIVE_CONTRACT + ':' + p.eventId).digest('hex');
  return Object.freeze({
    contract: WATCH_PROSPECTIVE_CONTRACT, outcomeId: id,
    eventId: p.eventId, market: p.market, symbol: p.symbol,
    direction: p.direction, source: p.source,
    kind: 'PUBLIC_PRICE_OBSERVATION_ONLY', status: 'OBSERVED_COARSE',
    reason: 'TICKER_SNAPSHOTS_NOT_OHLC_OR_EXECUTION',
    eventAtMs: p.eventAtMs, evaluatedAtMs: nowMs,
    horizonTargetMs: WATCH_PROSPECTIVE_POLICY.targetMs,
    sampledElapsedMs: p.lastQuoteAtMs - p.eventAtMs,
    sampledFutureN: p.sampleCount,
    sampledFavorableExcursionPercent: round(favorable),
    sampledAdverseExcursionPercent: round(adverse),
    referencePrice: p.referencePrice, sourceTimeBound: true,
    economicEvidenceCredit: 0, paperCredit: 0, oosCredit: 0,
    executionAuthority: 'NONE', isTradingSignal: false,
    orderAllowed: false, profitabilityProven: false,
  });
}

/**
 * Advance pending discoveries using only independently observed future
 * public quote timestamps. No historical backfill, look-ahead, fills or PnL.
 * Call once per observation cycle; caller persists outputs before cursor.
 */
export function advancePublicWatchProspectiveEvidence({
  previousPending = [], sources = {}, discovered = [], nowMs,
}) {
  if (!validAt(nowMs) || !Array.isArray(previousPending)
    || previousPending.length > WATCH_PROSPECTIVE_POLICY.maxPending
    || !Array.isArray(discovered) || discovered.length > 48
    || !object(sources)) throw new Error('WATCH_PROSPECTIVE_INPUT_INVALID');

  // A bounded public source dictionary: each symbol has one latest timestamp.
  const indexes = new Map();
  for (const market of MARKETS) {
    const src = sources[market];
    if (!src || !['READY', 'PARTIAL_TICKERS', 'PARTIAL_UNIVERSE'].includes(src.status)
      || !SAFE_SOURCE.test(String(src.source ?? '')) || !Array.isArray(src.quotes)) continue;
    const lookup = new Map();
    for (const row of src.quotes.slice(0, 8_000)) {
      if (SAFE_SYMBOL.test(String(row.symbol ?? ''))
        && pos(row.price) && validAt(row.sourceAtMs)
        && row.sourceAtMs <= nowMs + 5_000) lookup.set(row.symbol, row);
    }
    indexes.set(market, { source: src.source, quotes: lookup });
  }
  const pending = [];
  const outcomes = [];
  const seen = new Set();
  for (const old of previousPending) {
    const p = freshPending(old, nowMs);
    if (seen.has(p.eventId)) throw new Error('WATCH_PROSPECTIVE_PENDING_DUPLICATE');
    seen.add(p.eventId);
    const matched = indexes.get(p.market);
    const sourceChanged = matched && matched.source !== p.source;
    if (sourceChanged) {
      outcomes.push(blocked(p, nowMs, 'PUBLIC_SOURCE_CHANGED'));
      continue;
    }
    let next = p;
    const quote = matched?.quotes.get(p.symbol);
    const deadline = p.eventAtMs + WATCH_PROSPECTIVE_POLICY.targetMs;
    if (quote && quote.sourceAtMs > p.lastQuoteAtMs
      && quote.sourceAtMs <= deadline && quote.sourceAtMs > p.eventAtMs) {
      next = Object.freeze({
        ...p, lastQuoteAtMs: quote.sourceAtMs,
        sampleCount: p.sampleCount + 1,
        maxObservedGapMs: Math.max(p.maxObservedGapMs, quote.sourceAtMs - p.lastQuoteAtMs),
        minSamplePrice: Math.min(p.minSamplePrice, quote.price),
        maxSamplePrice: Math.max(p.maxSamplePrice, quote.price),
      });
    }
    if (nowMs >= deadline) {
      // The final 3-minute slack allows coarse 2-minute snapshot observation,
      // but never incorporates quotes after the target horizon.
      if (next.lastQuoteAtMs >= deadline - WATCH_PROSPECTIVE_POLICY.closeToleranceMs) {
        outcomes.push(study(next, nowMs));
      } else if (nowMs >= deadline + WATCH_PROSPECTIVE_POLICY.closeToleranceMs) {
        outcomes.push(blocked(next, nowMs, 'FUTURE_QUOTES_MISSING_OR_LATE'));
      } else {
        pending.push(next);
      }
    } else {
      pending.push(next);
    }
  }
  let notTracked = 0;
  for (const d of discovered) {
    if (!object(d) || !SHA256.test(String(d.eventId ?? ''))
      || !MARKETS.has(d.market) || !SAFE_SYMBOL.test(String(d.symbol ?? ''))
      || !['UP','DOWN'].includes(d.direction)
      || !validAt(d.sourceAtMs) || d.sourceAtMs > nowMs + 5_000
      || !SAFE_SOURCE.test(String(d.source ?? ''))) {
      throw new Error('WATCH_PROSPECTIVE_DISCOVERY_INVALID');
    }
    if (seen.has(d.eventId)) continue;
    seen.add(d.eventId);
    const src = indexes.get(d.market);
    const quote = src?.quotes.get(d.symbol);
    // A discovery without an exact original source quotation cannot
    // manufacture a future study or an executable reference price.
    if (!src || src.source !== d.source || !quote
      || quote.sourceAtMs !== d.sourceAtMs || !pos(quote.price)
      || pending.length >= WATCH_PROSPECTIVE_POLICY.maxPending) {
      notTracked += 1;
      continue;
    }
    pending.push(Object.freeze({
      eventId: d.eventId, market: d.market, symbol: d.symbol,
      direction: d.direction, source: d.source,
      eventAtMs: d.sourceAtMs, lastQuoteAtMs: d.sourceAtMs,
      referencePrice: quote.price, minSamplePrice: quote.price,
      maxSamplePrice: quote.price, sampleCount: 0, maxObservedGapMs: 0,
    }));
  }
  return Object.freeze({
    contract: WATCH_PROSPECTIVE_CONTRACT,
    pending: Object.freeze(pending), outcomes: Object.freeze(outcomes),
    pendingCount: pending.length, notTrackedCount: notTracked,
    completedCoarse: outcomes.filter(x => x.status === 'OBSERVED_COARSE').length,
    blockedData: outcomes.filter(x => x.status === 'BLOCKED_DATA').length,
    safety: Object.freeze({
      priceSamplesOnly: true, liveTrading: false, orderAuthority: 'NONE',
      paperOrderAuthority: false, profitabilityProven: false,
      oosCredit: 0, feeAdjustedPnLProvided: false,
    }),
  });
}
