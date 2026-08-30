import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { Bell, ChevronRight, ExternalLink } from 'lucide-react';
import { useAlertFeed } from '@/hooks/use-stock-data';
import { BottomNav } from '@/components/bottom-nav';
import { ErrorState, LoadingState } from '@/components/data-state';
import { type MarketAlert } from '@/lib/api';
import { authorizedFetch } from '@/lib/auth-fetch';
import { useAuth } from '@/lib/auth';
import { alertRelativeTime, parseAlertFeed, parseNotificationHistory, parseNotificationRead, type EvidencedAlert, type EvidencedAlertFeed, type NotificationHistoryRow } from '@/lib/alert-evidence';
import { classifyAlert, NOTIFICATION_LABELS } from '@/lib/notifications';
import { cn } from '@/lib/utils';

type MarketTab = 'KR' | 'US';
type ToneTab = 'all' | 'positive' | 'negative';
type SourceTab = 'mine' | 'market';

const IMPORTANCE: Record<MarketAlert['importance'], { label: string; cls: string }> = {
  high: { label: '높음', cls: 'text-risk border-risk/30 bg-risk/10' },
  medium: { label: '보통', cls: 'text-warning border-warning/30 bg-warning/10' },
  low: { label: '낮음', cls: 'text-muted-foreground border-border bg-secondary' },
};

function getFilteredAlerts(
  data: EvidencedAlertFeed | undefined,
  market: MarketTab,
  tone: ToneTab,
): EvidencedAlert[] {
  if (!data) return [];
  const all = tone === 'positive'
    ? data.positive
    : tone === 'negative'
      ? data.negative
      : [...data.positive, ...data.negative];
  return all
    .filter((alert) => alert.market === market)
    .sort((left, right) => Date.parse(right.time) - Date.parse(left.time));
}

export default function AlertsPage() {
  const auth = useAuth();
  return <MemberAlertsPage key={`${auth.user?.id ?? 'anonymous'}:${auth.can('canAccessBasicInfo')}`} />;
}

