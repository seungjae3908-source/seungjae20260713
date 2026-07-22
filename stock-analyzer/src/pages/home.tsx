import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
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

const VIEW_META: Record<MarketView, { tab: string; indexTitle: string }> = {
  KR: { tab: '국내', indexTitle: '국내 지수' },
  US: { tab: '해외', indexTitle: '해외 지수' },
  COIN: { tab: '코인', indexTitle: '코인 지수' },
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
    queryFn: () => apiGet<MarketNewsBriefing>(`/market/news-briefing?market=${view}`),
    refetchInterval: 60_000,
    refetchIntervalInBackground: true,
    staleTime: 0,
  });

  const stockIndices = useMemo(() => {
    const keys = view === 'KR' ? ['kospi', 'kosdaq'] : ['nasdaq', 'sp500'];
    const items = (summary.data?.items ?? []) as SummaryItem[];
    return keys.map((key) => items.find((item) => String(item.key).toLowerCase() === key)).filter((item): item is SummaryItem => Boolean(item));
  }, [summary.data, view]);

  const coinIndices = useMemo(() => {
    const rows = (coinTickers.data?.tickers ?? []) as AnyObj[];
    return ['BTC', 'ETH', 'XRP'].map((symbol) => {
      const row = rows.find((item) => String(item.symbol ?? '').toUpperCase().includes(symbol));
      return { symbol, row };
    });
  }, [coinTickers.data]);

  return (
    <div className="h-full overflow-y-auto overscroll-contain bg-background">
      <header className="border-b border-card-border px-4 py-4">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-2xl font-black">지식정보</h1>
          <time className="shrink-0 text-sm font-black tabular-nums text-muted-foreground">
            {formatClock(now)}
          </time>
        </div>
      </header>

      <main className="space-y-4 px-4 pb-28 pt-4">
        <section>
          <div className="text-center">
            <h2 className="text-xl font-black">오늘의 증시현황</h2>
            <p className="mt-1 text-xs font-bold text-muted-foreground">
              주요 뉴스와 시장 데이터를 함께 확인합니다.
            </p>
          </div>

          <div className="mt-4 grid grid-cols-3 gap-2 rounded-2xl bg-secondary/70 p-1.5">
            {(Object.keys(VIEW_META) as MarketView[]).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setView(item)}
                className={cn(
                  'rounded-xl px-3 py-2.5 text-sm font-black transition',
                  view === item ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground',
                )}
              >
                {VIEW_META[item].tab}
              </button>
            ))}
          </div>
        </section>

        <section className="rounded-3xl border border-card-border bg-card p-4 text-center shadow-sm">
          <div>
            <h3 className="text-base font-black">{VIEW_META[view].indexTitle}</h3>
            <span className="mt-1 block text-[10px] font-bold text-muted-foreground">실시간 제공기관 기준</span>
          </div>

          {view === 'COIN' ? (
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
              {coinIndices.map(({ symbol, row }) => (
                <IndexCard
                  key={symbol}
                  label={symbol}
                  value={finite(row?.price) == null ? '데이터 없음' : formatAppPrice(Number(row?.price), 'KRW')}
                  change={finite(row?.changePercent ?? row?.changePercent24h)}
                />
              ))}
            </div>
          ) : (
            <div className="mt-3 grid grid-cols-2 gap-2">
              {stockIndices.map((item) => (
                <IndexCard
                  key={item.key}
                  label={item.label}
                  value={finite(item.price) == null ? '데이터 없음' : Number(item.price).toLocaleString(undefined, { maximumFractionDigits: 2 })}
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

          {(summary.isLoading || (view === 'COIN' && coinTickers.isLoading)) && <State>지수 데이터를 불러오는 중입니다.</State>}
          {(summary.isError || (view === 'COIN' && coinTickers.isError)) && <State error>지수 제공기관의 응답이 지연되고 있습니다.</State>}
        </section>

        <section className="rounded-3xl border border-card-border bg-card p-4 text-center shadow-sm">
          <div className="flex flex-col items-center gap-2">
            <div>
              <h3 className="text-base font-black">오늘의 이슈</h3>
              <p className="mt-1 text-[11px] font-bold text-muted-foreground">주식시장 주요 뉴스 AI 분석</p>
            </div>
            {briefing.data && <StanceBadge stance={briefing.data.stance} />}
          </div>

          {briefing.isLoading && <State>오늘의 주요 뉴스를 분석하고 있습니다.</State>}
          {briefing.isError && <State error>뉴스 브리핑을 불러오지 못했습니다.</State>}

          {briefing.data && (
            <div className="mt-4 space-y-4">
              <div className="rounded-2xl bg-secondary/60 p-4">
                <p className="text-sm font-black leading-6">{briefing.data.headline}</p>
                <p className="mt-2 whitespace-pre-line text-sm font-semibold leading-6 text-muted-foreground">
                  {briefing.data.summary}
                </p>
              </div>

              {briefing.data.issues.length > 0 && (
                <div className="space-y-2">
                  {briefing.data.issues.slice(0, 5).map((issue, index) => (
                    <a
                      key={`${issue.url}-${index}`}
                      href={issue.url}
                      target="_blank"
                      rel="noreferrer"
                      className="block rounded-2xl border border-card-border px-3 py-3 text-center"
                    >
                      <p className="line-clamp-2 text-sm font-semibold leading-5">
                        {issue.summary}
                      </p>
                      <div className="mt-1 flex items-center justify-center gap-1 text-[10px] font-bold text-muted-foreground">
                        <span>{issue.source}</span>
                        <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                      </div>
                    </a>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>
      </main>

      <BottomNav />
    </div>
  );
}

function IndexCard({ label, value, change }: { label: string; value: string; change: number | null }) {
  return (
    <div className="rounded-2xl bg-secondary/60 p-3 text-center">
      <p className="text-[11px] font-bold text-muted-foreground">{label}</p>
      <p className="mt-1 truncate text-base font-black">{value}</p>
      <p className={cn(
        'mt-1 text-xs font-black',
        change == null ? 'text-muted-foreground' : change >= 0 ? 'text-positive' : 'text-destructive',
      )}>
        {change == null ? '등락 데이터 없음' : formatAppPercent(change)}
      </p>
    </div>
  );
}

function StanceBadge({ stance }: { stance: MarketNewsBriefing['stance'] }) {
  return (
    <span className={cn(
      'shrink-0 rounded-full px-3 py-1.5 text-xs font-black',
      stance === '강세'
        ? 'bg-positive/10 text-positive'
        : stance === '약세'
          ? 'bg-destructive/10 text-destructive'
          : 'bg-secondary text-muted-foreground',
    )}>
      뉴스 분석 · {stance}
    </span>
  );
}

function State({ children, error }: { children: React.ReactNode; error?: boolean }) {
  return (
    <p className={cn(
      'mt-3 rounded-2xl bg-secondary p-4 text-center text-xs font-bold text-muted-foreground',
      error && 'bg-destructive/10 text-destructive',
    )}>
      {children}
    </p>
  );
}
