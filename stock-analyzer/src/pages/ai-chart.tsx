import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Database, MonitorUp, ShieldAlert, X } from 'lucide-react';
import { useLocation } from 'wouter';
import { BottomNav } from '@/components/bottom-nav';
import { ChartBroadcastPanel, type ChartBroadcastMarket } from '@/components/chart-broadcast';
import {
  useAnalysisSelection,
  type AnalysisMarket,
  type AnalysisSelection,
} from '@/lib/analysis-selection';
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
import type { ChartAnalysis } from '@/lib/chart-analysis';

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

function sameSelection(left: AnalysisSelection, right: AnalysisSelection): boolean {
  return chartSelectionKey(left) === chartSelectionKey(right)
    && left.displayName === right.displayName;
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

function marketLabel(market: AnalysisMarket): string {
  const labels: Record<AnalysisMarket, string> = {
    KR: '국내주식',
    US: '미국주식',
    UPBIT: '코인 현물',
    BITGET: '코인 선물',
  };
  return labels[market];
}

function safeFocus(popup: Window): void {
  try {
    popup.focus();
  } catch {
    // A browser may deny focus without invalidating the already-open chart window.
  }
}

export default function AiChartPage({ embedded = false }: { embedded?: boolean }) {
  const [, navigate] = useLocation();
  const state = useAnalysisSelection();
  const selectSelection = state.select;
  const initialSearchRef = useRef(currentBrowserSearch());
  const routeModeRef = useRef(chartWindowRouteModeFromSearch(initialSearchRef.current));
  const routeSelectionRef = useRef(chartSelectionFromSearch(initialSearchRef.current));
  const externalMode = routeModeRef.current === 'external';
  const externalSyncId = chartSyncIdFromSearch(initialSearchRef.current);
  const externalPairId = chartPairIdFromSearch(initialSearchRef.current);
  const invalidRoute = routeModeRef.current === 'invalid'
    || (hasChartRouteSelection(initialSearchRef.current) && !routeSelectionRef.current)
    || (externalMode && (!externalSyncId || !externalPairId));
  const initialSelectionRef = useRef<AnalysisSelection>((() => {
    const storedSelection = normalizeChartWindowSelection(state.selection);
    return mergeChartRouteSelection(routeSelectionRef.current, storedSelection)
      ?? storedSelection
      ?? fallbackSelection();
  })());
  const initialSelection = initialSelectionRef.current;

  const [selection, setSelection] = useState<AnalysisSelection>(initialSelection);
  const [analysis, setAnalysis] = useState<ChartAnalysis | null>(null);
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

  const stopPopupTracking = useCallback(() => {
    popupPollCleanupRef.current?.();
    popupPollCleanupRef.current = null;
    if (popupPublishTimeoutRef.current != null) {
      window.clearTimeout(popupPublishTimeoutRef.current);
      popupPublishTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!routeSelectionRef.current || invalidRoute) return;
    selectSelection(initialSelection);
  }, [initialSelection, invalidRoute, selectSelection]);

  useEffect(() => {
    if (!embedded || !state.selection) return;
    const normalized = normalizeChartWindowSelection(state.selection);
    if (!normalized || sameSelection(selectionRef.current, normalized)) return;
    selectionRef.current = normalized;
    setSelection(normalized);
    setAnalysis(null);
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

  const publishSelection = useCallback((next: AnalysisSelection) => {
    const message = postWindowMessage('selection', next);
    if (!message) return;
    selectionOrderRef.current = selectionOrderFromMessage(message);
  }, [postWindowMessage]);

  const applySelection = useCallback((next: AnalysisSelection, publish: boolean) => {
    const normalized = normalizeChartWindowSelection(next);
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
        publishSelection(selectionRef.current);
        if (externalMode) setExternalWindowStatus('본창과 안전하게 동기화되었습니다.');
        return;
      }
      if (message.type === 'closed') {
        if (externalMode) {
          setExternalWindowStatus('본창 연결이 종료되었습니다. 이 창에서는 새 선택을 동기화하지 않습니다.');
        } else {
          stopPopupTracking();
          popupRef.current = null;
          setExternalWindowStatus('외부 차트 창이 닫혔습니다.');
        }
        return;
      }
      if (!shouldApplyChartSelection(message, selectionOrderRef.current)) return;

      selectionOrderRef.current = selectionOrderFromMessage(message);
      applySelection(mergeChartRouteSelection(message.selection, selectionRef.current) ?? message.selection, false);
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
          // Cleanup must continue even if the browser no longer exposes the popup handle.
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

  const legacyMarket: ChartBroadcastMarket | null = selection.market === 'KR' || selection.market === 'US'
    ? selection.market
    : null;
  const updateSelection = useCallback((next: {
    ticker: string;
    name: string;
    market: ChartBroadcastMarket;
    timeframe: string;
  }) => {
    const current = selectionRef.current;
    applySelection({
      ...current,
      assetType: 'stock',
      market: next.market,
      symbol: next.ticker,
      ticker: next.ticker,
      displayName: next.name,
      timeframe: next.timeframe,
      selectedAt: current.market === next.market && current.ticker === next.ticker
        ? current.selectedAt
        : new Date().toISOString(),
    }, true);
  }, [applySelection]);

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
      setExternalWindowStatus('팝업이 차단되었습니다. 이 사이트의 팝업을 허용한 뒤 다시 시도하세요.');
      return;
    }

    try {
      popup.opener = null;
    } catch {
      // BroadcastChannel is the only synchronization path; opener access is not required.
    }
    popupRef.current = popup;
    safeFocus(popup);
    setExternalWindowStatus('외부 차트 창을 열었습니다. 종목·시장·시간봉이 하나의 선택으로 동기화됩니다.');
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

  return (
    <div className={`h-full overflow-y-auto overscroll-contain bg-background ${embedded || externalMode ? 'pb-4' : 'pb-24'}`}>
      <header className="sticky top-0 z-20 border-b border-card-border bg-background/95 px-4 py-3 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center gap-3">
          {!embedded && !externalMode && (
            <button
              type="button"
              aria-label="AI 검색기로 돌아가기"
              onClick={() => navigate('/scanner')}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-card-border bg-card"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          {externalMode && (
            <button
              type="button"
              aria-label="외부 차트 창 닫기"
              onClick={closeExternalWindow}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-card-border bg-card"
            >
              <X className="h-4 w-4" />
            </button>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-extrabold text-primary">기술탭</p>
            <h1 className="truncate text-lg font-black">AI 차트 분석기{externalMode ? ' · 외부 창' : ''}</h1>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {externalControlAvailable && (
              <button
                type="button"
                aria-label="외부 창"
                aria-describedby={externalWindowStatus ? 'external-chart-window-status' : undefined}
                onClick={openExternalWindow}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-card-border bg-card px-3 text-[11px] font-extrabold"
              >
                <MonitorUp className="h-4 w-4 text-primary" />
                외부 창
              </button>
            )}
            <div className="text-right text-[10px] font-bold text-muted-foreground">
              <p>{marketLabel(selection.market)} · {selection.timeframe}</p>
              <p>{externalMode ? '동기화 창' : 'REST 갱신형'}</p>
            </div>
          </div>
        </div>
      </header>

      {externalWindowStatus && (
        <div
          id="external-chart-window-status"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="mx-auto mt-3 max-w-7xl px-4"
        >
          <p className="rounded-2xl border border-primary/20 bg-primary/5 px-3 py-2 text-[11px] font-bold text-muted-foreground">
            {externalWindowStatus}
          </p>
        </div>
      )}

      <main className="mx-auto grid max-w-7xl gap-4 p-4 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
        <section className="min-w-0">
          {invalidRoute ? (
            <div role="alert" className="rounded-3xl border border-destructive/30 bg-destructive/5 p-6 text-sm font-bold text-destructive">
              잘못된 외부 차트 또는 종목 경로입니다. 임의 기본값으로 이동하지 않았습니다.
            </div>
          ) : legacyMarket ? (
            <ChartBroadcastPanel
              market={legacyMarket}
              initialSelection={{
                ticker: selection.ticker,
                name: selection.displayName,
                market: legacyMarket,
                timeframe: selection.timeframe,
              }}
              onAnalysisChange={setAnalysis}
              onSelectionChange={updateSelection}
            />
          ) : (
            <div role="status" className="rounded-3xl border border-warning/30 bg-warning/5 p-6 text-sm font-bold text-warning">
              현재 PR 브랜치의 구형 차트는 국내·미국주식만 표시합니다. 코인 선택을 국내주식으로 바꾸지 않았으며, 최신 main 통합 후 UnifiedAnalysisChart를 그대로 사용합니다.
            </div>
          )}
        </section>

        <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
            <p className="text-[11px] font-extrabold text-primary">AI 검색기에서 전달된 선택</p>
            <h2 className="mt-1 text-lg font-black">{selection.displayName}</h2>
            <p className="mt-1 text-xs font-bold text-muted-foreground">
              {selection.ticker} · {selection.market} · {selection.timeframe}
            </p>
            <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
              <div data-testid="analysis-signal-score" className="rounded-2xl bg-background p-2">
                <p className="text-[10px] text-muted-foreground">AI 점수</p>
                <strong>{selection.signalScore ?? '-'}</strong>
              </div>
              <div className="rounded-2xl bg-background p-2">
                <p className="text-[10px] text-muted-foreground">신뢰도</p>
                <strong>{selection.confidence ?? '-'}</strong>
              </div>
              <div className="rounded-2xl bg-background p-2">
                <p className="text-[10px] text-muted-foreground">위험</p>
                <strong>{selection.riskLevel ?? '-'}</strong>
              </div>
            </div>
            {selection.matchedSignals?.length ? (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {selection.matchedSignals.map((item) => (
                  <span key={item} className="rounded-full bg-primary/10 px-2 py-1 text-[10px] font-bold text-primary">
                    {item}
                  </span>
                ))}
              </div>
            ) : null}
          </section>

          <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
            <div className="flex items-center gap-2">
              <Database className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-black">구조화 분석 상태</h2>
            </div>
            {analysis ? (
              <div className="mt-3 space-y-3 text-xs">
                <div className="flex items-center justify-between">
                  <strong>{analysis.title}</strong>
                  <span className="rounded-full bg-primary/10 px-2 py-1 font-black text-primary">{analysis.status}</span>
                </div>
                <p className="break-keep leading-5 text-muted-foreground">{analysis.summary}</p>
                <div>
                  <p className="font-black">근거</p>
                  <ul className="mt-1 space-y-1 text-muted-foreground">
                    {analysis.reasons.map((item) => <li key={item}>• {item}</li>)}
                  </ul>
                </div>
                <div>
                  <p className="font-black">확인 조건</p>
                  <ul className="mt-1 space-y-1 text-muted-foreground">
                    {analysis.confirmationConditions.map((item) => <li key={item}>• {item}</li>)}
                  </ul>
                </div>
                <div>
                  <p className="font-black text-destructive">무효 조건</p>
                  <ul className="mt-1 space-y-1 text-muted-foreground">
                    {analysis.invalidationConditions.map((item) => <li key={item}>• {item}</li>)}
                  </ul>
                </div>
              </div>
            ) : (
              <p className="mt-3 text-xs leading-5 text-muted-foreground">
                실제 캔들이 준비되면 분석 객체를 표시합니다. 데이터가 없을 때 임시 분석을 만들지 않습니다.
              </p>
            )}
          </section>

          <p className="flex gap-2 rounded-2xl border border-warning/30 bg-warning/5 p-3 text-[10px] font-semibold leading-4 text-muted-foreground">
            <ShieldAlert className="h-4 w-4 shrink-0 text-warning" />
            진행 중 캔들의 분석은 forming 또는 candidate로만 표시합니다. 공급자가 완료 여부를 제공하지 않으면 확정으로 승격하지 않습니다.
          </p>
        </aside>
      </main>
      {!embedded && !externalMode && <BottomNav />}
    </div>
  );
}
