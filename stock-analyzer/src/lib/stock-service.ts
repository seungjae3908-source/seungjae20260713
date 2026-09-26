import { STOCK_DIRECTORY } from '../data/stock-directory';
import type { Market, Currency } from './api';

// A factual, price-free catalog entry used only for search + navigation.
// Live market data is fetched from the backend per stock.
export interface SearchResult {
  ticker: string;
  name: string;
  market: Market;
  currency: Currency;
}

function normalize(value: string) {
  return value.toLowerCase().replace(/\s+/g, '').trim();
}

// KR tickers are 6-digit KRX codes; everything else is a US symbol.
function marketOf(ticker: string): { market: Market; currency: Currency } {
  return /^\d{6}$/.test(ticker)
    ? { market: 'KR', currency: 'KRW' }
    : { market: 'US', currency: 'USD' };
}

const CATALOG: SearchResult[] = STOCK_DIRECTORY.map((e) => ({
  ticker: e.ticker,
  name: e.name,
  ...marketOf(e.ticker),
}));

const SEARCH_LIMIT = 20;

export function searchStocks(query: string): SearchResult[] {
  const q = normalize(query);
  if (!q) return [];

  const scored: { entry: SearchResult; rank: number }[] = [];
  for (const entry of CATALOG) {
    const nTicker = normalize(entry.ticker);
    const nName = normalize(entry.name);

    const partial = nTicker.includes(q) || nName.includes(q);
    if (!partial) continue;

    const exact = nTicker === q || nName === q;
    const startsWith = nTicker.startsWith(q) || nName.startsWith(q);
    const rank = exact ? 0 : startsWith ? 1 : 2;
    scored.push({ entry, rank });
  }

  scored.sort((a, b) => a.rank - b.rank);
  return scored.slice(0, SEARCH_LIMIT).map((s) => s.entry);
}
