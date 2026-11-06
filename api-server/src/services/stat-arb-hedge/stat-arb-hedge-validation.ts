import { createHash } from 'node:crypto';
import {
  STAT_ARB_HEDGE_SIGNAL_SCHEMA,
  type HedgeExposure, type HedgeFxQuote, type HedgeInstrumentRules, type HedgeLegSpec, type HedgeLegState,
  type HedgeSignal, type HedgeVenue, type PerformanceEvidence, type PerformanceEvidenceRow,
  type PerformanceGateDecision, type PerformanceGateThresholds,
} from './stat-arb-hedge.types';

const DAY_MS = 86_400_000;
const SHA_RE = /^[0-9a-f]{40}$/u;

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Field-level schema validation. Returns block codes; empty = valid. */
export function validateHedgeSignalShape(signal: unknown): string[] {
  const codes: string[] = [];
  if (!signal || typeof signal !== 'object') return ['SIGNAL_NOT_OBJECT'];
  const s = signal as Record<string, unknown>;
  if (s.schema !== STAT_ARB_HEDGE_SIGNAL_SCHEMA) codes.push('SIGNAL_SCHEMA_MISMATCH');
  for (const key of ['strategyId', 'strategyVersion', 'parameterHash', 'signalId'] as const) {
    if (typeof s[key] !== 'string' || !(s[key] as string).trim()) codes.push(`SIGNAL_${key.toUpperCase()}_MISSING`);
  }
  if (typeof s.researchCodeSha !== 'string' || !SHA_RE.test(s.researchCodeSha)) codes.push('SIGNAL_RESEARCH_SHA_INVALID');
  for (const key of ['signalAtMs', 'dataAsOfMs', 'maxDataAgeMs', 'expiresAtMs'] as const) {
    if (!finitePositive(s[key])) codes.push(`SIGNAL_${key.toUpperCase()}_INVALID`);
  }
  if (s.action !== 'ENTER' && s.action !== 'EXIT') codes.push('SIGNAL_ACTION_INVALID');
  if (s.action === 'EXIT' && (typeof s.pairId !== 'string' || !s.pairId.trim())) codes.push('SIGNAL_EXIT_PAIR_ID_MISSING');
  if (!Array.isArray(s.legs) || s.legs.length !== 2) codes.push('SIGNAL_LEGS_COUNT_INVALID');
  else {
    const roles = new Set<string>();
    const ids = new Set<string>();
    for (const raw of s.legs as unknown[]) {
      const leg = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const id = typeof leg.legId === 'string' ? leg.legId : '?';
      if (ids.has(id)) codes.push(`LEG_ID_DUPLICATE:${id}`);
      ids.add(id);
      if (leg.role !== 'SPOT' && leg.role !== 'PERP') codes.push(`LEG_ROLE_INVALID:${id}`);
      else if (roles.has(leg.role)) codes.push(`LEG_ROLE_DUPLICATE:${leg.role}`);
      roles.add(String(leg.role));
      if (typeof leg.venue !== 'string') codes.push(`LEG_VENUE_MISSING:${id}`);
      if (leg.product !== 'spot' && leg.product !== 'usdt_perp') codes.push(`LEG_PRODUCT_INVALID:${id}`);
      if (typeof leg.symbol !== 'string' || !leg.symbol.trim()) codes.push(`LEG_SYMBOL_MISSING:${id}`);
      if (!['buy', 'sell', 'long', 'short'].includes(String(leg.side))) codes.push(`LEG_SIDE_INVALID:${id}`);
      if (!finitePositive(leg.quantity)) codes.push(`LEG_QUANTITY_INVALID:${id}`);
      if (!finitePositive(leg.referencePrice)) codes.push(`LEG_REFERENCE_PRICE_INVALID:${id}`);
      if (leg.priceType !== 'market' && leg.priceType !== 'limit') codes.push(`LEG_PRICE_TYPE_INVALID:${id}`);
      if (leg.priceType === 'limit' && !finitePositive(leg.limitPrice)) codes.push(`LEG_LIMIT_PRICE_INVALID:${id}`);
      if (leg.quoteCurrency !== 'KRW' && leg.quoteCurrency !== 'USDT') codes.push(`LEG_QUOTE_INVALID:${id}`);
    }
  }
  const fx = (s.fx && typeof s.fx === 'object' ? s.fx : {}) as Record<string, unknown>;
  if (!finitePositive(fx.krwPerUsdt)) codes.push('FX_RATE_INVALID');
  if (!finitePositive(fx.asOfMs)) codes.push('FX_AS_OF_INVALID');
  if (typeof fx.source !== 'string' || !fx.source.trim()) codes.push('FX_SOURCE_MISSING');
  if (!Number.isInteger(s.leverage) || (s.leverage as number) <= 0) codes.push('SIGNAL_LEVERAGE_INVALID');
  if (s.marginMode !== 'isolated') codes.push('SIGNAL_MARGIN_MODE_INVALID');
  return codes;
}

