import { authorizedFetch } from '@/lib/auth-fetch';
import { resolveAssetDetailPath, type CanonicalAssetIdentity } from '@/lib/asset-navigation';

export type UnifiedAssetFilter = 'all' | 'stock' | 'coin';
export type UnifiedMarketFilter = 'KR' | 'US' | 'spot' | 'futures';
export type UnifiedSearchState = 'FULL' | 'PARTIAL' | 'DEGRADED' | 'EMPTY' | 'ERROR';
export type UnifiedSearchOutcomeCode = 'RESULTS_AVAILABLE' | 'NO_MATCH' | 'PROVIDER_UNAVAILABLE' | 'DATA_UNAVAILABLE';

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
  state: UnifiedSearchState;
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

export function deriveUnifiedSearchOutcome(response: UnifiedAssetSuggestResponse): UnifiedSearchOutcomeCode {
  if (!response.ok || response.state === 'ERROR') return 'DATA_UNAVAILABLE';
  if (response.results.length > 0) return 'RESULTS_AVAILABLE';
  if (response.partial || response.stale || response.state === 'PARTIAL' || response.state === 'DEGRADED'
    || response.providers.some((provider) => provider.status === 'error')) {
    return 'PROVIDER_UNAVAILABLE';
  }
  return 'NO_MATCH';
}

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

export function unifiedSuggestionIdentity(item: UnifiedAssetSuggestion, backPath = '/search'): CanonicalAssetIdentity {
  if (item.assetType === 'stock') {
    const market = item.market === 'US' ? 'US' : 'KR';
    const symbol = (item.ticker ?? item.productCode).trim().toUpperCase();
    return {
      assetClass: market === 'US' ? 'US_STOCK' : 'KR_STOCK',
      market,
      symbol,
      canonicalSymbol: symbol,
      backPath,
    };
  }

  if (item.market === 'futures') {
    const symbol = (item.productCode || item.symbol || item.baseSymbol).trim().toUpperCase();
    return {
      assetClass: 'CRYPTO_FUTURES',
      market: 'BITGET',
      symbol,
      canonicalSymbol: symbol,
      backPath,
    };
  }

  const rawSymbol = (item.symbol || item.productCode || item.baseSymbol).trim().toUpperCase();
  const baseSymbol = (item.baseSymbol || rawSymbol.replace(/^(?:KRW|BTC|USDT)-/, '')).trim().toUpperCase();
  return {
    assetClass: 'CRYPTO_SPOT',
    market: 'UPBIT',
    symbol: rawSymbol,
    canonicalSymbol: baseSymbol,
    backPath,
  };
}

export function unifiedAssetDetailPath(item: UnifiedAssetSuggestion, backPath = '/search') {
  const resolved = resolveAssetDetailPath(unifiedSuggestionIdentity(item, backPath));
  return item.assetType === 'stock'
    ? resolved.replace('/stock-info?', '/stock-info/analysis?')
    : resolved;
}
