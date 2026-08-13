import { useMemo } from 'react';
import { useLocation } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, RefreshCw } from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { api, type SectorPopularGroup, type SummaryItem } from '@/lib/api';
import { useAssetMode } from '@/lib/asset-mode';
import { cn } from '@/lib/utils';

function finite(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatNumber(value: unknown): string {
  const number = finite(value);
  if (number == null) return '데이터 없음';
  return number.toLocaleString('ko-KR', { maximumFractionDigits: 2 });
}

function formatPercent(value: unknown): string {
  const number = finite(value);
  if (number == null) return '등락 데이터 없음';
  return `${number > 0 ? '+' : ''}${number.toFixed(2)}%`;
}

function averageChange(group: SectorPopularGroup): number | null {
  const values = group.rows
    .map((row) => finite(row.changePercent))
    .filter((value): value is number => value != null);

  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function activeInterval(milliseconds: number): number | false {
  return typeof document !== 'undefined' && document.hidden ? false : milliseconds;
}

function StateMessage({ children, error = false }: { children: React.ReactNode; error?: boolean }) {
  return (
    <div
      className={cn(
        'rounded-2xl border px-4 py-6 text-center text-sm font-bold',
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
    <div className="rounded-2xl border border-card-border bg-background/60 p-4">
      <p className="text-xs font-extrabold text-muted-foreground">{item.label}</p>
      <p className="mt-2 text-xl font-black">{formatNumber(item.price)}</p>
      <p
        className={cn(
          'mt-1 text-sm font-black',
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

  const summary = useQuery({
    queryKey: ['market-overview-summary'],
    queryFn: () => api.summary(),
    staleTime: 15_000,
    refetchInterval: () => activeInterval(30_000),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: 1,
  });

  const sectors = useQuery({
    queryKey: ['market-overview-sectors', market],
    queryFn: () => api.sectorPopular(market),
    staleTime: 15_000,
    refetchInterval: () => activeInterval(30_000),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: 1,
  });

  const briefing = useQuery({
    queryKey: ['market-overview-briefing'],
    queryFn: () => api.briefing(),
    staleTime: 30_000,
    refetchInterval: () => activeInterval(60_000),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: 1,
  });

  const indices = useMemo(() => {
    const wanted = market === 'KR' ? ['kospi', 'kosdaq'] : ['nasdaq'];
    return (summary.data?.items ?? []).filter((item) =>
      wanted.includes(String(item.key).toLowerCase()),
    );
  }, [market, summary.data]);

  const topSectors = useMemo(() => {
    return [...(sectors.data?.sectors ?? [])]
      .map((sector) => ({ sector, change: averageChange(sector) }))
      .sort((a, b) => (b.change ?? Number.NEGATIVE_INFINITY) - (a.change ?? Number.NEGATIVE_INFINITY))
      .slice(0, 6);
  }, [sectors.data]);

  const refreshing = summary.isFetching || sectors.isFetching || briefing.isFetching;

  function refresh() {
    void Promise.all([summary.refetch(), sectors.refetch(), briefing.refetch()]);
  }

  function selectMarket(next: 'KR' | 'US') {
    mode.setAsset('stock');
    mode.setStockMarket(next);
  }

  return (
    <div className="h-full overflow-y-auto overscroll-contain bg-background">
      <header className="border-b border-card-border px-4 pb-4 pt-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-black">시황</h1>
            <p className="mt-1 text-xs font-bold text-muted-foreground">
              주요 지수와 섹터 흐름을 한눈에 확인합니다.
            </p>
          </div>
          <button
            type="button"
            onClick={refresh}
            aria-label="시황 새로고침"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-card-border bg-card"
          >
            <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
          </button>
        </div>

        <div className="mt-4 grid grid-cols-2 rounded-2xl bg-muted p-1">
          <button
            type="button"
            onClick={() => selectMarket('KR')}
            className={cn(
              'rounded-xl px-3 py-2.5 text-sm font-black transition',
              market === 'KR' ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground',
            )}
          >
            국내주식
          </button>
          <button
            type="button"
            onClick={() => selectMarket('US')}
            className={cn(
              'rounded-xl px-3 py-2.5 text-sm font-black transition',
              market === 'US' ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground',
            )}
          >
            해외주식
          </button>
        </div>
      </header>

      <main className="space-y-4 px-4 pb-28 pt-4">
        <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-black">주요 지수</h2>
            <span className="text-[10px] font-bold text-muted-foreground">
              {market === 'KR' ? '국내 시장' : '미국 시장'}
            </span>
          </div>

          {summary.isLoading && <div className="mt-3"><StateMessage>지수 데이터를 불러오는 중입니다.</StateMessage></div>}
          {summary.isError && <div className="mt-3"><StateMessage error>지수 데이터를 불러오지 못했습니다.</StateMessage></div>}

          {!summary.isLoading && !summary.isError && (
            <div className="mt-3 grid grid-cols-2 gap-2">
              {indices.map((item) => <IndexCard key={item.key} item={item} />)}
              {indices.length === 0 && (
                <div className="col-span-2">
                  <StateMessage>현재 표시할 지수 데이터가 없습니다.</StateMessage>
                </div>
              )}
            </div>
          )}
        </section>

        <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-black">섹터 흐름</h2>
              <p className="mt-1 text-[10px] font-bold text-muted-foreground">
                섹터 내 제공 종목의 평균 등락률 기준
              </p>
            </div>
            <button
              type="button"
              onClick={() => navigate('/stocks')}
              className="flex items-center gap-1 text-xs font-black text-primary"
            >
              전체보기
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>

          {sectors.isLoading && <div className="mt-3"><StateMessage>섹터 데이터를 불러오는 중입니다.</StateMessage></div>}
          {sectors.isError && <div className="mt-3"><StateMessage error>섹터 데이터를 불러오지 못했습니다.</StateMessage></div>}

          {!sectors.isLoading && !sectors.isError && (
            <div className="mt-3 space-y-2">
              {topSectors.map(({ sector, change }) => (
                <div key={sector.key} className="rounded-2xl border border-card-border bg-background/60 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="min-w-0 truncate text-sm font-black">{sector.label}</p>
                    <span
                      className={cn(
                        'shrink-0 text-xs font-black',
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
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {sector.rows.slice(0, 3).map((row) => (
                      <button
                        key={`${row.market}:${row.ticker}`}
                        type="button"
                        onClick={() => navigate(`/stock/${encodeURIComponent(row.ticker)}`)}
                        className="rounded-full bg-muted px-2.5 py-1 text-[10px] font-extrabold text-muted-foreground active:text-foreground"
                      >
                        {row.name}
                      </button>
                    ))}
                  </div>
                </div>
              ))}

              {topSectors.length === 0 && (
                <StateMessage>현재 표시할 섹터 데이터가 없습니다.</StateMessage>
              )}
            </div>
          )}
        </section>

        <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
          <h2 className="text-sm font-black">시장 브리핑</h2>

          {briefing.isLoading && <div className="mt-3"><StateMessage>시장 브리핑을 불러오는 중입니다.</StateMessage></div>}
          {briefing.isError && <div className="mt-3"><StateMessage error>시장 브리핑을 불러오지 못했습니다.</StateMessage></div>}

          {!briefing.isLoading && !briefing.isError && briefing.data && (
            <div className="mt-3 rounded-2xl border border-card-border bg-background/60 p-4">
              <p className="text-base font-black leading-6">{briefing.data.headline}</p>
              <div className="mt-3 space-y-2">
                {briefing.data.lines.slice(0, 5).map((line, index) => (
                  <p key={`${index}:${line}`} className="text-sm font-semibold leading-6 text-muted-foreground">
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
