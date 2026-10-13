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

// Yahoo's public chart endpoints share provider and egress-IP limits. Keep one
// process-wide start gate for every Yahoo request: per-call hedging multiplies
// traffic and turns one scanner batch into an avoidable query1/query2 burst.
const YAHOO_DEFAULT_REQUEST_TIMEOUT_MS = 1_650;
const YAHOO_DEFAULT_MINIMUM_START_INTERVAL_MS = 1_000;
const YAHOO_DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
const YAHOO_TRANSPORT_FALLBACK_DELAY_MS = 150;
const YAHOO_MAX_CACHE_ENTRIES = 1_000;
const YAHOO_HOSTS = Object.freeze([
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
] as const);

export interface YahooChartRequestOptions {
  signal?: AbortSignal;
  purpose?: 'scanner';
  exchange?: string | null;
}

type YahooRuntimeCacheEntry = { value: unknown; expiresAt: number };

const yahooCache = new Map<string, YahooRuntimeCacheEntry>();
const yahooInFlight = new Map<string, Promise<unknown>>();
let yahooTransportIdentity: typeof globalThis.fetch = globalThis.fetch;
let yahooScheduleTail: Promise<void> = Promise.resolve();
let yahooNextStartAt = 0;
let yahooRateLimitedUntil = 0;
let yahooMinimumStartIntervalMs = YAHOO_DEFAULT_MINIMUM_START_INTERVAL_MS;
let yahooRateLimitCooldownMs = YAHOO_DEFAULT_RATE_LIMIT_COOLDOWN_MS;
let yahooTransportFallbackDelayMs = YAHOO_TRANSPORT_FALLBACK_DELAY_MS;
let yahooRequestTimeoutMs = YAHOO_DEFAULT_REQUEST_TIMEOUT_MS;
let yahooDiagnostics = {
  actualRequests: 0,
  successfulResponses: 0,
  cacheHits: 0,
  deduplicatedRequests: 0,
  delayedStarts: 0,
  transportFallbacks: 0,
  rateLimitResponses: 0,
  lastRateLimitAt: null as string | null,
  lastRateLimitBody: null as string | null,
};

class YahooHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | null,
    readonly responseBody: string,
  ) {
    super(`YAHOO_CHART_HTTP_${status}`);
    this.name = 'YahooHttpError';
  }
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(minimum, Math.min(maximum, Math.floor(parsed)))
    : fallback;
}

function yahooRetryAfterMs(response: Response): number | null {
  const raw = response.headers.get('retry-after')?.trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, seconds * 1_000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.min(60_000, Math.max(0, date - Date.now())) : null;
}

function synchronizeYahooTransportIdentity(): void {
  if (globalThis.fetch === yahooTransportIdentity) return;
  // A replaced transport is a new request boundary (for example, a runtime
  // instrumentation swap). Never return payloads or cooldown state that were
  // produced by a different transport implementation.
  yahooTransportIdentity = globalThis.fetch;
  yahooCache.clear();
  yahooInFlight.clear();
  yahooScheduleTail = Promise.resolve();
  yahooNextStartAt = 0;
  yahooRateLimitedUntil = 0;
}

function yahooAbortReason(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error('YAHOO_CHART_ABORTED');
}

