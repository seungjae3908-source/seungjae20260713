import {
  normalizeChartCandles,
  type ChartCandleNormalizationResult,
  type ChartCandleTimeframe,
} from './chart-candle-normalizer';
import type { AnalysisAssetType, AnalysisMarket } from './analysis-selection';
import { type UnifiedChartTimeframe } from './unified-chart-metadata';
export {
  UNIFIED_CHART_TIMEFRAMES,
  unifiedMarketLabel,
  type UnifiedChartTimeframe,
} from './unified-chart-metadata';

export type UnifiedChartDataStatus =
  | 'ok'
  | 'delayed'
  | 'stale'
  | 'insufficient'
  | 'unavailable';

export type UnifiedChartData = {
  market: AnalysisMarket;
  symbol: string;
  timeframe: UnifiedChartTimeframe;
  provider: string;
  fetchedAt?: string;
  updatedAt?: string;
  normalization: ChartCandleNormalizationResult;
  sourceUrl: string;
};

export type UnifiedChartErrorKind =
  | 'aborted'
  | 'timeout'
  | 'rate-limited'
  | 'not-found'
  | 'client'
  | 'server'
  | 'network'
  | 'malformed-response';

export class UnifiedChartDataError extends Error {
  constructor(
    message: string,
    public readonly kind: UnifiedChartErrorKind,
    public readonly status: number | null = null,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'UnifiedChartDataError';
  }
}

export type UnifiedChartFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

let configuredUnifiedChartFetch: UnifiedChartFetch | null = null;

export function configureUnifiedChartFetch(fetcher: UnifiedChartFetch | null): void {
  configuredUnifiedChartFetch = fetcher;
}

const DEFAULT_TIMEOUT_MS = 12_000;
const US_PRIMARY_STOCK_ENDPOINT_TIMEOUT_MS = 3_500;
const KR_PRIMARY_STOCK_ENDPOINT_TIMEOUT_MS = 3_500;
const STOCK_ALTERNATE_HEDGE_DELAY_MS = 2_000;
const INSUFFICIENT_CANDLE_RETRY_DELAY_MS = 150;

export function marketAssetType(market: AnalysisMarket): AnalysisAssetType {
  if (market === 'UPBIT') return 'coin_spot';
  if (market === 'BITGET') return 'coin_futures';
  return 'stock';
}

export function defaultUnifiedSymbol(market: AnalysisMarket): {
  symbol: string;
  displayName: string;
} {
  if (market === 'KR') return { symbol: '005930', displayName: '삼성전자' };
  if (market === 'US') return { symbol: 'AAPL', displayName: 'Apple' };
  if (market === 'UPBIT') return { symbol: 'BTC', displayName: '비트코인' };
  return { symbol: 'BTCUSDT', displayName: 'BTCUSDT' };
}

export function normalizeUnifiedSymbol(market: AnalysisMarket, value: unknown): string {
  let normalized = String(value ?? '').trim().toUpperCase();
  if (market === 'UPBIT') normalized = normalized.replace(/^KRW[-_:]?/, '');
  if (market === 'BITGET') normalized = normalized.replace(/[-_/]/g, '');
  if (market === 'KR') return normalized.replace(/\D/g, '').slice(0, 6);
  return normalized.replace(/[^A-Z0-9.-]/g, '').slice(0, 30);
}

function upbitUnit(timeframe: UnifiedChartTimeframe): number | null {
  if (timeframe === '1D') return null;
  if (timeframe === '1H') return 60;
  if (timeframe === '4H') return 240;
  return Number(timeframe.replace('m', ''));
}

export function buildUnifiedChartUrls(input: {
  market: AnalysisMarket;
  symbol: string;
  timeframe: UnifiedChartTimeframe;
}): string[] {
  const symbol = normalizeUnifiedSymbol(input.market, input.symbol);
  const encodedSymbol = encodeURIComponent(symbol);
  const encodedFrame = encodeURIComponent(input.timeframe);

  if (input.market === 'US' || input.market === 'KR') {
    return [
      `/api/stocks/${encodedSymbol}/candles?tf=${encodedFrame}`,
      `/api/stocks/${encodedSymbol}/chart?tf=${encodedFrame}`,
    ];
  }

  if (input.market === 'UPBIT') {
    const unit = upbitUnit(input.timeframe);
    const params = new URLSearchParams({ symbol, count: '200' });
    if (unit == null) params.set('tf', '1D');
    else params.set('unit', String(unit));
    return [`/api/crypto/spot/candles?${params.toString()}`];
  }

  return [
    `/api/crypto/futures/candles?symbol=${encodedSymbol}&granularity=${encodedFrame}&limit=300`,
  ];
}

function candleRows(payload: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(payload.candles)) return payload.candles as Record<string, unknown>[];
  const data = payload.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const nested = data as Record<string, unknown>;
    if (Array.isArray(nested.candles)) return nested.candles as Record<string, unknown>[];
  }
  if (Array.isArray(payload.items)) return payload.items as Record<string, unknown>[];
  return [];
}

