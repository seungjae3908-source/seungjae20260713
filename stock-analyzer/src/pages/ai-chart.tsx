import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  Clock3,
  Database,
  Minus,
  MonitorUp,
  ShieldAlert,
  TrendingDown,
  TrendingUp,
  X,
} from 'lucide-react';
import { useLocation } from 'wouter';
import { AiChartPositionPanel } from '@/components/ai-chart-position-panel';
import { BottomNav } from '@/components/bottom-nav';
import { ResponsiveTabs } from '@/components/responsive-tabs';
import { UnifiedAnalysisChart } from '@/components/unified-analysis-chart';
import {
  defaultStrategyMode,
  normalizeStrategyMode,
  strategyModeTimeframes,
  type AiChartStrategyMode,
} from '@/lib/ai-chart-v2-intelligence';
import {
  useAnalysisSelection,
  type AnalysisSelection,
} from '@/lib/analysis-selection';
import type { ChartAnalysis, ChartAnalysisBias, ChartAnalysisStatus } from '@/lib/chart-analysis';
import {
  acceptChartWindowMessage,
  attachChartWindowLifecycleListeners,
  buildChartPath,
  buildExternalChartPath,
  chartExternalWindowChannel,
  chartPairIdFromSearch,
  chartSelectionFromSearch,
  chartSelectionKey,
  chartSyncIdFromSearch,
  chartWindowRouteModeFromSearch,
  CHART_EXTERNAL_WINDOW_NAME,
  createChartWindowMessage,
  createChartWindowSourceId,
  externalChartWindowFeatures,
  hasChartRouteSelection,
  initialChartWindowPeerState,
  isDesktopChartViewport,
  mergeChartRouteSelection,
  nextChartWindowMessageClock,
  normalizeChartWindowSelection,
  selectionOrderFromMessage,
  shouldApplyChartSelection,
  startChartPopupClosedPolling,
  type ChartExternalWindowMessage,
  type ChartSelectionOrder,
  type ChartWindowMessageClock,
  type ChartWindowMessageContext,
  type ChartWindowMessageType,
  type ChartWindowPeerState,
} from '@/lib/chart-external-window';
import {
  UNIFIED_CHART_TIMEFRAMES,
  unifiedMarketLabel,
  type UnifiedChartTimeframe,
} from '@/lib/unified-chart-data';
import { cn } from '@/lib/utils';

const CURRENT_TIMEFRAMES = new Set(UNIFIED_CHART_TIMEFRAMES.map((item) => item.key));
const AI_CHART_MODE_STORAGE_KEY = 'ai-chart-v2-strategy-mode.v1';

const LazyAiChartV2IntelligencePanel = lazy(() =>
  import('@/components/ai-chart-v2-intelligence-panel').then(({ AiChartV2IntelligencePanel }) => ({
    default: AiChartV2IntelligencePanel,
  })),
);
const LazyFuturesPublicContextPanel = lazy(() =>
  import('@/components/futures-public-context-panel').then(({ FuturesPublicContextPanel }) => ({
    default: FuturesPublicContextPanel,
  })),
);

type MobileChartTab = 'summary' | 'chart' | 'position' | 'details';

const MOBILE_CHART_TABS = [
  { value: 'summary', label: '요약' },
  { value: 'chart', label: '차트' },
  { value: 'position', label: '내 포지션' },
  { value: 'details', label: '상세' },
] as const;

function fallbackSelection(): AnalysisSelection {
  return {
    assetType: 'stock',
    market: 'KR',
    symbol: '005930',
    ticker: '005930',
    displayName: '삼성전자',
    timeframe: '5m',
    selectedAt: new Date().toISOString(),
  };
}

function statusLabel(status: ChartAnalysisStatus): string {
  const labels: Record<ChartAnalysisStatus, string> = {
    forming: '형성 중',
    candidate: '후보',
    confirmed: '확정',
    weakened: '약화',
    invalidated: '무효화',
    expired: '만료',
  };
  return labels[status];
}