async function waitForYahooStart(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) throw yahooAbortReason(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(yahooAbortReason(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function scheduledYahooStart<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let release!: () => void;
  const previous = yahooScheduleTail;
  yahooScheduleTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    if (signal?.aborted) throw yahooAbortReason(signal);
    const waitMs = Math.max(0, yahooNextStartAt - Date.now());
    if (waitMs > 0) {
      yahooDiagnostics.delayedStarts += 1;
      await waitForYahooStart(waitMs, signal);
    }
    if (Date.now() < yahooRateLimitedUntil) {
      throw new YahooHttpError(429, yahooRateLimitedUntil - Date.now(), 'RATE_LIMIT_COOLDOWN_ACTIVE');
    }
    yahooNextStartAt = Date.now() + yahooMinimumStartIntervalMs;
    const started = operation();
    release();
    return await started;
  } catch (error) {
    release();
    throw error;
  }
}

async function fetchYahooJsonUrl<T>(url: string, signal?: AbortSignal): Promise<T> {
  return scheduledYahooStart(async () => {
    const controller = new AbortController();
    let rejectDeadline: (reason: unknown) => void = () => {};
    const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
    const abort = (reason: Error) => {
      controller.abort(reason);
      rejectDeadline(reason);
    };
    const onAbort = () => abort(yahooAbortReason(signal));
    signal?.addEventListener('abort', onAbort, { once: true });
    const timeoutError = new Error('YAHOO_CHART_BUDGET_EXCEEDED');
    const timeout = setTimeout(() => abort(timeoutError), yahooRequestTimeoutMs);
    try {
      const request = (async () => {
        yahooDiagnostics.actualRequests += 1;
        const response = await fetch(url, {
          redirect: 'follow',
          signal: controller.signal,
          headers: {
            accept: 'application/json,text/plain,*/*',
            'accept-language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
            'user-agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
          },
        });
        if (!response.ok) {
          const body = (await response.text().catch(() => '')).trim().slice(0, 160);
          const retryAfterMs = yahooRetryAfterMs(response);
          if (response.status === 429) {
            yahooDiagnostics.rateLimitResponses += 1;
            yahooDiagnostics.lastRateLimitAt = new Date().toISOString();
            yahooDiagnostics.lastRateLimitBody = body || null;
            yahooRateLimitedUntil = Math.max(
              yahooRateLimitedUntil,
              Date.now() + Math.max(retryAfterMs ?? 0, yahooRateLimitCooldownMs),
            );
          }
          throw new YahooHttpError(response.status, retryAfterMs, body);
        }
        yahooDiagnostics.successfulResponses += 1;
        return await response.json() as T;
      })();
      return await Promise.race([request, deadline]);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }
  }, signal);
}

function yahooHostsForRequest(): readonly string[] {
  // query1 is the stable primary. query2 is only a bounded transport/5xx
  // fallback; it is never rotated into use as a rate-limit workaround.
  return YAHOO_HOSTS;
}

async function loadYahooJson<T>(
  cacheKey: string,
  pathAndQuery: string,
  ttlMs: number,
  signal?: AbortSignal,
): Promise<T> {
  synchronizeYahooTransportIdentity();
  const cached = yahooCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    yahooDiagnostics.cacheHits += 1;
    yahooCache.delete(cacheKey);
    yahooCache.set(cacheKey, cached);
    return cached.value as T;
  }
  if (cached) yahooCache.delete(cacheKey);
  // A caller-owned abort signal must not cancel a shared request belonging to
  // another caller. Signal-bound Scanner reads still use the global start gate
  // and cache, but do not participate in cross-caller single-flight sharing.
  const shareInFlight = signal == null;
  const running = shareInFlight ? yahooInFlight.get(cacheKey) as Promise<T> | undefined : undefined;
  if (running) {
    yahooDiagnostics.deduplicatedRequests += 1;
    return running;
  }

  const request = (async () => {
    const errors: string[] = [];
    const hosts = yahooHostsForRequest();
    for (let index = 0; index < hosts.length; index += 1) {
      try {
        const value = await fetchYahooJsonUrl<T>(`https://${hosts[index]}${pathAndQuery}`, signal);
        const now = Date.now();
        for (const [key, entry] of yahooCache) {
          if (entry.expiresAt <= now) yahooCache.delete(key);
        }
        while (yahooCache.size >= YAHOO_MAX_CACHE_ENTRIES) {
          const oldest = yahooCache.keys().next().value;
          if (typeof oldest !== 'string') break;
          yahooCache.delete(oldest);
        }
        yahooCache.set(cacheKey, { value, expiresAt: Date.now() + ttlMs });
        return value;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        if (signal?.aborted) throw error;
        // A provider 429 applies to the shared Yahoo service/egress identity.
        // Trying the other hostname is not a legitimate rate-limit bypass.
        if (error instanceof YahooHttpError && (error.status === 429 || error.status < 500)) throw error;
        if (index + 1 < hosts.length) {
          yahooDiagnostics.transportFallbacks += 1;
          if (yahooTransportFallbackDelayMs > 0) await sleep(yahooTransportFallbackDelayMs);
        }
      }
    }
    throw new Error(`YAHOO_BOUNDED_HOSTS_FAILED:${errors.join('|')}`);
  })();
  if (!shareInFlight) return request;
  let shared!: Promise<T>;
  shared = request.finally(() => {
    if (yahooInFlight.get(cacheKey) === shared) yahooInFlight.delete(cacheKey);
  });
  yahooInFlight.set(cacheKey, shared as Promise<unknown>);
  return shared;
}

/**
 * Shared entry point for Yahoo endpoints that are not chart helpers. Keeping
 * them here prevents screeners/profile/FX reads from bypassing the same
 * process-wide rate gate and 429 cooldown used by the Scanner.
 */
export function getGovernedYahooJson<T>(pathAndQuery: string, ttlMs = 30_000): Promise<T> {
  if (!pathAndQuery.startsWith('/') || pathAndQuery.includes('://')) {
    return Promise.reject(new Error('YAHOO_PATH_AND_QUERY_REQUIRED'));
  }
  const boundedTtlMs = boundedInteger(ttlMs, 30_000, 1_000, 24 * 60 * 60_000);
  return loadYahooJson<T>(`raw:${pathAndQuery}`, pathAndQuery, boundedTtlMs);
}

