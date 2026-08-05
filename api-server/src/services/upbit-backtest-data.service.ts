import { BacktestMarketContractError, normalizeBacktestSymbol } from './backtest-market-profile.service';

const UPBIT_BASE_URL = 'https://api.upbit.com';
const PAGE_LIMIT = 200;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_CANDLES = 20_000;
const MAX_PAGES = Math.ceil(MAX_CANDLES / PAGE_LIMIT) + 1;

export type SpotBacktestCandle = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
  timeframe: string;
  symbol: string;
  market: 'crypto-spot';
  source: 'upbit';
  isClosed: true;
};

type UpbitCandleRow = {
  market?: unknown;
  candle_date_time_utc?: unknown;
  opening_price?: unknown;
  high_price?: unknown;
  low_price?: unknown;
  trade_price?: unknown;
  candle_acc_trade_price?: unknown;
  candle_acc_trade_volume?: unknown;
};

const MINUTE_UNITS: Readonly<Record<string, number>> = Object.freeze({
  '1m': 1,
  '3m': 3,
  '5m': 5,
  '10m': 10,
  '15m': 15,
  '30m': 30,
  '1H': 60,
  '4H': 240,
});

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function endpointFor(timeframe: string) {
  if (timeframe === '1D') return { path: '/v1/candles/days', durationMs: 86_400_000 };
  const unit = MINUTE_UNITS[timeframe];
  if (!unit) throw new BacktestMarketContractError('UPBIT_UNSUPPORTED_TIMEFRAME', `Upbit 현물 백테스트에서 ${timeframe} 시간봉은 지원하지 않습니다.`);
  return { path: `/v1/candles/minutes/${unit}`, durationMs: unit * 60_000 };
}

function normalizeRows(rows: unknown, input: { symbol: string; timeframe: string; startTime: number; endTime: number; now: number }) {
  if (!Array.isArray(rows)) throw new BacktestMarketContractError('UPBIT_INVALID_RESPONSE', 'Upbit 과거 캔들 응답 형식이 올바르지 않습니다.');
  const candles: SpotBacktestCandle[] = [];
  for (const item of rows) {
    const row = item as UpbitCandleRow;
    const timestamp = Date.parse(String(row.candle_date_time_utc ?? '') + 'Z');
    const open = finite(row.opening_price);
    const high = finite(row.high_price);
    const low = finite(row.low_price);
    const close = finite(row.trade_price);
    const volume = finite(row.candle_acc_trade_volume);
    const quoteVolume = finite(row.candle_acc_trade_price);
    if (![timestamp, open, high, low, close, volume, quoteVolume].every((value) => value != null && Number.isFinite(value))) continue;
    if (timestamp < input.startTime || timestamp > input.endTime || timestamp >= input.now) continue;
    if ((open as number) <= 0 || (high as number) <= 0 || (low as number) <= 0 || (close as number) <= 0 || (volume as number) < 0) continue;
    candles.push({
      timestamp,
      open: open as number,
      high: high as number,
      low: low as number,
      close: close as number,
      volume: volume as number,
      quoteVolume: quoteVolume as number,
      timeframe: input.timeframe,
      symbol: input.symbol,
      market: 'crypto-spot',
      source: 'upbit',
      isClosed: true,
    });
  }
  return candles;
}

async function fetchPage(input: { symbol: string; timeframe: string; to: number; fetchImpl: typeof fetch; signal?: AbortSignal }) {
  const { path } = endpointFor(input.timeframe);
  const url = new URL(path, UPBIT_BASE_URL);
  url.searchParams.set('market', input.symbol);
  url.searchParams.set('to', new Date(input.to).toISOString());
  url.searchParams.set('count', String(PAGE_LIMIT));
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  input.signal?.addEventListener('abort', forwardAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await input.fetchImpl(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'seungjae-investment-app/2.0' },
      signal: controller.signal,
    });
    if (!response.ok) throw new BacktestMarketContractError('UPBIT_HTTP_ERROR', `Upbit 과거 캔들 요청에 실패했습니다. HTTP ${response.status}`);
    return await response.json() as unknown;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new BacktestMarketContractError('UPBIT_TIMEOUT', 'Upbit 과거 캔들 요청 시간이 초과되었습니다.');
    throw error;
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener('abort', forwardAbort);
  }
}

export async function loadUpbitBacktestCandles(input: {
  symbol: unknown;
  timeframe: string;
  startTime: number;
  endTime: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  now?: number;
}) {
  const symbol = normalizeBacktestSymbol('crypto-spot', input.symbol);
  const { durationMs } = endpointFor(input.timeframe);
  if (!Number.isFinite(input.startTime) || !Number.isFinite(input.endTime) || input.startTime >= input.endTime) {
    throw new BacktestMarketContractError('INVALID_PERIOD', '현물 백테스트 기간이 올바르지 않습니다.');
  }
  const expected = Math.ceil((input.endTime - input.startTime) / durationMs);
  if (expected > MAX_CANDLES) throw new BacktestMarketContractError('CANDLE_LIMIT_EXCEEDED', '현물 백테스트 예상 캔들 수가 상한을 초과했습니다.');

  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now();
  const byTimestamp = new Map<number, SpotBacktestCandle>();
  const warnings: string[] = [];
  let cursor = Math.min(input.endTime + durationMs, now);
  let requestCount = 0;

  while (cursor > input.startTime && requestCount < MAX_PAGES && byTimestamp.size < MAX_CANDLES) {
    if (input.signal?.aborted) throw new BacktestMarketContractError('BACKTEST_CANCELLED', '현물 백테스트 요청이 취소되었습니다.');
    const rows = await fetchPage({ symbol, timeframe: input.timeframe, to: cursor, fetchImpl, signal: input.signal });
    requestCount += 1;
    const normalized = normalizeRows(rows, { symbol, timeframe: input.timeframe, startTime: input.startTime, endTime: input.endTime, now });
    for (const candle of normalized) byTimestamp.set(candle.timestamp, candle);
    if (!Array.isArray(rows) || rows.length === 0 || normalized.length === 0) break;
    const earliest = Math.min(...normalized.map((candle) => candle.timestamp));
    if (!Number.isFinite(earliest) || earliest >= cursor) break;
    cursor = earliest;
  }

  const candles = [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
  let gapCount = 0;
  for (let index = 1; index < candles.length; index += 1) {
    if (candles[index].timestamp - candles[index - 1].timestamp > durationMs * 1.5) gapCount += 1;
  }
  if (gapCount) warnings.push(`거래가 없어 생성되지 않은 캔들 또는 누락 구간 ${gapCount}개를 감지했습니다.`);
  if (!candles.length) warnings.push('요청 기간에 사용할 수 있는 완료된 Upbit 현물 캔들이 없습니다.');
  return { candles, warnings, requestCount, provider: 'upbit' as const, orderSubmitted: false as const };
}
