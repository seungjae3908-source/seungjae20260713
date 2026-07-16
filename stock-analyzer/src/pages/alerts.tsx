import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import {
  Bell,
  ExternalLink,
  ChevronRight,
  TrendingUp,
  TrendingDown,
} from 'lucide-react';
import { useAlertFeed } from '@/hooks/use-stock-data';
import { BottomNav } from '@/components/bottom-nav';
import { LoadingState, ErrorState } from '@/components/data-state';
import { apiGet, type MarketAlert } from '@/lib/api';
import { authorizedFetch } from '@/lib/auth-fetch';
import { classifyAlert, NOTIFICATION_LABELS } from '@/lib/notifications';
import { cn } from '@/lib/utils';

type MarketTab = 'KR' | 'US';
type ToneTab = 'all' | 'positive' | 'negative';
type SourceTab = 'mine' | 'market';
type NotificationHistoryRow = { id: string; notification_type: string; title: string; body: string; url: string | null; channel: string; read_at: string | null; created_at: string };

const IMPORTANCE: Record<
  MarketAlert['importance'],
  { label: string; cls: string; stars: string }
> = {
  high: {
    label: '높음',
    cls: 'text-risk border-risk/30 bg-risk/10',
    stars: '★★★★★',
  },
  medium: {
    label: '보통',
    cls: 'text-warning border-warning/30 bg-warning/10',
    stars: '★★★★☆',
  },
  low: {
    label: '낮음',
    cls: 'text-muted-foreground border-border bg-secondary',
    stars: '★★★☆☆',
  },
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

  return new Date(t).toLocaleDateString('ko-KR', {
    month: 'short',
    day: 'numeric',
  });
}

function getAlertMarket(alert: MarketAlert): MarketTab {
  const market = (alert as MarketAlert & { market?: string }).market;

  if (market === 'KR' || market === 'US') return market;

  // 한국 종목코드는 보통 숫자 6자리
  if (/^\d{6}$/.test(alert.ticker)) return 'KR';

  return 'US';
}

function getFilteredAlerts(
  data: { positive: MarketAlert[]; negative: MarketAlert[] } | undefined,
  market: MarketTab,
  tone: ToneTab,
): MarketAlert[] {
  if (!data) return [];

  const all =
    tone === 'positive'
      ? data.positive
      : tone === 'negative'
        ? data.negative
        : [...data.positive, ...data.negative];

  return all
    .filter((a) => getAlertMarket(a) === market)
    .sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
}

export default function AlertsPage() {
  const [source, setSource] = useState<SourceTab>('mine');
  const [market, setMarket] = useState<MarketTab>('KR');
  const [tone, setTone] = useState<ToneTab>('all');

  const feed = useAlertFeed('ALL');
  const history = useQuery({
    queryKey: ['notification-history'],
    queryFn: () => apiGet<{ notifications: NotificationHistoryRow[] }>('/notifications/history?limit=200'),
    refetchInterval: 30_000,
    retry: false,
  });

  const list = useMemo(
    () => getFilteredAlerts(feed.data, market, tone),
    [feed.data, market, tone],
  );

  const counts = useMemo(() => {
    const krAll = getFilteredAlerts(feed.data, 'KR', 'all').length;
    const usAll = getFilteredAlerts(feed.data, 'US', 'all').length;
    const all = getFilteredAlerts(feed.data, market, 'all').length;
    const positive = getFilteredAlerts(feed.data, market, 'positive').length;
    const negative = getFilteredAlerts(feed.data, market, 'negative').length;

    return { krAll, usAll, all, positive, negative };
  }, [feed.data, market]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain bg-background">
      <header className="relative z-20 border-b border-card-border bg-background/90 px-4 pb-0 pt-4 backdrop-blur">
        <div className="mb-3 flex items-center gap-2">
          <Bell className="h-5 w-5 text-ai" />
          <h1 className="text-xl font-bold">알림</h1>
          <span className="ml-auto text-[11px] text-muted-foreground">
            전체 종목 신호
          </span>
        </div>

        <div className="mb-2 grid grid-cols-2 gap-2">
          <MarketButton active={source === 'mine'} onClick={() => setSource('mine')}>내 알림 <Count n={history.data?.notifications?.length ?? 0} /></MarketButton>
          <MarketButton active={source === 'market'} onClick={() => setSource('market')}>시장 신호 <Count n={counts.krAll + counts.usAll} /></MarketButton>
        </div>

        {source === 'market' && (<>
        <div className="mb-2 grid grid-cols-2 gap-2">
          <MarketButton
            active={market === 'KR'}
            onClick={() => setMarket('KR')}
          >
            🇰🇷 국장 <Count n={counts.krAll} />
          </MarketButton>

          <MarketButton
            active={market === 'US'}
            onClick={() => setMarket('US')}
          >
            🇺🇸 미장 <Count n={counts.usAll} />
          </MarketButton>
        </div>

        <div className="flex">
          <ToneButton active={tone === 'all'} onClick={() => setTone('all')}>
            전체 <Count n={counts.all} />
          </ToneButton>

          <ToneButton
            active={tone === 'positive'}
            onClick={() => setTone('positive')}
            tone="positive"
          >
            <TrendingUp className="h-4 w-4" />
            호재 <Count n={counts.positive} />
          </ToneButton>

          <ToneButton
            active={tone === 'negative'}
            onClick={() => setTone('negative')}
            tone="negative"
          >
            <TrendingDown className="h-4 w-4" />
            악재 <Count n={counts.negative} />
          </ToneButton>
        </div>
        </>)}
      </header>

      <main className="flex-none p-3 pb-20">
        {source === 'mine' ? (
          <NotificationHistoryList query={history} />
        ) : (<>
        {feed.isLoading && <LoadingState label="시장 신호 수집 중..." />}

        {feed.isError && <ErrorState onRetry={() => feed.refetch()} />}

        {feed.data && list.length === 0 && (
          <p className="py-16 text-center text-sm text-muted-foreground">
            현재 {market === 'KR' ? '국장' : '미장'}{' '}
            {tone === 'positive'
              ? '호재'
              : tone === 'negative'
                ? '악재'
                : '전체'}{' '}
            신호가 없습니다.
          </p>
        )}

        <div className="space-y-2">
          {list.map((alert) => (
            <AlertItem key={alert.id} alert={alert} />
          ))}
        </div>
        </>)}
      </main>

      <BottomNav />
    </div>
  );
}