/** Freshness (fail-closed on stale data / expired signal / stale FX / clock skew). */
export function validateHedgeSignalFreshness(signal: HedgeSignal, nowMs: number, maxFxAgeMs: number): string[] {
  const codes: string[] = [];
  if (signal.dataAsOfMs > nowMs + 5_000) codes.push('SIGNAL_DATA_FROM_FUTURE');
  if (signal.signalAtMs < signal.dataAsOfMs) codes.push('SIGNAL_BEFORE_DATA');
  if (nowMs - signal.dataAsOfMs > signal.maxDataAgeMs) codes.push('SIGNAL_DATA_STALE');
  if (nowMs > signal.expiresAtMs) codes.push('SIGNAL_EXPIRED');
  if (nowMs - signal.fx.asOfMs > maxFxAgeMs) codes.push('FX_QUOTE_STALE');
  if (signal.fx.asOfMs > nowMs + 5_000) codes.push('FX_QUOTE_FROM_FUTURE');
  return codes;
}

/** One deterministic key per (user, strategy, signal, action, leg). The same
 * signal replayed yields the same clientOrderId, which both venues reject as a
 * duplicate; a different signal never collides. Prefix `sah-` keeps it apart
 * from the existing single-leg path (`sj-`). */
export function hedgeLegIdempotencyKey(userId: string, signal: Pick<HedgeSignal, 'strategyId' | 'signalId' | 'signalAtMs' | 'action'>, legId: string): string {
  return createHash('sha256')
    .update([userId, signal.strategyId, signal.signalId, String(signal.signalAtMs), signal.action, legId].join('|'))
    .digest('hex');
}

export function hedgeClientOrderId(venue: HedgeVenue, idempotencyKey: string): string {
  return `sah-${venue}-${idempotencyKey.slice(0, 20)}`;
}

export function hedgePairId(userId: string, signal: Pick<HedgeSignal, 'strategyId' | 'signalId' | 'signalAtMs'>): string {
  return createHash('sha256').update([userId, signal.strategyId, signal.signalId, String(signal.signalAtMs)].join('|')).digest('hex').slice(0, 24);
}

/** Round DOWN to the venue step so the sent size never exceeds what was approved. */
export function roundDownToStep(quantity: number, step: number): number {
  if (!(step > 0)) return quantity;
  const units = Math.floor(quantity / step + 1e-9);
  return Number((units * step).toFixed(12));
}

export function validateLegAgainstRules(leg: Pick<HedgeLegSpec, 'legId' | 'quantity' | 'priceType' | 'limitPrice' | 'referencePrice'>, rules: HedgeInstrumentRules): string[] {
  const codes: string[] = [];
  if (!rules.tradable) codes.push(`INSTRUMENT_NOT_TRADABLE:${leg.legId}`);
  const quantity = roundDownToStep(leg.quantity, rules.quantityStep);
  if (quantity <= 0) codes.push(`QUANTITY_BELOW_STEP:${leg.legId}`);
  if (rules.minQuantity > 0 && quantity < rules.minQuantity) codes.push(`QUANTITY_BELOW_MINIMUM:${leg.legId}`);
  const price = leg.priceType === 'limit' ? Number(leg.limitPrice) : leg.referencePrice;
  if (leg.priceType === 'limit' && rules.priceStep > 0
    && Math.abs(price / rules.priceStep - Math.round(price / rules.priceStep)) > 1e-8) codes.push(`PRICE_STEP:${leg.legId}`);
  if (rules.minNotional > 0 && price * quantity < rules.minNotional) codes.push(`NOTIONAL_BELOW_MINIMUM:${leg.legId}`);
  return codes;
}

export function legNotionalKrw(leg: Pick<HedgeLegSpec, 'quantity' | 'referencePrice' | 'quoteCurrency'>, fx: HedgeFxQuote): number {
  const price = leg.referencePrice;
  return leg.quoteCurrency === 'KRW' ? leg.quantity * price : leg.quantity * price * fx.krwPerUsdt;
}