function payloadText(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function httpError(status: number, payload: Record<string, unknown>): UnifiedChartDataError {
  const serverMessage = payloadText(payload, 'message') ?? payloadText(payload, 'error');
  if (status === 429) {
    return new UnifiedChartDataError(
      serverMessage ?? '요청이 너무 많습니다. 잠시 뒤 다시 시도하세요.',
      'rate-limited',
      status,
      true,
    );
  }
  if (status === 404) {
    return new UnifiedChartDataError(
      serverMessage ?? '해당 종목 또는 시간봉 데이터를 찾지 못했습니다.',
      'not-found',
      status,
      false,
    );
  }
  if (status >= 500) {
    return new UnifiedChartDataError(
      serverMessage ?? `데이터 제공 서버 오류가 발생했습니다. HTTP ${status}`,
      'server',
      status,
      true,
    );
  }
  return new UnifiedChartDataError(
    serverMessage ?? `차트 요청이 거부되었습니다. HTTP ${status}`,
    'client',
    status,
    false,
  );
}

async function parsePayload(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text().catch(() => '');
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('OBJECT_REQUIRED');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new UnifiedChartDataError(
      '차트 API가 올바른 JSON 객체를 반환하지 않았습니다.',
      'malformed-response',
      response.status || null,
      true,
    );
  }
}

function createLinkedSignal(external: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  timedOut: () => boolean;
  abort: () => void;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let timeoutReached = false;
  const timeout = globalThis.setTimeout(() => {
    timeoutReached = true;
    controller.abort();
  }, timeoutMs);
  const abortFromExternal = () => controller.abort(external?.reason);
  if (external?.aborted) abortFromExternal();
  else external?.addEventListener('abort', abortFromExternal, { once: true });

  return {
    signal: controller.signal,
    timedOut: () => timeoutReached,
    abort: () => controller.abort(),
    cleanup: () => {
      globalThis.clearTimeout(timeout);
      external?.removeEventListener('abort', abortFromExternal);
    },
  };
}

