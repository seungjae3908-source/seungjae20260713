import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Ban, CheckCircle2, RefreshCw, ShieldCheck } from 'lucide-react';
import { authorizedFetch } from '@/lib/auth-fetch';
import { cn } from '@/lib/utils';

type Exchange = 'bitget' | 'upbit' | 'kiwoom';
type AccountMode = 'paper' | 'mock' | 'live';
type SignalState = 'forming' | 'candidate' | 'confirmed' | 'weakening' | 'invalid' | 'expired';

export type TradeApprovalPlan = {
  id: string;
  exchange: Exchange;
  accountMode: AccountMode;
  strategyId: string;
  symbol: string;
  market: string;
  side: 'buy' | 'sell' | 'long' | 'short';
  estimatedKrw: number;
  stopPrice: number;
  targetPrices: number[];
  signalReasons: string[];
  state: string;
  approvalExpiresAt: string | null;
  signalState?: SignalState | null;
  signalExpiresAt?: string | null;
  entryZoneLow?: number | null;
  entryZoneHigh?: number | null;
  estimatedSlippagePercent?: number | null;
  averageSpreadPercent?: number | null;
  marketSnapshot: {
    currentPrice?: number | null;
    observedAt: string;
    dataDelayMs: number;
  };
  riskAssessment?: {
    allowed: boolean;
    blockCodes: string[];
    warnings: string[];
    expectedValueR: number | null;
    riskBudgetKrw: number | null;
    maximumOrderKrw: number | null;
    stopDistancePercent: number | null;
    pilotStage: 'approval-20' | 'limited-50' | 'validated';
  } | null;
  internalIdentityExposed?: false;
};

const EXCHANGE_LABELS: Record<Exchange, string> = {
  bitget: 'Bitget 선물', upbit: 'Upbit 현물', kiwoom: 'Kiwoom 주식',
};

const SIGNAL_LABELS: Record<SignalState, string> = {
  forming: '형성 중', candidate: '후보', confirmed: '확정', weakening: '약화', invalid: '무효', expired: '만료',
};

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function approvalBlockReason(plan: TradeApprovalPlan, emergencyStopped: boolean) {
  if (emergencyStopped) return '긴급정지 또는 상태 확인 중입니다.';
  if (plan.state !== 'APPROVAL_PENDING') return '이미 처리된 주문후보입니다.';
  if (!plan.approvalExpiresAt || Date.parse(plan.approvalExpiresAt) <= Date.now()) return '승인 유효시간이 만료됐습니다.';
  if (plan.signalExpiresAt && Date.parse(plan.signalExpiresAt) <= Date.now()) return '신호 유효시간이 만료됐습니다.';
  if (plan.signalState && plan.signalState !== 'confirmed') return `신호가 ${SIGNAL_LABELS[plan.signalState]} 상태입니다.`;
  if (plan.riskAssessment && !plan.riskAssessment.allowed) {
    return `위험검사 차단: ${plan.riskAssessment.blockCodes.join(', ') || '조건 미충족'}`;
  }
  const currentPrice = plan.marketSnapshot.currentPrice;
  if (finite(currentPrice) && finite(plan.entryZoneLow) && finite(plan.entryZoneHigh)) {
    const low = Math.min(plan.entryZoneLow, plan.entryZoneHigh);
    const high = Math.max(plan.entryZoneLow, plan.entryZoneHigh);
    if (currentPrice < low || currentPrice > high) return '현재가가 승인 가능한 진입구간을 이탈했습니다.';
  }
  if (plan.accountMode === 'live') return 'Live는 최신 시세·호가 재검증 연결 전까지 승인할 수 없습니다.';
  return null;
}

function money(value: number | null | undefined) {
  return finite(value) ? `${Math.round(value).toLocaleString('ko-KR')}원` : '계산 전';
}

