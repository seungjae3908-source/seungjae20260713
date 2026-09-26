import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { AlertTriangle, BarChart3, ChevronRight, ExternalLink, FileText, Newspaper, RefreshCw, WifiOff } from 'lucide-react';
import { useLocation } from 'wouter';
import { BottomNav } from '@/components/bottom-nav';
import { ResponsiveTabs } from '@/components/responsive-tabs';
import { UnifiedAssetSearch } from '@/components/unified-asset-search';
import { authorizedFetch } from '@/lib/auth-fetch';
import { useAssetMode } from '@/lib/asset-mode';
import {
  marketInformationDetailPath,
  marketInformationRoute,
  parseMarketInformationText,
  type MarketInformationAssetRow,
  type MarketInformationMeta,
  type MarketInformationNewsRow,
  type MarketInformationRoute,
  type MarketInformationSection,
} from '@/lib/market-information';
import { unifiedAssetDetailPath } from '@/lib/unified-asset-search';
import { cn } from '@/lib/utils';
import { readWatchlistItems, WATCHLIST_CHANGE_EVENT } from '@/lib/stock-display';
import { loadPortfolioChartOverlays } from '@/lib/portfolio-overlay';

type RankingKey = 'tradingValue' | 'volume' | 'gainers' | 'losers' | 'marketCap';
type MobileRoomTab = 'market' | 'ranking' | 'news' | 'futures';

type MarketEventTimelineItem = {
  key: string;
  symbol: string;
  title: string;
  summary: string | null;
  kind: 'news' | 'disclosure';
  publishedAt: string;
  sources: Array<{ source: string; provider: string; url: string }>;
  held: boolean;
  watched: boolean;
};

const MOBILE_ROOM_TABS = [
  { value: 'market', label: '시장' },
  { value: 'ranking', label: '순위' },
  { value: 'news', label: '소식' },
] as const;

class MarketInformationRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'MarketInformationRequestError';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function requestRoom(route: MarketInformationRoute, signal: AbortSignal) {
  let response: Response;
  try {
    response = await authorizedFetch(`/api/market-information/${route.id}`, { signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new MarketInformationRequestError(0, 'NETWORK_ERROR', true, '네트워크 연결을 확인해 주세요.');
  }

  const text = await response.text();
  if (!response.ok) {
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) as unknown : null;
    } catch {
      payload = null;
    }
    const record = isObject(payload) ? payload : {};
    const code = typeof record.errorCode === 'string' ? record.errorCode : `HTTP_${response.status}`;
    const retryable = record.retryable === true || response.status === 429 || response.status >= 500;
    const message = typeof record.message === 'string' && record.message.trim()
      ? record.message
      : `시장정보 요청 실패 (${response.status})`;
    throw new MarketInformationRequestError(response.status, code, retryable, message);
  }

  return parseMarketInformationText(text, route);
}

export async function prefetchMarketInformationRoom(
  client: QueryClient,
  path = '/stocks/kr',
): Promise<void> {
  const route = marketInformationRoute(path);
  if (!route) return;
  await client.prefetchQuery({
    queryKey: ['market-information-room', route.id],
    queryFn: ({ signal }) => requestRoom(route, signal),
    staleTime: route.id === 'coins-futures' ? 10_000 : route.id === 'coins-spot' ? 15_000 : 30_000,
    retry: false,
  });
}

