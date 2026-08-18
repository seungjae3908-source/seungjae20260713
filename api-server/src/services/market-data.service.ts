import BaseMarketDataService from './market-data.base.service';
import type { SearchResult, QuoteRow } from './market-data.base.service';
import {
  getCandles as getTossCandles,
  getCompanyProfile as getTossCompanyProfile,
  getQuote as getTossQuote,
  isTossConfigured,
} from '../providers/toss';
import { getKiwoomChartCandles } from '../kiwoom-chart';
import type { Candle, CompanyProfile, Quote, Timeframe } from '../sample/types';

export type { SearchResult, QuoteRow };

const FALLBACK_PROFILE_DESCRIPTION = '기업 정보를 확인 중입니다.';
const APP_KR_INTRADAY_CANDLE_LIMIT = 300;
const KR_INTRADAY_TIMEFRAMES = new Set(['1m', '3m', '5m', '15m', '30m', '60m', '1H', '4H']);

function minimumUsefulCandles(timeframe: Timeframe): number {
  return timeframe === '1D' ? 30 : 2;
}

function isBoundedKrIntradayRequest(ticker: string, timeframe: Timeframe): boolean {
  return /^\d{6}$/.test(String(ticker ?? '').trim())
    && KR_INTRADAY_TIMEFRAMES.has(String(timeframe));
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
  ): Promise<{ candles: Candle[]; provider: string; fetchedAt: string }> {
    /*
     * App-facing KR intraday charts must terminate inside the browser's finite request budget.
     * The lower-level Kiwoom history reader intentionally keeps its deep 300-page contract for
     * research/long-history callers; this facade asks only for the latest visible chart window.
     */
    if (isBoundedKrIntradayRequest(ticker, timeframe)) {
      try {
        const candles = await getKiwoomChartCandles(
          String(ticker).trim(),
          String(timeframe),
          APP_KR_INTRADAY_CANDLE_LIMIT,
        );
        if (candles.length >= minimumUsefulCandles(timeframe)) {
          return { candles, provider: 'kiwoom', fetchedAt: new Date().toISOString() };
        }
      } catch {
        // Preserve the existing provider fallback contract below.
      }
    }

    let primaryResult: { candles: Candle[]; provider: string; fetchedAt: string } | null = null;
    let primaryError: unknown = null;
    try {
      primaryResult = await super.getCandlesMeta(ticker, timeframe);
      if (primaryResult.candles.length > 0) return primaryResult;
    } catch (error) {
      primaryError = error;
    }

    if (isTossConfigured()) {
      try {
        const entry = await super.getCatalogEntry(ticker);
        const candles = await getTossCandles(entry, timeframe, 200);
        if (candles.length >= minimumUsefulCandles(timeframe)) {
          return { candles, provider: 'toss', fetchedAt: new Date().toISOString() };
        }
      } catch {
        // Preserve the pre-Toss failure/empty-data contract below.
      }
    }

    if (primaryError) throw primaryError;
    return primaryResult ?? { candles: [], provider: 'none', fetchedAt: new Date().toISOString() };
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