export function yahooProviderDiagnostics() {
  const snapshot = { ...yahooDiagnostics };
  return Object.freeze({
    ...snapshot,
    minimumStartIntervalMs: yahooMinimumStartIntervalMs,
    requestTimeoutMs: yahooRequestTimeoutMs,
    rateLimitCooldownUntil: yahooRateLimitedUntil > Date.now()
      ? new Date(yahooRateLimitedUntil).toISOString()
      : null,
    causeAssessment: Object.freeze({
      callFrequencyControlled: yahooMinimumStartIntervalMs > 0,
      localBurstPrevented: snapshot.delayedStarts > 0 || snapshot.deduplicatedRequests > 0,
      providerLimitConfirmed: snapshot.rateLimitResponses > 0,
      sharedEgressIpSuspected: snapshot.rateLimitResponses > 0
        && snapshot.successfulResponses === 0
        && snapshot.actualRequests <= 2,
    }),
  });
}

export function resetYahooProviderRuntimeForDiagnostics(options: {
  minimumStartIntervalMs?: number;
  rateLimitCooldownMs?: number;
  transportFallbackDelayMs?: number;
  requestTimeoutMs?: number;
} = {}): void {
  yahooTransportIdentity = globalThis.fetch;
  yahooCache.clear();
  yahooInFlight.clear();
  yahooScheduleTail = Promise.resolve();
  yahooNextStartAt = 0;
  yahooRateLimitedUntil = 0;
  yahooMinimumStartIntervalMs = boundedInteger(
    options.minimumStartIntervalMs,
    YAHOO_DEFAULT_MINIMUM_START_INTERVAL_MS,
    0,
    10_000,
  );
  yahooRateLimitCooldownMs = boundedInteger(
    options.rateLimitCooldownMs,
    YAHOO_DEFAULT_RATE_LIMIT_COOLDOWN_MS,
    0,
    300_000,
  );
  yahooTransportFallbackDelayMs = boundedInteger(
    options.transportFallbackDelayMs,
    YAHOO_TRANSPORT_FALLBACK_DELAY_MS,
    0,
    5_000,
  );
  yahooRequestTimeoutMs = boundedInteger(
    options.requestTimeoutMs,
    YAHOO_DEFAULT_REQUEST_TIMEOUT_MS,
    1,
    10_000,
  );
  yahooDiagnostics = {
    actualRequests: 0,
    successfulResponses: 0,
    cacheHits: 0,
    deduplicatedRequests: 0,
    delayedStarts: 0,
    transportFallbacks: 0,
    rateLimitResponses: 0,
    lastRateLimitAt: null,
    lastRateLimitBody: null,
  };
}

export const resetYahooProviderRuntimeForTests = resetYahooProviderRuntimeForDiagnostics;

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
    if (options.purpose === 'scanner' && !/^(?:KOSPI|코스피|유가증권)$/u.test(exchange)) {
      throw new Error('YAHOO_PROVIDER_KR_EXCHANGE_MAPPING_UNAVAILABLE');
    }
    return `${clean}.KS`;
  }
  if (/^[A-Z0-9]+\.[A-Z0-9]+$/u.test(clean)) return clean.replace(/\./gu, '-');

  return clean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validChart(data: any, resource: string): YahooChartResult {
  const result = data?.chart?.result?.[0];
  if (!result?.indicators?.quote?.[0]) throw new Error(`YAHOO_CHART_EMPTY_RESULT:${resource}`);
  return result as YahooChartResult;
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

  const q = query[0];
  const pathAndQuery = `/v8/finance/chart/${encoded}?${q}`;
  const interval = params?.interval ?? '1d';
  const ttlMs = params == null
    ? 10_000
    : /m|h/iu.test(interval)
      ? 30_000
      : 5 * 60_000;
  try {
    const data = await loadYahooJson<any>(`chart:${symbol}:${q}`, pathAndQuery, ttlMs, signal);
    const result = validChart(data, pathAndQuery);
    if (result.meta?.symbol && cleanTicker(result.meta.symbol) !== cleanTicker(symbol)) {
      throw new Error('YAHOO_PROVIDER_SYMBOL_MISMATCH');
    }
    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`YAHOO_PROVIDER_MARKER_20260711_FAILED:${symbol}:${detail}`);
  }
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
  // Current-signal scanning needs recent evidence, not multi-year payloads.
  // Long-history chart and research callers keep the original ranges.
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
  const pathAndQuery = `/v10/finance/quoteSummary/${encoded}?modules=assetProfile`;
  try {
    const data = await loadYahooJson<any>(`sector:${clean}`, pathAndQuery, 6 * 60 * 60_000);
    const sector = data?.quoteSummary?.result?.[0]?.assetProfile?.sector;
    const value = String(sector ?? '').trim();
    return value || null;
  } catch {
    return null;
  }
}
