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

export interface PortfolioEvidenceRow {
  ticker: string;
  currentPrice: number | null;
}

const INVALID_PORTFOLIO_QUOTES = 'INVALID_PORTFOLIO_QUOTE_RESPONSE';
const MISSING_PORTFOLIO_MARKET_EVIDENCE = 'PORTFOLIO_MARKET_EVIDENCE_MISSING';
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

export function assertPortfolioMarketEvidence(rows: PortfolioEvidenceRow[]): void {
  const missing = rows
    .filter((row) => !isFiniteNumber(row.currentPrice) || row.currentPrice <= 0)
    .map((row) => row.ticker.trim().toUpperCase())
    .filter(Boolean);

  if (missing.length === 0) return;

  throw new Error(
    `${MISSING_PORTFOLIO_MARKET_EVIDENCE}: 현재 시세 근거를 확인하지 못했습니다 (${Array.from(new Set(missing)).join(', ')}).`,
  );
}
