import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
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
import {
  AiChartPositionPanel,
  type AiChartPositionOverlay,
} from '@/components/ai-chart-position-panel';
import { ChartPatternOverlayPanel } from '@/components/chart-pattern-overlay-panel';
import type { AnalysisMarket, AnalysisPricePlan } from '@/lib/analysis-selection';
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
  pricePlanLines: IPriceLine[];
  positionPriceLines: IPriceLine[];
};

type LogicalViewport = {
  from: number;
  to: number;
};

type StoredViewport = {
  resetKey: string;
  logicalRange: LogicalViewport;
};

type PlanLineRow = {
  price: number | null | undefined;
  title: string;
  color: string;
  style: LineStyle;
  width: 1 | 2;
  priority: number;
};

export type PatternAwareUnifiedChartCanvasHandle = {
  applyRealtimeCandle: (candle: NormalizedChartCandle) => boolean;
};

type Props = {
  candles: NormalizedChartCandle[];
  indicators: ChartIndicatorResult;
  levels: PriceLevels;
  analysis: ChartAnalysis | null;
  pricePlan?: AnalysisPricePlan;
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

const LEGEND_NUMBER_FORMATTER = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 8 });
const LEGEND_DATE_FORMATTER = new Intl.DateTimeFormat('ko-KR', { month: '2-digit', day: '2-digit' });
const LEGEND_DATETIME_FORMATTER = new Intl.DateTimeFormat('ko-KR', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function formatLegendNumber(value: number): string {
  return LEGEND_NUMBER_FORMATTER.format(value);
}

function formatLegendTime(time: number, timeframe: UnifiedChartTimeframe): string {
  const formatter = timeframe === '1D' ? LEGEND_DATE_FORMATTER : LEGEND_DATETIME_FORMATTER;
  return formatter.format(new Date(time * 1_000));
}

function updateCrosshairLegend(
  element: HTMLDivElement | null,
  candle: Pick<NormalizedChartCandle, 'time' | 'open' | 'high' | 'low' | 'close' | 'volume'> | null,
  timeframe: UnifiedChartTimeframe,
): void {
  if (!element || !candle) return;
  const label = [
    formatLegendTime(candle.time, timeframe),
    `시 ${formatLegendNumber(candle.open)}`,
    `고 ${formatLegendNumber(candle.high)}`,
    `저 ${formatLegendNumber(candle.low)}`,
    `종 ${formatLegendNumber(candle.close)}`,
    `거래량 ${formatLegendNumber(candle.volume)}`,
  ].join(' · ');
  if (element.dataset.candleTime === String(candle.time) && element.textContent === label) return;
  element.dataset.candleTime = String(candle.time);
  element.dataset.direction = candle.close >= candle.open ? 'up' : 'down';
  element.textContent = label;
  element.setAttribute('aria-label', `크로스헤어 ${label}`);
}

function validPlanPrice(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value) && value > 0;
}

function sameVisiblePrice(left: number | null | undefined, right: number | null | undefined): boolean {
  if (!validPlanPrice(left) || !validPlanPrice(right)) return false;
  const scale = Math.max(Math.abs(left), Math.abs(right), 1);
  return Math.abs(left - right) <= Math.max(scale * 0.000001, Number.EPSILON * 32);
}

function mergePlanRows(rows: PlanLineRow[]): PlanLineRow[] {
  const merged: PlanLineRow[] = [];
  for (const candidate of rows.filter((row) => validPlanPrice(row.price)).sort((a, b) => a.priority - b.priority)) {
    const match = merged.find((row) => sameVisiblePrice(row.price, candidate.price));
    if (!match) {
      merged.push({ ...candidate });
      continue;
    }
    const titles = new Set(`${match.title}·${candidate.title}`.split('·').map((title) => title.trim()).filter(Boolean));
    const hasStop = Array.from(titles).some((title) => title.includes('손절'));
    const hasInvalidation = Array.from(titles).some((title) => title.includes('무효화'));
    const hasEntryTop = Array.from(titles).some((title) => title.includes('진입 상단'));
    const hasEntryBottom = Array.from(titles).some((title) => title.includes('진입 하단'));
    match.title = hasStop && hasInvalidation
      ? '손절·무효화'
      : hasEntryTop && hasEntryBottom
        ? 'Scanner 진입'
        : Array.from(titles).join('·');
    if (candidate.priority < match.priority) {
      match.color = candidate.color;
      match.style = candidate.style;
      match.width = candidate.width;
      match.priority = candidate.priority;
    }
  }
  return merged;
}

