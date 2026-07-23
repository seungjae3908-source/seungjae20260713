import { useEffect, useRef } from 'react';
import {
  createChart,
  ColorType,
  CrosshairMode,
  type IChartApi,
  type Time,
  type LineData,
  type CandlestickData,
  type HistogramData,
} from 'lightweight-charts';
import type { Candle, IndicatorSeries } from '@/lib/api';

const UP = '#22c55e';
const DOWN = '#ef4444';
const GRID = 'rgba(255,255,255,0.05)';
const TEXT = 'rgba(255,255,255,0.55)';

const baseOptions = {
  layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: TEXT, fontSize: 11 },
  grid: { vertLines: { color: GRID }, horzLines: { color: GRID } },
  crosshair: { mode: CrosshairMode.Normal },
  rightPriceScale: { borderColor: GRID },
  timeScale: { borderColor: GRID, timeVisible: true, secondsVisible: false },
  handleScroll: true,
  handleScale: true,
};

function useResize(ref: React.RefObject<HTMLDivElement | null>, chartRef: React.RefObject<IChartApi | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (chartRef.current && el) chartRef.current.applyOptions({ width: el.clientWidth });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, chartRef]);
}

function lineData(candles: Candle[], series: (number | null)[]): LineData[] {
  const out: LineData[] = [];
  for (let i = 0; i < candles.length; i++) {
    const v = series[i];
    if (v !== null && v !== undefined) out.push({ time: candles[i].time as Time, value: v });
  }
  return out;
}

// Simple moving average computed directly from the real candle close series.
// When there are fewer bars than `period`, the leading positions are null so
// the line simply starts later (no fabricated points — requirement #12).
export function movingAverage(candles: Candle[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].close;
    if (i >= period) sum -= candles[i - period].close;
    out.push(i >= period - 1 ? sum / period : null);
  }
  return out;
}

export type MaPeriod = 5 | 20 | 60 | 120;

export const MA_CONFIG: { period: MaPeriod; color: string; label: string }[] = [
  { period: 5, color: '#ec4899', label: '5봉' },
  { period: 20, color: '#3b82f6', label: '20봉' },
  { period: 60, color: '#f59e0b', label: '60봉' },
  { period: 120, color: '#a855f7', label: '120봉' },
];

export function PriceChart({
  candles,
  visibleMas,
}: {
  candles: Candle[];
  indicators?: IndicatorSeries;
  visibleMas?: MaPeriod[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  useResize(ref, chartRef);

  useEffect(() => {
    const el = ref.current;
    if (!el || candles.length === 0) return;
    const chart = createChart(el, { ...baseOptions, width: el.clientWidth, height: 300 });
    chartRef.current = chart;

    const candleSeries = chart.addCandlestickSeries({
      upColor: UP,
      downColor: DOWN,
      borderUpColor: UP,
      borderDownColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
    });
    candleSeries.setData(
      candles.map(
        (c): CandlestickData => ({
          time: c.time as Time,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        }),
      ),
    );

    const volSeries = chart.addHistogramSeries({
      priceScaleId: 'vol',
      priceFormat: { type: 'volume' },
    });
    volSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volSeries.setData(
      candles.map(
        (c): HistogramData => ({
          time: c.time as Time,
          value: c.volume,
          color: c.close >= c.open ? 'rgba(34,197,94,0.4)' : 'rgba(239,68,68,0.4)',
        }),
      ),
    );

    const enabled = visibleMas ?? MA_CONFIG.map((m) => m.period);
    for (const { period, color } of MA_CONFIG) {
      if (!enabled.includes(period)) continue;
      const data = lineData(candles, movingAverage(candles, period));
      if (data.length === 0) continue;
      const s = chart.addLineSeries({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      s.setData(data);
    }

    chart.timeScale().fitContent();
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [candles, visibleMas]);

  return <div ref={ref} className="w-full" />;
}

export function RsiChart({ candles, rsi }: { candles: Candle[]; rsi: (number | null)[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  useResize(ref, chartRef);

  useEffect(() => {
    const el = ref.current;
    if (!el || candles.length === 0) return;
    const chart = createChart(el, {
      ...baseOptions,
      width: el.clientWidth,
      height: 120,
      rightPriceScale: { borderColor: GRID },
    });
    chartRef.current = chart;
    const s = chart.addLineSeries({ color: '#3b82f6', lineWidth: 1, priceLineVisible: false });
    s.setData(lineData(candles, rsi));
    for (const level of [70, 30]) {
      const g = chart.addLineSeries({ color: 'rgba(255,255,255,0.15)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      g.setData(candles.map((c) => ({ time: c.time as Time, value: level })));
    }
    chart.timeScale().fitContent();
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [candles, rsi]);

  return <div ref={ref} className="w-full" />;
}

export function MacdChart({
  candles,
  macd,
}: {
  candles: Candle[];
  macd: { macd: (number | null)[]; signal: (number | null)[]; hist: (number | null)[] };
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  useResize(ref, chartRef);

  useEffect(() => {
    const el = ref.current;
    if (!el || candles.length === 0) return;
    const chart = createChart(el, { ...baseOptions, width: el.clientWidth, height: 120 });
    chartRef.current = chart;

    const hist = chart.addHistogramSeries({ priceLineVisible: false });
    const histData: HistogramData[] = [];
    for (let i = 0; i < candles.length; i++) {
      const v = macd.hist[i];
      if (v !== null && v !== undefined)
        histData.push({ time: candles[i].time as Time, value: v, color: v >= 0 ? 'rgba(34,197,94,0.5)' : 'rgba(239,68,68,0.5)' });
    }
    hist.setData(histData);

    const macdLine = chart.addLineSeries({ color: '#3b82f6', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    macdLine.setData(lineData(candles, macd.macd));
    const signalLine = chart.addLineSeries({ color: '#f59e0b', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    signalLine.setData(lineData(candles, macd.signal));

    chart.timeScale().fitContent();
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [candles, macd]);

  return <div ref={ref} className="w-full" />;
}
