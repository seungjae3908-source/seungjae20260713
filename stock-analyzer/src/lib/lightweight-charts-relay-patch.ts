// @ts-nocheck
import { createChart as createBaseChart } from 'lightweight-charts-original';

export * from 'lightweight-charts-original';

const PATTERN_COLORS = new Set(['#eab308', '#f97316', '#22c55e', '#ef4444']);

function numericTime(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

function isPatternRailOptions(options: Record<string, unknown> | undefined): boolean {
  if (!options) return false;
  return (
    options.lineWidth === 3 &&
    options.priceLineVisible === false &&
    options.lastValueVisible === false &&
    options.crosshairMarkerVisible === false &&
    PATTERN_COLORS.has(String(options.color ?? '').toLowerCase())
  );
}

export function createChart(container: HTMLElement, options?: Record<string, unknown>) {
  const chart = createBaseChart(container, options as never) as any;
  const originalAddCandlestickSeries = chart.addCandlestickSeries.bind(chart);
  const originalAddLineSeries = chart.addLineSeries.bind(chart);
  const originalRemoveSeries = chart.removeSeries.bind(chart);

  let mainCandleSeries: any = null;
  let focusCandleSeries: any = null;
  let mainCandles: any[] = [];
  let relayChartDetected = false;
  const patternRanges = new Map<any, { start: number; end: number }>();

  const ensureFocusSeries = () => {
    if (focusCandleSeries) return focusCandleSeries;
    focusCandleSeries = originalAddCandlestickSeries({
      upColor: '#b91c1c',
      downColor: '#1d4ed8',
      wickUpColor: '#991b1b',
      wickDownColor: '#1e40af',
      borderUpColor: '#7f1d1d',
      borderDownColor: '#1e3a8a',
      priceLineVisible: false,
      lastValueVisible: false,
    });
    return focusCandleSeries;
  };

  const updateStoredCandle = (bar: any) => {
    const time = numericTime(bar?.time);
    if (time == null) return;
    const index = mainCandles.findIndex((item) => numericTime(item?.time) === time);
    if (index >= 0) mainCandles[index] = bar;
    else mainCandles.push(bar);
  };

  chart.addCandlestickSeries = (seriesOptions: Record<string, unknown> = {}) => {
    const series = originalAddCandlestickSeries(seriesOptions);

    if (!mainCandleSeries) {
      mainCandleSeries = series;
      const originalSetData = series.setData.bind(series);
      const originalUpdate = series.update.bind(series);
      const originalCreatePriceLine = series.createPriceLine.bind(series);

      series.setData = (data: any[]) => {
        mainCandles = Array.isArray(data) ? data.map((item) => ({ ...item })) : [];
        return originalSetData(data);
      };

      series.update = (bar: any) => {
        updateStoredCandle({ ...bar });
        return originalUpdate(bar);
      };

      series.createPriceLine = (lineOptions: Record<string, unknown>) => {
        if (
          relayChartDetected &&
          String(lineOptions?.color ?? '').toLowerCase() === '#eab308'
        ) {
          return originalCreatePriceLine({
            ...lineOptions,
            color: 'rgba(234,179,8,0)',
            axisLabelVisible: false,
            title: '',
          });
        }
        return originalCreatePriceLine(lineOptions);
      };
    }

    return series;
  };

  chart.addLineSeries = (seriesOptions: Record<string, unknown> = {}) => {
    const patternRail = isPatternRailOptions(seriesOptions);
    const series = originalAddLineSeries(
      patternRail ? { ...seriesOptions, visible: false } : seriesOptions,
    );

    if (patternRail) {
      relayChartDetected = true;
      ensureFocusSeries();
      const originalSetData = series.setData.bind(series);

      series.setData = (data: any[]) => {
        if (Array.isArray(data) && data.length >= 2) {
          const start = numericTime(data[0]?.time);
          const end = numericTime(data[data.length - 1]?.time);
          if (start != null && end != null) {
            patternRanges.set(series, {
              start: Math.min(start, end),
              end: Math.max(start, end),
            });
          }
        }
        return originalSetData([]);
      };
    }

    return series;
  };

  chart.removeSeries = (series: any) => {
    patternRanges.delete(series);
    if (series === focusCandleSeries) focusCandleSeries = null;
    return originalRemoveSeries(series);
  };

  const timeScale = chart.timeScale();
  const originalSetVisibleLogicalRange = timeScale.setVisibleLogicalRange.bind(timeScale);

  const highlightSelectedPattern = (range: { from: number; to: number }) => {
    if (!relayChartDetected || !mainCandles.length || !patternRanges.size) return;
    const focusSeries = ensureFocusSeries();
    const centerIndex = Math.max(
      0,
      Math.min(mainCandles.length - 1, Math.round((range.from + range.to) / 2)),
    );
    const centerTime = numericTime(mainCandles[centerIndex]?.time);
    if (centerTime == null) return;

    const selectedRange = [...patternRanges.values()].sort((left, right) => {
      const leftDistance = Math.abs(left.start - centerTime);
      const rightDistance = Math.abs(right.start - centerTime);
      if (leftDistance !== rightDistance) return leftDistance - rightDistance;
      return left.end - left.start - (right.end - right.start);
    })[0];

    let selected = selectedRange
      ? mainCandles.filter((candle) => {
          const time = numericTime(candle?.time);
          return time != null && time >= selectedRange.start && time <= selectedRange.end;
        })
      : [];

    if (!selected.length) {
      selected = mainCandles.slice(
        Math.max(0, centerIndex - 2),
        Math.min(mainCandles.length, centerIndex + 3),
      );
    }

    focusSeries.setData(selected);
  };

  timeScale.setVisibleLogicalRange = (range: { from: number; to: number }) => {
    const result = originalSetVisibleLogicalRange(range);
    const width = Number(range?.to) - Number(range?.from);
    if (
      relayChartDetected &&
      Number.isFinite(width) &&
      width >= 20 &&
      width <= 50.5
    ) {
      queueMicrotask(() => highlightSelectedPattern(range));
    }
    return result;
  };

  return chart;
}
