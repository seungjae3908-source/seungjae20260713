import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useQueries } from '@tanstack/react-query';
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Clock3,
  Database,
  Minus,
  ShieldAlert,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import {
  aggregateMultiTimeframe,
  buildTechnicalTimeframeEvidence,
  mapPricePlan,
  signalLifecycleFromAnalysis,
  strategyModeTimeframes,
  type AiChartSignalLifecycle,
  type AiChartSignalSide,
  type AiChartStrategyMode,
  type AiChartTimeframeEvidence,
} from '@/lib/ai-chart-v2-intelligence';
import type { AnalysisSelection, AnalysisTradeAction } from '@/lib/analysis-selection';
import type { ChartAnalysis } from '@/lib/chart-analysis';
import { computeChartIndicators } from '@/lib/chart-indicator-engine';
import { analyzeChartStructure } from '@/lib/chart-structure-engine';
import {
  UnifiedChartDataError,
  fetchUnifiedChartData,
  unifiedChartDataStatus,
  type UnifiedChartTimeframe,
} from '@/lib/unified-chart-data';
import { cn } from '@/lib/utils';

type Props = {
  selection: AnalysisSelection;
  analysis: ChartAnalysis | null;
  mode: AiChartStrategyMode;
  onModeChange: (mode: AiChartStrategyMode) => void;
};

const SIGNAL_OVERLAY_STORAGE_KEY = 'ai-chart-v2-signal-overlay.v1';

const MODE_OPTIONS: Array<{ key: AiChartStrategyMode; label: string; description: string }> = [
  { key: 'SCALPING', label: 'SCALPING', description: '1m · 3m · 5m · 15m' },
  { key: 'SWING', label: 'SWING', description: '15m · 1H · 4H · 1D' },
  { key: 'MID_LONG', label: 'MID-LONG', description: '4H · 1D' },
];

function formatPrice(value: number | null, market: AnalysisSelection['market']): string {
  if (value == null || !Number.isFinite(value)) return 'UNAVAILABLE';
  if (market === 'US') return `$${value.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}`;
  if (market === 'BITGET') return `${value.toLocaleString('ko-KR', { maximumFractionDigits: value >= 1000 ? 2 : 8 })} USDT`;
  return `${value.toLocaleString('ko-KR', { maximumFractionDigits: value >= 1000 ? 0 : 8 })}원`;
}

function qualityClass(quality: AiChartTimeframeEvidence['quality']): string {
  if (quality === 'LIVE') return 'border-positive/30 bg-positive/10 text-positive';
  if (quality === 'DELAYED' || quality === 'PARTIAL') return 'border-warning/30 bg-warning/10 text-warning';
  return 'border-destructive/30 bg-destructive/10 text-destructive';
}

function sideClass(side: AiChartSignalSide): string {
  if (side === 'BUY' || side === 'LONG') return 'text-destructive';
  if (side === 'SELL' || side === 'SHORT') return 'text-blue-500';
  return 'text-muted-foreground';
}

function isPositiveSide(side: AiChartSignalSide): boolean {
  return side === 'BUY' || side === 'LONG';
}

function normalizeContextSide(action: AnalysisTradeAction | undefined, market: AnalysisSelection['market']): AiChartSignalSide | null {
  if (!action || action === 'NONE') return null;
  if (market === 'BITGET') {
    if (action === 'BUY') return 'LONG';
    if (action === 'SELL') return 'SHORT';
    return action;
  }
  if (action === 'LONG') return 'BUY';
  if (action === 'SHORT') return 'SELL';
  return action;
}

function finiteScore(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(Math.max(0, Math.min(100, value)));
}

