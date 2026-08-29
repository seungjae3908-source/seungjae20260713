import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { Bell, ChevronRight, ExternalLink } from 'lucide-react';
import { useAlertFeed } from '@/hooks/use-stock-data';
import { BottomNav } from '@/components/bottom-nav';
import { ErrorState, LoadingState } from '@/components/data-state';
import { apiGet, type MarketAlert } from '@/lib/api';
import { authorizedFetch } from '@/lib/auth-fetch';
import { classifyAlert, NOTIFICATION_LABELS } from '@/lib/notifications';
import { cn } from '@/lib/utils';

type MarketTab = 'KR' | 'US';
type ToneTab = 'all' | 'positive' | 'negative';
type SourceTab = 'mine' | 'market';
type NotificationHistoryRow = {
  id: string;
  notification_type: string;
  title: string;
  body: string;
  url: string | null;
  channel: string;
  read_at: string | null;
  created_at: string;
};

const IMPORTANCE: Record<MarketAlert['importance'], { label: string; cls: string }> = {
  high: { label: '높음', cls: 'text-risk border-risk/30 bg-risk/10' },
  medium: { label: '보통', cls: 'text-warning border-warning/30 bg-warning/10' },
  low: { label: '낮음', cls: 'text-muted-foreground border-border bg-secondary' },
};

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso || '—';
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}일 전`;
  return new Date(t).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}

function getAlertMarket(alert: MarketAlert): MarketTab {
  const market = (alert as MarketAlert & { market?: string }).market;
  if (market === 'KR' || market === 'US') return market;
  return /^\d{6}$/.test(alert.ticker) ? 'KR' : 'US';
}

function getFilteredAlerts(
  data: { positive: MarketAlert[]; negative: MarketAlert[] } | undefined,
  market: MarketTab,
  tone: ToneTab,
): MarketAlert[] {
  if (!data) return [];
  const all = tone === 'positive'
    ? data.positive
    : tone === 'negative'
      ? data.negative
      : [...data.positive, ...data.negative];
  return all
    .filter((alert) => getAlertMarket(alert) === market)
    .sort((left, right) => Date.parse(right.time) - Date.parse(left.time));
}

export default function AlertsPage() {
  const [source, setSource] = useState<SourceTab>('mine');
  const [market, setMarket] = useState<MarketTab>('KR');
  const [tone, setTone] = useState<ToneTab>('all');

  const feed = useAlertFeed('ALL', source === 'market');
  const history = useQuery({
    queryKey: ['notification-history'],
    queryFn: () => apiGet<{ notifications: NotificationHistoryRow[] }>('/notifications/history?limit=200'),
    refetchInterval: 30_000,
    retry: false,
  });

  const list = useMemo(() => getFilteredAlerts(feed.data, market, tone), [feed.data, market, tone]);
  const counts = useMemo(() => {
    const krAll = getFilteredAlerts(feed.data, 'KR', 'all').length;
    const usAll = getFilteredAlerts(feed.data, 'US', 'all').length;
    const all = getFilteredAlerts(feed.data, market, 'all').length;
    const positive = getFilteredAlerts(feed.data, market, 'positive').length;
    const negative = getFilteredAlerts(feed.data, market, 'negative').length;
    return { krAll, usAll, all, positive, negative };
  }, [feed.data, market]);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-y-auto overscroll-contain bg-background">
      <header className="sticky top-0 z-20 border-b border-card-border bg-background/95 px-3 pb-2 pt-3 backdrop-blur sm:px-4">
        <div className="mx-auto w-full max-w-6xl">
          <div className="flex items-center gap-2">
            <Bell className="h-5 w-5 text-ai" aria-hidden="true" />
            <h1 className="text-lg font-black sm:text-xl">알림</h1>
          </div>

          <div className="mt-2 grid grid-cols-2 gap-2" data-testid="alert-source-tabs">
            <FilterButton active={source === 'mine'} onClick={() => setSource('mine')}>
              내 알림 <Count n={history.data?.notifications?.length ?? 0} />
            </FilterButton>
            <FilterButton active={source === 'market'} onClick={() => setSource('market')}>
              시장 신호 <Count n={counts.krAll + counts.usAll} />
            </FilterButton>
          </div>

          {source === 'market' && (
            <div className="mt-2 grid grid-cols-5 gap-1" data-testid="alert-market-filters">
              <FilterButton compact active={market === 'KR'} onClick={() => setMarket('KR')}>
                국내 <Count n={counts.krAll} />
              </FilterButton>
              <FilterButton compact active={market === 'US'} onClick={() => setMarket('US')}>
                미국 <Count n={counts.usAll} />
              </FilterButton>
              <FilterButton compact active={tone === 'all'} onClick={() => setTone('all')}>
                전체 <Count n={counts.all} />
              </FilterButton>
              <FilterButton compact active={tone === 'positive'} onClick={() => setTone('positive')} tone="positive">
                호재 <Count n={counts.positive} />
              </FilterButton>
              <FilterButton compact active={tone === 'negative'} onClick={() => setTone('negative')} tone="negative">
                악재 <Count n={counts.negative} />
              </FilterButton>
            </div>
          )}
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-none p-3 pb-20 sm:p-4 sm:pb-20">
        {source === 'mine' ? (
          <NotificationHistoryList query={history} />
        ) : (
          <>
            {feed.isLoading && <LoadingState label="신호 확인 중" />}
            {feed.isError && <ErrorState onRetry={() => { void feed.refetch(); }} />}
            {feed.data && list.length === 0 && (
              <p className="py-12 text-center text-sm font-bold text-muted-foreground">표시할 신호가 없습니다.</p>
            )}
            <div className="grid gap-2 lg:grid-cols-2" data-testid="market-alert-list">
              {list.map((alert) => <AlertItem key={alert.id} alert={alert} />)}
            </div>
          </>
        )}
      </main>

      <BottomNav />
    </div>
  );
}

function NotificationHistoryList({ query }: {
  query: {
    data?: { notifications: NotificationHistoryRow[] };
    isLoading: boolean;
    isError: boolean;
    refetch: () => unknown;
  };
}) {
  if (query.isLoading) return <LoadingState label="알림 확인 중" />;
  if (query.isError) return <ErrorState onRetry={() => { void query.refetch(); }} />;
  const rows = query.data?.notifications ?? [];
  if (!rows.length) return <p className="py-12 text-center text-sm font-bold text-muted-foreground">저장된 알림이 없습니다.</p>;

  const markRead = async (row: NotificationHistoryRow) => {
    if (!row.read_at) {
      await authorizedFetch(`/api/notifications/history/${encodeURIComponent(row.id)}/read`, { method: 'PATCH' });
    }
    if (row.url) window.location.href = row.url;
    else await query.refetch();
  };

  return (
    <div className="grid gap-2 lg:grid-cols-2" data-testid="notification-history-list">
      {rows.map((row) => (
        <button
          key={row.id}
          type="button"
          onClick={() => void markRead(row)}
          className={cn(
            'min-w-0 w-full rounded-2xl border p-3 text-left',
            row.read_at ? 'border-card-border bg-card' : 'border-primary/40 bg-primary/5',
          )}
        >
          <div className="flex min-w-0 items-start gap-3">
            <Bell className={cn('mt-0.5 h-4 w-4 shrink-0', row.read_at ? 'text-muted-foreground' : 'text-primary')} />
            <div className="min-w-0 flex-1">
              <p className="line-clamp-1 break-keep text-sm font-black">{row.title}</p>
              <p className="mt-1 line-clamp-2 break-keep text-xs font-bold leading-5 text-muted-foreground">{row.body || '내용 없음'}</p>
              <p className="mt-1.5 text-[10px] font-bold text-muted-foreground">{relTime(row.created_at)}</p>
            </div>
            {row.url && <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
          </div>
        </button>
      ))}
    </div>
  );
}

function FilterButton({
  active,
  onClick,
  children,
  compact = false,
  tone = 'all',
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  compact?: boolean;
  tone?: ToneTab;
}) {
  const activeClass = tone === 'positive'
    ? 'border-positive bg-positive/10 text-positive'
    : tone === 'negative'
      ? 'border-destructive bg-destructive/10 text-destructive'
      : 'border-ai bg-ai/15 text-ai';

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'min-w-0 items-center justify-center rounded-xl border font-bold transition-colors',
        compact ? 'flex min-h-11 gap-0.5 px-1 text-[11px]' : 'flex min-h-11 gap-1 px-2 text-xs sm:text-sm',
        active ? activeClass : 'border-card-border bg-card text-muted-foreground',
      )}
    >
      {children}
    </button>
  );
}

function Count({ n }: { n: number }) {
  return <span className="shrink-0 rounded-full bg-secondary px-1.5 py-0.5 text-[9px] font-bold text-muted-foreground">{n}</span>;
}

function AlertItem({ alert }: { alert: MarketAlert }) {
  const importance = IMPORTANCE[alert.importance];
  const kindClass = alert.kind === 'positive'
    ? 'text-positive border-positive/30 bg-positive/10'
    : 'text-destructive border-destructive/30 bg-destructive/10';
  const sourceLabel = NOTIFICATION_LABELS[classifyAlert(alert)];

  return (
    <article className="min-w-0 rounded-2xl border border-card-border bg-card p-3 shadow-sm">
      <div className="flex min-w-0 items-start gap-2">
        <Link href={`/stock/${alert.ticker}`} className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-black">{alert.name}</span>
            <span className="shrink-0 text-[10px] font-bold text-muted-foreground">{alert.ticker}</span>
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
            <span className={cn('rounded-full border px-2 py-0.5 text-[10px] font-black', kindClass)}>
              {alert.kind === 'positive' ? '호재' : '악재'}
            </span>
            <span className={cn('rounded-full border px-2 py-0.5 text-[10px] font-bold', importance.cls)}>
              중요 {importance.label}
            </span>
            <span className="max-w-[9rem] truncate rounded-full border border-card-border bg-secondary px-2 py-0.5 text-[10px] font-bold text-muted-foreground">
              {sourceLabel}
            </span>
          </div>
        </Link>
      </div>

      <p className="mt-2 line-clamp-2 break-keep text-sm font-bold leading-5">{alert.title}</p>

      <div className="mt-2 flex min-w-0 items-center gap-2 text-[10px] font-bold text-muted-foreground">
        <span className="shrink-0">{relTime(alert.time)}</span>
        <div className="ml-auto flex shrink-0 items-center gap-3">
          {alert.url ? (
            <a href={alert.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-0.5 text-ai hover:underline">
              원문 <ExternalLink className="h-3 w-3" />
            </a>
          ) : null}
          <Link href={`/stock/${alert.ticker}`} className="flex items-center gap-0.5 hover:text-foreground">
            상세 <ChevronRight className="h-3 w-3" />
          </Link>
        </div>
      </div>
    </article>
  );
}
