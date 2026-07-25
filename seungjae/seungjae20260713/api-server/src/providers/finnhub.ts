// Finnhub provider: live US quotes, company profile, and company news.
// Docs: https://finnhub.io/docs/api
import { getFinnhubKey } from '../lib/config';
import { ProviderError } from '../lib/errors';
import { fetchJson } from '../lib/http';
import { cached, TTL } from '../lib/cache';
import type { CatalogEntry } from '../data/catalog';

const BASE = 'https://finnhub.io/api/v1';

export interface Quote {
  price: number;
  changeAmount: number;
  changePercent: number;
  high: number;
  low: number;
  open: number;
  previousClose: number;
}

export interface Profile {
  name: string;
  marketCap: number | null; // in USD
  exchange: string | null;
  industry: string | null;
}

export interface RawNews {
  headline: string;
  summary: string;
  source: string;
  url: string;
  datetime: number; // unix seconds
}

// Finnhub uses a suffix for non-US listings; KOSPI = .KS, KOSDAQ = .KQ.
function toFinnhubSymbol(entry: CatalogEntry): string {
  if (entry.market === 'US') return entry.ticker;
  // KR 6-digit codes: 6xxxxx tends to be KOSDAQ, otherwise KOSPI (heuristic).
  const suffix = /^[6]/.test(entry.ticker) ? '.KQ' : '.KS';
  return `${entry.ticker}${suffix}`;
}

interface FinnhubQuote {
  c: number;
  d: number | null;
  dp: number | null;
  h: number;
  l: number;
  o: number;
  pc: number;
}

export async function getQuote(entry: CatalogEntry): Promise<Quote> {
  const key = getFinnhubKey();
  const symbol = toFinnhubSymbol(entry);
  return cached(`finnhub:quote:${symbol}`, TTL.quote, async () => {
    const data = await fetchJson<FinnhubQuote>(
      `${BASE}/quote?symbol=${encodeURIComponent(symbol)}&token=${key}`,
      { provider: 'finnhub' },
    );
    // Finnhub returns c=0 for symbols it has no data for (common for KR on free tier).
    if (!data || !data.c) {
      throw new ProviderError(
        'UNAVAILABLE',
        'finnhub',
        `no quote for ${symbol}`,
      );
    }
    return {
      price: data.c,
      changeAmount: data.d ?? 0,
      changePercent: data.dp ?? 0,
      high: data.h,
      low: data.l,
      open: data.o,
      previousClose: data.pc,
    };
  });
}

interface FinnhubProfile {
  name?: string;
  marketCapitalization?: number; // in millions
  exchange?: string;
  finnhubIndustry?: string;
}

export async function getProfile(entry: CatalogEntry): Promise<Profile> {
  const key = getFinnhubKey();
  const symbol = toFinnhubSymbol(entry);
  return cached(`finnhub:profile:${symbol}`, TTL.profile, async () => {
    const data = await fetchJson<FinnhubProfile>(
      `${BASE}/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${key}`,
      { provider: 'finnhub' },
    );
    return {
      name: data.name ?? entry.name,
      marketCap:
        typeof data.marketCapitalization === 'number'
          ? data.marketCapitalization * 1_000_000
          : null,
      exchange: data.exchange ?? null,
      industry: data.finnhubIndustry ?? null,
    };
  });
}

interface FinnhubMetricResponse {
  metric?: Record<string, number | null>;
}

export interface Ratios {
  eps: number;
  per: number;
  pbr: number;
  roe: number;
  debtRatio: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Live valuation ratios from Finnhub's /stock/metric endpoint (US only).
export async function getRatios(entry: CatalogEntry): Promise<Ratios> {
  const key = getFinnhubKey();
  const symbol = toFinnhubSymbol(entry);
  return cached(`finnhub:metric:${symbol}`, TTL.financials, async () => {
    const data = await fetchJson<FinnhubMetricResponse>(
      `${BASE}/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all&token=${key}`,
      { provider: 'finnhub' },
    );
    const m = data.metric ?? {};
    const num = (k: string): number => {
      const v = m[k];
      return typeof v === 'number' && Number.isFinite(v) ? v : 0;
    };
    const de =
      num('totalDebt/totalEquityAnnual') || num('totalDebt/totalEquityQuarterly');
    return {
      eps: round2(
        num('epsBasicExclExtraItemsTTM') || num('epsInclExtraItemsTTM'),
      ),
      per: round2(num('peBasicExclExtraTTM') || num('peInclExtraTTM')),
      pbr: round2(num('pbAnnual') || num('pbQuarterly')),
      roe: round2(num('roeTTM') || num('roeRfy')),
      debtRatio: round2(de * 100),
    };
  });
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function getCompanyNews(entry: CatalogEntry): Promise<RawNews[]> {
  const key = getFinnhubKey();
  const symbol = toFinnhubSymbol(entry);
  return cached(`finnhub:news:${symbol}`, TTL.news, async () => {
    const to = new Date();
    const from = new Date(to.getTime() - 14 * 24 * 60 * 60 * 1000);
    const data = await fetchJson<RawNews[]>(
      `${BASE}/company-news?symbol=${encodeURIComponent(symbol)}&from=${ymd(
        from,
      )}&to=${ymd(to)}&token=${key}`,
      { provider: 'finnhub' },
    );
    if (!Array.isArray(data)) return [];
    return data
      .filter((n) => n.headline)
      .slice(0, 20)
      .map((n) => ({
        headline: n.headline,
        summary: n.summary ?? '',
        source: n.source ?? '',
        url: n.url ?? '',
        datetime: n.datetime ?? 0,
      }));
  });
}

export interface SymbolHit {
  symbol: string;
  description: string;
  type: string;
}

interface FinnhubSearchResponse {
  result?: { symbol: string; description: string; type: string }[];
}

// Finnhub Symbol Search — the whole US universe (stocks/ETF/ETN/ADR/REIT).
// Foreign listings carry an exchange suffix (e.g. 603020.SS); we keep only the
// plain US symbols.
export async function symbolSearch(query: string): Promise<SymbolHit[]> {
  const key = getFinnhubKey();
  const q = query.trim();
  if (!q) return [];
  return cached(`finnhub:search:${q.toLowerCase()}`, TTL.news, async () => {
    const data = await fetchJson<FinnhubSearchResponse>(
      `${BASE}/search?q=${encodeURIComponent(q)}&token=${key}`,
      { provider: 'finnhub' },
    );
    const rows = Array.isArray(data.result) ? data.result : [];
    return rows
      .filter((r) => r.symbol && !r.symbol.includes('.'))
      .slice(0, 20)
      .map((r) => ({
        symbol: r.symbol,
        description: r.description || r.symbol,
        type: r.type ?? '',
      }));
  });
}