function currentEvidenceFromExistingChart(
  selection: AnalysisSelection,
  analysis: ChartAnalysis | null,
): AiChartTimeframeEvidence {
  const scannerSide = normalizeContextSide(selection.action, selection.market);
  const scannerScore = finiteScore(selection.confidence ?? selection.signalScore);
  const reasons = (selection.reasons ?? []).filter(Boolean).slice(0, 8);

  if (scannerSide && scannerScore != null) {
    const positive = scannerSide === 'BUY' || scannerSide === 'LONG';
    return {
      timeframe: selection.timeframe as UnifiedChartTimeframe,
      state: 'READY',
      side: scannerSide,
      score: scannerScore,
      quality: 'PARTIAL',
      positiveFactors: positive ? reasons : [],
      negativeFactors: positive ? [] : reasons,
      riskFactors: ['현재 시간봉 freshness는 기존 차트 Data Quality 상태를 우선 확인'],
      reasonCodes: ['SCANNER_CONTEXT', 'EXISTING_CHART_OWNER'],
      source: 'SCANNER',
    };
  }

  if (analysis) {
    const side: AiChartSignalSide = analysis.bias === 'bullish'
      ? selection.market === 'BITGET' ? 'LONG' : 'BUY'
      : analysis.bias === 'bearish'
        ? selection.market === 'BITGET' ? 'SHORT' : 'SELL'
        : 'WAIT';
    const positive = side === 'BUY' || side === 'LONG';
    return {
      timeframe: selection.timeframe as UnifiedChartTimeframe,
      state: 'READY',
      side,
      score: finiteScore(analysis.confidence),
      quality: 'PARTIAL',
      positiveFactors: positive ? analysis.reasons.slice(0, 8) : [],
      negativeFactors: side === 'SELL' || side === 'SHORT' ? analysis.reasons.slice(0, 8) : [],
      riskFactors: ['현재 시간봉 freshness는 기존 차트 Data Quality 상태를 우선 확인'],
      reasonCodes: ['CHART_ANALYSIS_CONTEXT', 'EXISTING_CHART_OWNER'],
      source: 'TECHNICAL_EVIDENCE',
    };
  }

  return {
    timeframe: selection.timeframe as UnifiedChartTimeframe,
    state: 'INSUFFICIENT_DATA',
    side: 'WAIT',
    score: null,
    quality: 'PARTIAL',
    positiveFactors: [],
    negativeFactors: [],
    riskFactors: ['현재 차트 분석이 준비될 때까지 방향 판단을 보류'],
    reasonCodes: ['EXISTING_CHART_CONTEXT_PENDING'],
    source: 'NONE',
  };
}

function currentContext(
  contexts: AiChartTimeframeEvidence[],
  timeframe: string,
): AiChartTimeframeEvidence | null {
  return contexts.find((context) => context.timeframe === timeframe) ?? null;
}

function initialSignalOverlayVisible(): boolean {
  if (typeof window === 'undefined') return true;
  return window.localStorage.getItem(SIGNAL_OVERLAY_STORAGE_KEY) !== 'false';
}

function signalIdFromContext(selection: AnalysisSelection, analysis: ChartAnalysis | null): string {
  if (typeof window !== 'undefined') {
    const routeSignalId = new URLSearchParams(window.location.search).get('signalId')?.trim();
    if (routeSignalId) return routeSignalId;
  }
  return analysis?.id
    ?? selection.searchRunId
    ?? `${selection.market}:${selection.ticker}:${selection.timeframe}`;
}

function SignalDirectionIcon({ side }: { side: AiChartSignalSide }) {
  if (side === 'BUY' || side === 'LONG') return <TrendingUp className="h-4 w-4 shrink-0" aria-hidden="true" />;
  if (side === 'SELL' || side === 'SHORT') return <TrendingDown className="h-4 w-4 shrink-0" aria-hidden="true" />;
  return <Minus className="h-4 w-4 shrink-0" aria-hidden="true" />;
}

