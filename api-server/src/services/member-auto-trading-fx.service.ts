import { getIndexQuote as getYahooIndexQuote } from '../providers/yahoo';
import { fetchPublicMarketJson } from './public-market-http';

export type MemberAutoTradingFxMarket =
  | 'KR_STOCK'
  | 'US_STOCK'
  | 'CRYPTO_SPOT'
  | 'CRYPTO_FUTURES';

type YahooQuoteLoader = (ticker: string) => Promise<{ price: number; updatedAt: string }>;
type PublicJsonLoader = typeof fetchPublicMarketJson;

export type MemberAutoTradingFxQuote = Readonly<{
  market: MemberAutoTradingFxMarket;
  krwPerQuoteCurrency: number;
  source: string;
  observedAt: string;
  stale: false;
}>;

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function timestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 100_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function assertFresh(observedAtMs: number | null, nowMs: number, maxAgeMs: number, code: string) {
  if (observedAtMs == null || observedAtMs > nowMs || nowMs - observedAtMs > maxAgeMs) {
    throw new Error(code);
  }
}

export async function resolveMemberAutoTradingKrwRate(
  market: MemberAutoTradingFxMarket,
  options: {
    nowMs?: number;
    yahooQuote?: YahooQuoteLoader;
    publicJson?: PublicJsonLoader;
  } = {},
): Promise<MemberAutoTradingFxQuote> {
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs) || nowMs <= 0) throw new Error('BACKGROUND_FX_CLOCK_INVALID');

  if (market === 'KR_STOCK' || market === 'CRYPTO_SPOT') {
    return Object.freeze({
      market,
      krwPerQuoteCurrency: 1,
      source: 'NATIVE_KRW',
      observedAt: new Date(nowMs).toISOString(),
      stale: false,
    });
  }

  if (market === 'US_STOCK') {
    const quote = await (options.yahooQuote ?? getYahooIndexQuote)('USDKRW=X');
    const price = Number(quote.price);
    const observedAtMs = timestamp(quote.updatedAt);
    if (!positive(price)) throw new Error('BACKGROUND_USDKRW_RATE_INVALID');
    assertFresh(observedAtMs, nowMs, 24 * 60 * 60_000, 'BACKGROUND_USDKRW_RATE_STALE');
    return Object.freeze({
      market,
      krwPerQuoteCurrency: price,
      source: 'YAHOO:USDKRW=X',
      observedAt: new Date(observedAtMs!).toISOString(),
      stale: false,
    });
  }

  const payload = await (options.publicJson ?? fetchPublicMarketJson)(
    'https://api.upbit.com/v1/ticker?markets=KRW-USDT',
    { provider: 'UPBIT_USDT_KRW', timeoutMs: 4_000 },
  );
  const row = Array.isArray(payload) ? payload[0] : null;
  const value = row && typeof row === 'object' ? row as Record<string, unknown> : null;
  const price = Number(value?.trade_price);
  const observedAtMs = timestamp(value?.timestamp ?? value?.trade_timestamp);
  if (!positive(price)) throw new Error('BACKGROUND_USDTKRW_RATE_INVALID');
  assertFresh(observedAtMs, nowMs, 10 * 60_000, 'BACKGROUND_USDTKRW_RATE_STALE');
  return Object.freeze({
    market,
    krwPerQuoteCurrency: price,
    source: 'UPBIT:KRW-USDT',
    observedAt: new Date(observedAtMs!).toISOString(),
    stale: false,
  });
}
