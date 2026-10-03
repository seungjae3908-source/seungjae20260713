import MarketDataService from './market-data.service';
import {
  FUTURES_TIMEFRAME_MS,
  normalizeBitgetCandles,
  normalizeFuturesSymbol,
  type NormalizedCandle,
} from './futures-market-data.service';
import { BACKTEST_LIMITS, BacktestValidationError, type BacktestMarket } from './backtest-engine.service';

const BITGET_BASE_URL = 'https://api.bitget.com';
const UPBIT_BASE_URL = 'https://api.upbit.com';
const PRODUCT_TYPE = 'USDT-FUTURES';
const PROVIDER_PAGE_LIMIT = 200;
const PROVIDER_MAX_WINDOW_MS = 90 * 24 * 60 * 60_000;
const PROVIDER_TIMEOUT_MS = 8_000;
const MAX_PAGES = Math.ceil(BACKTEST_LIMITS.maximumCandles / PROVIDER_PAGE_LIMIT) + 2;

const TIMEFRAME_MS: Readonly<Record<string, number>> = Object.freeze({
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '60m': 60 * 60_000,
  '1H': 60 * 60_000,
  '4H': 4 * 60 * 60_000,
  '1D': 24 * 60 * 60_000,
});

const UPBIT_UNIT: Readonly<Record<string, string>> = Object.freeze({
  '1m': 'minutes/1',
  '5m': 'minutes/5',
  '15m': 'minutes/15',
  '30m': 'minutes/30',
  '60m': 'minutes/60',
  '1H': 'minutes/60',
  '4H': 'minutes/240',
  '1D': 'days',
});

export type HistoricalBacktestData = {
  candles: NormalizedCandle[];
  warnings: string[];
  requestCount: number;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeMarketSymbol(market: BacktestMarket, value: unknown): string {
  const symbol = String(value ?? '').trim().toUpperCase();
  if (market === 'crypto-futures') {
    const normalized = normalizeFuturesSymbol(symbol);
    if (!normalized) throw new BacktestValidationError('INVALID_SYMBOL', '코인선물 종목 형식이 올바르지 않습니다.');
    return normalized;
  }
  if (market === 'crypto-spot') {
    if (!/^(?:KRW-)?[A-Z0-9]{1,20}$/u.test(symbol)) {
      throw new BacktestValidationError('INVALID_SYMBOL', '코인현물 종목 형식이 올바르지 않습니다.');
    }
    return symbol;
  }
  if (market === 'kr-stock') {
    if (!/^\d{6}$/u.test(symbol)) throw new BacktestValidationError('INVALID_SYMBOL', '국내주식 종목코드는 6자리여야 합니다.');
    return symbol;
  }
  if (!/^[A-Z0-9.-]{1,16}$/u.test(symbol)) {
    throw new BacktestValidationError('INVALID_SYMBOL', '미국주식 종목 형식이 올바르지 않습니다.');
  }
  return symbol;
}

function validateRange(timeframe: string, startTime: number, endTime: number) {
  const timeframeMs = TIMEFRAME_MS[timeframe];
  if (!timeframeMs) throw new BacktestValidationError('INVALID_TIMEFRAME', '지원하지 않는 시간봉입니다.');
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime >= endTime) {
    throw new BacktestValidationError('INVALID_PERIOD', '과거 데이터 조회 기간이 올바르지 않습니다.');
  }
  if (endTime - startTime > BACKTEST_LIMITS.maximumDurationMs) {
    throw new BacktestValidationError('PERIOD_LIMIT_EXCEEDED', '과거 데이터 조회 기간 상한을 초과했습니다.');
  }
  const expectedCount = Math.ceil((endTime - startTime) / timeframeMs);
  if (expectedCount > BACKTEST_LIMITS.maximumCandles) {
    throw new BacktestValidationError('CANDLE_LIMIT_EXCEEDED', '요청 기간의 예상 캔들 수가 상한을 초과했습니다.');
  }
  return timeframeMs;
}

