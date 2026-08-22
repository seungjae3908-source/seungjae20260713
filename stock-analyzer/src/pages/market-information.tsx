import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, BarChart3, ChevronRight, RefreshCw, WifiOff } from 'lucide-react';
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

type RankingKey = 'tradingValue' | 'volume' | 'gainers' | 'losers' | 'marketCap';
type MobileRoomTab = 'market' | 'ranking' | 'news' | 'futures';

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
  const query = '(min-width: 1024px)';
  const [desktop, setDesktop] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);

  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setDesktop(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  return desktop;
}

function SourceMeta({ meta }: { meta: MarketInformationMeta }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-bold text-muted-foreground" aria-label="데이터 상태">
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
        <h2 className="truncate text-sm font-black">{title}</h2>
        <span className={cn(
          'shrink-0 rounded-full px-2 py-1 text-[10px] font-black',
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
            'min-h-11 min-w-0 rounded-xl border px-2 text-xs font-black',
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
          <span className="w-5 shrink-0 text-center text-[10px] font-black text-muted-foreground">{index + 1}</span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-black">{row.name}</span>
              <span className="shrink-0 text-[9px] font-bold text-muted-foreground">{row.symbol}</span>
              {row.warning ? <span className="shrink-0 rounded bg-red-500/10 px-1.5 py-0.5 text-[9px] font-black text-red-600">주의</span> : null}
            </span>
            <span className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[9px] font-bold text-muted-foreground">
              <span>거래량 {formatCompact(row.volume24h)}</span>
              <span>거래대금 {formatCompact(row.tradingValue24h)}</span>
              {route.id === 'coins-futures' ? <span>펀딩 {formatPercent(row.fundingRatePercent)}</span> : null}
              {route.id === 'coins-futures' ? <span>미결제약정 {formatCompact(row.openInterest)}</span> : null}
            </span>
          </span>
          <span className="shrink-0 text-right">
            <span className="block text-xs font-black sm:text-sm">{formatNumber(row.price, row.currency)} {row.currency}</span>
            <span className={cn(
              'text-[10px] font-black sm:text-xs',
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
          <span className="mt-1 block truncate text-[10px] font-bold text-muted-foreground">{item.symbol} · {item.source} · {formatDate(item.publishedAt)}</span>
        </a>
      ))}
    </div>
  );
}

function MarketDataLoading({ route }: { route: MarketInformationRoute }) {
  return (
    <section className="mt-4 flex min-h-16 items-center justify-center rounded-2xl border bg-card px-4 text-xs font-black text-muted-foreground" aria-busy="true" aria-label={`${route.label} 시장정보 로딩`}>
      시장정보 확인 중
    </section>
  );
}

function MarketDataError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const state = statusText(error);
  return (
    <section className="mt-4 rounded-2xl border bg-card p-4 text-center shadow-sm" aria-label="시장정보 오류">
      <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-muted">{state.icon}</div>
      <h2 className="mt-3 text-base font-black">{state.title}</h2>
      <p className="mt-1 line-clamp-2 text-xs font-bold text-muted-foreground">{state.description}</p>
      <button type="button" onClick={onRetry} className="mt-3 min-h-11 rounded-xl bg-primary px-5 text-sm font-black text-primary-foreground">재시도</button>
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
              <p className="mt-1 text-base font-black">{formatNumber(row.value)}</p>
              <p className={cn('mt-1 text-xs font-black', (row.changePercent ?? 0) > 0 ? 'text-red-600' : (row.changePercent ?? 0) < 0 ? 'text-blue-600' : 'text-muted-foreground')}>{formatPercent(row.changePercent)}</p>
            </div>
          ))}
        </div>
      </SectionFrame>
      <SectionFrame title="업종·섹터" section={data.sections.sectors}>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {data.sections.sectors.data.slice(0, 12).map((row) => (
            <div key={row.key} className="rounded-xl border bg-background p-3">
              <p className="truncate text-sm font-black">{row.label}</p>
              <p className="mt-1 truncate text-[10px] font-bold text-muted-foreground">구성 {row.constituentCount} · 거래대금 {formatCompact(row.tradingValue)}</p>
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
          <p className="text-[10px] font-bold text-muted-foreground">미제공 값은 비워둡니다.</p>
          <span className="shrink-0 rounded-full bg-muted px-2 py-1 text-[10px] font-black">{visibleRows.length}개</span>
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
          <div className="rounded-xl border bg-background p-3"><p className="text-[10px] font-bold text-muted-foreground">롱</p><p className="mt-1 text-base font-black">{formatPercent(data.sections.derivatives.data.longRatio == null ? null : data.sections.derivatives.data.longRatio * 100)}</p></div>
          <div className="rounded-xl border bg-background p-3"><p className="text-[10px] font-bold text-muted-foreground">숏</p><p className="mt-1 text-base font-black">{formatPercent(data.sections.derivatives.data.shortRatio == null ? null : data.sections.derivatives.data.shortRatio * 100)}</p></div>
          <div className="rounded-xl border bg-background p-3"><p className="text-[10px] font-bold text-muted-foreground">비율</p><p className="mt-1 text-base font-black">{formatNumber(data.sections.derivatives.data.longShortRatio)}</p></div>
        </div>
        <div className="mt-3 space-y-2">
          {data.sections.derivatives.data.liquidations.slice(0, 8).map((item, index) => (
            <div key={`${item.symbol}:${item.occurredAt}:${index}`} className="flex min-w-0 items-center justify-between gap-2 rounded-xl border bg-background p-3 text-xs">
              <span className="truncate font-black">{item.symbol} · {item.side === 'long' ? '롱 청산' : item.side === 'short' ? '숏 청산' : '방향 미상'}</span>
              <span className="shrink-0 text-right text-[10px] font-bold text-muted-foreground">{formatNumber(item.price, 'USDT')} · {formatCompact(item.amount)}</span>
            </div>
          ))}
        </div>
      </SectionFrame>
    </div>
  ) : null;

  const news = data ? (
    <div className="grid min-w-0 gap-3 lg:grid-cols-2" data-testid="market-room-news">
      <SectionFrame title="뉴스" section={data.sections.news}><FeedList rows={data.sections.news.data} /></SectionFrame>
      <SectionFrame title="공시" section={data.sections.disclosures}><FeedList rows={data.sections.disclosures.data} /></SectionFrame>
    </div>
  ) : null;

  return (
    <>
      <main className="mx-auto min-h-screen w-full max-w-6xl overflow-x-hidden px-3 pb-28 pt-3 sm:px-5 sm:pt-4">
        <header className="rounded-2xl border bg-card p-3 shadow-sm sm:p-4">
          <div className="flex min-w-0 items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[10px] font-black text-muted-foreground"><BarChart3 className="h-4 w-4" /><span className="truncate">{route.exchange} · {route.currency}</span></div>
              <h1 className="mt-1 truncate text-xl font-black tracking-tight sm:text-2xl">{route.label}</h1>
            </div>
            <button type="button" onClick={() => void query.refetch()} disabled={query.isFetching} className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl border bg-background px-3 text-xs font-black disabled:opacity-50" aria-label="시장정보 새로고침">
              <RefreshCw className={cn('h-4 w-4', query.isFetching && 'animate-spin')} />새로고침
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-[10px] font-bold text-muted-foreground">
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