function MemberAlertsPage() {
  const auth = useAuth();
  const allowed = Boolean(auth.user && auth.can('canAccessBasicInfo'));
  const [source, setSource] = useState<SourceTab>('mine');
  const [market, setMarket] = useState<MarketTab>('KR');
  const [tone, setTone] = useState<ToneTab>('all');

  const [now, setNow] = useState(Date.now);
  const clock = Math.max(now, Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const feed = useAlertFeed('ALL', allowed && source === 'market');
  const history = useQuery({
    queryKey: ['notification-history', auth.user?.id],
    enabled: allowed && source === 'mine',
    queryFn: async ({ signal }) => {
      const response = await authorizedFetch('/api/notifications/history?limit=200', { signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`NOTIFICATION_HISTORY_HTTP_${response.status}`);
      return parseNotificationHistory(await response.json());
    },
    refetchInterval: 30_000,
    retry: false,
  });

  let validFeed: EvidencedAlertFeed | undefined;
  let feedInvalid = false;
  if (allowed && !feed.isError && feed.data) {
    try { validFeed = parseAlertFeed(feed.data, clock); } catch { feedInvalid = true; }
  }
  const list = getFilteredAlerts(validFeed, market, tone);
  const counts = (() => {
    const krAll = validFeed ? getFilteredAlerts(validFeed, 'KR', 'all').length : null;
    const usAll = validFeed ? getFilteredAlerts(validFeed, 'US', 'all').length : null;
    const all = validFeed ? getFilteredAlerts(validFeed, market, 'all').length : null;
    const positive = validFeed ? getFilteredAlerts(validFeed, market, 'positive').length : null;
    const negative = validFeed ? getFilteredAlerts(validFeed, market, 'negative').length : null;
    return { krAll, usAll, all, positive, negative };
  })();

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
              내 알림 <Count n={allowed && !history.isError ? history.data?.count ?? null : null} />
            </FilterButton>
            <FilterButton active={source === 'market'} onClick={() => setSource('market')}>
              시장 신호 <Count n={counts.krAll !== null && counts.usAll !== null ? counts.krAll + counts.usAll : null} />
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
        {!allowed ? <p role="status" className="py-12 text-center text-sm">{auth.loading ? '알림 접근 권한 확인 중' : auth.user ? '알림 조회 권한이 없습니다.' : '로그인 후 내 알림을 확인할 수 있습니다.'}</p> : source === 'mine' ? (
          <NotificationHistoryList query={history} now={clock} />
        ) : (
          <>
            {feed.isLoading && <LoadingState label="신호 확인 중" />}
            {validFeed && <p className="mb-3 text-xs text-muted-foreground">수신한 신호만 표시합니다. 전체 시장의 신호 수가 아니며 현재 가격·조건을 보장하지 않습니다.</p>}
            {(feed.isError || feedInvalid) && <ErrorState message="신호 근거를 확인하지 못했습니다. 이전 결과를 표시하지 않습니다." onRetry={() => { void feed.refetch(); }} />}
            {validFeed && list.length === 0 && (
              <p className="py-12 text-center text-sm font-bold text-muted-foreground">표시할 신호가 없습니다.</p>
            )}
            <div className="grid gap-2 lg:grid-cols-2" data-testid="market-alert-list">
              {list.map((alert) => <AlertItem key={alert.id} alert={alert} now={clock} />)}
            </div>
          </>
        )}
      </main>

      <BottomNav />
    </div>
  );
}

function NotificationHistoryList({ query, now }: {
  now: number;
  query: {
    data?: { notifications: NotificationHistoryRow[] };
    isLoading: boolean;
    isError: boolean;
    refetch: () => unknown;
  };
}) {
  const lock = useRef(false);
  const active = useRef(true);
  const request = useRef<AbortController | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; request.current?.abort(); };
  }, []);
  if (query.isLoading) return <LoadingState label="알림 확인 중" />;
  if (query.isError) return <ErrorState onRetry={() => { void query.refetch(); }} />;
  if (!query.data) return <p role="status">알림 이력 미확인</p>;
  const rows = query.data.notifications;
  if (!rows.length) return <p className="py-12 text-center text-sm font-bold text-muted-foreground">저장된 알림이 없습니다.</p>;

  const markRead = async (row: NotificationHistoryRow) => {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setError(null);
    request.current = new AbortController();
    try {
      if (!row.read_at) {
        const response = await authorizedFetch(`/api/notifications/history/${encodeURIComponent(row.id)}/read`, {
          method: 'PATCH', signal: request.current.signal, cache: 'no-store',
        });
        if (!response.ok) throw new Error('NOTIFICATION_READ_FAILED');
        parseNotificationRead(await response.json(), row.id);
      }
      if (!active.current) return;
      if (row.url) window.location.assign(row.url);
      else await query.refetch();
    } catch {
      if (active.current) setError('읽음 처리를 확인하지 못했습니다. 이동하지 않았습니다. 다시 시도해 주세요.');
    } finally {
      lock.current = false;
      if (active.current) setPending(false);
    }
  };

  return (
    <div className="grid gap-2 lg:grid-cols-2" data-testid="notification-history-list">
      {error && <p role="alert" className="text-sm text-destructive lg:col-span-2">{error}</p>}
      {rows.map((row) => (
        <button
          key={row.id}
          type="button"
          onClick={() => void markRead(row)}
          disabled={pending}
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
              <p className="mt-1.5 text-[10px] font-bold text-muted-foreground">알림 발생: {alertRelativeTime(row.created_at, now)}</p>
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
      <span className="inline-flex w-full items-center justify-center gap-1 whitespace-nowrap">{children}</span>
    </button>
  );
}

function Count({ n }: { n: number | null }) {
  return <span className="shrink-0 rounded-full bg-secondary px-1.5 py-0.5 text-[9px] font-bold text-muted-foreground">{n ?? '미확인'}</span>;
}

function AlertItem({ alert, now }: { alert: EvidencedAlert; now: number }) {
  const importance = IMPORTANCE[alert.importance];
  const kindClass = alert.kind === 'positive'
    ? 'text-positive border-positive/30 bg-positive/10'
    : 'text-destructive border-destructive/30 bg-destructive/10';
  const sourceLabel = alert.category === '시세 변동' ? '시세 변동' : NOTIFICATION_LABELS[classifyAlert(alert)];
  const archived = now - Date.parse(alert.time) > 300_000;

  return (
    <article className="min-w-0 rounded-2xl border border-card-border bg-card p-3 shadow-sm">
      <div className="flex min-w-0 items-start gap-2">
        <Link href={`/stock/${encodeURIComponent(alert.ticker)}`} className="min-w-0 flex-1">
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
      <p className="mt-1 text-[10px] text-muted-foreground">{archived ? 'ARCHIVED · 과거 신호' : alert.source ? 'FRESH · 원본 시각 기준' : 'UNKNOWN · 출처 미확인'} · 현재 조건 재검증 필요 · 주문 권한 없음</p>
      <p className="mt-1 break-all text-[10px] text-muted-foreground">출처: {alert.source ?? '미확인'} · 원본 시각: {alert.time}</p>

      <div className="mt-2 flex min-w-0 items-center gap-2 text-[10px] font-bold text-muted-foreground">
        <span className="shrink-0">{alertRelativeTime(alert.time, now)}</span>
        <div className="ml-auto flex shrink-0 items-center gap-3">
          {alert.url ? (
            <a href={alert.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-0.5 text-ai hover:underline">
              원문 <ExternalLink className="h-3 w-3" />
            </a>
          ) : null}
          <Link href={`/stock/${encodeURIComponent(alert.ticker)}`} className="flex items-center gap-0.5 hover:text-foreground">
            상세 <ChevronRight className="h-3 w-3" />
          </Link>
        </div>
      </div>
    </article>
  );
}
