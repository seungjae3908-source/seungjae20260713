import MarketDataService from './market-data.service';
import { getFuturesMarketSnapshot } from './futures-market-data.service';

export type MemberAutoTradingMarket =
  | 'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES';

export type MemberAutoTradingMarketMark = Readonly<{
  market: MemberAutoTradingMarket;
  symbol: string;
  price: number;
  observedAt: string;
  source: string;
}>;

type StockQuoteReader = (symbol: string) => Promise<Record<string, unknown>>;
type FuturesSnapshotReader = (symbol: string) => Promise<{
  price: number | null;
  markPrice: number | null;
  updatedAt: string;
  source: string;
  isDelayed: boolean;
}>;

export type MemberAutoTradingMarketMarkDependencies = {
  stockQuoteReader?: StockQuoteReader;
  futuresSnapshotReader?: FuturesSnapshotReader;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

function finitePositive(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function observedAt(value: unknown, now: Date, maximumAgeMs: number) {
  const parsed = Date.parse(String(value ?? ''));
  if (!Number.isFinite(parsed)) throw new Error('BACKGROUND_EXIT_MARK_TIMESTAMP_REQUIRED');
  if (parsed > now.getTime() + 5_000) throw new Error('BACKGROUND_EXIT_MARK_FROM_FUTURE');
  if (now.getTime() - parsed > maximumAgeMs) throw new Error('BACKGROUND_EXIT_MARK_STALE');
  return new Date(parsed).toISOString();
}

function upbitMarket(symbol: string) {
  const clean = symbol.trim().toUpperCase();
  if (/^KRW-[A-Z0-9]{1,20}$/u.test(clean)) return clean;
  if (/^[A-Z0-9]{1,20}$/u.test(clean)) return `KRW-${clean}`;
  throw new Error('BACKGROUND_EXIT_UPBIT_SYMBOL_INVALID');
}

export function createMemberAutoTradingMarketMarkReader(
  dependencies: MemberAutoTradingMarketMarkDependencies = {},
) {
  const stockQuoteReader: StockQuoteReader = dependencies.stockQuoteReader
    ?? (async (symbol) => MarketDataService.getQuote(symbol) as unknown as Record<string, unknown>);
  const futuresSnapshotReader = dependencies.futuresSnapshotReader ?? getFuturesMarketSnapshot;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const now = dependencies.now ?? (() => new Date());

  return async function readMark(
    market: MemberAutoTradingMarket,
    symbol: string,
  ): Promise<MemberAutoTradingMarketMark> {
    const cleanSymbol = symbol.trim().toUpperCase();
    if (!cleanSymbol) throw new Error('BACKGROUND_EXIT_MARK_SYMBOL_REQUIRED');
    const clock = now();

    if (market === 'KR_STOCK' || market === 'US_STOCK') {
      const quote = await stockQuoteReader(cleanSymbol);
      const price = finitePositive(quote.price);
      if (price == null) throw new Error('BACKGROUND_EXIT_STOCK_PRICE_REQUIRED');
      return Object.freeze({
        market,
        symbol: cleanSymbol,
        price,
        observedAt: observedAt(quote.updatedAt, clock, 60_000),
        source: String(quote.source ?? 'market-data-service'),
      });
    }

    if (market === 'CRYPTO_SPOT') {
      const providerMarket = upbitMarket(cleanSymbol);
      const url = new URL('https://api.upbit.com/v1/ticker');
      url.searchParams.set('markets', providerMarket);
      const response = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error('BACKGROUND_EXIT_UPBIT_MARK_UNAVAILABLE');
      const rows = await response.json() as unknown;
      const row = Array.isArray(rows) && rows[0] && typeof rows[0] === 'object'
        ? rows[0] as Record<string, unknown>
        : null;
      const price = finitePositive(row?.trade_price);
      const timestamp = Number(row?.timestamp);
      if (price == null || !Number.isFinite(timestamp) || timestamp <= 0) {
        throw new Error('BACKGROUND_EXIT_UPBIT_MARK_INVALID');
      }
      return Object.freeze({
        market,
        symbol: cleanSymbol.replace(/^KRW-/u, ''),
        price,
        observedAt: observedAt(new Date(timestamp).toISOString(), clock, 30_000),
        source: 'upbit-public-ticker',
      });
    }

    const snapshot = await futuresSnapshotReader(cleanSymbol);
    const price = finitePositive(snapshot.markPrice ?? snapshot.price);
    if (price == null || snapshot.isDelayed) throw new Error('BACKGROUND_EXIT_BITGET_MARK_UNAVAILABLE');
    return Object.freeze({
      market,
      symbol: cleanSymbol,
      price,
      observedAt: observedAt(snapshot.updatedAt, clock, 30_000),
      source: snapshot.source || 'bitget-public-v2',
    });
  };
}

export const readMemberAutoTradingMarketMark = createMemberAutoTradingMarketMarkReader();