function biasLabel(bias: ChartAnalysisBias): string {
  return bias === 'bullish' ? '상승 우세' : bias === 'bearish' ? '하락 우세' : '중립';
}

function BiasIcon({ bias }: { bias: ChartAnalysisBias }) {
  if (bias === 'bullish') return <TrendingUp className="h-4 w-4 text-destructive" />;
  if (bias === 'bearish') return <TrendingDown className="h-4 w-4 text-blue-500" />;
  return <Minus className="h-4 w-4 text-muted-foreground" />;
}

function formatAnalysisTime(value: string | undefined): string {
  if (!value) return '-';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '-';
  return new Date(timestamp).toLocaleString('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatPlanPrice(value: number | null | undefined, market: AnalysisSelection['market']): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return '미확인';
  if (market === 'US') return `$${value.toLocaleString('ko-KR', { maximumFractionDigits: 4 })}`;
  if (market === 'BITGET') return `${value.toLocaleString('ko-KR', { maximumFractionDigits: value >= 1000 ? 2 : 8 })} USDT`;
  return `${value.toLocaleString('ko-KR', { maximumFractionDigits: value >= 1000 ? 0 : 8 })}원`;
}

function actionLabel(action: AnalysisSelection['action']): string {
  if (action === 'BUY') return '매수';
  if (action === 'SELL') return '매도';
  if (action === 'LONG') return '상승';
  if (action === 'SHORT') return '하락';
  if (action === 'NO_TRADE' || action === 'NONE') return '거래 안 함';
  return '판단 대기';
}

function strategyModeLabel(mode: AiChartStrategyMode): string {
  if (mode === 'SCALPING') return '단타';
  if (mode === 'SWING') return '스윙';
  return '중장기';
}

function sameSelection(left: AnalysisSelection, right: AnalysisSelection): boolean {
  return chartSelectionKey(left) === chartSelectionKey(right)
    && left.displayName === right.displayName;
}

function supportedSelection(value: AnalysisSelection | null): AnalysisSelection | null {
  const normalized = value ? normalizeChartWindowSelection(value) : null;
  return normalized && CURRENT_TIMEFRAMES.has(normalized.timeframe as never) ? normalized : null;
}

function isMobileUserAgent(userAgent: string): boolean {
  return /Android|iPhone|iPad|iPod|Mobile|IEMobile|Opera Mini/i.test(userAgent);
}

function currentBrowserSearch(): string {
  return typeof window === 'undefined' ? '' : window.location.search;
}

function currentOrigin(): string {
  return typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
}

function safeFocus(popup: Window): void {
  try {
    popup.focus();
  } catch {
    // Focus denial does not invalidate an already-open external chart.
  }
}

function initialStrategyMode(selection: AnalysisSelection): AiChartStrategyMode {
  const fallback = defaultStrategyMode(selection.timeframe as UnifiedChartTimeframe);
  if (typeof window === 'undefined') return fallback;
  const routeValue = new URLSearchParams(window.location.search).get('strategyMode');
  if (routeValue) return normalizeStrategyMode(routeValue, fallback);
  return normalizeStrategyMode(window.localStorage.getItem(AI_CHART_MODE_STORAGE_KEY), fallback);
}

function useDesktopChartLayout(): boolean {
  const query = '(min-width: 1024px)';
  const [desktop, setDesktop] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);

  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setDesktop(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  return desktop;
}

function MobileSummary({ selection, analysis }: { selection: AnalysisSelection; analysis: ChartAnalysis | null }) {
  const plan = selection.pricePlan;
  const confidence = analysis?.confidence ?? selection.confidence;
  const reason = analysis?.summary ?? selection.reasons?.[0] ?? '확인된 추가 설명 없음';

  return (
    <section data-testid="ai-chart-mobile-summary" className="space-y-3 rounded-3xl border border-card-border bg-card p-4 shadow-sm">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-lg font-black">{selection.displayName}</p>
          <p className="mt-0.5 truncate text-[11px] font-bold text-muted-foreground">
            {unifiedMarketLabel(selection.market)} · {selection.timeframe}
          </p>
        </div>
        <span className="shrink-0 rounded-full border border-primary/30 bg-primary/10 px-3 py-1.5 text-xs font-black text-primary">
          {actionLabel(selection.action)}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-2xl bg-background p-2.5">
          <p className="text-[10px] text-muted-foreground">신호점수</p>
          <strong className="mt-0.5 block text-sm tabular-nums">{selection.signalScore ?? '-'}</strong>
        </div>
        <div className="rounded-2xl bg-background p-2.5">
          <p className="text-[10px] text-muted-foreground">신뢰도</p>
          <strong className="mt-0.5 block text-sm tabular-nums">{confidence ?? '-'}</strong>
        </div>
        <div className="rounded-2xl bg-background p-2.5">
          <p className="text-[10px] text-muted-foreground">위험</p>
          <strong className="mt-0.5 block truncate text-sm">{selection.riskLevel || '미확인'}</strong>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-2xl border border-card-border p-3">
          <p className="text-[10px] font-bold text-muted-foreground">진입</p>
          <strong className="mt-1 block tabular-nums">
            {plan?.entryZone
              ? `${formatPlanPrice(plan.entryZone.from, selection.market)} ~ ${formatPlanPrice(plan.entryZone.to, selection.market)}`
              : '미확인'}
          </strong>
        </div>
        <div className="rounded-2xl border border-card-border p-3">
          <p className="text-[10px] font-bold text-muted-foreground">손절</p>
          <strong className="mt-1 block tabular-nums">{formatPlanPrice(plan?.stopLoss ?? plan?.invalidation, selection.market)}</strong>
        </div>
        <div className="rounded-2xl border border-card-border p-3">
          <p className="text-[10px] font-bold text-muted-foreground">목표 1</p>
          <strong className="mt-1 block tabular-nums">{formatPlanPrice(plan?.targets?.[0], selection.market)}</strong>
        </div>
        <div className="rounded-2xl border border-card-border p-3">
          <p className="text-[10px] font-bold text-muted-foreground">손익비</p>
          <strong className="mt-1 block tabular-nums">{plan?.riskReward == null ? '미확인' : plan.riskReward.toFixed(2)}</strong>
        </div>
      </div>

      <div className="rounded-2xl bg-secondary/60 px-3 py-3">
        <p className="text-[10px] font-black text-muted-foreground">핵심 판단</p>
        <p className="mt-1 line-clamp-2 break-keep text-xs font-bold leading-5">{reason}</p>
      </div>

      <p className="text-center text-[10px] font-bold text-muted-foreground">읽기 전용 · 주문 실행 없음</p>
    </section>
  );
}

function ContextCard({ selection, analysis }: { selection: AnalysisSelection; analysis: ChartAnalysis | null }) {
  return (
    <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <Activity className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-black">현재 상태</h2>
      </div>
      <h3 className="mt-3 truncate text-lg font-black">{selection.displayName}</h3>
      <p className="mt-1 truncate text-xs font-bold text-muted-foreground">
        {selection.ticker} · {unifiedMarketLabel(selection.market)} · {selection.timeframe}
      </p>
      <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
        <div className="rounded-2xl bg-background p-2">
          <p className="text-[10px] text-muted-foreground">분석</p>
          <strong>{analysis ? statusLabel(analysis.status) : '대기'}</strong>
        </div>
        <div className="rounded-2xl bg-background p-2">
          <p className="text-[10px] text-muted-foreground">방향</p>
          <strong>{analysis ? biasLabel(analysis.bias) : '-'}</strong>
        </div>
        <div data-testid="analysis-signal-score" className="rounded-2xl bg-background p-2">
          <p className="text-[10px] text-muted-foreground">신뢰도</p>
          <strong>{analysis?.confidence ?? selection.confidence ?? '-'}</strong>
        </div>
      </div>
    </section>
  );
}

function DecisionCard({ analysis }: { analysis: ChartAnalysis | null }) {
  return (
    <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <Database className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-black">현재 판단</h2>
      </div>
      {analysis ? (
        <div className="mt-3 space-y-3 text-xs">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <BiasIcon bias={analysis.bias} />
                <strong className="line-clamp-2 break-keep text-sm">{analysis.title}</strong>
              </div>
            </div>
            <span
              className={cn(
                'shrink-0 rounded-full border px-2 py-1 text-[10px] font-black',
                analysis.status === 'confirmed'
                  ? 'border-primary/30 bg-primary/10 text-primary'
                  : analysis.status === 'invalidated' || analysis.status === 'expired'
                    ? 'border-muted bg-muted text-muted-foreground'
                    : 'border-warning/30 bg-warning/10 text-warning',
              )}
            >
              {statusLabel(analysis.status)}
            </span>
          </div>

          <p className="line-clamp-3 break-keep rounded-2xl bg-secondary/70 px-3 py-3 leading-5 text-foreground">
            {analysis.summary}
          </p>

          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-2xl border border-card-border bg-background p-3">
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Clock3 className="h-3.5 w-3.5" />
                <span className="text-[10px] font-bold">감지</span>
              </div>
              <strong className="mt-1 block text-[11px]">{formatAnalysisTime(analysis.detectedAt)}</strong>
            </div>
            <div className="rounded-2xl border border-card-border bg-background p-3">
              <p className="text-[10px] font-bold text-muted-foreground">최근 변화</p>
              <strong className="mt-1 block line-clamp-2 break-keep text-[11px]">
                {analysis.transitionReason ?? '최초 분석'}
              </strong>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            <CompactList title="판단 근거" items={analysis.reasons} />
            <CompactList title="확인 조건" items={analysis.confirmationConditions} />
            <CompactList title="무효 조건" items={analysis.invalidationConditions} danger />
          </div>
        </div>
      ) : (
        <p className="mt-3 text-xs font-bold text-muted-foreground">차트 데이터 확인 후 표시됩니다.</p>
      )}
    </section>
  );
}

function CompactList({ title, items, danger = false }: { title: string; items: string[]; danger?: boolean }) {
  const visible = items.filter(Boolean).slice(0, 3);
  return (
    <div className="rounded-2xl border border-card-border bg-background p-3">
      <p className={cn('text-[10px] font-black', danger && 'text-destructive')}>{title}</p>
      {visible.length ? (
        <ul className="mt-1 space-y-1 text-[10px] leading-4 text-muted-foreground">
          {visible.map((item) => <li key={item} className="line-clamp-2">• {item}</li>)}
        </ul>
      ) : <p className="mt-1 text-[10px] text-muted-foreground">미확인</p>}
    </div>
  );
}

function SafetyNote() {
  return (
    <p className="flex items-center gap-2 rounded-2xl border border-warning/30 bg-warning/5 px-3 py-2.5 text-[10px] font-bold text-muted-foreground">
      <ShieldAlert className="h-4 w-4 shrink-0 text-warning" />
      읽기 전용 · 확정된 근거만 표시 · 주문 실행 없음
    </p>
  );
}

export default function AiChartPage({ embedded = false }: { embedded?: boolean }) {
  const [, navigate] = useLocation();
  const state = useAnalysisSelection();
  const selectSelection = state.select;
  const desktop = useDesktopChartLayout();
  const initialSearchRef = useRef(currentBrowserSearch());
  const routeModeRef = useRef(chartWindowRouteModeFromSearch(initialSearchRef.current));
  const routeSelectionRef = useRef(supportedSelection(chartSelectionFromSearch(initialSearchRef.current)));
  const externalMode = routeModeRef.current === 'external';
  const externalSyncId = chartSyncIdFromSearch(initialSearchRef.current);
  const externalPairId = chartPairIdFromSearch(initialSearchRef.current);
  const invalidRoute = routeModeRef.current === 'invalid'
    || (hasChartRouteSelection(initialSearchRef.current) && !routeSelectionRef.current)
    || (externalMode && (!externalSyncId || !externalPairId));
  const initialSelectionRef = useRef<AnalysisSelection>((() => {
    const storedSelection = supportedSelection(state.selection);
    return mergeChartRouteSelection(routeSelectionRef.current, storedSelection)
      ?? storedSelection
      ?? fallbackSelection();
  })());
  const initialSelection = initialSelectionRef.current;

  const [selection, setSelection] = useState<AnalysisSelection>(initialSelection);
  const [analysis, setAnalysis] = useState<ChartAnalysis | null>(null);
  const [strategyMode, setStrategyMode] = useState<AiChartStrategyMode>(() => initialStrategyMode(initialSelection));
  const [mobileTab, setMobileTab] = useState<MobileChartTab>('summary');
  const [externalControlAvailable, setExternalControlAvailable] = useState(false);
  const [externalWindowStatus, setExternalWindowStatus] = useState<string | null>(() => {
    if (routeModeRef.current === 'invalid') return '외부 차트 경로가 올바르지 않아 동기화를 시작하지 않았습니다.';
    if (externalMode && (!externalSyncId || !externalPairId)) return '외부 차트 세션 정보가 없거나 올바르지 않습니다.';
    if (hasChartRouteSelection(initialSearchRef.current) && !routeSelectionRef.current) {
      return '시장·종목·시간봉 입력이 올바르지 않아 기존 정상 선택을 유지합니다.';
    }
    return null;
  });

  const sourceIdRef = useRef(createChartWindowSourceId());
  const syncSessionIdRef = useRef(externalMode ? externalSyncId : createChartWindowSourceId());
  const pairIdRef = useRef(externalMode ? externalPairId : createChartWindowSourceId());
  const sourceRole = externalMode ? 'external' : 'main';
  const messageContextRef = useRef<ChartWindowMessageContext>({
    sessionId: syncSessionIdRef.current,
    pairId: pairIdRef.current,
    sourceId: sourceIdRef.current,
    sourceRole,
    origin: currentOrigin(),
  });
  const channelRef = useRef<BroadcastChannel | null>(null);
  const popupRef = useRef<Window | null>(null);
  const popupPollCleanupRef = useRef<(() => void) | null>(null);
  const popupPublishTimeoutRef = useRef<number | null>(null);
  const peerStateRef = useRef<ChartWindowPeerState>(initialChartWindowPeerState());
  const messageClockRef = useRef<ChartWindowMessageClock>({ sequence: 0, sentAt: 0 });
  const selectionOrderRef = useRef<ChartSelectionOrder | null>(null);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  const ignorePositionOverlay = useCallback(() => {}, []);

  const stopPopupTracking = useCallback(() => {
    popupPollCleanupRef.current?.();
    popupPollCleanupRef.current = null;
    if (popupPublishTimeoutRef.current != null) {
      window.clearTimeout(popupPublishTimeoutRef.current);
      popupPublishTimeoutRef.current = null;
    }
  }, []);

  const updateStrategyMode = useCallback((nextMode: AiChartStrategyMode) => {
    setStrategyMode(nextMode);
    if (typeof window !== 'undefined') window.localStorage.setItem(AI_CHART_MODE_STORAGE_KEY, nextMode);
  }, []);

  useEffect(() => {
    if (invalidRoute) return;
    selectSelection(initialSelection);
  }, [initialSelection, invalidRoute, selectSelection]);

  useEffect(() => {
    if (!embedded || !state.selection) return;
    const normalized = supportedSelection(state.selection);
    if (!normalized || sameSelection(selectionRef.current, normalized)) return;
    selectionRef.current = normalized;
    setSelection(normalized);
    setAnalysis(null);
    setMobileTab('summary');
  }, [embedded, state.selection]);

  useEffect(() => {
    if (embedded || externalMode || invalidRoute || typeof window === 'undefined') {
      setExternalControlAvailable(false);
      return;
    }
    const update = () => setExternalControlAvailable(
      typeof BroadcastChannel !== 'undefined'
      && isDesktopChartViewport(window.innerWidth, isMobileUserAgent(window.navigator.userAgent)),
    );
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [embedded, externalMode, invalidRoute]);

  const postWindowMessage = useCallback((
    type: ChartWindowMessageType,
    nextSelection?: AnalysisSelection,
  ): ChartExternalWindowMessage | null => {
    const channel = channelRef.current;
    if (!channel) return null;
    const clock = nextChartWindowMessageClock(messageClockRef.current);
    messageClockRef.current = clock;
    const message = type === 'selection'
      ? nextSelection
        ? createChartWindowMessage('selection', messageContextRef.current, clock, nextSelection)
        : null
      : createChartWindowMessage(type, messageContextRef.current, clock);
    if (!message) return null;
    channel.postMessage(message);
    return message;
  }, []);

  const publishSelection = useCallback((next: AnalysisSelection, trackOrder = true) => {
    const message = postWindowMessage('selection', next);
    if (!message) return;
    if (trackOrder) selectionOrderRef.current = selectionOrderFromMessage(message);
  }, [postWindowMessage]);

  const applySelection = useCallback((next: AnalysisSelection, publish: boolean) => {
    const normalized = supportedSelection(next);
    if (!normalized || sameSelection(selectionRef.current, normalized)) return;
    selectionRef.current = normalized;
    setSelection(normalized);
    selectSelection(normalized);
    setAnalysis(null);
    if (publish) publishSelection(normalized);

    if (!embedded && typeof window !== 'undefined') {
      const nextLocation = buildChartPath(
        normalized,
        externalMode ? { syncId: syncSessionIdRef.current, pairId: pairIdRef.current } : undefined,
      );
      if (`${window.location.pathname}${window.location.search}` !== nextLocation) {
        navigate(nextLocation, { replace: true });
      }
    }
  }, [embedded, externalMode, navigate, publishSelection, selectSelection]);

  useEffect(() => {
    if (embedded || invalidRoute || typeof window === 'undefined') return;
    if (typeof BroadcastChannel === 'undefined') {
      setExternalControlAvailable(false);
      if (externalMode) setExternalWindowStatus('이 브라우저는 외부 차트 동기화를 지원하지 않습니다.');
      return;
    }

    const channel = new BroadcastChannel(chartExternalWindowChannel(syncSessionIdRef.current, pairIdRef.current));
    channelRef.current = channel;
    peerStateRef.current = initialChartWindowPeerState();
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const accepted = acceptChartWindowMessage(event.data, {
        sessionId: syncSessionIdRef.current,
        pairId: pairIdRef.current,
        localSourceId: sourceIdRef.current,
        localRole: sourceRole,
        origin: window.location.origin,
      }, peerStateRef.current);
      if (!accepted) return;
      peerStateRef.current = accepted.state;
      const { message } = accepted;
      messageClockRef.current = {
        sequence: messageClockRef.current.sequence,
        sentAt: Math.max(messageClockRef.current.sentAt, message.sentAt),
      };

      if (message.type === 'ready') {
        publishSelection(selectionRef.current, false);
        if (externalMode) setExternalWindowStatus('본창과 안전하게 동기화되었습니다.');
        return;
      }
      if (message.type === 'closed') {
        if (externalMode) {
          setExternalWindowStatus('본창 연결이 종료되었습니다.');
        } else {
          stopPopupTracking();
          popupRef.current = null;
          setExternalWindowStatus('외부 차트 창이 닫혔습니다.');
        }
        return;
      }
      if (!shouldApplyChartSelection(message, selectionOrderRef.current)) return;
      const remoteSelection = supportedSelection(message.selection);
      if (!remoteSelection) return;

      selectionOrderRef.current = selectionOrderFromMessage(message);
      applySelection(mergeChartRouteSelection(remoteSelection, selectionRef.current) ?? remoteSelection, false);
    };

    const notifyReady = () => {
      if (document.visibilityState === 'visible') postWindowMessage('ready');
    };
    const notifyClosed = () => {
      postWindowMessage('closed');
      if (!externalMode) {
        try {
          popupRef.current?.close();
        } catch {
          // Cleanup continues even if the popup handle is no longer accessible.
        }
      }
    };
    const cleanupLifecycle = attachChartWindowLifecycleListeners({
      windowTarget: window,
      documentTarget: document,
      onBeforeUnload: notifyClosed,
      onVisible: notifyReady,
    });
    postWindowMessage('ready');

    return () => {
      postWindowMessage('closed');
      cleanupLifecycle();
      channel.onmessage = null;
      channel.close();
      if (channelRef.current === channel) channelRef.current = null;
      if (!externalMode) {
        stopPopupTracking();
        try {
          popupRef.current?.close();
        } catch {
          // The popup may already be gone.
        }
        popupRef.current = null;
      }
    };
  }, [applySelection, embedded, externalMode, invalidRoute, postWindowMessage, publishSelection, sourceRole, stopPopupTracking]);

  const updateSelection = useCallback((next: AnalysisSelection) => {
    applySelection(next, true);
  }, [applySelection]);

  const updateStrategyModeAndTimeframe = useCallback((nextMode: AiChartStrategyMode) => {
    updateStrategyMode(nextMode);
    const allowedTimeframes = strategyModeTimeframes(nextMode);
    const current = selectionRef.current;
    if (allowedTimeframes.includes(current.timeframe as UnifiedChartTimeframe)) return;
    updateSelection({
      ...current,
      timeframe: allowedTimeframes[0],
      selectedAt: new Date().toISOString(),
    });
  }, [updateSelection, updateStrategyMode]);

  const openExternalWindow = useCallback(() => {
    if (!externalControlAvailable || invalidRoute) return;
    const currentPopup = popupRef.current;
    if (currentPopup && !currentPopup.closed) {
      safeFocus(currentPopup);
      publishSelection(selectionRef.current);
      setExternalWindowStatus('이미 열린 외부 차트 창으로 이동했습니다.');
      return;
    }

    const popup = window.open(
      buildExternalChartPath(selectionRef.current, syncSessionIdRef.current, pairIdRef.current),
      CHART_EXTERNAL_WINDOW_NAME,
      externalChartWindowFeatures(window.screen),
    );
    if (!popup) {
      setExternalWindowStatus('팝업이 차단되었습니다. 팝업 허용 후 다시 시도하세요.');
      return;
    }

    try {
      popup.opener = null;
    } catch {
      // BroadcastChannel is the only synchronization path.
    }
    popupRef.current = popup;
    safeFocus(popup);
    setExternalWindowStatus('외부 차트 창을 열었습니다.');
    stopPopupTracking();
    popupPublishTimeoutRef.current = window.setTimeout(() => {
      popupPublishTimeoutRef.current = null;
      publishSelection(selectionRef.current);
    }, 250);
    popupPollCleanupRef.current = startChartPopupClosedPolling({
      popup,
      scheduler: {
        setInterval: (handler, timeout) => window.setInterval(handler, timeout),
        clearInterval: (handle) => window.clearInterval(handle),
      },
      onClosed: () => {
        popupPollCleanupRef.current = null;
        popupRef.current = null;
        setExternalWindowStatus('외부 차트 창이 닫혔습니다.');
      },
    });
  }, [externalControlAvailable, invalidRoute, publishSelection, stopPopupTracking]);

  const closeExternalWindow = useCallback(() => {
    postWindowMessage('closed');
    window.close();
  }, [postWindowMessage]);

  useEffect(() => {
    setAnalysis(null);
  }, [selection.market, selection.ticker, selection.timeframe]);

  const chart = (
    <UnifiedAnalysisChart
      selection={selection}
      onSelectionChange={updateSelection}
      onAnalysisChange={setAnalysis}
    />
  );

  const intelligencePanel = (
    <Suspense fallback={null}>
      <LazyAiChartV2IntelligencePanel
        selection={selection}
        analysis={analysis}
        mode={strategyMode}
        onModeChange={updateStrategyModeAndTimeframe}
      />
    </Suspense>
  );

  const details = (
    <div className="space-y-4">
      {intelligencePanel}
      <Suspense fallback={null}>
        <LazyFuturesPublicContextPanel selection={selection} />
      </Suspense>
      <ContextCard selection={selection} analysis={analysis} />
      <DecisionCard analysis={analysis} />
      <SafetyNote />
    </div>
  );

  const mobile = !desktop && !externalMode && !embedded;

  return (
    <div className={`h-full min-w-0 overflow-y-auto overscroll-contain bg-background ${embedded || externalMode ? 'pb-4' : 'pb-24'}`}>
      <header className="sticky top-0 z-30 border-b border-card-border bg-background/95 px-3 py-2.5 backdrop-blur-xl sm:px-4 sm:py-3">
        <div className="mx-auto flex max-w-7xl items-center gap-3">
          {!embedded && !externalMode && (
            <button
              type="button"
              aria-label="기술 화면으로 돌아가기"
              onClick={() => navigate('/scanner')}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-card-border bg-card"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-[10px] font-extrabold text-primary">{externalMode ? '외부 AI 차트' : selection.displayName}</p>
            <h1 aria-label="AI 차트 생중계 · AI 차트 2.0" className="truncate text-base font-black sm:text-lg">AI 차트</h1>
          </div>
          {!embedded && !externalMode && externalControlAvailable && (
            <button
              type="button"
              data-testid="open-external-ai-chart"
              onClick={openExternalWindow}
              className="flex h-10 items-center gap-2 rounded-xl border border-card-border bg-card px-3 text-xs font-black"
            >
              <MonitorUp className="h-4 w-4" />
              외부창
            </button>
          )}
          {externalMode && (
            <button
              type="button"
              data-testid="close-external-ai-chart"
              aria-label="외부 AI 차트 닫기"
              onClick={closeExternalWindow}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-card-border bg-card"
            >
              <X className="h-4 w-4" />
            </button>
          )}
          <div className="shrink-0 text-right text-[10px] font-bold text-muted-foreground">
            <p>{unifiedMarketLabel(selection.market)} · {selection.timeframe}</p>
            <p>{strategyModeLabel(strategyMode)} · 읽기 전용</p>
          </div>
        </div>
        {externalWindowStatus && (
          <p data-testid="external-chart-status" className="mx-auto mt-2 max-w-7xl truncate text-[10px] font-bold text-muted-foreground">
            {externalWindowStatus}
          </p>
        )}
      </header>

      {mobile ? (
        <>
          <div className="sticky top-[57px] z-20 border-b border-card-border bg-background/95 px-2 py-2 backdrop-blur-xl sm:top-[61px]">
            <div className="mx-auto max-w-7xl">
              <ResponsiveTabs
                value={mobileTab}
                options={MOBILE_CHART_TABS}
                onChange={setMobileTab}
                ariaLabel="AI 차트 모바일 보기"
                testId="ai-chart-mobile-tabs"
                compact
              />
            </div>
          </div>
          <main className="mx-auto w-full max-w-7xl p-3 sm:p-4">
            {mobileTab === 'summary' ? <MobileSummary selection={selection} analysis={analysis} /> : null}
            {mobileTab === 'chart' ? (
              <section data-testid="ai-chart-mobile-chart" className="min-w-0 [&_[data-testid=ai-chart-position-panel]]:hidden">
                {chart}
                <div className="hidden" aria-hidden="true" data-testid="ai-chart-mobile-overlay-controller">
                  {intelligencePanel}
                </div>
              </section>
            ) : null}
            {mobileTab === 'position' ? (
              <section data-testid="ai-chart-mobile-position" className="min-w-0">
                <AiChartPositionPanel
                  market={selection.market}
                  symbol={selection.symbol || selection.ticker}
                  chartPrice={null}
                  pricePlan={selection.pricePlan}
                  onOverlayChange={ignorePositionOverlay}
                />
              </section>
            ) : null}
            {mobileTab === 'details' ? <section data-testid="ai-chart-mobile-details">{details}</section> : null}
          </main>
        </>
      ) : (
        <main className="mx-auto grid max-w-7xl gap-4 p-4 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
          <section className="min-w-0">{chart}</section>
          <aside className="min-w-0 lg:sticky lg:top-20 lg:self-start">{details}</aside>
        </main>
      )}

      {!embedded && !externalMode && <BottomNav />}
    </div>
  );
}