function formatDate(value: string | null): string {
  if (!value) return '미확인';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '미확인';
  return new Intl.DateTimeFormat('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

function formatNumber(value: number | null, currency?: string): string {
  if (value == null) return '미제공';
  const maximumFractionDigits = currency === 'KRW' ? 0 : Math.abs(value) < 1 ? 6 : 2;
  return new Intl.NumberFormat('ko-KR', { maximumFractionDigits }).format(value);
}

function formatCompact(value: number | null): string {
  if (value == null) return '미제공';
  return new Intl.NumberFormat('ko-KR', { notation: 'compact', maximumFractionDigits: 2 }).format(value);
}

function formatPercent(value: number | null): string {
  if (value == null) return '미제공';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

function normalizedEventTitle(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\[[^\]]+\]/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function buildEventTimeline(
  newsRows: MarketInformationNewsRow[],
  disclosureRows: MarketInformationNewsRow[],
  watched: Set<string>,
  held: Set<string>,
): MarketEventTimelineItem[] {
  const grouped = new Map<string, MarketEventTimelineItem>();
  for (const row of [...disclosureRows, ...newsRows]) {
    const symbol = row.symbol.trim().toUpperCase();
    const titleKey = normalizedEventTitle(row.title);
    const key = `${symbol}:${titleKey || row.id}`;
    const existing = grouped.get(key);
    if (existing) {
      if (!existing.sources.some((source) => source.url === row.url)) {
        existing.sources.push({ source: row.source, provider: row.provider, url: row.url });
      }
      if (row.kind === 'disclosure') existing.kind = 'disclosure';
      if (Date.parse(row.publishedAt) > Date.parse(existing.publishedAt)) existing.publishedAt = row.publishedAt;
      if (!existing.summary && row.summary) existing.summary = row.summary;
      continue;
    }
    grouped.set(key, {
      key,
      symbol,
      title: row.title,
      summary: row.summary,
      kind: row.kind,
      publishedAt: row.publishedAt,
      sources: [{ source: row.source, provider: row.provider, url: row.url }],
      held: held.has(symbol),
      watched: watched.has(symbol),
    });
  }

  return [...grouped.values()].sort((left, right) => {
    const leftUser = left.held ? 2 : left.watched ? 1 : 0;
    const rightUser = right.held ? 2 : right.watched ? 1 : 0;
    if (leftUser !== rightUser) return rightUser - leftUser;
    if (left.kind !== right.kind) return left.kind === 'disclosure' ? -1 : 1;
    return Date.parse(right.publishedAt) - Date.parse(left.publishedAt);
  });
}

function MarketEventTimeline({
  route,
  rows,
  onSelectSymbol,
}: {
  route: MarketInformationRoute;
  rows: MarketEventTimelineItem[];
  onSelectSymbol: (symbol: string) => void;
}) {
  if (!rows.length) {
    return <p className="mt-3 rounded-xl border border-dashed p-3 text-xs font-semibold text-muted-foreground">표시할 최신 뉴스·공시 이벤트가 없습니다.</p>;
  }
  return (
    <div className="mt-3 space-y-2" data-testid="market-event-timeline">
      {rows.slice(0, 30).map((item) => (
        <article key={item.key} className="rounded-xl border bg-background p-3" data-event-symbol={item.symbol}>
          <div className="flex min-w-0 items-start gap-2">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              {item.kind === 'disclosure' ? <FileText className="h-4 w-4" aria-hidden="true" /> : <Newspaper className="h-4 w-4" aria-hidden="true" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5 text-xs font-semibold">
                <span>{item.kind === 'disclosure' ? '공식공시' : '뉴스'}</span>
                <span className="text-muted-foreground">{item.symbol}</span>
                {item.held ? <span className="rounded-full bg-positive/10 px-2 py-0.5 text-positive">보유</span> : null}
                {!item.held && item.watched ? <span className="rounded-full bg-primary/10 px-2 py-0.5 text-primary">관심</span> : null}
              </div>
              <h3 className="mt-1 break-words text-sm font-bold leading-5">{item.title}</h3>
              {item.summary ? <p className="mt-1 line-clamp-2 break-words text-xs leading-5 text-muted-foreground">{item.summary}</p> : null}
              <p className="mt-1 text-xs font-medium text-muted-foreground">
                {formatDate(item.publishedAt)} · 출처 {item.sources.length}개
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" onClick={() => onSelectSymbol(item.symbol)} className="min-h-10 rounded-lg border px-3 text-xs font-semibold">
                  종목 분석
                </button>
                {item.sources.slice(0, 3).map((source, index) => (
                  <a key={source.url} href={source.url} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center gap-1 rounded-lg border px-3 text-xs font-semibold text-primary">
                    {item.sources.length > 1 ? `원문 ${index + 1}` : '원문'} <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </a>
                ))}
              </div>
            </div>
          </div>
        </article>
      ))}
      <p className="px-1 text-xs font-medium leading-5 text-muted-foreground">
        보유·관심종목과 공식공시를 우선 정렬합니다. AI 중요도·감성은 이 화면에서 임의 생성하지 않으며, 종목 분석 화면에서 검증된 근거가 있을 때만 사용합니다.
      </p>
    </div>
  );
}

function sectionStatusLabel(status: MarketInformationSection<unknown>['status']): string {
  if (status === 'ready') return '정상';
  if (status === 'partial') return '일부';
  if (status === 'stale') return '오래됨';
  if (status === 'unsupported') return '미지원';
  if (status === 'unavailable') return '사용불가';
  if (status === 'error') return '오류';
  if (status === 'empty') return '없음';
  return '미확인';
}

function statusText(error: unknown): { title: string; description: string; icon: ReactNode } {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return { title: '오프라인', description: '인터넷 연결을 확인해 주세요.', icon: <WifiOff className="h-5 w-5" /> };
  }
  if (error instanceof MarketInformationRequestError) {
    if (error.status === 401) return { title: '로그인 필요', description: '다시 로그인해 주세요.', icon: <AlertTriangle className="h-5 w-5" /> };
    if (error.status === 403) return { title: '권한 없음', description: '현재 등급에서 사용할 수 없습니다.', icon: <AlertTriangle className="h-5 w-5" /> };
    if (error.status === 429) return { title: '잠시 후 재시도', description: '호출 한도에 도달했습니다.', icon: <AlertTriangle className="h-5 w-5" /> };
    if (error.code.includes('TIMEOUT')) return { title: '응답 지연', description: '잠시 후 다시 시도해 주세요.', icon: <AlertTriangle className="h-5 w-5" /> };
    return { title: '시장정보 확인 실패', description: error.message, icon: <AlertTriangle className="h-5 w-5" /> };
  }
  return { title: '시장정보 확인 실패', description: error instanceof Error ? error.message : '알 수 없는 오류', icon: <AlertTriangle className="h-5 w-5" /> };
}

function useDesktopRoom(): boolean {
  const query = '(min-width: 1200px)';
  const [desktop, setDesktop] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);

  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setDesktop(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);

  return desktop;
}

function SourceMeta({ meta }: { meta: MarketInformationMeta }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-bold text-muted-foreground" aria-label="데이터 상태">
      <span>출처 {meta.source ?? meta.provider ?? '미연결'}</span>
      <span>기준 {formatDate(meta.providerUpdatedAt ?? meta.observedAt)}</span>
      <span>
        {meta.marketStatus === '24H' ? '24시간' : meta.marketStatus === 'OPEN' ? '장중' : meta.marketStatus === 'CLOSED' ? '마감' : '미확인'}
      </span>
      {meta.isDelayed ? <span className="text-amber-600">지연</span> : null}
      {meta.isStale ? <span className="text-red-600">오래됨</span> : null}
      {meta.partial ? <span className="text-amber-600">일부</span> : null}
    </div>
  );
}

function SectionFrame<T>({ title, section, children }: { title: string; section: MarketInformationSection<T>; children: ReactNode }) {
  const unavailable = section.status === 'unsupported'
    || section.status === 'unavailable'
    || section.status === 'error'
    || section.status === 'empty';

  return (
    <section className="min-w-0 rounded-2xl border bg-card p-3 shadow-sm sm:p-4">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <h2 className="truncate text-sm font-bold">{title}</h2>
        <span className={cn(
          'shrink-0 rounded-full px-2 py-1 text-xs font-bold',
          section.status === 'ready' && 'bg-emerald-500/10 text-emerald-700',
          (section.status === 'partial' || section.status === 'stale') && 'bg-amber-500/10 text-amber-700',
          unavailable && 'bg-muted text-muted-foreground',
        )}>
          {sectionStatusLabel(section.status)}
        </span>
      </div>
      {unavailable ? (
        <div className="mt-3 flex min-h-14 items-center gap-2 rounded-xl border border-dashed px-3 py-3 text-xs font-bold text-muted-foreground">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="line-clamp-2">{section.message ?? '표시할 데이터 없음'}</span>
        </div>
      ) : (
        <>
          {section.message ? <p className="mt-3 line-clamp-2 rounded-xl bg-muted/60 px-3 py-2 text-xs font-bold text-muted-foreground">{section.message}</p> : null}
          {children}
        </>
      )}
      <SourceMeta meta={section.meta} />
    </section>
  );
}

function RankingTabs({ value, onChange }: { value: RankingKey; onChange: (value: RankingKey) => void }) {
  const items: Array<{ key: RankingKey; label: string }> = [
    { key: 'tradingValue', label: '거래대금' },
    { key: 'volume', label: '거래량' },
    { key: 'gainers', label: '급등' },
    { key: 'losers', label: '급락' },
    { key: 'marketCap', label: '시가총액' },
  ];
  return (
    <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-5" role="tablist" aria-label="시장 순위 기준">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="tab"
          aria-selected={value === item.key}
          onClick={() => onChange(item.key)}
          className={cn(
            'min-h-11 min-w-0 rounded-xl border px-2 text-xs font-bold',
            value === item.key ? 'border-primary bg-primary text-primary-foreground' : 'bg-background hover:bg-muted',
          )}
        >
          <span className="break-keep">{item.label}</span>
        </button>
      ))}
    </div>
  );
}

