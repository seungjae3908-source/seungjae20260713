import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Loader2,
  RefreshCw,
  ShieldCheck,
  ShieldX,
  WifiOff,
  XCircle,
} from 'lucide-react';
import { authorizedFetch } from '@/lib/auth-fetch';
import { TradeApprovalConfirmationDialog } from '@/components/trade-approval-confirmation-dialog';
import { CardListSkeleton } from '@/components/data-state';
import {
  accountModeLabel,
  approvalCountdown,
  approvalMessage,
  orderStateLabel,
  safeTradeErrorMessage,
  sideLabel,
} from '@/lib/trade-approval-ui';
import { cn } from '@/lib/utils';

type SignalState = 'WATCHING' | 'READY_FOR_APPROVAL' | 'WEAKENED' | 'INVALIDATED' | 'EXPIRED';
type PlanState = 'PLANNED' | 'APPROVAL_PENDING' | 'SUBMITTED' | 'EXPIRED' | string;

type ApprovalStatus = {
  approvalEnabled: boolean;
  signalState: SignalState;
  planState: PlanState;
  reasonCode: string | null;
  expiresAt: string | null;
  lastValidatedAt: string;
};

export type TradeApprovalQueueItem = {
  id: string;
  exchange: 'bitget' | 'upbit' | 'kiwoom';
  accountMode: 'paper' | 'mock' | 'live';
  strategyId: string;
  signalId: string;
  symbol: string;
  market: string;
  side: 'buy' | 'sell' | 'long' | 'short';
  orderType: 'market' | 'limit';
  estimatedKrw: number;
  quantity: number | null;
  limitPrice: number | null;
  stopPrice: number;
  targetPrices: number[];
  splitRatios: number[];
  leverage: number | null;
  signalReasons: string[];
  signalWarnings: string[];
  signalScore: number | null;
  signalConfidence: number | null;
  signalRiskReward: number | null;
  signalState: SignalState;
  signalInvalidationReason: string | null;
  state: PlanState;
  approvalExpiresAt: string | null;
  updatedAt: string;
  approval: ApprovalStatus;
  order: {
    state: string;
    filledQuantity: number;
    updatedAt: string;
    lastErrorCode: string | null;
  } | null;
};

type QueueResponse = {
  ok: boolean;
  items?: TradeApprovalQueueItem[];
  count?: number;
  updatedAt?: string;
  error?: string;
};

type ApprovalStatusResponse = {
  ok?: boolean;
  plan?: Partial<Pick<TradeApprovalQueueItem,
    'state' | 'signalState' | 'signalInvalidationReason' | 'approvalExpiresAt' | 'updatedAt'>>;
  approval?: ApprovalStatus;
  error?: string;
};

const EXCHANGE_LABEL: Record<TradeApprovalQueueItem['exchange'], string> = {
  bitget: 'Bitget 선물',
  upbit: 'Upbit 현물',
  kiwoom: 'Kiwoom 국내주식',
};

const SIGNAL_LABEL: Record<SignalState, string> = {
  WATCHING: '감시 중',
  READY_FOR_APPROVAL: '승인 가능',
  WEAKENED: '신호 약화',
  INVALIDATED: '신호 무효',
  EXPIRED: '신호 만료',
};

function formatNumber(value: number | null | undefined, maximumFractionDigits = 0) {
  if (value == null || !Number.isFinite(Number(value))) return '-';
  return new Intl.NumberFormat('ko-KR', { maximumFractionDigits }).format(Number(value));
}