export function TradeApprovalQueue({
  fixturePlans,
  emergencyStopped,
}: {
  fixturePlans?: TradeApprovalPlan[];
  emergencyStopped?: boolean;
}) {
  const [plans, setPlans] = useState<TradeApprovalPlan[]>(fixturePlans ?? []);
  const [serverStopped, setServerStopped] = useState(emergencyStopped ?? true);
  const [loading, setLoading] = useState(!fixturePlans);
  const [message, setMessage] = useState('');
  const visiblePlans = useMemo(() => plans.slice(0, 20), [plans]);
  const effectiveStopped = emergencyStopped ?? serverStopped;

  async function load() {
    if (fixturePlans) return;
    setLoading(true);
    try {
      const [plansResponse, statusResponse] = await Promise.all([
        authorizedFetch('/api/trade-automation/plans'),
        authorizedFetch('/api/trade-automation/status'),
      ]);
      const plansPayload = await plansResponse.json() as { plans?: TradeApprovalPlan[]; error?: string };
      const statusPayload = await statusResponse.json() as { emergencyStopped?: boolean; error?: string };
      if (!plansResponse.ok || !plansPayload.plans) throw new Error(plansPayload.error ?? '주문후보를 불러오지 못했습니다.');
      if (!statusResponse.ok || typeof statusPayload.emergencyStopped !== 'boolean') throw new Error(statusPayload.error ?? '거래 안전상태를 확인하지 못했습니다.');
      setPlans(plansPayload.plans);
      setServerStopped(statusPayload.emergencyStopped);
      setMessage('');
    } catch (error) {
      setServerStopped(true);
      setMessage(error instanceof Error ? error.message : '주문후보를 불러오지 못했습니다.');
    } finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, []);

  async function approve(plan: TradeApprovalPlan) {
    const reason = approvalBlockReason(plan, effectiveStopped);
    if (reason) { setMessage(reason); return; }
    if (fixturePlans) {
      setPlans((current) => current.map((item) => item.id === plan.id ? { ...item, state: 'FILLED' } : item));
      setMessage(`${plan.symbol} Paper 주문을 승인하고 체결 검증했습니다.`);
      return;
    }
    try {
      const response = await authorizedFetch(`/api/trade-automation/plans/${encodeURIComponent(plan.id)}/approve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved: true }),
      });
      const payload = await response.json() as { plan?: TradeApprovalPlan; order?: { state?: string }; error?: string };
      if (!response.ok || !payload.plan) throw new Error(payload.error ?? '승인 실행에 실패했습니다.');
      setPlans((current) => current.map((item) => item.id === plan.id ? payload.plan! : item));
      setMessage(`${plan.symbol} 승인 완료 · ${payload.order?.state ?? payload.plan.state}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '승인 실행에 실패했습니다.');
      await load();
    }
  }

  async function invalidate(plan: TradeApprovalPlan) {
    if (fixturePlans) {
      setPlans((current) => current.map((item) => item.id === plan.id ? { ...item, state: 'EXPIRED' } : item));
      setMessage(`${plan.symbol} 주문후보를 취소했습니다.`);
      return;
    }
    try {
      const response = await authorizedFetch(`/api/trade-automation/plans/${encodeURIComponent(plan.id)}/invalidate`, { method: 'POST' });
      const payload = await response.json() as { plan?: TradeApprovalPlan; error?: string };
      if (!response.ok || !payload.plan) throw new Error(payload.error ?? '후보 취소에 실패했습니다.');
      setPlans((current) => current.map((item) => item.id === plan.id ? payload.plan! : item));
      setMessage(`${plan.symbol} 주문후보를 취소했습니다.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '후보 취소에 실패했습니다.');
      await load();
    }
  }

  return <section className="mt-3 rounded-3xl border border-card-border bg-card p-4 text-left shadow-sm" data-testid="trade-approval-queue">
    <div className="flex items-start justify-between gap-3">
      <div><h2 className="text-sm font-black">주문후보 · 승인 대기</h2><p className="mt-1 text-[11px] text-muted-foreground">조건 이탈 즉시 승인 버튼이 비활성화되며 Live는 서버 재검증 전까지 잠깁니다.</p></div>
      <button type="button" onClick={() => void load()} aria-label="주문후보 새로고침" className="rounded-xl border border-card-border p-2"><RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} /></button>
    </div>

    <div className="mt-3 space-y-2">
      {visiblePlans.length === 0 && <p className="rounded-xl border border-dashed border-card-border p-4 text-center text-xs text-muted-foreground">현재 승인 대기 주문후보가 없습니다.</p>}
      {visiblePlans.map((plan) => {
        const reason = approvalBlockReason(plan, effectiveStopped);
        const pending = plan.state === 'APPROVAL_PENDING';
        return <article key={plan.id} className="rounded-2xl border border-card-border bg-background p-3" data-testid={`approval-plan-${plan.id}`}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex flex-wrap items-center gap-1.5">
                <strong className="text-sm">{plan.symbol}</strong>
                <span className="rounded-full bg-secondary px-2 py-0.5 text-[9px] font-black">{EXCHANGE_LABELS[plan.exchange]}</span>
                <span className={cn('rounded-full px-2 py-0.5 text-[9px] font-black', plan.accountMode === 'live' ? 'bg-destructive/15 text-destructive' : 'bg-positive/15 text-positive')}>{plan.accountMode === 'live' ? 'LIVE' : plan.accountMode.toUpperCase()}</span>
                <span className="rounded-full bg-secondary px-2 py-0.5 text-[9px] font-black">{plan.side.toUpperCase()}</span>
              </div>
              <p className="mt-1 text-[10px] text-muted-foreground">{plan.strategyId} · {plan.signalReasons.join(' · ') || '근거 기록 없음'}</p>
            </div>
            {pending && !reason ? <CheckCircle2 className="h-5 w-5 text-positive" /> : <AlertTriangle className="h-5 w-5 text-warning" />}
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <PlanMetric label="예상 주문" value={money(plan.estimatedKrw)} />
            <PlanMetric label="위험수량 상한" value={money(plan.riskAssessment?.maximumOrderKrw)} />
            <PlanMetric label="비용 후 EV" value={finite(plan.riskAssessment?.expectedValueR) ? `+${plan.riskAssessment!.expectedValueR!.toFixed(2)}R` : '검증 전'} />
            <PlanMetric label="현재가" value={finite(plan.marketSnapshot.currentPrice) ? Number(plan.marketSnapshot.currentPrice).toLocaleString('ko-KR') : '수신 전'} />
            <PlanMetric label="진입구간" value={finite(plan.entryZoneLow) && finite(plan.entryZoneHigh) ? `${Number(plan.entryZoneLow).toLocaleString('ko-KR')}~${Number(plan.entryZoneHigh).toLocaleString('ko-KR')}` : '서버 검사'} />
            <PlanMetric label="손절" value={Number(plan.stopPrice).toLocaleString('ko-KR')} />
            <PlanMetric label="목표" value={plan.targetPrices.map((value) => value.toLocaleString('ko-KR')).join(' / ')} />
            <PlanMetric label="신호" value={plan.signalState ? SIGNAL_LABELS[plan.signalState] : '서버 최종검사'} />
          </div>

          {reason ? <p className="mt-3 flex items-start gap-1.5 rounded-xl bg-warning/10 p-2 text-[10px] font-bold text-warning"><Ban className="mt-0.5 h-3 w-3 shrink-0" />{reason}</p>
            : <p className="mt-3 flex items-start gap-1.5 rounded-xl bg-positive/10 p-2 text-[10px] font-bold text-positive"><ShieldCheck className="mt-0.5 h-3 w-3 shrink-0" />현재 표시 조건 통과 · 클릭 후 서버가 전체 위험조건을 다시 검사합니다.</p>}

          <div className="mt-3 grid grid-cols-2 gap-2">
            <button type="button" disabled={Boolean(reason)} onClick={() => void approve(plan)} className="rounded-xl bg-primary px-3 py-2 text-xs font-extrabold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-40">
              {plan.accountMode === 'live' ? 'Live 재검증 대기' : 'Paper 승인 실행'}
            </button>
            <button type="button" disabled={!pending} onClick={() => void invalidate(plan)} className="rounded-xl border border-card-border px-3 py-2 text-xs font-extrabold disabled:opacity-40">후보 취소</button>
          </div>
        </article>;
      })}
    </div>
    {message && <p role="status" className="mt-3 rounded-xl bg-secondary p-2 text-[11px] font-bold">{message}</p>}
  </section>;
}

function PlanMetric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-card-border bg-card px-2 py-2"><span className="block text-[9px] font-bold text-muted-foreground">{label}</span><strong className="mt-0.5 block break-words text-[11px]">{value}</strong></div>;
}
