import { useEffect, useMemo, useState } from 'react';
import { Bell, BellOff, CheckCircle2, RefreshCw, ShieldX, TimerReset } from 'lucide-react';
import { authorizedFetch } from '@/lib/auth-fetch';
import { cn } from '@/lib/utils';

export type TradeSignalAlertItem = {
  id: string;
  planId: string;
  signalId: string;
  symbol: string;
  market: string;
  exchange: string;
  kind: 'CONDITION_MET' | 'CONDITION_MAINTAINED' | 'CONDITION_RELEASED' | 'SIGNAL_EXPIRED';
  cycle: number;
  title: string;
  message: string;
  eventState: 'WATCHING' | 'READY_FOR_APPROVAL' | 'WEAKENED' | 'INVALIDATED' | 'EXPIRED';
  currentSignalState: 'WATCHING' | 'READY_FOR_APPROVAL' | 'WEAKENED' | 'INVALIDATED' | 'EXPIRED';
  approvalEnabled: boolean;
  approvalReasonCode: string | null;
  approvalExpiresAt: string | null;
  score: number;
  confidence: number;
  reasonCode: string;
  createdAt: string;
};

type AlertResponse = {
  ok?: boolean;
  alerts?: TradeSignalAlertItem[];
  error?: string;
};

const DELIVERED_STORAGE_KEY = 'scanner-signal-alert-delivered-v1';
const RECENT_NOTIFICATION_MS = 15 * 60_000;

function readDelivered() {
  if (typeof window === 'undefined') return new Set<string>();
  try {
    const value = JSON.parse(window.localStorage.getItem(DELIVERED_STORAGE_KEY) ?? '[]');
    return new Set(Array.isArray(value) ? value.map(String).slice(-500) : []);
  } catch {
    return new Set<string>();
  }
}

function writeDelivered(values: Set<string>) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(DELIVERED_STORAGE_KEY, JSON.stringify([...values].slice(-500)));
}

function permissionState() {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported' as const;
  return window.Notification.permission;
}

function stateLabel(value: TradeSignalAlertItem['currentSignalState']) {
  if (value === 'READY_FOR_APPROVAL') return '현재 승인 가능';
  if (value === 'WEAKENED') return '현재 신호 약화';
  if (value === 'INVALIDATED') return '현재 신호 무효';
  if (value === 'EXPIRED') return '현재 신호 만료';
  return '현재 감시 중';
}

function kindIcon(kind: TradeSignalAlertItem['kind']) {
  if (kind === 'CONDITION_MET') return <CheckCircle2 className="h-4 w-4 text-positive" />;
  if (kind === 'CONDITION_MAINTAINED') return <TimerReset className="h-4 w-4 text-primary" />;
  return <ShieldX className="h-4 w-4 text-destructive" />;
}

