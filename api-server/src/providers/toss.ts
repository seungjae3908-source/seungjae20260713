import { ProviderError } from '../lib/errors';
import type { CatalogEntry, Currency, Market } from '../data/catalog';
import type { Candle, CompanyProfile, Timeframe } from '../sample/types';

const DEFAULT_BASE_URL = 'https://openapi.tossinvest.com';
const REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const MAX_TRANSIENT_RETRIES = 1;
const MAX_RATE_LIMIT_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 2_000;

const READ_ONLY_PATHS = new Set([
  '/api/v1/prices',
  '/api/v1/stocks',
  '/api/v1/candles',
  '/api/v1/orderbook',
]);

type TossReadPath =
  | '/api/v1/prices'
  | '/api/v1/stocks'
  | '/api/v1/candles'
  | '/api/v1/orderbook';

type TossCurrency = 'KRW' | 'USD';

type TossEnvelope<T> = {
  result?: T;
};

type TossTokenResponse = {
  access_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
};

type TossPriceResponse = {
  symbol?: unknown;
  timestamp?: unknown;
  lastPrice?: unknown;
  currency?: unknown;
};

type TossCandleResponse = {
  timestamp?: unknown;
  openPrice?: unknown;
  highPrice?: unknown;
  lowPrice?: unknown;
  closePrice?: unknown;
  volume?: unknown;
  currency?: unknown;
};

type TossCandlePage = {
  candles?: unknown;
  nextBefore?: unknown;
};

type TossStockResponse = {
  symbol?: unknown;
  name?: unknown;
  englishName?: unknown;
  isinCode?: unknown;
  market?: unknown;
  securityType?: unknown;
  isCommonShare?: unknown;
  status?: unknown;
  currency?: unknown;
  listDate?: unknown;
  delistDate?: unknown;
  sharesOutstanding?: unknown;
  leverageFactor?: unknown;
  koreanMarketDetail?: unknown;
};

type TossOrderbookLevel = {
  price?: unknown;
  volume?: unknown;
};

type TossOrderbookResponse = {
  timestamp?: unknown;
  currency?: unknown;
  asks?: unknown;
  bids?: unknown;
};

export interface TossCurrentPrice {
  ticker: string;
  price: number;
  currency: TossCurrency;
  updatedAt: string | null;
  provider: 'toss';
}

export interface TossStockInfo {
  ticker: string;
  name: string;
  englishName: string | null;
  isinCode: string | null;
  market: string;
  appMarket: Market;
  currency: TossCurrency;
  securityType: string;
  isCommonShare: boolean | null;
  status: string;
  listDate: string | null;
  delistDate: string | null;
  sharesOutstanding: number | null;
  leverageFactor: number | null;
  tradingSuspended: boolean | null;
  provider: 'toss';
}

export interface TossOrderbookLevelNormalized {
  price: number;
  volume: number;
}

export interface TossOrderbook {
  ticker: string;
  currency: TossCurrency;
  updatedAt: string | null;
  asks: TossOrderbookLevelNormalized[];
  bids: TossOrderbookLevelNormalized[];
  provider: 'toss';
}

export interface TossQuoteSnapshot {
  price: number;
  previousClose: number;
  changeAmount: number;
  changePercent: number;
  volume: number;
  open: number;
  high: number;
  low: number;
  updatedAt: string;
}

let tokenCache: { token: string; expiresAt: number } | null = null;
let tokenRefreshInFlight: Promise<string> | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireEnv(name: 'TOSS_CLIENT_ID' | 'TOSS_CLIENT_SECRET'): string {
  const value = process.env[name]?.trim();
  if (!value) throw new ProviderError('NOT_CONFIGURED', 'toss');
  return value;
}

function baseUrl(): string {
  const configured = process.env.TOSS_API_BASE_URL?.trim() || DEFAULT_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new ProviderError('NOT_CONFIGURED', 'toss', 'toss: invalid API base URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new ProviderError('NOT_CONFIGURED', 'toss', 'toss: API base URL must use https');
  }
  return parsed.toString().replace(/\/$/, '');
}

function cleanSymbol(value: unknown): string {
  const symbol = String(value ?? '').trim().toUpperCase();
  if (!symbol || !/^[A-Z0-9.-]+$/.test(symbol)) {
    throw new ProviderError('UNAVAILABLE', 'toss', 'toss: invalid symbol');
  }
  return symbol;
}

function entryTicker(entry: CatalogEntry): string {
  return cleanSymbol(entry.ticker);
}

function safeString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function requiredPositiveNumber(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ProviderError('UPSTREAM_ERROR', 'toss', `toss: invalid ${field}`);
  }
  return parsed;
}

