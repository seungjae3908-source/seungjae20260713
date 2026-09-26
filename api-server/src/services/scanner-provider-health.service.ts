import { providerStatus } from '../lib/config';
import { isTossConfigured } from '../providers/toss';
import type { Candle, Quote, Timeframe } from '../sample/types';
import { MarketDataService } from './market-data.service';
import {
  createScannerProviderHealth,
  type ScannerProviderHealth,
  type ScannerProviderHealthState,
} from './scanner-provider-health.contract';

const HEALTH_SEVERITY: Record<ScannerProviderHealthState, number> = {
  READY: 0,
  SEARCH_EMPTY: 0,
  DATA_STALE: 1,
  RATE_LIMIT: 2,
  TIMEOUT: 3,
  PROVIDER_FAILURE: 4,
};

function timestampMs(value: Candle['time'] | string | number | null | undefined): number | null {
  if (typeof value === 'number') {
    const normalized = value > 10_000_000_000 ? value : value * 1_000;
    return Number.isFinite(normalized) ? normalized : null;
  }
  if (!value) return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function candleFreshness(timeframe: Timeframe, candles: Candle[]): ScannerProviderHealth['freshness'] {
  const latest = timestampMs(candles.at(-1)?.time);
  if (latest == null) return 'UNKNOWN';
  const tf = String(timeframe);
  const staleAfterMs = tf === '1D'
    ? 5 * 24 * 60 * 60_000
    : tf === '4H'
      ? 12 * 60 * 60_000
      : tf === '60m' || tf === '1H'
        ? 3 * 60 * 60_000
        : tf === '15m'
          ? 45 * 60_000
          : 20 * 60_000;
  return Date.now() - latest > staleAfterMs ? 'STALE' : 'FRESH';
}

function safeFailureReason(error: unknown): string {
  const raw = error instanceof Error
    ? `${error.name}:${error.message}`
    : String(error ?? 'UNKNOWN');
  return raw
    .replace(/https?:\/\/\S+/giu, '<upstream>')
    .replace(/[\r\n\t]+/gu, ' ')
    .slice(0, 240);
}

function failureState(error: unknown): ScannerProviderHealthState {
  const text = safeFailureReason(error).toUpperCase();
  if (/429|RATE[_ -]?LIMIT|TOO MANY REQUESTS/u.test(text)) return 'RATE_LIMIT';
  if (/TIMEOUT|TIMED OUT|DEADLINE|ABORT|BUDGET_EXCEEDED/u.test(text)) return 'TIMEOUT';
  return 'PROVIDER_FAILURE';
}

function laterTimestamp(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (!Number.isFinite(leftMs)) return right;
  if (!Number.isFinite(rightMs)) return left;
  return rightMs >= leftMs ? right : left;
}

function quoteFallbackProviders(market: 'KR' | 'US'): string[] {
  const providers = market === 'KR'
    ? ['naver', 'yahoo']
    : ['yahoo', ...(providerStatus().finnhub ? ['finnhub'] : [])];
  if (isTossConfigured()) providers.push('toss');
  return providers;
}

function candleFallbackProviders(market: 'KR' | 'US', timeframe: Timeframe): string[] {
  if (market === 'US') return ['yahoo'];
  const intraday = ['1m', '3m', '5m', '15m', '30m', '60m', '1H', '4H'].includes(String(timeframe));
  const providers = ['kiwoom', ...(!intraday ? ['naver'] : []), 'yahoo'];
  if (isTossConfigured()) providers.push('toss');
  return providers;
}

function signalAbortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('Scanner provider request aborted');
  error.name = 'AbortError';
  return error;
}

async function runWithSignal<T>(signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
  if (!signal) return task();
  if (signal.aborted) throw signalAbortReason(signal);

  let removeAbortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(signalAbortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);
  });

  try {
    return await Promise.race([task(), aborted]);
  } finally {
    removeAbortListener?.();
  }
}

export class ScannerProviderHealthTracker {
  private readonly health = new Map<string, ScannerProviderHealth>();

  record(input: Partial<ScannerProviderHealth> & Pick<ScannerProviderHealth, 'provider'>): void {
    const next = createScannerProviderHealth(input);
    const previous = this.health.get(next.provider);
    if (!previous) {
      this.health.set(next.provider, next);
      return;
    }