async function fetchBitgetPage(input: {
  symbol: string;
  timeframe: string;
  startTime: number;
  endTime: number;
  signal?: AbortSignal;
  fetchImpl: typeof fetch;
}) {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  input.signal?.addEventListener('abort', forwardAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  const url = new URL('/api/v2/mix/market/history-candles', BITGET_BASE_URL);
  url.searchParams.set('symbol', input.symbol);
  url.searchParams.set('productType', PRODUCT_TYPE);
  url.searchParams.set('granularity', input.timeframe);
  url.searchParams.set('startTime', String(input.startTime));
  url.searchParams.set('endTime', String(input.endTime));
  url.searchParams.set('limit', String(PROVIDER_PAGE_LIMIT));
  try {
    const response = await input.fetchImpl(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'seungjae-investment-app/2.0' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`BITGET_HTTP_${response.status}`);
    const payload = await response.json() as unknown;
    if (!isObject(payload) || String(payload.code ?? '') !== '00000' || !Array.isArray(payload.data)) {
      throw new Error('BITGET_INVALID_RESPONSE');
    }
    return payload.data;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new BacktestValidationError('PROVIDER_TIMEOUT', '코인선물 과거 데이터 요청 시간이 초과되었습니다.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener('abort', forwardAbort);
  }
}

async function loadFutures(input: {
  symbol: string;
  timeframe: string;
  startTime: number;
  endTime: number;
  signal?: AbortSignal;
  fetchImpl: typeof fetch;
  now: number;
}): Promise<HistoricalBacktestData> {
  const timeframeMs = validateRange(input.timeframe, input.startTime, input.endTime);
  const byTimestamp = new Map<number, NormalizedCandle>();
  const warnings: string[] = [];
  let cursorEnd = input.endTime;
  let requestCount = 0;

  while (cursorEnd >= input.startTime && requestCount < MAX_PAGES) {
    if (input.signal?.aborted) throw new BacktestValidationError('BACKTEST_CANCELLED', '백테스트 요청이 취소되었습니다.');
    const windowStart = Math.max(input.startTime, cursorEnd - PROVIDER_MAX_WINDOW_MS);
    const rows = await fetchBitgetPage({
      symbol: input.symbol,
      timeframe: input.timeframe,
      startTime: windowStart,
      endTime: cursorEnd,
      signal: input.signal,
      fetchImpl: input.fetchImpl,
    });
    requestCount += 1;
    const normalized = normalizeBitgetCandles(rows, input.symbol, input.timeframe, input.now);
    for (const candle of normalized.data) {
      if (candle.timestamp >= input.startTime && candle.timestamp <= input.endTime && candle.isClosed) {
        byTimestamp.set(candle.timestamp, candle);
      }
    }
    warnings.push(...normalized.warnings);
    const earliest = normalized.data.at(0)?.timestamp;
    if (earliest == null || rows.length === 0) {
      if (windowStart > input.startTime) cursorEnd = windowStart - timeframeMs;
      else break;
    } else {
      const nextEnd = earliest - timeframeMs;
      if (nextEnd >= cursorEnd) break;
      cursorEnd = nextEnd;
    }
    if (byTimestamp.size >= BACKTEST_LIMITS.maximumCandles) break;
  }
  return finalize([...byTimestamp.values()], warnings, requestCount, timeframeMs, input.startTime, input.endTime);
}

function upbitProviderSymbol(symbol: string) {
  return symbol.startsWith('KRW-') ? symbol : `KRW-${symbol}`;
}

function upbitTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(/[zZ]|[+-]\d\d:\d\d$/u.test(value) ? value : `${value}Z`);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function fetchUpbitPage(input: {
  providerSymbol: string;
  timeframe: string;
  cursor: number;
  signal?: AbortSignal;
  fetchImpl: typeof fetch;
}) {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  input.signal?.addEventListener('abort', forwardAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  const endpoint = UPBIT_UNIT[input.timeframe];
  if (!endpoint) throw new BacktestValidationError('INVALID_TIMEFRAME', '코인현물에서 지원하지 않는 시간봉입니다.');
  const url = new URL(`/v1/candles/${endpoint}`, UPBIT_BASE_URL);
  url.searchParams.set('market', input.providerSymbol);
  url.searchParams.set('to', new Date(input.cursor).toISOString());
  url.searchParams.set('count', String(PROVIDER_PAGE_LIMIT));
  try {
    const response = await input.fetchImpl(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'seungjae-investment-app/2.0' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`UPBIT_HTTP_${response.status}`);
    const payload = await response.json() as unknown;
    if (!Array.isArray(payload)) throw new Error('UPBIT_INVALID_RESPONSE');
    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new BacktestValidationError('PROVIDER_TIMEOUT', '코인현물 과거 데이터 요청 시간이 초과되었습니다.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener('abort', forwardAbort);
  }
}

async function loadSpot(input: {
  symbol: string;
  timeframe: string;
  startTime: number;
  endTime: number;
  signal?: AbortSignal;
  fetchImpl: typeof fetch;
  now: number;
}): Promise<HistoricalBacktestData> {
  const timeframeMs = validateRange(input.timeframe, input.startTime, input.endTime);
  if (!UPBIT_UNIT[input.timeframe]) throw new BacktestValidationError('INVALID_TIMEFRAME', '코인현물에서 지원하지 않는 시간봉입니다.');
  const providerSymbol = upbitProviderSymbol(input.symbol);
  const byTimestamp = new Map<number, NormalizedCandle>();
  const warnings: string[] = [];
  let cursor = input.endTime;
  let requestCount = 0;

  while (cursor > input.startTime && requestCount < MAX_PAGES && byTimestamp.size < BACKTEST_LIMITS.maximumCandles) {
    if (input.signal?.aborted) throw new BacktestValidationError('BACKTEST_CANCELLED', '백테스트 요청이 취소되었습니다.');
    const rows = await fetchUpbitPage({ providerSymbol, timeframe: input.timeframe, cursor, signal: input.signal, fetchImpl: input.fetchImpl });
    requestCount += 1;
    if (!rows.length) break;
    let oldest = Number.POSITIVE_INFINITY;
    for (const raw of rows) {
      if (!isObject(raw)) continue;
      const timestamp = upbitTimestamp(raw.candle_date_time_utc);
      const open = Number(raw.opening_price);
      const high = Number(raw.high_price);
      const low = Number(raw.low_price);
      const close = Number(raw.trade_price);
      const volume = Number(raw.candle_acc_trade_volume);
      const quoteVolume = Number(raw.candle_acc_trade_price);
      if (timestamp == null || ![open, high, low, close, volume].every(Number.isFinite)
        || open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0
        || high < Math.max(open, close) || low > Math.min(open, close)) continue;
      oldest = Math.min(oldest, timestamp);
      if (timestamp < input.startTime || timestamp > input.endTime || timestamp + timeframeMs > input.now) continue;
      byTimestamp.set(timestamp, {
        timestamp, open, high, low, close, volume,
        quoteVolume: Number.isFinite(quoteVolume) && quoteVolume >= 0 ? quoteVolume : null,
        timeframe: input.timeframe,
        symbol: input.symbol,
        market: 'crypto-spot',
        source: 'upbit-public',
        isClosed: true,
        isDelayed: false,
        updatedAt: new Date(timestamp + timeframeMs).toISOString(),
      });
    }
    if (!Number.isFinite(oldest) || oldest <= input.startTime) break;
    const next = oldest - 1;
    if (next >= cursor) break;
    cursor = next;
  }
  return finalize([...byTimestamp.values()], warnings, requestCount, timeframeMs, input.startTime, input.endTime);
}

async function loadStock(input: {
  market: 'kr-stock' | 'us-stock';
  symbol: string;
  timeframe: string;
  startTime: number;
  endTime: number;
  signal?: AbortSignal;
  now: number;
}): Promise<HistoricalBacktestData> {
  const timeframeMs = validateRange(input.timeframe, input.startTime, input.endTime);
  if (input.signal?.aborted) throw new BacktestValidationError('BACKTEST_CANCELLED', '백테스트 요청이 취소되었습니다.');
  const meta = await MarketDataService.getCandlesMeta(input.symbol, input.timeframe as never);
  if (input.signal?.aborted) throw new BacktestValidationError('BACKTEST_CANCELLED', '백테스트 요청이 취소되었습니다.');
  const candles: NormalizedCandle[] = meta.candles.flatMap((row) => {
    const timestamp = Date.parse(String(row.time));
    if (!Number.isFinite(timestamp) || timestamp < input.startTime || timestamp > input.endTime
      || timestamp + timeframeMs > input.now) return [];
    const open = Number(row.open);
    const high = Number(row.high);
    const low = Number(row.low);
    const close = Number(row.close);
    const volume = Number(row.volume);
    if (![open, high, low, close, volume].every(Number.isFinite)
      || open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0
      || high < Math.max(open, close) || low > Math.min(open, close)) return [];
    return [{
      timestamp, open, high, low, close, volume,
      quoteVolume: null,
      timeframe: input.timeframe,
      symbol: input.symbol,
      market: input.market,
      source: meta.provider,
      isClosed: true,
      isDelayed: true,
      updatedAt: meta.fetchedAt,
    }];
  });
  const warnings = candles.length ? [] : ['요청 기간에 사용할 수 있는 주식 완료 캔들이 없습니다.'];
  return finalize(candles, warnings, 1, timeframeMs, input.startTime, input.endTime);
}

function finalize(
  raw: NormalizedCandle[],
  warnings: string[],
  requestCount: number,
  timeframeMs: number,
  startTime: number,
  endTime: number,
): HistoricalBacktestData {
  const byTimestamp = new Map<number, NormalizedCandle>();
  for (const candle of raw) byTimestamp.set(candle.timestamp, candle);
  const candles = [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
  if (candles.length > BACKTEST_LIMITS.maximumCandles) {
    throw new BacktestValidationError('CANDLE_LIMIT_EXCEEDED', '정규화된 캔들 수가 상한을 초과했습니다.');
  }
  let gapCount = 0;
  for (let index = 1; index < candles.length; index += 1) {
    if (candles[index].timestamp - candles[index - 1].timestamp > timeframeMs * 3) gapCount += 1;
  }
  if (gapCount) warnings.push(`캔들 누락 구간 ${gapCount}개를 감지했으며 임의 데이터로 채우지 않았습니다.`);
  if (!candles.length) warnings.push('요청 기간에 사용할 수 있는 완료 캔들이 없습니다.');
  if (candles.length && candles[0].timestamp > startTime + timeframeMs * 2) warnings.push('공개 제공자의 보유 범위 때문에 요청 시작 구간 일부가 제외됐습니다.');
  if (candles.length && candles.at(-1)!.timestamp < endTime - timeframeMs * 2) warnings.push('요청 종료 구간까지 공개 데이터가 완전히 이어지지 않습니다.');
  return { candles, warnings: [...new Set(warnings)], requestCount };
}

export async function loadHistoricalBacktestCandles(input: {
  market?: BacktestMarket;
  symbol: unknown;
  timeframe: unknown;
  startTime: number;
  endTime: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<HistoricalBacktestData> {
  const market = input.market ?? 'crypto-futures';
  const symbol = normalizeMarketSymbol(market, input.symbol);
  const timeframe = String(input.timeframe ?? (market === 'crypto-futures' ? '15m' : '1D'));
  const now = input.now ?? Date.now();
  const fetchImpl = input.fetchImpl ?? fetch;
  if (market === 'crypto-futures') {
    return loadFutures({ symbol, timeframe, startTime: input.startTime, endTime: input.endTime, signal: input.signal, fetchImpl, now });
  }
  if (market === 'crypto-spot') {
    return loadSpot({ symbol, timeframe, startTime: input.startTime, endTime: input.endTime, signal: input.signal, fetchImpl, now });
  }
  return loadStock({ market, symbol, timeframe, startTime: input.startTime, endTime: input.endTime, signal: input.signal, now });
}
