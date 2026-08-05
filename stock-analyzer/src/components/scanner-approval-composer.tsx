import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, ShieldCheck } from 'lucide-react';
import { useLocation } from 'wouter';
import { authorizedFetch } from '@/lib/auth-fetch';
import type { AnalysisSelection } from '@/lib/analysis-selection';
import { safeTradeErrorMessage } from '@/lib/trade-approval-ui';
import { cn } from '@/lib/utils';

type CreatedPlan = {
  id: string;
  symbol: string;
  estimatedKrw: number;
  quantity: number | null;
  stopPrice: number;
  targetPrices: number[];
  splitRatios: number[];
  signalScore: number;
  signalConfidence: number;
  signalRiskReward: number | null;
  signalExpiresAt: string;
  state: string;
  signalState: string;
};

type CreateResponse = {
  ok?: boolean;
  error?: string;
  plan?: CreatedPlan;
  duplicate?: boolean;
  serverVerified?: boolean;
  liveOrderEnabled?: boolean;
  scanner?: {
    score?: number;
    confidence?: number;
    riskScore?: number | null;
    matchedConditions?: string[];
  };
  orderbook?: {
    ask?: number;
    bid?: number;
    spreadPercent?: number;
  };
};

const AMOUNT_STORAGE_KEY = 'scanner-approval-paper-amount-v1';
const MINIMUM_AMOUNT_KRW = 5_000;
const QUICK_AMOUNTS = [50_000, 100_000, 200_000, 500_000] as const;
const CREATE_PLAN_TIMEOUT_MS = 10_000;

function loadAmount() {
  if (typeof window === 'undefined') return 100_000;
  const value = Number(window.localStorage.getItem(AMOUNT_STORAGE_KEY));
  return Number.isFinite(value) && value >= MINIMUM_AMOUNT_KRW ? Math.round(value) : 100_000;
}

function formatNumber(value: number | null | undefined, digits = 0) {
  if (value == null || !Number.isFinite(Number(value))) return '-';
  return new Intl.NumberFormat('ko-KR', { maximumFractionDigits: digits }).format(Number(value));
}

function creationErrorMessage(code: string) {
  const labels: Record<string, string> = {
    US_ORDER_ADAPTER_NOT_AVAILABLE: '미국주식 주문 어댑터가 검증되기 전까지 승인 계획을 만들 수 없습니다.',
    SCANNER_SIGNAL_NOT_FOUND: '서버 재검색에서 해당 종목의 신호가 더 이상 확인되지 않았습니다.',
    SCANNER_AND_CONDITIONS_NOT_MAINTAINED: '선택했던 조건이 모두 유지되지 않아 승인 계획을 만들지 않았습니다.',
    SCANNER_RISK_BLOCKED: '현재 위험 점수가 허용 범위를 넘어 승인 계획이 차단됐습니다.',
    SCANNER_DUPLICATE_ACTIVE_SYMBOL: '같은 종목의 활성 계획 또는 주문이 이미 있어 중복 등록을 차단했습니다.',
    SCANNER_RISK_CAPACITY_EXHAUSTED: '남은 운용한도 또는 종목 노출한도가 부족합니다.',
    SCANNER_MINUTE_DATA_INSUFFICIENT: '1분 변동성 데이터가 부족해 계획 생성을 중단했습니다.',
    SCANNER_ORDERBOOK_INVALID: '실시간 최우선 호가를 확인할 수 없어 계획 생성을 중단했습니다.',
  };
  return labels[code] ?? safeTradeErrorMessage(code, '서버 검증형 승인 계획을 만들지 못했습니다.');
}

