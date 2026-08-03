import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Database, ShieldAlert } from 'lucide-react';
import { useLocation } from 'wouter';
import { BottomNav } from '@/components/bottom-nav';
import { ChartBroadcastPanel, type ChartBroadcastMarket } from '@/components/chart-broadcast';
import {
  selectionFromSearch,
  selectionQuery,
  useAnalysisSelection,
  type AnalysisSelection,
} from '@/lib/analysis-selection';
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

export default function AiChartPage({ embedded = false }: { embedded?: boolean }) {
  const [location, navigate] = useLocation();
  const state = useAnalysisSelection();
  const fromUrl = useMemo(() => selectionFromSearch(location.includes('?') ? location.slice(location.indexOf('?')) : ''), [location]);
  const selection = useMemo<AnalysisSelection>(() => fromUrl
    ? { ...(state.selection?.ticker === fromUrl.ticker ? state.selection : {}), ...fromUrl }
    : state.selection ?? fallbackSelection(), [fromUrl, state.selection]);
  const [analysis, setAnalysis] = useState<ChartAnalysis | null>(null);

  useEffect(() => {
    if (fromUrl) state.select({ ...state.selection, ...fromUrl, selectedAt: state.selection?.selectedAt ?? fromUrl.selectedAt } as AnalysisSelection);
    // URL selection is authoritative only when the URL changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromUrl?.ticker, fromUrl?.market, fromUrl?.timeframe]);

  const market: ChartBroadcastMarket = selection.market === 'US' ? 'US' : 'KR';
  const updateSelection = useCallback((next: { ticker: string; name: string; market: ChartBroadcastMarket; timeframe: string }) => {
    const merged: AnalysisSelection = {
      ...selection,
      assetType: 'stock',
      market: next.market,
      symbol: next.ticker,
      ticker: next.ticker,
      displayName: next.name,
      timeframe: next.timeframe,
      selectedAt: selection.ticker === next.ticker ? selection.selectedAt : new Date().toISOString(),
    };
    const changed = selection.ticker !== merged.ticker || selection.market !== merged.market || selection.timeframe !== merged.timeframe || selection.displayName !== merged.displayName;
    if (changed) state.select(merged);
    const nextLocation = `/ai-chart?${selectionQuery(merged)}`;
    if (!embedded && location !== nextLocation) navigate(nextLocation, { replace: true });
  }, [embedded, location, navigate, selection, state]);

  return (
    <div className={`h-full overflow-y-auto overscroll-contain bg-background ${embedded ? 'pb-4' : 'pb-24'}`}>
      <header className="sticky top-0 z-20 border-b border-card-border bg-background/95 px-4 py-3 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center gap-3">
          {!embedded && <button type="button" aria-label="AI 검색기로 돌아가기" onClick={() => navigate('/scanner')} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-card-border bg-card"><ArrowLeft className="h-4 w-4" /></button>}
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-extrabold text-primary">기술탭</p>
            <h1 className="truncate text-lg font-black">AI 차트 분석기</h1>
          </div>
          <div className="text-right text-[10px] font-bold text-muted-foreground">
            <p>{market === 'KR' ? '국내주식' : '미국주식'} · {selection.timeframe}</p>
            <p>REST 갱신형</p>
          </div>
        </div>
      </header>

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
              <div className="rounded-2xl bg-background p-2"><p className="text-[10px] text-muted-foreground">AI 점수</p><strong>{selection.signalScore ?? '-'}</strong></div>
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
      {!embedded && <BottomNav />}
    </div>
  );
}
