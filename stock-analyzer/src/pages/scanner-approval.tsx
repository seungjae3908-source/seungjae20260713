import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import { api, type ScanCard } from '@/lib/api';
import { authorizedFetch } from '@/lib/auth-fetch';
import { BottomNav } from '@/components/bottom-nav';
import { cn } from '@/lib/utils';

type Market = 'KR' | 'US';
type SignalState = 'DETECTED' | 'WATCHING' | 'READY_FOR_APPROVAL' | 'APPROVAL_SENT' | 'APPROVED' | 'WEAKENED' | 'INVALIDATED' | 'EXPIRED' | 'REJECTED';
type Signal = {
  id: string; market: Market; symbol: string; displayName: string; timeframe: string;
  score: number; confidence: number; riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'BLOCKED';
  matchedSignals: string[]; selectedConditions: string[]; reasons: string[]; warnings: string[];
  currentPrice: number;
  entryPlan: { legs: Array<{ sequence: 1 | 2 | 3; price: number; allocationRate: number; status: string }> };
  targets: Array<{ price: number; exitRate: number }>;
  stopLoss: number | null; expectedRiskReward: number | null; estimatedMaxLoss: number | null;
  state: SignalState; generatedAt: string; expiresAt: string; dataTimestamp: string;
};
type Guard = { enabled: boolean; reasons: string[]; checkedAt: string };
type ApprovalResponse = {
  ok: boolean; error?: string; detailCodes?: string[]; signal?: Signal; guard?: Guard;
  plan?: { id: string; state: string; approvalExpiresAt: string | null } | null;
  order?: { id: string; state: string } | null;
  paperOnly?: boolean; liveOrderEnabled?: boolean; exchangeRequestSent?: boolean; paperOrderCreated?: boolean;
  approvalToken?: string | null; followUpEntriesCancelled?: boolean; additionalEntriesEnabled?: boolean;
  nextEntryPrice?: number | null; activatedEntries?: Array<{ sequence: 2 | 3; orderState: string }>;
};

const DEFAULT_CONDITIONS = ['거래량 증가', '5일선 돌파', 'AI 점수 상위'];