function planPriorityPrices(pricePlan: AnalysisPricePlan | undefined): number[] {
  if (!pricePlan) return [];
  return [
    pricePlan.stopLoss,
    pricePlan.invalidation,
    pricePlan.entryZone?.from,
    pricePlan.entryZone?.to,
    ...pricePlan.targets,
  ].filter(validPlanPrice);
}

function conflictsWithHigherPriority(price: number, higherPriorityPrices: number[]): boolean {
  return higherPriorityPrices.some((candidate) => sameVisiblePrice(price, candidate));
}

function chartSymbolFromResetKey(
  resetKey: string,
  market: AnalysisMarket,
  timeframe: UnifiedChartTimeframe,
): string {
  const prefix = `${market}:`;
  const suffix = `:${timeframe}`;
  if (!resetKey.startsWith(prefix) || !resetKey.endsWith(suffix)) return '';
  return resetKey.slice(prefix.length, resetKey.length - suffix.length).trim();
}

export const PatternAwareUnifiedChartCanvas = forwardRef<PatternAwareUnifiedChartCanvasHandle, Props>(function PatternAwareUnifiedChartCanvas({
  candles,
  indicators,
  levels,
  analysis,
  pricePlan,
  overlays,
  timeframe,
  resetKey,
  market,
  onCandleSelect,
}: Props, ref) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const crosshairLegendRef = useRef<HTMLDivElement | null>(null);
  const crosshairActiveRef = useRef(false);
  const latestCandleRef = useRef<NormalizedChartCandle | null>(candles.at(-1) ?? null);
  const instanceRef = useRef<ChartInstance | null>(null);
  const storedViewportRef = useRef<StoredViewport | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [positionOverlay, setPositionOverlay] = useState<AiChartPositionOverlay | null>(null);
  const hasChartData = candles.length >= 2;
  const chartSymbol = useMemo(
    () => chartSymbolFromResetKey(resetKey, market, timeframe),
    [market, resetKey, timeframe],
  );
  const latestChartPrice = candles.at(-1)?.close ?? null;

  useImperativeHandle(ref, () => ({
    applyRealtimeCandle: (candle) => {
      const instance = instanceRef.current;
      if (
        !instance
        || !Number.isFinite(candle.time)
        || !Number.isFinite(candle.open)
        || !Number.isFinite(candle.high)
        || !Number.isFinite(candle.low)
        || !Number.isFinite(candle.close)
        || !Number.isFinite(candle.volume)
        || candle.open <= 0
        || candle.high <= 0
        || candle.low <= 0
        || candle.close <= 0
        || candle.volume < 0
        || candle.high < Math.max(candle.open, candle.close)
        || candle.low > Math.min(candle.open, candle.close)
      ) {
        return false;
      }
      instance.candle.update({
        time: candle.time as UTCTimestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      });
      instance.volume.update({
        time: candle.time as UTCTimestamp,
        value: candle.volume,
        color: candle.close >= candle.open ? 'rgba(239,68,68,0.42)' : 'rgba(59,130,246,0.42)',
      });
      latestCandleRef.current = candle;
      if (!crosshairActiveRef.current) {
        updateCrosshairLegend(crosshairLegendRef.current, candle, timeframe);
      }
      return true;
    },
  }), [resetKey, timeframe]);

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
      pricePlanLines: [],
      positionPriceLines: [],
    };

    const handleClick: Parameters<IChartApi['subscribeClick']>[0] = (param) => {
      if (typeof param.time === 'number' && Number.isFinite(param.time)) onCandleSelect(param.time);
    };
    const handleCrosshairMove: Parameters<IChartApi['subscribeCrosshairMove']>[0] = (param) => {
      const candleRow = param.seriesData.get(candle);
      const volumeRow = param.seriesData.get(volume);
      const volumeValue = volumeRow && 'value' in volumeRow
        ? volumeRow.value
        : null;
      if (
        typeof param.time === 'number'
        && candleRow
        && 'open' in candleRow
        && 'high' in candleRow
        && 'low' in candleRow
        && 'close' in candleRow
        && volumeValue != null
        && Number.isFinite(volumeValue)
      ) {
        crosshairActiveRef.current = true;
        updateCrosshairLegend(crosshairLegendRef.current, {
          time: param.time,
          open: candleRow.open,
          high: candleRow.high,
          low: candleRow.low,
          close: candleRow.close,
          volume: volumeValue,
        }, timeframe);
        return;
      }
      crosshairActiveRef.current = false;
      updateCrosshairLegend(crosshairLegendRef.current, latestCandleRef.current, timeframe);
    };
    const publishVisibleRange = () => {
      const range = exposeLogicalViewport(wrapperRef.current, chart);
      if (range) storedViewportRef.current = { resetKey, logicalRange: range };
    };
    chart.subscribeClick(handleClick);
    chart.subscribeCrosshairMove(handleCrosshairMove);
    chart.timeScale().subscribeVisibleLogicalRangeChange(publishVisibleRange);
    instanceRef.current = instance;

    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      chart.applyOptions({ width: Math.max(rect.width, 1), height: Math.max(rect.height, 390) });
      exposeLogicalViewport(wrapperRef.current, chart);
    });
    observer.observe(container);
    publishVisibleRange();

    return () => {
      publishVisibleRange();
      observer.disconnect();
      chart.unsubscribeClick(handleClick);
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
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
    latestCandleRef.current = candles.at(-1) ?? null;
    crosshairActiveRef.current = false;
    updateCrosshairLegend(crosshairLegendRef.current, latestCandleRef.current, timeframe);
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

    const higherPriorityPrices = planPriorityPrices(pricePlan);
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
          axisLabelVisible: !conflictsWithHigherPriority(row.price, higherPriorityPrices),
          title: row.title,
        }));
      }
    }

    removePriceLines(instance.candle, instance.pricePlanLines);
    if (pricePlan) {
      const planRows = mergePlanRows([
        { price: pricePlan.stopLoss, title: 'Scanner 손절', color: '#dc2626', style: LineStyle.Solid, width: 2, priority: 1 },
        { price: pricePlan.invalidation, title: 'Scanner 무효화', color: '#f97316', style: LineStyle.Dotted, width: 1, priority: 1 },
        { price: pricePlan.entryZone?.from, title: 'Scanner 진입 하단', color: '#22c55e', style: LineStyle.Dashed, width: 2, priority: 2 },
        { price: pricePlan.entryZone?.to, title: 'Scanner 진입 상단', color: '#22c55e', style: LineStyle.Dashed, width: 2, priority: 2 },
        ...pricePlan.targets.slice(0, 4).map((price, index) => ({
          price,
          title: `Scanner 목표 ${index + 1}`,
          color: '#8b5cf6',
          style: LineStyle.Dotted,
          width: 1 as const,
          priority: 3,
        })),
      ]);
      for (const row of planRows) {
        if (!validPlanPrice(row.price)) continue;
        instance.pricePlanLines.push(instance.candle.createPriceLine({
          price: row.price,
          color: row.color,
          lineWidth: row.width,
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
          axisLabelVisible: !conflictsWithHigherPriority(patternOverlay.confirmationPrice, higherPriorityPrices),
          title: `패턴 확인선 · ${patternOverlay.status}`,
        }));
        instance.analysisPriceLines.push(instance.candle.createPriceLine({
          price: patternOverlay.invalidationPrice,
          color: '#dc2626',
          lineWidth: 2,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: !conflictsWithHigherPriority(patternOverlay.invalidationPrice, higherPriorityPrices),
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
  }, [analysis, candles, indicators, levels, overlays.levels, overlays.markers, patternOverlay, pricePlan, resetKey, timeframe]);

  useEffect(() => {
    const instance = instanceRef.current;
    if (!instance) return;
    const beforeUpdate = logicalViewport(instance.chart)
      ?? (storedViewportRef.current?.resetKey === resetKey ? storedViewportRef.current.logicalRange : null);
    removePriceLines(instance.candle, instance.positionPriceLines);

    if (positionOverlay) {
      const average = positionOverlay.position.averageEntryPrice;
      if (validPlanPrice(average)) {
        instance.positionPriceLines.push(instance.candle.createPriceLine({
          price: average,
          color: '#14b8a6',
          lineWidth: 2,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: !conflictsWithHigherPriority(average, planPriorityPrices(pricePlan)),
          title: positionOverlay.stale ? '내 평단 · 오래된 값' : '내 평단',
        }));
      }
      const liquidation = positionOverlay.position.liquidationPrice;
      if (market === 'BITGET' && validPlanPrice(liquidation)) {
        instance.positionPriceLines.push(instance.candle.createPriceLine({
          price: liquidation,
          color: '#e11d48',
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: positionOverlay.stale ? '청산가 · 오래된 값' : '청산가',
        }));
      }
    }

    restoreLogicalViewport(instance.chart, beforeUpdate);
    const afterUpdate = exposeLogicalViewport(wrapperRef.current, instance.chart);
    if (afterUpdate) storedViewportRef.current = { resetKey, logicalRange: afterUpdate };
  }, [market, positionOverlay, pricePlan, resetKey]);

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
        data-position-average={positionOverlay?.position.averageEntryPrice ?? ''}
        data-position-liquidation={positionOverlay?.position.liquidationPrice ?? ''}
        className={cn('relative overflow-hidden bg-background', fullscreen && 'h-[100dvh] w-screen')}
      >
        <div data-testid="chart-floating-controls" className="absolute left-2 top-2 z-10 flex gap-1 rounded-xl border border-card-border bg-background/90 p-1 opacity-60 shadow-sm backdrop-blur transition-opacity duration-200 hover:opacity-100 focus-within:opacity-100">
          <ChartControl label="전체 데이터 맞춤" testId="chart-fit-content" onClick={() => instanceRef.current?.chart.timeScale().fitContent()}><Expand className="h-4 w-4" /></ChartControl>
          <ChartControl label="최신 캔들로 이동" testId="chart-latest-candle" onClick={() => instanceRef.current?.chart.timeScale().scrollToRealTime()}><LocateFixed className="h-4 w-4" /></ChartControl>
          <ChartControl label={fullscreen ? '전체화면 해제' : '전체화면'} testId="chart-fullscreen" onClick={() => void toggleFullscreen()}>{fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}</ChartControl>
        </div>
        <div
          ref={crosshairLegendRef}
          data-testid="chart-crosshair-legend"
          data-candle-time=""
          data-direction=""
          role="group"
          aria-label="크로스헤어 OHLCV"
          className="pointer-events-none absolute left-2 right-2 top-[3.75rem] z-[9] rounded-lg border border-card-border bg-background/88 px-2 py-1 text-left text-[10px] font-bold leading-4 text-foreground shadow-sm backdrop-blur-sm sm:left-auto sm:top-2 sm:max-w-[28rem] sm:text-right sm:text-[11px]"
        />
        <div ref={containerRef} data-testid="unified-chart-canvas" className={cn('h-[390px] w-full touch-pan-y', fullscreen && 'h-[100dvh]')} />
      </div>
      {chartSymbol ? (
        <div className="px-3 sm:px-4">
          <AiChartPositionPanel
            market={market}
            symbol={chartSymbol}
            chartPrice={latestChartPrice}
            pricePlan={pricePlan}
            onOverlayChange={setPositionOverlay}
          />
        </div>
      ) : null}
      <div className="px-4 pb-4">
        <ChartPatternOverlayPanel overlay={patternOverlay} market={market} visible={overlays.markers} />
      </div>
    </div>
  );
});

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
      className="flex h-11 w-11 touch-manipulation items-center justify-center rounded-lg hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      {children}
    </button>
  );
}