function requiredNonNegativeNumber(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ProviderError('UPSTREAM_ERROR', 'toss', `toss: invalid ${field}`);
  }
  return parsed;
}

function optionalNonNegativeNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeCurrency(value: unknown): TossCurrency {
  const currency = String(value ?? '').trim().toUpperCase();
  if (currency === 'KRW' || currency === 'USD') return currency;
  throw new ProviderError('UPSTREAM_ERROR', 'toss', 'toss: unsupported currency');
}

function normalizeMarket(value: unknown, currency: TossCurrency): Market {
  const market = String(value ?? '').trim().toUpperCase();
  if (['KOSPI', 'KOSDAQ', 'KONEX', 'KRX', 'NXT', 'KR_ETC'].includes(market)) {
    return 'KR' as Market;
  }
  if (['NASDAQ', 'NYSE', 'AMEX', 'US_ETC'].includes(market)) {
    return 'US' as Market;
  }
  return (currency === 'KRW' ? 'KR' : 'US') as Market;
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get('retry-after');
  const seconds = retryAfter == null ? Number.NaN : Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(MAX_RETRY_DELAY_MS, Math.round(seconds * 1000));
  }
  return Math.min(MAX_RETRY_DELAY_MS, 250 * 2 ** attempt);
}

async function readJson<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    throw new ProviderError(
      'UPSTREAM_ERROR',
      'toss',
      `toss: invalid JSON response (HTTP ${response.status})`,
    );
  }
}

async function issueToken(attempt = 0): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: requireEnv('TOSS_CLIENT_ID'),
      client_secret: requireEnv('TOSS_CLIENT_SECRET'),
    });
    const response = await fetch(`${baseUrl()}/oauth2/token`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      signal: controller.signal,
    });

    if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      const delay = retryDelay(response, attempt);
      clearTimeout(timeout);
      await sleep(delay);
      return issueToken(attempt + 1);
    }
    if (response.status >= 500 && response.status <= 599 && attempt < MAX_TRANSIENT_RETRIES) {
      clearTimeout(timeout);
      await sleep(250 * (attempt + 1));
      return issueToken(attempt + 1);
    }
    if (!response.ok) {
      throw new ProviderError(
        response.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_ERROR',
        'toss',
        `toss: token request failed (HTTP ${response.status})`,
      );
    }

    const result = await readJson<TossTokenResponse>(response);
    const token = safeString(result.access_token);
    const expiresIn = Number(result.expires_in);
    if (!token || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new ProviderError('UPSTREAM_ERROR', 'toss', 'toss: invalid token response');
    }
    tokenCache = {
      token,
      expiresAt: Date.now() + expiresIn * 1000,
    };
    return token;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      if (attempt < MAX_TRANSIENT_RETRIES) return issueToken(attempt + 1);
      throw new ProviderError('UPSTREAM_ERROR', 'toss', 'toss: token request timeout');
    }
    if (attempt < MAX_TRANSIENT_RETRIES) {
      await sleep(250 * (attempt + 1));
      return issueToken(attempt + 1);
    }
    throw new ProviderError('UPSTREAM_ERROR', 'toss', 'toss: token request failed');
  } finally {
    clearTimeout(timeout);
  }
}

export function clearTossTokenCache(): void {
  tokenCache = null;
}

export function isTossConfigured(): boolean {
  return Boolean(
    process.env.TOSS_CLIENT_ID?.trim() && process.env.TOSS_CLIENT_SECRET?.trim(),
  );
}

export function getTossStatus() {
  return {
    provider: 'toss' as const,
    readOnly: true,
    clientIdRegistered: Boolean(process.env.TOSS_CLIENT_ID?.trim()),
    clientSecretRegistered: Boolean(process.env.TOSS_CLIENT_SECRET?.trim()),
    providerEndpointConfigured: Boolean(process.env.TOSS_API_BASE_URL?.trim()),
    tokenCached: Boolean(
      tokenCache && Date.now() < tokenCache.expiresAt - TOKEN_REFRESH_SKEW_MS,
    ),
  };
}

export async function getTossAccessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt - TOKEN_REFRESH_SKEW_MS) {
    return tokenCache.token;
  }
  if (tokenRefreshInFlight) return tokenRefreshInFlight;

  tokenRefreshInFlight = issueToken().finally(() => {
    tokenRefreshInFlight = null;
  });
  return tokenRefreshInFlight;
}

