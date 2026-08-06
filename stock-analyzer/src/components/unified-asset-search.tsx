import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import { AlertTriangle, Clock3, Loader2, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  fetchUnifiedAssetSuggestions,
  prioritizeUnifiedAssetSuggestions,
  type UnifiedAssetFilter,
  type UnifiedAssetSuggestion,
  type UnifiedAssetSuggestResponse,
  type UnifiedMarketFilter,
} from '@/lib/unified-asset-search';
import {
  readWatchlistItems,
  WATCHLIST_CHANGE_EVENT,
} from '@/lib/stock-display';

const RECENT_KEY = 'unified-asset-search:recent:v1';
const GROUP_ORDER: UnifiedMarketFilter[] = ['KR', 'US', 'spot', 'futures'];
const GROUP_LABEL: Record<UnifiedMarketFilter, string> = {
  KR: '국내주식',
  US: '해외주식',
  spot: '코인 현물',
  futures: '코인 선물',
};
const PROVIDER_LABEL: Record<string, string> = {
  krx: 'KRX',
  finnhub: 'Finnhub',
  upbit: 'Upbit',
  bitget: 'Bitget',
};

function readRecent(): UnifiedAssetSuggestion[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.slice(0, 8) : [];
  } catch {
    return [];
  }
}

function saveRecent(item: UnifiedAssetSuggestion) {
  const next = [item, ...readRecent().filter((recent) => recent.id !== item.id)].slice(0, 8);
  window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
}

function readSearchWatchlist() {
  return readWatchlistItems().map((item) => ({ ticker: item.ticker, market: item.market }));
}

function marketDescription(item: UnifiedAssetSuggestion) {
  if (item.market === 'KR') return `국내주식 · ${item.exchange}`;
  if (item.market === 'US') return `해외주식 · ${item.exchange}`;
  if (item.market === 'spot') return `현물 · ${item.exchange}`;
  return `선물 · ${item.exchange}`;
}

function displayCode(item: UnifiedAssetSuggestion) {
  if (item.market === 'spot') return `${item.baseSymbol}/${item.quoteCurrency}`;
  return item.ticker ?? item.productCode;
}

function providerNames(providers: UnifiedAssetSuggestResponse['providers']) {
  return providers.map((provider) => PROVIDER_LABEL[provider.provider] ?? provider.provider).join(', ');
}

function Highlight({ text, query }: { text: string; query: string }) {
  const normalizedText = text.toLocaleLowerCase('ko-KR');
  const normalizedQuery = query.trim().toLocaleLowerCase('ko-KR');
  const index = normalizedQuery ? normalizedText.indexOf(normalizedQuery) : -1;
  if (index < 0) return <>{text}</>;
  return <>{text.slice(0, index)}<mark className="rounded bg-primary/15 px-0.5 text-inherit">{text.slice(index, index + normalizedQuery.length)}</mark>{text.slice(index + normalizedQuery.length)}</>;
}

