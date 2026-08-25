import BaseMarketDataService from './market-data.base.service';
import type { SearchResult, QuoteRow } from './market-data.base.service';
import {
  getCandles as getTossCandles,
  getCompanyProfile as getTossCompanyProfile,
  getQuote as getTossQuote,
  isTossConfigured,
} from '../providers/toss';
import { getCandles as getYahooCandles } from '../providers/yahoo';
import { getKiwoomChartCandlesMeta } from '../kiwoom-chart';
import type { Candle, CompanyProfile, Quote, Timeframe } from '../sample/types';

export type { SearchResult, QuoteRow };

const FALLBACK_PROFILE_DESCRIPTION = '기업 정보를 확인 중입니다.';
const APP_KR_INTERACTIVE_CANDLE_LIMIT = 300;
export const APP_KR_INTRADAY_DEADLINE_MS = 2_000;
const APP_KR_INTERACTIVE_YAHOO_HEDGE_DELAY_MS = 100;
const KR_INTERACTIVE_TIMEFRAMES = new Set([
  '1m',
  '3m',
  '5m',
  '15m',
  '30m',
  '60m',
  '1H',
  '4H',
  '1D',
]);

export interface CandleEvidenceMeta {
  completeness: 'complete' | 'partial';
  reason: string;
  pagesFetched: number | null;
  targetCandles: number | null;
}

export interface CandleProviderFallbackMeta {
  provider: 'kiwoom';
  reason: string;
}

export interface MarketDataCandlesMeta {
  candles: Candle[];
  provider: string;
  fetchedAt: string;
  evidence?: CandleEvidenceMeta;
  fallbackFrom?: CandleProviderFallbackMeta;
}

function minimumUsefulCandles(timeframe: Timeframe): number {
  return timeframe === '1D' ? 30 : 2;
}

function isBoundedKrInteractiveRequest(ticker: string, timeframe: Timeframe): boolean {
  return /^\d{6}$/.test(String(ticker ?? '').trim())
    && KR_INTERACTIVE_TIMEFRAMES.has(String(timeframe));
}

function isBoundedKrIntradayRequest(ticker: string, timeframe: Timeframe): boolean {
  return isBoundedKrInteractiveRequest(ticker, timeframe)
    && String(timeframe) !== '1D';
}

export function resolveKrInteractiveMaxPages(timeframe: Timeframe): number {
  const tf = String(timeframe);

  if (tf === '1m' || tf === '3m') return 6;
  if (tf === '5m' || tf === '15m' || tf === '30m') return 8;
  if (tf === '60m' || tf === '1H') return 10;
  if (tf === '4H') return 12;
  if (tf === '1D') return 4;

  return 8;
}

function normalizeKiwoomInteractiveFailure(error: unknown, deadlineReached: boolean): string {
  if (deadlineReached) return 'DEADLINE_REACHED';

  if (error instanceof Error) {
    if (error.name === 'AbortError') return 'ABORTED';
    if (/INSUFFICIENT_CANDLES|차트 데이터가 부족/.test(error.message)) return 'INSUFFICIENT_CANDLES';
    if (/시간이 초과되었습니다/.test(error.message)) return 'UPSTREAM_TIMEOUT';
    return `UPSTREAM_ERROR:${error.message}`;
  }

  return 'UPSTREAM_ERROR:UNKNOWN';
}

function interactiveAbortError(): Error {
  const error = new Error('KR_INTERACTIVE_PROVIDER_ABORTED');
  error.name = 'AbortError';
  return error;
}

