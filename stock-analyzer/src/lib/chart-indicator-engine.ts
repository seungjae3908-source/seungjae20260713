import type { NormalizedChartCandle } from './chart-candle-normalizer';

export type ChartIndicatorValue = number | null;

export type ChartBollingerValue = {
  upper: number;
  middle: number;
  lower: number;
} | null;

export type ChartIndicatorSnapshot = {
  time: number;
  sma5: ChartIndicatorValue;
  sma20: ChartIndicatorValue;
  sma60: ChartIndicatorValue;
  sma120: ChartIndicatorValue;
  ema12: ChartIndicatorValue;
  ema26: ChartIndicatorValue;
  rsi14: ChartIndicatorValue;
  macd: ChartIndicatorValue;
  macdSignal: ChartIndicatorValue;
  macdHistogram: ChartIndicatorValue;
  atr14: ChartIndicatorValue;
  bollinger20: ChartBollingerValue;
  vwap: ChartIndicatorValue;
  volumeRatio20: ChartIndicatorValue;
};

export type ChartIndicatorPoint = ChartIndicatorSnapshot;

export type ChartIndicatorResult = {
  points: ChartIndicatorPoint[];
  latest: ChartIndicatorSnapshot | null;
};

class RollingWindow {
  private readonly values: number[] = [];
  private sum = 0;
  private sumSquares = 0;

  constructor(private readonly period: number) {}

  push(value: number): void {
    this.values.push(value);
    this.sum += value;
    this.sumSquares += value * value;
    if (this.values.length > this.period) {
      const removed = this.values.shift()!;
      this.sum -= removed;
      this.sumSquares -= removed * removed;
    }
  }

  get length(): number {
    return this.values.length;
  }

  mean(requireFullPeriod = true): number | null {
    if (!this.values.length || (requireFullPeriod && this.values.length < this.period)) return null;
    return this.sum / this.values.length;
  }

  standardDeviation(): number | null {
    if (this.values.length < this.period) return null;
    const mean = this.sum / this.values.length;
    const variance = Math.max(0, this.sumSquares / this.values.length - mean * mean);
    return Math.sqrt(variance);
  }
}

class EmaAccumulator {
  private readonly seed: number[] = [];
  private current: number | null = null;
  private readonly multiplier: number;

  constructor(private readonly period: number) {
    this.multiplier = 2 / (period + 1);
  }

  push(value: number): number | null {
    if (this.current != null) {
      this.current = (value - this.current) * this.multiplier + this.current;
      return this.current;
    }
    this.seed.push(value);
    if (this.seed.length < this.period) return null;
    this.current = this.seed.reduce((sum, item) => sum + item, 0) / this.period;
    return this.current;
  }
}

class RsiAccumulator {
  private previousClose: number | null = null;
  private readonly gains: RollingWindow;
  private readonly losses: RollingWindow;

  constructor(period: number) {
    this.gains = new RollingWindow(period);
    this.losses = new RollingWindow(period);
  }

  push(close: number): number | null {
    if (this.previousClose == null) {
      this.previousClose = close;
      return null;
    }
    const change = close - this.previousClose;
    this.previousClose = close;
    this.gains.push(Math.max(change, 0));
    this.losses.push(Math.max(-change, 0));
    const averageGain = this.gains.mean();
    const averageLoss = this.losses.mean();
    if (averageGain == null || averageLoss == null) return null;
    if (averageLoss === 0) return 100;
    return 100 - 100 / (1 + averageGain / averageLoss);
  }
}

class AtrAccumulator {
  private previousClose: number | null = null;
  private readonly trueRanges: RollingWindow;

  constructor(period: number) {
    this.trueRanges = new RollingWindow(period);
  }

  push(candle: NormalizedChartCandle): number | null {
    if (this.previousClose == null) {
      this.previousClose = candle.close;
      return null;
    }
    const trueRange = Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - this.previousClose),
      Math.abs(candle.low - this.previousClose),
    );
    this.previousClose = candle.close;
    this.trueRanges.push(trueRange);
    return this.trueRanges.mean(false);
  }
}