export function UnifiedAssetSearch({
  asset = 'all',
  market = null,
  placeholder = '종목명·티커·코인명·심볼 검색',
  autoFocus = false,
  onSelect,
}: {
  asset?: UnifiedAssetFilter;
  market?: UnifiedMarketFilter | null;
  placeholder?: string;
  autoFocus?: boolean;
  onSelect: (item: UnifiedAssetSuggestion) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const requestSequence = useRef(0);
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const [response, setResponse] = useState<UnifiedAssetSuggestResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [recent, setRecent] = useState<UnifiedAssetSuggestion[]>(() => readRecent());
  const [watchlist, setWatchlist] = useState(() => readSearchWatchlist());
  const [popupStyle, setPopupStyle] = useState<CSSProperties>({});
  const trimmed = query.trim();

  const filteredRecent = useMemo(() => recent.filter((item) =>
    (asset === 'all' || item.assetType === asset) && (!market || item.market === market),
  ), [asset, market, recent]);
  const prioritizedResults = useMemo(() => prioritizeUnifiedAssetSuggestions(
    response?.results ?? [],
    {
      recentIds: recent.map((item) => item.id),
      watchlist,
    },
  ), [recent, response?.results, watchlist]);
  const items = trimmed ? prioritizedResults : filteredRecent;
  const open = focused && (trimmed.length > 0 || filteredRecent.length > 0);
  const staleProviders = response?.providers.filter((provider) => provider.status === 'stale') ?? [];
  const errorProviders = response?.providers.filter((provider) => provider.status === 'error') ?? [];

  useEffect(() => {
    const updateWatchlist = () => setWatchlist(readSearchWatchlist());
    window.addEventListener(WATCHLIST_CHANGE_EVENT, updateWatchlist);
    window.addEventListener('storage', updateWatchlist);
    return () => {
      window.removeEventListener(WATCHLIST_CHANGE_EVENT, updateWatchlist);
      window.removeEventListener('storage', updateWatchlist);
    };
  }, []);

  const updatePopupPosition = useCallback(() => {
    const rect = inputRef.current?.getBoundingClientRect();
    if (!rect) return;
    const viewport = window.visualViewport;
    const viewportTop = viewport?.offsetTop ?? 0;
    const viewportHeight = viewport?.height ?? window.innerHeight;
    const top = rect.bottom + 8;
    setPopupStyle({
      position: 'fixed',
      left: Math.max(12, rect.left),
      top,
      width: Math.min(rect.width, window.innerWidth - Math.max(12, rect.left) - 12),
      maxHeight: Math.min(480, Math.max(180, viewportTop + viewportHeight - top - 12)),
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePopupPosition();
    const viewport = window.visualViewport;
    window.addEventListener('resize', updatePopupPosition);
    window.addEventListener('scroll', updatePopupPosition, true);
    viewport?.addEventListener('resize', updatePopupPosition);
    viewport?.addEventListener('scroll', updatePopupPosition);
    return () => {
      window.removeEventListener('resize', updatePopupPosition);
      window.removeEventListener('scroll', updatePopupPosition, true);
      viewport?.removeEventListener('resize', updatePopupPosition);
      viewport?.removeEventListener('scroll', updatePopupPosition);
    };
  }, [open, updatePopupPosition]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !popupRef.current?.contains(target)) setFocused(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, []);

  const runSearch = useCallback(async (value: string, signal?: AbortSignal) => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    setError(null);
    try {
      const next = await fetchUnifiedAssetSuggestions({ q: value, asset, market, limit: value.length === 1 ? 25 : 30, signal });
      if (sequence !== requestSequence.current) return;
      setResponse(next);
      setActiveIndex(next.results.length ? 0 : -1);
    } catch (cause) {
      if (signal?.aborted || sequence !== requestSequence.current) return;
      setError(cause instanceof Error ? cause.message : '검색 요청에 실패했습니다.');
      setResponse(null);
      setActiveIndex(-1);
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [asset, market]);

  useEffect(() => {
    if (!trimmed || composing) {
      setResponse(null);
      setLoading(false);
      setError(null);
      setActiveIndex(filteredRecent.length ? 0 : -1);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => void runSearch(trimmed, controller.signal), 200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [composing, filteredRecent.length, runSearch, trimmed]);

  const selectItem = (item: UnifiedAssetSuggestion) => {
    saveRecent(item);
    setRecent(readRecent());
    setFocused(false);
    setQuery(item.displayName);
    onSelect(item);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setFocused(true);
      setActiveIndex((current) => items.length ? (current + 1 + items.length) % items.length : -1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setFocused(true);
      setActiveIndex((current) => items.length ? (current - 1 + items.length) % items.length : -1);
    } else if (event.key === 'Enter' && activeIndex >= 0 && items[activeIndex]) {
      event.preventDefault();
      selectItem(items[activeIndex]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setFocused(false);
    }
  };

  const grouped = GROUP_ORDER.map((groupMarket) => ({
    market: groupMarket,
    items: items.map((item, index) => ({ item, index })).filter(({ item }) => item.market === groupMarket),
  })).filter((group) => group.items.length > 0);

  return (
    <div ref={rootRef} className="relative w-full">
      <div className="relative">
        <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
        <input
          ref={inputRef}
          role="combobox"
          aria-label="통합 자산 검색"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls="unified-asset-search-listbox"
          aria-activedescendant={activeIndex >= 0 ? `unified-search-option-${activeIndex}` : undefined}
          autoFocus={autoFocus}
          value={query}
          onFocus={() => { setFocused(true); updatePopupPosition(); }}
          onChange={(event) => setQuery(event.target.value)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={(event) => { setComposing(false); setQuery(event.currentTarget.value); }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="h-12 w-full rounded-2xl border border-card-border bg-card pl-12 pr-12 text-base font-bold outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15"
        />
        {query && <button type="button" aria-label="검색어 지우기" onClick={() => { setQuery(''); inputRef.current?.focus(); }} className="absolute right-1 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-xl text-muted-foreground active:bg-muted"><X className="h-4 w-4" /></button>}
      </div>

      {open && (
        <div ref={popupRef} id="unified-asset-search-listbox" role="listbox" aria-label="통합 자산 자동완성 결과" style={popupStyle} className="z-[120] overflow-y-auto overscroll-contain rounded-2xl border border-card-border bg-card shadow-2xl">
          {!trimmed && filteredRecent.length > 0 && <div className="flex items-center gap-2 border-b border-card-border px-4 py-3 text-xs font-extrabold text-muted-foreground"><Clock3 className="h-4 w-4" /> 최근 검색</div>}
          {loading && <div className="flex min-h-28 items-center justify-center gap-2 px-4 py-6 text-sm font-bold text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /> 검색 인덱스에서 찾는 중입니다.</div>}
          {!loading && error && <div className="space-y-3 px-4 py-5 text-center"><AlertTriangle className="mx-auto h-6 w-6 text-warning" /><p className="break-keep text-sm font-bold">{error}</p><button type="button" onClick={() => { if (trimmed) void runSearch(trimmed); }} className="h-11 rounded-xl border border-card-border px-4 text-sm font-extrabold">재시도</button></div>}
          {!loading && !error && trimmed && errorProviders.length > 0 && <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs font-bold text-destructive">공급자 연결 실패: {providerNames(errorProviders)}. 해당 시장 결과가 누락될 수 있습니다.</div>}
          {!loading && !error && trimmed && staleProviders.length > 0 && <div className="border-b border-warning/30 bg-warning/10 px-4 py-2 text-xs font-bold text-warning">마지막 정상 인덱스 사용: {providerNames(staleProviders)}.</div>}
          {!loading && !error && trimmed && response?.stale && <div className="border-b border-warning/30 bg-warning/10 px-4 py-2 text-xs font-bold text-warning">가장 오래된 데이터 기준시각: {response.dataAsOf ? new Date(response.dataAsOf).toLocaleString('ko-KR') : '확인 필요'}</div>}
          {!loading && !error && grouped.map((group) => (
            <Fragment key={group.market}>
              <div className="sticky top-0 z-10 border-y border-card-border bg-secondary/90 px-4 py-2 text-xs font-black backdrop-blur">{GROUP_LABEL[group.market]}</div>
              {group.items.map(({ item, index }) => (
                <button id={`unified-search-option-${index}`} key={item.id} type="button" role="option" aria-selected={activeIndex === index} onMouseEnter={() => setActiveIndex(index)} onClick={() => selectItem(item)} className={cn('flex min-h-14 w-full items-center gap-3 border-b border-card-border px-4 py-3 text-left last:border-b-0', activeIndex === index ? 'bg-primary/10' : 'bg-card active:bg-muted')}>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-black"><Highlight text={item.displayName} query={trimmed} /></p>
                    {item.englishName && item.englishName !== item.displayName && <p className="mt-0.5 truncate text-xs font-bold text-muted-foreground"><Highlight text={item.englishName} query={trimmed} /></p>}
                    <p className="mt-1 truncate text-[11px] font-bold text-muted-foreground">{marketDescription(item)}</p>
                  </div>
                  <div className="shrink-0 text-right"><p className="max-w-28 truncate text-xs font-black"><Highlight text={displayCode(item)} query={trimmed} /></p><p className={cn('mt-1 text-[10px] font-bold', item.active ? 'text-positive' : 'text-warning')}>{item.active ? '거래 가능' : '거래 중지'}</p></div>
                </button>
              ))}
            </Fragment>
          ))}
          {!loading && !error && trimmed && response && response.results.length === 0 && (
            <div className="space-y-2 px-4 py-6 text-center">
              <p className="text-sm font-black">일치하는 자산이 없습니다.</p>
              {response.hiddenMatches.length > 0 ? <p className="text-xs font-bold text-muted-foreground">다른 시장에서 찾음: {response.hiddenMatches.map((item) => `${GROUP_LABEL[item.market]} ${item.count}개`).join(', ')}</p> : response.partial ? <p className="text-xs font-bold text-warning">일부 공급자 결과가 누락되었거나 마지막 정상 인덱스를 사용 중이므로 신규 상장 자산이 아직 반영되지 않았을 수 있습니다.</p> : <p className="text-xs font-bold text-muted-foreground">이름·티커·종목코드·심볼을 다시 확인해 주세요.</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
