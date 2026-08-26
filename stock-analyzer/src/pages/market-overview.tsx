import { useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, RefreshCw } from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { api, type SectorPopularGroup, type SummaryItem } from '@/lib/api';
import { getMarketSummary, validMarketSummaryItems } from '@/lib/market-summary';
import { useAssetMode } from '@/lib/asset-mode';
import { cn } from '@/lib/utils';

type OverviewTab = 'indices' | 'sectors' | 'briefing';

const MOBILE_TABS: Array<{ key: OverviewTab; label: string }> = [
  { key: 'indices', label: '지수' },
  { key: 'sectors', label: '섹터' },
  { key: 'briefing', label: '브리핑' },
];

function finite(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatNumber(value: unknown): string {
  const number = finite(value);
  if (number == null) return '미확인';
  return number.toLocaleString('ko-KR', { maximumFractionDigits: 2 });
}

function formatPercent(value: unknown): string {
  const number = finite(value);
  if (number == null) return '미확인';
  return `${number > 0 ? '+' : ''}${number.toFixed(2)}%`;
}

function averageChange(group: SectorPopularGroup): number | null {
  const values = group.rows
    .map((row) => finite(row.changePercent))
    .filter((value): value is number => value != null);
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function StateMessage({ children, error = false }: { children: React.ReactNode; error?: boolean }) {
  return (
    <div
      className={cn(
        'rounded-2xl border px-3 py-4 text-center text-xs font-bold',
        error
          ? 'border-destructive/20 bg-destructive/5 text-destructive'
          : 'border-card-border bg-muted/40 text-muted-foreground',
      )}
    >
      {children}
    </div>
  );
}

function IndexCard({ item }: { item: SummaryItem }) {
  const change = finite(item.changePercent);
  return (
    <div className="min-w-0 rounded-2xl border border-card-border bg-background/60 p-3">
      <p className="truncate text-[11px] font-extrabold text-muted-foreground">{item.label}</p>
      <p className="mt-1 truncate text-lg font-black tabular-nums">{formatNumber(item.price)}</p>
      <p
        className={cn(
          'mt-1 text-xs font-black tabular-nums',
          change == null
            ? 'text-muted-foreground'
            : change >= 0
              ? 'text-red-500'
              : 'text-blue-500',
        )}
      >
        {formatPercent(change)}
      </p>
    </div>
  );
}

export default function MarketOverviewPage() {
  const [, navigate] = useLocation();
  const mode = useAssetMode();
  const market = mode.stockMarket;
  const [mobileTab, setMobileTab] = useState<OverviewTab>('indices');

  const summary = useQuery({
    queryKey: ['market-overview-summary'],
    queryFn: getMarketSummary,
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  const sectors = useQuery({
    queryKey: ['market-overview-sectors', market],
    queryFn: () => api.sectorPopular(market),
    refetchInterval: 30_000,
  });

  const briefing = useQuery({
    queryKey: ['market-overview-briefing'],
    queryFn: () => api.briefing(),
    refetchInterval: 60_000,
  });

  const indices = useMemo(() => {
    const wanted = market === 'KR' ? ['kospi', 'kosdaq'] : ['nasdaq'];
    return validMarketSummaryItems(summary.data?.items ?? []).filter((item) =>
      wanted.includes(String(item.key).toLowerCase()),
    );
  }, [market, summary.data]);

  const topSectors = useMemo(() => {
    return [...(sectors.data?.sectors ?? [])]
      .map((sector) => ({ sector, change: averageChange(sector) }))
      .sort((a, b) => (b.change ?? Number.NEGATIVE_INFINITY) - (a.change ?? Number.NEGATIVE_INFINITY))
      .slice(0, 6);
  }, [sectors.data]);

  const summaryProviderError = summary.data?.dataState === 'provider_error';
  const summaryPartial = summary.data?.dataState === 'partial';
  const refreshing = summary.isFetching || sectors.isFetching || briefing.isFetching;

  function refresh() {
    void Promise.all([summary.refetch(), sectors.refetch(), briefing.refetch()]);
  }

  function selectMarket(next: 'KR' | 'US') {
    mode.setAsset('stock');
    mode.setStockMarket(next);
    setMobileTab('indices');
  }

  return (
    <div className="h-full min-w-0 overflow-y-auto overscroll-contain bg-background">
      <header className="sticky top-0 z-20 border-b border-card-border bg-background/95 px-3 pb-3 pt-3 backdrop-blur sm:px-4">
        <div className="mx-auto max-w-6xl">
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-xl font-black">시황</h1>
            <button
              type="button"
              onClick={refresh}
              aria-label="시황 새로고침"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-card-border bg-card"
            >
              <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
            </button>
          </div>

          <div className="mt-2 grid grid-cols-2 rounded-2xl bg-muted p-1">
            <button
              type="button"
              onClick={() => selectMarket('KR')}
              className={cn(
                'min-h-10 rounded-xl px-3 text-sm font-black transition',
                market === 'KR' ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground',
              )}
            >
              국내주식
            </button>
            <button
              type="button"
              onClick={() => selectMarket('US')}
              className={cn(
                'min-h-10 rounded-xl px-3 text-sm font-black transition',
                market === 'US' ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground',
              )}
            >
              미국주식
            </button>
          </div>

          <div className="mt-2 grid grid-cols-3 gap-1 lg:hidden" data-testid="market-overview-mobile-tabs">
            {MOBILE_TABS.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setMobileTab(item.key)}
                className={cn(
                  'min-h-10 rounded-xl border px-2 text-xs font-black',
                  mobileTab === item.key
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-card-border bg-card text-muted-foreground',
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-6xl gap-4 px-3 pb-28 pt-3 sm:px-4 lg:grid-cols-3 lg:pt-4">
        <section
          data-testid="market-overview-indices"
          className={cn(
            'min-w-0 rounded-3xl border border-card-border bg-card p-4 shadow-sm',
            mobileTab !== 'indices' && 'hidden lg:block',
          )}
        >
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-black">주요 지수</h2>
            <span className="text-[10px] font-bold text-muted-foreground">{market === 'KR' ? '국내' : '미국'}</span>
          </div>

          {summary.isLoading && <div className="mt-3"><StateMessage>지수 확인 중</StateMessage></div>}
          {summary.isError && <div className="mt-3"><StateMessage error>지수 확인 실패</StateMessage></div>}
          {!summary.isLoading && !summary.isError && summaryProviderError && (
            <div className="mt-3">
              <StateMessage error>
                <div className="space-y-2">
                  <p>지수 제공처 응답 없음</p>
                  <button
                    type="button"
                    onClick={() => void summary.refetch()}
                    className="rounded-xl border border-destructive/30 px-3 py-2 text-xs font-black"
                  >
                    재시도
                  </button>
                </div>
              </StateMessage>
            </div>
          )}
          {!summary.isLoading && !summary.isError && summaryPartial && (
            <div className="mt-3"><StateMessage>일부 지수만 표시</StateMessage></div>
          )}

          {!summary.isLoading && !summary.isError && !summaryProviderError && (
            <div className="mt-3 grid grid-cols-2 gap-2">
              {indices.map((item) => <IndexCard key={item.key} item={item} />)}
              {indices.length === 0 && (
                <div className="col-span-2"><StateMessage>지수 데이터 없음</StateMessage></div>
              )}
            </div>
          )}
        </section>

        <section
          data-testid="market-overview-sectors"
          className={cn(
            'min-w-0 rounded-3xl border border-card-border bg-card p-4 shadow-sm',
            mobileTab !== 'sectors' && 'hidden lg:block',
          )}
        >
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-black">섹터 흐름</h2>
            <button
              type="button"
              onClick={() => navigate('/stocks')}
              className="flex items-center gap-1 text-xs font-black text-primary"
            >
              전체
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>

          {sectors.isLoading && <div className="mt-3"><StateMessage>섹터 확인 중</StateMessage></div>}
          {sectors.isError && <div className="mt-3"><StateMessage error>섹터 확인 실패</StateMessage></div>}

          {!sectors.isLoading && !sectors.isError && (
            <div className="mt-3 space-y-2">
              {topSectors.map(({ sector, change }) => (
                <div key={sector.key} className="min-w-0 rounded-2xl border border-card-border bg-background/60 p-3">
                  <div className="flex min-w-0 items-center justify-between gap-3">
                    <p className="min-w-0 truncate text-sm font-black">{sector.label}</p>
                    <span
                      className={cn(
                        'shrink-0 text-xs font-black tabular-nums',
                        change == null
                          ? 'text-muted-foreground'
                          : change >= 0
                            ? 'text-red-500'
                            : 'text-blue-500',
                      )}
                    >
                      {formatPercent(change)}
                    </span>
                  </div>
                  <div className="mt-2 flex min-w-0 flex-wrap gap-1.5">
                    {sector.rows.slice(0, 3).map((row) => (
                      <button
                        key={`${row.market}:${row.ticker}`}
                        type="button"
                        onClick={() => navigate(`/stock/${encodeURIComponent(row.ticker)}`)}
                        className="max-w-full truncate rounded-full bg-muted px-2.5 py-1 text-[10px] font-extrabold text-muted-foreground active:text-foreground"
                      >
                        {row.name}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {topSectors.length === 0 && <StateMessage>섹터 데이터 없음</StateMessage>}
            </div>
          )}
        </section>

        <section
          data-testid="market-overview-briefing"
          className={cn(
            'min-w-0 rounded-3xl border border-card-border bg-card p-4 shadow-sm',
            mobileTab !== 'briefing' && 'hidden lg:block',
          )}
        >
          <h2 className="text-sm font-black">시장 브리핑</h2>

          {briefing.isLoading && <div className="mt-3"><StateMessage>브리핑 확인 중</StateMessage></div>}
          {briefing.isError && <div className="mt-3"><StateMessage error>브리핑 확인 실패</StateMessage></div>}

          {!briefing.isLoading && !briefing.isError && briefing.data && (
            <div className="mt-3 rounded-2xl border border-card-border bg-background/60 p-3">
              <p className="line-clamp-2 text-sm font-black leading-5">{briefing.data.headline}</p>
              <div className="mt-2 space-y-1.5">
                {briefing.data.lines.slice(0, 5).map((line, index) => (
                  <p key={`${index}:${line}`} className="line-clamp-2 text-xs font-semibold leading-5 text-muted-foreground">
                    {line}
                  </p>
                ))}
              </div>
            </div>
          )}
        </section>
      </main>

      <BottomNav />
    </div>
  );
}