function sortRows(rows: MarketInformationAssetRow[], key: RankingKey): MarketInformationAssetRow[] {
  const filtered = key === 'gainers'
    ? rows.filter((row) => (row.changePercent ?? 0) > 0)
    : key === 'losers'
      ? rows.filter((row) => (row.changePercent ?? 0) < 0)
      : rows;
  const metric = (row: MarketInformationAssetRow) => {
    if (key === 'volume') return row.volume24h;
    if (key === 'marketCap') return row.marketCap;
    if (key === 'gainers' || key === 'losers') return row.changePercent;
    return row.tradingValue24h;
  };
  return [...filtered].sort((left, right) => {
    const leftValue = metric(left);
    const rightValue = metric(right);
    if (leftValue == null && rightValue == null) return left.symbol.localeCompare(right.symbol);
    if (leftValue == null) return 1;
    if (rightValue == null) return -1;
    return key === 'losers' ? leftValue - rightValue : rightValue - leftValue;
  });
}

function AssetList({ route, rows, onSelect }: { route: MarketInformationRoute; rows: MarketInformationAssetRow[]; onSelect: (row: MarketInformationAssetRow) => void }) {
  if (!rows.length) return <p className="mt-3 rounded-xl border border-dashed p-3 text-xs font-bold text-muted-foreground">조건에 맞는 종목 없음</p>;

  return (
    <div className="mt-3 space-y-2">
      {rows.slice(0, 30).map((row, index) => (
        <button
          key={`${row.exchange}:${row.symbol}`}
          type="button"
          onClick={() => onSelect(row)}
          aria-label={`${row.name} 상세 화면 이동`}
          className="flex min-h-16 w-full min-w-0 items-center gap-2 rounded-xl border bg-background px-3 py-2.5 text-left hover:bg-muted/60"
        >
          <span className="w-5 shrink-0 text-center text-xs font-bold text-muted-foreground">{index + 1}</span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-bold">{row.name}</span>
              <span className="shrink-0 text-xs font-bold text-muted-foreground">{row.symbol}</span>
              {row.warning ? <span className="shrink-0 rounded bg-red-500/10 px-1.5 py-0.5 text-xs font-bold text-red-600">주의</span> : null}
            </span>
            <span className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-xs font-bold text-muted-foreground">
              <span>거래량 {formatCompact(row.volume24h)}</span>
              <span>거래대금 {formatCompact(row.tradingValue24h)}</span>
              {route.id === 'coins-futures' ? <span>펀딩 {formatPercent(row.fundingRatePercent)}</span> : null}
              {route.id === 'coins-futures' ? <span>미결제약정 {formatCompact(row.openInterest)}</span> : null}
            </span>
          </span>
          <span className="shrink-0 text-right">
            <span className="block text-xs font-bold sm:text-sm">{formatNumber(row.price, row.currency)} {row.currency}</span>
            <span className={cn(
              'text-xs font-bold sm:text-xs',
              (row.changePercent ?? 0) > 0 ? 'text-red-600' : (row.changePercent ?? 0) < 0 ? 'text-blue-600' : 'text-muted-foreground',
            )}>
              {formatPercent(row.changePercent)}
            </span>
          </span>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      ))}
    </div>
  );
}

