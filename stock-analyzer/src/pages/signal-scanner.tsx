import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { useAssetMode } from '@/lib/asset-mode';
import {
  selectionQuery,
  useAnalysisSelection,
  type AnalysisSelection,
  type AnalysisMarket,
} from '@/lib/analysis-selection';
import {
  fetchSignalScanner,
  signalScannerDetailPath,
  SignalScannerRequestError,
  type ScannerAlertCandidate,
  type ScannerResponse,
  type ScannerSignalCard,
  type ScannerStrategyMode,
  type SignalScannerRequest,
} from '@/lib/signal-scanner';

type ScannerView = 'KR' | 'US' | 'SPOT' | 'FUTURES';
type RequestStatus = 'loading' | 'success' | 'empty' | 'partial' | 'cancelled' | 'error';

const STOCK_CONDITIONS = [
  '거래량 증가',
  '거래대금 증가',
  '이평선 돌파',
  'RSI 과매도 반등',
  'MACD 골든크로스',
  '뉴스 호재',
  '공시 호재',
  'PER 낮음',
  'PBR 낮음',
  'AI 점수 상위',
] as const;

const COIN_CONDITIONS = [
  { value: 'trend', label: '추세' },
  { value: 'volume', label: '거래량' },
  { value: 'breakout', label: '돌파' },
  { value: 'pullback', label: '눌림' },
] as const;

const VIEWS: Array<{ value: ScannerView; label: string; description: string }> = [
  { value: 'KR', label: '국내주식', description: 'KRX 주식·ETF·ETN' },
  { value: 'US', label: '미국주식', description: '미국 주식·ETF' },
  { value: 'SPOT', label: '코인 현물', description: 'Upbit KRW 현물' },
  { value: 'FUTURES', label: '코인 선물', description: 'Bitget USDT 선물' },
];

const STRATEGY_TIMEFRAMES: Record<ScannerStrategyMode, readonly SignalScannerRequest['timeframe'][]> = {
  scalping: ['1m', '3m', '5m'],
  swing: ['4H', '1D'],
};

function requestErrorMessage(error: unknown): string {
  if (error instanceof SignalScannerRequestError) {
    if (error.status === 401) return '로그인이 만료됐습니다. 다시 로그인한 뒤 재시도해 주세요.';
    if (error.status === 403) return '현재 회원 등급으로 이 시장의 AI 검색기를 사용할 수 없습니다.';
    if (error.status === 409) return '동일 조건 분석이 이미 진행 중입니다. 기존 결과를 유지하며 완료를 기다립니다.';
    if (error.status === 429) {
      const retry = error.retryAfterSeconds == null ? '' : ` ${error.retryAfterSeconds}초 후`;
      return `검색 요청 한도를 보호하고 있습니다.${retry} 다음 갱신을 기다립니다.`;
    }
    if (error.status === 502) return '시장데이터 공급자 응답이 불안정합니다. 마지막 정상 결과가 있으면 유지합니다.';
    if (error.code.includes('STRATEGY_TIMEFRAME_MISMATCH')) return '단타/스윙 전략과 시간봉 조합이 맞지 않습니다.';
    return `검색 요청 실패: ${error.code}`;
  }
  if (error instanceof Error && error.name === 'AbortError') return '이전 검색 요청을 취소했습니다.';
  return error instanceof Error ? error.message : '검색 요청 중 알 수 없는 오류가 발생했습니다.';
}

function formatNumber(value: number | null | undefined, maximumFractionDigits = 2): string {
  if (value == null || !Number.isFinite(value)) return '미확인';
  return value.toLocaleString('ko-KR', { maximumFractionDigits });
}

function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '미확인';
  return `${value.toFixed(digits)}%`;
}

function stateLabel(state: ScannerSignalCard['signalState']): string {
  const labels: Record<ScannerSignalCard['signalState'], string> = {
    CANDIDATE: '후보',
    CONFIRMED: '확인',
    ARMED: '진입 감시',
    ENTRY_ZONE: '진입 구간',
    APPROVAL_PENDING: '승인 대기',
    APPROVED: '승인됨',
    EXECUTING: '실행 중',
    PARTIALLY_FILLED: '부분 체결',
    FILLED: '체결 완료',
    MANAGING: '포지션 관리',
    CLOSED: '종료',
    INVALIDATED: '무효',
    EXPIRED: '만료',
    REJECTED: '거절',
    CANCELLED: '취소',
    DETECTED: '감지',
    WATCHING: '감시 중',
    READY_FOR_APPROVAL: '진입 검토 준비',
    WEAKENED: '약화',
  };
  return labels[state];
}