function AiChartSignalOverlayPortal({
  visible,
  selection,
  side,
  score,
  lifecycle,
  mode,
  signalId,
}: {
  visible: boolean;
  selection: AnalysisSelection;
  side: AiChartSignalSide;
  score: number | null;
  lifecycle: AiChartSignalLifecycle;
  mode: AiChartStrategyMode;
  signalId: string;
}) {
  const [target, setTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!visible || typeof document === 'undefined') {
      setTarget(null);
      return;
    }
    const locate = () => {
      const next = document.querySelector<HTMLElement>('[data-testid="unified-chart-wrapper"]');
      setTarget((current) => current === next ? current : next);
    };
    locate();
    const observer = new MutationObserver(locate);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [visible]);

  if (!visible || !target || !target.isConnected) return null;
  const inactive = lifecycle === 'INVALIDATED' || lifecycle === 'EXPIRED';

  return createPortal(
    <div
      data-testid="ai-chart-v2-signal-overlay"
      data-signal-id={signalId}
      data-signal-status={lifecycle}
      className={cn(
        'pointer-events-none absolute left-3 top-3 z-20 max-w-[calc(100%-1.5rem)] rounded-xl border bg-background/90 px-3 py-2 shadow-sm backdrop-blur-sm',
        inactive ? 'border-dashed border-muted-foreground/40 opacity-60' : 'border-card-border',
      )}
      aria-label={`AI 신호 ${side}, 상태 ${lifecycle}`}
    >
      <div className={cn('flex items-center gap-1.5 text-xs font-black', sideClass(side))}>
        <SignalDirectionIcon side={side} />
        <span>{side}</span>
        {score != null && <span>· {score}</span>}
      </div>
      <p className="mt-0.5 text-[9px] font-black text-foreground">
        {lifecycle} · {mode} · {selection.timeframe}
      </p>
      <p className="mt-0.5 truncate text-[8px] font-semibold text-muted-foreground">
        Signal {signalId}
      </p>
    </div>,
    target,
  );
}

