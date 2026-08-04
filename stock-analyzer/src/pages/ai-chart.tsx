import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  Clock3,
  Database,
  Minus,
  ShieldAlert,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { useLocation } from 'wouter';
import { BottomNav } from '@/components/bottom-nav';
import { ChartBroadcastPanel, type ChartBroadcastMarket } from '@/components/chart-broadcast';
import {
  selectionFromSearch,
  selectionQuery,
  useAnalysisSelection,
  type AnalysisSelection,
} from '@/lib/analysis-selection';
import type { ChartAnalysis, ChartAnalysisBias, ChartAnalysisStatus } from '@/lib/chart-analysis';
import { cn } from '@/lib/utils';

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

export default function AiChartPage({ embedded = false }: { embedded?: boolean }) {
  const [location, navigate] = useLocation();
  const state = useAnalysisSelection();
  const fromUrl = useMemo(
    () => selectionFromSearch(location.includes('?') ? location.slice(location.indexOf('?')) : ''),
    [location],
  );
  const selection = useMemo<AnalysisSelection>(
    () =>
      fromUrl
        ? { ...(state.selection?.ticker === fromUrl.ticker ? state.selection : {}), ...fromUrl }
        : state.selection ?? fallbackSelection(),
    [fromUrl, state.selection],
  );
  const [analysis, setAnalysis] = useState<ChartAnalysis | null>(null);

  useEffect(() => {
    if (fromUrl) {
      state.select({
        ...state.selection,
        ...fromUrl,
        selectedAt: state.selection?.selectedAt ?? fromUrl.selectedAt,
      } as AnalysisSelection);
    }
    // URL selection is authoritative only when the URL changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromUrl?.ticker, fromUrl?.market, fromUrl?.timeframe]);

  const market: ChartBroadcastMarket = selection.market === 'US' ? 'US' : 'KR';
  const updateSelection = useCallback(
    (next: { ticker: string; name: string; market: ChartBroadcastMarket; timeframe: string }) => {
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
      const changed =
        selection.ticker !== merged.ticker ||
        selection.market !== merged.market ||
        selection.timeframe !== merged.timeframe ||
        selection.displayName !== merged.displayName;
      if (changed) state.select(merged);
      const nextLocation = `/ai-chart?${selectionQuery(merged)}`;
      if (!embedded && location !== nextLocation) navigate(nextLocation, { replace: true });
    },
    [embedded, location, navigate, selection, state],
  );

  useEffect(() => {
    setAnalysis(null);
  }, [selection.market, selection.ticker, selection.timeframe]);

  return (
    <div className={`h-full overflow-y-auto overscroll-contain bg-background ${embedded ? 'pb-4' : 'pb-24'}`}>
      <header className="sticky top-0 z-20 border-b border-card-border bg-background/95 px-4 py-3 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center gap-3">
          {!embedded && (
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
            <p className="text-[11px] font-extrabold text-primary">실시간 기술 분석</p>
            <h1 className="truncate text-lg font-black">AI 차트 생중계</h1>
          </div>
          <div className="text-right text-[10px] font-bold text-muted-foreground">
            <p>{market === 'KR' ? '국내주식' : '미국주식'} · {selection.timeframe}</p>
            <p>실제 캔들 REST 갱신</p>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl gap-4 p-4 lg:grid-cols-[minmax(0,2fr)_minmax(300px,1fr)]">
        <section className="min-w-0">
          <ChartBroadcastPanel
            market={market}
            initialSelection={{
              ticker: selection.ticker,
              name: selection.displayName,
              market,
              timeframe: selection.timeframe,
            }}
            onAnalysisChange={setAnalysis}
            onSelectionChange={updateSelection}
          />
        </section>

        <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-black">현재 차트 컨텍스트</h2>
            </div>
            <h3 className="mt-3 text-lg font-black">{selection.displayName}</h3>
            <p className="mt-1 text-xs font-bold text-muted-foreground">
              {selection.ticker} · {selection.market} · {selection.timeframe}
            </p>
            <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
              <div className="rounded-2xl bg-background p-2">
                <p className="text-[10px] text-muted-foreground">분석 상태</p>
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
            <p className="mt-3 text-[10px] font-semibold leading-4 text-muted-foreground">
              종목이나 시간봉이 변경되면 이전 분석을 비우고 새 컨텍스트의 실제 캔들이 준비된 뒤 다시 판정합니다.
            </p>
          </section>

          <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
            <div className="flex items-center gap-2">
              <Database className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-black">현재 생중계 판단</h2>
            </div>
            {analysis ? (
              <div className="mt-3 space-y-4 text-xs">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <BiasIcon bias={analysis.bias} />
                      <strong className="break-keep text-sm">{analysis.title}</strong>
                    </div>
                    <p className="mt-1 text-[10px] font-bold text-muted-foreground">
                      {analysis.subtype ?? analysis.type} · {analysis.engineVersion}
                    </p>
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

                <p className="break-keep rounded-2xl bg-secondary/70 px-3 py-3 leading-5 text-foreground">
                  {analysis.summary}
                </p>

                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-2xl border border-card-border bg-background p-3">
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <Clock3 className="h-3.5 w-3.5" />
                      <span className="text-[10px] font-bold">감지 시각</span>
                    </div>
                    <strong className="mt-1 block text-[11px]">{formatAnalysisTime(analysis.detectedAt)}</strong>
                  </div>
                  <div className="rounded-2xl border border-card-border bg-background p-3">
                    <p className="text-[10px] font-bold text-muted-foreground">최근 변화</p>
                    <strong className="mt-1 block break-keep text-[11px]">
                      {analysis.transitionReason ?? '최초 분석'}
                    </strong>
                  </div>
                </div>

                <div>
                  <p className="font-black">판단 근거</p>
                  <ul className="mt-1 space-y-1 text-muted-foreground">
                    {analysis.reasons.map((item) => (
                      <li key={item}>• {item}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <p className="font-black">확인 조건</p>
                  <ul className="mt-1 space-y-1 text-muted-foreground">
                    {analysis.confirmationConditions.map((item) => (
                      <li key={item}>• {item}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <p className="font-black text-destructive">무효 조건</p>
                  <ul className="mt-1 space-y-1 text-muted-foreground">
                    {analysis.invalidationConditions.map((item) => (
                      <li key={item}>• {item}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : (
              <p className="mt-3 text-xs leading-5 text-muted-foreground">
                실제 캔들이 준비되면 현재 구조와 변화 이유를 표시합니다. 데이터가 없거나 종목이 바뀐 직후에는 임시 분석을 만들지 않습니다.
              </p>
            )}
          </section>

          <p className="flex gap-2 rounded-2xl border border-warning/30 bg-warning/5 p-3 text-[10px] font-semibold leading-4 text-muted-foreground">
            <ShieldAlert className="h-4 w-4 shrink-0 text-warning" />
            진행 중 캔들은 형성 중으로 표시하고, 패턴 확정은 완료된 봉의 확인 조건을 통과한 경우에만 수행합니다. 이 화면은 분석 보조 기능이며 주문을 실행하지 않습니다.
          </p>
        </aside>
      </main>
      {!embedded && <BottomNav />}
    </div>
  );
}
