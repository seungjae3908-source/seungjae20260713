import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BarChart3,
  Clock3,
  ExternalLink,
  Flame,
  Newspaper,
  Sparkles,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { BottomNav } from '@/components/bottom-nav';
import { useAssetMode } from '@/lib/asset-mode';
import { api, apiGet, type SummaryItem } from '@/lib/api';
import { formatAppPercent, formatAppPrice } from '@/lib/stock-display';
import { cn } from '@/lib/utils';

type MarketView = 'KR' | 'US' | 'COIN';
type AnyObj = Record<string, any>;

interface NewsIssue {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  summary: string;
}

interface MarketNewsBriefing {
  market: MarketView;
  asOf: string;
  stance: '강세' | '중립' | '약세';
  headline: string;
  summary: string;
  reasons: string[];
  issues: NewsIssue[];
  aiUsed: boolean;
}

function formatClock(now: Date) {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(now);
}

function finite(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

const VIEW_META: Record<
  MarketView,
  { tab: string; indexTitle: string; description: string }
> = {
  KR: {
    tab: '국내',
    indexTitle: '국내 주요 지수',
    description: '코스피와 코스닥 흐름',
  },
  US: {
    tab: '해외',
    indexTitle: '해외 주요 지수',
    description: '나스닥과 S&P500 흐름',
  },
  COIN: {
    tab: '코인',
    indexTitle: '코인 주요 시세',
    description: '비트코인·이더리움·리플 흐름',
  },
};

export default function HomePage() {
  const mode = useAssetMode();
  const [now, setNow] = useState(() => new Date());
  const [view, setView] = useState<MarketView>(() => {
    if (mode.asset === 'coin') return 'COIN';
    return mode.stockMarket === 'US' ? 'US' : 'KR';
  });

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (view === 'COIN') {
      mode.setAsset('coin');
      mode.setCoinMarket('spot');
      return;
    }
    mode.setAsset('stock');
    mode.setStockMarket(view);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  const summary = useQuery({
    queryKey: ['home-market-summary'],
    queryFn: () => api.summary(),
    refetchInterval: 10_000,
    refetchIntervalInBackground: true,
  });

  const coinTickers = useQuery({
    queryKey: ['home-coin-index'],
    queryFn: () => apiGet<AnyObj>('/crypto/spot/tickers'),
    enabled: view === 'COIN',
    refetchInterval: 10_000,
    refetchIntervalInBackground: true,
  });

  const briefing = useQuery({
    queryKey: ['home-market-news-briefing', view],
    queryFn: () =>
      apiGet<MarketNewsBriefing>(`/market/news-briefing?market=${view}`),
    refetchInterval: 60_000,
    refetchIntervalInBackground: true,
    staleTime: 0,
  });

  const stockIndices = useMemo(() => {
    const keys = view === 'KR' ? ['kospi', 'kosdaq'] : ['nasdaq', 'sp500'];
    const items = (summary.data?.items ?? []) as SummaryItem[];
    return keys
      .map((key) =>
        items.find((item) => String(item.key).toLowerCase() === key),
      )
      .filter((item): item is SummaryItem => Boolean(item));
  }, [summary.data, view]);

  const coinIndices = useMemo(() => {
    const rows = (coinTickers.data?.tickers ?? []) as AnyObj[];
    return ['BTC', 'ETH', 'XRP'].map((symbol) => {
      const row = rows.find((item) =>
        String(item.symbol ?? '').toUpperCase().includes(symbol),
      );
      return { symbol, row };
    });
  }, [coinTickers.data]);

  const issueCount = briefing.data?.issues.length ?? 0;
  const positiveIndices =
    view === 'COIN'
      ? coinIndices.filter(({ row }) => Number(row?.changePercent ?? 0) >= 0).length
      : stockIndices.filter((item) => Number(item.changePercent ?? 0) >= 0).length;

  return (
    <div className="h-full overflow-y-auto overscroll-contain bg-background text-center">
      <header className="border-b border-card-border bg-background/90 px-4 py-4 backdrop-blur-xl">
        <div className="mx-auto flex max-w-md items-center justify-between gap-4">
          <div className="text-left">
            <p className="text-[10px] font-black text-primary">MARKET DASHBOARD</p>
            <h1 className="mt-0.5 text-2xl font-black">지식정보</h1>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-card-border bg-card px-3 py-2">
            <Clock3 className="h-4 w-4 text-primary" />
            <time className="text-xs font-black tabular-nums text-muted-foreground">
              {formatClock(now)}
            </time>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-md space-y-4 px-4 pb-28 pt-4">
        <section className="overflow-hidden rounded-3xl border border-card-border bg-card shadow-sm">
          <div className="bg-gradient-to-br from-primary/15 via-primary/5 to-transparent p-5">
            <div className="flex items-start justify-between gap-3 text-left">
              <div>
                <p className="text-[10px] font-black text-primary">오늘의 시장</p>
                <h2 className="mt-1 text-xl font-black">오늘의 증시현황</h2>
                <p className="mt-1 text-xs font-bold text-muted-foreground">
                  주요 지수와 오늘의 이슈를 한눈에 확인합니다.
                </p>
              </div>
              <BarChart3 className="h-7 w-7 shrink-0 text-primary" />
            </div>

            <div className="mt-4 grid grid-cols-3 gap-2 rounded-2xl bg-background/80 p-1.5">
              {(Object.keys(VIEW_META) as MarketView[]).map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setView(item)}
                  className={cn(
                    'rounded-xl px-3 py-2.5 text-sm font-black transition',
                    view === item
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : 'text-muted-foreground',
                  )}
                >
                  {VIEW_META[item].tab}
                </button>
              ))}
            </div>

            <div className="mt-4 grid grid-cols-3 gap-2 text-center">
              <SummaryChip label="선택 시장" value={VIEW_META[view].tab} />
              <SummaryChip label="상승 지수" value={`${positiveIndices}개`} />
              <SummaryChip label="주요 이슈" value={`${issueCount}건`} />
            </div>
          </div>
        </section>

        <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3 text-left">
            <div>
              <p className="text-[10px] font-black text-primary">LIVE INDEX</p>
              <h3 className="mt-1 text-base font-black">
                {VIEW_META[view].indexTitle}
              </h3>
              <p className="mt-1 text-[10px] font-bold text-muted-foreground">
                {VIEW_META[view].description}
              </p>
            </div>
            <span className="rounded-full bg-secondary px-3 py-1.5 text-[9px] font-black text-muted-foreground">
              10초 갱신
            </span>
          </div>

          {view === 'COIN' ? (
            <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
              {coinIndices.map(({ symbol, row }) => (
                <IndexCard
                  key={symbol}
                  label={symbol}
                  value={
                    finite(row?.price) == null
                      ? '데이터 없음'
                      : formatAppPrice(Number(row?.price), 'KRW')
                  }
                  change={finite(row?.changePercent ?? row?.changePercent24h)}
                />
              ))}
            </div>
          ) : (
            <div className="mt-4 grid grid-cols-2 gap-2">
              {stockIndices.map((item) => (
                <IndexCard
                  key={item.key}
                  label={item.label}
                  value={
                    finite(item.price) == null
                      ? '데이터 없음'
                      : Number(item.price).toLocaleString(undefined, {
                          maximumFractionDigits: 2,
                        })
                  }
                  change={finite(item.changePercent)}
                />
              ))}
              {!summary.isLoading && stockIndices.length === 0 && (
                <div className="col-span-2">
                  <State>현재 표시할 지수 데이터가 없습니다.</State>
                </div>
              )}
            </div>
          )}

          {(summary.isLoading || (view === 'COIN' && coinTickers.isLoading)) && (
            <State>지수 데이터를 불러오는 중입니다.</State>
          )}
          {(summary.isError || (view === 'COIN' && coinTickers.isError)) && (
            <State error>지수 제공기관의 응답이 지연되고 있습니다.</State>
          )}
        </section>

        <section className="overflow-hidden rounded-3xl border border-card-border bg-card shadow-sm">
          <div className="bg-gradient-to-br from-orange-500/15 via-background to-background p-4">
            <div className="flex items-start justify-between gap-3 text-left">
              <div>
                <div className="flex items-center gap-2">
                  <Flame className="h-5 w-5 text-orange-500" />
                  <h3 className="text-base font-black">오늘의 이슈</h3>
                </div>
                <p className="mt-1 text-[10px] font-bold text-muted-foreground">
                  뉴스와 시장 흐름을 묶어 핵심만 보여줍니다.
                </p>
              </div>
              {briefing.data && <StanceBadge stance={briefing.data.stance} />}
            </div>

            {briefing.isLoading && (
              <State>오늘의 주요 뉴스를 분석하고 있습니다.</State>
            )}
            {briefing.isError && (
              <State error>뉴스 브리핑을 불러오지 못했습니다.</State>
            )}

            {briefing.data && (
              <div className="mt-4 space-y-3">
                <div className="rounded-2xl border border-orange-500/20 bg-background/90 p-4 text-left">
                  <div className="flex items-start gap-2">
                    <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-orange-500" />
                    <div>
                      <p className="text-sm font-black leading-6">
                        {briefing.data.headline}
                      </p>
                      <p className="mt-2 whitespace-pre-line text-xs font-semibold leading-5 text-muted-foreground">
                        {briefing.data.summary}
                      </p>
                    </div>
                  </div>
                </div>

                {briefing.data.reasons.length > 0 && (
                  <div className="grid grid-cols-1 gap-2">
                    {briefing.data.reasons.slice(0, 3).map((reason, index) => (
                      <div
                        key={`${reason}:${index}`}
                        className="rounded-2xl bg-secondary/70 px-3 py-2.5 text-left text-[10px] font-bold leading-4"
                      >
                        {index + 1}. {reason}
                      </div>
                    ))}
                  </div>
                )}

                {briefing.data.issues.length > 0 && (
                  <div className="space-y-2">
                    {briefing.data.issues.slice(0, 5).map((issue, index) => (
                      <a
                        key={`${issue.url}-${index}`}
                        href={issue.url}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-start gap-3 rounded-2xl border border-card-border bg-background px-3 py-3 text-left"
                      >
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10">
                          <Newspaper className="h-4 w-4 text-primary" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="line-clamp-2 text-xs font-black leading-5">
                            {issue.summary}
                          </p>
                          <p className="mt-1 text-[9px] font-bold text-muted-foreground">
                            {issue.source}
                          </p>
                        </div>
                        <ExternalLink className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
                      </a>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      </main>

      <BottomNav />
    </div>
  );
}

function SummaryChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-card-border bg-card/90 p-2">
      <p className="text-[9px] font-bold text-muted-foreground">{label}</p>
      <p className="mt-1 text-xs font-black">{value}</p>
    </div>
  );
}

function IndexCard({
  label,
  value,
  change,
}: {
  label: string;
  value: string;
  change: number | null;
}) {
  const positive = change != null && change >= 0;
  const TrendIcon = positive ? TrendingUp : TrendingDown;

  return (
    <div className="rounded-2xl border border-card-border bg-background p-3 text-left">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-black text-muted-foreground">{label}</p>
        {change != null && (
          <span
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-full',
              positive ? 'bg-positive/10 text-positive' : 'bg-destructive/10 text-destructive',
            )}
          >
            <TrendIcon className="h-3.5 w-3.5" />
          </span>
        )}
      </div>
      <p className="mt-2 truncate text-base font-black">{value}</p>
      <p
        className={cn(
          'mt-1 text-xs font-black',
          change == null
            ? 'text-muted-foreground'
            : positive
              ? 'text-positive'
              : 'text-destructive',
        )}
      >
        {change == null ? '등락 데이터 없음' : formatAppPercent(change)}
      </p>
    </div>
  );
}

function StanceBadge({ stance }: { stance: MarketNewsBriefing['stance'] }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-full px-3 py-1.5 text-xs font-black',
        stance === '강세'
          ? 'bg-positive/10 text-positive'
          : stance === '약세'
            ? 'bg-destructive/10 text-destructive'
            : 'bg-secondary text-muted-foreground',
      )}
    >
      {stance}
    </span>
  );
}

function State({ children, error }: { children: React.ReactNode; error?: boolean }) {
  return (
    <p
      className={cn(
        'mt-3 rounded-2xl bg-secondary p-4 text-center text-xs font-bold text-muted-foreground',
        error && 'bg-destructive/10 text-destructive',
      )}
    >
      {children}
    </p>
  );
}
