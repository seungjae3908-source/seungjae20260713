import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  RefreshCw,
  ShieldCheck,
  ShieldX,
  XCircle,
} from 'lucide-react';
import { authorizedFetch } from '@/lib/auth-fetch';
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

const REASON_LABELS: Record<string, string> = {
  PLAN_NOT_APPROVAL_PENDING: '이미 처리됐거나 승인 대기 상태가 아닙니다.',
  SIGNAL_WATCHING: '아직 진입 조건을 확인 중입니다.',
  SIGNAL_WEAKENED: '신호가 약해져 재검증 전까지 승인할 수 없습니다.',
  SIGNAL_INVALIDATED: '핵심 조건이 이탈해 승인이 무효화됐습니다.',
  SIGNAL_EXPIRED: '신호 유효시간이 지났습니다.',
  APPROVAL_EXPIRED: '승인 가능 시간이 지났습니다.',
  SIGNAL_REVALIDATION_REQUIRED: '최신 시장 데이터 재검증이 필요합니다.',
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

function approvalReason(item: TradeApprovalQueueItem, expired: boolean) {
  if (expired) return '승인 가능 시간이 지났습니다.';
  const code = item.approval.reasonCode;
  if (!code) return '조건 유지가 확인돼 승인할 수 있습니다.';
  return REASON_LABELS[code] ?? item.signalInvalidationReason ?? code;
}

export function TradeApprovalQueue({ fixture }: { fixture?: TradeApprovalQueueItem[] }) {
  const [items, setItems] = useState<TradeApprovalQueueItem[]>(fixture ?? []);
  const [loading, setLoading] = useState(!fixture);
  const [message, setMessage] = useState('');
  const [actionId, setActionId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  async function load(silent = false) {
    if (fixture) return;
    if (!silent) setLoading(true);
    try {
      const response = await authorizedFetch('/api/trade-automation/approval-queue', {
        headers: { 'Cache-Control': 'no-cache' },
      });
      const payload = await response.json().catch(() => ({})) as QueueResponse;
      if (!response.ok || !payload.ok) throw new Error(payload.error ?? '승인 대기 신호를 불러오지 못했습니다.');
      setItems(Array.isArray(payload.items) ? payload.items : []);
      if (!silent) setMessage('');
    } catch (error) {
      if (!silent) setMessage(error instanceof Error ? error.message : '승인 대기 신호를 불러오지 못했습니다.');
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
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, []);

  const sorted = useMemo(() => [...items].sort((a, b) => {
    const approvalRank = Number(b.approval.approvalEnabled) - Number(a.approval.approvalEnabled);
    return approvalRank || Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  }), [items]);

  async function approve(item: TradeApprovalQueueItem) {
    if (actionId) return;
    const expiresAt = item.approval.expiresAt ? Date.parse(item.approval.expiresAt) : Number.NaN;
    if (!item.approval.approvalEnabled || (Number.isFinite(expiresAt) && expiresAt <= Date.now())) {
      setMessage('조건이 유지되지 않거나 승인 시간이 지나 주문 버튼이 비활성화됐습니다.');
      await load(true);
      return;
    }

    setActionId(item.id);
    try {
      const statusResponse = await authorizedFetch(`/api/trade-automation/plans/${encodeURIComponent(item.id)}/approval-status`, {
        headers: { 'Cache-Control': 'no-cache' },
      });
      const statusPayload = await statusResponse.json().catch(() => ({})) as {
        approval?: ApprovalStatus;
        error?: string;
      };
      if (!statusResponse.ok || !statusPayload.approval?.approvalEnabled) {
        throw new Error(REASON_LABELS[statusPayload.approval?.reasonCode ?? ''] ?? statusPayload.error ?? '최종 조건 확인에서 승인이 차단됐습니다.');
      }

      const confirmed = window.confirm([
        `${item.symbol} ${item.side === 'short' ? '숏' : item.side === 'sell' ? '매도' : '매수'} 주문을 승인하시겠습니까?`,
        '',
        `${EXCHANGE_LABEL[item.exchange]} · ${item.accountMode === 'live' ? '실전' : item.accountMode === 'mock' ? '모의' : 'Paper'}`,
        `AI 점수: ${formatNumber(item.signalScore)}점`,
        `신뢰도: ${formatNumber(item.signalConfidence)}%`,
        `예상 주문금액: ${formatNumber(item.estimatedKrw)}원`,
        `분할계획: ${item.splitRatios.join('% / ')}%`,
        `손절가: ${formatNumber(item.stopPrice, 8)}`,
        `목표가: ${item.targetPrices.map((price) => formatNumber(price, 8)).join(' / ')}`,
        `승인 만료: ${timeText(item.approval.expiresAt)}`,
        '',
        '확인을 누른 뒤에도 서버가 가격·조건·위험 한도를 다시 검사합니다.',
      ].join('\n'));
      if (!confirmed) {
        setMessage('주문 승인을 취소했습니다.');
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
      if (!response.ok || !payload.ok) throw new Error(payload.error ?? '주문 승인에 실패했습니다.');
      setMessage(`승인 처리 완료 · 주문 상태 ${payload.order?.state ?? '확인 중'}${payload.order?.lastErrorCode ? ` · ${payload.order.lastErrorCode}` : ''}`);
      await load(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '주문 승인에 실패했습니다.');
      await load(true);
    } finally {
      setActionId(null);
    }
  }

  async function reject(item: TradeApprovalQueueItem) {
    if (actionId) return;
    setActionId(item.id);
    try {
      const response = await authorizedFetch(`/api/trade-automation/plans/${encodeURIComponent(item.id)}/invalidate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'USER_REJECTED_APPROVAL' }),
      });
      const payload = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.error ?? '신호 거절에 실패했습니다.');
      setMessage(`${item.symbol} 승인 요청을 거절했습니다.`);
      await load(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '신호 거절에 실패했습니다.');
    } finally {
      setActionId(null);
    }
  }

  return (
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
          aria-label="승인 대기 신호 새로고침"
          className="rounded-xl border border-card-border p-2"
        >
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
        </button>
      </div>

      {message ? <p role="status" className="mt-3 rounded-2xl bg-secondary p-3 text-xs font-bold">{message}</p> : null}

      <div className="mt-4 space-y-3">
        {!loading && sorted.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-card-border bg-background p-5 text-center">
            <Clock3 className="mx-auto h-6 w-6 text-muted-foreground" />
            <p className="mt-2 text-sm font-extrabold">현재 승인 대기 신호가 없습니다.</p>
            <p className="mt-1 text-xs text-muted-foreground">검색기 신호가 진입 조건을 유지하면 이곳에 표시됩니다.</p>
          </div>
        ) : null}

        {sorted.map((item) => {
          const expiresAt = item.approval.expiresAt ? Date.parse(item.approval.expiresAt) : Number.NaN;
          const expired = Number.isFinite(expiresAt) && expiresAt <= now;
          const enabled = item.approval.approvalEnabled && !expired && item.state === 'APPROVAL_PENDING';
          const busy = actionId === item.id;
          return (
            <article key={item.id} className="rounded-2xl border border-card-border bg-background p-3" data-testid={`approval-plan-${item.id}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-base font-black">{item.symbol}</span>
                    <span className="rounded-full border border-card-border px-2 py-0.5 text-[10px] font-bold">{EXCHANGE_LABEL[item.exchange]}</span>
                    <span className="rounded-full border border-card-border px-2 py-0.5 text-[10px] font-bold">{item.accountMode === 'live' ? '실전' : item.accountMode === 'mock' ? '모의' : 'Paper'}</span>
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">{item.strategyId} · {item.market} · {item.side.toUpperCase()}</p>
                </div>
                <span className={cn('rounded-full border px-2.5 py-1 text-[11px] font-extrabold', stateClass(item.signalState))}>
                  {SIGNAL_LABEL[item.signalState]}
                </span>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                <Metric label="AI 점수" value={`${formatNumber(item.signalScore)}점`} />
                <Metric label="신뢰도" value={`${formatNumber(item.signalConfidence)}%`} />
                <Metric label="손익비" value={item.signalRiskReward == null ? '-' : `${formatNumber(item.signalRiskReward, 2)} : 1`} />
                <Metric label="주문 한도" value={`${formatNumber(item.estimatedKrw)}원`} />
              </div>

              <div className="mt-3 rounded-xl border border-card-border bg-card p-3 text-xs">
                <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
                  <span className="font-bold text-muted-foreground">분할진입</span><span>{item.splitRatios.join('% / ')}%</span>
                  <span className="font-bold text-muted-foreground">손절</span><span>{formatNumber(item.stopPrice, 8)}</span>
                  <span className="font-bold text-muted-foreground">목표</span><span>{item.targetPrices.map((price) => formatNumber(price, 8)).join(' / ')}</span>
                  <span className="font-bold text-muted-foreground">승인 만료</span><span>{timeText(item.approval.expiresAt)}</span>
                </div>
              </div>

              {item.signalReasons.length ? (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {item.signalReasons.slice(0, 6).map((reason) => <span key={reason} className="rounded-full bg-secondary px-2 py-1 text-[10px] font-bold">{reason}</span>)}
                </div>
              ) : null}

              <div className={cn('mt-3 flex items-start gap-2 rounded-xl border p-3 text-xs', enabled ? 'border-positive/30 bg-positive/10' : 'border-warning/30 bg-warning/10')}>
                {enabled ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-positive" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />}
                <div>
                  <p className="font-extrabold">{enabled ? '최종 승인 가능' : '주문 승인 비활성화'}</p>
                  <p className="mt-0.5 text-muted-foreground">{approvalReason(item, expired)}</p>
                </div>
              </div>

              {item.order ? (
                <p className="mt-2 text-[11px] font-bold text-muted-foreground">
                  주문 상태 {item.order.state} · 체결수량 {formatNumber(item.order.filledQuantity, 8)}
                  {item.order.lastErrorCode ? ` · ${item.order.lastErrorCode}` : ''}
                </p>
              ) : null}

              <div className="mt-3 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => void reject(item)}
                  disabled={busy || item.state !== 'APPROVAL_PENDING'}
                  className="flex items-center justify-center gap-2 rounded-xl border border-card-border px-3 py-2.5 text-xs font-extrabold disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <XCircle className="h-4 w-4" />거절
                </button>
                <button
                  type="button"
                  onClick={() => void approve(item)}
                  disabled={!enabled || busy}
                  data-testid={`approve-plan-${item.id}`}
                  className="flex items-center justify-center gap-2 rounded-xl bg-primary px-3 py-2.5 text-xs font-extrabold text-primary-foreground disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
                >
                  {enabled ? <ShieldCheck className="h-4 w-4" /> : <ShieldX className="h-4 w-4" />}
                  {busy ? '최종 확인 중...' : item.accountMode === 'paper' ? '모의 주문 승인' : '주문 승인'}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-card-border bg-card p-2.5"><p className="text-[10px] font-bold text-muted-foreground">{label}</p><p className="mt-1 font-extrabold">{value}</p></div>;
}
