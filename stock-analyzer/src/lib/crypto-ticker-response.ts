const CHANGE_VALUES = new Set(['RISE', 'EVEN', 'FALL']);
const MAX_SPOT_TICKER_AGE_MS = 2 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 1000;

export interface SpotCryptoTickerRow {
  market: string;
  symbol: string;
  price: number | null;
  change: 'RISE' | 'EVEN' | 'FALL';
  changeRate: number | null;
  changePercent: number | null;
  changePrice: number | null;
  high24h: number | null;
  low24h: number | null;
  volume24h: number | null;
  tradingValue24h: number | null;
  timestamp: number | null;
}

export interface SpotCryptoTickerResponse {
  exchange: 'UPBIT';
  quoteCurrency: 'KRW';
  tickers: SpotCryptoTickerRow[];
  count: number;
  updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isFreshTimestamp(value: unknown, nowMs: number): value is string {
  if (!isNonEmptyString(value)) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  if (parsed > nowMs + MAX_FUTURE_SKEW_MS) return false;
  if (nowMs - parsed > MAX_SPOT_TICKER_AGE_MS) return false;
  return true;
}

function isSpotTickerRow(value: unknown): value is SpotCryptoTickerRow {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.market) || !value.market.startsWith('KRW-')) return false;
  if (!isNonEmptyString(value.symbol)) return false;
  if (value.market !== `KRW-${value.symbol}`) return false;
  if (!CHANGE_VALUES.has(String(value.change))) return false;

  const nullableNumberKeys = [
    'price',
    'changeRate',
    'changePercent',
    'changePrice',
    'high24h',
    'low24h',
    'volume24h',
    'tradingValue24h',
    'timestamp',
  ] as const;

  return nullableNumberKeys.every(
    (key) => hasOwn(value, key) && isNullableFiniteNumber(value[key]),
  );
}

/**
 * HTTP 200 is transport success only. Upbit ticker data is investment-facing,
 * so malformed, stale, future-dated, or partially shaped success payloads must
 * fail closed instead of becoming a legitimate-looking empty/normal market state.
 */
export function requireSpotCryptoTickerResponse(
  payload: unknown,
  nowMs = Date.now(),
): SpotCryptoTickerResponse {
  if (!isRecord(payload)) throw new Error('INVALID_SPOT_CRYPTO_TICKER_RESPONSE');
  if (payload.exchange !== 'UPBIT' || payload.quoteCurrency !== 'KRW') {
    throw new Error('INVALID_SPOT_CRYPTO_TICKER_RESPONSE');
  }
  if (!Array.isArray(payload.tickers)) throw new Error('INVALID_SPOT_CRYPTO_TICKER_RESPONSE');
  if (!Number.isInteger(payload.count) || (payload.count as number) < 0) {
    throw new Error('INVALID_SPOT_CRYPTO_TICKER_RESPONSE');
  }
  if (payload.count !== payload.tickers.length) {
    throw new Error('INVALID_SPOT_CRYPTO_TICKER_RESPONSE');
  }
  if (!isFreshTimestamp(payload.updatedAt, nowMs)) {
    throw new Error('INVALID_SPOT_CRYPTO_TICKER_RESPONSE');
  }
  if (!payload.tickers.every(isSpotTickerRow)) {
    throw new Error('INVALID_SPOT_CRYPTO_TICKER_RESPONSE');
  }
  return payload as SpotCryptoTickerResponse;
}
