import { CATALOG } from '../data/catalog';
import { aliasesForAsset } from '../data/search-aliases';
import {
  createUnifiedAssetId,
  searchUnifiedAssetDocuments,
  type UnifiedAssetDocument,
} from '../lib/search-normalization';

export const US_SEARCH_SOFT_DEADLINE_MS = 2_000;

export interface UsSearchFallbackResponse {
  results: Array<{
    id: string;
    assetType: 'stock';
    market: 'US';
    instrumentType: 'stock';
    exchange: 'US';
    ticker: string;
    productCode: string;
    koreanName: string;
    englishName: string;
    displayName: string;
    baseSymbol: string;
    quoteCurrency: 'USD';
    matchType: string;
    active: false;
    provider: 'STATIC_US_CATALOG';
    dataAsOf: string;
  }>;
  count: number;
  dataAsOf: null;
  stale: true;
  partial: true;
  providers: Array<{
    provider: 'finnhub';
    status: 'stale';
    count: number;
    dataAsOf: null;
    message: string;
  }>;
  hiddenMatches: [];
}

function usCatalogDocuments(now: string): UnifiedAssetDocument[] {
  return CATALOG
    .filter((item) => item.market === 'US')
    .map((item, index) => {
      const ticker = item.ticker.trim().toUpperCase();
      const manual = aliasesForAsset('stock', 'US', ticker);
      const koreanName = manual?.koreanName || '';
      const englishName = manual?.englishName || item.name;
      const document: UnifiedAssetDocument = {
        id: '',
        assetType: 'stock',
        market: 'US',
        instrumentType: 'stock',
        exchange: 'US',
        ticker,
        productCode: ticker,
        koreanName,
        englishName,
        displayName: koreanName || englishName || ticker,
        aliases: Array.from(new Set([
          ticker,
          item.name,
          ...(manual?.aliases ?? []),
          manual?.koreanName ?? '',
          manual?.englishName ?? '',
        ].map((value) => value.trim()).filter(Boolean))),
        baseSymbol: ticker,
        quoteCurrency: 'USD',
        active: false,
        provider: 'STATIC_US_CATALOG',
        dataAsOf: now,
        liquidityRank: index + 1,
      };
      document.id = createUnifiedAssetId(document);
      return document;
    });
}

export function buildUsSearchFallback(
  query: string,
  limit: number,
  now = new Date().toISOString(),
): UsSearchFallbackResponse | null {
  const matches = searchUnifiedAssetDocuments(usCatalogDocuments(now), query, {
    asset: 'stock',
    market: 'US',
    limit,
  });
  if (matches.length === 0) return null;

  const results = matches.map(({ document, matchType }) => ({
    id: document.id,
    assetType: 'stock' as const,
    market: 'US' as const,
    instrumentType: 'stock' as const,
    exchange: 'US' as const,
    ticker: document.ticker ?? document.productCode,
    productCode: document.productCode,
    koreanName: document.koreanName,
    englishName: document.englishName,
    displayName: document.displayName,
    baseSymbol: document.baseSymbol,
    quoteCurrency: 'USD' as const,
    matchType,
    active: false as const,
    provider: 'STATIC_US_CATALOG' as const,
    dataAsOf: now,
  }));

  return {
    results,
    count: results.length,
    dataAsOf: null,
    stale: true,
    partial: true,
    providers: [{
      provider: 'finnhub',
      status: 'stale',
      count: 0,
      dataAsOf: null,
      message: 'Finnhub 미국 종목 목록을 제시간에 확인하지 못해 검색용 정적 US 종목 메타데이터만 표시합니다. 현재 상장·가격·거래 가능 상태는 확인되지 않았습니다.',
    }],
    hiddenMatches: [],
  };
}
