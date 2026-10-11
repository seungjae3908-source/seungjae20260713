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
    regularMarketTime?: number;
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
// public chart attempt below that budget, including the delayed hedge. The
// deadline also terminates non-cooperative transports; abort alone is not enough.
const YAHOO_CHART_BUDGET_MS = 2_800;
const YAHOO_HEDGE_DELAY_MS = 180;

export interface YahooChartRequestOptions {
  signal?: AbortSignal;
  purpose?: 'scanner';
  exchange?: string | null;
}

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

function yahooSymbol(ticker: string, options: YahooChartRequestOptions = {}) {
  const clean = cleanTicker(ticker);

  // Preserve an already-qualified Korean Yahoo symbol. Without this guard,
  // 005930.KS / 247540.KQ can be mistaken for a US class-share ticker and
  // rewritten to 005930-KS / 247540-KQ, which Yahoo correctly returns as 404.
  if (isQualifiedKrTicker(clean)) return clean;
  if (isKrTicker(clean)) {
    const exchange = String(options.exchange ?? '').toUpperCase();
    if (/KOSDAQ|코스닥/u.test(exchange)) return `${clean}.KQ`;
    if (options.purpose === 'scanner' && !/KOSPI|코스피/u.test(exchange)) {
      throw new Error('YAHOO_PROVIDER_KR_EXCHANGE_MAPPING_UNAVAILABLE');
    }
    return `${clean}.KS`;
  }
  if (/^[A-Z0-9]+\.[A-Z0-9]+$/u.test(clean)) return clean.replace(/\./gu, '-');

  return clean;
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

async function hedgedYahooChart(urls: [string, string], signal?: AbortSignal): Promise<YahooChartResult> {
  if (signal?.aborted) throw signal.reason ?? new Error('YAHOO_CHART_ABORTED');
  const controllers = [new AbortController(), new AbortController()];
  let finished = false;
  let hedgeTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectDeadline: (reason: unknown) => void = () => {};
  const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  const abort = (reason: unknown) => {
    controllers.forEach(controller => controller.abort(reason));
    rejectDeadline(reason);
  };
  const onAbort = () => abort(signal?.reason ?? new Error('YAHOO_CHART_ABORTED'));
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => abort(new Error('YAHOO_CHART_BUDGET_EXCEEDED')), YAHOO_CHART_BUDGET_MS);
  const first = validChart(urls[0], controllers[0].signal);
  const second = new Promise<YahooChartResult>((resolve, reject) => {
    hedgeTimer = setTimeout(() => {
      if (finished || signal?.aborted) return;
      validChart(urls[1], controllers[1].signal).then(resolve, reject);
    }, YAHOO_HEDGE_DELAY_MS);
  });

  try {
    return await Promise.race([Promise.any([first, second]), deadline]);
  } catch (error) {
    if (error instanceof AggregateError) {
      const details = error.errors.map((item) => item instanceof Error ? item.message : String(item)).join('|');
      throw new Error(`YAHOO_HEDGED_PAIR_FAILED:${details}`);
    }
    throw error;
  } finally {
    finished = true;
    clearTimeout(timer);
    clearTimeout(hedgeTimer);
    signal?.removeEventListener('abort', onAbort);
    controllers[0].abort();
    controllers[1].abort();
  }
}

async function fetchYahooChart(
  symbol: string,
  params?: { range: string; interval: string },
  signal?: AbortSignal,
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
      ], signal).then(result => {
        if (result.meta?.symbol && cleanTicker(result.meta.symbol) !== cleanTicker(symbol)) {
          throw new Error('YAHOO_PROVIDER_SYMBOL_MISMATCH');
        }
        return result;
      });
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

function yahooProviderTimestamp(result: YahooChartResult, index: number): string {
  const regularMarketTime = safeNumber(result.meta?.regularMarketTime, Number.NaN);
  const candleTime = safeNumber(result.timestamp?.[index], Number.NaN);
  const providerSeconds = Number.isFinite(regularMarketTime) && regularMarketTime > 0
    ? regularMarketTime
    : candleTime;
  const providerMs = providerSeconds * 1000;

  if (
    !Number.isFinite(providerMs)
    || providerMs <= 0
    || providerMs > Date.now() + 5 * 60 * 1000
  ) {
    throw new Error('YAHOO_PROVIDER_TIMESTAMP_INVALID');
  }

  return new Date(providerMs).toISOString();
}

function normalizeYahooCandles(result: YahooChartResult): Candle[] {
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

function aggregateContinuousCandles(
  rows: Candle[],
  size: number,
  maximumGapMs: number,
): Candle[] {
  if (size <= 1) return rows;

  const output: Candle[] = [];
  let chunk: Candle[] = [];

  const flush = () => {
    if (chunk.length === size) {
      output.push({
        time: chunk[0].time,
        open: chunk[0].open,
        high: Math.max(...chunk.map((item) => item.high)),
        low: Math.min(...chunk.map((item) => item.low)),
        close: chunk[chunk.length - 1].close,
        volume: chunk.reduce((sum, item) => sum + item.volume, 0),
      });
    }
    chunk = [];
  };

  for (const row of rows) {
    if (chunk.length > 0) {
      const previousMs = Date.parse(String(chunk[chunk.length - 1].time));
      const currentMs = Date.parse(String(row.time));
      const contiguous = Number.isFinite(previousMs)
        && Number.isFinite(currentMs)
        && currentMs > previousMs
        && currentMs - previousMs <= maximumGapMs;

      if (!contiguous) flush();
    }

    chunk.push(row);
    if (chunk.length === size) flush();
  }

  flush();
  return output;
}

export function aggregateYahooDerivedTimeframe(timeframe: string, rows: Candle[]): Candle[] {
  switch (String(timeframe)) {
    case '3m':
      return aggregateContinuousCandles(rows, 3, 90_000);
    case '4H':
      return aggregateContinuousCandles(rows, 4, 90 * 60_000);
    default:
      return rows;
  }
}

export async function getQuote(
  entryOrTicker: CatalogEntry | string,
  options: YahooChartRequestOptions = {},
): Promise<Partial<Quote>> {
  const ticker = getTickerFromEntry(entryOrTicker);
  const symbol = yahooSymbol(ticker, options);
  const result = await fetchYahooChart(symbol, undefined, options.signal);
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
    updatedAt: yahooProviderTimestamp(result, index),
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
  options: YahooChartRequestOptions = {},
): Promise<Candle[]> {
  const ticker = getTickerFromEntry(entryOrTicker);
  const symbol = yahooSymbol(ticker, options);
  const requestedTimeframe = String(timeframe ?? '1D');
  const sourceTimeframe = requestedTimeframe === '3m'
    ? '1m'
    : requestedTimeframe === '4H'
      ? '60m'
      : requestedTimeframe;
  const params = yahooChartParams(sourceTimeframe);
  // Scanning current signals does not need ten years of daily or two years of
  // hourly history per symbol. Long-history chart/research callers are unchanged.
  if (options.purpose === 'scanner') {
    if (sourceTimeframe === '1D') params.range = '1y';
    if (sourceTimeframe === '60m' || sourceTimeframe === '1H') params.range = '6mo';
  }
  const result = await fetchYahooChart(symbol, params, options.signal);
  const rows = normalizeYahooCandles(result);

  return aggregateYahooDerivedTimeframe(requestedTimeframe, rows);
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
    updatedAt: yahooProviderTimestamp(result, index),
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
