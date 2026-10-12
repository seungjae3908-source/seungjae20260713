import type { AnalysisMarket } from './analysis-selection';

export type ChartDisplayCurrency = 'USD' | 'KRW';
export type ChartFxQuote = { currency: 'USD' | 'USDT'; krwRate: number; source: string; asOf: string; quality: string };
export type ChartFxSnapshot = { quotes: ChartFxQuote[]; missing: string[]; fetchedAt: string };

export function nativeChartCurrency(market: AnalysisMarket): 'KRW' | 'USD' | 'USDT' {
  return market === 'US' ? 'USD' : market === 'BITGET' ? 'USDT' : 'KRW';
}

export function usableChartFx(quote: ChartFxQuote | undefined, now = Date.now()): ChartFxQuote | null {
  if (!quote || !Number.isFinite(quote.krwRate) || quote.krwRate <= 0 || !quote.source) return null;
  const age = now - Date.parse(quote.asOf);
  // USD closes over the weekend. Never present its last session quote as live.
  const maxAge = quote.currency === 'USD' ? 4 * 86_400_000 : 5 * 60_000;
  return Number.isFinite(age) && age >= -60_000 && age <= maxAge && !['STALE', 'UNAVAILABLE'].includes(quote.quality) ? quote : null;
}

export function chartDisplayValue(value: number | null | undefined, market: AnalysisMarket, display: ChartDisplayCurrency, quotes: readonly ChartFxQuote[], now = Date.now()): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const currency = nativeChartCurrency(market);
  if (currency === 'KRW' || display === 'USD') return value;
  const quote = usableChartFx(quotes.find(row => row.currency === currency), now);
  if (!quote) return null;
  const converted = value * quote.krwRate;
  // An overflow is not a financial quote; never display Infinity or NaN.
  return Number.isFinite(converted) ? converted : null;
}

export function formatChartMoney(value: number | null | undefined, market: AnalysisMarket, display: ChartDisplayCurrency = 'USD', quotes: readonly ChartFxQuote[] = [], now = Date.now()): string {
  const amount = chartDisplayValue(value, market, display, quotes, now);
  if (amount == null) return value == null || !Number.isFinite(value) ? '미제공' : '환율 미제공';
  const currency = nativeChartCurrency(market) === 'KRW' || display === 'KRW' ? 'KRW' : nativeChartCurrency(market);
  const digits = Math.abs(amount) < 1 ? 8 : currency === 'KRW' ? 0 : 2;
  const formatted = amount.toLocaleString('ko-KR', {
    minimumFractionDigits: currency === 'USD' ? 2 : 0,
    maximumFractionDigits: digits,
  });
  return currency === 'KRW' ? `${formatted}원` : currency === 'USD' ? `$${formatted}` : `${formatted} USDT`;
}
