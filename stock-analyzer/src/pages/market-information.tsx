import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  ChevronRight,
  RefreshCw,
  Search,
  WifiOff,
} from 'lucide-react';
import { useLocation } from 'wouter';
import { BottomNav } from '@/components/bottom-nav';
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
import { cn } from '@/lib/utils';

type RankingKey = 'tradingValue' | 'volume' | 'gainers' | 'losers' | 'marketCap';

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
      : `시장정보 요청에 실패했습니다. (${response.status})`;
    throw new MarketInformationRequestError(response.status, code, retryable, message);
  }

  return parseMarketInformationText(text, route);
}

function formatDate(value: string | null): string {
  if (!value) return '기준시각 미제공';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '잘못된 기준시각';
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

function statusText(error: unknown): { title: string; description: string; icon: ReactNode } {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return {
      title: '오프라인 상태입니다',
      description: '인터넷 연결 후 새로고침해 주세요.',
      icon: <WifiOff className="h-5 w-5" />,
    };
  }
  if (error instanceof MarketInformationRequestError) {
    if (error.status === 401) {
      return {
        title: '인증이 만료되었습니다',
        description: '다시 로그인한 뒤 이용해 주세요.',
        icon: <AlertTriangle className="h-5 w-5" />,
      };
    }
    if (error.status === 403) {
      return {
        title: '권한이 부족합니다',
        description: '현재 회원 등급에서 이 정보방을 사용할 수 없습니다.',
        icon: <AlertTriangle className="h-5 w-5" />,
      };
    }
    if (error.status === 429) {
      return {
        title: '제공기관 호출 한도에 도달했습니다',
        description: 'Retry-After 이후 다시 시도해 주세요.',
        icon: <AlertTriangle className="h-5 w-5" />,
      };
    }
    if (error.code.includes('TIMEOUT')) {
      return {
        title: '제공기관 응답이 지연되고 있습니다',
        description: '잠시 후 다시 시도해 주세요.',
        icon: <AlertTriangle className="h-5 w-5" />,
      };
    }
    return {
      title: '시장정보를 불러오지 못했습니다',
      description: error.message,
      icon: <AlertTriangle className="h-5 w-5" />,
    };
  }
  return {
    title: '시장정보 응답을 확인하지 못했습니다',
    description: error instanceof Error ? error.message : '알 수 없는 오류입니다.',
    icon: <AlertTriangle className="h-5 w-5" />,
  };
}

function SourceMeta({ meta }: { meta: MarketInformationMeta }) {
  return (
    <div
      className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground"
      aria-label="데이터 출처와 신선도"
    >
      <span>출처 {meta.source ?? meta.provider ?? '미연결'}</span>
      <span>기준 {formatDate(meta.providerUpdatedAt ?? meta.observedAt)}</span>
      <span>
        {meta.marketStatus === '24H'
          ? '24시간 시장'
          : meta.marketStatus === 'OPEN'
            ? '장중'
            : meta.marketStatus === 'CLOSED'
              ? '장 마감'
              : '시장상태 미확인'}
      </span>
      {meta.isDelayed && <span className="font-semibold text-amber-600">지연</span>}
      {meta.isStale && <span className="font-semibold text-red-600">stale</span>}
      {meta.partial && <span className="font-semibold text-amber-600">일부 데이터</span>}
    </div>
  );
}

