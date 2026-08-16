import type {
  UnifiedAssetSuggestResponse,
  UnifiedMarketFilter,
  UnifiedSearchState,
} from '@/lib/unified-asset-search';

export const ALL_UNIFIED_SEARCH_MARKETS: readonly UnifiedMarketFilter[] = Object.freeze([
  'KR',
  'US',
  'spot',
  'futures',
]);

const PROVIDER_MARKET: Record<string, UnifiedMarketFilter> = {
  krx: 'KR',
  finnhub: 'US',
  upbit: 'spot',
  bitget: 'futures',
};

export function allowedUnifiedSearchMarkets({
  canAccessSpot,
  canAccessFutures,
}: {
  canAccessSpot: boolean;
  canAccessFutures: boolean;
}): UnifiedMarketFilter[] {
  const markets: UnifiedMarketFilter[] = ['KR', 'US'];
  if (canAccessSpot) markets.push('spot');
  if (canAccessFutures) markets.push('futures');
  return markets;
}

export function isUnifiedSearchMarketAllowed(
  market: UnifiedMarketFilter,
  allowedMarkets: readonly UnifiedMarketFilter[],
): boolean {
  return allowedMarkets.includes(market);
}

function filteredState(resultCount: number, partial: boolean, stale: boolean): UnifiedSearchState {
  if (resultCount > 0) {
    if (partial) return 'PARTIAL';
    if (stale) return 'DEGRADED';
    return 'FULL';
  }
  if (partial || stale) return 'DEGRADED';
  return 'EMPTY';
}

function filteredDataAsOf(
  response: UnifiedAssetSuggestResponse,
  providers: UnifiedAssetSuggestResponse['providers'],
): string | null {
  const providerTimes = providers
    .map((provider) => provider.dataAsOf ? Date.parse(provider.dataAsOf) : Number.NaN)
    .filter(Number.isFinite);
  if (providerTimes.length > 0) return new Date(Math.min(...providerTimes)).toISOString();
  return response.dataAsOf;
}

export function filterUnifiedSearchResponseByMarkets(
  response: UnifiedAssetSuggestResponse,
  allowedMarkets: readonly UnifiedMarketFilter[],
): UnifiedAssetSuggestResponse {
  const allowed = new Set(allowedMarkets);
  const results = response.results.filter((item) => allowed.has(item.market));
  const providers = response.providers.filter((provider) => {
    const providerMarket = PROVIDER_MARKET[String(provider.provider ?? '').toLowerCase()];
    return !providerMarket || allowed.has(providerMarket);
  });
  const hiddenMatches = response.hiddenMatches.filter((item) => allowed.has(item.market));
  const partial = providers.some((provider) => provider.status !== 'ok');
  const snapshotAgeStale = response.stale && response.providers.every((provider) => provider.status === 'ok');
  const stale = snapshotAgeStale || providers.some((provider) => provider.status === 'stale');

  return {
    ...response,
    results,
    count: results.length,
    dataAsOf: filteredDataAsOf(response, providers),
    stale,
    partial,
    state: filteredState(results.length, partial, stale),
    providers,
    hiddenMatches,
  };
}
