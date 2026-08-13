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
  type SignalScannerRequest,
} from '@/lib/signal-scanner';
import {
  getScannerUiProfile,
  SCANNER_STRATEGY_OPTIONS,
  toAiChartStrategyMode,
  type UnifiedScannerStrategyMode,
} from '@/lib/signal-scanner-profile';
import type { FrontendScannerMarket } from '@/lib/signal-scanner-url';

export type ScannerView = 'KR' | 'US' | 'SPOT' | 'FUTURES';
type RequestStatus = 'loading' | 'success' | 'empty' | 'partial' | 'cancelled' | 'error';

const VIEWS: Array<{ value: ScannerView; market: FrontendScannerMarket; label: string; description: string }> = [
  { value: 'KR', market: 'KR_STOCK', label: '국내주식', description: 'KRX 주식·ETF·ETN' },
  { value: 'US', market: 'US_STOCK', label: '미국주식', description: '미국 주식·ETF' },
  { value: 'SPOT', market: 'CRYPTO_SPOT', label: '코인 현물', description: 'Upbit KRW 현물' },
  { value: 'FUTURES', market: 'CRYPTO_FUTURES', label: '코인 선물', description: 'Bitget USDT 선물' },
];

const EMBEDDED_TIMEFRAMES: Readonly<Record<UnifiedScannerStrategyMode, readonly SignalScannerRequest['timeframe'][]>> = Object.freeze({
  scalping: ['1m', '3m', '5m'],
  swing: ['4H', '1D'],
  position: ['1D'],
});

function viewMarket(view: ScannerView): FrontendScannerMarket {
  return VIEWS.find((item) => item.value === view)?.market ?? 'KR_STOCK';
}

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
    if (error.code.includes('STRATEGY_TIMEFRAME_MISMATCH')) return '선택한 투자 스타일의 자동 시간봉 구성을 사용할 수 없습니다.';
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

