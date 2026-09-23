import { assertPortfolioMarketEvidence } from './portfolio-market-truth';

export interface PortfolioChartOverlay {
  ticker: string;
  name: string;
  market: "KR" | "US";
  currency: "KRW" | "USD";
  averagePrice: number;
  quantity: number;
  purchaseDate: string;
  currentPrice: number | null;
  rate: number | null;
  updatedAt: string;
}

interface PortfolioOverlayInput {
  ticker: string;
  name: string;
  market: "KR" | "US";
  currency: "KRW" | "USD";
  average_price: number;
  quantity: number;
  purchase_date?: string | null;
  created_at?: string | null;
  currentPrice?: number | null;
}

const STORAGE_KEY = "sa-portfolio-chart-overlays-v1";
const PURCHASE_DATE_KEY = "sa-portfolio-purchase-dates-v1";
const RATE_EPSILON = 1e-8;
const PORTFOLIO_TICKER_PATTERN = /^[A-Z0-9][A-Z0-9.-]{0,31}$/;

function hasStorage() {
  return typeof window !== "undefined" && Boolean(window.localStorage);
}

function normalizeDate(value: unknown) {
  const text = String(value ?? "").trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const parsed = new Date(`${text}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime())) return "";
    return parsed.toISOString().slice(0, 10) === text ? text : "";
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return "";

  return parsed.toISOString().slice(0, 10);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isValidPortfolioChartOverlay(value: unknown): value is PortfolioChartOverlay {
  if (!isRecord(value)) return false;

  const ticker = typeof value.ticker === "string" ? value.ticker.trim().toUpperCase() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!ticker || !PORTFOLIO_TICKER_PATTERN.test(ticker) || !name || value.ticker !== ticker) return false;

  if (value.market !== "KR" && value.market !== "US") return false;
  const expectedCurrency = value.market === "US" ? "USD" : "KRW";
  if (value.currency !== expectedCurrency) return false;

  if (!isPositiveFiniteNumber(value.averagePrice) || !isPositiveFiniteNumber(value.quantity)) {
    return false;
  }

  if (typeof value.purchaseDate !== "string" || normalizeDate(value.purchaseDate) !== value.purchaseDate) {
    return false;
  }

  if (typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) {
    return false;
  }

  if (value.currentPrice === null) {
    return value.rate === null;
  }

  if (!isPositiveFiniteNumber(value.currentPrice)
    || typeof value.rate !== "number"
    || !Number.isFinite(value.rate)) {
    return false;
  }

  const expectedRate = ((value.currentPrice - value.averagePrice) / value.averagePrice) * 100;
  return Math.abs(value.rate - expectedRate) <= RATE_EPSILON;
}

export function parsePortfolioChartOverlays(value: unknown): PortfolioChartOverlay[] {
  if (!Array.isArray(value)) return [];

  const overlays: PortfolioChartOverlay[] = [];
  const seenTickers = new Set<string>();

  for (const row of value) {
    if (!isValidPortfolioChartOverlay(row) || seenTickers.has(row.ticker)) {
      continue;
    }

    seenTickers.add(row.ticker);
    overlays.push(row);
  }

  return overlays;
}

export function parsePortfolioPurchaseDates(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};

  const dates: Record<string, string> = {};
  for (const [ticker, purchaseDate] of Object.entries(value)) {
    const normalizedTicker = ticker.trim().toUpperCase();
    if (ticker !== normalizedTicker || !PORTFOLIO_TICKER_PATTERN.test(normalizedTicker)) {
      continue;
    }
    if (typeof purchaseDate !== "string" || normalizeDate(purchaseDate) !== purchaseDate) {
      continue;
    }
    dates[normalizedTicker] = purchaseDate;
  }

  return dates;
}

function readPurchaseDates(): Record<string, string> {
  if (!hasStorage()) return {};

  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(PURCHASE_DATE_KEY) ?? "{}",
    );

    return parsePortfolioPurchaseDates(parsed);
  } catch {
    return {};
  }
}

export function getRememberedPurchaseDate(ticker: string) {
  return readPurchaseDates()[ticker.trim().toUpperCase()] ?? "";
}

export function rememberPurchaseDate(ticker: string, date: string) {
  if (!hasStorage()) return;

  const normalizedTicker = ticker.trim().toUpperCase();
  const normalizedDate = normalizeDate(date);
  if (!PORTFOLIO_TICKER_PATTERN.test(normalizedTicker) || !normalizedDate) return;

  const dates = readPurchaseDates();
  dates[normalizedTicker] = normalizedDate;
  window.localStorage.setItem(PURCHASE_DATE_KEY, JSON.stringify(dates));
}

export function syncPortfolioChartOverlays(rows: PortfolioOverlayInput[]) {
  // PortfolioPage currently falls back from missing currentPrice to average_price
  // when rendering value/PnL. Stop before that safe-looking projection can become
  // visible: missing current-market evidence is an explicit failure, never 0%.
  assertPortfolioMarketEvidence(
    rows.map((row) => ({
      ticker: row.ticker,
      quantity: row.quantity,
      average_price: row.average_price,
      currentPrice: row.currentPrice ?? null,
    })),
  );

  if (!hasStorage()) return;

  const purchaseDates = readPurchaseDates();
  const grouped = new Map<
    string,
    {
      ticker: string;
      name: string;
      market: "KR" | "US";
      currency: "KRW" | "USD";
      quantity: number;
      totalCost: number;
      purchaseDate: string;
      currentPrice: number | null;
    }
  >();

  for (const row of rows) {
    const ticker = row.ticker.trim().toUpperCase();
    const quantity = Number(row.quantity);
    const averagePrice = Number(row.average_price);

    if (
      !PORTFOLIO_TICKER_PATTERN.test(ticker) ||
      !Number.isFinite(quantity) ||
      quantity <= 0 ||
      !Number.isFinite(averagePrice) ||
      averagePrice <= 0
    ) {
      continue;
    }

    const rowDate =
      normalizeDate(row.purchase_date) ||
      purchaseDates[ticker] ||
      normalizeDate(row.created_at) ||
      new Date().toISOString().slice(0, 10);

    const previous = grouped.get(ticker);

    if (!previous) {
      grouped.set(ticker, {
        ticker,
        name: row.name,
        market: row.market,
        currency: row.currency,
        quantity,
        totalCost: averagePrice * quantity,
        purchaseDate: rowDate,
        currentPrice:
          row.currentPrice != null && Number.isFinite(Number(row.currentPrice))
            ? Number(row.currentPrice)
            : null,
      });
      continue;
    }

    previous.quantity += quantity;
    previous.totalCost += averagePrice * quantity;
    previous.purchaseDate = [previous.purchaseDate, rowDate]
      .filter(Boolean)
      .sort()[0];
    if (row.currentPrice != null && Number.isFinite(Number(row.currentPrice))) {
      previous.currentPrice = Number(row.currentPrice);
    }
  }

  const overlays: PortfolioChartOverlay[] = [...grouped.values()].map((item) => {
    const averagePrice = item.totalCost / item.quantity;
    const rate =
      item.currentPrice != null && averagePrice > 0
        ? ((item.currentPrice - averagePrice) / averagePrice) * 100
        : null;

    return {
      ticker: item.ticker,
      name: item.name,
      market: item.market,
      currency: item.currency,
      averagePrice,
      quantity: item.quantity,
      purchaseDate: item.purchaseDate,
      currentPrice: item.currentPrice,
      rate,
      updatedAt: new Date().toISOString(),
    };
  });

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(overlays));
  window.dispatchEvent(new CustomEvent("sa-portfolio-overlay-updated"));
}

export function loadPortfolioChartOverlays(): PortfolioChartOverlay[] {
  if (!hasStorage()) return [];

  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
    return parsePortfolioChartOverlays(parsed);
  } catch {
    return [];
  }
}

export function getPortfolioChartOverlay(ticker: string) {
  const normalized = ticker.trim().toUpperCase();
  return (
    loadPortfolioChartOverlays().find((item) => item.ticker === normalized) ??
    null
  );
}