export function ScannerApprovalComposer({ selection }: { selection: AnalysisSelection }) {
  const [, navigate] = useLocation();
  const [amount, setAmount] = useState(loadAmount);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<CreateResponse | null>(null);
  const requestSequenceRef = useRef(0);
  const requestAbortRef = useRef<AbortController | null>(null);
  const conditions = useMemo(
    () => [...new Set((selection.matchedSignals ?? []).map(String).map((item) => item.trim()).filter(Boolean))].slice(0, 20),
    [selection.matchedSignals],
  );
  const supported = selection.assetType === 'stock' && selection.market === 'KR' && /^\d{6}(?:_(?:NX|AL))?$/.test(selection.ticker);
  const amountValid = Number.isFinite(amount) && amount >= MINIMUM_AMOUNT_KRW;

  useEffect(() => {
    requestSequenceRef.current += 1;
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
    setCreating(false);
    setResult(null);
    setMessage('');
  }, [selection.market, selection.ticker, selection.timeframe, conditions.join('|')]);

  useEffect(() => () => {
    requestSequenceRef.current += 1;
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
  }, []);

  async function createPlan() {
    if (creating) return;
    if (!supported) {
      setMessage(selection.market === 'US'
        ? '미국주식 주문 어댑터가 검증되기 전까지 승인 계획을 만들 수 없습니다.'
        : '현재는 국내주식 검색 신호의 Paper 승인 계획만 지원합니다.');
      return;
    }
    if (!conditions.length) {
      setMessage('AI 검색기에서 종목을 선택한 뒤 일치 조건이 전달돼야 합니다.');
      return;
    }
    if (!amountValid) {
      setMessage(`희망 운용금액을 ${formatNumber(MINIMUM_AMOUNT_KRW)}원 이상 입력해 주세요.`);
      return;
    }

    const sequence = requestSequenceRef.current + 1;
    requestSequenceRef.current = sequence;
    requestAbortRef.current?.abort();
    const controller = new AbortController();
    requestAbortRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), CREATE_PLAN_TIMEOUT_MS);

    setCreating(true);
    setMessage('서버가 검색 조건·실시간 호가·캔들·위험 한도를 다시 계산하고 있습니다.');
    try {
      window.localStorage.setItem(AMOUNT_STORAGE_KEY, String(Math.round(amount)));
      const response = await authorizedFetch('/api/trade-automation/scanner/plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          market: selection.market,
          symbol: selection.ticker,
          timeframe: selection.timeframe,
          selectedConditions: conditions,
          requestedInvestmentKrw: Math.round(amount),
          splitRatios: [40, 30, 30],
          minimumScore: 70,
          minimumConfidence: 60,
          maximumRiskScore: 50,
        }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({})) as CreateResponse;
      if (!response.ok || !payload.ok || !payload.plan || payload.serverVerified !== true) {
        throw new Error(payload.error ?? 'SCANNER_APPROVAL_FAILED');
      }
      if (sequence !== requestSequenceRef.current) return;
      setResult(payload);
      setMessage(payload.duplicate
        ? '같은 서버 검증 신호의 기존 승인 계획을 불러왔습니다.'
        : '서버 검증이 끝났습니다. 승인형 주문 화면에서 최종 승인할 수 있습니다.');
    } catch (error) {
      if (sequence !== requestSequenceRef.current) return;
      setResult(null);
      if (error instanceof Error && error.name === 'AbortError') {
        setMessage('서버 재검증 시간이 초과되어 계획을 생성하지 않았습니다. 최신 조건을 확인한 뒤 다시 시도해 주세요.');
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

  return (
    <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm" data-testid="scanner-approval-composer">
      <div className="flex items-start gap-2">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
        <div className="min-w-0">
          <h2 className="text-sm font-black">승인 대기 등록</h2>
          <p className="mt-1 break-keep text-[11px] leading-5 text-muted-foreground">
            화면의 가격·점수를 주문값으로 사용하지 않고 서버가 같은 조건을 다시 검색한 뒤 Paper 계획을 생성합니다.
          </p>
        </div>
      </div>

      <div className="mt-3 rounded-2xl border border-card-border bg-background p-3 text-xs">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="break-words font-extrabold">{selection.displayName} · {selection.ticker}</p>
            <p className="mt-1 text-[10px] font-bold text-muted-foreground">{selection.market} · {selection.timeframe} · 조건 {conditions.length}개</p>
          </div>
          <span className={cn('shrink-0 rounded-full px-2 py-1 text-[10px] font-extrabold', supported ? 'bg-positive/10 text-positive' : 'bg-warning/10 text-warning')}>
            {supported ? '국내 Paper 지원' : '주문 연결 미지원'}
          </span>
        </div>
        {conditions.length ? <div className="mt-2 flex flex-wrap gap-1">{conditions.slice(0, 6).map((item) => <span key={item} className="max-w-full break-words rounded-full bg-secondary px-2 py-1 text-[10px] font-bold">{item}</span>)}</div> : null}
      </div>

      <div className="mt-3 rounded-2xl border border-card-border bg-background p-3">
        <label className="block">
          <span className="text-[10px] font-bold text-muted-foreground">희망 운용금액</span>
          <div className={cn('mt-1 flex min-h-11 items-center gap-2 rounded-xl border px-3', amountValid ? 'border-card-border' : 'border-destructive/50')}>
            <input
              aria-label="승인 계획 희망 운용금액"
              aria-invalid={!amountValid}
              type="text"
              inputMode="numeric"
              value={formatNumber(amount)}
              onChange={(event) => {
                const digits = event.target.value.replace(/\D/g, '').slice(0, 12);
                setAmount(digits ? Number(digits) : 0);
              }}
              className="min-w-0 flex-1 bg-transparent text-sm font-extrabold tabular-nums outline-none"
            />
            <span className="text-xs font-bold">원</span>
          </div>
        </label>
        <div className="mt-2 grid grid-cols-4 gap-1.5" aria-label="희망 운용금액 빠른 선택">
          {QUICK_AMOUNTS.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setAmount(value)}
              aria-pressed={amount === value}
              className={cn(
                'min-h-11 rounded-xl border px-1 text-[10px] font-extrabold',
                amount === value ? 'border-primary bg-primary/10 text-primary' : 'border-card-border bg-card',
              )}
            >
              {formatNumber(value / 10_000)}만원
            </button>
          ))}
        </div>
        <p className={cn('mt-2 break-keep text-[10px] font-bold', amountValid ? 'text-muted-foreground' : 'text-destructive')}>
          최소 {formatNumber(MINIMUM_AMOUNT_KRW)}원 · 실제 계획금액은 서버 위험한도에 따라 축소될 수 있습니다.
        </p>
      </div>

      <button
        type="button"
        onClick={() => void createPlan()}
        disabled={creating || !supported || !conditions.length || !amountValid}
        className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl bg-primary px-4 py-3 text-sm font-extrabold text-primary-foreground disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
      >
        {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
        {creating ? '서버 재검증 중...' : '승인 대기 등록'}
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
            <Metric label="서버 AI 점수" value={`${formatNumber(result.plan.signalScore)}점`} />
            <Metric label="서버 신뢰도" value={`${formatNumber(result.plan.signalConfidence)}%`} />
            <Metric label="계획금액" value={`${formatNumber(result.plan.estimatedKrw)}원`} />
            <Metric label="수량" value={result.plan.quantity == null ? '서버 계산' : `${formatNumber(result.plan.quantity)}주`} />
          </div>
          <p className="mt-3 break-keep font-bold">분할 {result.plan.splitRatios.join('% / ')}% · 손절 {formatNumber(result.plan.stopPrice)} · 목표 {result.plan.targetPrices.map((item) => formatNumber(item)).join(' / ')}</p>
          <p className="mt-1 text-[10px] font-bold text-muted-foreground">실주문 비활성 · 승인 만료 {new Date(result.plan.signalExpiresAt).toLocaleString('ko-KR')}</p>
          <button type="button" onClick={() => navigate('/auto-trading')} className="mt-3 min-h-11 w-full rounded-xl border border-positive/30 bg-background px-3 font-extrabold text-positive">승인형 주문 화면에서 확인</button>
        </div>
      ) : null}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 rounded-xl bg-background p-2 text-center"><p className="text-[9px] font-bold text-muted-foreground">{label}</p><p className="mt-1 break-words font-extrabold">{value}</p></div>;
}