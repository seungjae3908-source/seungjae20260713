import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Database, MonitorUp, ShieldAlert, X } from 'lucide-react';
import { useLocation } from 'wouter';
import { BottomNav } from '@/components/bottom-nav';
import { ChartBroadcastPanel, type ChartBroadcastMarket } from '@/components/chart-broadcast';
import {
  selectionFromSearch,
  useAnalysisSelection,
  type AnalysisSelection,
} from '@/lib/analysis-selection';
import {
  buildChartPath,
  buildExternalChartPath,
  chartExternalWindowChannel,
  chartSelectionKey,
  chartSyncIdFromSearch,
  CHART_EXTERNAL_WINDOW_NAME,
  createChartWindowMessage,
  createChartWindowSourceId,
  externalChartWindowFeatures,
  isDesktopChartViewport,
  isExternalChartSearch,
  mergeChartRouteSelection,
  parseChartWindowMessage,
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

export default function AiChartPage({ embedded = false }: { embedded?: boolean }) {
  const [, navigate] = useLocation();
  const state = useAnalysisSelection();
  const selectSelection = state.select;
  const initialSearchRef = useRef(currentBrowserSearch());
  const externalMode = isExternalChartSearch(initialSearchRef.current);
  const externalSyncId = chartSyncIdFromSearch(initialSearchRef.current);
  const [selection, setSelection] = useState<AnalysisSelection>(() => (
    mergeChartRouteSelection(selectionFromSearch(initialSearchRef.current), state.selection)
    ?? state.selection
    ?? fallbackSelection()
  ));
  const [analysis, setAnalysis] = useState<ChartAnalysis | null>(null);
  const [externalControlAvailable, setExternalControlAvailable] = useState(false);
  const [externalWindowStatus, setExternalWindowStatus] = useState<string | null>(null);
  const sourceIdRef = useRef(createChartWindowSourceId());
  const syncSessionIdRef = useRef(externalSyncId || createChartWindowSourceId());
  const channelRef = useRef<BroadcastChannel | null>(null);
  const popupRef = useRef<Window | null>(null);
  const popupPollRef = useRef<number | null>(null);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  useEffect(() => {
    if (!embedded || !state.selection || selectionRef.current === state.selection) return;
    selectionRef.current = state.selection;
    setSelection(state.selection);
    setAnalysis(null);
  }, [embedded, state.selection]);

  useEffect(() => {
    if (embedded || externalMode || typeof window === 'undefined') {
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
  }, [embedded, externalMode]);

  const publishSelection = useCallback((next: AnalysisSelection) => {
    channelRef.current?.postMessage(createChartWindowMessage('selection', sourceIdRef.current, next));
  }, []);

  const applySelection = useCallback((next: AnalysisSelection, publish: boolean) => {
    if (sameSelection(selectionRef.current, next)) return;
    selectionRef.current = next;
    setSelection(next);
    selectSelection(next);
    setAnalysis(null);
    if (publish) publishSelection(next);

    if (!embedded && typeof window !== 'undefined') {
      const nextLocation = buildChartPath(next, externalMode ? syncSessionIdRef.current : undefined);
      if (`${window.location.pathname}${window.location.search}` !== nextLocation) {
        navigate(nextLocation, { replace: true });
      }
    }
  }, [embedded, externalMode, navigate, publishSelection, selectSelection]);

  useEffect(() => {
    if (embedded || typeof BroadcastChannel === 'undefined') {
      if (externalMode && typeof BroadcastChannel === 'undefined') {
        setExternalWindowStatus('이 브라우저는 외부 차트 동기화를 지원하지 않습니다.');
      }
      return;
    }

    const channel = new BroadcastChannel(chartExternalWindowChannel(syncSessionIdRef.current));
    channelRef.current = channel;
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const message = parseChartWindowMessage(event.data);
      if (!message || message.sourceId === sourceIdRef.current) return;

      if (message.type === 'ready') {
        channel.postMessage(createChartWindowMessage('selection', sourceIdRef.current, selectionRef.current));
        return;
      }
      if (message.type === 'closed') {
        if (!externalMode) {
          popupRef.current = null;
          setExternalWindowStatus('외부 차트 창이 닫혔습니다.');
        }
        return;
      }

      applySelection(message.selection, false);
    };

    const notifyClosed = () => {
      if (externalMode) channel.postMessage(createChartWindowMessage('closed', sourceIdRef.current));
    };
    window.addEventListener('beforeunload', notifyClosed);
    if (externalMode) channel.postMessage(createChartWindowMessage('ready', sourceIdRef.current));

    return () => {
      notifyClosed();
      window.removeEventListener('beforeunload', notifyClosed);
      channel.close();
      if (channelRef.current === channel) channelRef.current = null;
    };
  }, [applySelection, embedded, externalMode]);

  useEffect(() => () => {
    if (popupPollRef.current != null) window.clearInterval(popupPollRef.current);
  }, []);

  const market: ChartBroadcastMarket = selection.market === 'US' ? 'US' : 'KR';
  const updateSelection = useCallback((next: { ticker: string; name: string; market: ChartBroadcastMarket; timeframe: string }) => {
    const current = selectionRef.current;
    const merged: AnalysisSelection = {
      ...current,
      assetType: 'stock',
      market: next.market,
      symbol: next.ticker,
      ticker: next.ticker,
      displayName: next.name,
      timeframe: next.timeframe,
      selectedAt: current.ticker === next.ticker ? current.selectedAt : new Date().toISOString(),
    };
    applySelection(merged, true);
  }, [applySelection]);

  const openExternalWindow = useCallback(() => {
    const currentPopup = popupRef.current;
    if (currentPopup && !currentPopup.closed) {
      currentPopup.focus();
      publishSelection(selectionRef.current);
      setExternalWindowStatus('이미 열린 외부 차트 창으로 이동했습니다.');
      return;
    }

    const popup = window.open(
      buildExternalChartPath(selectionRef.current, syncSessionIdRef.current),
      CHART_EXTERNAL_WINDOW_NAME,
      externalChartWindowFeatures(window.screen),
    );
    if (!popup) {
      setExternalWindowStatus('팝업이 차단되었습니다. 이 사이트의 팝업을 허용한 뒤 다시 시도하세요.');
      return;
    }

    popupRef.current = popup;
    popup.focus();
    setExternalWindowStatus('외부 차트 창을 열었습니다. 종목·시장·시간봉 변경이 양쪽에 동기화됩니다.');
    window.setTimeout(() => publishSelection(selectionRef.current), 250);

    if (popupPollRef.current != null) window.clearInterval(popupPollRef.current);
    popupPollRef.current = window.setInterval(() => {
      if (!popup.closed) return;
      popupRef.current = null;
      if (popupPollRef.current != null) window.clearInterval(popupPollRef.current);
      popupPollRef.current = null;
      setExternalWindowStatus('외부 차트 창이 닫혔습니다.');
    }, 1_000);
  }, [publishSelection]);

  return (
    <div className={`h-full overflow-y-auto overscroll-contain bg-background ${embedded || externalMode ? 'pb-4' : 'pb-24'}`}>
      <header className="sticky top-0 z-20 border-b border-card-border bg-background/95 px-4 py-3 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center gap-3">
          {!embedded && !externalMode && <button type="button" aria-label="AI 검색기로 돌아가기" onClick={() => navigate('/scanner')} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-card-border bg-card"><ArrowLeft className="h-4 w-4" /></button>}
          {externalMode && <button type="button" aria-label="외부 차트 창 닫기" onClick={() => window.close()} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-card-border bg-card"><X className="h-4 w-4" /></button>}
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-extrabold text-primary">기술탭</p>
            <h1 className="truncate text-lg font-black">AI 차트 분석기{externalMode ? ' · 외부 창' : ''}</h1>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {externalControlAvailable && (
              <button
                type="button"
                onClick={openExternalWindow}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-card-border bg-card px-3 text-[11px] font-extrabold"
              >
                <MonitorUp className="h-4 w-4 text-primary" />
                외부 창
              </button>
            )}
            <div className="text-right text-[10px] font-bold text-muted-foreground">
              <p>{market === 'KR' ? '국내주식' : '미국주식'} · {selection.timeframe}</p>
              <p>{externalMode ? '동기화 창' : 'REST 갱신형'}</p>
            </div>
          </div>
        </div>
      </header>

      {externalWindowStatus && (
        <div role="status" className="mx-auto mt-3 max-w-7xl px-4">
          <p className="rounded-2xl border border-primary/20 bg-primary/5 px-3 py-2 text-[11px] font-bold text-muted-foreground">
            {externalWindowStatus}
          </p>
        </div>
      )}

      <main className="mx-auto grid max-w-7xl gap-4 p-4 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
        <section className="min-w-0">
          <ChartBroadcastPanel
            market={market}
            initialSelection={{ ticker: selection.ticker, name: selection.displayName, market, timeframe: selection.timeframe }}
            onAnalysisChange={setAnalysis}
            onSelectionChange={updateSelection}
          />
        </section>

        <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
            <p className="text-[11px] font-extrabold text-primary">AI 검색기에서 전달된 선택</p>
            <h2 className="mt-1 text-lg font-black">{selection.displayName}</h2>
            <p className="mt-1 text-xs font-bold text-muted-foreground">{selection.ticker} · {selection.market} · {selection.timeframe}</p>
            <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
              <div data-testid="analysis-signal-score" className="rounded-2xl bg-background p-2"><p className="text-[10px] text-muted-foreground">AI 점수</p><strong>{selection.signalScore ?? '-'}</strong></div>
              <div className="rounded-2xl bg-background p-2"><p className="text-[10px] text-muted-foreground">신뢰도</p><strong>{selection.confidence ?? '-'}</strong></div>
              <div className="rounded-2xl bg-background p-2"><p className="text-[10px] text-muted-foreground">위험</p><strong>{selection.riskLevel ?? '-'}</strong></div>
            </div>
            {selection.matchedSignals?.length ? <div className="mt-3 flex flex-wrap gap-1.5">{selection.matchedSignals.map((item) => <span key={item} className="rounded-full bg-primary/10 px-2 py-1 text-[10px] font-bold text-primary">{item}</span>)}</div> : null}
          </section>

          <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
            <div className="flex items-center gap-2"><Database className="h-4 w-4 text-primary" /><h2 className="text-sm font-black">구조화 분석 상태</h2></div>
            {analysis ? (
              <div className="mt-3 space-y-3 text-xs">
                <div className="flex items-center justify-between"><strong>{analysis.title}</strong><span className="rounded-full bg-primary/10 px-2 py-1 font-black text-primary">{analysis.status}</span></div>
                <p className="break-keep leading-5 text-muted-foreground">{analysis.summary}</p>
                <div><p className="font-black">근거</p><ul className="mt-1 space-y-1 text-muted-foreground">{analysis.reasons.map((item) => <li key={item}>• {item}</li>)}</ul></div>
                <div><p className="font-black">확인 조건</p><ul className="mt-1 space-y-1 text-muted-foreground">{analysis.confirmationConditions.map((item) => <li key={item}>• {item}</li>)}</ul></div>
                <div><p className="font-black text-destructive">무효 조건</p><ul className="mt-1 space-y-1 text-muted-foreground">{analysis.invalidationConditions.map((item) => <li key={item}>• {item}</li>)}</ul></div>
              </div>
            ) : <p className="mt-3 text-xs leading-5 text-muted-foreground">실제 캔들이 준비되면 분석 객체를 표시합니다. 데이터가 없을 때 임시 분석을 만들지 않습니다.</p>}
          </section>

          <p className="flex gap-2 rounded-2xl border border-warning/30 bg-warning/5 p-3 text-[10px] font-semibold leading-4 text-muted-foreground"><ShieldAlert className="h-4 w-4 shrink-0 text-warning" />진행 중 캔들의 분석은 forming 또는 candidate로만 표시합니다. 공급자가 완료 여부를 제공하지 않으면 확정으로 승격하지 않습니다.</p>
        </aside>
      </main>
      {!embedded && !externalMode && <BottomNav />}
    </div>
  );
}
