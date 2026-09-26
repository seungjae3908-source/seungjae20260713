import type {
  UnifiedAssetSuggestion,
  UnifiedMarketFilter,
  UnifiedSearchWatchlistPreference,
} from './unified-asset-search';

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
