// Alpha Vantage provider: fundamentals (income statement, balance sheet) and
// daily price series used to compute technical signals.
// Docs: https://www.alphavantage.co/documentation/
// NOTE: free tier is ~25 requests/day, so every call is heavily cached.
import { getAlphaVantageKey } from '../lib/config';
import { ProviderError } from '../lib/errors';
import { fetchJson } from '../lib/http';
import { cached, TTL } from '../lib/cache';
import type { CatalogEntry } from '../data/catalog';

const BASE = 'https://www.alphavantage.co/query';

export interface Financials {
  revenue: number | null;
  operatingProfit: number | null;
  netProfit: number | null;
  cash: number | null;
  debt: number | null;
  fiscalDate: string | null;
}

export interface DailyBar {
  date: string;
  close: number;
  volume: number;
}

function toAvSymbol(entry: CatalogEntry): string {
  if (entry.market === 'US') return entry.ticker;
  return `${entry.ticker}.KSC`; // Alpha Vantage KRX suffix
}

// Alpha Vantage signals a hit rate limit via a "Note"/"Information" field.
function assertNotThrottled(data: Record<string, unknown>): void {
  if (data['Note'] || data['Information']) {
    throw new ProviderError('RATE_LIMITED', 'alphavantage');
  }
  if (data['Error Message']) {
    throw new ProviderError('UNAVAILABLE', 'alphavantage');
  }
}

function num(v: unknown): number | null {
  if (v === undefined || v === null || v === 'None' || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

interface AvReport {
  fiscalDateEnding?: string;
  totalRevenue?: string;
  operatingIncome?: string;
  netIncome?: string;
  cashAndCashEquivalentsAtCarryingValue?: string;
  cashAndShortTermInvestments?: string;
  totalLiabilities?: string;
  shortLongTermDebtTotal?: string;
}

export async function getFinancials(entry: CatalogEntry): Promise<Financials> {
  const key = getAlphaVantageKey();
  const symbol = toAvSymbol(entry);
  return cached(`av:fin:${symbol}`, TTL.financials, async () => {
    const income = await fetchJson<{ annualReports?: AvReport[] } & Record<string, unknown>>(
      `${BASE}?function=INCOME_STATEMENT&symbol=${encodeURIComponent(symbol)}&apikey=${key}`,
      { provider: 'alphavantage' },
    );
    assertNotThrottled(income);
    const balance = await fetchJson<{ annualReports?: AvReport[] } & Record<string, unknown>>(
      `${BASE}?function=BALANCE_SHEET&symbol=${encodeURIComponent(symbol)}&apikey=${key}`,
      { provider: 'alphavantage' },
    );
    assertNotThrottled(balance);

    const inc = income.annualReports?.[0];
    const bal = balance.annualReports?.[0];
    if (!inc && !bal) {
      throw new ProviderError('UNAVAILABLE', 'alphavantage', `no fundamentals for ${symbol}`);
    }
    return {
      revenue: num(inc?.totalRevenue),
      operatingProfit: num(inc?.operatingIncome),
      netProfit: num(inc?.netIncome),
      cash: num(bal?.cashAndCashEquivalentsAtCarryingValue) ?? num(bal?.cashAndShortTermInvestments),
      debt: num(bal?.totalLiabilities) ?? num(bal?.shortLongTermDebtTotal),
      fiscalDate: inc?.fiscalDateEnding ?? bal?.fiscalDateEnding ?? null,
    };
  });
}

export async function getDailySeries(entry: CatalogEntry): Promise<DailyBar[]> {
  const key = getAlphaVantageKey();
  const symbol = toAvSymbol(entry);
  return cached(`av:daily:${symbol}`, TTL.signals, async () => {
    const data = await fetchJson<Record<string, unknown>>(
      `${BASE}?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(symbol)}&outputsize=compact&apikey=${key}`,
      { provider: 'alphavantage' },
    );
    assertNotThrottled(data);
    const series = data['Time Series (Daily)'] as
      | Record<string, Record<string, string>>
      | undefined;
    if (!series) {
      throw new ProviderError('UNAVAILABLE', 'alphavantage', `no series for ${symbol}`);
    }
    const bars: DailyBar[] = Object.entries(series)
      .map(([date, ohlc]) => ({
        date,
        close: Number(ohlc['4. close']),
        volume: Number(ohlc['5. volume']),
      }))
      .filter((b) => Number.isFinite(b.close))
      .sort((a, b) => (a.date < b.date ? -1 : 1)); // ascending by date
    return bars;
  });
}