function timeText(value: string | null | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return '-';
  return new Date(value).toLocaleString('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function stateClass(state: SignalState) {
  if (state === 'READY_FOR_APPROVAL') return 'border-positive/30 bg-positive/10 text-positive';
  if (state === 'WEAKENED' || state === 'WATCHING') return 'border-warning/30 bg-warning/10 text-warning';
  return 'border-destructive/30 bg-destructive/10 text-destructive';
}

function accountModeClass(mode: TradeApprovalQueueItem['accountMode']) {
  if (mode === 'live') return 'border-destructive/40 bg-destructive/10 text-destructive';
  if (mode === 'mock') return 'border-warning/40 bg-warning/10 text-warning';
  return 'border-primary/30 bg-primary/10 text-primary';
}

function mergeApprovalStatus(item: TradeApprovalQueueItem, payload: ApprovalStatusResponse) {
  return {
    ...item,
    state: payload.plan?.state ?? payload.approval?.planState ?? item.state,
    signalState: payload.plan?.signalState ?? payload.approval?.signalState ?? item.signalState,
    signalInvalidationReason: payload.plan?.signalInvalidationReason ?? item.signalInvalidationReason,
    approvalExpiresAt: payload.plan?.approvalExpiresAt ?? payload.approval?.expiresAt ?? item.approvalExpiresAt,
    updatedAt: payload.plan?.updatedAt ?? item.updatedAt,
    approval: payload.approval ?? item.approval,
  };
}

export function TradeApprovalQueue({ fixture }: { fixture?: TradeApprovalQueueItem[] }) {
  const [items, setItems] = useState<TradeApprovalQueueItem[]>(fixture ?? []);
  const [loading, setLoading] = useState(!fixture);
  const [message, setMessage] = useState('');
  const [actionId, setActionId] = useState<string | null>(null);
  const [validatingId, setValidatingId] = useState<string | null>(null);
  const [confirmationId, setConfirmationId] = useState<string | null>(null);
  const [validationMessage, setValidationMessage] = useState('서버 승인 상태를 확인하고 있습니다.');
  const [now, setNow] = useState(() => Date.now());
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(() => {
    if (!fixture?.length) return null;
    return [...fixture].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0]?.updatedAt ?? null;
  });
  const [stale, setStale] = useState(false);
  const [offline, setOffline] = useState(() => typeof navigator !== 'undefined' && !navigator.onLine);
  const requestSequenceRef = useRef(0);
  const mutationLockRef = useRef(false);

  const load = useCallback(async (silent = false) => {
    if (fixture) return;
    const requestSequence = ++requestSequenceRef.current;
    if (!silent) setLoading(true);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await authorizedFetch('/api/trade-automation/approval-queue', {
        headers: { 'Cache-Control': 'no-cache' },
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({})) as QueueResponse;
      if (!response.ok || !payload.ok) throw new Error(payload.error ?? 'APPROVAL_QUEUE_LOAD_FAILED');
      if (requestSequence !== requestSequenceRef.current) return;
      setItems(Array.isArray(payload.items) ? payload.items : []);
      setLastUpdatedAt(payload.updatedAt ?? new Date().toISOString());
      setStale(false);
      setOffline(false);
      if (!silent) setMessage('');
    } catch (error) {
      if (requestSequence !== requestSequenceRef.current) return;
      const timedOut = error instanceof Error && error.name === 'AbortError';
      const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
      setOffline(isOffline);
      setStale(true);
      if (!silent || !lastUpdatedAt) {
        setMessage(isOffline
          ? '오프라인 상태입니다. 마지막 확인 데이터를 표시하며 주문 승인은 잠금 상태입니다.'
          : timedOut
            ? '승인 목록 갱신 시간이 초과됐습니다. 다시 시도해 주세요.'
            : safeTradeErrorMessage(error instanceof Error ? error.message : null, '승인 대기 신호를 불러오지 못했습니다.'));
      }
    } finally {
      window.clearTimeout(timeout);
      if (requestSequence === requestSequenceRef.current && !silent) setLoading(false);
    }
  }, [fixture, lastUpdatedAt]);

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
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, []);

  const sorted = useMemo(() => [...items].sort((a, b) => {
    const approvalRank = Number(b.approval.approvalEnabled) - Number(a.approval.approvalEnabled);
    return approvalRank || Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  }), [items]);

  const summary = useMemo(() => {
    let available = 0;
    let expiringSoon = 0;
    let invalid = 0;
    for (const item of items) {
      const countdown = approvalCountdown(item.approval.expiresAt, now);
      const enabled = item.approval.approvalEnabled
        && item.state === 'APPROVAL_PENDING'
        && item.accountMode !== 'live'
        && !countdown.expired;
      if (enabled) available += 1;
      if (enabled && countdown.seconds <= 60) expiringSoon += 1;
      if (item.signalState === 'INVALIDATED' || item.signalState === 'EXPIRED' || item.state === 'EXPIRED') invalid += 1;
    }
    return { available, expiringSoon, invalid };
  }, [items, now]);

  const fetchApprovalStatus = useCallback(async (planId: string) => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await authorizedFetch(`/api/trade-automation/plans/${encodeURIComponent(planId)}/approval-status`, {
        headers: { 'Cache-Control': 'no-cache' },
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({})) as ApprovalStatusResponse;
      if (!response.ok || !payload.ok || !payload.approval) {
        throw new Error(payload.error ?? 'SIGNAL_REVALIDATION_REQUIRED');
      }
      return payload;
    } finally {
      window.clearTimeout(timeout);
    }
  }, []);

  const revalidateConfirmation = useCallback(async (planId: string, silent = false) => {
    if (actionId === planId) return;
    setValidatingId(planId);
    if (!silent) setValidationMessage('서버 승인 상태를 확인하고 있습니다.');
    try {
      const payload = await fetchApprovalStatus(planId);
      setItems((current) => current.map((item) => item.id === planId ? mergeApprovalStatus(item, payload) : item));
      setValidationMessage(payload.approval?.approvalEnabled
        ? '신호 유지가 확인됐습니다.'
        : approvalMessage(payload.approval?.reasonCode, payload.plan?.signalInvalidationReason));
      setStale(false);
      setLastUpdatedAt(new Date().toISOString());
    } catch (error) {
      setItems((current) => current.map((item) => item.id === planId ? {
        ...item,
        approval: {
          ...item.approval,
          approvalEnabled: false,
          reasonCode: 'SIGNAL_REVALIDATION_REQUIRED',
        },
      } : item));
      setStale(true);
      setValidationMessage(error instanceof Error && error.name === 'AbortError'
        ? '서버 재검증 시간이 초과돼 승인을 잠갔습니다.'
        : safeTradeErrorMessage(error instanceof Error ? error.message : null, '서버 재검증에 실패해 승인을 잠갔습니다.'));
    } finally {
      setValidatingId((current) => current === planId ? null : current);
    }
  }, [actionId, fetchApprovalStatus]);

  const revalidateOpenDialog = useCallback(() => {
    if (confirmationId) void revalidateConfirmation(confirmationId, true);
  }, [confirmationId, revalidateConfirmation]);

  function openApproval(item: TradeApprovalQueueItem) {
    if (mutationLockRef.current || actionId || validatingId) return;
    const countdown = approvalCountdown(item.approval.expiresAt);
    const locallyEnabled = item.approval.approvalEnabled
      && item.state === 'APPROVAL_PENDING'
      && item.signalState === 'READY_FOR_APPROVAL'
      && !countdown.expired
      && item.accountMode !== 'live'
      && !stale
      && !offline;
    setConfirmationId(item.id);
    setValidationMessage(locallyEnabled
      ? '서버 승인 상태를 확인하고 있습니다.'
      : item.accountMode === 'live'
        ? '실전 계좌 주문은 현재 차단 상태입니다.'
        : stale || offline
          ? '통신 상태가 최신이 아니어서 서버 재검증 전까지 승인할 수 없습니다.'
          : approvalMessage(item.approval.reasonCode, item.signalInvalidationReason));
    void revalidateConfirmation(item.id);
  }

  function closeConfirmation() {
    if (mutationLockRef.current) return;
    setConfirmationId(null);
    setValidationMessage('서버 승인 상태를 확인하고 있습니다.');
  }

  async function confirmApproval(item: TradeApprovalQueueItem) {
    if (mutationLockRef.current) return;
    mutationLockRef.current = true;
    setActionId(item.id);
    try {
      const statusPayload = await fetchApprovalStatus(item.id);
      const checkedItem = mergeApprovalStatus(item, statusPayload);
      setItems((current) => current.map((candidate) => candidate.id === item.id ? checkedItem : candidate));
      const countdown = approvalCountdown(checkedItem.approval.expiresAt);
      if (checkedItem.accountMode === 'live'
        || !checkedItem.approval.approvalEnabled
        || checkedItem.state !== 'APPROVAL_PENDING'
        || checkedItem.signalState !== 'READY_FOR_APPROVAL'
        || countdown.expired) {
        setValidationMessage(checkedItem.accountMode === 'live'
          ? '실전 계좌 주문은 현재 차단 상태입니다.'
          : approvalMessage(checkedItem.approval.reasonCode, checkedItem.signalInvalidationReason));
        return;
      }

      const response = await authorizedFetch(`/api/trade-automation/plans/${encodeURIComponent(item.id)}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved: true }),
      });
      const payload = await response.json().catch(() => ({})) as {
        ok?: boolean;
        error?: string;
        order?: { state?: string; lastErrorCode?: string | null };
      };
      if (!response.ok || !payload.ok) throw new Error(payload.error ?? 'TRADE_APPROVAL_FAILED');
      setConfirmationId(null);
      setMessage(`승인 처리 완료 · ${orderStateLabel(payload.order?.state)}`);
      await load(true);
    } catch (error) {
      const text = error instanceof Error && error.name === 'AbortError'
        ? '서버 최종 재검증 시간이 초과돼 주문을 보내지 않았습니다.'
        : safeTradeErrorMessage(error instanceof Error ? error.message : null, '주문 승인에 실패했습니다.');
      setValidationMessage(text);
      setMessage(text);
      setStale(true);
      await load(true);
    } finally {
      mutationLockRef.current = false;
      setActionId(null);
    }
  }

  async function reject(item: TradeApprovalQueueItem) {
    if (mutationLockRef.current || actionId || validatingId) return;
    mutationLockRef.current = true;
    setActionId(item.id);
    try {
      const response = await authorizedFetch(`/api/trade-automation/plans/${encodeURIComponent(item.id)}/invalidate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'USER_REJECTED_APPROVAL' }),
      });
      const payload = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.error ?? 'TRADE_REJECTION_FAILED');
      setMessage(`${item.symbol} 승인 요청을 거절했습니다.`);
      await load(true);
    } catch (error) {
      setMessage(safeTradeErrorMessage(error instanceof Error ? error.message : null, '신호 거절에 실패했습니다.'));
    } finally {
      mutationLockRef.current = false;
      setActionId(null);
    }
  }

  const confirmationItem = confirmationId
    ? items.find((item) => item.id === confirmationId) ?? null
    : null;
  const anyActionBusy = actionId !== null || validatingId !== null;

  return (
    <>
      <section className="rounded-3xl border border-card-border bg-card p-4 text-left shadow-sm" data-testid="trade-approval-queue">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-primary" />
              <h2 className="text-sm font-extrabold">승인 대기 신호</h2>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              검색 조건이 서버에서 유지되는 동안만 주문 승인 버튼이 활성화됩니다.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading || anyActionBusy}
            aria-label="승인 대기 신호 새로고침"
            className="flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-card-border disabled:opacity-40"
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </button>
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2" aria-label="승인 상태 요약">
          <SummaryMetric label="승인 가능" value={summary.available} tone="positive" />
          <SummaryMetric label="곧 만료" value={summary.expiringSoon} tone="warning" />
          <SummaryMetric label="무효·만료" value={summary.invalid} tone="destructive" />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px] font-bold text-muted-foreground" aria-live="polite">
          {offline ? <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-1 text-destructive"><WifiOff className="h-3 w-3" />오프라인</span> : null}
          {stale ? <span className="rounded-full bg-warning/10 px-2 py-1 text-warning">마지막 확인 후 갱신 실패 · 승인 잠금</span> : <span className="rounded-full bg-positive/10 px-2 py-1 text-positive">자동 갱신 중</span>}
          <span>마지막 갱신 {timeText(lastUpdatedAt)}</span>
        </div>

        {message ? <p role="status" className="mt-3 rounded-2xl bg-secondary p-3 text-xs font-bold">{message}</p> : null}

        <div className="mt-4 space-y-3">
          {loading ? <CardListSkeleton count={2} /> : null}
          {!loading && sorted.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-card-border bg-background p-5 text-center">
              <Clock3 className="mx-auto h-6 w-6 text-muted-foreground" />
              <p className="mt-2 text-sm font-extrabold">현재 승인 대기 신호가 없습니다.</p>
              <p className="mt-1 text-xs text-muted-foreground">검색기 신호가 진입 조건을 유지하면 이곳에 표시됩니다.</p>
            </div>
          ) : null}

          {!loading && sorted.map((item) => {
            const countdown = approvalCountdown(item.approval.expiresAt, now);
            const liveBlocked = item.accountMode === 'live';
            const enabled = item.approval.approvalEnabled
              && !countdown.expired
              && item.state === 'APPROVAL_PENDING'
              && item.signalState === 'READY_FOR_APPROVAL'
              && !liveBlocked
              && !stale
              && !offline;
            const busy = actionId === item.id || validatingId === item.id;
            return (
              <article key={item.id} className="min-w-0 rounded-2xl border border-card-border bg-background p-3" data-testid={`approval-plan-${item.id}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="break-all text-base font-black">{item.symbol}</span>
                      <span className="rounded-full border border-card-border px-2 py-0.5 text-[10px] font-bold">{EXCHANGE_LABEL[item.exchange]}</span>
                      <span className={cn('rounded-full border px-2 py-0.5 text-[10px] font-black', accountModeClass(item.accountMode))}>{accountModeLabel(item.accountMode)}</span>
                    </div>
                    <p className="mt-1 text-[11px] font-bold text-muted-foreground">{item.market} · {sideLabel(item.side)}</p>
                  </div>
                  <span className={cn('rounded-full border px-2.5 py-1 text-[11px] font-extrabold', stateClass(item.signalState))}>
                    {SIGNAL_LABEL[item.signalState]}
                  </span>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                  <Metric label="주문 한도" value={`${formatNumber(item.estimatedKrw)}원`} />
                  <Metric label="손절" value={formatNumber(item.stopPrice, 8)} />
                  <Metric label="목표" value={item.targetPrices.map((price) => formatNumber(price, 8)).join(' / ')} />
                  <Metric label="승인 시간" value={countdown.label} warning={countdown.warning} />
                </div>

                <div className={cn(
                  'mt-3 flex items-start gap-2 rounded-xl border p-3 text-xs',
                  enabled ? 'border-positive/30 bg-positive/10' : 'border-warning/30 bg-warning/10',
                )}>
                  {busy
                    ? <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
                    : enabled
                      ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-positive" />
                      : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />}
                  <div className="min-w-0">
                    <p className="font-extrabold">{busy ? '서버 확인 중' : enabled ? '최종 승인 가능' : liveBlocked ? '실전 주문 차단' : '주문 승인 비활성화'}</p>
                    <p className="mt-0.5 break-keep leading-5 text-muted-foreground">
                      {liveBlocked
                        ? '실전 계좌 주문은 현재 활성화되지 않았습니다.'
                        : stale || offline
                          ? '최신 상태를 확인할 수 없어 승인 버튼을 잠갔습니다.'
                          : countdown.expired
                            ? '승인 가능 시간이 지났습니다.'
                            : approvalMessage(item.approval.reasonCode, item.signalInvalidationReason)}
                    </p>
                  </div>
                </div>

                {item.order ? (
                  <p className="mt-2 text-[11px] font-bold text-muted-foreground">
                    주문 상태 {orderStateLabel(item.order.state)} · 체결수량 {formatNumber(item.order.filledQuantity, 8)}
                    {item.order.lastErrorCode ? ' · 상태 재확인 필요' : ''}
                  </p>
                ) : null}

                <details className="mt-3 rounded-xl border border-card-border bg-card p-3 text-xs">
                  <summary className="cursor-pointer font-extrabold">AI 근거·경고·주문 상세 보기</summary>
                  <div className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
                    <span className="font-bold text-muted-foreground">AI 점수</span><span>{formatNumber(item.signalScore)}점</span>
                    <span className="font-bold text-muted-foreground">신뢰도</span><span>{formatNumber(item.signalConfidence)}%</span>
                    <span className="font-bold text-muted-foreground">손익비</span><span>{item.signalRiskReward == null ? '-' : `${formatNumber(item.signalRiskReward, 2)} : 1`}</span>
                    <span className="font-bold text-muted-foreground">분할진입</span><span>{item.splitRatios.join('% / ')}%</span>
                    <span className="font-bold text-muted-foreground">승인 만료</span><span>{timeText(item.approval.expiresAt)}</span>
                  </div>
                  {item.signalReasons.length ? <p className="mt-3 break-keep leading-5">근거 · {item.signalReasons.join(' · ')}</p> : null}
                  {item.signalWarnings.length ? <p className="mt-2 break-keep leading-5 text-warning">경고 · {item.signalWarnings.join(' · ')}</p> : null}
                </details>

                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => void reject(item)}
                    disabled={anyActionBusy || item.state !== 'APPROVAL_PENDING'}
                    className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-card-border px-3 text-xs font-extrabold disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <XCircle className="h-4 w-4" />{busy && actionId === item.id ? '처리 중' : '거절'}
                  </button>
                  <button
                    type="button"
                    onClick={() => openApproval(item)}
                    disabled={!enabled || anyActionBusy}
                    data-testid={`approve-plan-${item.id}`}
                    className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-primary px-3 text-xs font-extrabold text-primary-foreground disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
                  >
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : enabled ? <ShieldCheck className="h-4 w-4" /> : <ShieldX className="h-4 w-4" />}
                    {busy ? '서버 확인 중' : liveBlocked ? '실전 주문 차단' : item.accountMode === 'paper' ? 'Paper 주문 승인' : '모의 주문 승인'}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {confirmationItem ? (
        <TradeApprovalConfirmationDialog
          item={confirmationItem}
          validating={validatingId === confirmationItem.id}
          submitting={actionId === confirmationItem.id}
          validationMessage={validationMessage}
          onCancel={closeConfirmation}
          onConfirm={() => void confirmApproval(confirmationItem)}
          onRevalidate={revalidateOpenDialog}
        />
      ) : null}
    </>
  );
}

function Metric({ label, value, warning = false }: { label: string; value: string; warning?: boolean }) {
  return (
    <div className={cn('min-w-0 rounded-xl border border-card-border bg-card p-2.5', warning && 'border-warning/40 bg-warning/10')}>
      <p className="text-[10px] font-bold text-muted-foreground">{label}</p>
      <p className={cn('mt-1 break-words font-extrabold tabular-nums', warning && 'text-warning')}>{value}</p>
    </div>
  );
}

function SummaryMetric({ label, value, tone }: { label: string; value: number; tone: 'positive' | 'warning' | 'destructive' }) {
  return (
    <div className={cn(
      'rounded-xl border p-2 text-center',
      tone === 'positive' && 'border-positive/30 bg-positive/10',
      tone === 'warning' && 'border-warning/30 bg-warning/10',
      tone === 'destructive' && 'border-destructive/30 bg-destructive/10',
    )}>
      <p className="text-[9px] font-bold text-muted-foreground">{label}</p>
      <p className="mt-1 text-base font-black tabular-nums">{value}</p>
    </div>
  );
}
