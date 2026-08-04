import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  BarChart3,
  ChevronDown,
  ChevronUp,
  Expand,
  Loader2,
  LocateFixed,
  Maximize2,
  Minimize2,
  RefreshCw,
  Search,
  Settings2,
  TrendingDown,
  TrendingUp,
  X,
} from 'lucide-react';
import {
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { SelectedCandleDetailPanel } from '@/components/selected-candle-detail';
import { api } from '@/lib/api';
import { authorizedFetch } from '@/lib/auth-fetch';
import {
  buildChartAnalysis,
  shouldAppendTimeline,
  type ChartAnalysis,
} from '@/lib/chart-analysis';
import type { NormalizedChartCandle } from '@/lib/chart-candle-normalizer';
import {
  bollingerSeries,
  computeChartIndicators,
  indicatorSeries,
  type ChartIndicatorResult,
} from '@/lib/chart-indicator-engine';
import { analyzeChartStructure } from '@/lib/chart-structure-engine';
import {
  UNIFIED_CHART_TIMEFRAMES,
  UnifiedChartDataError,
  defaultUnifiedSymbol,
  fetchUnifiedChartData,
  marketAssetType,
  normalizeUnifiedSymbol,
  unifiedChartDataStatus,
  unifiedMarketLabel,
  type UnifiedChartData,
  type UnifiedChartTimeframe,
} from '@/lib/unified-chart-data';
import type { AnalysisMarket, AnalysisSelection } from '@/lib/analysis-selection';
import { cn } from '@/lib/utils';

type OverlayKey =
  | 'sma5'
  | 'sma20'
  | 'sma60'
  | 'sma120'
  | 'ema12'
  | 'ema26'
  | 'bollinger'
  | 'vwap'
  | 'volume'
  | 'levels'
  | 'markers'
  | 'rsi'
  | 'macd'
  | 'atr';

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

type SearchCandidate = {
  symbol: string;
  name: string;
  market: AnalysisMarket;
  price: number | null;
  changePercent: number | null;
};

type PriceLevels = {
  support: number;
  support2: number;
  resistance: number;
  resistance2: number;
  targetReference: number;
  invalidationReference: number;
};

type TimelineItem = {
  key: string;
  analysis: ChartAnalysis;
};

type ChartInstance = {
  chart: IChartApi;
  candle: ISeriesApi<'Candlestick'>;
  volume?: ISeriesApi<'Histogram'>;
  lines: Partial<Record<LineKey, ISeriesApi<'Line'>>>;
};

type Props = {
  selection: AnalysisSelection;
  onSelectionChange: (selection: AnalysisSelection) => void;
  onAnalysisChange?: (analysis: ChartAnalysis | null) => void;
};

const EMPTY_CANDLES: NormalizedChartCandle[] = [];
const MARKET_OPTIONS: Array<{ key: AnalysisMarket; label: string }> = [
  { key: 'KR', label: '국내주식' },
  { key: 'US', label: '미국주식' },
  { key: 'UPBIT', label: '코인 현물' },
  { key: 'BITGET', label: '코인 선물' },
];
const OVERLAY_OPTIONS: Array<{ key: OverlayKey; label: string }> = [
  { key: 'sma5', label: 'SMA5' },
  { key: 'sma20', label: 'SMA20' },
  { key: 'sma60', label: 'SMA60' },
  { key: 'sma120', label: 'SMA120' },
  { key: 'ema12', label: 'EMA12' },
  { key: 'ema26', label: 'EMA26' },
  { key: 'bollinger', label: '볼린저밴드' },
  { key: 'vwap', label: 'VWAP' },
  { key: 'volume', label: '거래량' },
  { key: 'levels', label: '지지·저항' },
  { key: 'markers', label: '분석 마커' },
  { key: 'rsi', label: 'RSI' },
  { key: 'macd', label: 'MACD' },
  { key: 'atr', label: 'ATR' },
];
const DEFAULT_OVERLAYS: Record<OverlayKey, boolean> = {
  sma5: true,
  sma20: true,
  sma60: false,
  sma120: false,
  ema12: false,
  ema26: false,
  bollinger: false,
  vwap: false,
  volume: true,
  levels: true,
  markers: true,
  rsi: true,
  macd: true,
  atr: true,
};
const OVERLAY_STORAGE_KEY = 'unified-analysis-chart-overlays.v1';

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function loadOverlays(): Record<OverlayKey, boolean> {
  if (typeof window === 'undefined') return DEFAULT_OVERLAYS;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(OVERLAY_STORAGE_KEY) ?? '{}') as Partial<Record<OverlayKey, boolean>>;
    return { ...DEFAULT_OVERLAYS, ...parsed };
  } catch {
    return DEFAULT_OVERLAYS;
  }
}

function persistOverlays(overlays: Record<OverlayKey, boolean>): Record<OverlayKey, boolean> {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(OVERLAY_STORAGE_KEY, JSON.stringify(overlays));
  }
  return overlays;
}