/** Target-vs-actual exposure of both legs, in base units and KRW. */
export function computeHedgeExposure(
  spot: Pick<HedgeLegState, 'filledQuantity' | 'averagePrice' | 'referencePrice'>,
  perp: Pick<HedgeLegState, 'filledQuantity' | 'averagePrice' | 'referencePrice'>,
  fxKrwPerUsdt: number,
  maxImbalanceBps: number,
): HedgeExposure {
  const spotQuantity = spot.filledQuantity;
  const perpQuantity = perp.filledQuantity;
  const spotNotionalKrw = spotQuantity * (spot.averagePrice ?? spot.referencePrice);
  const perpNotionalKrw = perpQuantity * (perp.averagePrice ?? perp.referencePrice) * fxKrwPerUsdt;
  const imbalanceQuantity = Number((spotQuantity - perpQuantity).toFixed(12));
  const larger = Math.max(spotQuantity, perpQuantity);
  const imbalanceBps = larger > 0 ? Math.abs(imbalanceQuantity) / larger * 10_000 : 0;
  const balanced = larger === 0 ? spotQuantity === perpQuantity : imbalanceBps <= maxImbalanceBps;
  return Object.freeze({ spotQuantity, perpQuantity, spotNotionalKrw, perpNotionalKrw, imbalanceQuantity, imbalanceBps, balanced });
}

export function slippageBps(side: HedgeLegSpec['side'], referencePrice: number, averagePrice: number | null): number | null {
  if (averagePrice == null || !(referencePrice > 0)) return null;
  const adverse = side === 'buy' || side === 'long' ? averagePrice - referencePrice : referencePrice - averagePrice;
  return adverse / referencePrice * 10_000;
}

export const DEFAULT_PERFORMANCE_THRESHOLDS: PerformanceGateThresholds = Object.freeze({
  costProfile: 'current_public_assumed',
  minWindowDays: 180,
  minTrades: 30,
  minNetReturn: 0,
  minProfitFactor: 1,
  maxLiquidations: 0,
});

function windowDays(row: PerformanceEvidenceRow): number | null {
  const start = Date.parse(row.window_start);
  const end = Date.parse(row.window_end_exclusive);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return (end - start) / DAY_MS;
}

/**
 * Performance gate (directive §3): the PR #2004 data-quality + cost results are
 * the adapter's pass condition. Every matched row must pass; no matched row,
 * a code-sha mismatch, a non-OK status/data_verdict, or any failing metric
 * yields authority NONE. A strategy that failed validation never trades.
 */
export function evaluatePerformanceGate(
  evidence: PerformanceEvidence | null | undefined,
  signal: Pick<HedgeSignal, 'strategyId' | 'researchCodeSha' | 'leverage'>,
  thresholds: PerformanceGateThresholds = DEFAULT_PERFORMANCE_THRESHOLDS,
): PerformanceGateDecision {
  const reasons: string[] = [];
  if (!evidence) return Object.freeze({ authority: 'NONE', reasons: Object.freeze(['PERFORMANCE_EVIDENCE_MISSING']), matchedRows: Object.freeze([]) });
  if (evidence.researchCodeSha !== signal.researchCodeSha) reasons.push('PERFORMANCE_EVIDENCE_SHA_MISMATCH');
  const matched = evidence.rows.filter((row) =>
    row.strategy === signal.strategyId && Number(row.leverage) === signal.leverage && row.cost_profile === thresholds.costProfile);
  if (matched.length === 0) reasons.push('PERFORMANCE_EVIDENCE_NO_MATCHING_ROW');
  for (const row of matched) {
    const tag = row.window;
    if (row.status !== 'OK') reasons.push(`PERFORMANCE_STATUS_NOT_OK:${tag}:${row.status}`);
    if (row.data_verdict !== 'OK') reasons.push(`PERFORMANCE_DATA_VERDICT_NOT_OK:${tag}:${row.data_verdict}`);
    const days = windowDays(row);
    if (days == null || days < thresholds.minWindowDays) reasons.push(`PERFORMANCE_WINDOW_TOO_SHORT:${tag}`);
    if (!(Number(row.trades) >= thresholds.minTrades)) reasons.push(`PERFORMANCE_TRADES_TOO_FEW:${tag}`);
    if (!(Number(row.net_return) > thresholds.minNetReturn)) reasons.push(`PERFORMANCE_NET_RETURN_NOT_POSITIVE:${tag}`);
    if (row.pf_net == null || !(Number(row.pf_net) > thresholds.minProfitFactor)) reasons.push(`PERFORMANCE_PROFIT_FACTOR_LOW:${tag}`);
    if (Number(row.liquidations) > thresholds.maxLiquidations) reasons.push(`PERFORMANCE_LIQUIDATIONS:${tag}`);
  }
  const authority = reasons.length === 0 ? 'LIVE_ELIGIBLE' : 'NONE';
  return Object.freeze({ authority, reasons: Object.freeze([...new Set(reasons)]), matchedRows: Object.freeze(matched) });
}