export function AiChartV2IntelligencePanel({ selection, analysis, mode, onModeChange }: Props) {
  const [signalOverlayVisible, setSignalOverlayVisible] = useState(initialSignalOverlayVisible);
  const [multiTimeframeRequested, setMultiTimeframeRequested] = useState(false);
  const modeTimeframes = useMemo<UnifiedChartTimeframe[]>(
    () => [...strategyModeTimeframes(mode)],
    [mode],
  );
  const selectedTimeframe = selection.timeframe as UnifiedChartTimeframe;
  const supplementalTimeframes = useMemo(
    () => modeTimeframes.filter((timeframe) => timeframe !== selectedTimeframe),
    [modeTimeframes, selectedTimeframe],
  );

  useEffect(() => {
    setMultiTimeframeRequested(false);
  }, [mode, selection.market, selection.ticker, selection.timeframe]);

  const queries = useQueries({
    queries: supplementalTimeframes.map((timeframe) => ({
      queryKey: ['unified-chart-data', selection.market, selection.ticker, timeframe],
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchUnifiedChartData({
        market: selection.market,
        symbol: selection.ticker,
        timeframe,
        signal,
      }),
      enabled: multiTimeframeRequested && Boolean(selection.ticker),
      staleTime: 15_000,
      gcTime: 10 * 60 * 1000,
      refetchInterval: false as const,
      refetchOnWindowFocus: false,
      retry: (failureCount: number, error: unknown) => {
        if (failureCount >= 1) return false;
        if (error instanceof UnifiedChartDataError) return error.retryable && error.kind !== 'aborted';
        return true;
      },
    })),
  });

  const currentChartEvidence = useMemo(
    () => currentEvidenceFromExistingChart(selection, analysis),
    [analysis, selection],
  );

  const supplementalContexts = useMemo(() => supplementalTimeframes.map((timeframe, index) => {
    const query = queries[index];
    const data = query.data;
    const status = data
      ? unifiedChartDataStatus(data, query.isError)
      : query.isError
        ? 'unavailable' as const
        : 'insufficient' as const;
    const candles = data?.normalization.candles ?? [];
    const indicators = computeChartIndicators(candles);
    const structure = analyzeChartStructure(candles);
    const latest = candles.at(-1);
    const current = indicators.latest;

    return buildTechnicalTimeframeEvidence({
      market: selection.market,
      mode,
      timeframe,
      dataStatus: status,
      candleCount: candles.length,
      trend: structure.marketStructure.trend,
      close: latest?.close ?? null,
      ema12: current?.ema12 ?? null,
      ema26: current?.ema26 ?? null,
      vwap: current?.vwap ?? null,
      rsi14: current?.rsi14 ?? null,
      macdHistogram: current?.macdHistogram ?? null,
      volumeRatio20: current?.volumeRatio20 ?? null,
      atr14: current?.atr14 ?? null,
    });
  }), [mode, queries, selection.market, supplementalTimeframes]);

  const contexts = useMemo(
    () => [currentChartEvidence, ...(multiTimeframeRequested ? supplementalContexts : [])],
    [currentChartEvidence, multiTimeframeRequested, supplementalContexts],
  );
  const aggregate = useMemo(
    () => aggregateMultiTimeframe(mode, contexts, selectedTimeframe),
    [contexts, mode, selectedTimeframe],
  );
  const current = currentContext(contexts, selection.timeframe) ?? currentChartEvidence;
  const plan = mapPricePlan(selection.pricePlan);
  const lifecycle = signalLifecycleFromAnalysis(analysis?.status);
  const invalidationText = analysis?.invalidationConditions?.[0]
    ?? (plan.invalidation != null ? `가격 ${formatPrice(plan.invalidation, selection.market)} 무효화` : 'UNAVAILABLE');
  const scannerLinked = Boolean(selection.searchRunId || selection.action || selection.signalScore != null || selection.confidence != null);
  const signalId = signalIdFromContext(selection, analysis);
  const supplementalLoading = multiTimeframeRequested && queries.some((query) => query.isFetching);

  const toggleSignalOverlay = () => {
    setSignalOverlayVisible((currentVisible) => {
      const next = !currentVisible;
      if (typeof window !== 'undefined') window.localStorage.setItem(SIGNAL_OVERLAY_STORAGE_KEY, String(next));
      return next;
    });
  };

  return (
    <section className="space-y-4" data-testid="ai-chart-v2-intelligence">
      <AiChartSignalOverlayPortal
        visible={signalOverlayVisible}
        selection={selection}
        side={current.side}
        score={current.score}
        lifecycle={lifecycle}
        mode={mode}
        signalId={signalId}
      />

      <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-extrabold text-primary">AI CHART 2.0</p>
            <h2 className="mt-1 text-sm font-black">분석 모드</h2>
          </div>
          <span className="rounded-full border border-card-border bg-background px-2 py-1 text-[10px] font-black">
            {lifecycle}
          </span>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2" role="group" aria-label="AI 차트 분석 모드">
          {MODE_OPTIONS.map((item) => (
            <button
              key={item.key}
              type="button"
              data-testid={`strategy-mode-${item.key}`}
              aria-pressed={mode === item.key}
              onClick={() => onModeChange(item.key)}
              className={cn(
                'min-w-0 rounded-2xl border px-2 py-2 text-center',
                mode === item.key
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-card-border bg-background text-muted-foreground',
              )}
            >
              <span className="block truncate text-[10px] font-black sm:text-xs">{item.label}</span>
              <span className="mt-0.5 hidden text-[9px] font-bold opacity-80 sm:block">{item.description}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          data-testid="toggle-ai-signal-overlay"
          aria-pressed={signalOverlayVisible}
          onClick={toggleSignalOverlay}
          className="mt-2 flex w-full items-center justify-between rounded-2xl border border-card-border bg-background px-3 py-2 text-left text-[10px] font-black"
        >
          <span>AI Signals · BUY / SELL / LONG / SHORT / WAIT</span>
          <span>{signalOverlayVisible ? 'ON' : 'OFF'}</span>
        </button>
      </section>

      <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm" data-testid="multi-timeframe-ai">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <Clock3 className="h-4 w-4 text-primary" />
            <div>
              <h2 className="text-sm font-black">Multi-Timeframe</h2>
              <p className="text-[10px] font-bold text-muted-foreground">기존 차트 단일 요청 계약을 보존하고 필요할 때만 보조 시간봉 조회</p>
            </div>
          </div>
          <button
            type="button"
            data-testid="load-multi-timeframe"
            onClick={() => setMultiTimeframeRequested(true)}
            disabled={multiTimeframeRequested}
            className="shrink-0 rounded-xl border border-card-border bg-background px-2.5 py-1.5 text-[9px] font-black disabled:opacity-60"
          >
            {supplementalLoading ? '분석 중…' : multiTimeframeRequested ? '분석 요청됨' : '다중 시간봉 분석'}
          </button>
        </div>
        {!multiTimeframeRequested ? (
          <div data-testid="mtf-not-loaded" className="mt-3 rounded-2xl border border-dashed border-card-border bg-background p-3">
            <p className="text-[10px] font-bold leading-4 text-muted-foreground">
              현재 차트는 추가 네트워크 요청 없이 기존 분석 컨텍스트를 사용합니다. 버튼을 누르면 {modeTimeframes.join(' · ')} 중 현재 시간봉을 제외한 보조 시간봉을 병렬 조회하며 자동 polling은 만들지 않습니다.
            </p>
          </div>
        ) : (
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
            {aggregate.contexts.map((context) => (
              <div
                key={context.timeframe}
                data-testid={`mtf-${context.timeframe}`}
                className="rounded-2xl border border-card-border bg-background p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <strong className="text-xs">{context.timeframe}</strong>
                  <span className={cn('rounded-full border px-1.5 py-0.5 text-[8px] font-black', qualityClass(context.quality))}>
                    {context.quality}
                  </span>
                </div>
                <div className="mt-2 flex items-end justify-between gap-2">
                  <span className={cn('text-sm font-black', sideClass(context.side))}>{context.side}</span>
                  <span className="text-[10px] font-black text-muted-foreground">
                    {context.score == null ? 'INSUFFICIENT' : `${context.score}`}
                  </span>
                </div>
                <p className="mt-1 truncate text-[9px] font-bold text-muted-foreground">{context.source}</p>
              </div>
            ))}
          </div>
        )}
        {multiTimeframeRequested && aggregate.higherTimeframeConflict && (
          <div role="alert" data-testid="higher-timeframe-conflict" className="mt-3 flex gap-2 rounded-2xl border border-warning/30 bg-warning/5 p-3">
            <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
            <p className="text-[10px] font-bold leading-4 text-muted-foreground">
              현재 방향과 상위 시간봉이 충돌합니다: {aggregate.conflictTimeframes.join(', ')}. 추격 진입보다 상위 구조 확인을 우선합니다.
            </p>
          </div>
        )}
      </section>

      <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm" data-testid="ai-evidence-panel">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            {isPositiveSide(current.side)
              ? <TrendingUp className="h-4 w-4 shrink-0 text-destructive" />
              : current.side === 'SELL' || current.side === 'SHORT'
                ? <TrendingDown className="h-4 w-4 shrink-0 text-blue-500" />
                : <BarChart3 className="h-4 w-4 shrink-0 text-muted-foreground" />}
            <div className="min-w-0">
              <p className="text-[10px] font-bold text-muted-foreground">Current Decision</p>
              <h2 className={cn('truncate text-base font-black', sideClass(current.side))}>
                {current.side} {current.score == null ? '' : `· ${current.score}`}
              </h2>
            </div>
          </div>
          <span className={cn('rounded-full border px-2 py-1 text-[9px] font-black', qualityClass(current.quality))}>
            {current.quality}
          </span>
        </div>

        {current.state === 'INSUFFICIENT_DATA' ? (
          <div className="mt-3 rounded-2xl border border-warning/30 bg-warning/5 p-3 text-xs font-bold text-muted-foreground" data-testid="insufficient-data-evidence">
            INSUFFICIENT_DATA — 데이터가 충분해질 때까지 확률·점수를 임의 생성하지 않습니다.
          </div>
        ) : null}

        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
          <EvidenceList
            title="Positive Factors"
            icon={<CheckCircle2 className="h-3.5 w-3.5 text-positive" />}
            items={current.positiveFactors}
            empty="상승 근거 없음"
          />
          <EvidenceList
            title="Negative Factors"
            icon={<TrendingDown className="h-3.5 w-3.5 text-blue-500" />}
            items={current.negativeFactors}
            empty="하락 근거 없음"
          />
          <EvidenceList
            title="Risk Factors"
            icon={<ShieldAlert className="h-3.5 w-3.5 text-warning" />}
            items={[
              ...current.riskFactors,
              ...(multiTimeframeRequested && aggregate.higherTimeframeConflict ? [`상위 시간봉 충돌: ${aggregate.conflictTimeframes.join(', ')}`] : []),
            ]}
            empty="추가 위험 근거 없음"
          />
          <EvidenceList
            title="Invalidation"
            icon={<AlertTriangle className="h-3.5 w-3.5 text-destructive" />}
            items={[invalidationText]}
            empty="UNAVAILABLE"
          />
        </div>
      </section>

      <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm" data-testid="ai-chart-order-plan-preview">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-extrabold text-primary">ORDER PLAN PREVIEW</p>
            <h2 className="mt-1 text-sm font-black">Entry · Stop · Target</h2>
          </div>
          <span className="rounded-full border border-warning/30 bg-warning/5 px-2 py-1 text-[9px] font-black text-warning">PREVIEW ONLY</span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
          <PlanMetric label="ENTRY 1" value={formatPrice(plan.entries[0], selection.market)} />
          <PlanMetric label="ENTRY 2" value={formatPrice(plan.entries[1], selection.market)} />
          <PlanMetric label="ENTRY 3" value={formatPrice(plan.entries[2], selection.market)} />
          <PlanMetric label="STOP" value={formatPrice(plan.stop, selection.market)} />
          <PlanMetric label="TP 1" value={formatPrice(plan.targets[0], selection.market)} />
          <PlanMetric label="TP 2" value={formatPrice(plan.targets[1], selection.market)} />
          <PlanMetric label="TP 3" value={formatPrice(plan.targets[2], selection.market)} />
          <PlanMetric label="R:R" value={plan.riskReward == null ? 'UNAVAILABLE' : plan.riskReward.toFixed(2)} />
        </div>
        <p className="mt-3 text-[10px] font-bold leading-4 text-muted-foreground">
          Scanner/Risk output만 표시합니다. 없는 ENTRY/TP 가격을 차트가 임의 생성하지 않습니다.
        </p>
      </section>

      <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm" data-testid="ai-chart-data-provenance">
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-black">Data Quality · Provenance</h2>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] font-bold">
          <div className="rounded-2xl bg-background p-3">
            <span className="text-muted-foreground">Scanner 연결</span>
            <strong className="mt-1 block">{scannerLinked ? 'LINKED' : 'NO_SCANNER_CONTEXT'}</strong>
          </div>
          <div className="rounded-2xl bg-background p-3">
            <span className="text-muted-foreground">실행 계층</span>
            <strong className="mt-1 block">READ_ONLY_PREVIEW</strong>
          </div>
        </div>
        <p className="mt-3 text-[10px] font-semibold leading-4 text-muted-foreground">
          현재 차트 데이터는 기존 단일 owner를 재사용합니다. 보조 시간봉은 명시적 MTF 분석 요청에서만 기존 provider/cache 계약으로 읽고 별도 polling을 만들지 않습니다.
        </p>
      </section>
    </section>
  );
}

function EvidenceList({ title, icon, items, empty }: {
  title: string;
  icon: ReactNode;
  items: string[];
  empty: string;
}) {
  return (
    <div className="rounded-2xl border border-card-border bg-background p-3">
      <div className="flex items-center gap-1.5">
        {icon}
        <h3 className="text-[10px] font-black">{title}</h3>
      </div>
      <ul className="mt-2 space-y-1 text-[10px] font-bold leading-4 text-muted-foreground">
        {items.length ? items.slice(0, 5).map((item) => <li key={item}>• {item}</li>) : <li>• {empty}</li>}
      </ul>
    </div>
  );
}

function PlanMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-card-border bg-background p-3">
      <p className="text-[9px] font-black text-muted-foreground">{label}</p>
      <strong className="mt-1 block break-words text-[11px]">{value}</strong>
    </div>
  );
}
