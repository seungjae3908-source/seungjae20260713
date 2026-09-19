import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, ShieldCheck } from 'lucide-react';
import { useLocation } from 'wouter';
import { authorizedFetch } from '@/lib/auth-fetch';
import { useAuth } from '@/lib/auth';
import type { AnalysisSelection } from '@/lib/analysis-selection';
import { safeTradeErrorMessage } from '@/lib/trade-approval-ui';
import { cn } from '@/lib/utils';

type CreatedPlan = {
  id: string;
  candidateId: string;
  market: string;
  symbol: string;
  timeframe: string;
  side: string;
  leverage: number | null;
  leverageProvenance: 'CANONICAL_SIMULATION_DATA_EVIDENCE' | 'NOT_APPLICABLE_CASH_OR_SPOT';
  quantity: number | null;
  entryPrice: number | null;
  notional: number | null;
  costPolicyVersion: string;
  strategyId: string;
  parameterHash: string;
  signalExpiresAt: string;
  state: string;
  executionAuthority: 'NONE';
};

type CreateResponse = {
  ok?: boolean;
  error?: string;
  plan?: CreatedPlan;
  duplicate?: boolean;
  serverVerified?: boolean;
  executionConnected?: boolean;
  liveOrderEnabled?: boolean;
  orderSubmitted?: boolean;
  exchangeRequestSent?: boolean;
  evidenceCredit?: number;
  naturalSampleCredit?: number;
  profitabilityClaimAllowed?: boolean;
};

type ScannerApprovalComposerProps = {
  selection: AnalysisSelection;
  testOnlyCanPlaceOrders?: boolean;
};

const CREATE_PLAN_TIMEOUT_MS = 10_000;
const supportedMarkets = ['KR', 'US', 'UPBIT', 'BITGET'] as const;
const US_ORDER_ADAPTER_AVAILABLE = supportedMarkets.includes('US');

function formatNumber(value: number | null | undefined, digits = 4) {
  if (value == null || !Number.isFinite(Number(value))) return '-';
  return new Intl.NumberFormat('ko-KR', { maximumFractionDigits: digits }).format(Number(value));
}

function creationErrorMessage(code: string) {
  const labels: Record<string, string> = {
    CAPABILITY_REQUIRED: '모의매매는 준회원 이상에서 사용할 수 있습니다.',
    SCANNER_SIGNAL_NOT_FOUND: '서버 재검색에서 해당 신호가 더 이상 확인되지 않았습니다.',
    SCANNER_AND_CONDITIONS_NOT_MAINTAINED: '선택했던 조건이 유지되지 않아 Paper 계획을 만들지 않았습니다.',
    APPROVAL_MODE_REQUIRED: '승인형 Paper 모드만 사용할 수 있습니다.',
    PAPER_ACCOUNT_MODE_REQUIRED: 'Paper 계정 모드만 사용할 수 있습니다.',
    PAPER_ADAPTER_REQUIRED: '서버가 선택한 Paper 어댑터만 사용할 수 있습니다.',
    LIVE_MODE_FORBIDDEN: '실전 계좌와 live 어댑터는 사용할 수 없습니다.',
    CLIENT_PAPER_AUTHORITY_FORBIDDEN: '브라우저가 Paper evidence·실행 권한을 지정할 수 없습니다.',
    SERVER_LEVERAGE_PROVENANCE_REQUIRED: '레버리지는 서버 evidence로만 결정됩니다.',
    SERVER_OWNED_SCANNER_PAPER_EVIDENCE_REQUIRED: '서버가 보유한 Paper admission·위험·수익성 evidence가 아직 준비되지 않아 계획을 만들지 않았습니다.',
    CANONICAL_PAPER_ADMISSION_BLOCKED: 'Canonical Paper admission 검증을 통과하지 못했습니다.',
    SCANNER_CANONICAL_IDENTITY_CONTINUITY_MISMATCH: '검색 신호와 Paper candidate identity가 일치하지 않아 차단했습니다.',
    CANONICAL_PAPER_SIMULATION_BLOCKED: '공개시장 evidence 기반 모의체결 조건을 충족하지 못했습니다.',
    CANONICAL_PAPER_CYCLE_BLOCKED: 'Paper cycle의 진입 조건을 충족하지 못해 포지션을 만들지 않았습니다.',
    PAPER_SOURCE_NOT_RESOLVABLE: '서버 신호 참조가 없거나 만료됐습니다.',
  };
  return labels[code] ?? safeTradeErrorMessage(code, '서버 검증형 Paper 계획을 만들지 못했습니다.');
}