function SectionFrame<T>({
  title,
  section,
  children,
}: {
  title: string;
  section: MarketInformationSection<T>;
  children: ReactNode;
}) {
  const unavailable = section.status === 'unsupported'
    || section.status === 'unavailable'
    || section.status === 'error'
    || section.status === 'empty';
  const headingId = `section-${title}`;

  return (
    <section className="min-w-0 rounded-2xl border bg-card p-4 shadow-sm" aria-labelledby={headingId}>
      <div className="flex items-start justify-between gap-3">
        <h2 id={headingId} className="text-sm font-bold">{title}</h2>
        <span className={cn(
          'rounded-full px-2 py-1 text-[10px] font-semibold',
          section.status === 'ready' && 'bg-emerald-500/10 text-emerald-700',
          (section.status === 'partial' || section.status === 'stale') && 'bg-amber-500/10 text-amber-700',
          unavailable && 'bg-muted text-muted-foreground',
        )}>
          {section.status}
        </span>
      </div>

      {unavailable ? (
        <div className="mt-4 flex min-h-20 items-center gap-2 rounded-xl border border-dashed px-3 py-4 text-xs text-muted-foreground">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>{section.message ?? '표시할 데이터가 없습니다.'}</span>
        </div>
      ) : (
        <>
          {section.message && (
            <p className="mt-3 rounded-xl bg-muted/60 px-3 py-2 text-xs leading-5 text-muted-foreground">
              {section.message}
            </p>
          )}
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
            'min-h-11 rounded-xl border px-2 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            value === item.key ? 'border-primary bg-primary text-primary-foreground' : 'bg-background hover:bg-muted',
          )}
        >
          {item.label}
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

function AssetList({
  route,
  rows,
  onSelect,
}: {
  route: MarketInformationRoute;
  rows: MarketInformationAssetRow[];
  onSelect: (row: MarketInformationAssetRow) => void;
}) {
  if (!rows.length) {
    return (
      <p className="mt-4 rounded-xl border border-dashed p-4 text-xs text-muted-foreground">
        현재 조건에 맞는 종목이 없습니다.
      </p>
    );
  }

  return (
    <div className="mt-3 space-y-2">
      {rows.slice(0, 30).map((row, index) => (
        <button
          key={`${row.exchange}:${row.symbol}`}
          type="button"
          onClick={() => onSelect(row)}
          aria-label={`${row.name} 상세 화면 이동`}
          className="flex min-h-16 w-full min-w-0 items-center gap-3 rounded-xl border bg-background px-3 py-3 text-left transition hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="w-6 shrink-0 text-center text-xs font-bold text-muted-foreground">{index + 1}</span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-bold">{row.name}</span>
              <span className="shrink-0 text-[10px] text-muted-foreground">{row.symbol}</span>
              {row.warning && (
                <span className="shrink-0 rounded bg-red-500/10 px-1.5 py-0.5 text-[9px] font-bold text-red-600">
                  주의
                </span>
              )}
            </span>
            <span className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
              <span>거래량 {formatCompact(row.volume24h)}</span>
              <span>거래대금 {formatCompact(row.tradingValue24h)}</span>
              {route.id === 'coins-futures' && <span>펀딩 {formatPercent(row.fundingRatePercent)}</span>}
              {route.id === 'coins-futures' && <span>OI {formatCompact(row.openInterest)}</span>}
            </span>
          </span>
          <span className="shrink-0 text-right">
            <span className="block text-sm font-bold">{formatNumber(row.price, row.currency)} {row.currency}</span>
            <span className={cn(
              'text-xs font-semibold',
              (row.changePercent ?? 0) > 0
                ? 'text-red-600'
                : (row.changePercent ?? 0) < 0
                  ? 'text-blue-600'
                  : 'text-muted-foreground',
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
  return (
    <div className="mt-3 space-y-2">
      {rows.slice(0, 20).map((item) => (
        <a
          key={item.id}
          href={item.url}
          target="_blank"
          rel="noreferrer"
          className="block min-h-14 rounded-xl border bg-background px-3 py-3 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`${item.title} 원문 열기`}
        >
          <span className="block text-sm font-semibold leading-5">{item.title}</span>
          <span className="mt-1 block text-[11px] text-muted-foreground">
            {item.symbol} · {item.source} · {formatDate(item.publishedAt)}
          </span>
        </a>
      ))}
    </div>
  );
}

function LoadingView({ route }: { route: MarketInformationRoute }) {
  return (
    <main className="mx-auto min-h-screen w-full max-w-6xl overflow-x-hidden px-3 pb-28 pt-4 sm:px-5" aria-busy="true">
      <div className="h-8 w-48 animate-pulse rounded-lg bg-muted" />
      <p className="mt-3 text-sm text-muted-foreground">{route.label} 공개 데이터를 불러오는 중입니다.</p>
      <div className="mt-5 grid gap-4 md:grid-cols-2">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="h-40 animate-pulse rounded-2xl bg-muted" />
        ))}
      </div>
    </main>
  );
}

export default function MarketInformationPage() {
  const [location, navigate] = useLocation();
  const route = marketInformationRoute(location);
  const mode = useAssetMode();
  const [search, setSearch] = useState('');
  const [ranking, setRanking] = useState<RankingKey>('tradingValue');

  useEffect(() => {
    if (!route) return;
    mode.setAsset(route.asset);
    if (route.asset === 'stock') mode.setStockMarket(route.market === 'US' ? 'US' : 'KR');
    else mode.setCoinMarket(route.market === 'futures' ? 'futures' : 'spot');
    setSearch('');
    setRanking('tradingValue');
  }, [route?.id]);

  const query = useQuery({
    queryKey: ['market-information-room', route?.id ?? 'missing'],
    enabled: Boolean(route),
    queryFn: ({ signal }) => {
      if (!route) {
        throw new MarketInformationRequestError(404, 'ROOM_NOT_FOUND', false, '정보방 경로를 찾을 수 없습니다.');
      }
      return requestRoom(route, signal);
    },
    staleTime: route?.id === 'coins-futures' ? 10_000 : route?.id === 'coins-spot' ? 15_000 : 30_000,
    refetchInterval: route?.id === 'coins-futures' ? 15_000 : route?.id === 'coins-spot' ? 30_000 : 60_000,
    retry: (failureCount, error) => error instanceof MarketInformationRequestError && error.retryable && failureCount < 1,
  });

  const visibleRows = useMemo(() => {
    const rows = query.data?.sections.rankings.data ?? [];
    const term = search.trim().toLocaleLowerCase('ko-KR');
    const filtered = term
      ? rows.filter((row) => row.symbol.toLocaleLowerCase().includes(term)
        || row.name.toLocaleLowerCase('ko-KR').includes(term))
      : rows;
    return sortRows(filtered, ranking);
  }, [query.data, ranking, search]);

  if (!route) {
    return <main className="p-6">지원하지 않는 정보방 경로입니다.</main>;
  }

  if (query.isPending) {
    return (
      <>
        <LoadingView route={route} />
        <BottomNav />
      </>
    );
  }

  if (query.isError || !query.data) {
    const state = statusText(query.error);
    return (
      <>
        <main className="mx-auto min-h-screen w-full max-w-3xl overflow-x-hidden px-4 pb-28 pt-8">
          <div className="rounded-2xl border bg-card p-6 text-center shadow-sm">
            <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-muted">{state.icon}</div>
            <h1 className="mt-4 text-lg font-bold">{state.title}</h1>
            <p className="mt-2 text-sm text-muted-foreground">{state.description}</p>
            <button
              type="button"
              onClick={() => void query.refetch()}
              className="mt-5 min-h-11 rounded-xl bg-primary px-5 text-sm font-bold text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              다시 시도
            </button>
          </div>
        </main>
        <BottomNav />
      </>
    );
  }

  const data = query.data;
  return (
    <>
      <main className="mx-auto min-h-screen w-full max-w-6xl overflow-x-hidden px-3 pb-28 pt-4 sm:px-5">
        <header className="rounded-2xl border bg-card p-4 shadow-sm sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                <BarChart3 className="h-4 w-4" />
                <span>{route.exchange} · {route.currency}</span>
              </div>
              <h1 className="mt-2 text-xl font-black tracking-tight sm:text-2xl">{route.label}</h1>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                실제 공개 시장데이터만 표시하며 출처·기준시각·부분 실패를 카드별로 구분합니다.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void query.refetch()}
              disabled={query.isFetching}
              className="flex min-h-11 items-center gap-2 rounded-xl border bg-background px-3 text-xs font-bold hover:bg-muted disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="시장정보 새로고침"
            >
              <RefreshCw className={cn('h-4 w-4', query.isFetching && 'animate-spin')} />
              새로고침
            </button>
          </div>
          <div className="mt-4 flex flex-wrap gap-2 text-[11px]">
            <span className="rounded-full bg-emerald-500/10 px-2.5 py-1 font-semibold text-emerald-700">
              <CheckCircle2 className="mr-1 inline h-3 w-3" />공개 API 전용
            </span>
            <span className="rounded-full bg-muted px-2.5 py-1">private 요청 0</span>
            <span className="rounded-full bg-muted px-2.5 py-1">주문·취소 0</span>
            {data.partial && (
              <span className="rounded-full bg-amber-500/10 px-2.5 py-1 font-semibold text-amber-700">부분 데이터</span>
            )}
            <span className="rounded-full bg-muted px-2.5 py-1">수집 {formatDate(data.fetchedAt)}</span>
          </div>
        </header>

        <div className="relative mt-4">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={route.asset === 'stock' ? '현재 정보방 종목명·티커 검색' : '현재 정보방 코인명·심볼 검색'}
            aria-label="현재 정보방 검색"
            className="min-h-11 w-full rounded-xl border bg-card pl-10 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <div className="mt-4 grid min-w-0 gap-4 lg:grid-cols-2">
          <SectionFrame title="주요 지수" section={data.sections.indices}>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {data.sections.indices.data.map((row) => (
                <div key={row.key} className="rounded-xl border bg-background p-3">
                  <p className="text-xs text-muted-foreground">{row.label}</p>
                  <p className="mt-1 text-base font-bold">{formatNumber(row.value)}</p>
                  <p className={cn(
                    'mt-1 text-xs font-semibold',
                    (row.changePercent ?? 0) > 0
                      ? 'text-red-600'
                      : (row.changePercent ?? 0) < 0
                        ? 'text-blue-600'
                        : 'text-muted-foreground',
                  )}>
                    {formatPercent(row.changePercent)}
                  </p>
                </div>
              ))}
            </div>
          </SectionFrame>

          <SectionFrame title="업종·섹터" section={data.sections.sectors}>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {data.sections.sectors.data.slice(0, 12).map((row) => (
                <div key={row.key} className="rounded-xl border bg-background p-3">
                  <p className="truncate text-sm font-bold">{row.label}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    구성 {row.constituentCount} · 거래대금 {formatCompact(row.tradingValue)}
                  </p>
                </div>
              ))}
            </div>
          </SectionFrame>
        </div>

        <div className="mt-4">
          <SectionFrame title="시장 종목 순위" section={data.sections.rankings}>
            <div className="mt-3 flex flex-wrap items-start justify-between gap-2">
              <p className="text-[11px] text-muted-foreground">null은 미제공이며 실제 0과 구분합니다.</p>
              <span className="rounded-full bg-muted px-2 py-1 text-[10px]">{visibleRows.length}개</span>
            </div>
            <RankingTabs value={ranking} onChange={setRanking} />
            {ranking === 'marketCap' && data.sections.rankings.data.every((row) => row.marketCap == null) ? (
              <p className="mt-4 rounded-xl border border-dashed p-4 text-xs text-muted-foreground">
                현재 연결된 provider가 시가총액을 제공하지 않아 임의 계산하지 않습니다.
              </p>
            ) : (
              <AssetList
                route={route}
                rows={visibleRows}
                onSelect={(row) => navigate(marketInformationDetailPath(route, row.symbol))}
              />
            )}
          </SectionFrame>
        </div>

        {route.id === 'coins-futures' && (
          <div className="mt-4">
            <SectionFrame title="선물 공개 파생지표" section={data.sections.derivatives}>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl border bg-background p-3">
                  <p className="text-xs text-muted-foreground">롱 비율</p>
                  <p className="mt-1 text-lg font-bold">
                    {formatPercent(data.sections.derivatives.data.longRatio == null
                      ? null
                      : data.sections.derivatives.data.longRatio * 100)}
                  </p>
                </div>
                <div className="rounded-xl border bg-background p-3">
                  <p className="text-xs text-muted-foreground">숏 비율</p>
                  <p className="mt-1 text-lg font-bold">
                    {formatPercent(data.sections.derivatives.data.shortRatio == null
                      ? null
                      : data.sections.derivatives.data.shortRatio * 100)}
                  </p>
                </div>
                <div className="rounded-xl border bg-background p-3">
                  <p className="text-xs text-muted-foreground">롱/숏 비</p>
                  <p className="mt-1 text-lg font-bold">{formatNumber(data.sections.derivatives.data.longShortRatio)}</p>
                </div>
              </div>
              <div className="mt-3 space-y-2">
                {data.sections.derivatives.data.liquidations.slice(0, 8).map((item, index) => (
                  <div
                    key={`${item.symbol}:${item.occurredAt}:${index}`}
                    className="flex items-center justify-between gap-3 rounded-xl border bg-background p-3 text-xs"
                  >
                    <span className="font-bold">
                      {item.symbol} · {item.side === 'long' ? '롱 청산' : item.side === 'short' ? '숏 청산' : '방향 미상'}
                    </span>
                    <span className="text-right text-muted-foreground">
                      {formatNumber(item.price, 'USDT')} · {formatCompact(item.amount)} · {formatDate(item.occurredAt)}
                    </span>
                  </div>
                ))}
              </div>
            </SectionFrame>
          </div>
        )}

        <div className="mt-4 grid min-w-0 gap-4 lg:grid-cols-2">
          <SectionFrame title="뉴스" section={data.sections.news}>
            <FeedList rows={data.sections.news.data} />
          </SectionFrame>
          <SectionFrame title="공시" section={data.sections.disclosures}>
            <FeedList rows={data.sections.disclosures.data} />
          </SectionFrame>
        </div>
      </main>
      <BottomNav />
    </>
  );
}
