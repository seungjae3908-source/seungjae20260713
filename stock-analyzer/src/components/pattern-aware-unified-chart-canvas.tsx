import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { Expand, LocateFixed, Maximize2, Minimize2 } from 'lucide-react';
import { ChartPatternOverlayPanel } from '@/components/chart-pattern-overlay-panel';
import type { AnalysisMarket } from '@/lib/analysis-selection';
import type { ChartAnalysis } from '@/lib/chart-analysis';
import type { NormalizedChartCandle } from '@/lib/chart-candle-normalizer';
import {
  bollingerSeries,
  indicatorSeries,
  type ChartIndicatorResult,
} from '@/lib/chart-indicator-engine';
import { buildChartPatternOverlay } from '@/lib/chart-pattern-overlay';
import { analyzeChartStructure } from '@/lib/chart-structure-engine';
import type { UnifiedChartTimeframe } from '@/lib/unified-chart-data';
import { cn } from '@/lib/utils';

type LineKey =
  | 'sma5'
  | 'sma20'
  | 'sma60'
  | 'sma120'
  | 'ema12'
  | 'ema26'
  | 'vwap'
  | 'bollingerUpper'
  | 'bollingerMiddle'
  | 'bollingerLower';

type PriceLevels = {
  support: number;
  support2: number;
  resistance: number;
  resistance2: number;
  targetReference: number;
  invalidationReference: number;
};

type OverlayState = {
  sma5: boolean;
  sma20: boolean;
  sma60: boolean;
  sma120: boolean;
  ema12: boolean;
  ema26: boolean;
  bollinger: boolean;
  vwap: boolean;
  volume: boolean;
  levels: boolean;
  markers: boolean;
  rsi: boolean;
  macd: boolean;
  atr: boolean;
};

type ChartInstance = {
  chart: IChartApi;
  candle: ISeriesApi<'Candlestick'>;
  volume: ISeriesApi<'Histogram'>;
  lines: Record<LineKey, ISeriesApi<'Line'>>;
  referencePriceLines: IPriceLine[];
  analysisPriceLines: IPriceLine[];
};

type LogicalViewport = {
  from: number;
  to: number;
};

type StoredViewport = {
  resetKey: string;
  logicalRange: LogicalViewport;
};

type Props = {
  candles: NormalizedChartCandle[];
  indicators: ChartIndicatorResult;
  levels: PriceLevels;
  analysis: ChartAnalysis | null;
  overlays: OverlayState;
  timeframe: UnifiedChartTimeframe;
  resetKey: string;
  market: AnalysisMarket;
  onCandleSelect: (time: number) => void;
};

function createLine(
  chart: IChartApi,
  options: Record<string, unknown>,
): ISeriesApi<'Line'> {
  return chart.addLineSeries(options);
}

function setLineData(
  series: ISeriesApi<'Line'>,
  rows: Array<{ time: number; value: number }>,
): void {
  series.setData(rows.map((row) => ({ time: row.time as UTCTimestamp, value: row.value })));
}

function removePriceLines(series: ISeriesApi<'Candlestick'>, lines: IPriceLine[]): void {
  for (const line of lines) series.removePriceLine(line);
  lines.splice(0, lines.length);
}

function statusColor(status: ChartAnalysis['status']): string {
  if (status === 'confirmed') return '#16a34a';
  if (status === 'invalidated') return '#dc2626';
  if (status === 'weakened') return '#f97316';
  return '#f59e0b';
}

function logicalViewport(chart: IChartApi): LogicalViewport | null {
  const range = chart.timeScale().getVisibleLogicalRange();
  if (!range || !Number.isFinite(range.from) || !Number.isFinite(range.to)) return null;
  return { from: Number(range.from), to: Number(range.to) };
}

function restoreLogicalViewport(chart: IChartApi, range: LogicalViewport | null): void {
  if (!range) return;
  chart.timeScale().setVisibleLogicalRange({ from: range.from, to: range.to });
}

function exposeLogicalViewport(wrapper: HTMLDivElement | null, chart: IChartApi): LogicalViewport | null {
  const range = logicalViewport(chart);
  if (wrapper) wrapper.dataset.visibleLogicalRange = range ? `${range.from}:${range.to}` : '';
  return range;
}

