export type MarketMoversMarket = 'KR' | 'US';

type MarketMoversCurrency = 'KRW' | 'USD';

export interface MarketMoverRow {
  ticker: string;
  name: string;
  market: MarketMoversMarket;
  currency: MarketMoversCurrency;
  price: number;
  changePercent: number;
  tradingValue?: number;
  volume?: number;
  rating?: { score?: number };
  [key: string]: unknown;
}

export interface MarketMoversResponse {
  market: MarketMoversMarket;
  provider: 'live-market-providers';
  dataStatus: 'complete' | 'partial';
  popular: MarketMoverRow[];
  volume: MarketMoverRow[];
  recommended: MarketMoverRow[];
  gainers: MarketMoverRow[];
  losers: MarketMoverRow[];
  risky: MarketMoverRow[];
  updatedAt: string;
  diagnostics?: unknown;
  rankingSource?: Record<string, string>;
}

const MAX_AGE_MS = 2 * 60_000;
const MAX_FUTURE_SKEW_MS = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function expectedCurrency(market: MarketMoversMarket): MarketMoversCurrency {
  return market === 'KR' ? 'KRW' : 'USD';
}

function isBaseRow(value: unknown, market: MarketMoversMarket): value is MarketMoverRow {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.ticker) || !isNonEmptyString(value.name)) return false;
  if (value.market !== market || value.currency !== expectedCurrency(market)) return false;
  if (!isFiniteNumber(value.price) || value.price <= 0) return false;
  if (!isFiniteNumber(value.changePercent)) return false;
  return true;
}

function isRows(value: unknown, market: MarketMoversMarket): value is MarketMoverRow[] {
  return Array.isArray(value) && value.every((row) => isBaseRow(row, market));
}

function hasFiniteNonNegative(value: unknown): boolean {
  return isFiniteNumber(value) && value >= 0;
}

function validUpdatedAt(value: unknown, nowMs: number): value is string {
  if (!isNonEmptyString(value)) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  if (timestamp > nowMs + MAX_FUTURE_SKEW_MS) return false;
  if (nowMs - timestamp > MAX_AGE_MS) return false;
  return true;
}

/**
 * HTTP 200 is transport success only. `/market/movers` drives investment-facing
 * ranking labels, so malformed/stale payloads must never degrade into a normal
 * empty list or into rankings whose required basis is missing.
 */
export function requireMarketMoversResponse(
  value: unknown,
  expectedMarket: MarketMoversMarket,
  nowMs = Date.now(),
): MarketMoversResponse {
  if (!isRecord(value)) throw new Error('INVALID_MARKET_MOVERS_RESPONSE');
  if (value.market !== expectedMarket) throw new Error('INVALID_MARKET_MOVERS_RESPONSE');
  if (value.provider !== 'live-market-providers') throw new Error('INVALID_MARKET_MOVERS_RESPONSE');
  if (value.dataStatus !== 'complete' && value.dataStatus !== 'partial') {
    throw new Error('INVALID_MARKET_MOVERS_RESPONSE');
  }
  if (!validUpdatedAt(value.updatedAt, nowMs)) throw new Error('INVALID_MARKET_MOVERS_RESPONSE');

  if (!isRows(value.popular, expectedMarket)
    || !isRows(value.volume, expectedMarket)
    || !isRows(value.recommended, expectedMarket)
    || !isRows(value.gainers, expectedMarket)
    || !isRows(value.losers, expectedMarket)
    || !isRows(value.risky, expectedMarket)) {
    throw new Error('INVALID_MARKET_MOVERS_RESPONSE');
  }

  // The canonical backend returns 503 when no live rows exist. Therefore an
  // all-empty HTTP 200 is not a legitimate "no candidates" success state.
  if (value.popular.length === 0
    || value.volume.length === 0
    || value.recommended.length === 0
    || value.gainers.length === 0
    || value.losers.length === 0
    || value.risky.length === 0) {
    throw new Error('INVALID_MARKET_MOVERS_RESPONSE');
  }

  if (!value.popular.every((row) => hasFiniteNonNegative(row.tradingValue))) {
    throw new Error('INVALID_MARKET_MOVERS_RESPONSE');
  }
  if (!value.volume.every((row) => hasFiniteNonNegative(row.volume))) {
    throw new Error('INVALID_MARKET_MOVERS_RESPONSE');
  }
  if (!value.recommended.every((row) => isRecord(row.rating) && isFiniteNumber(row.rating.score))) {
    throw new Error('INVALID_MARKET_MOVERS_RESPONSE');
  }

  return value as unknown as MarketMoversResponse;
}