async function getBoundedKrInteractiveCandlesMeta(
  ticker: string,
  timeframe: Timeframe,
): Promise<MarketDataCandlesMeta> {
  const controller = new AbortController();
  const deadlineAt = Date.now() + APP_KR_INTRADAY_DEADLINE_MS;
  const deadlineError = new Error('KR_INTERACTIVE_PROVIDER_DEADLINE');
  deadlineError.name = 'TimeoutError';
  const timeout = setTimeout(
    () => controller.abort(deadlineError),
    APP_KR_INTRADAY_DEADLINE_MS,
  );
  const terminalDeadline = new Promise<never>((_resolve, reject) => {
    const rejectFromSignal = () => {
      reject(controller.signal.reason instanceof Error ? controller.signal.reason : deadlineError);
    };
    if (controller.signal.aborted) rejectFromSignal();
    else controller.signal.addEventListener('abort', rejectFromSignal, { once: true });
  });
  let kiwoomFailure: string | null = null;

  const kiwoomAttempt = (async (): Promise<MarketDataCandlesMeta> => {
    try {
      const result = await getKiwoomChartCandlesMeta(
        String(ticker).trim(),
        String(timeframe),
        APP_KR_INTERACTIVE_CANDLE_LIMIT,
        {
          signal: controller.signal,
          deadlineAt,
          maxPages: resolveKrInteractiveMaxPages(timeframe),
        },
      );

      if (result.candles.length < minimumUsefulCandles(timeframe)) {
        kiwoomFailure = `INSUFFICIENT_CANDLES:${result.stopReason}`;
        throw new Error(kiwoomFailure);
      }

      return {
        candles: result.candles as Candle[],
        provider: 'kiwoom',
        fetchedAt: new Date().toISOString(),
        evidence: {
          completeness: result.completeness,
          reason: result.stopReason,
          pagesFetched: result.pagesFetched,
          targetCandles: result.targetCandles,
        },
      };
    } catch (error) {
      if (!kiwoomFailure) {
        kiwoomFailure = normalizeKiwoomInteractiveFailure(
          error,
          Date.now() >= deadlineAt,
        );
      }
      throw error;
    }
  })();

  const yahooAttempt = (async (): Promise<MarketDataCandlesMeta> => {
    await new Promise((resolve) => setTimeout(resolve, APP_KR_INTERACTIVE_YAHOO_HEDGE_DELAY_MS));
    if (controller.signal.aborted) throw interactiveAbortError();

    const candles = await getYahooCandles(String(ticker).trim(), String(timeframe));
    if (candles.length < minimumUsefulCandles(timeframe)) {
      throw new Error('YAHOO_INSUFFICIENT_CANDLES');
    }

    return {
      candles,
      provider: 'yahoo',
      fetchedAt: new Date().toISOString(),
      fallbackFrom: {
        provider: 'kiwoom',
        reason: kiwoomFailure ?? 'HEDGE_WON_BEFORE_KIWOOM_TERMINAL',
      },
    };
  })();

  try {
    return await Promise.race([
      Promise.any([kiwoomAttempt, yahooAttempt]),
      terminalDeadline,
    ]);
  } catch (error) {
    if (error === deadlineError || (error instanceof Error && error.message === deadlineError.message)) {
      kiwoomFailure = 'DEADLINE_REACHED';
    }
    return {
      candles: [],
      provider: 'none',
      fetchedAt: new Date().toISOString(),
      fallbackFrom: {
        provider: 'kiwoom',
        reason: kiwoomFailure ?? 'INTERACTIVE_PROVIDERS_UNAVAILABLE',
      },
    };
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

async function getBoundedKrIntradayCandlesMeta(
  ticker: string,
  timeframe: Timeframe,
): Promise<MarketDataCandlesMeta> {
  return getBoundedKrInteractiveCandlesMeta(ticker, timeframe);
}

export class MarketDataService extends BaseMarketDataService {
  static async getQuote(ticker: string): Promise<Quote> {
    try {
      return await super.getQuote(ticker);
    } catch (primaryError) {
      if (!isTossConfigured()) throw primaryError;
      try {
        const entry = await super.getCatalogEntry(ticker);
        return await getTossQuote(entry) as unknown as Quote;
      } catch {
        throw primaryError;
      }
    }
  }

  static async getCandles(ticker: string, timeframe: Timeframe = '1D'): Promise<Candle[]> {
    const result = await this.getCandlesMeta(ticker, timeframe);
    return result.candles;
  }

  static async getCandlesMeta(
    ticker: string,
    timeframe: Timeframe = '1D',
  ): Promise<MarketDataCandlesMeta> {
    /*
     * App-facing KR interactive charts must terminate inside the browser's
     * primary endpoint budget. Kiwoom and the public Yahoo fallback therefore
     * race under one bounded deadline for both intraday and daily visible
     * windows. If both fail, return truthful empty evidence instead of falling
     * back into BaseMarketDataService's deep/unbounded Kiwoom history path.
     * Research/long-history callers continue to use the lower-level APIs
     * directly and keep their deep pagination semantics.
     */
    if (isBoundedKrIntradayRequest(ticker, timeframe)) {
      return getBoundedKrIntradayCandlesMeta(ticker, timeframe);
    }

    if (isBoundedKrInteractiveRequest(ticker, timeframe)) {
      return getBoundedKrInteractiveCandlesMeta(ticker, timeframe);
    }

    let primaryResult: MarketDataCandlesMeta | null = null;
    let primaryError: unknown = null;
    try {
      primaryResult = await super.getCandlesMeta(ticker, timeframe);
      if (primaryResult.candles.length > 0) {
        return primaryResult;
      }
    } catch (error) {
      primaryError = error;
    }

    if (isTossConfigured()) {
      try {
        const entry = await super.getCatalogEntry(ticker);
        const candles = await getTossCandles(entry, timeframe, 200);
        if (candles.length >= minimumUsefulCandles(timeframe)) {
          return {
            candles,
            provider: 'toss',
            fetchedAt: new Date().toISOString(),
          };
        }
      } catch {
        // Preserve the pre-Toss failure/empty-data contract below.
      }
    }

    if (primaryError) throw primaryError;
    return primaryResult ?? {
      candles: [],
      provider: 'none',
      fetchedAt: new Date().toISOString(),
    };
  }

  static async getCompanyProfile(ticker: string): Promise<CompanyProfile> {
    const primary = await super.getCompanyProfile(ticker);
    if (primary.description !== FALLBACK_PROFILE_DESCRIPTION || !isTossConfigured()) return primary;
    try {
      const entry = await super.getCatalogEntry(ticker);
      return await getTossCompanyProfile(entry);
    } catch {
      return primary;
    }
  }
}

export default MarketDataService;