function FeedList({ rows }: { rows: MarketInformationNewsRow[] }) {
  if (!rows.length) return <p className="mt-3 rounded-xl border border-dashed p-3 text-xs font-bold text-muted-foreground">새 소식 없음</p>;
  return (
    <div className="mt-3 space-y-2">
      {rows.slice(0, 20).map((item) => (
        <a
          key={item.id}
          href={item.url}
          target="_blank"
          rel="noreferrer"
          className="block min-h-14 rounded-xl border bg-background px-3 py-3 hover:bg-muted/60"
          aria-label={`${item.title} 원문 열기`}
        >
          <span className="line-clamp-2 text-sm font-bold leading-5">{item.title}</span>
          <span className="mt-1 block truncate text-xs font-bold text-muted-foreground">{item.symbol} · {item.source} · {formatDate(item.publishedAt)}</span>
        </a>
      ))}
    </div>
  );
}

function MarketDataLoading({ route }: { route: MarketInformationRoute }) {
  return (
    <section className="mt-4 flex min-h-16 items-center justify-center rounded-2xl border bg-card px-4 text-xs font-bold text-muted-foreground" aria-busy="true" aria-label={`${route.label} 시장정보 로딩`}>
      시장정보 확인 중
    </section>
  );
}

function MarketDataError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const state = statusText(error);
  return (
    <section className="mt-4 rounded-2xl border bg-card p-4 text-center shadow-sm" aria-label="시장정보 오류">
      <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-muted">{state.icon}</div>
      <h2 className="mt-3 text-base font-bold">{state.title}</h2>
      <p className="mt-1 line-clamp-2 text-xs font-bold text-muted-foreground">{state.description}</p>
      <button type="button" onClick={onRetry} className="mt-3 min-h-11 rounded-xl bg-primary px-5 text-sm font-bold text-primary-foreground">재시도</button>
    </section>
  );
}

