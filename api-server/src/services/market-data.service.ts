import BaseMarketDataService from './market-data.base.service';
import type { SearchResult, QuoteRow } from './market-data.base.service';
import {
  getCandles as getTossCandles,
  getCompanyProfile as getTossCompanyProfile,
  getQuote as getTossQuote,
  isTossConfigured,
} from '../providers/toss';
import { getKiwoomChartCandlesMeta } from '../kiwoom-chart';
import type { Candle, CompanyProfile, Quote, Timeframe } from '../sample/types';

export type { SearchResult, QuoteRow };

const FALLBACK_PROFILE_DESCRIPTION = '기업 정보를 확인 중입니다.';
const APP_KR_INTRADAY_CANDLE_LIMIT = 300;
const APP_KR_INTRADAY_DEADLINE_MS = 8_000;
const KR_INTRADAY_TIMEFRAMES = new Set(['1m', '3m', '5m', '15m', '30m', '60m', '1H', '4H']);

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

function isBoundedKrIntradayRequest(ticker: string, timeframe: Timeframe): boolean {
  return /^\d{6}$/.test(String(ticker ?? '').trim())
    && KR_INTRADAY_TIMEFRAMES.has(String(timeframe));
}

export function resolveKrInteractiveMaxPages(timeframe: Timeframe): number {
  const tf = String(timeframe);

  if (tf === '1m' || tf === '3m') return 6;
  if (tf === '5m' || tf === '15m' || tf === '30m') return 8;
  if (tf === '60m' || tf === '1H') return 10;
  if (tf === '4H') return 12;

  return 8;
}

function normalizeKiwoomInteractiveFailure(error: unknown, deadlineReached: boolean): string {
  if (deadlineReached) return 'DEADLINE_REACHED';

  if (error instanceof Error) {
    if (error.name === 'AbortError') return 'ABORTED';
    if (/시간이 초과되었습니다/.test(error.message)) return 'UPSTREAM_TIMEOUT';
    return `UPSTREAM_ERROR:${error.message}`;
  }

  return 'UPSTREAM_ERROR:UNKNOWN';
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
     * App-facing KR intraday charts use a bounded visible-window contract.
     * Research/long-history callers do not pass this contract and keep the lower-level
     * Kiwoom reader's deep pagination semantics.
     */
    let boundedKiwoomFailure: string | null = null;

    if (isBoundedKrIntradayRequest(ticker, timeframe)) {
      const controller = new AbortController();
      const deadlineAt = Date.now() + APP_KR_INTRADAY_DEADLINE_MS;
      const timeout = setTimeout(() => controller.abort(), APP_KR_INTRADAY_DEADLINE_MS);

      try {
        const result = await getKiwoomChartCandlesMeta(
          String(ticker).trim(),
          String(timeframe),
          APP_KR_INTRADAY_CANDLE_LIMIT,
          {
            signal: controller.signal,
            deadlineAt,
            maxPages: resolveKrInteractiveMaxPages(timeframe),
          },
        );

        if (result.candles.length >= minimumUsefulCandles(timeframe)) {
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
        }

        boundedKiwoomFailure = `INSUFFICIENT_CANDLES:${result.stopReason}`;
      } catch (error) {
        boundedKiwoomFailure = normalizeKiwoomInteractiveFailure(
          error,
          Date.now() >= deadlineAt,
        );
      } finally {
        clearTimeout(timeout);
      }
    }

    let primaryResult: MarketDataCandlesMeta | null = null;
    let primaryError: unknown = null;
    try {
      primaryResult = await super.getCandlesMeta(ticker, timeframe);
      if (primaryResult.candles.length > 0) {
        return boundedKiwoomFailure
          ? {
              ...primaryResult,
              fallbackFrom: {
                provider: 'kiwoom',
                reason: boundedKiwoomFailure,
              },
            }
          : primaryResult;
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
            ...(boundedKiwoomFailure
              ? {
                  fallbackFrom: {
                    provider: 'kiwoom' as const,
                    reason: boundedKiwoomFailure,
                  },
                }
              : {}),
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
      ...(boundedKiwoomFailure
        ? {
            fallbackFrom: {
              provider: 'kiwoom' as const,
              reason: boundedKiwoomFailure,
            },
          }
        : {}),
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
