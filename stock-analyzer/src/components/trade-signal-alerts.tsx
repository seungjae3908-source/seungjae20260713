import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bell, BellOff, CheckCircle2, RefreshCw, ShieldX, TimerReset, WifiOff } from 'lucide-react';
import { authorizedFetch } from '@/lib/auth-fetch';
import { CardListSkeleton } from '@/components/data-state';
import { approvalMessage, safeTradeErrorMessage } from '@/lib/trade-approval-ui';
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
  updatedAt?: string;
  error?: string;
};

const DELIVERED_STORAGE_KEY = 'scanner-signal-alert-delivered-v1';
const RECENT_NOTIFICATION_MS = 15 * 60_000;
const INTERNAL_CODE_PATTERN = /\b[A-Z][A-Z0-9_]{3,}\b/;

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

function userAlertMessage(alert: TradeSignalAlertItem) {
  if (!INTERNAL_CODE_PATTERN.test(alert.message)) return alert.message;
  return approvalMessage(alert.approvalReasonCode ?? alert.reasonCode);
}

function timeText(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return '-';
  return new Date(value).toLocaleString('ko-KR', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

export function TradeSignalAlerts({ fixture }: { fixture?: TradeSignalAlertItem[] }) {
  const [alerts, setAlerts] = useState<TradeSignalAlertItem[]>(fixture ?? []);
  const [loading, setLoading] = useState(!fixture);
  const [message, setMessage] = useState('');
  const [permission, setPermission] = useState(permissionState);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(() => fixture?.[0]?.createdAt ?? null);
  const [stale, setStale] = useState(false);
  const [offline, setOffline] = useState(() => typeof navigator !== 'undefined' && !navigator.onLine);
  const requestSequenceRef = useRef(0);

  const load = useCallback(async (silent = false) => {
    if (fixture) return;
    const sequence = ++requestSequenceRef.current;
    if (!silent) setLoading(true);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await authorizedFetch('/api/trade-automation/approval-alerts?limit=50', {
        headers: { 'Cache-Control': 'no-cache' },
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({})) as AlertResponse;
      if (!response.ok || !payload.ok) throw new Error(payload.error ?? 'SIGNAL_ALERT_LOAD_FAILED');
      if (sequence !== requestSequenceRef.current) return;
      setAlerts(Array.isArray(payload.alerts) ? payload.alerts : []);
      setLastUpdatedAt(payload.updatedAt ?? new Date().toISOString());
      setStale(false);
      setOffline(false);
      if (!silent) setMessage('');
    } catch (error) {
      if (sequence !== requestSequenceRef.current) return;
      const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
      setOffline(isOffline);
      setStale(true);
      if (!silent) {
        setMessage(isOffline
          ? '오프라인 상태입니다. 마지막 신호 알림을 표시합니다.'
          : error instanceof Error && error.name === 'AbortError'
            ? '신호 알림 갱신 시간이 초과됐습니다.'
            : safeTradeErrorMessage(error instanceof Error ? error.message : null, '신호 알림을 불러오지 못했습니다.'));
      }
    } finally {
      window.clearTimeout(timeout);
      if (sequence === requestSequenceRef.current && !silent) setLoading(false);
    }
  }, [fixture]);

  useEffect(() => {
    void load();
    if (fixture) return;
    const refresh = () => void load(true);
    const interval = window.setInterval(refresh, 10_000);
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    const onOffline = () => {
      setOffline(true);
      setStale(true);
    };
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [fixture, load]);

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
        body: `${userAlertMessage(alert)} · ${stateLabel(alert.currentSignalState)}`,
        tag: alert.id,
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
      ? '브라우저 알림이 켜졌습니다. 같은 알림은 한 번만 전송됩니다.'
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
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          aria-label="검색 신호 알림 새로고침"
          className="flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-card-border disabled:opacity-40"
        >
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void enableNotifications()}
          disabled={permission === 'granted' || permission === 'unsupported'}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-card-border bg-background px-3 text-[11px] font-extrabold disabled:opacity-50"
        >
          {permission === 'granted' ? <Bell className="h-3.5 w-3.5" /> : <BellOff className="h-3.5 w-3.5" />}
          {permission === 'granted' ? '브라우저 알림 켜짐' : permission === 'unsupported' ? '브라우저 알림 미지원' : '브라우저 알림 켜기'}
        </button>
        {offline ? <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-1 text-[10px] font-bold text-destructive"><WifiOff className="h-3 w-3" />오프라인</span> : null}
        {stale ? <span className="rounded-full bg-warning/10 px-2 py-1 text-[10px] font-bold text-warning">마지막 확인 후 갱신 실패</span> : <span className="text-[10px] font-bold text-muted-foreground">자동 갱신 중</span>}
        <span className="text-[10px] font-bold text-muted-foreground">마지막 갱신 {timeText(lastUpdatedAt)}</span>
      </div>

      {message ? <p role="status" className="mt-3 rounded-2xl bg-secondary p-3 text-xs font-bold">{message}</p> : null}

      <div className="mt-3 space-y-2">
        {loading ? <CardListSkeleton count={2} /> : null}
        {!loading && visible.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-card-border bg-background p-4 text-center text-xs font-bold text-muted-foreground">
            최근 검색 신호 알림이 없습니다.
          </p>
        ) : null}
        {!loading && visible.map((alert) => (
          <article key={alert.id} className="rounded-2xl border border-card-border bg-background p-3" data-testid={`signal-alert-${alert.kind.toLowerCase()}`}>
            <div className="flex items-start gap-2">
              <div className="mt-0.5 shrink-0">{kindIcon(alert.kind)}</div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="break-words text-xs font-extrabold">{alert.title}</p>
                  <span className={cn(
                    'rounded-full px-2 py-1 text-[10px] font-extrabold',
                    alert.approvalEnabled ? 'bg-positive/10 text-positive' : 'bg-destructive/10 text-destructive',
                  )}>
                    {stateLabel(alert.currentSignalState)}
                  </span>
                </div>
                <p className="mt-1 break-keep text-[11px] leading-5 text-muted-foreground">{userAlertMessage(alert)}</p>
                <p className="mt-1 text-[10px] font-bold text-muted-foreground">
                  주기 {alert.cycle} · {new Date(alert.createdAt).toLocaleString('ko-KR')}
                  {!alert.approvalEnabled ? ` · ${approvalMessage(alert.approvalReasonCode ?? alert.reasonCode)}` : ''}
                </p>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