function safeDivide(numerator: number, denominator: number | null): number | null {
  if (denominator == null || !Number.isFinite(denominator) || denominator <= 0) return null;
  const value = numerator / denominator;
  return Number.isFinite(value) ? value : null;
}

export function computeChartIndicators(candles: NormalizedChartCandle[]): ChartIndicatorResult {
  const sma5 = new RollingWindow(5);
  const sma20 = new RollingWindow(20);
  const sma60 = new RollingWindow(60);
  const sma120 = new RollingWindow(120);
  const bollinger20 = new RollingWindow(20);
  const previousVolumes20 = new RollingWindow(20);
  const ema12 = new EmaAccumulator(12);
  const ema26 = new EmaAccumulator(26);
  const macdSignal = new EmaAccumulator(9);
  const rsi14 = new RsiAccumulator(14);
  const atr14 = new AtrAccumulator(14);
  let cumulativeTypicalVolume = 0;
  let cumulativeVolume = 0;
  const points: ChartIndicatorPoint[] = [];

  for (const candle of candles) {
    const averagePreviousVolume = previousVolumes20.mean(false);
    const volumeRatio20 = safeDivide(candle.volume, averagePreviousVolume);

    sma5.push(candle.close);
    sma20.push(candle.close);
    sma60.push(candle.close);
    sma120.push(candle.close);
    bollinger20.push(candle.close);

    const ema12Value = ema12.push(candle.close);
    const ema26Value = ema26.push(candle.close);
    const macd = ema12Value != null && ema26Value != null ? ema12Value - ema26Value : null;
    const signal = macd == null ? null : macdSignal.push(macd);
    const histogram = macd != null && signal != null ? macd - signal : null;

    const typicalPrice = (candle.high + candle.low + candle.close) / 3;
    cumulativeTypicalVolume += typicalPrice * candle.volume;
    cumulativeVolume += candle.volume;
    const vwap = cumulativeVolume > 0 ? cumulativeTypicalVolume / cumulativeVolume : null;

    const middle = bollinger20.mean();
    const deviation = bollinger20.standardDeviation();
    const band = middle != null && deviation != null
      ? { upper: middle + deviation * 2, middle, lower: middle - deviation * 2 }
      : null;

    points.push({
      time: candle.time,
      sma5: sma5.mean(),
      sma20: sma20.mean(),
      sma60: sma60.mean(),
      sma120: sma120.mean(),
      ema12: ema12Value,
      ema26: ema26Value,
      rsi14: rsi14.push(candle.close),
      macd,
      macdSignal: signal,
      macdHistogram: histogram,
      atr14: atr14.push(candle),
      bollinger20: band,
      vwap,
      volumeRatio20,
    });

    previousVolumes20.push(candle.volume);
  }

  return { points, latest: points.at(-1) ?? null };
}

export function indicatorSeries(
  result: ChartIndicatorResult,
  key: Exclude<keyof ChartIndicatorSnapshot, 'time' | 'bollinger20'>,
): Array<{ time: number; value: number }> {
  return result.points.flatMap((point) => {
    const value = point[key];
    return typeof value === 'number' && Number.isFinite(value) ? [{ time: point.time, value }] : [];
  });
}

export function bollingerSeries(result: ChartIndicatorResult): {
  upper: Array<{ time: number; value: number }>;
  middle: Array<{ time: number; value: number }>;
  lower: Array<{ time: number; value: number }>;
} {
  const upper: Array<{ time: number; value: number }> = [];
  const middle: Array<{ time: number; value: number }> = [];
  const lower: Array<{ time: number; value: number }> = [];
  for (const point of result.points) {
    if (!point.bollinger20) continue;
    upper.push({ time: point.time, value: point.bollinger20.upper });
    middle.push({ time: point.time, value: point.bollinger20.middle });
    lower.push({ time: point.time, value: point.bollinger20.lower });
  }
  return { upper, middle, lower };
}
