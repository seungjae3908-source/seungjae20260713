import BaseMarketDataService from './market-data.base.service';
import type { SearchResult, QuoteRow } from './market-data.base.service';
import {
  getCandles as getTossCandles,
  getCompanyProfile as getTossCompanyProfile,
  getQuote as getTossQuote,
  isTossConfigured,
} from '../providers/toss';
import type { Candle, CompanyProfile, Quote, Timeframe } from '../sample/types';

export type { SearchResult, QuoteRow };

const FALLBACK_PROFILE_DESCRIPTION = '기업 정보를 확인 중입니다.';

function minimumUsefulCandles(timeframe: Timeframe): number {
  return timeframe === '1D' ? 30 : 2;
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
