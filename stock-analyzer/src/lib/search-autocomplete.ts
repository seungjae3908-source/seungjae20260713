export type SearchSuggestion = {
  value: string;
  label?: string;
};

const HISTORY_PREFIX = 'app-search-history-v1';
const HISTORY_LIMIT = 20;

const STOCK_SUGGESTIONS: SearchSuggestion[] = [
  { value: '005930', label: '삼성전자' },
  { value: '000660', label: 'SK하이닉스' },
  { value: '005380', label: '현대차' },
  { value: '035420', label: '네이버' },
  { value: '035720', label: '카카오' },
  { value: '373220', label: 'LG에너지솔루션' },
  { value: '207940', label: '삼성바이오로직스' },
  { value: '068270', label: '셀트리온' },
  { value: 'AAPL', label: '애플' },
  { value: 'NVDA', label: '엔비디아' },
  { value: 'MSFT', label: '마이크로소프트' },
  { value: 'TSLA', label: '테슬라' },
  { value: 'AMZN', label: '아마존' },
  { value: 'GOOGL', label: '알파벳' },
  { value: 'META', label: '메타 플랫폼스' },
];

const COIN_SUGGESTIONS: SearchSuggestion[] = [
  { value: 'BTC', label: '비트코인' },
  { value: 'ETH', label: '이더리움' },
  { value: 'XRP', label: '리플' },
  { value: 'SOL', label: '솔라나' },
  { value: 'DOGE', label: '도지코인' },
  { value: 'ADA', label: '에이다' },
  { value: 'TRX', label: '트론' },
  { value: 'LINK', label: '체인링크' },
  { value: 'AVAX', label: '아발란체' },
  { value: 'SUI', label: '수이' },
  { value: 'BTCUSDT', label: '비트코인 선물' },
  { value: 'ETHUSDT', label: '이더리움 선물' },
  { value: 'XRPUSDT', label: '리플 선물' },
  { value: 'SOLUSDT', label: '솔라나 선물' },
];

export function searchContextKey(context: string): string {
  const normalized = String(context ?? '').trim().toLowerCase();
  if (/코인|심볼|coin|symbol|usdt|선물/.test(normalized)) return 'coin';
  if (/종목|주식|티커|ticker|stock|코드/.test(normalized)) return 'stock';
  return normalized.replace(/[^a-z0-9가-힣]+/g, '-').slice(0, 40) || 'general';
}

function historyStorageKey(context: string): string {
  return `${HISTORY_PREFIX}:${searchContextKey(context)}`;
}

export function readSearchHistory(context: string): SearchSuggestion[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(historyStorageKey(context));
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => String(item ?? '').trim())
      .filter(Boolean)
      .slice(0, HISTORY_LIMIT)
      .map((value) => ({ value, label: '최근 검색' }));
  } catch {
    return [];
  }
}

export function saveSearchHistory(context: string, value: string): void {
  const normalized = String(value ?? '').trim();
  if (!normalized || typeof window === 'undefined') return;
  try {
    const current = readSearchHistory(context).map((item) => item.value);
    const next = [
      normalized,
      ...current.filter((item) => item.toLowerCase() !== normalized.toLowerCase()),
    ].slice(0, HISTORY_LIMIT);
    window.localStorage.setItem(historyStorageKey(context), JSON.stringify(next));
  } catch {
    // 저장 공간을 사용할 수 없으면 최근 검색 저장만 생략합니다.
  }
}

function baseSuggestions(context: string): SearchSuggestion[] {
  const key = searchContextKey(context);
  if (key === 'coin') return COIN_SUGGESTIONS;
  if (key === 'stock') return STOCK_SUGGESTIONS;
  return [];
}

export function getSearchSuggestions(
  context: string,
  query: string,
  limit = 10,
): SearchSuggestion[] {
  const keyword = String(query ?? '').trim().toLowerCase();
  const merged = [...readSearchHistory(context), ...baseSuggestions(context)];
  const unique = new Map<string, SearchSuggestion>();

  for (const suggestion of merged) {
    const key = suggestion.value.toLowerCase();
    if (!unique.has(key)) unique.set(key, suggestion);
  }

  return [...unique.values()]
    .filter((suggestion) => {
      if (!keyword) return true;
      return (
        suggestion.value.toLowerCase().includes(keyword) ||
        String(suggestion.label ?? '').toLowerCase().includes(keyword)
      );
    })
    .slice(0, limit);
}
