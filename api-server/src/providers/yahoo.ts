import type { CatalogEntry } from '../data/catalog';
import type { Candle, Quote } from '../sample/types';

type YahooChartQuote = {
  open?: Array<number | null>;
  high?: Array<number | null>;
  low?: Array<number | null>;
  close?: Array<number | null>;
  volume?: Array<number | null>;
};

type YahooChartResult = {
  meta?: {
    symbol?: string;
    currency?: string;
    regularMarketPrice?: number;
    previousClose?: number;
    chartPreviousClose?: number;
  };
  timestamp?: number[];
  indicators?: {
    quote?: YahooChartQuote[];
  };
};

function cleanTicker(value: unknown) {
  return String(value ?? '').trim().toUpperCase();
}

function safeNumber(value: unknown, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  if (typeof value === 'string') {
    const parsed = Number(value.replace(/[,\s$%]/g, ''));

    if (Number.isFinite(parsed)) return parsed;
  }

  return fallback;
}

function isKrTicker(ticker: string) {
  return /^\d{6}$/.test(ticker);
}

function getTickerFromEntry(entryOrTicker: CatalogEntry | string) {
  if (typeof entryOrTicker === 'string') return cleanTicker(entryOrTicker);

  return cleanTicker((entryOrTicker as any).ticker);
}

function getNameFromEntry(entryOrTicker: CatalogEntry | string, fallback: string) {
  if (typeof entryOrTicker === 'string') return fallback;

  return String((entryOrTicker as any).name ?? fallback);
}

function yahooSymbol(ticker: string) {
  const clean = cleanTicker(ticker);

  if (isKrTicker(clean)) return `${clean}.KS`;

  return clean;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      accept: 'application/json,text/plain,*/*',
      'accept-language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    },
  });

  if (!res.ok) {
    throw new Error(`YAHOO_CHART_HTTP_${res.status}`);
  }

  return (await res.json()) as T;
}

async function fetchYahooChart(symbol: string): Promise<YahooChartResult> {
  const encoded = encodeURIComponent(symbol);

  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?range=5d&interval=1d`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encoded}?range=5d&interval=1d`,
    `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?range=1mo&interval=1d`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encoded}?range=1mo&interval=1d`,
  ];

  const errors: string[] = [];

  for (const url of urls) {
    try {
      const data = await fetchJson<any>(url);
      const result = data?.chart?.result?.[0];

      if (result?.indicators?.quote?.[0]) {
        return result as YahooChartResult;
      }

      errors.push(`EMPTY_RESULT:${url}`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  throw new Error(`YAHOO_PROVIDER_MARKER_20260711_FAILED:${symbol}:${errors.join('|')}`);
}

function lastValidIndex(values: Array<number | null | undefined>) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];

    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return index;
    }
  }

  return -1;
}

export async function getQuote(
  entryOrTicker: CatalogEntry | string,
): Promise<Partial<Quote>> {
  const ticker = getTickerFromEntry(entryOrTicker);
  const symbol = yahooSymbol(ticker);
  const result = await fetchYahooChart(symbol);
  const quote = result.indicators?.quote?.[0];

  if (!quote?.close?.length) {
    throw new Error(`YAHOO_PROVIDER_MARKER_20260711_NO_CLOSE:${symbol}`);
  }

  const index = lastValidIndex(quote.close);

  if (index < 0) {
    throw new Error(`YAHOO_PROVIDER_MARKER_20260711_NO_VALID_PRICE:${symbol}`);
  }

  const price =
    safeNumber(result.meta?.regularMarketPrice) ||
    safeNumber(quote.close[index]);

  if (!price) {
    throw new Error(`YAHOO_PROVIDER_MARKER_20260711_ZERO_PRICE:${symbol}`);
  }

  let previousClose =
    safeNumber(result.meta?.previousClose) ||
    safeNumber(result.meta?.chartPreviousClose);

  if (!previousClose) {
    for (let i = index - 1; i >= 0; i -= 1) {
      const candidate = safeNumber(quote.close[i]);

      if (candidate > 0) {
        previousClose = candidate;
        break;
      }
    }
  }

  if (!previousClose) previousClose = price;

  const changeAmount = price - previousClose;
  const changePercent = previousClose ? (changeAmount / previousClose) * 100 : 0;
  const volume = safeNumber(quote.volume?.[index]);
  const tradingValue = price * volume;

  return {
    ticker,
    symbol,
    name: getNameFromEntry(entryOrTicker, ticker),
    price,
    currentPrice: price,
    regularMarketPrice: price,
    close: price,
    previousClose,
    prevClose: previousClose,
    change: changeAmount,
    changeAmount,
    changePercent,
    regularMarketChangePercent: changePercent,
    volume,
    tradingValue,
    open: safeNumber(quote.open?.[index]),
    high: safeNumber(quote.high?.[index]),
    low: safeNumber(quote.low?.[index]),
    updatedAt: new Date().toISOString(),
  } as Partial<Quote>;
}

export const quote = getQuote;

export async function getCandles(
  entryOrTicker: CatalogEntry | string,
): Promise<Candle[]> {
  const ticker = getTickerFromEntry(entryOrTicker);
  const symbol = yahooSymbol(ticker);
  const result = await fetchYahooChart(symbol);
  const quote = result.indicators?.quote?.[0];

  if (!result.timestamp?.length || !quote) return [];

  return result.timestamp
    .map((timestamp, index) => {
      const close = safeNumber(quote.close?.[index]);

      return {
        time: new Date(timestamp * 1000).toISOString(),
        open: safeNumber(quote.open?.[index]),
        high: safeNumber(quote.high?.[index]),
        low: safeNumber(quote.low?.[index]),
        close,
        volume: safeNumber(quote.volume?.[index]),
      } as Candle;
    })
    .filter((candle) => candle.close > 0);
}

export const candles = getCandles;

export async function getCompanyProfile(
  entryOrTicker: CatalogEntry | string,
): Promise<any> {
  const ticker = getTickerFromEntry(entryOrTicker);

  return {
    ticker,
    name: getNameFromEntry(entryOrTicker, ticker),
    market: isKrTicker(ticker) ? 'KR' : 'US',
    currency: isKrTicker(ticker) ? 'KRW' : 'USD',
    description: `${getNameFromEntry(entryOrTicker, ticker)} 기업 정보입니다.`,
    sector: '',
    industry: '',
    website: '',
  };
}

export const companyProfile = getCompanyProfile;