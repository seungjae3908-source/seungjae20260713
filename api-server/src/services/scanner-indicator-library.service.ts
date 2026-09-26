import type { ScannerQualityCandle } from './scanner-data-quality.service';

export interface ScannerMacdSnapshot {
  macd: number | null;
  signal: number | null;
  histogram: number | null;
}

export interface ScannerIndicatorSnapshot {
  close: number | null;
  ema12: number | null;
  ema20: number | null;
  ema26: number | null;
  ema60: number | null;
  sma20: number | null;
  sma60: number | null;
  sma120: number | null;
  rsi14: number | null;
  atr14: number | null;
  adx14: number | null;
  vwap: number | null;
  relativeVolume20: number | null;
  tradeIntensityProxy: number | null;
  macd: ScannerMacdSnapshot;
  support20: number | null;
  resistance20: number | null;
  volumeTrend20: number | null;
  momentum5: number | null;
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

export function scannerSma(values: number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  return average(values.slice(-period));
}

function emaSeries(values: number[], period: number): Array<number | null> {
  if (period <= 0 || values.length < period) return values.map(() => null);
  const output: Array<number | null> = values.map(() => null);
  const seed = average(values.slice(0, period));
  if (seed == null) return output;
  output[period - 1] = seed;
  const multiplier = 2 / (period + 1);
  let previous = seed;
  for (let index = period; index < values.length; index += 1) {
    previous = (values[index] - previous) * multiplier + previous;
    output[index] = previous;
  }
  return output;
}

export function scannerEma(values: number[], period: number): number | null {
  return emaSeries(values, period).at(-1) ?? null;
}

export function scannerRsi(values: number[], period = 14): number | null {
  if (values.length <= period) return null;
  let gains = 0;
  let losses = 0;
  const start = values.length - period;
  for (let index = start; index < values.length; index += 1) {
    const delta = values[index] - values[index - 1];
    if (delta >= 0) gains += delta;
    else losses += Math.abs(delta);
  }
  if (losses === 0) return 100;
  const relativeStrength = gains / losses;
  return 100 - 100 / (1 + relativeStrength);
}

export function scannerAtr(candles: ScannerQualityCandle[], period = 14): number | null {
  if (candles.length < 2) return null;
  const rows = candles.slice(-Math.min(candles.length, period + 1));
  const ranges: number[] = [];
  for (let index = 1; index < rows.length; index += 1) {
    const current = rows[index];
    const previous = rows[index - 1];
    ranges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close),
    ));
  }
  return average(ranges);
}

export function scannerMacd(values: number[]): ScannerMacdSnapshot {
  if (values.length < 26) return { macd: null, signal: null, histogram: null };
  const fast = emaSeries(values, 12);
  const slow = emaSeries(values, 26);
  const macdSeries = values.map((_, index) => (
    fast[index] != null && slow[index] != null ? fast[index]! - slow[index]! : null
  ));
  const compact = macdSeries.filter((value): value is number => value != null);
  if (compact.length < 9) {
    return { macd: macdSeries.at(-1) ?? null, signal: null, histogram: null };
  }
  const signalSeries = emaSeries(compact, 9);
  const macd = compact.at(-1) ?? null;
  const signal = signalSeries.at(-1) ?? null;
  return {
    macd,
    signal,
    histogram: macd != null && signal != null ? macd - signal : null,
  };
}

export function scannerAdx(candles: ScannerQualityCandle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const rows = candles.slice(-(period + 1));
  let trTotal = 0;
  let plusTotal = 0;
  let minusTotal = 0;
  for (let index = 1; index < rows.length; index += 1) {
    const current = rows[index];
    const previous = rows[index - 1];
    const upMove = current.high - previous.high;
    const downMove = previous.low - current.low;
    const trueRange = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close),
    );
    trTotal += trueRange;
    if (upMove > downMove && upMove > 0) plusTotal += upMove;
    if (downMove > upMove && downMove > 0) minusTotal += downMove;
  }
  if (!(trTotal > 0)) return null;
  const plusDi = plusTotal / trTotal * 100;
  const minusDi = minusTotal / trTotal * 100;
  const denominator = plusDi + minusDi;
  if (!(denominator > 0)) return 0;
  return Math.abs(plusDi - minusDi) / denominator * 100;
}

export function scannerVwap(candles: ScannerQualityCandle[]): number | null {
  let weighted = 0;
  let volume = 0;
  for (const candle of candles) {
    if (!(candle.volume >= 0) || !Number.isFinite(candle.volume)) continue;
    const typical = (candle.high + candle.low + candle.close) / 3;
    weighted += typical * candle.volume;
    volume += candle.volume;
  }
  return volume > 0 ? weighted / volume : null;
}

export function scannerRelativeVolume(candles: ScannerQualityCandle[], lookback = 20): number | null {
  if (candles.length < 2) return null;
  const latest = candles.at(-1)!;
  const baseline = candles.slice(-(lookback + 1), -1).map((row) => row.volume).filter(Number.isFinite);
  const mean = average(baseline);
  return mean != null && mean > 0 ? latest.volume / mean : null;
}

export function scannerTradeIntensityProxy(candles: ScannerQualityCandle[], lookback = 20): number | null {
  const latest = candles.at(-1);
  if (!latest) return null;
  const range = latest.high - latest.low;
  const relativeVolume = scannerRelativeVolume(candles, lookback);
  if (!(range > 0) || relativeVolume == null) return null;
  // Providers without aggressor-side volume cannot expose a true execution-strength ratio.
  // This deterministic proxy combines candle pressure (-1..1) with relative volume.
  const pressure = Math.max(-1, Math.min(1, (latest.close - latest.open) / range));
  return pressure * relativeVolume;
}

export function buildScannerIndicatorSnapshot(candles: ScannerQualityCandle[]): ScannerIndicatorSnapshot {
  const closes = candles.map((row) => row.close).filter(Number.isFinite);
  const recent20 = candles.slice(-20);
  const latest = candles.at(-1) ?? null;
  const firstVolumeWindow = candles.slice(-20, -10).map((row) => row.volume).filter(Number.isFinite);
  const lastVolumeWindow = candles.slice(-10).map((row) => row.volume).filter(Number.isFinite);
  const earlyVolume = average(firstVolumeWindow);
  const lateVolume = average(lastVolumeWindow);
  const volumeTrend20 = earlyVolume != null && earlyVolume > 0 && lateVolume != null
    ? lateVolume / earlyVolume - 1
    : null;
  const momentum5 = closes.length >= 6 && closes.at(-6)! > 0
    ? closes.at(-1)! / closes.at(-6)! - 1
    : null;

  return {
    close: latest?.close ?? null,
    ema12: scannerEma(closes, 12),
    ema20: scannerEma(closes, 20),
    ema26: scannerEma(closes, 26),
    ema60: scannerEma(closes, 60),
    sma20: scannerSma(closes, 20),
    sma60: scannerSma(closes, 60),
    sma120: scannerSma(closes, 120),
    rsi14: scannerRsi(closes, 14),
    atr14: scannerAtr(candles, 14),
    adx14: scannerAdx(candles, 14),
    vwap: scannerVwap(candles),
    relativeVolume20: scannerRelativeVolume(candles, 20),
    tradeIntensityProxy: scannerTradeIntensityProxy(candles, 20),
    macd: scannerMacd(closes),
    support20: recent20.length ? Math.min(...recent20.map((row) => row.low)) : null,
    resistance20: recent20.length ? Math.max(...recent20.map((row) => row.high)) : null,
    volumeTrend20,
    momentum5,
  };
}