async function waitForSignalAwareDelay(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

function primaryStockEndpointTimeoutMs(market: AnalysisMarket, totalTimeoutMs: number): number {
  /*
   * The app-facing stock candle backends already terminate their live-provider
   * work before the 5s release gate: KR has a 2s hard terminal, while a cold US
   * request can spend up to 750ms on persistent cache lookup plus the 1.65s
   * Yahoo hedge before auth/transport/JSON overhead. A 2.5s US browser cutoff
   * can therefore abort a healthy bounded primary request and restart the same
   * candle chain through /chart. Keep the 5s release gate unchanged and give
   * both stock markets a 3.5s primary budget so bounded /candles can terminate.
   */
  const endpointBudgetMs = market === 'KR'
    ? KR_PRIMARY_STOCK_ENDPOINT_TIMEOUT_MS
    : US_PRIMARY_STOCK_ENDPOINT_TIMEOUT_MS;
  return Math.min(endpointBudgetMs, Math.max(250, Math.floor(totalTimeoutMs / 2)));
}

function canTryAlternateEndpoint(error: UnifiedChartDataError): boolean {
  return error.kind === 'timeout' || error.status === 404 || error.status === 405;
}

export async function fetchUnifiedChartData(input: {
  market: AnalysisMarket;
  symbol: string;
  timeframe: UnifiedChartTimeframe;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetcher?: UnifiedChartFetch;
}): Promise<UnifiedChartData> {
  const symbol = normalizeUnifiedSymbol(input.market, input.symbol);
  if (!symbol) {
    throw new UnifiedChartDataError('유효한 종목 심볼을 입력하세요.', 'client', 400, false);
  }

  const urls = buildUnifiedChartUrls({
    market: input.market,
    symbol,
    timeframe: input.timeframe,
  });
  const fetcher = input.fetcher ?? configuredUnifiedChartFetch ?? globalThis.fetch.bind(globalThis);
  const totalTimeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const linked = createLinkedSignal(input.signal, totalTimeoutMs);
  let lastError: UnifiedChartDataError | null = null;
  const requestInit = (signal: AbortSignal): RequestInit => ({
    cache: 'no-store',
    headers: {
      'Cache-Control': 'no-cache, no-store, max-age=0',
      Pragma: 'no-cache',
    },
    signal,
  });
  const alternateHedge = urls.length > 1
    ? createLinkedSignal(linked.signal, totalTimeoutMs)
    : null;
  const alternateGate = alternateHedge
    ? (() => {
        let release: () => void = () => undefined;
        const promise = new Promise<void>((resolve) => { release = resolve; });
        return { promise, release };
      })()
    : null;
  const alternateResponse = alternateHedge && alternateGate
    ? Promise.race([
        waitForSignalAwareDelay(STOCK_ALTERNATE_HEDGE_DELAY_MS, alternateHedge.signal),
        alternateGate.promise,
      ]).then(() => fetcher(urls[1], requestInit(alternateHedge.signal)))
    : null;
  void alternateResponse?.catch(() => undefined);

  try {
    for (const [index, url] of urls.entries()) {
      const alternateAvailable = index < urls.length - 1;
      const attempt = alternateAvailable
        ? createLinkedSignal(linked.signal, primaryStockEndpointTimeoutMs(input.market, totalTimeoutMs))
        : null;
      const attemptSignal = attempt?.signal ?? linked.signal;

      try {
        const response = index === 1 && alternateResponse
          ? await alternateResponse
          : await fetcher(url, requestInit(attemptSignal));
        let payload = await parsePayload(response);
        if (!response.ok) {
          const error = httpError(response.status, payload);
          if (alternateAvailable && canTryAlternateEndpoint(error)) {
            lastError = error;
            alternateGate?.release();
            continue;
          }
          throw error;
        }

        let normalization = normalizeChartCandles(
          candleRows(payload),
          input.timeframe as ChartCandleTimeframe,
        );
        if (normalization.candles.length < 2) {
          await waitForSignalAwareDelay(INSUFFICIENT_CANDLE_RETRY_DELAY_MS, attemptSignal);
          const retryResponse = await fetcher(url, requestInit(attemptSignal));
          payload = await parsePayload(retryResponse);
          if (!retryResponse.ok) throw httpError(retryResponse.status, payload);
          normalization = normalizeChartCandles(
            candleRows(payload),
            input.timeframe as ChartCandleTimeframe,
          );
        }
        // A successful HTTP response is not usable chart evidence when fewer
        // than two real candles survive normalization. For stock markets, use
        // the already-defined alternate endpoint instead of presenting a
        // misleading terminal empty state. Single-endpoint markets stay
        // explicit and never synthesize candles.
        if (normalization.candles.length < 2 && alternateAvailable) {
          alternateGate?.release();
          continue;
        }
        alternateHedge?.abort();
        return {
          market: input.market,
          symbol,
          timeframe: input.timeframe,
          provider:
            payloadText(payload, 'provider') ??
            payloadText(payload, 'exchange') ??
            'market-data',
          fetchedAt: payloadText(payload, 'fetchedAt'),
          updatedAt: payloadText(payload, 'updatedAt'),
          normalization,
          sourceUrl: url,
        };
      } catch (error) {
        if (error instanceof UnifiedChartDataError) {
          lastError = error;
          if (alternateAvailable && canTryAlternateEndpoint(error)) {
            alternateGate?.release();
            continue;
          }
          alternateHedge?.abort();
          throw error;
        }

        if (attempt?.signal.aborted && attempt.timedOut() && !linked.signal.aborted) {
          const timeoutError = new UnifiedChartDataError(
            '기본 차트 데이터 경로가 지연되어 대체 경로를 확인합니다.',
            'timeout',
            null,
            true,
          );
          lastError = timeoutError;
          if (alternateAvailable) {
            alternateGate?.release();
            continue;
          }
          throw timeoutError;
        }

        if (linked.signal.aborted) {
          if (linked.timedOut()) {
            throw new UnifiedChartDataError(
              '차트 데이터 요청 시간이 초과되었습니다.',
              'timeout',
              null,
              true,
            );
          }
          throw new UnifiedChartDataError(
            '이전 차트 요청이 취소되었습니다.',
            'aborted',
            null,
            false,
          );
        }

        const networkError = new UnifiedChartDataError(
          error instanceof Error ? error.message : '차트 네트워크 요청에 실패했습니다.',
          'network',
          null,
          true,
        );
        lastError = networkError;
        if (alternateAvailable && canTryAlternateEndpoint(networkError)) continue;
        throw networkError;
      } finally {
        attempt?.cleanup();
      }
    }
    throw lastError ?? new UnifiedChartDataError(
      '차트 데이터를 불러오지 못했습니다.',
      'network',
      null,
      true,
    );
  } finally {
    alternateHedge?.abort();
    alternateHedge?.cleanup();
    linked.cleanup();
  }
}

export function unifiedChartDataStatus(
  data: UnifiedChartData | undefined,
  failed: boolean,
  now = Date.now(),
): UnifiedChartDataStatus {
  if (failed) return 'unavailable';
  if (!data || data.normalization.candles.length < 2) return 'insufficient';
  const timestamp = Date.parse(data.updatedAt ?? data.fetchedAt ?? '');
  if (!Number.isFinite(timestamp)) return 'delayed';

  const seconds: Record<UnifiedChartTimeframe, number> = {
    '1m': 60,
    '3m': 180,
    '5m': 300,
    '15m': 900,
    '30m': 1_800,
    '1H': 3_600,
    '4H': 14_400,
    '1D': 86_400,
  };
  const interval = seconds[data.timeframe] * 1_000;
  const delayedAfter = data.timeframe === '1D'
    ? interval * 2
    : Math.max(interval * 2, 10 * 60_000);
  const staleAfter = data.timeframe === '1D'
    ? interval * 5
    : Math.max(interval * 3, 30 * 60_000);
  const age = now - timestamp;
  if (age > staleAfter) return 'stale';
  if (age > delayedAfter) return 'delayed';
  return 'ok';
}
