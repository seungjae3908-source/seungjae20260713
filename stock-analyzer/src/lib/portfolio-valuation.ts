import { evidenceNumber, evidenceRecord } from './server-evidence';
import { quoteFreshness } from './market-freshness';

export type PortfolioQuote = {
  currentPrice: number | null; changePercent: number | null; updatedAt: string | null; source: string | null;
  quoteStatus: 'FRESH' | 'STALE' | 'ARCHIVED' | 'UNKNOWN' | 'INVALID' | 'PROVIDER_UNAVAILABLE';
};
type Identity = { ticker: string; market: 'KR' | 'US'; currency: 'KRW' | 'USD' };
type Holding = Identity & { quantity: number; average_price: number; currentPrice: number | null };
const finite = (value: number): number | null => Number.isFinite(value) ? value : null;

export function portfolioQuote(quote: unknown, holding: Identity, now = Date.now()): PortfolioQuote {
  const empty: PortfolioQuote = { currentPrice: null, changePercent: null, updatedAt: null, source: null, quoteStatus: 'PROVIDER_UNAVAILABLE' };
  if (quote === undefined || quote === null) return empty;
  if (!evidenceRecord(quote) || quote.ticker !== holding.ticker || quote.market !== holding.market
    || quote.currency !== holding.currency || !evidenceNumber(quote.price) || quote.price <= 0) return { ...empty, quoteStatus: 'INVALID' };
  const source = typeof quote.source === 'string' && quote.source.trim() ? quote.source : null;
  const time = quoteFreshness(quote, now);
  const freshness = evidenceRecord(quote.freshness) ? quote.freshness.status : null;
  const quoteStatus = freshness === 'PROVIDER_UNAVAILABLE' ? 'PROVIDER_UNAVAILABLE'
    : time.label === '시세 시각 오류' ? 'INVALID'
      : !time.timestamp || !source ? 'UNKNOWN'
        : freshness === 'ARCHIVED' ? 'ARCHIVED'
          : freshness === 'STALE' || now - Date.parse(time.timestamp) > 300_000 ? 'STALE' : 'FRESH';
  return { source, updatedAt: time.timestamp, quoteStatus,
    currentPrice: quoteStatus === 'FRESH' ? quote.price : null,
    changePercent: quoteStatus === 'FRESH' && evidenceNumber(quote.changePercent) ? quote.changePercent : null };
}

export function portfolioTotals(rows: Holding[]) {
  return (['KRW', 'USD'] as const).flatMap((currency) => {
    const group = rows.filter((row) => row.currency === currency);
    if (!group.length) return [];
    const cost = finite(group.reduce((sum, row) => sum + row.quantity * row.average_price, 0));
    const value = group.some((row) => row.currentPrice === null) ? null
      : finite(group.reduce((sum, row) => sum + row.quantity * row.currentPrice!, 0));
    const profit = value === null || cost === null ? null : finite(value - cost);
    const rate = profit === null || cost === null || cost <= 0 ? null : finite(profit / cost * 100);
    return [{ currency, count: group.length, cost, value, profit, rate }];
  });
}
