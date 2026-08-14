import type { UnifiedMarketFilter } from '@/lib/unified-asset-search';

export const ALL_UNIFIED_SEARCH_MARKETS: readonly UnifiedMarketFilter[] = Object.freeze([
  'KR',
  'US',
  'spot',
  'futures',
]);

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
