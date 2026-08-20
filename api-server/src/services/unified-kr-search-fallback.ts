import { CATALOG } from '../data/catalog';
import {
  createUnifiedAssetId,
  searchUnifiedAssetDocuments,
  type UnifiedAssetDocument,
} from '../lib/search-normalization';

export interface KrSearchFallbackResponse {
  results: Array<{
    id: string;
    assetType: 'stock';
    market: 'KR';
    instrumentType: 'stock';
    exchange: 'KRX';
    ticker: string;
    productCode: string;
    koreanName: string;
    englishName: string;
    displayName: string;
    baseSymbol: string;
    quoteCurrency: 'KRW';
    matchType: string;
    active: false;
    provider: 'STATIC_KR_CATALOG';
    dataAsOf: string;
  }>;
  count: number;
  dataAsOf: null;
  stale: true;
  partial: true;
  providers: Array<{
    provider: 'krx';
    status: 'stale';
    count: 0;
    dataAsOf: null;
    message: string;
  }>;
  hiddenMatches: [];
}

function staticKrCatalogDocuments(now: string): UnifiedAssetDocument[] {
  return CATALOG
    .filter((item) => item.market === 'KR')
    .map((item, index) => {
      const ticker = item.ticker.trim().toUpperCase();
      const document: UnifiedAssetDocument = {
        id: '',
        assetType: 'stock',
        market: 'KR',
        instrumentType: 'stock',
        exchange: 'KRX',
        ticker,
        productCode: ticker,
        koreanName: item.name,
        englishName: '',
        displayName: item.name || ticker,
        aliases: [ticker, item.name].filter(Boolean),
        baseSymbol: ticker,
        quoteCurrency: 'KRW',
        // Static metadata proves search identity only. It must never be treated
        // as proof that the symbol is currently listed or tradeable.
        active: false,
        provider: 'STATIC_KR_CATALOG',
        dataAsOf: now,
        liquidityRank: index + 1,
      };
      document.id = createUnifiedAssetId(document);
      return document;
    });
}

export function buildKrSearchFallback(
  query: string,
  limit: number,
  now = new Date().toISOString(),
): KrSearchFallbackResponse | null {
  const matches = searchUnifiedAssetDocuments(staticKrCatalogDocuments(now), query, {
    asset: 'stock',
    market: 'KR',
    limit,
  });
  if (matches.length === 0) return null;

  const results = matches.map(({ document, matchType }) => ({
    id: document.id,
    assetType: 'stock' as const,
    market: 'KR' as const,
    instrumentType: 'stock' as const,
    exchange: 'KRX' as const,
    ticker: document.ticker ?? document.productCode,
    productCode: document.productCode,
    koreanName: document.koreanName,
    englishName: document.englishName,
    displayName: document.displayName,
    baseSymbol: document.baseSymbol,
    quoteCurrency: 'KRW' as const,
    matchType,
    active: false as const,
    provider: 'STATIC_KR_CATALOG' as const,
    dataAsOf: now,
  }));

  return {
    results,
    count: results.length,
    dataAsOf: null,
    stale: true,
    partial: true,
    providers: [{
      provider: 'krx',
      status: 'stale',
      count: 0,
      dataAsOf: null,
      message: 'KRX 공개 종목 목록을 확인하지 못해 저장소 정적 KR 종목 메타데이터만 표시합니다. 현재 상장·가격·거래 가능 상태는 확인되지 않았습니다.',
    }],
    hiddenMatches: [],
  };
}
