import { evidenceInstant, evidenceNumber, evidenceRecord } from './server-evidence';

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
  quoteUpdatedAt?: string | null;
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
  updatedAt?: string | null;
}

const STORAGE_KEY = "sa-portfolio-chart-overlays-v1";
const PURCHASE_DATE_KEY = "sa-portfolio-purchase-dates-v1";
let memberId: string | null = null;

export function setPortfolioOverlayMember(value: string | null) {
  if (memberId === value) return;
  memberId = value;
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('sa-portfolio-overlay-updated'));
}

function hasStorage() {
  return typeof window !== "undefined" && Boolean(window.localStorage);
}

function normalizeDate(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
  return evidenceInstant(value + 'T00:00:00Z') ? value : '';
}

function readPurchaseDates(): Record<string, string> {
  if (!hasStorage() || !memberId) return {};

  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(PURCHASE_DATE_KEY) ?? "{}",
    );

    if (!evidenceRecord(parsed) || parsed.version !== 2 || parsed.memberId !== memberId || !evidenceRecord(parsed.dates)) return {};
    return Object.fromEntries(Object.entries(parsed.dates).filter((entry): entry is [string, string] => normalizeDate(entry[1]) !== ''));
  } catch {
    return {};
  }
}

export function getRememberedPurchaseDate(ticker: string) {
  return readPurchaseDates()[ticker.trim().toUpperCase()] ?? "";
}

export function rememberPurchaseDate(ticker: string, date: string) {
  if (!hasStorage() || !memberId) return;

  const normalizedTicker = ticker.trim().toUpperCase();
  const normalizedDate = normalizeDate(date);
  if (!normalizedTicker || !normalizedDate) return;

  const dates = readPurchaseDates();
  dates[normalizedTicker] = normalizedDate;
  window.localStorage.setItem(PURCHASE_DATE_KEY, JSON.stringify({ version: 2, memberId, dates }));
}

export function syncPortfolioChartOverlays(rows: PortfolioOverlayInput[]) {
  if (!hasStorage() || !memberId) return;

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
      quoteUpdatedAt: string | null;
    }
  >();

  for (const row of rows) {
    const ticker = row.ticker.trim().toUpperCase();
    const quantity = row.quantity;
    const averagePrice = row.average_price;

    if (
      !ticker ||
      !evidenceNumber(quantity) ||
      quantity <= 0 ||
      !evidenceNumber(averagePrice) ||
      averagePrice <= 0 || !Number.isFinite(averagePrice * quantity)
    ) {
      continue;
    }

    const rowDate =
      normalizeDate(row.purchase_date) ||
      purchaseDates[ticker] || '';

    const key = row.market + ':' + row.currency + ':' + ticker;
    const previous = grouped.get(key);

    if (!previous) {
      grouped.set(key, {
        ticker,
        name: row.name,
        market: row.market,
        currency: row.currency,
        quantity,
        totalCost: averagePrice * quantity,
        purchaseDate: rowDate,
        currentPrice:
          evidenceNumber(row.currentPrice) && row.currentPrice > 0
            ? row.currentPrice
            : null,
        quoteUpdatedAt: evidenceInstant(row.updatedAt, Date.now()) ? row.updatedAt! : null,
      });
      continue;
    }

    previous.quantity += quantity;
    previous.totalCost += averagePrice * quantity;
    previous.purchaseDate = previous.purchaseDate && rowDate ? [previous.purchaseDate, rowDate].sort()[0] : '';
    if (previous.currentPrice !== row.currentPrice || previous.quoteUpdatedAt !== row.updatedAt) {
      previous.currentPrice = null;
      previous.quoteUpdatedAt = null;
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
      quoteUpdatedAt: item.quoteUpdatedAt,
    };
  });

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, memberId, rows: overlays }));
  window.dispatchEvent(new CustomEvent("sa-portfolio-overlay-updated"));
}

export function loadPortfolioChartOverlays(): PortfolioChartOverlay[] {
  if (!hasStorage() || !memberId) return [];

  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!evidenceRecord(parsed) || parsed.version !== 2 || parsed.memberId !== memberId || !Array.isArray(parsed.rows)) return [];
    const now = Date.now();
    if (!parsed.rows.every((row) => evidenceRecord(row) && typeof row.ticker === 'string' && typeof row.name === 'string'
      && (row.market === 'KR' || row.market === 'US') && row.currency === (row.market === 'KR' ? 'KRW' : 'USD')
      && evidenceNumber(row.quantity) && row.quantity > 0 && evidenceNumber(row.averagePrice) && row.averagePrice > 0
      && (row.purchaseDate === '' || normalizeDate(row.purchaseDate) !== '') && evidenceInstant(row.updatedAt, now)
      && (row.currentPrice === null || (evidenceNumber(row.currentPrice) && row.currentPrice > 0)))) return [];
    return (parsed.rows as PortfolioChartOverlay[]).map((row) => {
      const fresh = evidenceInstant(row.quoteUpdatedAt, now) && now - Date.parse(row.quoteUpdatedAt!) <= 300_000;
      const currentPrice = fresh ? row.currentPrice : null;
      return { ...row, currentPrice, rate: currentPrice === null ? null : (currentPrice - row.averagePrice) / row.averagePrice * 100 };
    });
  } catch {
    return [];
  }
}

export function getPortfolioChartOverlay(ticker: string) {
  const normalized = ticker.trim().toUpperCase();
  const matches = loadPortfolioChartOverlays().filter((item) => item.ticker === normalized);
  return matches.length === 1 ? matches[0] : null;
}
