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

export interface YahooIndexQuote {
  price: number;
  changeAmount: number;
  changePercent: number;
  spark: number[];
  unit?: 'index' | 'krw' | 'usd';
  updatedAt: string;
}

// The stock Scanner has a four-second per-symbol budget. Keep each Yahoo
// public chart attempt comfortably below that budget so a bounded retry can
// still finish instead of being reported as an item timeout.
const YAHOO_CHART_BUDGET_MS = 1_650;
const YAHOO_HEDGE_DELAY_MS = 180;

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

function isQualifiedKrTicker(ticker: string) {
  return /^\d{6}\.(?:KS|KQ)$/u.test(ticker);
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

  // Preserve an already-qualified Korean Yahoo symbol. Without this guard,
  // 005930.KS / 247540.KQ can be mistaken for a US class-share ticker and
  // rewritten to 005930-KS / 247540-KQ, which Yahoo correctly returns as 404.
  if (isQualifiedKrTicker(clean)) return clean;
  if (isKrTicker(clean)) return `${clean}.KS`;
  if (/^[A-Z0-9]+\.[A-Z0-9]+$/u.test(clean)) return clean.replace(/\./gu, '-');

  return clean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    redirect: 'follow',
    signal,
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

async function validChart(url: string, signal: AbortSignal): Promise<YahooChartResult> {
  const data = await fetchJson<any>(url, signal);
  const result = data?.chart?.result?.[0];
  if (!result?.indicators?.quote?.[0]) throw new Error(`YAHOO_CHART_EMPTY_RESULT:${url}`);
  return result as YahooChartResult;
}

async function hedgedYahooChart(urls: [string, string]): Promise<YahooChartResult> {
  const controllers = [new AbortController(), new AbortController()];
  const timer = setTimeout(() => {
    controllers[0].abort(new Error('YAHOO_CHART_BUDGET_EXCEEDED'));
    controllers[1].abort(new Error('YAHOO_CHART_BUDGET_EXCEEDED'));
  }, YAHOO_CHART_BUDGET_MS);
  const first = validChart(urls[0], controllers[0].signal);
  const second = (async () => {
    await sleep(YAHOO_HEDGE_DELAY_MS);
    return validChart(urls[1], controllers[1].signal);
  })();

  try {
    return await Promise.any([first, second]);
  } catch (error) {
    if (error instanceof AggregateError) {
      const details = error.errors.map((item) => item instanceof Error ? item.message : String(item)).join('|');
      throw new Error(`YAHOO_HEDGED_PAIR_FAILED:${details}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    controllers[0].abort();
    controllers[1].abort();
  }
}

async function fetchYahooChart(
  symbol: string,
  params?: { range: string; interval: string },
): Promise<YahooChartResult> {
  const encoded = encodeURIComponent(symbol);

  // A single 1mo/1d request is sufficient for quote/previous-close fields and
  // avoids spending a second full network budget on a 5d fallback. Explicit
  // candle requests still use their requested timeframe/range.
  const query = params
    ? [
        params.range
          ? `range=${params.range}&interval=${params.interval}`
          : `period1=0&period2=9999999999&interval=${params.interval}`,
      ]
    : ['range=1mo&interval=1d'];

  const errors: string[] = [];
  for (const q of query) {
    try {
      return await hedgedYahooChart([
        `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?${q}`,
        `https://query2.finance.yahoo.com/v8/finance/chart/${encoded}?${q}`,
      ]);
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

export function yahooChartParams(tf?: string): { range: string; interval: string } {
  switch (String(tf ?? '1D')) {
    case '1m':
      return { range: '7d', interval: '1m' };
    case '5m':
      return { range: '1mo', interval: '5m' };
    case '15m':
      return { range: '1mo', interval: '15m' };
    case '30m':
      return { range: '1mo', interval: '30m' };
    case '60m':
    case '1H':
      return { range: '2y', interval: '60m' };
    case '3m':
    case '4H':
      throw new Error(`YAHOO_UNSUPPORTED_TIMEFRAME:${String(tf)}`);
    case '1W':
      return { range: '', interval: '1wk' };
    case '1M':
      return { range: '', interval: '1mo' };
    case '1D':
      return { range: '10y', interval: '1d' };
    default:
      throw new Error(`YAHOO_UNSUPPORTED_TIMEFRAME:${String(tf)}`);
  }
}

export async function getCandles(
  entryOrTicker: CatalogEntry | string,
  timeframe?: string,
): Promise<Candle[]> {
  const ticker = getTickerFromEntry(entryOrTicker);
  const symbol = yahooSymbol(ticker);
  const result = await fetchYahooChart(symbol, yahooChartParams(timeframe));
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

export async function getIndexQuote(symbol: string): Promise<YahooIndexQuote> {
  const clean = cleanTicker(symbol);
  const result = await fetchYahooChart(clean);
  const quote = result.indicators?.quote?.[0];

  if (!quote?.close?.length) {
    throw new Error(`YAHOO_INDEX_NO_CLOSE:${clean}`);
  }

  const index = lastValidIndex(quote.close);
  if (index < 0) {
    throw new Error(`YAHOO_INDEX_NO_VALID_PRICE:${clean}`);
  }

  const price =
    safeNumber(result.meta?.regularMarketPrice) || safeNumber(quote.close[index]);
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

  if (!price || !previousClose) {
    throw new Error(`YAHOO_INDEX_INCOMPLETE:${clean}`);
  }

  const changeAmount = price - previousClose;
  return {
    price,
    changeAmount,
    changePercent: (changeAmount / previousClose) * 100,
    spark: quote.close
      .map((value) => safeNumber(value))
      .filter((value) => value > 0),
    updatedAt: new Date().toISOString(),
  };
}

export async function getCompanyProfile(
  entryOrTicker: CatalogEntry | string,
): Promise<any> {
  const ticker = getTickerFromEntry(entryOrTicker);
  const kr = isKrTicker(ticker) || isQualifiedKrTicker(ticker);

  return {
    ticker,
    name: getNameFromEntry(entryOrTicker, ticker),
    market: kr ? 'KR' : 'US',
    currency: kr ? 'KRW' : 'USD',
    description: `${getNameFromEntry(entryOrTicker, ticker)} 기업 정보입니다.`,
    sector: '',
    industry: '',
    website: '',
  };
}

export const companyProfile = getCompanyProfile;

export async function getYahooSector(ticker: string): Promise<string | null> {
  const clean = cleanTicker(ticker);
  if (!clean || isKrTicker(clean) || isQualifiedKrTicker(clean)) return null;

  const encoded = encodeURIComponent(yahooSymbol(clean));
  const urls = [
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encoded}?modules=assetProfile`,
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encoded}?modules=assetProfile`,
  ];

  for (const url of urls) {
    try {
      const data = await fetchJson<any>(url);
      const sector = data?.quoteSummary?.result?.[0]?.assetProfile?.sector;
      const value = String(sector ?? '').trim();
      if (value) return value;
    } catch {
      // best-effort — try next host / give up silently
    }
  }

  return null;
}