export function PatternAwareUnifiedChartCanvas({
  candles,
  indicators,
  levels,
  analysis,
  overlays,
  timeframe,
  resetKey,
  market,
  onCandleSelect,
}: Props) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<ChartInstance | null>(null);
  const storedViewportRef = useRef<StoredViewport | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const hasChartData = candles.length >= 2;

  const activePattern = useMemo(() => {
    return analyzeChartStructure(candles).patterns
      .filter((pattern) => pattern.status !== 'expired')
      .sort((left, right) => right.updatedAtTime - left.updatedAtTime)[0] ?? null;
  }, [candles]);
  const patternOverlay = useMemo(
    () => buildChartPatternOverlay(analysis, activePattern),
    [activePattern, analysis],
  );

  useEffect(() => {
    const onFullscreenChange = () => setFullscreen(document.fullscreenElement === wrapperRef.current);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !hasChartData) return;
    const dark = document.documentElement.classList.contains('dark');
    const chart = createChart(container, {
      width: Math.max(container.clientWidth, 1),
      height: Math.max(container.clientHeight, 390),
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: dark ? '#cbd5e1' : '#475569',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: dark ? 'rgba(148,163,184,0.08)' : 'rgba(100,116,139,0.10)' },
        horzLines: { color: dark ? 'rgba(148,163,184,0.08)' : 'rgba(100,116,139,0.10)' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: {
        visible: true,
        borderVisible: true,
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
      timeScale: {
        visible: true,
        borderVisible: true,
        timeVisible: timeframe !== '1D',
        secondsVisible: false,
        rightOffset: 6,
        barSpacing: timeframe.endsWith('m') ? 8 : 7,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: {
        axisPressedMouseMove: true,
        mouseWheel: true,
        pinch: true,
      },
    });
    const candle = chart.addCandlestickSeries({
      upColor: '#ef4444',
      downColor: '#3b82f6',
      wickUpColor: '#ef4444',
      wickDownColor: '#3b82f6',
      borderUpColor: '#ef4444',
      borderDownColor: '#3b82f6',
      priceLineVisible: true,
      lastValueVisible: true,
    });
    const lines: Record<LineKey, ISeriesApi<'Line'>> = {
      sma5: createLine(chart, { color: '#f59e0b', lineWidth: 1, title: 'SMA5', visible: false }),
      sma20: createLine(chart, { color: '#8b5cf6', lineWidth: 2, title: 'SMA20', visible: false }),
      sma60: createLine(chart, { color: '#10b981', lineWidth: 1, title: 'SMA60', visible: false }),
      sma120: createLine(chart, { color: '#ec4899', lineWidth: 1, title: 'SMA120', visible: false }),
      ema12: createLine(chart, { color: '#f97316', lineWidth: 1, title: 'EMA12', visible: false }),
      ema26: createLine(chart, { color: '#0ea5e9', lineWidth: 1, title: 'EMA26', visible: false }),
      vwap: createLine(chart, { color: '#06b6d4', lineWidth: 2, lineStyle: LineStyle.Dashed, title: 'VWAP', visible: false }),
      bollingerUpper: createLine(chart, { color: 'rgba(14,165,233,0.75)', lineWidth: 1, title: 'BB 상단', visible: false }),
      bollingerMiddle: createLine(chart, { color: 'rgba(14,165,233,0.38)', lineWidth: 1, lineStyle: LineStyle.Dashed, title: 'BB 중심', visible: false }),
      bollingerLower: createLine(chart, { color: 'rgba(14,165,233,0.75)', lineWidth: 1, title: 'BB 하단', visible: false }),
    };
    const volume = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      lastValueVisible: false,
      priceLineVisible: false,
      visible: false,
    });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    const instance: ChartInstance = {
      chart,
      candle,
      volume,
      lines,
      referencePriceLines: [],
      analysisPriceLines: [],
    };

    const handleClick: Parameters<IChartApi['subscribeClick']>[0] = (param) => {
      if (typeof param.time === 'number' && Number.isFinite(param.time)) onCandleSelect(param.time);
    };
    const publishVisibleRange = () => {
      const range = exposeLogicalViewport(wrapperRef.current, chart);
      if (range) storedViewportRef.current = { resetKey, logicalRange: range };
    };
    chart.subscribeClick(handleClick);
    chart.timeScale().subscribeVisibleLogicalRangeChange(publishVisibleRange);
    instanceRef.current = instance;

    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      chart.applyOptions({ width: Math.max(rect.width, 1), height: Math.max(rect.height, 390) });
    });
    observer.observe(container);
    publishVisibleRange();

    return () => {
      publishVisibleRange();
      observer.disconnect();
      chart.unsubscribeClick(handleClick);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(publishVisibleRange);
      instanceRef.current = null;
      chart.remove();
    };
  }, [hasChartData, onCandleSelect, resetKey, timeframe]);

  useEffect(() => {
    const instance = instanceRef.current;
    if (!instance) return;
    const beforeUpdate = logicalViewport(instance.chart)
      ?? (storedViewportRef.current?.resetKey === resetKey ? storedViewportRef.current.logicalRange : null);
    instance.lines.sma5.applyOptions({ visible: overlays.sma5 });
    instance.lines.sma20.applyOptions({ visible: overlays.sma20 });
    instance.lines.sma60.applyOptions({ visible: overlays.sma60 });
    instance.lines.sma120.applyOptions({ visible: overlays.sma120 });
    instance.lines.ema12.applyOptions({ visible: overlays.ema12 });
    instance.lines.ema26.applyOptions({ visible: overlays.ema26 });
    instance.lines.vwap.applyOptions({ visible: overlays.vwap });
    instance.lines.bollingerUpper.applyOptions({ visible: overlays.bollinger });
    instance.lines.bollingerMiddle.applyOptions({ visible: overlays.bollinger });
    instance.lines.bollingerLower.applyOptions({ visible: overlays.bollinger });
    instance.volume.applyOptions({ visible: overlays.volume });
    instance.chart.applyOptions({
      rightPriceScale: {
        scaleMargins: { top: 0.08, bottom: overlays.volume ? 0.24 : 0.08 },
      },
    });
    restoreLogicalViewport(instance.chart, beforeUpdate);
    const afterUpdate = exposeLogicalViewport(wrapperRef.current, instance.chart);
    if (afterUpdate) storedViewportRef.current = { resetKey, logicalRange: afterUpdate };
  }, [overlays, resetKey]);

  useEffect(() => {
    const instance = instanceRef.current;
    if (!instance) return;
    const beforeUpdate = logicalViewport(instance.chart)
      ?? (storedViewportRef.current?.resetKey === resetKey ? storedViewportRef.current.logicalRange : null);

    instance.candle.setData(candles.map((row) => ({
      time: row.time as UTCTimestamp,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
    })));
    setLineData(instance.lines.sma5, indicatorSeries(indicators, 'sma5'));
    setLineData(instance.lines.sma20, indicatorSeries(indicators, 'sma20'));
    setLineData(instance.lines.sma60, indicatorSeries(indicators, 'sma60'));
    setLineData(instance.lines.sma120, indicatorSeries(indicators, 'sma120'));
    setLineData(instance.lines.ema12, indicatorSeries(indicators, 'ema12'));
    setLineData(instance.lines.ema26, indicatorSeries(indicators, 'ema26'));
    setLineData(instance.lines.vwap, indicatorSeries(indicators, 'vwap'));
    const band = bollingerSeries(indicators);
    setLineData(instance.lines.bollingerUpper, band.upper);
    setLineData(instance.lines.bollingerMiddle, band.middle);
    setLineData(instance.lines.bollingerLower, band.lower);
    instance.volume.setData(candles.map((row) => ({
      time: row.time as UTCTimestamp,
      value: row.volume,
      color: row.close >= row.open ? 'rgba(239,68,68,0.42)' : 'rgba(59,130,246,0.42)',
    })));

    removePriceLines(instance.candle, instance.referencePriceLines);
    if (overlays.levels) {
      const referenceRows = [
        { price: levels.resistance2, color: '#f97316', title: '2차 저항', style: LineStyle.Dotted },
        { price: levels.resistance, color: '#ef4444', title: '1차 저항', style: LineStyle.Dashed },
        { price: levels.support, color: '#3b82f6', title: '1차 지지', style: LineStyle.Dashed },
        { price: levels.support2, color: '#06b6d4', title: '2차 지지', style: LineStyle.Dotted },
        { price: levels.targetReference, color: '#a855f7', title: '목표 참고', style: LineStyle.Dotted },
        { price: levels.invalidationReference, color: '#64748b', title: '무효 기준', style: LineStyle.Dotted },
      ];
      for (const row of referenceRows) {
        if (!Number.isFinite(row.price) || row.price <= 0) continue;
        instance.referencePriceLines.push(instance.candle.createPriceLine({
          price: row.price,
          color: row.color,
          lineWidth: 1,
          lineStyle: row.style,
          axisLabelVisible: true,
          title: row.title,
        }));
      }
    }

    removePriceLines(instance.candle, instance.analysisPriceLines);
    const markers: Array<Record<string, unknown> & { time: UTCTimestamp }> = [];
    if (analysis && overlays.markers) {
      if (patternOverlay) {
        for (const anchor of patternOverlay.anchors) {
          markers.push({
            time: anchor.time as UTCTimestamp,
            position: anchor.role === 'high' ? 'aboveBar' : 'belowBar',
            color: patternOverlay.bias === 'bearish' ? '#3b82f6' : '#ef4444',
            shape: 'circle',
            text: `${anchor.role === 'high' ? '고점' : '저점'} ${anchor.order}`,
          });
        }
        instance.analysisPriceLines.push(instance.candle.createPriceLine({
          price: patternOverlay.confirmationPrice,
          color: statusColor(patternOverlay.status),
          lineWidth: 2,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `패턴 확인선 · ${patternOverlay.status}`,
        }));
        instance.analysisPriceLines.push(instance.candle.createPriceLine({
          price: patternOverlay.invalidationPrice,
          color: '#dc2626',
          lineWidth: 2,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: '패턴 무효화선',
        }));
      }

      const latest = candles.at(-1);
      if (latest) {
        markers.push({
          time: latest.time as UTCTimestamp,
          position: analysis.bias === 'bearish' ? 'aboveBar' : 'belowBar',
          color: statusColor(analysis.status),
          shape: analysis.bias === 'bearish' ? 'arrowDown' : 'arrowUp',
          text: `${analysis.status} · ${analysis.bias}`,
        });
      }
    }
    markers.sort((left, right) => Number(left.time) - Number(right.time));
    instance.candle.setMarkers(markers as never[]);

    restoreLogicalViewport(instance.chart, beforeUpdate);
    const afterUpdate = exposeLogicalViewport(wrapperRef.current, instance.chart);
    if (afterUpdate) storedViewportRef.current = { resetKey, logicalRange: afterUpdate };
  }, [analysis, candles, indicators, levels, overlays.levels, overlays.markers, patternOverlay, resetKey]);

  useEffect(() => {
    storedViewportRef.current = null;
    instanceRef.current?.chart.timeScale().fitContent();
  }, [resetKey]);

  const toggleFullscreen = useCallback(async () => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    try {
      if (document.fullscreenElement === wrapper) await document.exitFullscreen();
      else await wrapper.requestFullscreen();
    } catch {
      // Fullscreen may be blocked by the browser; the chart remains usable.
    }
  }, []);

  return (
    <div className="space-y-3" data-testid="pattern-aware-chart-region">
      <div
        ref={wrapperRef}
        data-testid="unified-chart-wrapper"
        data-pattern-overlay-id={overlays.markers ? patternOverlay?.analysisId ?? '' : ''}
        className={cn('relative overflow-hidden bg-background', fullscreen && 'h-[100dvh] w-screen')}
      >
        <div className="absolute right-2 top-2 z-10 flex gap-1 rounded-xl border border-card-border bg-background/90 p-1 shadow-sm backdrop-blur">
          <ChartControl label="전체 데이터 맞춤" testId="chart-fit-content" onClick={() => instanceRef.current?.chart.timeScale().fitContent()}><Expand className="h-4 w-4" /></ChartControl>
          <ChartControl label="최신 캔들로 이동" testId="chart-latest-candle" onClick={() => instanceRef.current?.chart.timeScale().scrollToRealTime()}><LocateFixed className="h-4 w-4" /></ChartControl>
          <ChartControl label={fullscreen ? '전체화면 해제' : '전체화면'} testId="chart-fullscreen" onClick={() => void toggleFullscreen()}>{fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}</ChartControl>
        </div>
        <div ref={containerRef} data-testid="unified-chart-canvas" className={cn('h-[390px] w-full touch-pan-y', fullscreen && 'h-[100dvh]')} />
      </div>
      <div className="px-4 pb-4">
        <ChartPatternOverlayPanel overlay={patternOverlay} market={market} visible={overlays.markers} />
      </div>
    </div>
  );
}

function ChartControl({ label, testId, onClick, children }: {
  label: string;
  testId: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-secondary"
    >
      {children}
    </button>
  );
}
