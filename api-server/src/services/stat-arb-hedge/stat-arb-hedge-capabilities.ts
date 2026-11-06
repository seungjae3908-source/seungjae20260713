import type { HedgeLegSpec, HedgeProduct, HedgeSignal, HedgeVenue } from './stat-arb-hedge.types';

/**
 * Venue capability matrix as verified in THIS repository's order path on
 * 2026-10-20 (trade-exchange-adapters.service.ts, trade-automation-risk.service.ts):
 *
 * - upbit:   KRW spot only. Automatic entries are BUY only; SELL is an exit.
 *            5,000 KRW minimum, 8-decimal volume. No margin, no short.
 * - bitget:  USDT-FUTURES only, one-way isolated, leverage 2–7 live
 *            (1x blocked live), hedge_mode rejected, duplicate clientOid rejected.
 *            Bitget SPOT has no adapter in this repository.
 * - binance / hyperliquid: NO adapter in this repository (research data only).
 *
 * The matrix is therefore honest about what exists; it is not a wish list.
 */
export type VenueCapability = Readonly<{
  products: readonly HedgeProduct[];
  quote: 'KRW' | 'USDT' | null;
  canShort: boolean;
  automaticSpotEntrySides: readonly ('buy' | 'sell')[];
  liveLeverageMin: number | null;
  liveLeverageMax: number | null;
  adapterPresent: boolean;
}>;

export const HEDGE_VENUE_CAPABILITIES: Readonly<Record<HedgeVenue, VenueCapability>> = Object.freeze({
  upbit: Object.freeze({
    products: Object.freeze(['spot'] as const), quote: 'KRW', canShort: false,
    automaticSpotEntrySides: Object.freeze(['buy'] as const),
    liveLeverageMin: null, liveLeverageMax: null, adapterPresent: true,
  }),
  bitget: Object.freeze({
    products: Object.freeze(['usdt_perp'] as const), quote: 'USDT', canShort: true,
    automaticSpotEntrySides: Object.freeze([] as const),
    liveLeverageMin: 2, liveLeverageMax: 7, adapterPresent: true,
  }),
  binance: Object.freeze({
    products: Object.freeze([] as const), quote: null, canShort: false,
    automaticSpotEntrySides: Object.freeze([] as const),
    liveLeverageMin: null, liveLeverageMax: null, adapterPresent: false,
  }),
  hyperliquid: Object.freeze({
    products: Object.freeze([] as const), quote: null, canShort: false,
    automaticSpotEntrySides: Object.freeze([] as const),
    liveLeverageMin: null, liveLeverageMax: null, adapterPresent: false,
  }),
});

/** The ONLY hedge structure the current order path can carry:
 * long Upbit KRW spot (BUY) + short Bitget USDT perpetual (isolated). */
export const SUPPORTED_HEDGE_COMBINATIONS = Object.freeze([
  Object.freeze({
    id: 'carry_upbit_spot_long__bitget_perp_short',
    spot: Object.freeze({ venue: 'upbit' as const, product: 'spot' as const, entrySide: 'buy' as const, exitSide: 'sell' as const }),
    perp: Object.freeze({ venue: 'bitget' as const, product: 'usdt_perp' as const, entrySide: 'short' as const, exitSide: 'long' as const }),
  }),
]);

export type SupportedHedgeCombination = (typeof SUPPORTED_HEDGE_COMBINATIONS)[number];

export type HedgeCapabilityDecision = Readonly<{
  supported: boolean;
  combination: SupportedHedgeCombination | null;
  blockCodes: readonly string[];
}>;

function legByRole(signal: HedgeSignal, role: 'SPOT' | 'PERP'): HedgeLegSpec | null {
  return signal.legs.find((leg) => leg.role === role) ?? null;
}

/** Fail-closed: anything not on the matrix is UNSUPPORTED_HEDGE_COMBINATION. */
export function evaluateHedgeCapability(signal: HedgeSignal): HedgeCapabilityDecision {
  const codes: string[] = [];
  const spot = legByRole(signal, 'SPOT');
  const perp = legByRole(signal, 'PERP');
  if (!spot || !perp || signal.legs.length !== 2) {
    return Object.freeze({ supported: false, combination: null, blockCodes: Object.freeze(['HEDGE_LEGS_MUST_BE_SPOT_AND_PERP']) });
  }
  for (const leg of [spot, perp]) {
    const cap = HEDGE_VENUE_CAPABILITIES[leg.venue];
    if (!cap) { codes.push(`VENUE_UNKNOWN:${leg.legId}`); continue; }
    if (!cap.adapterPresent) codes.push(`VENUE_ADAPTER_MISSING:${leg.venue}`);
    if (!cap.products.includes(leg.product)) codes.push(`VENUE_PRODUCT_UNSUPPORTED:${leg.venue}:${leg.product}`);
    if (cap.quote && leg.quoteCurrency !== cap.quote) codes.push(`VENUE_QUOTE_MISMATCH:${leg.venue}:${leg.quoteCurrency}`);
  }
  const combination = SUPPORTED_HEDGE_COMBINATIONS.find((c) =>
    c.spot.venue === spot.venue && c.spot.product === spot.product
    && c.perp.venue === perp.venue && c.perp.product === perp.product) ?? null;
  if (!combination) {
    codes.push('UNSUPPORTED_HEDGE_COMBINATION');
    return Object.freeze({ supported: false, combination: null, blockCodes: Object.freeze([...new Set(codes)]) });
  }
  const expectedSpotSide = signal.action === 'ENTER' ? combination.spot.entrySide : combination.spot.exitSide;
  const expectedPerpSide = signal.action === 'ENTER' ? combination.perp.entrySide : combination.perp.exitSide;
  if (spot.side !== expectedSpotSide) codes.push(`SPOT_SIDE_UNSUPPORTED:${spot.side}`);
  if (perp.side !== expectedPerpSide) codes.push(`PERP_SIDE_UNSUPPORTED:${perp.side}`);
  const perpCap = HEDGE_VENUE_CAPABILITIES[perp.venue];
  if (perpCap.liveLeverageMin != null && perpCap.liveLeverageMax != null
    && (!Number.isInteger(signal.leverage) || signal.leverage < perpCap.liveLeverageMin || signal.leverage > perpCap.liveLeverageMax)) {
    codes.push('PERP_LEVERAGE_OUTSIDE_LIVE_RANGE');
  }
  if (signal.marginMode !== 'isolated') codes.push('PERP_MARGIN_MODE_UNSUPPORTED');
  const supported = codes.length === 0;
  return Object.freeze({ supported, combination: supported ? combination : null, blockCodes: Object.freeze([...new Set(codes)]) });
}
