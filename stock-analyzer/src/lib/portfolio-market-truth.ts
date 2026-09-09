export type PortfolioMarket = 'KR' | 'US';
export type PortfolioCurrency = 'KRW' | 'USD';

export interface PortfolioQuoteEvidence {
  ticker: string;
  price: number;
  changePercent: number;
}

export interface PortfolioQuoteSnapshot {
  quotes: Map<string, PortfolioQuoteEvidence>;
  requested: number;
  available: number;
  updatedAt: string;
  complete: boolean;
}

export interface PortfolioMarketRow {
  quantity: number;
  average_price: number;
  currentPrice: number | null;
}

export interface PortfolioMarketSummary {
  cost: number;
  value: number | null;
  profit: number | null;
  rate: number | null;
  evidenceComplete: boolean;
}

export interface PortfolioHoldingPerformance {
  value: number | null;
  profit: number | null;
  rate: number | null;
}

const INVALID_PORTFOLIO_QUOTES = 'INVALID_PORTFOLIO_QUOTE_RESPONSE';
const MAX_ENVELOPE_AGE_MS = 2 * 60_000;
const MAX_FUTURE_SKEW_MS = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
}

function fail(): never {
  throw new Error(INVALID_PORTFOLIO_QUOTES);
}

export function parsePortfolioQuoteSnapshot(
  value: unknown,
  requestedTickers: string[],
  now = Date.now(),
): PortfolioQuoteSnapshot {
  if (!isRecord(value) || !Array.isArray(value.quotes)) fail();
  if (!isNonNegativeInteger(value.requested) || !isNonNegativeInteger(value.available)) fail();
  if (value.requested !== requestedTickers.length || value.available !== value.quotes.length) fail();
  if (value.available > value.requested) fail();
  if (typeof value.updatedAt !== 'string') fail();

  const updatedAtMs = Date.parse(value.updatedAt);
  if (!Number.isFinite(updatedAtMs)) fail();
  if (updatedAtMs < now - MAX_ENVELOPE_AGE_MS || updatedAtMs > now + MAX_FUTURE_SKEW_MS) fail();

  const requested = new Set(requestedTickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean));
  if (requested.size !== requestedTickers.length) fail();

  const quotes = new Map<string, PortfolioQuoteEvidence>();
  for (const rawQuote of value.quotes) {
    if (!isRecord(rawQuote)) fail();
    const ticker = typeof rawQuote.ticker === 'string' ? rawQuote.ticker.trim().toUpperCase() : '';
    if (!ticker || !requested.has(ticker) || quotes.has(ticker)) fail();
    if (!isFiniteNumber(rawQuote.price) || rawQuote.price <= 0) fail();
    if (!isFiniteNumber(rawQuote.changePercent)) fail();

    quotes.set(ticker, {
      ticker,
      price: rawQuote.price,
      changePercent: rawQuote.changePercent,
    });
  }

  const complete = quotes.size === requested.size
    && Array.from(requested).every((ticker) => quotes.has(ticker));

  return {
    quotes,
    requested: value.requested,
    available: value.available,
    updatedAt: value.updatedAt,
    complete,
  };
}

export function calculatePortfolioMarketSummary(
  rows: PortfolioMarketRow[],
): PortfolioMarketSummary {
  let cost = 0;
  let value = 0;
  let evidenceComplete = true;

  for (const row of rows) {
    const rowCost = row.average_price * row.quantity;
    cost += rowCost;

    if (!isFiniteNumber(row.currentPrice) || row.currentPrice <= 0) {
      evidenceComplete = false;
      continue;
    }

    value += row.currentPrice * row.quantity;
  }

  if (!evidenceComplete) {
    return {
      cost,
      value: null,
      profit: null,
      rate: null,
      evidenceComplete: false,
    };
  }

  const profit = value - cost;
  return {
    cost,
    value,
    profit,
    rate: cost > 0 ? (profit / cost) * 100 : 0,
    evidenceComplete: true,
  };
}

export function calculateHoldingMarketPerformance(
  row: PortfolioMarketRow,
): PortfolioHoldingPerformance {
  if (!isFiniteNumber(row.currentPrice) || row.currentPrice <= 0) {
    return { value: null, profit: null, rate: null };
  }

  const value = row.currentPrice * row.quantity;
  const profit = (row.currentPrice - row.average_price) * row.quantity;
  const rate = row.average_price > 0
    ? ((row.currentPrice - row.average_price) / row.average_price) * 100
    : 0;

  return { value, profit, rate };
}