function marketDirectionSupported(selection: AnalysisSelection) {
  if (selection.market === 'KR') return selection.action === 'BUY' && /^\d{6}(?:_(?:NX|AL))?$/.test(selection.ticker);
  if (selection.market === 'US') return US_ORDER_ADAPTER_AVAILABLE && selection.action === 'BUY' && selection.ticker.trim().length > 0;
  if (selection.market === 'UPBIT') return selection.action === 'BUY' && selection.ticker.trim().length > 0;
  if (selection.market === 'BITGET') return (selection.action === 'LONG' || selection.action === 'SHORT') && selection.ticker.trim().length > 0;
  return false;
}

export function ScannerApprovalComposer({ selection, testOnlyCanPlaceOrders = false }: ScannerApprovalComposerProps) {
  const auth = useAuth();
  const fixtureCanPlaceOrders = import.meta.env.DEV
    && testOnlyCanPlaceOrders
    && typeof window !== 'undefined'
    && window.location.pathname === '/__phase12-trade-automation-e2e';
  const canAccessPaperTrading = auth.can('canAccessPaperTrading') || fixtureCanPlaceOrders;
  const [, navigate] = useLocation();
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<CreateResponse | null>(null);
  const requestSequenceRef = useRef(0);
  const requestAbortRef = useRef<AbortController | null>(null);
  const conditions = useMemo(
    () => [...new Set((selection.matchedSignals ?? []).map(String).map((item) => item.trim()).filter(Boolean))].slice(0, 20),
    [selection.matchedSignals],
  );
  const supported = supportedMarkets.includes(selection.market as typeof supportedMarkets[number])
    && marketDirectionSupported(selection);

  useEffect(() => {
    requestSequenceRef.current += 1;
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
    setCreating(false);
    setResult(null);
    setMessage('');
  }, [selection.market, selection.ticker, selection.timeframe, selection.action, selection.searchRunId, selection.signalId, conditions.join('|')]);

  useEffect(() => () => {
    requestSequenceRef.current += 1;
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
  }, []);

  async function createPlan() {
    if (!canAccessPaperTrading || creating) return;
    if (!supported) {
      setMessage('이 시장의 Paper 진입 방향이 명시되지 않았거나 지원 계약과 일치하지 않습니다.');
      return;
    }
    if (!conditions.length) {
      setMessage('AI 검색기에서 종목을 선택한 뒤 일치 조건이 전달돼야 합니다.');
      return;
    }
    if (!selection.searchRunId || !selection.signalId || !selection.action) {
      setMessage('서버 검색 run·signal 참조와 explicit BUY/LONG/SHORT 방향이 필요합니다.');
      return;
    }

    const sequence = requestSequenceRef.current + 1;
    requestSequenceRef.current = sequence;
    requestAbortRef.current?.abort();
    const controller = new AbortController();
    requestAbortRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), CREATE_PLAN_TIMEOUT_MS);

    setCreating(true);
    setMessage('서버가 동일 신호 identity와 canonical Paper evidence를 다시 검증하고 있습니다.');
    try {
      const response = await authorizedFetch('/api/trade-automation/scanner/plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'approval',
          accountMode: 'paper',
          adapter: 'paper',
          market: selection.market,
          symbol: selection.ticker,
          timeframe: selection.timeframe,
          searchRunId: selection.searchRunId,
          signalId: selection.signalId,
          side: selection.action,
          selectedConditions: conditions,
        }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({})) as CreateResponse;
      if (!response.ok || !payload.ok || !payload.plan || payload.serverVerified !== true || payload.executionConnected !== true) {
        throw new Error(payload.error ?? 'SCANNER_APPROVAL_FAILED');
      }
      if (payload.orderSubmitted !== false || payload.exchangeRequestSent !== false || payload.evidenceCredit !== 0) {
        throw new Error('SCANNER_PAPER_SAFETY_CONTRACT_VIOLATION');
      }
      if (sequence !== requestSequenceRef.current || controller.signal.aborted) return;
      setResult(payload);
      setMessage(payload.duplicate
        ? '같은 canonical signal의 기존 Paper 포지션을 확인했습니다.'
        : '서버 canonical 검증을 통과해 Paper-only 포지션이 생성됐습니다.');
    } catch (error) {
      if (sequence !== requestSequenceRef.current) return;
      setResult(null);
      if (error instanceof Error && error.name === 'AbortError') {
        setMessage('서버 재검증 시간이 초과되어 계획을 만들지 않았습니다.');
        return;
      }
      const code = error instanceof Error ? error.message : 'SCANNER_APPROVAL_FAILED';
      setMessage(creationErrorMessage(code));
    } finally {
      window.clearTimeout(timeout);
      if (requestAbortRef.current === controller) requestAbortRef.current = null;
      if (sequence === requestSequenceRef.current) setCreating(false);
    }
  }

  if (!canAccessPaperTrading) {
    return (
      <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm" data-testid="scanner-approval-admin-only">
        <div className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <h2 className="text-sm font-black">검색·분석 전용</h2>
            <p className="mt-1 break-keep text-[11px] leading-5 text-muted-foreground">모의매매는 준회원 이상에서 사용할 수 있습니다.</p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm" data-testid="scanner-approval-composer">
      <div className="flex items-start gap-2">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
        <div className="min-w-0">
          <h2 className="text-sm font-black">Canonical Paper 연결</h2>
          <p className="mt-1 break-keep text-[11px] leading-5 text-muted-foreground">
            브라우저 값으로 체결을 만들지 않습니다. 서버가 동일 신호·전략 identity, 위험, 비용, 공개시장 evidence를 검증한 경우에만 모의 포지션을 생성합니다.
          </p>
        </div>
      </div>

      <div className="mt-3 rounded-2xl border border-card-border bg-background p-3 text-xs">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="break-words font-extrabold">{selection.displayName} · {selection.ticker}</p>
            <p className="mt-1 text-[10px] font-bold text-muted-foreground">{selection.market} · {selection.timeframe} · {selection.action ?? '방향 없음'} · 조건 {conditions.length}개</p>
          </div>
          <span className={cn('shrink-0 rounded-full px-2 py-1 text-[10px] font-extrabold', supported ? 'bg-positive/10 text-positive' : 'bg-warning/10 text-warning')}>
            {supported ? 'Paper 지원' : '진입 방향 미지원'}
          </span>
        </div>
        {conditions.length ? <div className="mt-2 flex flex-wrap gap-1">{conditions.slice(0, 6).map((item) => <span key={item} className="max-w-full break-words rounded-full bg-secondary px-2 py-1 text-[10px] font-bold">{item}</span>)}</div> : null}
      </div>

      <div className="mt-3 rounded-2xl border border-card-border bg-background p-3 text-[10px] font-bold leading-5 text-muted-foreground">
        KR·US·현물은 BUY, 선물은 LONG/SHORT만 허용합니다. 수량·레버리지·진입가격은 client가 지정하지 않고 서버 canonical risk/simulation owner가 결정합니다.
      </div>

      <button
        type="button"
        onClick={() => void createPlan()}
        disabled={creating || !supported || !conditions.length}
        className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl bg-primary px-4 py-3 text-sm font-extrabold text-primary-foreground disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
      >
        {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
        {creating ? 'Canonical 검증 중...' : 'Paper 포지션 준비'}
      </button>

      {message ? (
        <div role="status" className={cn('mt-3 flex items-start gap-2 rounded-2xl border p-3 text-xs', result ? 'border-positive/30 bg-positive/10' : 'border-warning/30 bg-warning/10')}>
          {result ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-positive" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />}
          <p className="break-keep leading-5">{message}</p>
        </div>
      ) : null}

      {result?.plan ? (
        <div className="mt-3 rounded-2xl border border-positive/30 bg-positive/5 p-3 text-xs">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Metric label="시장/방향" value={`${result.plan.market} · ${result.plan.side}`} />
            <Metric label="서버 leverage" value={result.plan.leverage == null ? 'N/A' : `${formatNumber(result.plan.leverage)}x`} />
            <Metric label="수량" value={formatNumber(result.plan.quantity)} />
            <Metric label="모의 진입가" value={formatNumber(result.plan.entryPrice)} />
          </div>
          <p className="mt-3 break-all font-bold">Candidate {result.plan.candidateId}</p>
          <p className="mt-1 break-keep text-[10px] font-bold text-muted-foreground">
            executionAuthority=NONE · 실제 주문 없음 · 경제적 evidence credit=0 · 만료 {new Date(result.plan.signalExpiresAt).toLocaleString('ko-KR')}
          </p>
          <button type="button" onClick={() => navigate('/paper-trading')} className="mt-3 min-h-11 w-full rounded-xl border border-positive/30 bg-background px-3 font-extrabold text-positive">
            모의매매 화면에서 확인
          </button>
        </div>
      ) : null}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 rounded-xl bg-background p-2 text-center"><p className="text-[9px] font-bold text-muted-foreground">{label}</p><p className="mt-1 break-words font-extrabold">{value}</p></div>;
}
