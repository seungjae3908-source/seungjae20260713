import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { useAssetMode } from '@/lib/asset-mode';
import {
  selectionQuery,
  useAnalysisSelection,
  type AnalysisSelection,
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

type ScannerView = 'KR' | 'US' | 'SPOT' | 'FUTURES';
type RequestStatus =
  | 'loading'
  | 'success'
  | 'empty'
  | 'partial'
  | 'cancelled'
  | 'error';

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

const STOCK_TIMEFRAMES = ['5m', '15m', '60m', '1D'] as const;
const COIN_TIMEFRAMES = ['5m', '15m', '60m', '4H', '1D'] as const;
const ALERT_STORAGE_KEY = 'signal-scanner-browser-alerts-v1';

function requestErrorMessage(error: unknown): string {
  if (error instanceof SignalScannerRequestError) {
    if (error.status === 401) return '로그인이 만료됐습니다. 다시 로그인한 뒤 재시도해 주세요.';
    if (error.status === 403) return '현재 회원 등급으로 이 시장의 AI 검색기를 사용할 수 없습니다.';
    if (error.status === 409) return '동일 조건 분석이 이미 진행 중입니다. 기존 요청 완료 후 다시 시도해 주세요.';
    if (error.status === 429) {
      const retry = error.retryAfterSeconds == null ? '' : ` ${error.retryAfterSeconds}초 후`;
      return `검색 요청 한도를 보호하고 있습니다.${retry} 다시 시도해 주세요.`;
    }
    if (error.status === 502) return '시장데이터 공급자 응답이 불안정합니다. 결과를 성공으로 처리하지 않았습니다.';
    return `검색 요청 실패: ${error.code}`;
  }
  if (error instanceof Error && error.name === 'AbortError') return '이전 검색 요청을 취소했습니다.';
  return error instanceof Error ? error.message : '검색 요청 중 알 수 없는 오류가 발생했습니다.';
}

function loadDeliveredAlertIds(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(ALERT_STORAGE_KEY) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveDeliveredAlertIds(ids: Set<string>): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(ALERT_STORAGE_KEY, JSON.stringify([...ids].slice(-300)));
}

function formatNumber(value: number | null, maximumFractionDigits = 2): string {
  if (value == null || !Number.isFinite(value)) return '미확인';
  return value.toLocaleString('ko-KR', { maximumFractionDigits });
}

function stateLabel(state: ScannerSignalCard['signalState']): string {
  const labels: Record<ScannerSignalCard['signalState'], string> = {
    DETECTED: '감지',
    WATCHING: '감시 중',
    READY_FOR_APPROVAL: '진입 검토 준비',
    WEAKENED: '약화',
    INVALIDATED: '무효',
    EXPIRED: '만료',
  };
  return labels[state];
}

function directionLabel(card: ScannerSignalCard): string {
  if (card.direction === 'LONG') return card.assetClass === 'coin_spot' ? '매수 관찰' : '상승 관찰';
  if (card.direction === 'SHORT') return '하락 관찰';
  return '관망';
}

function alertTitle(alert: ScannerAlertCandidate): string {
  if (alert.direction === 'LONG') return `진입 검토 준비 · ${alert.symbol}`;
  if (alert.direction === 'SHORT') return `하락 신호 검토 준비 · ${alert.symbol}`;
  return `신호 검토 준비 · ${alert.symbol}`;
}

export default function SignalScannerPage({ embedded = false }: { embedded?: boolean }) {
  const [, navigate] = useLocation();
  const assetMode = useAssetMode();
  const analysisSelection = useAnalysisSelection();
  const initialView: ScannerView = assetMode.asset === 'coin'
    ? assetMode.coinMarket === 'futures' ? 'FUTURES' : 'SPOT'
    : assetMode.stockMarket;
  const [view, setView] = useState<ScannerView>(initialView);
  const [timeframe, setTimeframe] = useState<SignalScannerRequest['timeframe']>(
    initialView === 'KR' || initialView === 'US' ? '1D' : '15m',
  );
  const [conditions, setConditions] = useState<string[]>(['거래량 증가']);
  const [coinCondition, setCoinCondition] = useState<SignalScannerRequest['condition']>('trend');
  const [minimumScore, setMinimumScore] = useState(55);
  const [maximumRiskScore, setMaximumRiskScore] = useState(70);
  const [cursor, setCursor] = useState(0);
  const [refreshToken, setRefreshToken] = useState(0);
  const [status, setStatus] = useState<RequestStatus>('loading');
  const [data, setData] = useState<ScannerResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const latestSequence = useRef(0);

  const stockView = view === 'KR' || view === 'US';
  const batchSize = stockView ? 100 : 24;
  const request = useMemo<SignalScannerRequest>(() => ({
    assetClass: stockView ? 'stock' : view === 'SPOT' ? 'coin_spot' : 'coin_futures',
    market: view === 'KR' ? 'KR' : view === 'US' ? 'US' : view === 'SPOT' ? 'UPBIT' : 'BITGET',
    timeframe,
    conditions,
    condition: coinCondition,
    cursor,
    batchSize,
    minimumScore,
    maximumRiskScore,
  }), [batchSize, coinCondition, conditions, cursor, maximumRiskScore, minimumScore, stockView, timeframe, view]);
  const requestKey = useMemo(() => JSON.stringify(request), [request]);

  useEffect(() => {
    setCursor(0);
    if (view === 'KR' || view === 'US') {
      assetMode.setAsset('stock');
      assetMode.setStockMarket(view);
      if (timeframe === '4H') setTimeframe('1D');
    } else {
      assetMode.setAsset('coin');
      assetMode.setCoinMarket(view === 'FUTURES' ? 'futures' : 'spot');
      if (timeframe === '1D') setTimeframe('15m');
    }
  }, [view]);

  useEffect(() => {
    const controller = new AbortController();
    const sequence = latestSequence.current + 1;
    latestSequence.current = sequence;
    setStatus('loading');
    setErrorMessage('');

    void fetchSignalScanner(request, controller.signal)
      .then((result) => {
        if (controller.signal.aborted || latestSequence.current !== sequence) return;
        setData(result);
        setStatus(result.execution.partial || result.dataState === 'partial' || result.dataState === 'stale'
          ? 'partial'
          : result.cards.length === 0
            ? 'empty'
            : 'success');
      })
      .catch((error: unknown) => {
        if (latestSequence.current !== sequence) return;
        if (controller.signal.aborted) {
          setStatus('cancelled');
          return;
        }
        setData(null);
        setStatus('error');
        setErrorMessage(requestErrorMessage(error));
      });

    return () => controller.abort();
  }, [requestKey, refreshToken]);

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

  useEffect(() => {
    if (!data?.alerts.length || typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    const delivered = loadDeliveredAlertIds();
    let changed = false;
    for (const alert of data.alerts) {
      if (delivered.has(alert.idempotencyKey)) continue;
      const entry = alert.entryZone
        ? `${formatNumber(alert.entryZone.from)}~${formatNumber(alert.entryZone.to)}`
        : '미확인';
      new Notification(alertTitle(alert), {
        body: `관심 진입가 ${entry} · 만료 ${new Date(alert.expiresAt).toLocaleTimeString('ko-KR')}`,
        tag: alert.idempotencyKey,
      });
      delivered.add(alert.idempotencyKey);
      changed = true;
    }
    if (changed) saveDeliveredAlertIds(delivered);
  }, [data?.alerts]);

  const selectView = (next: ScannerView) => {
    if (next === view) return;
    setData(null);
    setView(next);
  };

  const toggleCondition = (condition: string) => {
    setCursor(0);
    setConditions((current) => {
      if (current.includes(condition)) {
        return current.length === 1 ? current : current.filter((item) => item !== condition);
      }
      return [...current, condition];
    });
  };

  const allowBrowserNotifications = async () => {
    if (!('Notification' in window)) return;
    await Notification.requestPermission();
    setRefreshToken((value) => value + 1);
  };

  const openInAiChart = (card: ScannerSignalCard) => {
    if (card.assetClass !== 'stock') {
      navigate(signalScannerDetailPath(card));
      return;
    }
    const selection: AnalysisSelection = {
      assetType: 'stock',
      market: card.market === 'US' ? 'US' : 'KR',
      symbol: card.symbol,
      ticker: card.symbol,
      displayName: card.name,
      timeframe: data?.timeframe ?? timeframe,
      searchRunId: data?.requestId,
      signalScore: card.score,
      confidence: card.confidence,
      riskLevel: card.riskLevel,
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

  const timeframes = stockView ? STOCK_TIMEFRAMES : COIN_TIMEFRAMES;
  const cards = data?.cards ?? [];

  return (
    <main className={`min-h-0 bg-background ${embedded ? 'h-full overflow-y-auto' : 'min-h-screen pb-24'}`}>
      <div className="mx-auto w-full max-w-6xl space-y-4 p-3 sm:p-5">
        <header className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-primary">공개 시장데이터 전용</p>
              <h1 className="mt-1 text-xl font-black">AI 신호검색기</h1>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                확인된 조건만 신호로 표시합니다. 이 화면은 계좌·주문·취소·포지션 API를 호출하지 않습니다.
              </p>
            </div>
            <div className="flex gap-2">
              {typeof window !== 'undefined' && 'Notification' in window && Notification.permission !== 'granted' && (
                <button
                  type="button"
                  onClick={allowBrowserNotifications}
                  className="min-h-11 rounded-xl border border-card-border px-3 text-xs font-bold"
                >
                  알림 허용
                </button>
              )}
              <button
                type="button"
                onClick={() => setRefreshToken((value) => value + 1)}
                className="min-h-11 rounded-xl bg-primary px-4 text-sm font-bold text-primary-foreground"
              >
                새로고침
              </button>
            </div>
          </div>
        </header>

        <section aria-label="검색 시장" className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {VIEWS.map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={view === item.value}
              onClick={() => selectView(item.value)}
              className={`min-h-14 rounded-2xl border px-3 py-2 text-left ${
                view === item.value ? 'border-primary bg-primary/10' : 'border-card-border bg-card'
              }`}
            >
              <span className="block text-sm font-black">{item.label}</span>
              <span className="block text-[11px] text-muted-foreground">{item.description}</span>
            </button>
          ))}
        </section>

        <section className="rounded-3xl border border-card-border bg-card p-4">
          <div className="grid gap-4 lg:grid-cols-4">
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
              최소 점수 {minimumScore}
              <input
                aria-label="최소 점수"
                type="range"
                min="0"
                max="100"
                value={minimumScore}
                onChange={(event) => { setCursor(0); setMinimumScore(Number(event.target.value)); }}
                className="min-h-11 w-full"
              />
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

          <div className="mt-4">
            <p className="mb-2 text-xs font-bold">검증 조건</p>
            <div className="flex flex-wrap gap-2">
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
                          : 'border-card-border bg-background'
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
                          : 'border-card-border bg-background'
                      }`}
                    >
                      {condition.label}
                    </button>
                  ))}
            </div>
          </div>
        </section>

        {status === 'loading' && (
          <section aria-live="polite" className="rounded-3xl border border-card-border bg-card p-8 text-center">
            <p className="font-bold">시장데이터를 분석하고 있습니다.</p>
            <p className="mt-2 text-xs text-muted-foreground">전체 호출이 아니라 제한된 묶음·동시성·deadline으로 처리합니다.</p>
          </section>
        )}

        {status === 'cancelled' && (
          <section aria-live="polite" className="rounded-3xl border border-card-border bg-card p-5 text-sm">
            이전 조건의 요청을 취소하고 최신 조건으로 다시 분석합니다.
          </section>
        )}

        {status === 'error' && (
          <section role="alert" className="rounded-3xl border border-destructive/40 bg-destructive/10 p-5">
            <p className="font-black text-destructive">검색 실패</p>
            <p className="mt-2 text-sm">{errorMessage}</p>
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
            <section className={`rounded-3xl border p-4 ${status === 'partial' ? 'border-amber-500/40 bg-amber-500/10' : 'border-card-border bg-card'}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-black">{data.message}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    기준 {new Date(data.generatedAt).toLocaleString('ko-KR')} · {data.universe.source}
                  </p>
                </div>
                <span className="rounded-full border border-card-border px-3 py-1 text-xs font-bold">
                  {data.dataState}
                </span>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 text-center sm:grid-cols-6">
                {[
                  ['요청', data.execution.requestedCount],
                  ['시작', data.execution.startedCount],
                  ['완료', data.execution.completedCount],
                  ['제외', data.execution.excludedCount],
                  ['공급자 오류', data.execution.providerErrorCount],
                  ['시간초과', data.execution.timeoutCount],
                ].map(([label, value]) => (
                  <div key={String(label)} className="rounded-xl bg-background p-2">
                    <p className="text-[10px] text-muted-foreground">{label}</p>
                    <p className="text-sm font-black">{value}</p>
                  </div>
                ))}
              </div>
            </section>

            {data.alerts.length > 0 && (
              <section aria-label="진입 검토 준비 알림" className="rounded-3xl border border-primary/40 bg-primary/10 p-4">
                <h2 className="font-black">READY_FOR_APPROVAL 알림</h2>
                <p className="mt-1 text-xs text-muted-foreground">알림 선택은 상세 정보만 열며 주문을 실행하지 않습니다.</p>
                <div className="mt-3 space-y-2">
                  {data.alerts.map((alert) => (
                    <button
                      key={alert.idempotencyKey}
                      type="button"
                      onClick={() => {
                        const card = cards.find((item) => item.signalId === alert.signalId);
                        if (card) navigate(signalScannerDetailPath(card));
                      }}
                      className="min-h-11 w-full rounded-xl border border-primary/30 bg-card px-3 py-2 text-left text-sm"
                    >
                      <span className="font-black">{alertTitle(alert)}</span>
                      <span className="ml-2 text-xs text-muted-foreground">만료 {new Date(alert.expiresAt).toLocaleTimeString('ko-KR')}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {data.failures.length > 0 && (
              <section className="rounded-3xl border border-amber-500/40 bg-amber-500/10 p-4">
                <h2 className="font-black">분석하지 못한 종목 {data.failures.length}개</h2>
                <div className="mt-2 flex flex-wrap gap-2">
                  {data.failures.slice(0, 20).map((failure) => (
                    <span key={`${failure.symbol}:${failure.reason}`} className="rounded-lg bg-background px-2 py-1 text-xs">
                      {failure.symbol} · {failure.reason}
                    </span>
                  ))}
                </div>
              </section>
            )}

            {cards.length === 0 ? (
              <section className="rounded-3xl border border-card-border bg-card p-8 text-center">
                <p className="font-black">조건에 맞는 결과가 없습니다.</p>
                <p className="mt-2 text-xs text-muted-foreground">데이터 부족 결과를 강한 신호로 올리지 않았습니다.</p>
              </section>
            ) : (
              <section className="grid gap-3 xl:grid-cols-2">
                {cards.map((card) => (
                  <article key={card.signalId} className="rounded-3xl border border-card-border bg-card p-4">
                    <div className="flex items-start justify-between gap-3">
                      <button
                        type="button"
                        onClick={() => navigate(signalScannerDetailPath(card))}
                        className="min-h-11 text-left"
                      >
                        <p className="font-black">{card.name}</p>
                        <p className="text-xs text-muted-foreground">{card.symbol} · {card.market} · {card.assetType}</p>
                      </button>
                      <div className="text-right">
                        <p className="text-sm font-black">{formatNumber(card.price, card.currency === 'KRW' ? 0 : 6)}</p>
                        <p className="text-xs text-muted-foreground">{card.changePercent == null ? '변동 미확인' : `${card.changePercent >= 0 ? '+' : ''}${card.changePercent.toFixed(2)}%`}</p>
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2 text-xs font-bold">
                      <span className="rounded-full bg-primary/10 px-2 py-1 text-primary">{stateLabel(card.signalState)}</span>
                      <span className="rounded-full bg-secondary px-2 py-1">{directionLabel(card)}</span>
                      <span className="rounded-full bg-secondary px-2 py-1">데이터 {card.dataState}</span>
                    </div>
                    <div className="mt-3 grid grid-cols-4 gap-2 text-center">
                      {[
                        ['점수', card.score],
                        ['신뢰도', card.confidence],
                        ['완성도', card.dataCompleteness],
                        ['위험', card.riskScore == null ? '미확인' : card.riskScore],
                      ].map(([label, value]) => (
                        <div key={String(label)} className="rounded-xl bg-background p-2">
                          <p className="text-[10px] text-muted-foreground">{label}</p>
                          <p className="text-sm font-black">{value}</p>
                        </div>
                      ))}
                    </div>
                    <div className="mt-3">
                      <p className="text-[11px] font-bold text-muted-foreground">확인된 근거</p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {card.matched.map((item) => <span key={item} className="rounded-lg bg-positive/10 px-2 py-1 text-[11px] text-positive">{item}</span>)}
                        {card.matched.length === 0 && <span className="text-xs text-muted-foreground">없음</span>}
                      </div>
                    </div>
                    {card.unverified.length > 0 && (
                      <div className="mt-3">
                        <p className="text-[11px] font-bold text-muted-foreground">미확인 데이터</p>
                        <p className="mt-1 text-xs leading-relaxed">{card.unverified.join(' · ')}</p>
                      </div>
                    )}
                    <div className="mt-3 rounded-xl bg-background p-3 text-xs leading-relaxed">
                      <p>관심 진입가: {card.pricePlan.entryZone ? `${formatNumber(card.pricePlan.entryZone.from)} ~ ${formatNumber(card.pricePlan.entryZone.to)}` : '미확인'}</p>
                      <p>손절 기준: {formatNumber(card.pricePlan.stopLoss)}</p>
                      <p>목표 구간: {card.pricePlan.targets.length ? card.pricePlan.targets.map((item) => formatNumber(item)).join(' / ') : '미확인'}</p>
                      <p>예상 손익비: {formatNumber(card.pricePlan.riskReward)}</p>
                    </div>
                    {card.warnings.length > 0 && (
                      <ul className="mt-3 space-y-1 text-xs text-amber-700 dark:text-amber-300">
                        {card.warnings.map((warning) => <li key={warning}>• {warning}</li>)}
                      </ul>
                    )}
                    <p className="mt-3 text-[10px] text-muted-foreground">
                      출처 {card.dataSources.join(', ') || '미확인'} · 관측 {new Date(card.observedAt).toLocaleString('ko-KR')}
                    </p>
                    {card.assetClass === 'stock' && (
                      <button
                        type="button"
                        onClick={() => openInAiChart(card)}
                        className="mt-3 min-h-11 w-full rounded-xl border border-primary/30 bg-primary/10 px-3 text-sm font-black text-primary"
                      >
                        AI 차트 분석기에서 보기
                      </button>
                    )}
                  </article>
                ))}
              </section>
            )}

            <nav aria-label="종목 묶음 이동" className="flex justify-between gap-3">
              <button
                type="button"
                disabled={cursor <= 0}
                onClick={() => setCursor(Math.max(0, cursor - batchSize))}
                className="min-h-11 rounded-xl border border-card-border px-4 text-sm font-bold disabled:opacity-40"
              >
                이전 묶음
              </button>
              <button
                type="button"
                disabled={data.universe.nextCursor == null}
                onClick={() => setCursor(data.universe.nextCursor ?? cursor)}
                className="min-h-11 rounded-xl border border-card-border px-4 text-sm font-bold disabled:opacity-40"
              >
                다음 묶음
              </button>
            </nav>
          </>
        )}
      </div>
    </main>
  );
}