async function requestReadOnly<T>(
  path: TossReadPath,
  params: Record<string, string>,
  options: { authRetry?: boolean; transientRetry?: number; rateRetry?: number } = {},
): Promise<T> {
  if (!READ_ONLY_PATHS.has(path)) {
    throw new ProviderError('UPSTREAM_ERROR', 'toss', 'toss: blocked non-market-data path');
  }

  const authRetry = options.authRetry ?? true;
  const transientRetry = options.transientRetry ?? 0;
  const rateRetry = options.rateRetry ?? 0;
  const token = await getTossAccessToken();
  const url = new URL(`${baseUrl()}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    });

    if (response.status === 401 && authRetry) {
      clearTossTokenCache();
      clearTimeout(timeout);
      return requestReadOnly<T>(path, params, {
        authRetry: false,
        transientRetry,
        rateRetry,
      });
    }
    if (response.status === 429 && rateRetry < MAX_RATE_LIMIT_RETRIES) {
      const delay = retryDelay(response, rateRetry);
      clearTimeout(timeout);
      await sleep(delay);
      return requestReadOnly<T>(path, params, {
        authRetry,
        transientRetry,
        rateRetry: rateRetry + 1,
      });
    }
    if (
      response.status >= 500 &&
      response.status <= 599 &&
      transientRetry < MAX_TRANSIENT_RETRIES
    ) {
      clearTimeout(timeout);
      await sleep(250 * (transientRetry + 1));
      return requestReadOnly<T>(path, params, {
        authRetry,
        transientRetry: transientRetry + 1,
        rateRetry,
      });
    }
    if (!response.ok) {
      const code = response.status === 404
        ? 'UNAVAILABLE'
        : response.status === 429
          ? 'RATE_LIMITED'
          : 'UPSTREAM_ERROR';
      throw new ProviderError(code, 'toss', `toss: read failed (HTTP ${response.status})`);
    }
    return readJson<T>(response);
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      if (transientRetry < MAX_TRANSIENT_RETRIES) {
        return requestReadOnly<T>(path, params, {
          authRetry,
          transientRetry: transientRetry + 1,
          rateRetry,
        });
      }
      throw new ProviderError('UPSTREAM_ERROR', 'toss', 'toss: read timeout');
    }
    if (transientRetry < MAX_TRANSIENT_RETRIES) {
      await sleep(250 * (transientRetry + 1));
      return requestReadOnly<T>(path, params, {
        authRetry,
        transientRetry: transientRetry + 1,
        rateRetry,
      });
    }
    throw new ProviderError('UPSTREAM_ERROR', 'toss', 'toss: read request failed');
  } finally {
    clearTimeout(timeout);
  }
}

export async function getCurrentPrice(symbol: string): Promise<TossCurrentPrice> {
  const ticker = cleanSymbol(symbol);
  const payload = await requestReadOnly<TossEnvelope<TossPriceResponse[]>>(
    '/api/v1/prices',
    { symbols: ticker },
  );
  const row = Array.isArray(payload.result)
    ? payload.result.find((item) => cleanSymbol(item.symbol) === ticker)
    : undefined;
  if (!row) throw new ProviderError('UNAVAILABLE', 'toss');

  return {
    ticker,
    price: requiredPositiveNumber(row.lastPrice, 'lastPrice'),
    currency: normalizeCurrency(row.currency),
    updatedAt: safeString(row.timestamp),
    provider: 'toss',
  };
}

export async function getStockInfo(symbol: string): Promise<TossStockInfo> {
  const ticker = cleanSymbol(symbol);
  const payload = await requestReadOnly<TossEnvelope<TossStockResponse[]>>(
    '/api/v1/stocks',
    { symbols: ticker },
  );
  const row = Array.isArray(payload.result)
    ? payload.result.find((item) => cleanSymbol(item.symbol) === ticker)
    : undefined;
  if (!row) throw new ProviderError('UNAVAILABLE', 'toss');

  const currency = normalizeCurrency(row.currency);
  const detail = row.koreanMarketDetail && typeof row.koreanMarketDetail === 'object'
    ? row.koreanMarketDetail as Record<string, unknown>
    : null;
  const suspendedValues = detail
    ? [detail.krxTradingSuspended, detail.nxtTradingSuspended].filter(
        (value): value is boolean => typeof value === 'boolean',
      )
    : [];

  return {
    ticker,
    name: safeString(row.name) ?? safeString(row.englishName) ?? ticker,
    englishName: safeString(row.englishName),
    isinCode: safeString(row.isinCode),
    market: safeString(row.market) ?? '',
    appMarket: normalizeMarket(row.market, currency),
    currency,
    securityType: safeString(row.securityType) ?? 'UNKNOWN',
    isCommonShare: typeof row.isCommonShare === 'boolean' ? row.isCommonShare : null,
    status: safeString(row.status) ?? 'UNKNOWN',
    listDate: safeString(row.listDate),
    delistDate: safeString(row.delistDate),
    sharesOutstanding: optionalNonNegativeNumber(row.sharesOutstanding),
    leverageFactor: optionalNonNegativeNumber(row.leverageFactor),
    tradingSuspended: suspendedValues.length > 0
      ? suspendedValues.some(Boolean)
      : null,
    provider: 'toss',
  };
}

export async function getCompanyProfile(entry: CatalogEntry): Promise<CompanyProfile> {
  const info = await getStockInfo(entryTicker(entry));
  return {
    ticker: info.ticker,
    name: info.name,
    market: info.appMarket,
    currency: info.currency as Currency,
    description: '',
    industry: '',
    sector: '',
    country: info.appMarket === ('KR' as Market) ? '대한민국' : '미국',
    mainBusiness: '',
    competitors: [],
  };
}

export async function getCandles(
  entry: CatalogEntry,
  timeframe: Timeframe | string = '1D',
  count = 200,
): Promise<Candle[]> {
  const interval = timeframe === '1m' ? '1m' : timeframe === '1D' ? '1d' : null;
  if (!interval) return [];
  const boundedCount = Math.max(1, Math.min(200, Math.trunc(count)));
  const payload = await requestReadOnly<TossEnvelope<TossCandlePage>>(
    '/api/v1/candles',
    {
      symbol: entryTicker(entry),
      interval,
      count: String(boundedCount),
      adjusted: 'true',
    },
  );
  const raw = payload.result?.candles;
  if (!Array.isArray(raw)) return [];

  const rows = raw.map((item): Candle => {
    const candle = item as TossCandleResponse;
    const timestamp = safeString(candle.timestamp);
    if (!timestamp || Number.isNaN(Date.parse(timestamp))) {
      throw new ProviderError('UPSTREAM_ERROR', 'toss', 'toss: invalid candle timestamp');
    }
    return {
      time: timestamp,
      open: requiredPositiveNumber(candle.openPrice, 'openPrice'),
      high: requiredPositiveNumber(candle.highPrice, 'highPrice'),
      low: requiredPositiveNumber(candle.lowPrice, 'lowPrice'),
      close: requiredPositiveNumber(candle.closePrice, 'closePrice'),
      volume: requiredNonNegativeNumber(candle.volume, 'volume'),
    };
  });

  rows.sort((a, b) => Date.parse(String(a.time)) - Date.parse(String(b.time)));
  return rows;
}

export async function getQuote(entry: CatalogEntry): Promise<TossQuoteSnapshot> {
  const [current, candles] = await Promise.all([
    getCurrentPrice(entryTicker(entry)),
    getCandles(entry, '1D', 3),
  ]);
  if (candles.length < 2) {
    throw new ProviderError('UNAVAILABLE', 'toss', 'toss: insufficient daily candles for quote');
  }
  const latest = candles[candles.length - 1];
  const previous = candles[candles.length - 2];
  const previousClose = previous.close;
  const changeAmount = current.price - previousClose;
  const changePercent = previousClose > 0 ? (changeAmount / previousClose) * 100 : 0;
  const updatedAt = current.updatedAt ?? String(latest.time);
  if (!updatedAt) {
    throw new ProviderError('UPSTREAM_ERROR', 'toss', 'toss: quote timestamp unavailable');
  }
  return {
    price: current.price,
    previousClose,
    changeAmount,
    changePercent,
    volume: latest.volume,
    open: latest.open,
    high: latest.high,
    low: latest.low,
    updatedAt,
  };
}

function normalizeOrderbookLevels(value: unknown, side: 'asks' | 'bids'): TossOrderbookLevelNormalized[] {
  if (!Array.isArray(value)) {
    throw new ProviderError('UPSTREAM_ERROR', 'toss', `toss: invalid ${side}`);
  }
  return value.map((item) => {
    const row = item as TossOrderbookLevel;
    return {
      price: requiredPositiveNumber(row.price, `${side}.price`),
      volume: requiredNonNegativeNumber(row.volume, `${side}.volume`),
    };
  });
}

export async function getOrderbook(symbol: string): Promise<TossOrderbook> {
  const ticker = cleanSymbol(symbol);
  const payload = await requestReadOnly<TossEnvelope<TossOrderbookResponse>>(
    '/api/v1/orderbook',
    { symbol: ticker },
  );
  if (!payload.result) throw new ProviderError('UNAVAILABLE', 'toss');

  return {
    ticker,
    currency: normalizeCurrency(payload.result.currency),
    updatedAt: safeString(payload.result.timestamp),
    asks: normalizeOrderbookLevels(payload.result.asks, 'asks'),
    bids: normalizeOrderbookLevels(payload.result.bids, 'bids'),
    provider: 'toss',
  };
}