function number(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cardReasons(card: ScanCard) {
  const breakdown = card.scoreBreakdown ?? {};
  const detailed = Object.values(breakdown).flatMap((item) => item?.reasons ?? []);
  return [...new Set([...(card.matched ?? []), ...detailed])].slice(0, 12);
}

function candidateFromCard(card: ScanCard, market: Market, fetchedAt?: string) {
  const observedAt = card.analyzedAt ?? fetchedAt ?? new Date().toISOString();
  const stale = card.dataState === 'stale' || card.dataState === 'delayed' || card.dataState === 'unavailable';
  return {
    market, symbol: card.ticker, displayName: card.name, timeframe: '1D', currentPrice: number(card.price),
    score: number(card.score, 50), confidence: number(card.confidence, 50), riskScore: number(card.riskScore, 35),
    riskLevel: card.riskLevel ?? 'MEDIUM', selectedConditions: DEFAULT_CONDITIONS, matchedSignals: card.matched ?? [],
    reasons: cardReasons(card), warnings: card.missing ?? [],
    scoreBreakdown: Object.fromEntries(Object.entries(card.scoreBreakdown ?? {}).map(([key, value]) => [key, value?.score])),
    entryPrices: card.entry?.map((value) => number(String(value).replace(/[^0-9.-]/g, ''))).filter((value) => value > 0),
    stopLoss: number(String(card.stop?.[0] ?? '').replace(/[^0-9.-]/g, ''), 0) || undefined,
    dataTimestamp: observedAt,
    marketSnapshot: {
      observedAt, dataDelayMs: stale ? 6_000 : 200, oneMinuteMovePercent: number(card.changePercent),
      spreadPercent: stale ? 1.2 : 0.2, orderbookGapPercent: stale ? 2.5 : 0.3, halted: false,
    },
  };
}

async function post(path: string, body: unknown): Promise<ApprovalResponse> {
  const response = await authorizedFetch(`/api/trade-automation/scanner${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({})) as ApprovalResponse;
  if (!response.ok && !payload.signal) throw new Error(payload.error ?? `HTTP_${response.status}`);
  return payload;
}

function formatPrice(value: number, market: Market) {
  return market === 'KR' ? `${Math.round(value).toLocaleString('ko-KR')}원` : `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

function stateLabel(state: SignalState) {
  const labels: Record<SignalState, string> = {
    DETECTED: '감지', WATCHING: '감시 중', READY_FOR_APPROVAL: '승인 가능', APPROVAL_SENT: '승인 요청',
    APPROVED: '승인 완료', WEAKENED: '신호 약화', INVALIDATED: '신호 무효', EXPIRED: '만료', REJECTED: '거절',
  };
  return labels[state];
}

export default function ScannerApprovalPage() {
  const [market, setMarket] = useState<Market>('KR');
  const [active, setActive] = useState<ApprovalResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  const scan = useQuery({
    queryKey: ['scanner-approval-candidates', market],
    queryFn: () => api.scan(DEFAULT_CONDITIONS, market, { minimumScore: 50, maximumRiskScore: 80, timeframe: '1D' }),
    refetchInterval: 30_000, refetchIntervalInBackground: true, refetchOnReconnect: true, refetchOnWindowFocus: true,
  });

  const cards = useMemo(() => (scan.data?.cards ?? []).slice(0, 30), [scan.data]);
  const activeCard = active?.signal ? cards.find((card) => card.ticker === active.signal?.symbol) : undefined;

  const createApproval = async (card: ScanCard) => {
    setBusy(card.ticker);
    setMessage('서버에서 신호와 위험 한도를 검증하는 중입니다.');
    try {
      const result = await post('/signals', { candidate: candidateFromCard(card, market, scan.data?.fetchedAt) });
      setActive(result);
      if (!result.ok || !result.plan) {
        setMessage(`승인 계획을 만들지 않았습니다: ${result.error ?? result.guard?.reasons.join(' · ') ?? '위험 한도 확인 필요'}`);
      } else {
        setMessage(result.guard?.enabled ? '조건이 유지되는 동안에만 모의주문 승인 버튼이 활성화됩니다.' : '현재 조건으로는 승인할 수 없어 감시 상태로 유지합니다.');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '승인 요청 생성에 실패했습니다.');
    } finally { setBusy(null); }
  };

  const revalidate = async () => {
    if (!active?.plan?.id || !active.signal || ['INVALIDATED', 'EXPIRED', 'REJECTED'].includes(active.signal.state)) return;
    const card = activeCard;
    const fallback = {
      market: active.signal.market, symbol: active.signal.symbol, displayName: active.signal.displayName,
      timeframe: active.signal.timeframe, currentPrice: active.signal.currentPrice,
      score: Math.max(0, active.signal.score - 25), confidence: Math.max(0, active.signal.confidence - 25),
      riskScore: 90, riskLevel: 'BLOCKED', selectedConditions: active.signal.selectedConditions, matchedSignals: [],
      reasons: ['최신 검색 결과에서 종목을 확인하지 못했습니다.'], warnings: ['신호 데이터가 사라져 승인을 잠갔습니다.'],
      dataTimestamp: new Date(Date.now() - 60_000).toISOString(),
      marketSnapshot: { observedAt: new Date(Date.now() - 60_000).toISOString(), dataDelayMs: 60_000, oneMinuteMovePercent: 0, spreadPercent: 2, orderbookGapPercent: 3, halted: false },
    };
    const result = await post(`/signals/${active.plan.id}/revalidate`, {
      candidate: card ? candidateFromCard(card, market, scan.data?.fetchedAt) : fallback,
    });
    setActive((current) => ({ ...(current ?? { ok: true }), ...result, plan: current?.plan ?? null }));
    if (result.activatedEntries?.length) setMessage(`${result.activatedEntries.map((entry) => `${entry.sequence}차 ${entry.orderState}`).join(' · ')} — 조건 유지와 가격 도달을 확인해 모의 체결했습니다.`);
    else if (result.signal?.state === 'WEAKENED') setMessage('신호가 약화되어 추가 진입과 승인 버튼을 잠갔습니다. 다음 검색 갱신에서 다시 확인합니다.');
    else if (result.signal?.state === 'INVALIDATED') setMessage('조건이 이탈해 승인과 2·3차 후속 진입계획을 무효화했습니다.');
    else if (result.signal?.state === 'APPROVED' && result.additionalEntriesEnabled) setMessage(`1차 보유분 관리 중 · 다음 모의진입 ${result.nextEntryPrice?.toLocaleString() ?? '-'} 도달을 감시합니다.`);
  };

  useEffect(() => {
    if (!active?.plan?.id) return;
    const timer = window.setInterval(() => { void revalidate(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [active?.plan?.id, active?.signal?.state, activeCard?.ticker, scan.data?.fetchedAt]);

  const approve = async () => {
    if (!active?.plan?.id || !active.signal || !active.guard?.enabled || !active.approvalToken || !activeCard || !['READY_FOR_APPROVAL', 'APPROVAL_SENT'].includes(active.signal.state)) return;
    setBusy('approve');
    try {
      const result = await post(`/signals/${active.plan.id}/approve`, {
        approved: true, approvalToken: active.approvalToken,
        candidate: candidateFromCard(activeCard, market, scan.data?.fetchedAt),
      });
      setActive((current) => ({ ...(current ?? { ok: true }), ...result, plan: result.plan ?? current?.plan ?? null }));
      if (!result.ok) {
        setMessage(`승인하지 않았습니다: ${[result.error, ...(result.guard?.reasons ?? []), ...(result.detailCodes ?? [])].filter(Boolean).join(' · ')}`);
      } else {
        setMessage(result.paperOrderCreated ? '승인된 계획을 모의주문으로만 체결했습니다. 실제 거래소 요청은 전송하지 않았습니다.' : '승인 결과를 확인했습니다.');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '승인 처리에 실패했습니다.');
      await revalidate();
    } finally { setBusy(null); }
  };

  const reject = async () => {
    if (!active?.plan?.id) return;
    setBusy('reject');
    try {
      const result = await post(`/signals/${active.plan.id}/reject`, {});
      setActive((current) => ({ ...(current ?? { ok: true }), ...result, plan: current?.plan ?? null }));
      setMessage('승인 요청을 거절하고 미사용 계획을 무효화했습니다.');
    } finally { setBusy(null); }
  };

  return (
    <div className="h-full overflow-y-auto overscroll-contain bg-background pb-24" data-testid="scanner-approval-page">
      <header className="border-b border-card-border px-4 pb-4 pt-4">
        <p className="text-[11px] font-extrabold text-primary">AI 검색기</p>
        <h1 className="text-xl font-extrabold">승인형 신호 관리</h1>
        <div className="mt-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs font-bold text-emerald-700">
          이 화면은 모의주문 전용입니다. 실주문·거래소 비공개 API·자동승인은 항상 비활성화됩니다.
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {(['KR', 'US'] as const).map((value) => (
            <button key={value} type="button" onClick={() => { setMarket(value); setActive(null); }} className={cn('rounded-xl border px-3 py-2 text-sm font-extrabold', market === value ? 'border-primary bg-primary text-primary-foreground' : 'border-card-border bg-card')}>
              {value === 'KR' ? '국내주식' : '미국주식'}
            </button>
          ))}
        </div>
      </header>

      <main className="space-y-4 px-4 pt-4">
        {active?.signal && (
          <section className="rounded-3xl border border-primary/30 bg-card p-4 shadow-sm" data-testid="approval-panel">
            <div className="flex items-start justify-between gap-3">
              <div><p className="text-lg font-black">{active.signal.displayName}</p><p className="text-xs font-bold text-muted-foreground">{active.signal.symbol} · {active.signal.market} · {active.signal.timeframe}</p></div>
              <span className={cn('rounded-full px-3 py-1 text-[11px] font-black', active.guard?.enabled ? 'bg-emerald-500/10 text-emerald-700' : 'bg-amber-500/10 text-amber-700')} data-testid="signal-state">{stateLabel(active.signal.state)}</span>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-center">
              <Metric label="AI 점수" value={`${active.signal.score}`} />
              <Metric label="신뢰도" value={`${active.signal.confidence}%`} />
              <Metric label="위험도" value={active.signal.riskLevel} />
            </div>
            <div className="mt-3 rounded-2xl bg-secondary/60 p-3">
              <p className="text-xs font-extrabold">1·2·3차 진입계획</p>
              <div className="mt-2 space-y-2">
                {active.signal.entryPlan.legs.map((leg) => (
                  <div key={leg.sequence} className="flex items-center justify-between text-xs font-bold">
                    <span>{leg.sequence}차 · {leg.allocationRate}% · {leg.status}</span><span>{formatPrice(leg.price, active.signal!.market)}</span>
                  </div>
                ))}
              </div>
              <div className="mt-2 border-t border-card-border pt-2 text-xs font-bold">손절 {active.signal.stopLoss ? formatPrice(active.signal.stopLoss, active.signal.market) : '없음'} · 손익비 {active.signal.expectedRiskReward ?? '계산 불가'}</div>
            </div>
            {!active.guard?.enabled && active.signal.state !== 'APPROVED' && (
              <div className="mt-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3" role="alert">
                <p className="flex items-center gap-1 text-xs font-black text-amber-700"><AlertTriangle className="h-4 w-4" /> 승인 잠금</p>
                <p className="mt-1 break-words text-[11px] font-bold text-amber-700">{active.guard?.reasons.join(' · ') || '신호 조건을 다시 확인해야 합니다.'}</p>
              </div>
            )}
            {active.signal.state === 'APPROVED' && <div className="mt-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs font-bold text-emerald-700">1차 모의체결 후 보유분 관리 중입니다. 2·3차는 가격 도달과 조건 유지가 함께 확인될 때만 모의 활성화됩니다.</div>}
            <button type="button" data-testid="revalidate-button" onClick={() => void revalidate()} disabled={busy != null || !active.plan?.id || ['INVALIDATED', 'EXPIRED', 'REJECTED'].includes(active.signal.state)} className="mt-3 w-full rounded-xl border border-card-border bg-background px-3 py-2 text-xs font-extrabold disabled:opacity-40">
              {active.signal.state === 'APPROVED' ? '보유분·추가진입 조건 확인' : '현재 조건 다시 확인'}
            </button>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button type="button" onClick={() => void reject()} disabled={busy != null || ['APPROVED', 'REJECTED'].includes(active.signal.state)} className="flex items-center justify-center gap-1 rounded-2xl border border-card-border bg-background px-3 py-3 text-sm font-extrabold disabled:opacity-40"><XCircle className="h-4 w-4" /> 거절</button>
              <button type="button" data-testid="approve-button" onClick={() => void approve()} disabled={!active.guard?.enabled || !active.approvalToken || busy != null || !activeCard || !['READY_FOR_APPROVAL', 'APPROVAL_SENT'].includes(active.signal.state)} className="flex items-center justify-center gap-1 rounded-2xl bg-primary px-3 py-3 text-sm font-extrabold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-40"><ShieldCheck className="h-4 w-4" /> {busy === 'approve' ? '재검증 중' : '모의주문 승인'}</button>
            </div>
            {active.order && <p className="mt-3 text-center text-xs font-black text-emerald-700" data-testid="paper-order-result"><CheckCircle2 className="mr-1 inline h-4 w-4" />모의주문 {active.order.state}</p>}
          </section>
        )}

        <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
          <div className="flex items-center justify-between gap-2">
            <div><h2 className="text-sm font-extrabold">승인 후보</h2><p className="mt-1 text-[11px] font-semibold text-muted-foreground">검색 결과는 30초마다 갱신되며 조건이 이탈하면 열어 둔 승인 버튼도 즉시 잠깁니다.</p></div>
            <button type="button" onClick={() => void scan.refetch()} className="flex h-9 w-9 items-center justify-center rounded-full border border-card-border"><RefreshCw className={cn('h-4 w-4', scan.isFetching && 'animate-spin')} /></button>
          </div>
          <div className="mt-3 space-y-2" data-testid="candidate-list">
            {scan.isLoading && <StateBox>검색 결과를 불러오는 중입니다.</StateBox>}
            {scan.isError && <StateBox>검색 API 오류로 승인 기능을 잠갔습니다.</StateBox>}
            {!scan.isLoading && !scan.isError && cards.length === 0 && <StateBox>현재 조건을 모두 만족하는 종목이 없습니다.</StateBox>}
            {cards.map((card) => (
              <article key={`${market}:${card.ticker}`} className="rounded-2xl border border-card-border bg-background p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0"><p className="truncate text-sm font-black">{card.name}</p><p className="text-[10px] font-bold text-muted-foreground">{card.ticker} · 일치 {card.matchCount}/{card.selectedCount}</p></div>
                  <div className="text-right"><p className="text-sm font-black">{card.score}점</p><p className="text-[10px] font-bold text-muted-foreground">위험 {card.riskLevel ?? '확인 중'}</p></div>
                </div>
                <p className="mt-2 line-clamp-2 text-[11px] font-semibold leading-5 text-muted-foreground">{(card.matched ?? []).join(' · ') || '일치 근거 없음'}</p>
                <button type="button" onClick={() => void createApproval(card)} disabled={busy != null || number(card.price) <= 0} className="mt-2 w-full rounded-xl border border-primary bg-primary/10 px-3 py-2 text-xs font-extrabold text-primary disabled:opacity-40">{busy === card.ticker ? '서버 검증 중' : '승인 요청 만들기'}</button>
              </article>
            ))}
          </div>
        </section>
        {message && <p className="rounded-2xl border border-card-border bg-card p-3 text-xs font-bold leading-5" aria-live="polite">{message}</p>}
      </main>
      <BottomNav />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-2xl bg-secondary/60 p-2"><p className="text-[10px] font-bold text-muted-foreground">{label}</p><p className="mt-1 text-sm font-black">{value}</p></div>;
}

function StateBox({ children }: { children: ReactNode }) {
  return <div className="rounded-2xl border border-dashed border-card-border p-5 text-center text-xs font-bold text-muted-foreground">{children}</div>;
}
