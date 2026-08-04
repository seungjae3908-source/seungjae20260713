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

const MATCH_TIER: Record<string, number> = {
  code_exact: 0,
  name_exact: 1,
  code_prefix: 2,
  name_prefix: 3,
  word_prefix: 4,
  alias: 5,
  contains: 6,
  choseong: 7,
  fuzzy: 8,
};

function normalizedPreferenceCode(value: unknown) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toUpperCase()
    .replace(/[\s\-./_:·・]+/gu, '');
}

function normalizedPreferenceMarket(value: unknown): UnifiedMarketFilter | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'kr' || normalized.includes('kospi') || normalized.includes('kosdaq') || normalized.includes('krx')) return 'KR';
  if (normalized === 'us' || normalized.includes('nasdaq') || normalized.includes('nyse') || normalized.includes('amex')) return 'US';
  if (normalized === 'spot' || normalized.includes('현물') || normalized.includes('upbit')) return 'spot';
  if (normalized === 'futures' || normalized.includes('선물') || normalized.includes('bitget')) return 'futures';
  return null;
}

function suggestionPreferenceCodes(item: UnifiedAssetSuggestion) {
  return new Set([
    item.ticker,
    item.symbol,
    item.productCode,
    item.baseSymbol,
    item.market === 'spot' ? `${item.baseSymbol}${item.quoteCurrency}` : '',
  ].map(normalizedPreferenceCode).filter(Boolean));
}

function isWatchlisted(item: UnifiedAssetSuggestion, watchlist: UnifiedSearchWatchlistPreference[]) {
  const codes = suggestionPreferenceCodes(item);
  return watchlist.some((entry) => {
    const code = normalizedPreferenceCode(entry.ticker);
    if (!code || !codes.has(code)) return false;
    const market = normalizedPreferenceMarket(entry.market);
    return market == null || market === item.market;
  });
}

/**
 * Preserve the server's strict match-category ordering. Recent searches and
 * watchlist membership only break ties inside the same match category, so an
 * alias or contains match can never outrank an exact ticker/code match.
 */
export function prioritizeUnifiedAssetSuggestions(
  results: UnifiedAssetSuggestion[],
  input: {
    recentIds?: Iterable<string>;
    watchlist?: UnifiedSearchWatchlistPreference[];
  } = {},
) {
  const recentIds = new Set(input.recentIds ?? []);
  const watchlist = input.watchlist ?? [];
  return results
    .map((item, index) => ({
      item,
      index,
      tier: MATCH_TIER[item.matchType] ?? Number.MAX_SAFE_INTEGER,
      watchlisted: isWatchlisted(item, watchlist),
      recent: recentIds.has(item.id),
    }))
    .sort((left, right) =>
      left.tier - right.tier ||
      Number(right.watchlisted) - Number(left.watchlisted) ||
      Number(right.recent) - Number(left.recent) ||
      left.index - right.index,
    )
    .map(({ item }) => item);
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
