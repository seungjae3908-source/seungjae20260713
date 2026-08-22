import { SEARCH_ALIAS_DEFINITIONS } from '../data/search-aliases';
import {
  createUnifiedAssetId,
  searchUnifiedAssetDocuments,
  type UnifiedAssetDocument,
} from '../lib/search-normalization';

export const FUTURES_SEARCH_SOFT_DEADLINE_MS = 2_500;

export interface FuturesSearchFallbackResponse {
  results: Array<{
    id: string;
    assetType: 'coin';
    market: 'futures';
    instrumentType: 'futures';
    exchange: 'BITGET';
    symbol: string;
    productCode: string;
    koreanName: string;
    englishName: string;
    displayName: string;
    baseSymbol: string;
    quoteCurrency: 'USDT';
    matchType: string;
    active: false;
    provider: 'SEARCH_ALIAS_CATALOG';
    dataAsOf: string;
  }>;
  count: number;
  dataAsOf: null;
  stale: true;
  partial: true;
  providers: Array<{
    provider: 'bitget';
    status: 'stale';
    count: number;
    dataAsOf: null;
    message: string;
  }>;
  hiddenMatches: [];
}

function futuresAliasDocuments(now: string): UnifiedAssetDocument[] {
  return SEARCH_ALIAS_DEFINITIONS
    .filter((item) => item.assetType === 'coin' && (!item.market || item.market === 'futures'))
    .map((item, index) => {
      const baseSymbol = item.tickerOrBaseSymbol.trim().toUpperCase();
      const productCode = `${baseSymbol}USDT`;
      const document: UnifiedAssetDocument = {
        id: '',
        assetType: 'coin',
        market: 'futures',
        instrumentType: 'futures',
        exchange: 'BITGET',
        symbol: productCode,
        productCode,
        koreanName: item.koreanName ?? '',
        englishName: item.englishName ?? '',
        displayName: item.koreanName || item.englishName || baseSymbol,
        aliases: Array.from(new Set([
          ...item.aliases,
          baseSymbol,
          productCode,
          `${baseSymbol}/USDT`,
          `${baseSymbol}-USDT`,
        ])),
        baseSymbol,
        quoteCurrency: 'USDT',
        active: false,
        provider: 'SEARCH_ALIAS_CATALOG',
        dataAsOf: now,
        liquidityRank: index + 1,
      };
      document.id = createUnifiedAssetId(document);
      return document;
    });
}

export function buildFuturesSearchFallback(
  query: string,
  limit: number,
  now = new Date().toISOString(),
): FuturesSearchFallbackResponse | null {
  const matches = searchUnifiedAssetDocuments(futuresAliasDocuments(now), query, {
    asset: 'coin',
    market: 'futures',
    limit,
  });
  if (matches.length === 0) return null;

  const results = matches.map(({ document, matchType }) => ({
    id: document.id,
    assetType: 'coin' as const,
    market: 'futures' as const,
    instrumentType: 'futures' as const,
    exchange: 'BITGET' as const,
    symbol: document.productCode,
    productCode: document.productCode,
    koreanName: document.koreanName,
    englishName: document.englishName,
    displayName: document.displayName,
    baseSymbol: document.baseSymbol,
    quoteCurrency: 'USDT' as const,
    matchType,
    active: false as const,
    provider: 'SEARCH_ALIAS_CATALOG' as const,
    dataAsOf: now,
  }));

  return {
    results,
    count: results.length,
    dataAsOf: null,
    stale: true,
    partial: true,
    providers: [{
      provider: 'bitget',
      status: 'stale',
      count: 0,
      dataAsOf: null,
      message: 'Bitget 공개 계약 목록을 제시간에 확인하지 못해 검색용 정적 별칭 메타데이터만 표시합니다. 현재 상장·가격·거래 가능 상태는 확인되지 않았습니다.',
    }],
    hiddenMatches: [],
  };
}