export default function MarketInformationPage() {
  const [location, navigate] = useLocation();
  const route = marketInformationRoute(location);
  const mode = useAssetMode();
  const desktop = useDesktopRoom();
  const [ranking, setRanking] = useState<RankingKey>('tradingValue');
  const [mobileTab, setMobileTab] = useState<MobileRoomTab>('market');
  const [, setPersonalContextVersion] = useState(0);

  useEffect(() => {
    const refresh = () => setPersonalContextVersion((value) => value + 1);
    window.addEventListener(WATCHLIST_CHANGE_EVENT, refresh);
    window.addEventListener('sa-portfolio-overlay-updated', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(WATCHLIST_CHANGE_EVENT, refresh);
      window.removeEventListener('sa-portfolio-overlay-updated', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  useEffect(() => {
    if (!route) return;
    mode.setAsset(route.asset);
    if (route.asset === 'stock') mode.setStockMarket(route.market === 'US' ? 'US' : 'KR');
    else mode.setCoinMarket(route.market === 'futures' ? 'futures' : 'spot');
    setRanking('tradingValue');
    setMobileTab('market');
  }, [route?.id]);

  const query = useQuery({
    queryKey: ['market-information-room', route?.id ?? 'missing'],
    enabled: Boolean(route),
    queryFn: ({ signal }) => {
      if (!route) throw new MarketInformationRequestError(404, 'ROOM_NOT_FOUND', false, '정보방 경로 없음');
      return requestRoom(route, signal);
    },
    staleTime: route?.id === 'coins-futures' ? 10_000 : route?.id === 'coins-spot' ? 15_000 : 30_000,
    refetchInterval: route?.id === 'coins-futures' ? 15_000 : route?.id === 'coins-spot' ? 30_000 : 60_000,
    retry: (failureCount, error) => error instanceof MarketInformationRequestError && error.retryable && failureCount < 1,
  });

  const visibleRows = useMemo(() => sortRows(query.data?.sections.rankings.data ?? [], ranking), [query.data, ranking]);
  const watchedSymbols = useMemo(() => new Set(readWatchlistItems().map((item) => item.ticker.trim().toUpperCase())), [query.data, route?.id]);
  const heldSymbols = useMemo(() => new Set(loadPortfolioChartOverlays().map((item) => item.ticker)), [query.data, route?.id]);
  const eventTimeline = useMemo(() => buildEventTimeline(
    query.data?.sections.news.data ?? [],
    query.data?.sections.disclosures.data ?? [],
    watchedSymbols,
    heldSymbols,
  ), [query.data, watchedSymbols, heldSymbols]);

  if (!route) return <main className="p-6">지원하지 않는 정보방</main>;

  const data = query.data;
  const mobileTabs = route.id === 'coins-futures'
    ? [...MOBILE_ROOM_TABS, { value: 'futures' as const, label: '선물' }]
    : MOBILE_ROOM_TABS;

  const overview = data ? (
    <div className="grid min-w-0 gap-3 lg:grid-cols-2" data-testid="market-room-overview">
      <SectionFrame title="주요 지수" section={data.sections.indices}>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {data.sections.indices.data.map((row) => (
            <div key={row.key} className="rounded-xl border bg-background p-3">
              <p className="truncate text-xs font-bold text-muted-foreground">{row.label}</p>
              <p className="mt-1 text-base font-bold">{formatNumber(row.value)}</p>
              <p className={cn('mt-1 text-xs font-bold', (row.changePercent ?? 0) > 0 ? 'text-red-600' : (row.changePercent ?? 0) < 0 ? 'text-blue-600' : 'text-muted-foreground')}>{formatPercent(row.changePercent)}</p>
            </div>
          ))}
        </div>
      </SectionFrame>
      <SectionFrame title="업종·섹터" section={data.sections.sectors}>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {data.sections.sectors.data.slice(0, 12).map((row) => (
            <div key={row.key} className="rounded-xl border bg-background p-3">
              <p className="truncate text-sm font-bold">{row.label}</p>
              <p className="mt-1 truncate text-xs font-bold text-muted-foreground">구성 {row.constituentCount} · 거래대금 {formatCompact(row.tradingValue)}</p>
            </div>
          ))}
        </div>
      </SectionFrame>
    </div>
  ) : null;

  const rankings = data ? (
    <div data-testid="market-room-rankings">
      <SectionFrame title="종목 순위" section={data.sections.rankings}>
        <div className="mt-3 flex items-center justify-between gap-2">
          <p className="text-xs font-bold text-muted-foreground">미제공 값은 비워둡니다.</p>
          <span className="shrink-0 rounded-full bg-muted px-2 py-1 text-xs font-bold">{visibleRows.length}개</span>
        </div>
        <RankingTabs value={ranking} onChange={setRanking} />
        {ranking === 'marketCap' && data.sections.rankings.data.every((row) => row.marketCap == null) ? (
          <p className="mt-3 rounded-xl border border-dashed p-3 text-xs font-bold text-muted-foreground">시가총액 미제공</p>
        ) : (
          <AssetList route={route} rows={visibleRows} onSelect={(row) => navigate(marketInformationDetailPath(route, row.symbol))} />
        )}
      </SectionFrame>
    </div>
  ) : null;

  const futures = data && route.id === 'coins-futures' ? (
    <div data-testid="market-room-futures">
      <SectionFrame title="선물 지표" section={data.sections.derivatives}>
        <div className="mt-3 grid grid-cols-3 gap-2">
          <div className="rounded-xl border bg-background p-3"><p className="text-xs font-bold text-muted-foreground">롱</p><p className="mt-1 text-base font-bold">{formatPercent(data.sections.derivatives.data.longRatio == null ? null : data.sections.derivatives.data.longRatio * 100)}</p></div>
          <div className="rounded-xl border bg-background p-3"><p className="text-xs font-bold text-muted-foreground">숏</p><p className="mt-1 text-base font-bold">{formatPercent(data.sections.derivatives.data.shortRatio == null ? null : data.sections.derivatives.data.shortRatio * 100)}</p></div>
          <div className="rounded-xl border bg-background p-3"><p className="text-xs font-bold text-muted-foreground">비율</p><p className="mt-1 text-base font-bold">{formatNumber(data.sections.derivatives.data.longShortRatio)}</p></div>
        </div>
        <div className="mt-3 space-y-2">
          {data.sections.derivatives.data.liquidations.slice(0, 8).map((item, index) => (
            <div key={`${item.symbol}:${item.occurredAt}:${index}`} className="flex min-w-0 items-center justify-between gap-2 rounded-xl border bg-background p-3 text-xs">
              <span className="truncate font-bold">{item.symbol} · {item.side === 'long' ? '롱 청산' : item.side === 'short' ? '숏 청산' : '방향 미상'}</span>
              <span className="shrink-0 text-right text-xs font-bold text-muted-foreground">{formatNumber(item.price, 'USDT')} · {formatCompact(item.amount)}</span>
            </div>
          ))}
        </div>
      </SectionFrame>
    </div>
  ) : null;

  const news = data ? (
    <div className="min-w-0" data-testid="market-room-news">
      <SectionFrame title="뉴스·공시 이벤트" section={data.sections.news.status === 'unavailable' && data.sections.disclosures.status === 'unsupported' ? data.sections.news : {
        ...data.sections.news,
        status: data.sections.news.status === 'error' && data.sections.disclosures.status === 'error' ? 'error' : data.sections.news.status === 'stale' || data.sections.disclosures.status === 'stale' ? 'stale' : data.sections.news.status === 'partial' || data.sections.disclosures.status === 'partial' ? 'partial' : 'ready',
        message: data.sections.news.message ?? data.sections.disclosures.message,
      }}>
        <MarketEventTimeline
          route={route}
          rows={eventTimeline}
          onSelectSymbol={(symbol) => navigate(marketInformationDetailPath(route, symbol))}
        />
      </SectionFrame>
    </div>
  ) : null;

  return (
    <>
      <main className="mx-auto min-h-screen w-full max-w-6xl overflow-x-hidden px-3 pb-28 pt-3 sm:px-5 sm:pt-4">
        <header className="rounded-2xl border bg-card p-3 shadow-sm sm:p-4">
          <div className="flex min-w-0 items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-xs font-bold text-muted-foreground"><BarChart3 className="h-4 w-4" /><span className="truncate">{route.exchange} · {route.currency}</span></div>
              <h1 className="mt-1 truncate text-xl font-bold tracking-tight sm:text-2xl">{route.label}</h1>
            </div>
            <button type="button" onClick={() => void query.refetch()} disabled={query.isFetching} className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl border bg-background px-3 text-xs font-bold disabled:opacity-50" aria-label="시장정보 새로고침">
              <RefreshCw className={cn('h-4 w-4', query.isFetching && 'animate-spin')} />새로고침
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-xs font-bold text-muted-foreground">
            <span className="rounded-full bg-emerald-500/10 px-2 py-1 text-emerald-700">공개 데이터</span>
            {data?.partial ? <span className="rounded-full bg-amber-500/10 px-2 py-1 text-amber-700">일부 데이터</span> : null}
            {data ? <span className="rounded-full bg-muted px-2 py-1">수집 {formatDate(data.fetchedAt)}</span> : null}
          </div>
        </header>

        <section className="relative z-20 mt-3" aria-label="현재 정보방 검색">
          <UnifiedAssetSearch
            key={route.id}
            asset={route.asset}
            market={route.market}
            allowedMarkets={[route.market]}
            placeholder={route.asset === 'stock' ? '종목 검색' : '코인 검색'}
            onSelect={(item) => navigate(unifiedAssetDetailPath(item, route.href))}
          />
        </section>

        {!desktop && data ? (
          <div className="mt-3" data-testid="market-room-mobile-tabs">
            <ResponsiveTabs value={mobileTab} options={mobileTabs} onChange={setMobileTab} ariaLabel="시장정보 보기" compact />
          </div>
        ) : null}

        {query.isPending ? <MarketDataLoading route={route} /> : query.isError || !data ? (
          <MarketDataError error={query.error} onRetry={() => void query.refetch()} />
        ) : desktop ? (
          <div className="mt-4 space-y-4" data-testid="market-room-desktop-dashboard">
            {overview}
            {rankings}
            {futures}
            {news}
          </div>
        ) : (
          <div className="mt-3" data-testid={`market-room-mobile-panel-${mobileTab}`}>
            {mobileTab === 'market' ? overview : null}
            {mobileTab === 'ranking' ? rankings : null}
            {mobileTab === 'news' ? news : null}
            {mobileTab === 'futures' ? futures : null}
          </div>
        )}
      </main>
      <BottomNav />
    </>
  );
}