function actionLabel(card: ScannerSignalCard): string {
  if (card.signalGrade === 'B') return 'WATCH · 관찰';
  if (card.action === 'BUY') return 'BUY · 매수 검토';
  if (card.action === 'SELL') return 'SELL · 보유분 축소 검토';
  if (card.action === 'LONG') return 'LONG · 롱 검토';
  if (card.action === 'SHORT') return 'SHORT · 숏 검토';
  return 'ACTION 미확인';
}

function alertTitle(alert: ScannerAlertCandidate): string {
  const action = alert.action && alert.action !== 'NONE' ? alert.action : 'SIGNAL';
  return `${action} 승인 대기 · ${alert.symbol}`;
}

function analysisMarket(card: ScannerSignalCard): AnalysisMarket {
  if (card.assetClass === 'coin_spot') return 'UPBIT';
  if (card.assetClass === 'coin_futures') return 'BITGET';
  return card.market === 'US' ? 'US' : 'KR';
}

export default function SignalScannerPage({ embedded = false }: { embedded?: boolean }) {
  const [, navigate] = useLocation();
  const assetMode = useAssetMode();
  const analysisSelection = useAnalysisSelection();
  const initialView: ScannerView = assetMode.asset === 'coin'
    ? assetMode.coinMarket === 'futures' ? 'FUTURES' : 'SPOT'
    : assetMode.stockMarket;
  const initialStrategy: ScannerStrategyMode = initialView === 'KR' || initialView === 'US' ? 'swing' : 'scalping';
  const [view, setView] = useState<ScannerView>(initialView);
  const [strategy, setStrategy] = useState<ScannerStrategyMode>(initialStrategy);
  const [timeframe, setTimeframe] = useState<SignalScannerRequest['timeframe']>(initialStrategy === 'scalping' ? '5m' : '1D');
  const [conditions, setConditions] = useState<string[]>([]);
  const [coinCondition, setCoinCondition] = useState<SignalScannerRequest['condition']>('trend');
  const [minimumScore, setMinimumScore] = useState(55);
  const [maximumRiskScore, setMaximumRiskScore] = useState(70);
  const [cursor, setCursor] = useState(0);
  const [refreshToken, setRefreshToken] = useState(0);
  const [status, setStatus] = useState<RequestStatus>('loading');
  const [data, setData] = useState<ScannerResponse | null>(null);
  const dataRef = useRef<ScannerResponse | null>(null);
  dataRef.current = data;
  const [errorMessage, setErrorMessage] = useState('');
  const latestSequence = useRef(0);
  const lastGeneratedAt = useRef<string | null>(null);
  const displayedRequestKey = useRef<string | null>(null);

  const normalizedCards = useMemo(() => {
    if (!data?.cards) return [];
    const map = new Map<string, ScannerSignalCard>();
    for (const card of data.cards) {
      if (!map.has(card.symbol)) map.set(card.symbol, card);
    }
    return Array.from(map.values());
  }, [data?.cards]);

  const stockView = view === 'KR' || view === 'US';
  const batchSize = stockView ? 100 : 24;
  const request = useMemo<SignalScannerRequest>(() => ({
    assetClass: stockView ? 'stock' : view === 'SPOT' ? 'coin_spot' : 'coin_futures',
    market: view === 'KR' ? 'KR' : view === 'US' ? 'US' : view === 'SPOT' ? 'UPBIT' : 'BITGET',
    strategy,
    timeframe,
    conditions,
    condition: coinCondition,
    cursor,
    batchSize,
    minimumScore,
    maximumRiskScore,
  }), [batchSize, coinCondition, conditions, cursor, maximumRiskScore, minimumScore, stockView, strategy, timeframe, view]);
  const requestKey = useMemo(() => JSON.stringify(request), [request]);

  useEffect(() => {
    setCursor(0);
    if (view === 'KR' || view === 'US') {
      assetMode.setAsset('stock');
      assetMode.setStockMarket(view);
    } else {
      assetMode.setAsset('coin');
      assetMode.setCoinMarket(view === 'FUTURES' ? 'futures' : 'spot');
    }
  }, [view]);

  useEffect(() => {
    lastGeneratedAt.current = null;
  }, [requestKey]);

  useEffect(() => {
    const controller = new AbortController();
    const sequence = latestSequence.current + 1;
    latestSequence.current = sequence;
    if (displayedRequestKey.current !== requestKey) setStatus('loading');
    setErrorMessage('');

    void fetchSignalScanner(request, controller.signal)
      .then((result) => {
        if (controller.signal.aborted || latestSequence.current !== sequence) return;
        if (lastGeneratedAt.current && new Date(result.generatedAt) < new Date(lastGeneratedAt.current)) return;
        lastGeneratedAt.current = result.generatedAt;
        displayedRequestKey.current = requestKey;
        setErrorMessage(result.refreshIssue?.message ?? '');
        setData(result);
        setStatus(
          result.execution.partial
            || result.dataState === 'partial'
            || result.dataState === 'stale'
            || result.dataState === 'untrusted'
            ? 'partial'
            : result.cards.length === 0
              ? 'empty'
              : 'success',
        );
      })
      .catch((error: unknown) => {
        if (latestSequence.current !== sequence) return;
        if (controller.signal.aborted) {
          if (displayedRequestKey.current !== requestKey) setStatus('cancelled');
          return;
        }
        const message = requestErrorMessage(error);
        setErrorMessage(message);
        if (error instanceof SignalScannerRequestError && (error.status === 409 || error.status === 429 || error.status === 502) && dataRef.current) {
          setStatus('partial');
          return;
        }
        setStatus('error');
      });

    return () => controller.abort();
  }, [request, requestKey, refreshToken]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') setRefreshToken((value) => value + 1);
    };
    document.addEventListener('visibilitychange', refreshWhenVisible);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') setRefreshToken((value) => value + 1);
    }, 30_000);
    return () => {
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      window.clearInterval(timer);
    };
  }, []);

  const selectView = (next: ScannerView) => {
    if (next === view) return;
    setCursor(0);
    setView(next);
  };

  const selectStrategy = (next: ScannerStrategyMode) => {
    if (next === strategy) return;
    setCursor(0);
    setStrategy(next);
    setTimeframe(next === 'scalping' ? '5m' : '1D');
  };

  const toggleCondition = (condition: string) => {
    setCursor(0);
    setConditions((current) => current.includes(condition)
      ? current.filter((item) => item !== condition)
      : [...current, condition]);
  };

  const openInAiChart = (card: ScannerSignalCard) => {
    const selection: AnalysisSelection = {
      assetType: card.assetClass,
      market: analysisMarket(card),
      symbol: card.symbol,
      ticker: card.symbol,
      displayName: card.name,
      timeframe: data?.timeframe ?? timeframe,
      searchRunId: data?.requestId,
      signalScore: card.score,
      signalRank: card.candidateRanking?.rank,
      confidence: card.confidence,
      riskLevel: card.riskLevel,
      action: card.action,
      pricePlan: card.pricePlan,
      matchedSignals: card.matched,
      reasons: card.evidence
        .filter((item) => item.status === 'matched')
        .flatMap((item) => item.reasons)
        .slice(0, 20),
      selectedAt: new Date().toISOString(),
    };
    analysisSelection.select(selection);
    if (!embedded) navigate(`/ai-chart?${selectionQuery(selection)}`);
  };

  const timeframes = STRATEGY_TIMEFRAMES[strategy];

  return (
    <main className={`min-h-0 bg-background ${embedded ? 'h-full overflow-y-auto' : 'min-h-screen pb-24'}`}>
      <div className="mx-auto w-full max-w-6xl space-y-4 p-3 sm:p-5">
        <header className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-primary">공개 시장데이터 전용 · Adaptive TOP 10</p>
              <h1 className="mt-1 text-xl font-black">AI 신호검색기</h1>
              <p className="mt-1 max-w-3xl break-keep text-xs leading-relaxed text-muted-foreground">
                Hard Risk Filter는 유지하고, 통과 후보를 상대순위·전략 품질로 비교합니다. S/A가 없으면 기준을 낮추지 않고 B 관찰 후보만 표시합니다. 계좌·주문·취소·포지션 API는 호출하지 않습니다.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setRefreshToken((value) => value + 1)}
              className="min-h-11 shrink-0 rounded-xl bg-primary px-4 text-sm font-bold text-primary-foreground"
            >
              새로고침
            </button>
          </div>
        </header>

        <section aria-label="검색 시장" className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {VIEWS.map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={view === item.value}
              onClick={() => selectView(item.value)}
              className={`min-h-14 min-w-0 rounded-2xl border px-3 py-2 text-left ${
                view === item.value ? 'border-primary bg-primary/10' : 'border-card-border bg-card'
              }`}
            >
              <span className="block break-keep text-sm font-black">{item.label}</span>
              <span className="block break-keep text-[11px] text-muted-foreground">{item.description}</span>
            </button>
          ))}
        </section>

        <section aria-label="검색 전략" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <button
            type="button"
            aria-pressed={strategy === 'scalping'}
            onClick={() => selectStrategy('scalping')}
            className={`min-h-16 rounded-2xl border px-4 py-3 text-left ${
              strategy === 'scalping' ? 'border-primary bg-primary/10' : 'border-card-border bg-card'
            }`}
          >
            <span className="block break-keep text-sm font-black">단타 Engine</span>
            <span className="block break-keep text-[11px] text-muted-foreground">1m · 3m · 5m / 15m context</span>
          </button>
          <button
            type="button"
            aria-pressed={strategy === 'swing'}
            onClick={() => selectStrategy('swing')}
            className={`min-h-16 rounded-2xl border px-4 py-3 text-left ${
              strategy === 'swing' ? 'border-primary bg-primary/10' : 'border-card-border bg-card'
            }`}
          >
            <span className="block break-keep text-sm font-black">스윙 Engine</span>
            <span className="block break-keep text-[11px] text-muted-foreground">4H · 1D / 1H context</span>
          </button>
        </section>

        <section className="rounded-3xl border border-card-border bg-card p-4">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <label className="space-y-1 text-xs font-bold">
              시간봉
              <select
                value={timeframe}
                onChange={(event) => { setCursor(0); setTimeframe(event.target.value as SignalScannerRequest['timeframe']); }}
                className="min-h-11 w-full rounded-xl border border-card-border bg-background px-3 text-sm"
              >
                {timeframes.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </label>
            <label className="space-y-1 text-xs font-bold">
              신호 점수 선호 {minimumScore}
              <input
                aria-label="신호 점수 선호"
                type="range"
                min="0"
                max="100"
                value={minimumScore}
                onChange={(event) => { setCursor(0); setMinimumScore(Number(event.target.value)); }}
                className="min-h-11 w-full"
              />
              <span className="block break-keep text-[10px] font-normal text-muted-foreground">미달 후보를 삭제하지 않고 순위에만 불리하게 반영합니다.</span>
            </label>
            <label className="space-y-1 text-xs font-bold">
              최대 위험점수 {maximumRiskScore}
              <input
                aria-label="최대 위험점수"
                type="range"
                min="0"
                max="100"
                value={maximumRiskScore}
                onChange={(event) => { setCursor(0); setMaximumRiskScore(Number(event.target.value)); }}
                className="min-h-11 w-full"
              />
            </label>
            <div className="space-y-1 text-xs font-bold">
              현재 묶음
              <div className="flex min-h-11 items-center justify-between rounded-xl border border-card-border bg-background px-3 text-sm">
                <span>{cursor + 1}번째부터</span>
                <span>{batchSize}종목</span>
              </div>
            </div>
          </div>

          <details className="mt-4 rounded-2xl border border-card-border bg-background p-3" open={!stockView}>
            <summary className="cursor-pointer break-keep text-xs font-black">고급 조건</summary>
            <div className="mt-3 flex flex-wrap gap-2">
              {stockView
                ? STOCK_CONDITIONS.map((condition) => (
                    <button
                      key={condition}
                      type="button"
                      aria-pressed={conditions.includes(condition)}
                      onClick={() => toggleCondition(condition)}
                      className={`min-h-11 rounded-xl border px-3 text-xs font-bold ${
                        conditions.includes(condition)
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-card-border bg-card'
                      }`}
                    >
                      {condition}
                    </button>
                  ))
                : COIN_CONDITIONS.map((condition) => (
                    <button
                      key={condition.value}
                      type="button"
                      aria-pressed={coinCondition === condition.value}
                      onClick={() => { setCursor(0); setCoinCondition(condition.value); }}
                      className={`min-h-11 rounded-xl border px-3 text-xs font-bold ${
                        coinCondition === condition.value
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-card-border bg-card'
                      }`}
                    >
                      {condition.label}
                    </button>
                  ))}
            </div>
            {stockView && (
              <p className="mt-2 break-keep text-[10px] text-muted-foreground">
                {conditions.length === 0 ? '종합 탐색 · 특정 조건 강제 없음' : `선택 ${conditions.length}개 · Soft evidence로 사용`}
              </p>
            )}
          </details>
        </section>

        {status === 'loading' && (
          <section aria-live="polite" className="rounded-3xl border border-card-border bg-card p-8 text-center">
            <p className="font-bold">시장데이터를 분석하고 있습니다.</p>
            <p className="mt-2 break-keep text-xs text-muted-foreground">같은 조건의 중복 요청은 합쳐서 처리하고 제한된 묶음·동시성·deadline을 유지합니다.</p>
          </section>
        )}

        {status === 'cancelled' && (
          <section aria-live="polite" className="rounded-3xl border border-card-border bg-card p-5 text-sm">
            이전 조건의 요청을 취소하고 최신 조건으로 다시 분석합니다.
          </section>
        )}

        {errorMessage && status === 'partial' && (
          <section role="alert" className="rounded-3xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
            <p className="font-black">최신 결과 갱신 대기</p>
            <p className="mt-1 break-keep text-xs text-muted-foreground">{errorMessage}</p>
          </section>
        )}

        {status === 'error' && (
          <section role="alert" className="rounded-3xl border border-destructive/40 bg-destructive/10 p-5">
            <p className="font-black text-destructive">검색 실패</p>
            <p className="mt-2 break-keep text-sm">{errorMessage}</p>
            <button
              type="button"
              onClick={() => setRefreshToken((value) => value + 1)}
              className="mt-4 min-h-11 rounded-xl border border-destructive/30 px-4 text-sm font-bold"
            >
              다시 시도
            </button>
          </section>
        )}

        {data && status !== 'loading' && status !== 'error' && (
          <>
            <section
              data-testid={status === 'partial' ? 'scanner-partial' : undefined}
              className={`rounded-3xl border p-4 ${status === 'partial' ? 'border-amber-500/40 bg-amber-500/10' : 'border-card-border bg-card'}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="break-keep text-sm font-black">{data.message}</p>
                  <p className="mt-1 break-keep text-xs text-muted-foreground">
                    {strategy === 'scalping' ? '단타' : '스윙'} · {data.timeframe} · 기준 {new Date(data.generatedAt).toLocaleString('ko-KR')} · {data.universe.source}
                  </p>
                </div>
                <span className="shrink-0 rounded-full border border-card-border px-3 py-1 text-xs font-bold">{data.dataState}</span>
              </div>
              {(data.execution.sGradeCount ?? 0) + (data.execution.aGradeCount ?? 0) === 0 && normalizedCards.length > 0 && (
                <div className="mt-3 rounded-xl border border-amber-500/30 bg-background p-3 break-keep text-sm font-black">
                  현재 진입 가능한 강한 신호 없음 · 기준을 완화하지 않고 B 관찰 후보만 표시합니다.
                </div>
              )}
              <div className="mt-3 grid grid-cols-2 gap-2 text-center sm:grid-cols-5">
                {[
                  ['스캔', data.execution.requestedCount],
                  ['분석 완료', data.execution.dataSuccessCount ?? data.execution.completedCount],
                  ['조건 통과', data.execution.finalDisplayedCount ?? normalizedCards.length],
                  ['데이터 부족', data.execution.insufficientDataCount ?? '미집계'],
                  ['Provider 오류', data.execution.providerErrorCount],
                ].map(([label, value]) => (
                  <div key={String(label)} className="rounded-xl bg-background p-2">
                    <p className="break-keep text-[10px] text-muted-foreground">{label}</p>
                    <p className="text-sm font-black">{value}</p>
                  </div>
                ))}
              </div>
              <details className="mt-3 rounded-2xl border border-card-border/60 bg-background p-3">
                <summary className="cursor-pointer text-xs font-black">진단 상세</summary>
                <div className="mt-3 grid grid-cols-3 gap-2 text-center sm:grid-cols-6 xl:grid-cols-12">
                  {[
                    ['Universe', data.universe.totalCount],
                    ['요청', data.execution.requestedCount],
                    ['시작', data.execution.startedCount],
                    ['완료', data.execution.completedCount],
                    ['Hard 통과', data.execution.hardFilterPassCount ?? '미집계'],
                    ['Hard 제외', data.execution.hardFilterRejectedCount ?? '미집계'],
                    ['Soft 후보', data.execution.softCandidateCount ?? '미집계'],
                    ['최종', data.execution.finalDisplayedCount ?? normalizedCards.length],
                    ['S', data.execution.sGradeCount ?? 0],
                    ['A', data.execution.aGradeCount ?? 0],
                    ['B', data.execution.bGradeCount ?? 0],
                    ['BT 미검증', data.execution.backtestMissingCount ?? 0],
                  ].map(([label, value]) => (
                    <div key={String(label)} className="rounded-xl bg-card p-2">
                      <p className="text-[10px] text-muted-foreground">{label}</p>
                      <p className="text-sm font-black">{value}</p>
                    </div>
                  ))}
                </div>
              </details>
            </section>

            {data.alerts.length > 0 && (
              <section aria-label="승인 대기 알림" className="rounded-3xl border border-primary/40 bg-primary/10 p-4">
                <h2 className="font-black">APPROVAL_PENDING 알림</h2>
                <p className="mt-1 break-keep text-xs text-muted-foreground">앱 내부 상태만 표시합니다. 선택은 상세 정보만 열며 주문을 실행하지 않습니다.</p>
                <div className="mt-3 space-y-2">
                  {data.alerts.map((alert) => (
                    <button
                      key={alert.idempotencyKey}
                      type="button"
                      onClick={() => {
                        const card = normalizedCards.find((item) => item.signalId === alert.signalId);
                        if (card) navigate(signalScannerDetailPath(card));
                      }}
                      className="min-h-11 w-full rounded-xl border border-primary/30 bg-card px-3 py-2 text-left text-sm"
                    >
                      <span className="break-keep font-black">{alertTitle(alert)}</span>
                      <span className="ml-2 break-keep text-xs text-muted-foreground">만료 {new Date(alert.expiresAt).toLocaleTimeString('ko-KR')}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {data.failures.length > 0 && (
              <section className="rounded-3xl border border-amber-500/40 bg-amber-500/10 p-4">
                <h2 className="break-keep font-black">분석하지 못한 종목 {data.failures.length}개</h2>
                <div className="mt-2 flex flex-wrap gap-2">
                  {data.failures.slice(0, 20).map((failure) => (
                    <span key={`${failure.symbol}:${failure.reason}`} className="rounded-lg bg-background px-2 py-1 text-xs">
                      {failure.symbol} · {failure.reason}
                    </span>
                  ))}
                </div>
              </section>
            )}

            {normalizedCards.length === 0 ? (
              <section className="rounded-3xl border border-card-border bg-card p-8 text-center">
                <p className="break-keep font-black">Hard Risk Filter를 통과한 후보가 없습니다.</p>
                <p className="mt-2 break-keep text-xs text-muted-foreground">stale·거래불가·유동성·spread·데이터 품질 기준을 자동 완화하지 않았습니다.</p>
              </section>
            ) : (
              <section className="grid gap-3 xl:grid-cols-2">
                {normalizedCards.map((card) => {
                  const backtest = card.backtestQuality;
                  const ranking = card.candidateRanking;
                  return (
                    <article key={card.signalId} className="min-w-0 rounded-3xl border border-card-border bg-card p-4">
                      <div className="flex items-start justify-between gap-3">
                        <button type="button" onClick={() => navigate(signalScannerDetailPath(card))} className="min-h-11 min-w-0 text-left">
                          <p className="truncate font-black">{ranking?.rank ? `${ranking.rank}위 · ` : ''}{card.name}</p>
                          <p className="truncate text-xs text-muted-foreground">{card.symbol} · {card.market} · {card.assetType}</p>
                        </button>
                        <div className="shrink-0 text-right">
                          <p className="text-sm font-black">{formatNumber(card.price, card.currency === 'KRW' ? 0 : 6)}</p>
                          <p className="text-xs text-muted-foreground">{card.changePercent == null ? '변동 미확인' : `${card.changePercent >= 0 ? '+' : ''}${card.changePercent.toFixed(2)}%`}</p>
                        </div>
                      </div>

                      <div className="mt-3 grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
                        <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">Action</p><p className="break-keep text-sm font-black">{card.signalGrade === 'B' ? 'WATCH' : card.action ?? '미확인'}</p></div>
                        <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">Score</p><p className="text-sm font-black">{card.score}</p></div>
                        <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">Confidence</p><p className="text-sm font-black">{card.confidence}</p></div>
                        <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">Risk</p><p className="text-sm font-black">{card.riskScore ?? '미확인'}</p></div>
                      </div>

                      <div className="mt-2 grid grid-cols-2 gap-2 text-center sm:grid-cols-5" data-testid="scanner-price-plan">
                        <div className="rounded-xl border border-card-border p-2"><p className="text-[10px] text-muted-foreground">진입</p><p className="break-keep text-xs font-black">{card.pricePlan.entryZone ? `${formatNumber(card.pricePlan.entryZone.from)} ~ ${formatNumber(card.pricePlan.entryZone.to)}` : '미확인'}</p></div>
                        <div className="rounded-xl border border-card-border p-2"><p className="text-[10px] text-muted-foreground">손절</p><p className="text-xs font-black">{formatNumber(card.pricePlan.stopLoss)}</p></div>
                        <div className="rounded-xl border border-card-border p-2"><p className="text-[10px] text-muted-foreground">목표1</p><p className="text-xs font-black">{formatNumber(card.pricePlan.targets[0])}</p></div>
                        <div className="rounded-xl border border-card-border p-2"><p className="text-[10px] text-muted-foreground">목표2</p><p className="text-xs font-black">{formatNumber(card.pricePlan.targets[1])}</p></div>
                        <div className="rounded-xl border border-card-border p-2"><p className="text-[10px] text-muted-foreground">R:R</p><p className="text-xs font-black">{formatNumber(card.pricePlan.riskReward)}</p></div>
                      </div>

                      <div className="mt-3 flex flex-wrap gap-2 text-xs font-bold">
                        <span className="rounded-full bg-primary/10 px-2 py-1 text-primary">{stateLabel(card.signalState)}</span>
                        <span className="break-keep rounded-full bg-secondary px-2 py-1">{actionLabel(card)}</span>
                        <span className="rounded-full bg-secondary px-2 py-1">{card.strategyMode === 'scalping' ? '단타' : '스윙'}</span>
                        {card.signalGrade && <span className="rounded-full bg-secondary px-2 py-1">Grade {card.signalGrade}</span>}
                        <span className="break-keep rounded-full bg-secondary px-2 py-1">데이터 {card.dataQuality?.state ?? card.dataState}</span>
                      </div>

                      {card.warnings.length > 0 && (
                        <ul className="mt-3 space-y-1 break-keep rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
                          {card.warnings.map((warning) => <li key={warning}>• {warning}</li>)}
                        </ul>
                      )}

                      {backtest?.status === 'verified' ? (
                        <details className="mt-3 rounded-2xl border border-card-border bg-background p-3">
                          <summary className="cursor-pointer text-[11px] font-black">검증 백테스트 품질</summary>
                          <div className="mt-2 grid grid-cols-3 gap-2 text-center sm:grid-cols-6">
                            {[
                              ['OOS 승률', formatPercent(backtest.oosWinRate)],
                              ['WF 승률', formatPercent(backtest.walkForwardWinRate)],
                              ['Expectancy', formatPercent(backtest.expectancyPercent, 2)],
                              ['PF', formatNumber(backtest.profitFactor)],
                              ['MDD', formatPercent(backtest.maxDrawdownPercent)],
                              ['표본', backtest.tradeCount ?? '미확인'],
                            ].map(([label, value]) => (
                              <div key={String(label)} className="rounded-lg bg-card p-2"><p className="text-[10px] text-muted-foreground">{label}</p><p className="text-xs font-black">{value}</p></div>
                            ))}
                          </div>
                        </details>
                      ) : (
                        <div className="mt-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs">
                          <p className="break-keep font-black">OOS / Walk-forward 검증 데이터 없음</p>
                          <p className="mt-1 break-keep text-muted-foreground">실제 검증 수치를 생성하지 않습니다. 검증 데이터가 연결되기 전에는 S/A로 승격하지 않습니다.</p>
                        </div>
                      )}

                      {card.signalGrade === 'B' && ranking && (
                        <div className="mt-3 rounded-2xl border border-card-border bg-background p-3 text-xs">
                          <div className="flex items-center justify-between gap-2"><p className="break-keep font-black">관찰 · 진입 조건 {ranking.watchCompletionPercent}% 충족</p><span className="shrink-0 font-bold text-muted-foreground">WATCH ONLY</span></div>
                          <ul className="mt-2 space-y-1 break-keep text-muted-foreground">
                            {ranking.watchReasons.length ? ranking.watchReasons.map((reason) => <li key={reason}>• {reason}</li>) : <li>• 실시간 필수 조건 재확인 필요</li>}
                          </ul>
                        </div>
                      )}

                      <details className="mt-3 rounded-2xl border border-card-border bg-background p-3">
                        <summary className="cursor-pointer text-[11px] font-black">근거·지표 상세</summary>
                        {card.quantScore && (
                          <div className="mt-2 grid grid-cols-4 gap-1 text-center text-[10px] sm:grid-cols-8">
                            {Object.entries(card.quantScore).map(([label, value]) => (
                              <div key={label} className="rounded-lg bg-card px-1 py-2"><p className="text-muted-foreground">{label}</p><p className="font-black">{Math.round(value)}</p></div>
                            ))}
                          </div>
                        )}
                        <div className="mt-3 flex flex-wrap gap-1">
                          {card.evidence.filter((item) => item.status === 'matched').map((item) => <span key={item.key} className="rounded-lg bg-positive/10 px-2 py-1 text-[11px] text-positive">{item.label}</span>)}
                          {card.evidence.every((item) => item.status !== 'matched') && <span className="text-xs text-muted-foreground">확인된 강한 근거 없음</span>}
                        </div>
                        {card.unverified.length > 0 && <p className="mt-3 break-keep text-xs text-muted-foreground">미확인: {card.unverified.join(' · ')}</p>}
                      </details>

                      <p className="mt-3 break-keep text-[10px] text-muted-foreground">출처 {card.dataSources.join(', ') || '미확인'} · 관측 {new Date(card.observedAt).toLocaleString('ko-KR')}</p>
                      <button
                        type="button"
                        onClick={() => openInAiChart(card)}
                        className="mt-3 min-h-11 w-full rounded-xl border border-primary/30 bg-primary/10 px-3 text-sm font-black text-primary"
                      >
                        AI 차트 분석기에서 보기
                      </button>
                    </article>
                  );
                })}
              </section>
            )}

            <nav aria-label="종목 묶음 이동" className="flex justify-between gap-3">
              <button type="button" disabled={cursor <= 0} onClick={() => setCursor(Math.max(0, cursor - batchSize))} className="min-h-11 rounded-xl border border-card-border px-4 text-sm font-bold disabled:opacity-40">이전 묶음</button>
              <button type="button" disabled={data.universe.nextCursor == null} onClick={() => setCursor(data.universe.nextCursor ?? cursor)} className="min-h-11 rounded-xl border border-card-border px-4 text-sm font-bold disabled:opacity-40">다음 묶음</button>
            </nav>
          </>
        )}
      </div>
    </main>
  );
}