export function TradeSignalAlerts({ fixture }: { fixture?: TradeSignalAlertItem[] }) {
  const [alerts, setAlerts] = useState<TradeSignalAlertItem[]>(fixture ?? []);
  const [loading, setLoading] = useState(!fixture);
  const [message, setMessage] = useState('');
  const [permission, setPermission] = useState(permissionState);

  async function load(silent = false) {
    if (fixture) return;
    if (!silent) setLoading(true);
    try {
      const response = await authorizedFetch('/api/trade-automation/approval-alerts?limit=50', {
        headers: { 'Cache-Control': 'no-cache' },
      });
      const payload = await response.json().catch(() => ({})) as AlertResponse;
      if (!response.ok || !payload.ok) throw new Error(payload.error ?? '신호 알림을 불러오지 못했습니다.');
      setAlerts(Array.isArray(payload.alerts) ? payload.alerts : []);
      if (!silent) setMessage('');
    } catch (error) {
      if (!silent) setMessage(error instanceof Error ? error.message : '신호 알림을 불러오지 못했습니다.');
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    if (fixture) return;
    const refresh = () => void load(true);
    const interval = window.setInterval(refresh, 10_000);
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [fixture]);

  useEffect(() => {
    if (fixture || permission !== 'granted' || typeof window === 'undefined' || !('Notification' in window)) return;
    const delivered = readDelivered();
    let changed = false;
    for (const alert of [...alerts].reverse()) {
      if (delivered.has(alert.id)) continue;
      const createdAt = Date.parse(alert.createdAt);
      if (!Number.isFinite(createdAt) || Date.now() - createdAt > RECENT_NOTIFICATION_MS) {
        delivered.add(alert.id);
        changed = true;
        continue;
      }
      const notification = new window.Notification(alert.title, {
        body: `${alert.message} · ${stateLabel(alert.currentSignalState)}`,
        tag: alert.id,
        renotify: false,
      });
      notification.onclick = () => {
        window.focus();
        notification.close();
      };
      delivered.add(alert.id);
      changed = true;
    }
    if (changed) writeDelivered(delivered);
  }, [alerts, fixture, permission]);

  const visible = useMemo(() => alerts.slice(0, 6), [alerts]);

  async function enableNotifications() {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      setMessage('이 브라우저는 알림 기능을 지원하지 않습니다.');
      return;
    }
    const next = await window.Notification.requestPermission();
    setPermission(next);
    setMessage(next === 'granted'
      ? '브라우저 알림이 켜졌습니다. 같은 알림 ID는 한 번만 전송됩니다.'
      : '브라우저 알림 권한이 허용되지 않았습니다. 화면 알림은 계속 표시됩니다.');
  }

  return (
    <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm" data-testid="trade-signal-alerts">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <Bell className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <div>
            <h2 className="text-sm font-extrabold">검색 신호 알림</h2>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              최초 충족·유지·해제·만료를 현재 승인 상태와 함께 표시합니다.
            </p>
          </div>
        </div>
        <button type="button" onClick={() => void load()} aria-label="검색 신호 알림 새로고침" className="rounded-xl border border-card-border p-2">
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void enableNotifications()}
          disabled={permission === 'granted' || permission === 'unsupported'}
          className="inline-flex items-center gap-1.5 rounded-full border border-card-border bg-background px-3 py-2 text-[11px] font-extrabold disabled:opacity-50"
        >
          {permission === 'granted' ? <Bell className="h-3.5 w-3.5" /> : <BellOff className="h-3.5 w-3.5" />}
          {permission === 'granted' ? '브라우저 알림 켜짐' : permission === 'unsupported' ? '브라우저 알림 미지원' : '브라우저 알림 켜기'}
        </button>
        <span className="text-[10px] font-bold text-muted-foreground">재진입은 새 주기 ID로 구분</span>
      </div>

      {message ? <p role="status" className="mt-3 rounded-2xl bg-secondary p-3 text-xs font-bold">{message}</p> : null}

      <div className="mt-3 space-y-2">
        {!loading && visible.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-card-border bg-background p-4 text-center text-xs font-bold text-muted-foreground">
            최근 검색 신호 알림이 없습니다.
          </p>
        ) : null}
        {visible.map((alert) => (
          <article key={alert.id} className="rounded-2xl border border-card-border bg-background p-3" data-testid={`signal-alert-${alert.kind.toLowerCase()}`}>
            <div className="flex items-start gap-2">
              <div className="mt-0.5 shrink-0">{kindIcon(alert.kind)}</div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-extrabold">{alert.title}</p>
                  <span className={cn(
                    'rounded-full px-2 py-1 text-[10px] font-extrabold',
                    alert.approvalEnabled ? 'bg-positive/10 text-positive' : 'bg-destructive/10 text-destructive',
                  )}>
                    {stateLabel(alert.currentSignalState)}
                  </span>
                </div>
                <p className="mt-1 break-keep text-[11px] leading-5 text-muted-foreground">{alert.message}</p>
                <p className="mt-1 text-[10px] font-bold text-muted-foreground">
                  주기 {alert.cycle} · {new Date(alert.createdAt).toLocaleString('ko-KR')}
                  {alert.approvalReasonCode ? ` · ${alert.approvalReasonCode}` : ''}
                </p>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