    const nextIsWorse = HEALTH_SEVERITY[next.state] >= HEALTH_SEVERITY[previous.state];
    const freshness = previous.freshness === 'STALE' || next.freshness === 'STALE'
      ? 'STALE'
      : previous.freshness === 'FRESH' || next.freshness === 'FRESH'
        ? 'FRESH'
        : 'UNKNOWN';

    this.health.set(next.provider, {
      provider: next.provider,
      state: nextIsWorse ? next.state : previous.state,
      latencyMs: previous.latencyMs == null
        ? next.latencyMs
        : next.latencyMs == null
          ? previous.latencyMs
          : Math.max(previous.latencyMs, next.latencyMs),
      retryCount: Math.max(previous.retryCount, next.retryCount),
      timeout: previous.timeout || next.timeout,
      lastSuccessfulFetch: laterTimestamp(previous.lastSuccessfulFetch, next.lastSuccessfulFetch),
      freshness,
      failureReason: nextIsWorse && next.failureReason ? next.failureReason : previous.failureReason,
    });
  }

  snapshot(): ScannerProviderHealth[] {
    return [...this.health.values()].sort((left, right) => left.provider.localeCompare(right.provider));
  }

  private recordChainFailure(
    chainProvider: string,
    providers: string[],
    error: unknown,
    latencyMs: number,
  ): void {
    const state = failureState(error);
    const reason = safeFailureReason(error);
    this.record({
      provider: chainProvider,
      state,
      latencyMs,
      timeout: state === 'TIMEOUT',
      freshness: 'UNKNOWN',
      failureReason: reason,
    });
    for (const provider of providers) {
      this.record({
        provider,
        state,
        latencyMs: null,
        timeout: state === 'TIMEOUT',
        freshness: 'UNKNOWN',
        failureReason: `CHAIN_EXHAUSTED:${reason}`,
      });
    }
  }

  async getQuote(market: 'KR' | 'US', ticker: string, signal?: AbortSignal): Promise<Quote> {
    const startedAt = Date.now();
    try {
      const quote = await runWithSignal(signal, () => MarketDataService.getQuote(ticker));
      const observedAt = typeof (quote as Quote & { updatedAt?: string }).updatedAt === 'string'
        ? (quote as Quote & { updatedAt?: string }).updatedAt ?? null
        : new Date().toISOString();
      this.record({
        provider: 'stock-quote-chain',
        state: 'READY',
        latencyMs: Math.max(0, Date.now() - startedAt),
        lastSuccessfulFetch: observedAt,
        freshness: 'FRESH',
      });
      return quote;
    } catch (error) {
      this.recordChainFailure(
        'stock-quote-chain',
        quoteFallbackProviders(market),
        error,
        Math.max(0, Date.now() - startedAt),
      );
      throw error;
    }
  }

  async getCandles(
    market: 'KR' | 'US',
    ticker: string,
    timeframe: Timeframe,
    signal?: AbortSignal,
  ): Promise<Candle[]> {
    const startedAt = Date.now();
    try {
      const meta = await runWithSignal(signal, () => MarketDataService.getCandlesMeta(ticker, timeframe));
      const latencyMs = Math.max(0, Date.now() - startedAt);
      const freshness = candleFreshness(timeframe, meta.candles);
      if (meta.fallbackFrom) {
        this.record({
          provider: meta.fallbackFrom.provider,
          state: failureState(meta.fallbackFrom.reason),
          latencyMs: null,
          timeout: failureState(meta.fallbackFrom.reason) === 'TIMEOUT',
          freshness: 'UNKNOWN',
          failureReason: meta.fallbackFrom.reason,
        });
      }
      if (meta.provider === 'none' || meta.candles.length === 0) {
        this.recordChainFailure(
          'stock-candle-chain',
          candleFallbackProviders(market, timeframe),
          new Error(`CANDLES_UNAVAILABLE:${ticker}:${String(timeframe)}`),
          latencyMs,
        );
        return meta.candles;
      }
      this.record({
        provider: meta.provider,
        state: freshness === 'STALE' ? 'DATA_STALE' : 'READY',
        latencyMs,
        lastSuccessfulFetch: meta.fetchedAt,
        freshness,
        failureReason: freshness === 'STALE' ? `STALE_CANDLES:${ticker}:${String(timeframe)}` : null,
      });
      return meta.candles;
    } catch (error) {
      this.recordChainFailure(
        'stock-candle-chain',
        candleFallbackProviders(market, timeframe),
        error,
        Math.max(0, Date.now() - startedAt),
      );
      throw error;
    }
  }
}
