// Upbit omits 1-minute bars for minutes without a trade. A missing minute is therefore
// either "no trade" (legitimate) or "collection gap" (data loss). This pure verifier tells
// them apart by reconciling the day's minute bars with Upbit's own UTC-day candle:
// volume sum, high, low, first open and last close must all agree. Only then are the
// missing minutes certified as no-trade. Read-only; it never creates or alters data.

export const UPBIT_NO_TRADE_RECONCILE_SCHEMA = 'upbit-no-trade-reconcile-v1';
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
export const DEFAULT_MAX_NO_TRADE_MINUTES = 60;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const close = (a, b, rel = 1e-9, abs = 1e-12) => Math.abs(a - b) <= Math.max(abs, rel * Math.max(Math.abs(a), Math.abs(b)));
const hold = (code) => Object.freeze({ schema: UPBIT_NO_TRADE_RECONCILE_SCHEMA, status: 'HOLD', code });

/**
 * @param {{dayStartMs:number, minuteBars:Array<{timestamp:number,open:number,high:number,low:number,close:number,volume:number}>,
 *   dayCandle:{open:number,high:number,low:number,close:number,volume:number}, maxNoTradeMinutes?:number}} input
 */
export function reconcileUpbitNoTradeMinutesV1(input) {
  try {
    const { dayStartMs, minuteBars, dayCandle } = input ?? {};
    const maxNoTrade = input?.maxNoTradeMinutes ?? DEFAULT_MAX_NO_TRADE_MINUTES;
    if (!finite(dayStartMs) || dayStartMs % DAY_MS !== 0) return hold('DAY_START_NOT_UTC_DAY_ALIGNED');
    if (!Array.isArray(minuteBars) || !dayCandle) return hold('INPUT_INVALID');
    for (const k of ['open', 'high', 'low', 'close', 'volume']) if (!finite(dayCandle[k]) || dayCandle[k] < 0) return hold('DAY_CANDLE_INVALID');
    if (!Number.isInteger(maxNoTrade) || maxNoTrade < 0 || maxNoTrade > 1440) return hold('MAX_NO_TRADE_INVALID');

    const seen = new Set();
    let volume = 0; let high = -Infinity; let low = Infinity;
    let first = null; let last = null;
    for (const bar of minuteBars) {
      if (!bar || !finite(bar.timestamp) || bar.timestamp % MINUTE_MS !== 0) return hold('MINUTE_BAR_MISALIGNED');
      if (bar.timestamp < dayStartMs || bar.timestamp >= dayStartMs + DAY_MS) return hold('MINUTE_BAR_OUTSIDE_DAY');
      if (seen.has(bar.timestamp)) return hold('MINUTE_BAR_DUPLICATE');
      for (const k of ['open', 'high', 'low', 'close', 'volume']) if (!finite(bar[k]) || bar[k] < 0) return hold('MINUTE_BAR_INVALID');
      if (bar.high < bar.low || bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close)) return hold('MINUTE_BAR_INCONSISTENT');
      seen.add(bar.timestamp);
      volume += bar.volume; high = Math.max(high, bar.high); low = Math.min(low, bar.low);
      if (!first || bar.timestamp < first.timestamp) first = bar;
      if (!last || bar.timestamp > last.timestamp) last = bar;
    }

    const noTradeMinutes = [];
    for (let slot = 0; slot < 1440; slot += 1) {
      const ts = dayStartMs + slot * MINUTE_MS;
      if (!seen.has(ts)) noTradeMinutes.push(ts);
    }
    if (noTradeMinutes.length === 0) {
      return Object.freeze({ schema: UPBIT_NO_TRADE_RECONCILE_SCHEMA, status: 'COMPLETE', noTradeMinutes: Object.freeze([]), noTradeCount: 0, volumeReconciled: true });
    }
    if (noTradeMinutes.length === 1440) {
      // A whole day with no minute bars: only a zero-volume day candle can justify that.
      return dayCandle.volume === 0
        ? Object.freeze({ schema: UPBIT_NO_TRADE_RECONCILE_SCHEMA, status: 'HOLD', code: 'NO_TRADES_ALL_DAY_NEEDS_REVIEW' })
        : hold('DAY_EMPTY_BUT_DAY_CANDLE_HAS_VOLUME');
    }
    if (noTradeMinutes.length > maxNoTrade) return hold('TOO_MANY_MISSING_MINUTES');
    if (!close(volume, dayCandle.volume)) return hold('VOLUME_MISMATCH_COLLECTION_GAP');
    if (!close(high, dayCandle.high) || !close(low, dayCandle.low)) return hold('RANGE_MISMATCH_COLLECTION_GAP');
    if (!close(first.open, dayCandle.open) || !close(last.close, dayCandle.close)) return hold('OPEN_CLOSE_MISMATCH_COLLECTION_GAP');
    return Object.freeze({
      schema: UPBIT_NO_TRADE_RECONCILE_SCHEMA, status: 'VERIFIED_NO_TRADE_GAPS',
      noTradeMinutes: Object.freeze(noTradeMinutes), noTradeCount: noTradeMinutes.length, volumeReconciled: true,
    });
  } catch {
    return hold('RECONCILE_FAILED');
  }
}

/**
 * Pure: flat zero-volume bars for CERTIFIED no-trade minutes only (carry the previous close;
 * the first minute of the day carries the day open). Each bar is marked synthetic so no
 * consumer can mistake it for an observed trade. Returns null unless the proof is verified.
 */
export function fillVerifiedNoTradeBarsV1(minuteBars, proof, dayCandle) {
  if (!proof || proof.status !== 'VERIFIED_NO_TRADE_GAPS') return null;
  const byTs = new Map(minuteBars.map((b) => [b.timestamp, b]));
  const gaps = new Set(proof.noTradeMinutes);
  const all = [...minuteBars.map((b) => ({ ...b, synthetic: false }))];
  for (const ts of gaps) {
    const prior = [...byTs.keys()].filter((t) => t < ts).sort((a, b) => b - a)[0];
    const carry = prior === undefined ? dayCandle?.open : byTs.get(prior).close;
    if (!finite(carry) || carry <= 0) return null;
    all.push({ timestamp: ts, open: carry, high: carry, low: carry, close: carry, volume: 0, synthetic: true });
  }
  return all.sort((a, b) => a.timestamp - b.timestamp);
}
