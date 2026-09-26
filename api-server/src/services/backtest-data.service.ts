import {
  FUTURES_TIMEFRAME_MS,
  normalizeBitgetCandles,
  normalizeFuturesSymbol,
  type NormalizedCandle,
} from './futures-market-data.service';
import { BACKTEST_LIMITS, BacktestValidationError } from './backtest-engine.service';

const BITGET_BASE_URL = 'https://api.bitget.com';
const PRODUCT_TYPE = 'USDT-FUTURES';
const PROVIDER_PAGE_LIMIT = 200;
const PROVIDER_MAX_WINDOW_MS = 90 * 24 * 60 * 60_000;
const PROVIDER_TIMEOUT_MS = 8_000;
const MAX_PAGES = Math.ceil(BACKTEST_LIMITS.maximumCandles / PROVIDER_PAGE_LIMIT) + 2;

export type HistoricalBacktestData = {
  candles: NormalizedCandle[];
  warnings: string[];
  requestCount: number;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function fetchPage(input: {
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
      throw new BacktestValidationError('PROVIDER_TIMEOUT', '과거 캔들 제공자 요청 시간이 초과되었습니다.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener('abort', forwardAbort);
  }
}

export async function loadHistoricalBacktestCandles(input: {
  symbol: unknown;
  timeframe: unknown;
  startTime: number;
  endTime: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<HistoricalBacktestData> {
  const symbol = normalizeFuturesSymbol(input.symbol);
  if (!symbol) throw new BacktestValidationError('INVALID_SYMBOL', '선물 종목 형식이 올바르지 않습니다.');
  const timeframe = String(input.timeframe ?? '15m');
  const timeframeMs = FUTURES_TIMEFRAME_MS[timeframe];
  if (!timeframeMs) throw new BacktestValidationError('INVALID_TIMEFRAME', '지원하지 않는 선물 시간봉입니다.');
  if (!Number.isFinite(input.startTime) || !Number.isFinite(input.endTime) || input.startTime >= input.endTime) {
    throw new BacktestValidationError('INVALID_PERIOD', '과거 캔들 조회 기간이 올바르지 않습니다.');
  }
  if (input.endTime - input.startTime > BACKTEST_LIMITS.maximumDurationMs) {
    throw new BacktestValidationError('PERIOD_LIMIT_EXCEEDED', '과거 캔들 조회 기간 상한을 초과했습니다.');
  }
  const expectedCount = Math.ceil((input.endTime - input.startTime) / timeframeMs);
  if (expectedCount > BACKTEST_LIMITS.maximumCandles) {
    throw new BacktestValidationError('CANDLE_LIMIT_EXCEEDED', '요청 기간의 예상 캔들 수가 상한을 초과했습니다.');
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const byTimestamp = new Map<number, NormalizedCandle>();
  const warnings: string[] = [];
  let cursorEnd = input.endTime;
  let requestCount = 0;

  while (cursorEnd >= input.startTime && requestCount < MAX_PAGES) {
    if (input.signal?.aborted) throw new BacktestValidationError('BACKTEST_CANCELLED', '백테스트 요청이 취소되었습니다.');
    const windowStart = Math.max(input.startTime, cursorEnd - PROVIDER_MAX_WINDOW_MS);
    const rows = await fetchPage({ symbol, timeframe, startTime: windowStart, endTime: cursorEnd, signal: input.signal, fetchImpl });
    requestCount += 1;
    const normalized = normalizeBitgetCandles(rows, symbol, timeframe, input.now ?? Date.now());
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

  if (requestCount >= MAX_PAGES && cursorEnd >= input.startTime) {
    warnings.push('과거 캔들 페이지 상한에 도달해 요청 기간 일부가 제외될 수 있습니다.');
  }
  const candles = [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
  if (candles.length > BACKTEST_LIMITS.maximumCandles) {
    throw new BacktestValidationError('CANDLE_LIMIT_EXCEEDED', '정규화된 캔들 수가 상한을 초과했습니다.');
  }
  let gapCount = 0;
  for (let index = 1; index < candles.length; index += 1) {
    if (candles[index].timestamp - candles[index - 1].timestamp > timeframeMs * 1.5) gapCount += 1;
  }
  if (gapCount) warnings.push(`캔들 누락 구간 ${gapCount}개를 감지했으며 임의 데이터로 채우지 않았습니다.`);
  if (!candles.length) warnings.push('요청 기간에 사용할 수 있는 완료 캔들이 없습니다.');
  return { candles, warnings: [...new Set(warnings)], requestCount };
}