function actionLabel(card: ScannerSignalCard): string {
  if (card.signalGrade === 'B') return 'WATCH · 관찰';
  if (card.action === 'BUY') return 'BUY · 매수 검토';
  if (card.action === 'SELL') return 'SELL · 축소 검토';
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

function strategyLabel(strategy: UnifiedScannerStrategyMode): string {
  return SCANNER_STRATEGY_OPTIONS.find((item) => item.value === strategy)?.label ?? strategy;
}

function defaultEmbeddedTimeframe(strategy: UnifiedScannerStrategyMode): SignalScannerRequest['timeframe'] {
  return strategy === 'scalping' ? '5m' : '1D';
}

export default function SignalScannerPage({ embedded = false }: { embedded?: boolean }) {
  const [, navigate] = useLocation();
  const assetMode = useAssetMode();
  const analysisSelection = useAnalysisSelection();
  const initialView: ScannerView = assetMode.asset === 'coin'
    ? assetMode.coinMarket === 'futures' ? 'FUTURES' : 'SPOT'
    : assetMode.stockMarket;
  const initialStrategy: UnifiedScannerStrategyMode = initialView === 'KR' || initialView === 'US' ? 'swing' : 'scalping';
  const [view, setView] = useState<ScannerView>(initialView);
  const [strategy, setStrategy] = useState<UnifiedScannerStrategyMode>(initialStrategy);
  const [embeddedTimeframe, setEmbeddedTimeframe] = useState<SignalScannerRequest['timeframe']>(() => defaultEmbeddedTimeframe(initialStrategy));
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

  const market = viewMarket(view);
  const profile = useMemo(() => getScannerUiProfile(market, strategy), [market, strategy]);
  const effectiveTimeframe = embedded ? embeddedTimeframe : profile.timeframe;
  const stockView = view === 'KR' || view === 'US';
  const batchSize = stockView ? 100 : 24;
  const profileRequest = useMemo<SignalScannerRequest>(() => ({
    assetClass: stockView ? 'stock' : view === 'SPOT' ? 'coin_spot' : 'coin_futures',
    market: view === 'KR' ? 'KR' : view === 'US' ? 'US' : view === 'SPOT' ? 'UPBIT' : 'BITGET',
    strategy,
    timeframe: profile.timeframe,
    conditions: [],
    condition: !stockView && strategy === 'scalping' ? 'williams' : 'trend',
    cursor,
    batchSize,
    minimumScore: 55,
    maximumRiskScore: 70,
  }), [batchSize, cursor, profile.timeframe, stockView, strategy, view]);
  const request = useMemo<SignalScannerRequest>(
    () => embedded ? { ...profileRequest, timeframe: embeddedTimeframe } : profileRequest,
    [embedded, embeddedTimeframe, profileRequest],
  );
  const requestKey = useMemo(() => JSON.stringify(request), [request]);

  const normalizedCards = useMemo(() => {
    if (!data?.cards) return [];
    const map = new Map<string, ScannerSignalCard>();
    for (const card of data.cards) if (!map.has(card.symbol)) map.set(card.symbol, card);
    return Array.from(map.values());
  }, [data?.cards]);

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

  useEffect(() => { lastGeneratedAt.current = null; }, [requestKey]);

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
        setData(result);
        setErrorMessage(result.refreshIssue?.message ?? '');
        setStatus(
          result.execution.partial || result.dataState === 'partial' || result.dataState === 'stale' || result.dataState === 'untrusted'
            ? 'partial'
            : result.cards.length === 0 ? 'empty' : 'success',
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
        if (error instanceof SignalScannerRequestError && [409, 429, 502].includes(error.status) && dataRef.current) {
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

  const selectStrategy = (next: UnifiedScannerStrategyMode) => {
    setCursor(0);
    setStrategy(next);
    if (embedded) setEmbeddedTimeframe(defaultEmbeddedTimeframe(next));
  };

  const openInAiChart = (card: ScannerSignalCard) => {
    const selection: AnalysisSelection = {
      assetType: card.assetClass,
      market: analysisMarket(card),
      symbol: card.symbol,
      ticker: card.symbol,
      displayName: card.name,
      timeframe: data?.timeframe ?? effectiveTimeframe,
      searchRunId: data?.requestId,
      signalScore: card.score,
      signalRank: card.candidateRanking?.rank,
      confidence: card.confidence,
      riskLevel: card.riskLevel,
      action: card.action,
      pricePlan: card.pricePlan,
      matchedSignals: card.matched,
      reasons: card.evidence.filter((item) => item.status === 'matched').flatMap((item) => item.reasons).slice(0, 20),
      selectedAt: new Date().toISOString(),
    };
    analysisSelection.select(selection);
    if (!embedded) {
      const params = new URLSearchParams(selectionQuery(selection));
      params.set('signalId', card.signalId);
      const chartStrategyMode = card.strategyMode ?? strategy;
      params.set('strategyMode', toAiChartStrategyMode(chartStrategyMode));
      navigate(`/ai-chart?${params.toString()}`);
    }
  };

  return (
    <main className={`min-h-0 bg-background ${embedded ? 'h-full overflow-y-auto' : 'min-h-screen pb-24'}`}>
      <div className="mx-auto w-full max-w-6xl space-y-4 p-3 sm:p-5">
        <header className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-primary">공개 시장데이터 전용 · 자동 전략 Profile</p>
              <h1 className="mt-1 text-xl font-black">AI 신호검색기</h1>
              <p className="mt-1 max-w-3xl break-keep text-xs leading-relaxed text-muted-foreground">
                시장과 투자 스타일만 선택하면 시간봉·기술지표·패턴·변동성·거래량·추세·시장국면·리스크 조건을 내부 엔진이 자동 조합합니다. 계좌·주문·취소 API는 호출하지 않습니다.
              </p>
            </div>
            <button type="button" onClick={() => setRefreshToken((value) => value + 1)} className="min-h-11 shrink-0 rounded-xl bg-primary px-4 text-sm font-bold text-primary-foreground">
              새로고침
            </button>
          </div>
        </header>

        <section aria-label="검색 시장" className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {VIEWS.map((item) => (
            <button key={item.value} type="button" aria-pressed={view === item.value} onClick={() => { setCursor(0); setView(item.value); }}
              className={`min-h-14 rounded-2xl border px-3 py-2 text-left ${view === item.value ? 'border-primary bg-primary/10' : 'border-card-border bg-card'}`}>
              <span className="block break-keep text-sm font-black">{item.label}</span>
              <span className="block break-keep text-[11px] text-muted-foreground">{item.description}</span>
            </button>
          ))}
        </section>

        <section aria-label="검색 전략" className="grid grid-cols-3 gap-2">
          {SCANNER_STRATEGY_OPTIONS.map((item) => (
            <button key={item.value} type="button" aria-label={embedded ? `${item.label} Engine` : undefined} aria-pressed={strategy === item.value} onClick={() => selectStrategy(item.value)}
              className={`min-h-16 rounded-2xl border px-3 py-3 text-left ${strategy === item.value ? 'border-primary bg-primary/10' : 'border-card-border bg-card'}`}>
              <span className="block break-keep text-sm font-black">{item.label}</span>
              <span className="mt-1 hidden break-keep text-[10px] text-muted-foreground sm:block">{item.description}</span>
            </button>
          ))}
        </section>

        <section aria-label="자동 전략 안내" className="rounded-3xl border border-card-border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-black">{strategyLabel(strategy)} · 자동 Profile</p>
              <p className="mt-1 break-keep text-xs text-muted-foreground">분석 시간봉 {effectiveTimeframe} · 확인 시간봉과 지표 가중치는 시장별 Profile에서 자동 관리</p>
            </div>
            <span className="rounded-full border border-card-border px-3 py-1 text-[11px] font-bold">{profile.profileVersion}</span>
          </div>
          <p className="mt-2 break-keep text-[11px] text-muted-foreground">기술지표 직접 선택은 기본 화면에 노출하지 않습니다. 상세 근거는 결과 카드에서 확인할 수 있습니다.</p>
          {embedded && (
            <label className="mt-3 block space-y-1 text-xs font-bold">
              시간봉
              <select
                aria-label="시간봉"
                value={embeddedTimeframe}
                onChange={(event) => { setCursor(0); setEmbeddedTimeframe(event.target.value as SignalScannerRequest['timeframe']); }}
                className="min-h-11 w-full rounded-xl border border-card-border bg-background px-3 text-sm"
              >
                {EMBEDDED_TIMEFRAMES[strategy].map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
              <span className="block text-[10px] font-normal text-muted-foreground">기술 워크스페이스의 회귀·연구 검증에서만 시간봉을 직접 전환합니다. 기본 Scanner 화면은 자동 Profile을 유지합니다.</span>
            </label>
          )}
        </section>

        {status === 'loading' && <section aria-live="polite" className="rounded-3xl border border-card-border bg-card p-8 text-center"><p className="font-bold">시장데이터를 분석하고 있습니다.</p></section>}
        {status === 'cancelled' && <section aria-live="polite" className="rounded-3xl border border-card-border bg-card p-5 text-sm">이전 요청을 취소하고 최신 선택으로 다시 분석합니다.</section>}
        {errorMessage && status === 'partial' && <section role="alert" className="rounded-3xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm"><p className="font-black">최신 결과 갱신 대기</p><p className="mt-1 text-xs text-muted-foreground">{errorMessage}</p></section>}
        {status === 'error' && <section role="alert" className="rounded-3xl border border-destructive/40 bg-destructive/10 p-5"><p className="font-black text-destructive">검색 실패</p><p className="mt-2 text-sm">{errorMessage}</p><button type="button" onClick={() => setRefreshToken((value) => value + 1)} className="mt-4 min-h-11 rounded-xl border border-destructive/30 px-4 text-sm font-bold">다시 시도</button></section>}

        {data && status !== 'loading' && status !== 'error' && (
          <>
            <section data-testid={status === 'partial' ? 'scanner-partial' : undefined} className={`rounded-3xl border p-4 ${status === 'partial' ? 'border-amber-500/40 bg-amber-500/10' : 'border-card-border bg-card'}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div><p className="text-sm font-black">{data.message}</p><p className="mt-1 text-xs text-muted-foreground">{strategyLabel(strategy)} · {data.timeframe} · {new Date(data.generatedAt).toLocaleString('ko-KR')}</p></div>
                <span className="rounded-full border border-card-border px-3 py-1 text-xs font-bold">{data.dataState}</span>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
                <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">스캔</p><p className="text-sm font-black">{data.execution.requestedCount}</p></div>
                <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">분석 완료</p><p className="text-sm font-black">{data.execution.dataSuccessCount ?? data.execution.completedCount}</p></div>
                <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">표시</p><p className="text-sm font-black">{data.execution.finalDisplayedCount ?? normalizedCards.length}</p></div>
                <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">Provider 오류</p><p className="text-sm font-black">{data.execution.providerErrorCount}</p></div>
              </div>
            </section>

            {data.failures.length > 0 && (
              <section className="rounded-3xl border border-amber-500/30 bg-card p-4">
                <h2 className="text-sm font-black">분석하지 못한 종목 {data.failures.length}개</h2>
                <div className="mt-2 space-y-1">
                  {data.failures.map((failure) => (
                    <p key={`${failure.symbol}:${failure.reason}`} className="text-xs text-muted-foreground">{failure.symbol} · {failure.reason}</p>
                  ))}
                </div>
              </section>
            )}

            {data.alerts.length > 0 && (
              <section aria-label="승인 대기 알림" className="rounded-3xl border border-primary/40 bg-primary/10 p-4">
                <h2 className="font-black">승인 대기 알림</h2>
                <p className="mt-1 text-xs text-muted-foreground">상세 정보만 열며 주문을 실행하지 않습니다.</p>
                <div className="mt-3 space-y-2">{data.alerts.map((alert) => (
                  <button key={alert.idempotencyKey} type="button" onClick={() => { const card = normalizedCards.find((item) => item.signalId === alert.signalId); if (card) navigate(signalScannerDetailPath(card)); }} className="min-h-11 w-full rounded-xl border border-primary/30 bg-card px-3 py-2 text-left text-sm">
                    <span className="font-black">{alertTitle(alert)}</span>
                  </button>
                ))}</div>
              </section>
            )}

            {normalizedCards.length === 0 ? (
              <section className="rounded-3xl border border-card-border bg-card p-8 text-center"><p className="font-black">현재 조건에서 표시할 검증 후보가 없습니다.</p></section>
            ) : (
              <section className="grid gap-3 xl:grid-cols-2">
                {normalizedCards.map((card) => (
                  <article key={card.signalId} className="min-w-0 rounded-3xl border border-card-border bg-card p-4">
                    <div className="flex items-start justify-between gap-3">
                      <button type="button" aria-label={`${card.name} ${card.symbol} · ${card.market} · ${card.assetType}`} onClick={() => navigate(signalScannerDetailPath(card))} className="min-h-11 min-w-0 text-left">
                        <p className="truncate font-black">{card.candidateRanking?.rank ? `${card.candidateRanking.rank}위 · ` : ''}{card.name}</p>
                        <p className="truncate text-xs text-muted-foreground">{card.symbol} · {card.market}</p>
                      </button>
                      <div className="shrink-0 text-right"><p className="text-sm font-black">{formatNumber(card.price, card.currency === 'KRW' ? 0 : 6)}</p><p className="text-xs text-muted-foreground">{card.changePercent == null ? '변동 미확인' : `${card.changePercent >= 0 ? '+' : ''}${card.changePercent.toFixed(2)}%`}</p></div>
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
                      <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">방향</p><p className="text-sm font-black">{actionLabel(card)}</p></div>
                      <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">신호점수</p><p className="text-sm font-black">{card.score}</p></div>
                      <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">표시 Confidence</p><p className="text-sm font-black">{card.confidence}</p></div>
                      <div className="rounded-xl bg-background p-2"><p className="text-[10px] text-muted-foreground">Risk</p><p className="text-sm font-black">{card.riskScore ?? '미확인'}</p></div>
                    </div>

                    <div className="mt-2 grid grid-cols-2 gap-2 text-center sm:grid-cols-5" data-testid="scanner-price-plan">
                      <div className="rounded-xl border border-card-border p-2"><p className="text-[10px] text-muted-foreground">진입</p><p className="text-xs font-black">{card.pricePlan.entryZone ? `${formatNumber(card.pricePlan.entryZone.from)}~${formatNumber(card.pricePlan.entryZone.to)}` : '미확인'}</p></div>
                      <div className="rounded-xl border border-card-border p-2"><p className="text-[10px] text-muted-foreground">손절</p><p className="text-xs font-black">{formatNumber(card.pricePlan.stopLoss)}</p></div>
                      <div className="rounded-xl border border-card-border p-2"><p className="text-[10px] text-muted-foreground">목표1</p><p className="text-xs font-black">{formatNumber(card.pricePlan.targets[0])}</p></div>
                      <div className="rounded-xl border border-card-border p-2"><p className="text-[10px] text-muted-foreground">목표2</p><p className="text-xs font-black">{formatNumber(card.pricePlan.targets[1])}</p></div>
                      <div className="rounded-xl border border-card-border p-2"><p className="text-[10px] text-muted-foreground">손익비</p><p className="text-xs font-black">{card.pricePlan.riskReward == null ? '미확인' : card.pricePlan.riskReward.toFixed(2)}</p></div>
                    </div>

                    <section aria-label="신호 성과" className="mt-3 rounded-2xl border border-card-border bg-background p-3">
                      <div className="flex items-center justify-between gap-2"><p className="text-xs font-black">과거 유사조건 성과</p><span className="rounded-full border border-card-border px-2 py-1 text-[10px]">NOT_ENOUGH_DATA</span></div>
                      <p className="mt-2 break-keep text-xs text-muted-foreground">통계 산출을 위한 데이터가 부족합니다. 신호점수와 과거 적중률은 같은 의미로 표시하지 않습니다.</p>
                    </section>

                    {card.backtestQuality?.status === 'verified' && (
                      <section className="mt-3 rounded-2xl border border-card-border p-3">
                        <p className="text-xs font-black">Historical Backtest 연구 근거</p>
                        <div className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                          <span>표본 {card.backtestQuality.tradeCount ?? '미확인'}</span>
                          <span>OOS {formatPercent(card.backtestQuality.oosWinRate)}</span>
                          <span>기대값 {formatPercent(card.backtestQuality.expectancyPercent)}</span>
                          <span>PF {formatNumber(card.backtestQuality.profitFactor)}</span>
                        </div>
                      </section>
                    )}

                    <details className="mt-3 rounded-2xl border border-card-border p-3">
                      <summary className="cursor-pointer text-xs font-black">엔진 근거 상세</summary>
                      <div className="mt-2 flex flex-wrap gap-1">{card.matched.slice(0, 12).map((item) => <span key={item} className="rounded-lg bg-background px-2 py-1 text-[10px]">{item}</span>)}</div>
                      {card.aiValidation && <p className="mt-2 text-[11px] text-muted-foreground">AI Validator: {card.aiValidation.status} · Risk Engine을 우회하지 않습니다.</p>}
                    </details>

                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <button type="button" onClick={() => navigate(signalScannerDetailPath(card))} className="min-h-11 rounded-xl border border-card-border text-sm font-bold">상세 보기</button>
                      <button type="button" aria-label="AI 차트 분석기에서 보기" onClick={() => openInAiChart(card)} className="min-h-11 rounded-xl bg-primary text-sm font-bold text-primary-foreground">AI 차트</button>
                    </div>
                  </article>
                ))}
              </section>
            )}

            <section className="flex items-center justify-between gap-2">
              <button type="button" disabled={cursor === 0} onClick={() => setCursor((value) => Math.max(0, value - batchSize))} className="min-h-11 rounded-xl border border-card-border px-4 text-sm font-bold disabled:opacity-40">이전</button>
              <span className="text-xs text-muted-foreground">{cursor + 1}번째부터 · 자동 Profile</span>
              <button type="button" disabled={data.universe.nextCursor == null} onClick={() => setCursor(data.universe.nextCursor ?? cursor)} className="min-h-11 rounded-xl border border-card-border px-4 text-sm font-bold disabled:opacity-40">다음</button>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
