import { authorizedFetch } from '@/lib/auth-fetch';

export type UnifiedAssetFilter = 'all' | 'stock' | 'coin';
export type UnifiedMarketFilter = 'KR' | 'US' | 'spot' | 'futures';

export interface UnifiedAssetSuggestion {
  id: string;
  assetType: 'stock' | 'coin';
  market: UnifiedMarketFilter;
  instrumentType: 'stock' | 'spot' | 'futures';
  exchange: string;
  ticker?: string;
  symbol?: string;
  productCode: string;
  koreanName: string;
  englishName: string;
  displayName: string;
  baseSymbol: string;
  quoteCurrency: string;
  matchType: string;
  active: boolean;
  provider: string;
  dataAsOf: string;
}

export interface UnifiedSearchProviderStatus {
  provider: string;
  status: 'ok' | 'stale' | 'error';
  count: number;
  dataAsOf: string | null;
  message?: string;
}

export interface UnifiedAssetSuggestResponse {
  ok: boolean;
  q: string;
  asset: UnifiedAssetFilter;
  market: UnifiedMarketFilter | null;
  results: UnifiedAssetSuggestion[];
  count: number;
  dataAsOf: string | null;
  stale: boolean;
  partial: boolean;
  providers: UnifiedSearchProviderStatus[];
  hiddenMatches: Array<{ market: UnifiedMarketFilter; count: number }>;
  error?: string;
  message?: string;
}

export interface UnifiedSearchWatchlistPreference {
  ticker: string;
  market?: string;
}

export { prioritizeUnifiedAssetSuggestions } from './unified-asset-search-priority';

export async function fetchUnifiedAssetSuggestions(input: {
  q: string;
  asset?: UnifiedAssetFilter;
  market?: UnifiedMarketFilter | null;
  limit?: number;
  signal?: AbortSignal;
}): Promise<UnifiedAssetSuggestResponse> {
  const params = new URLSearchParams({
    q: input.q,
    asset: input.asset ?? 'all',
    limit: String(Math.max(1, Math.min(50, input.limit ?? 25))),
  });
  if (input.market) params.set('market', input.market);
  const response = await authorizedFetch(`/api/search/suggest?${params.toString()}`, {
    cache: 'no-store',
    signal: input.signal,
  });
  const payload = await response.json().catch(() => ({})) as Partial<UnifiedAssetSuggestResponse>;
  if (!response.ok) {
    const error = new Error(payload.message ?? payload.error ?? `HTTP_${response.status}`);
    error.name = payload.error ?? 'UNIFIED_SEARCH_ERROR';
    throw error;
  }
  return payload as UnifiedAssetSuggestResponse;
}

export function unifiedAssetDetailPath(item: UnifiedAssetSuggestion, backPath = '/search') {
  if (item.assetType === 'stock') {
    const ticker = item.ticker ?? item.productCode;
    return `/stock/${encodeURIComponent(ticker)}?back=${encodeURIComponent(backPath)}`;
  }
  const symbol = item.market === 'futures'
    ? item.productCode
    : item.baseSymbol || item.symbol || item.productCode;
  return `/stock-info?asset=coin&coinMarket=${item.market}&symbol=${encodeURIComponent(symbol)}`;
}
