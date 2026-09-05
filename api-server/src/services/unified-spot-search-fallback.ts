import { SEARCH_ALIAS_DEFINITIONS } from '../data/search-aliases';
import {
  createUnifiedAssetId,
  searchUnifiedAssetDocuments,
  type UnifiedAssetDocument,
} from '../lib/search-normalization';

export const SPOT_SEARCH_SOFT_DEADLINE_MS = 4_500;

export interface SpotSearchFallbackResponse {
  results: Array<{
    id: string;
    assetType: 'coin';
    market: 'spot';
    instrumentType: 'spot';
    exchange: 'UPBIT';
    symbol: string;
    productCode: string;
    koreanName: string;
    englishName: string;
    displayName: string;
    baseSymbol: string;
    quoteCurrency: 'KRW';
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
    provider: 'upbit';
    status: 'stale';
    count: number;
    dataAsOf: null;
    message: string;
  }>;
  hiddenMatches: [];
}

function spotAliasDocuments(now: string): UnifiedAssetDocument[] {
  return SEARCH_ALIAS_DEFINITIONS
    .filter((item) => item.assetType === 'coin' && (!item.market || item.market === 'spot'))
    .map((item, index) => {
      const baseSymbol = item.tickerOrBaseSymbol.trim().toUpperCase();
      const productCode = `KRW-${baseSymbol}`;
      const document: UnifiedAssetDocument = {
        id: '',
        assetType: 'coin',
        market: 'spot',
        instrumentType: 'spot',
        exchange: 'UPBIT',
        symbol: baseSymbol,
        productCode,
        koreanName: item.koreanName ?? '',
        englishName: item.englishName ?? '',
        displayName: item.koreanName || item.englishName || baseSymbol,
        aliases: Array.from(new Set([
          ...item.aliases,
          baseSymbol,
          `${baseSymbol}/KRW`,
          `${baseSymbol}-KRW`,
          productCode,
        ])),
        baseSymbol,
        quoteCurrency: 'KRW',
        active: false,
        provider: 'SEARCH_ALIAS_CATALOG',
        dataAsOf: now,
        liquidityRank: index + 1,
      };
      document.id = createUnifiedAssetId(document);
      return document;
    });
}

export function buildSpotSearchFallback(
  query: string,
  limit: number,
  now = new Date().toISOString(),
): SpotSearchFallbackResponse | null {
  const matches = searchUnifiedAssetDocuments(spotAliasDocuments(now), query, {
    asset: 'coin',
    market: 'spot',
    limit,
  });
  if (matches.length === 0) return null;

  const results = matches.map(({ document, matchType }) => ({
    id: document.id,
    assetType: 'coin' as const,
    market: 'spot' as const,
    instrumentType: 'spot' as const,
    exchange: 'UPBIT' as const,
    symbol: document.symbol ?? document.baseSymbol,
    productCode: document.productCode,
    koreanName: document.koreanName,
    englishName: document.englishName,
    displayName: document.displayName,
    baseSymbol: document.baseSymbol,
    quoteCurrency: 'KRW' as const,
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
      provider: 'upbit',
      status: 'stale',
      count: 0,
      dataAsOf: null,
      message: 'Upbit 공개 마켓 목록을 제시간에 확인하지 못해 검색용 정적 별칭 메타데이터만 표시합니다. 현재 상장·가격·주문 가능 상태는 확인되지 않았습니다.',
    }],
    hiddenMatches: [],
  };
}