function formatPrice(value: number | null | undefined, market: AnalysisMarket): string {
  if (value == null || !Number.isFinite(value)) return '-';
  if (market === 'US') {
    return `$${value.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  if (market === 'BITGET') {
    return `${value.toLocaleString('ko-KR', { maximumFractionDigits: value >= 1000 ? 2 : 8 })} USDT`;
  }
  return `${value.toLocaleString('ko-KR', { maximumFractionDigits: value >= 1000 ? 0 : 8 })}원`;
}

function formatPercent(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '-';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function dataStatusLabel(status: ReturnType<typeof unifiedChartDataStatus>): string {
  return {
    ok: '정상',
    delayed: '지연',
    stale: '오래된 데이터',
    insufficient: '데이터 부족',
    unavailable: '연결 오류',
  }[status];
}

function dataStatusClass(status: ReturnType<typeof unifiedChartDataStatus>): string {
  if (status === 'ok') return 'border-positive/30 bg-positive/10 text-positive';
  if (status === 'delayed' || status === 'stale') return 'border-warning/30 bg-warning/10 text-warning';
  return 'border-destructive/30 bg-destructive/10 text-destructive';
}

async function searchCandidates(
  market: AnalysisMarket,
  query: string,
  signal?: AbortSignal,
): Promise<SearchCandidate[]> {
  const needle = query.trim().toUpperCase();
  if (!needle) return [];

  if (market === 'KR' || market === 'US') {
    const payload = await api.searchRows(query);
    return payload.results
      .filter((row) => row.market === market)
      .map((row) => ({
        symbol: row.ticker,
        name: row.name,
        market,
        price: finite(row.price),
        changePercent: finite(row.changePercent),
      }))
      .slice(0, 20);
  }

  const url = market === 'UPBIT'
    ? '/api/crypto/spot/markets'
    : '/api/crypto/futures/tickers';
  const response = await authorizedFetch(url, { cache: 'no-store', signal });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(payload.message ?? payload.error ?? `HTTP ${response.status}`));

  if (market === 'UPBIT') {
    const rows = Array.isArray(payload.markets) ? payload.markets as Record<string, unknown>[] : [];
    return rows
      .map((row) => ({
        symbol: normalizeUnifiedSymbol('UPBIT', row.symbol ?? row.market),
        name: String(row.koreanName ?? row.englishName ?? row.symbol ?? ''),
        market,
        price: null,
        changePercent: null,
      }))
      .filter((row) => row.symbol && `${row.symbol} ${row.name}`.toUpperCase().includes(needle))
      .slice(0, 30);
  }

  const rows = Array.isArray(payload.tickers) ? payload.tickers as Record<string, unknown>[] : [];
  return rows
    .map((row) => ({
      symbol: normalizeUnifiedSymbol('BITGET', row.symbol),
      name: String(row.symbol ?? ''),
      market,
      price: finite(row.markPrice ?? row.price),
      changePercent: finite(row.changePercent24h ?? row.changePercent),
    }))
    .filter((row) => row.symbol.includes(needle))
    .slice(0, 30);
}

function computeLevels(candles: NormalizedChartCandle[], indicators: ChartIndicatorResult): PriceLevels | null {
  const latest = candles.at(-1);
  if (!latest) return null;
  const history = candles.filter((row) => row.isClosed).slice(-100, -1);
  const fallback = Math.max(indicators.latest?.atr14 ?? 0, latest.close * 0.008);
  const lows = history.map((row) => row.low).filter((price) => price < latest.close).sort((a, b) => b - a);
  const highs = history.map((row) => row.high).filter((price) => price > latest.close).sort((a, b) => a - b);
  const support = lows[0] ?? latest.close - fallback;
  const support2 = lows.find((price) => price < support * 0.995) ?? support - fallback;
  const resistance = highs[0] ?? latest.close + fallback;
  const resistance2 = highs.find((price) => price > resistance * 1.005) ?? resistance + fallback;
  const risk = Math.max(latest.close - support, fallback);
  return {
    support,
    support2,
    resistance,
    resistance2,
    targetReference: Math.max(resistance2, latest.close + risk * 1.8),
    invalidationReference: Math.max(Number.EPSILON, Math.min(support, latest.close - risk)),
  };
}

function buildCurrentAnalysis(input: {
  selection: AnalysisSelection;
  data: UnifiedChartData;
  indicators: ChartIndicatorResult;
  levels: PriceLevels;
  previous: ChartAnalysis | null;
}): ChartAnalysis | null {
  const candles = input.data.normalization.candles;
  const latest = candles.at(-1);
  const previousCandle = candles.at(-2);
  if (!latest || !previousCandle) return null;
  const current = input.indicators.latest;
  const structure = analyzeChartStructure(candles);
  const pattern = structure.patterns
    .filter((item) => item.status !== 'expired')
    .sort((left, right) => right.updatedAtTime - left.updatedAtTime)[0];
  const trend = structure.marketStructure.trend === 'bullish'
    ? '상승'
    : structure.marketStructure.trend === 'bearish'
      ? '하락'
      : current?.sma5 != null && current.sma20 != null
        ? current.sma5 > current.sma20 ? '상승' : current.sma5 < current.sma20 ? '하락' : '중립'
        : '중립';
  const volumeRatio = current?.volumeRatio20 ?? 1;
  const bullishMomentum = trend === '상승' && (current?.macdHistogram == null || current.macdHistogram >= 0);
  const bearishMomentum = trend === '하락' && (current?.macdHistogram == null || current.macdHistogram <= 0);
  const signal = pattern?.status === 'candidate'
    ? 'WATCH'
    : pattern?.bias === 'bullish'
      ? 'HOLD'
      : pattern?.bias === 'bearish'
        ? 'EXIT'
        : bullishMomentum
          ? 'HOLD'
          : bearishMomentum
            ? 'EXIT'
            : 'WATCH';
  const confidence = Math.max(20, Math.min(92, Math.round(
    45 +
    (trend === '중립' ? 0 : 12) +
    (pattern ? 15 : 0) +
    Math.min(12, Math.max(0, (volumeRatio - 1) * 12)) +
    (latest.isClosed ? 8 : -8),
  )));
  const patternText = pattern
    ? `${pattern.label} ${pattern.status === 'confirmed' ? '확정' : pattern.status === 'invalidated' ? '무효화' : '후보'}`
    : null;
  const title = patternText ?? (trend === '상승' ? '상승 구조 관찰' : trend === '하락' ? '하락 구조 관찰' : '방향 확인 중');
  const summary = pattern
    ? pattern.status === 'confirmed'
      ? `${pattern.label}이 완료된 봉 기준으로 확인됐습니다. 넥라인과 무효화 기준을 함께 확인하세요.`
      : pattern.status === 'invalidated'
        ? `${pattern.label} 후보가 기준 가격을 벗어나 무효화됐습니다.`
        : `${pattern.label} 후보가 감지됐지만 넥라인 확인 전이므로 확정으로 판단하지 않습니다.`
    : `${input.selection.timeframe} 기준 ${trend} 구조입니다. 현재가 ${latest.close}, 지지 ${input.levels.support}, 저항 ${input.levels.resistance}를 기준으로 다음 완료봉을 확인합니다.`;
  const anchors = pattern?.anchorPivots ?? [];

  return buildChartAnalysis({
    symbol: input.selection.ticker,
    market: input.selection.market,
    timeframe: input.selection.timeframe,
    latestTime: latest.time,
    currentPrice: latest.close,
    previousClose: previousCandle.close,
    trend,
    rsi: current?.rsi14 ?? null,
    macd: current?.macd ?? null,
    volumeRatio,
    support: pattern?.type === 'double-top' ? pattern.neckline : input.levels.support,
    resistance: pattern?.type === 'double-bottom' ? pattern.neckline : input.levels.resistance,
    signal,
    confidence,
    title,
    summary,
    patterns: patternText ? [patternText] : [],
    source: input.data.provider,
    isClosedCandle: latest.isClosed,
    anchorTimes: anchors.map((pivot) => pivot.time),
    anchorPoints: anchors.map((pivot) => ({ time: pivot.time, price: pivot.price, role: pivot.kind })),
    previousAnalysis: input.previous,
    dataStatus: unifiedChartDataStatus(input.data, false),
    engineVersion: 'unified-chart-v1',
  });
}

function addLine(
  chart: IChartApi,
  rows: Array<{ time: number; value: number }>,
  options: Record<string, unknown>,
): ISeriesApi<'Line'> | undefined {
  if (!rows.length) return undefined;
  const series = chart.addLineSeries(options);
  series.setData(rows.map((row) => ({ time: row.time as UTCTimestamp, value: row.value })));
  return series;
}

function setLineData(
  series: ISeriesApi<'Line'> | undefined,
  rows: Array<{ time: number; value: number }>,
): void {
  series?.setData(rows.map((row) => ({ time: row.time as UTCTimestamp, value: row.value })));
}

function UnifiedChartCanvas({
  candles,
  indicators,
  levels,
  analysis,
  overlays,
  timeframe,
  resetKey,
  onCandleSelect,
}: {
  candles: NormalizedChartCandle[];
  indicators: ChartIndicatorResult;
  levels: PriceLevels;
  analysis: ChartAnalysis | null;
  overlays: Record<OverlayKey, boolean>;
  timeframe: UnifiedChartTimeframe;
  resetKey: string;
  onCandleSelect: (time: number) => void;
}) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<ChartInstance | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const onFullscreenChange = () => setFullscreen(document.fullscreenElement === wrapperRef.current);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || candles.length < 2) return;
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
        scaleMargins: { top: 0.08, bottom: overlays.volume ? 0.24 : 0.08 },
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
    const instance: ChartInstance = { chart, candle, lines: {} };
    if (overlays.sma5) instance.lines.sma5 = addLine(chart, indicatorSeries(indicators, 'sma5'), { color: '#f59e0b', lineWidth: 1, title: 'SMA5' });
    if (overlays.sma20) instance.lines.sma20 = addLine(chart, indicatorSeries(indicators, 'sma20'), { color: '#8b5cf6', lineWidth: 2, title: 'SMA20' });
    if (overlays.sma60) instance.lines.sma60 = addLine(chart, indicatorSeries(indicators, 'sma60'), { color: '#10b981', lineWidth: 1, title: 'SMA60' });
    if (overlays.sma120) instance.lines.sma120 = addLine(chart, indicatorSeries(indicators, 'sma120'), { color: '#ec4899', lineWidth: 1, title: 'SMA120' });
    if (overlays.ema12) instance.lines.ema12 = addLine(chart, indicatorSeries(indicators, 'ema12'), { color: '#f97316', lineWidth: 1, title: 'EMA12' });
    if (overlays.ema26) instance.lines.ema26 = addLine(chart, indicatorSeries(indicators, 'ema26'), { color: '#0ea5e9', lineWidth: 1, title: 'EMA26' });
    if (overlays.vwap) instance.lines.vwap = addLine(chart, indicatorSeries(indicators, 'vwap'), { color: '#06b6d4', lineWidth: 2, lineStyle: LineStyle.Dashed, title: 'VWAP' });
    if (overlays.bollinger) {
      const band = bollingerSeries(indicators);
      instance.lines.bollingerUpper = addLine(chart, band.upper, { color: 'rgba(14,165,233,0.75)', lineWidth: 1, title: 'BB 상단' });
      instance.lines.bollingerMiddle = addLine(chart, band.middle, { color: 'rgba(14,165,233,0.38)', lineWidth: 1, lineStyle: LineStyle.Dashed, title: 'BB 중심' });
      instance.lines.bollingerLower = addLine(chart, band.lower, { color: 'rgba(14,165,233,0.75)', lineWidth: 1, title: 'BB 하단' });
    }
    if (overlays.volume) {
      const volume = chart.addHistogramSeries({
        priceFormat: { type: 'volume' },
        priceScaleId: 'volume',
        lastValueVisible: false,
        priceLineVisible: false,
      });
      volume.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
      instance.volume = volume;
    }
    if (overlays.levels) {
      const levelRows = [
        { price: levels.resistance2, color: '#f97316', title: '2차 저항', style: LineStyle.Dotted },
        { price: levels.resistance, color: '#ef4444', title: '1차 저항', style: LineStyle.Dashed },
        { price: levels.support, color: '#3b82f6', title: '1차 지지', style: LineStyle.Dashed },
        { price: levels.support2, color: '#06b6d4', title: '2차 지지', style: LineStyle.Dotted },
        { price: levels.targetReference, color: '#a855f7', title: '목표 참고', style: LineStyle.Dotted },
        { price: levels.invalidationReference, color: '#64748b', title: '무효 기준', style: LineStyle.Dotted },
      ];
      for (const row of levelRows) {
        if (!Number.isFinite(row.price) || row.price <= 0) continue;
        candle.createPriceLine({
          price: row.price,
          color: row.color,
          lineWidth: 1,
          lineStyle: row.style,
          axisLabelVisible: true,
          title: row.title,
        });
      }
    }
    const handleClick: Parameters<IChartApi['subscribeClick']>[0] = (param) => {
      if (typeof param.time === 'number' && Number.isFinite(param.time)) {
        onCandleSelect(param.time);
      }
    };
    chart.subscribeClick(handleClick);
    instanceRef.current = instance;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      chart.applyOptions({ width: Math.max(rect.width, 1), height: Math.max(rect.height, 390) });
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      chart.unsubscribeClick(handleClick);
      instanceRef.current = null;
      chart.remove();
    };
  }, [onCandleSelect, overlays, timeframe]);

  useEffect(() => {
    const instance = instanceRef.current;
    if (!instance) return;
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
    instance.volume?.setData(candles.map((row) => ({
      time: row.time as UTCTimestamp,
      value: row.volume,
      color: row.close >= row.open ? 'rgba(239,68,68,0.42)' : 'rgba(59,130,246,0.42)',
    })));
    const markers = analysis && overlays.markers
      ? [{
          time: candles.at(-1)!.time as UTCTimestamp,
          position: analysis.bias === 'bearish' ? 'aboveBar' : 'belowBar',
          color: analysis.bias === 'bearish' ? '#3b82f6' : analysis.bias === 'bullish' ? '#ef4444' : '#64748b',
          shape: analysis.bias === 'bearish' ? 'arrowDown' : 'arrowUp',
          text: `${analysis.status} · ${analysis.bias}`,
        }]
      : [];
    instance.candle.setMarkers(markers as never[]);
  }, [analysis, candles, indicators, overlays.markers]);

  useEffect(() => {
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
    <div
      ref={wrapperRef}
      data-testid="unified-chart-wrapper"
      className={cn('relative overflow-hidden bg-background', fullscreen && 'h-[100dvh] w-screen')}
    >
      <div className="absolute right-2 top-2 z-10 flex gap-1 rounded-xl border border-card-border bg-background/90 p-1 shadow-sm backdrop-blur">
        <ChartControl label="전체 데이터 맞춤" testId="chart-fit-content" onClick={() => instanceRef.current?.chart.timeScale().fitContent()}><Expand className="h-4 w-4" /></ChartControl>
        <ChartControl label="최신 캔들로 이동" testId="chart-latest-candle" onClick={() => instanceRef.current?.chart.timeScale().scrollToRealTime()}><LocateFixed className="h-4 w-4" /></ChartControl>
        <ChartControl label={fullscreen ? '전체화면 해제' : '전체화면'} testId="chart-fullscreen" onClick={() => void toggleFullscreen()}>{fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}</ChartControl>
      </div>
      <div ref={containerRef} data-testid="unified-chart-canvas" className={cn('h-[390px] w-full touch-pan-y', fullscreen && 'h-[100dvh]')} />
    </div>
  );
}

export function UnifiedAnalysisChart({ selection, onSelectionChange, onAnalysisChange }: Props) {
  const market = selection.market;
  const timeframe = (UNIFIED_CHART_TIMEFRAMES.some((item) => item.key === selection.timeframe) ? selection.timeframe : '5m') as UnifiedChartTimeframe;
  const [draft, setDraft] = useState(selection.ticker);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [live, setLive] = useState(true);
  const [overlays, setOverlays] = useState<Record<OverlayKey, boolean>>(loadOverlays);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [inputError, setInputError] = useState('');
  const [selectedCandleTime, setSelectedCandleTime] = useState<number | null>(null);
  const previousAnalysisRef = useRef<ChartAnalysis | null>(null);

  useEffect(() => {
    setDraft(selection.ticker);
    setQuery('');
    setSearchOpen(false);
    setTimeline([]);
    setSelectedCandleTime(null);
    previousAnalysisRef.current = null;
    onAnalysisChange?.(null);
  }, [selection.market, selection.ticker, selection.timeframe, onAnalysisChange]);

  const searchQuery = useQuery({
    queryKey: ['unified-chart-search', market, query.trim()],
    queryFn: ({ signal }) => searchCandidates(market, query, signal),
    enabled: query.trim().length > 0,
    staleTime: 30_000,
    retry: 1,
  });
  const chartQuery = useQuery({
    queryKey: ['unified-chart-data', market, selection.ticker, timeframe],
    queryFn: ({ signal }) => fetchUnifiedChartData({ market, symbol: selection.ticker, timeframe, signal }),
    enabled: Boolean(selection.ticker),
    refetchInterval: live ? (timeframe === '1D' ? 30_000 : 8_000) : false,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: (failureCount, error) => {
      if (failureCount >= 1) return false;
      if (error instanceof UnifiedChartDataError) return error.retryable && error.kind !== 'aborted';
      return true;
    },
  });

  const candles = chartQuery.data?.normalization.candles ?? EMPTY_CANDLES;
  const indicators = useMemo(() => computeChartIndicators(candles), [candles]);
  const levels = useMemo(() => computeLevels(candles, indicators), [candles, indicators]);
  const analysis = useMemo(() => {
    if (!chartQuery.data || !levels || candles.length < 2) return null;
    return buildCurrentAnalysis({
      selection: { ...selection, timeframe },
      data: chartQuery.data,
      indicators,
      levels,
      previous: previousAnalysisRef.current,
    });
  }, [candles.length, chartQuery.data, indicators, levels, selection, timeframe]);

  useEffect(() => {
    if (selectedCandleTime != null && !candles.some((candle) => candle.time === selectedCandleTime)) {
      setSelectedCandleTime(null);
    }
  }, [candles, selectedCandleTime]);

  useEffect(() => {
    if (!analysis) {
      onAnalysisChange?.(null);
      return;
    }
    const previous = previousAnalysisRef.current;
    previousAnalysisRef.current = analysis;
    onAnalysisChange?.(analysis);
    if (!shouldAppendTimeline(previous, analysis)) return;
    const key = `${analysis.id}:${analysis.status}:${Math.floor(analysis.confidence / 10)}`;
    setTimeline((current) => [{ key, analysis }, ...current.filter((item) => item.key !== key)].slice(0, 30));
  }, [analysis, onAnalysisChange]);

  const commitSelection = useCallback((candidate: {
    market: AnalysisMarket;
    symbol: string;
    name: string;
    timeframe?: UnifiedChartTimeframe;
  }) => {
    const symbol = normalizeUnifiedSymbol(candidate.market, candidate.symbol);
    if (!symbol) {
      setInputError('유효한 종목 심볼을 입력하세요.');
      return;
    }
    setInputError('');
    onSelectionChange({
      ...selection,
      assetType: marketAssetType(candidate.market),
      market: candidate.market,
      symbol,
      ticker: symbol,
      displayName: candidate.name.trim() || symbol,
      timeframe: candidate.timeframe ?? timeframe,
      selectedAt: selection.market === candidate.market && selection.ticker === symbol
        ? selection.selectedAt
        : new Date().toISOString(),
    });
  }, [onSelectionChange, selection, timeframe]);

  const handleCandleSelect = useCallback((time: number) => {
    setSelectedCandleTime(time);
  }, []);
  const changeMarket = (nextMarket: AnalysisMarket) => {
    if (nextMarket === market) return;
    const fallback = defaultUnifiedSymbol(nextMarket);
    commitSelection({ market: nextMarket, symbol: fallback.symbol, name: fallback.displayName, timeframe });
  };
  const submitDraft = () => commitSelection({ market, symbol: draft, name: draft, timeframe });
  const changeTimeframe = (nextTimeframe: UnifiedChartTimeframe) => commitSelection({
    market,
    symbol: selection.ticker,
    name: selection.displayName,
    timeframe: nextTimeframe,
  });
  const toggleOverlay = (key: OverlayKey) => setOverlays((current) => persistOverlays({ ...current, [key]: !current[key] }));

  const dataStatus = unifiedChartDataStatus(chartQuery.data, chartQuery.isError);
  const latest = candles.at(-1);
  const currentIndicator = indicators.latest;
  const searchRows = searchQuery.data ?? [];
  const warnings = chartQuery.data?.normalization.warnings ?? [];
  const errorMessage = chartQuery.error instanceof Error ? chartQuery.error.message : '차트 데이터를 불러오지 못했습니다.';

  return (
    <div className="space-y-4" data-testid="unified-analysis-chart">
      <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <div><p className="text-[11px] font-extrabold text-primary">시장·종목 선택</p><h2 className="mt-1 text-base font-black">실제 차트 데이터</h2></div>
          <button type="button" onClick={() => setLive((current) => !current)} className={cn('rounded-full border px-3 py-1.5 text-xs font-extrabold', live ? 'border-positive/30 bg-positive/10 text-positive' : 'border-card-border bg-background text-muted-foreground')}>{live ? '자동 갱신 중' : '갱신 일시정지'}</button>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {MARKET_OPTIONS.map((item) => (
            <button key={item.key} type="button" data-testid={`market-${item.key}`} onClick={() => changeMarket(item.key)} className={cn('rounded-xl border px-2 py-2 text-xs font-black', market === item.key ? 'border-primary bg-primary text-primary-foreground' : 'border-card-border bg-background text-muted-foreground')}>{item.label}</button>
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          <label className="flex min-w-0 flex-1 items-center gap-2 rounded-2xl border border-card-border bg-background px-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submitDraft(); } }} aria-label="차트 종목 심볼" className="h-11 min-w-0 flex-1 bg-transparent text-sm font-bold outline-none" />
            {draft && <button type="button" aria-label="심볼 지우기" onClick={() => setDraft('')}><X className="h-4 w-4 text-muted-foreground" /></button>}
          </label>
          <button type="button" data-testid="apply-chart-symbol" onClick={submitDraft} className="shrink-0 rounded-2xl bg-primary px-4 text-xs font-black text-primary-foreground">적용</button>
        </div>
        {inputError && <p role="alert" className="mt-2 text-xs font-bold text-destructive">{inputError}</p>}
        <button type="button" onClick={() => setSearchOpen((current) => !current)} className="mt-2 flex w-full items-center justify-between rounded-2xl border border-card-border bg-background px-3 py-2.5 text-left"><span className="text-xs font-extrabold">종목명·심볼 검색</span>{searchOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}</button>
        {searchOpen && (
          <div className="mt-2 rounded-2xl border border-card-border bg-background p-2">
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="검색어 입력" aria-label="차트 종목 검색" className="h-10 w-full rounded-xl border border-card-border bg-card px-3 text-sm font-bold outline-none focus:border-primary" />
            <div className="mt-2 max-h-60 overflow-y-auto">
              {searchQuery.isLoading ? <Centered><Loader2 className="h-4 w-4 animate-spin" /> 검색 중</Centered> : searchQuery.isError ? <p role="alert" className="p-4 text-center text-xs font-bold text-destructive">검색 데이터를 불러오지 못했습니다.</p> : searchRows.length ? searchRows.map((row) => (
                <button key={`${row.market}:${row.symbol}`} type="button" onClick={() => { setDraft(row.symbol); setQuery(''); setSearchOpen(false); commitSelection({ market: row.market, symbol: row.symbol, name: row.name }); }} className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-secondary">
                  <div className="min-w-0"><p className="truncate text-sm font-black">{row.name}</p><p className="text-[10px] font-bold text-muted-foreground">{row.symbol}</p></div>
                  <div className="text-right text-[10px] font-bold"><p>{formatPrice(row.price, row.market)}</p><p>{formatPercent(row.changePercent)}</p></div>
                </button>
              )) : <p className="p-4 text-center text-xs font-bold text-muted-foreground">{query.trim() ? '검색 결과가 없습니다. 심볼을 직접 입력할 수 있습니다.' : '검색어를 입력하세요.'}</p>}
            </div>
          </div>
        )}
      </section>

      <section className="overflow-hidden rounded-3xl border border-card-border bg-card shadow-sm">
        <div className="border-b border-card-border p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h2 className="truncate text-lg font-black">{selection.displayName}</h2><span className="rounded-full bg-secondary px-2 py-1 text-[10px] font-extrabold text-muted-foreground">{selection.ticker}</span><span data-testid="chart-data-status" className={cn('rounded-full border px-2 py-1 text-[10px] font-black', dataStatusClass(dataStatus))}>{dataStatusLabel(dataStatus)}</span></div><p className="mt-1 text-[11px] font-bold text-muted-foreground">{unifiedMarketLabel(market)} · {chartQuery.data?.provider ?? '데이터 연결 대기'}</p></div>
            <button type="button" aria-label="차트 새로고침" onClick={() => void chartQuery.refetch()} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-card-border bg-background"><RefreshCw className={cn('h-4 w-4', chartQuery.isFetching && 'animate-spin')} /></button>
          </div>
          <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
            {UNIFIED_CHART_TIMEFRAMES.map((item) => <button key={item.key} type="button" data-testid={`timeframe-${item.key}`} onClick={() => changeTimeframe(item.key)} className={cn('shrink-0 rounded-xl border px-3 py-2 text-xs font-extrabold', timeframe === item.key ? 'border-primary bg-primary text-primary-foreground' : 'border-card-border bg-background text-muted-foreground')}>{item.label}</button>)}
          </div>
          <button type="button" onClick={() => setSettingsOpen((current) => !current)} className="mt-3 flex w-full items-center justify-between rounded-2xl border border-card-border bg-background px-3 py-2.5 text-left"><span className="inline-flex items-center gap-2 text-xs font-extrabold"><Settings2 className="h-4 w-4 text-primary" /> 지표 설정 · 브라우저 저장</span>{settingsOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}</button>
          {settingsOpen && <div className="mt-2 flex flex-wrap gap-2 rounded-2xl border border-card-border bg-background p-3">{OVERLAY_OPTIONS.map((item) => <button key={item.key} type="button" data-testid={`overlay-${item.key}`} onClick={() => toggleOverlay(item.key)} className={cn('rounded-full border px-3 py-1.5 text-[11px] font-extrabold', overlays[item.key] ? 'border-primary bg-primary/10 text-primary' : 'border-card-border bg-card text-muted-foreground')}>{overlays[item.key] ? '✓ ' : '+ '}{item.label}</button>)}</div>}
        </div>
        <div className="min-h-[390px] bg-background/30">
          {chartQuery.isLoading ? <Centered tall><Loader2 className="h-5 w-5 animate-spin" /> 차트 불러오는 중</Centered> : chartQuery.isError ? <div className="flex h-[390px] flex-col items-center justify-center px-6 text-center" data-testid="chart-error-state"><AlertTriangle className="h-8 w-8 text-destructive" /><p className="mt-3 text-sm font-black">차트 데이터를 불러오지 못했습니다.</p><p role="alert" className="mt-1 break-keep text-xs font-bold leading-5 text-muted-foreground">{errorMessage}</p><button type="button" onClick={() => void chartQuery.refetch()} className="mt-4 rounded-full bg-primary px-4 py-2 text-xs font-black text-primary-foreground">다시 시도</button></div> : candles.length < 2 || !levels ? <div className="flex h-[390px] flex-col items-center justify-center px-6 text-center" data-testid="chart-empty-state"><BarChart3 className="h-8 w-8 text-muted-foreground" /><p className="mt-3 text-sm font-black">표시할 유효한 캔들이 없습니다.</p><p className="mt-1 break-keep text-xs font-bold leading-5 text-muted-foreground">잘못된 심볼, 데이터 없는 종목 또는 지원하지 않는 시간봉인지 확인하세요. 임시 캔들은 만들지 않습니다.</p></div> : <UnifiedChartCanvas candles={candles} indicators={indicators} levels={levels} analysis={analysis} overlays={overlays} timeframe={timeframe} resetKey={`${market}:${selection.ticker}:${timeframe}`} onCandleSelect={handleCandleSelect} />}
        </div>
      </section>

      <SelectedCandleDetailPanel
        candles={candles}
        indicators={indicators}
        market={market}
        timeframe={timeframe}
        selectedTime={selectedCandleTime}
        onReset={() => setSelectedCandleTime(null)}
      />

      {warnings.length > 0 && <section className="rounded-3xl border border-warning/30 bg-warning/5 p-4" data-testid="chart-data-warnings"><div className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-warning" /><h2 className="text-sm font-black">데이터 품질 알림</h2></div><ul className="mt-2 space-y-1 text-xs font-bold text-muted-foreground">{warnings.map((warning) => <li key={warning}>• {warning}</li>)}</ul></section>}

      {latest && levels && <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm"><div className="flex items-start justify-between gap-3"><div><p className="text-[11px] font-extrabold text-primary">기술지표·분석 참고선</p><h2 className="mt-1 text-lg font-black">{analysis?.title ?? '분석 준비 중'}</h2></div><div className="rounded-full border border-card-border bg-secondary px-3 py-1.5 text-xs font-black">{analysis?.bias === 'bullish' ? '상승 우세' : analysis?.bias === 'bearish' ? '하락 우세' : '중립'}</div></div><p className="mt-3 rounded-2xl bg-secondary/70 p-3 text-xs font-bold leading-5">{analysis?.summary ?? '유효한 완료봉과 지표가 준비되면 분석을 표시합니다.'}</p><div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4"><Metric label="현재가" value={formatPrice(latest.close, market)} icon={<BarChart3 className="h-4 w-4" />} /><Metric label="1차 지지" value={formatPrice(levels.support, market)} icon={<TrendingDown className="h-4 w-4" />} /><Metric label="1차 저항" value={formatPrice(levels.resistance, market)} icon={<TrendingUp className="h-4 w-4" />} /><Metric label="목표 참고" value={formatPrice(levels.targetReference, market)} icon={<TrendingUp className="h-4 w-4" />} />{overlays.rsi && <Metric label="RSI14" value={currentIndicator?.rsi14 == null ? '-' : currentIndicator.rsi14.toFixed(1)} />}{overlays.macd && <Metric label="MACD" value={currentIndicator?.macd == null ? '-' : currentIndicator.macd.toFixed(4)} />}{overlays.atr && <Metric label="ATR14" value={formatPrice(currentIndicator?.atr14, market)} />}<Metric label="거래량 비율" value={currentIndicator?.volumeRatio20 == null ? '-' : `${currentIndicator.volumeRatio20.toFixed(2)}배`} /></div></section>}

      <section className="rounded-3xl border border-card-border bg-card p-4 shadow-sm"><div className="flex items-center justify-between gap-2"><div><p className="text-[11px] font-extrabold text-primary">분석 상태 타임라인</p><h2 className="mt-1 text-sm font-black">형성 → 후보 → 확정·무효화</h2></div><span className="text-[10px] font-bold text-muted-foreground">최근 {timeline.length}건</span></div><div className="mt-3 max-h-72 space-y-2 overflow-y-auto">{timeline.length ? timeline.map((item) => <div key={item.key} className="rounded-2xl bg-background p-3 text-xs"><div className="flex items-center justify-between gap-2"><strong>{item.analysis.title}</strong><span className="text-[10px] font-black text-primary">{item.analysis.status}</span></div><p className="mt-1 break-keep font-bold leading-5 text-muted-foreground">{item.analysis.transitionReason}</p><p className="mt-1 text-[10px] font-semibold text-muted-foreground">{new Date(item.analysis.detectedAt).toLocaleString('ko-KR')}</p></div>) : <p className="rounded-2xl bg-background p-5 text-center text-xs font-bold text-muted-foreground">새 분석 상태를 기다리는 중입니다.</p>}</div></section>
      <p className="px-1 text-[10px] font-semibold leading-4 text-muted-foreground">국내주식·미국주식·업비트 현물·비트겟 선물의 공개 시세를 읽기 전용으로 분석합니다. 주문 API와 연결하지 않으며 실제 주문을 실행하지 않습니다.</p>
    </div>
  );
}

function ChartControl({ label, testId, onClick, children }: { label: string; testId: string; onClick: () => void; children: ReactNode }) {
  return <button type="button" data-testid={testId} title={label} aria-label={label} onClick={onClick} className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-secondary">{children}</button>;
}

function Centered({ children, tall = false }: { children: ReactNode; tall?: boolean }) {
  return <p className={cn('flex items-center justify-center gap-2 text-xs font-bold text-muted-foreground', tall ? 'h-[390px]' : 'p-5')}>{children}</p>;
}

function Metric({ label, value, icon }: { label: string; value: string; icon?: ReactNode }) {
  return <div className="rounded-2xl border border-card-border bg-background p-3"><div className="flex items-center gap-1.5 text-primary">{icon}<span className="text-[10px] font-extrabold text-muted-foreground">{label}</span></div><p className="mt-2 break-words text-sm font-black">{value}</p></div>;
}