function NotificationHistoryList({ query }: { query: { data?: { notifications: NotificationHistoryRow[] }; isLoading: boolean; isError: boolean; refetch: () => unknown } }) {
  if (query.isLoading) return <LoadingState label="내 알림 이력을 불러오는 중입니다." />;
  if (query.isError) return <ErrorState onRetry={() => query.refetch()} />;
  const rows = query.data?.notifications ?? [];
  if (!rows.length) return <p className="py-16 text-center text-sm font-bold text-muted-foreground">아직 저장된 내 알림이 없습니다.</p>;
  const markRead = async (row: NotificationHistoryRow) => {
    if (!row.read_at) await authorizedFetch(`/api/notifications/history/${encodeURIComponent(row.id)}/read`, { method: 'PATCH' });
    if (row.url) window.location.href = row.url;
    else await query.refetch();
  };
  return <div className="space-y-2">{rows.map((row) => <button key={row.id} type="button" onClick={() => void markRead(row)} className={cn('w-full rounded-2xl border p-3 text-left', row.read_at ? 'border-card-border bg-card' : 'border-primary/40 bg-primary/5')}><div className="flex items-start gap-3"><Bell className={cn('mt-0.5 h-4 w-4 shrink-0', row.read_at ? 'text-muted-foreground' : 'text-primary')} /><div className="min-w-0 flex-1"><p className="break-keep text-sm font-black">{row.title}</p><p className="mt-1 break-keep text-xs font-bold leading-relaxed text-muted-foreground">{row.body || '내용 없음'}</p><p className="mt-2 text-[10px] font-bold text-muted-foreground">{row.notification_type} · {row.channel} · {relTime(row.created_at)}</p></div>{row.url && <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}</div></button>)}</div>;
}

function MarketButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center justify-center gap-1 rounded-xl border px-3 py-2 text-sm font-bold transition-colors',
        active
          ? 'border-ai bg-ai/15 text-ai'
          : 'border-card-border bg-card text-muted-foreground',
      )}
    >
      {children}
    </button>
  );
}

function ToneButton({
  active,
  onClick,
  tone = 'all',
  children,
}: {
  active: boolean;
  onClick: () => void;
  tone?: ToneTab;
  children: ReactNode;
}) {
  const activeCls =
    tone === 'positive'
      ? 'border-positive text-positive'
      : tone === 'negative'
        ? 'border-destructive text-destructive'
        : 'border-ai text-ai';

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex flex-1 items-center justify-center gap-1.5 border-b-2 py-2.5 text-sm font-semibold transition-colors',
        active ? activeCls : 'border-transparent text-muted-foreground',
      )}
    >
      {children}
    </button>
  );
}

function Count({ n }: { n: number }) {
  return (
    <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
      {n}
    </span>
  );
}

function AlertItem({ alert }: { alert: MarketAlert }) {
  const imp = IMPORTANCE[alert.importance];

  const kindCls =
    alert.kind === 'positive'
      ? 'text-positive border-positive/30 bg-positive/10'
      : 'text-destructive border-destructive/30 bg-destructive/10';

  const sourceLabel = NOTIFICATION_LABELS[classifyAlert(alert)];

  return (
    <article className="rounded-2xl border border-card-border bg-card p-3.5 shadow-sm">
      <div className="flex items-start gap-2">
        <Link href={`/stock/${alert.ticker}`} className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-bold">{alert.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {alert.ticker}
            </span>
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span
              className={cn(
                'rounded-full border px-2 py-0.5 text-[11px] font-semibold',
                kindCls,
              )}
            >
              {alert.kind === 'positive' ? '🟢 호재' : '🔴 악재'}
            </span>

            <span
              className={cn(
                'rounded-full border px-2 py-0.5 text-[11px] font-medium',
                imp.cls,
              )}
            >
              중요도 {imp.label}
            </span>

            <span className="rounded-full border border-card-border bg-secondary px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              {sourceLabel}
            </span>
          </div>
        </Link>

        <span className="shrink-0 text-xs font-semibold text-warning">
          {imp.stars}
        </span>
      </div>

      <p className="mt-3 text-sm font-medium leading-snug">{alert.title}</p>

      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
        {alert.kind === 'positive'
          ? 'AI 분석: 투자심리와 단기 수급에 긍정적으로 작용할 수 있는 신호입니다.'
          : 'AI 분석: 변동성 확대 또는 투자심리 위축 요인으로 볼 수 있어 주의가 필요합니다.'}
      </p>

      <div className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
        <span>{relTime(alert.time)}</span>

        <div className="ml-auto flex items-center gap-3">
          {alert.url ? (
            <a
              href={alert.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-0.5 text-ai hover:underline"
            >
              원문 <ExternalLink className="h-3 w-3" />
            </a>
          ) : null}

          <Link
            href={`/stock/${alert.ticker}`}
            className="flex items-center gap-0.5 hover:text-foreground"
          >
            상세 <ChevronRight className="h-3 w-3" />
          </Link>
        </div>
      </div>
    </article>
  );
}
