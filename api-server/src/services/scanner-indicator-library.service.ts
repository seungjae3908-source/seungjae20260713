import { scannerTimestampMs, type ScannerQualityCandle } from './scanner-data-quality.service';

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
  if (!Number.isInteger(period) || period < 1 || values.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const delta = values[index] - values[index - 1];
    if (delta >= 0) gains += delta;
    else losses += Math.abs(delta);
  }
  gains /= period;
  losses /= period;
  for (let index = period + 1; index < values.length; index += 1) {
    const delta = values[index] - values[index - 1];
    gains = (gains * (period - 1) + Math.max(0, delta)) / period;
    losses = (losses * (period - 1) + Math.max(0, -delta)) / period;
  }
  if (gains === 0 && losses === 0) return 50;
  if (losses === 0) return 100;
  const relativeStrength = gains / losses;
  return 100 - 100 / (1 + relativeStrength);
}

export function scannerAtr(candles: ScannerQualityCandle[], period = 14): number | null {
  if (!Number.isInteger(period) || period < 1 || candles.length <= period) return null;
  const rows = candles;
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
  let atr = average(ranges.slice(0, period))!;
  for (const range of ranges.slice(period)) atr = (atr * (period - 1) + range) / period;
  return atr;
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
  if (!Number.isInteger(period) || period < 2 || candles.length < 2 * period) return null;
  const rows = candles;
  let trTotal = 0;
  let plusTotal = 0;
  let minusTotal = 0;
  const dxValues: number[] = [];
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
    const plus = upMove > downMove && upMove > 0 ? upMove : 0;
    const minus = downMove > upMove && downMove > 0 ? downMove : 0;
    if (index < period) {
      trTotal += trueRange;
      plusTotal += plus;
      minusTotal += minus;
      continue;
    }
    trTotal = trTotal - trTotal / period + trueRange;
    plusTotal = plusTotal - plusTotal / period + plus;
    minusTotal = minusTotal - minusTotal / period + minus;
    const denominator = plusTotal + minusTotal;
    dxValues.push(trTotal > 0 && denominator > 0 ? Math.abs(plusTotal - minusTotal) / denominator * 100 : 0);
  }
  // ADX is Wilder-smoothed DX, not the latest window's single DX value.
  let adx = average(dxValues.slice(0, period))!;
  for (const dx of dxValues.slice(period)) adx = (adx * (period - 1) + dx) / period;
  return adx;
}

export function scannerVwap(candles: ScannerQualityCandle[], sessionTimeZone?: string): number | null {
  const latestAt = candles.length ? scannerTimestampMs(candles.at(-1)!.time) : null;
  const formatter = sessionTimeZone ? new Intl.DateTimeFormat('en-CA', {
    timeZone: sessionTimeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }) : null;
  if (formatter && latestAt == null) return null;
  const sessionDate = formatter ? formatter.format(new Date(latestAt!)) : null;
  let weighted = 0;
  let volume = 0;
  for (const candle of candles) {
    if (formatter) {
      const at = scannerTimestampMs(candle.time);
      if (at == null || formatter.format(new Date(at)) !== sessionDate) continue;
    }
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

export function buildScannerIndicatorSnapshot(candles: ScannerQualityCandle[], sessionTimeZone?: string): ScannerIndicatorSnapshot {
  const closes = candles.map((row) => row.close).filter(Number.isFinite);
  // A breakout must be compared with prior bars, not its own high/low.
  const recent20 = candles.slice(-21, -1);
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
    vwap: scannerVwap(candles, sessionTimeZone),
    relativeVolume20: scannerRelativeVolume(candles, 20),
    tradeIntensityProxy: scannerTradeIntensityProxy(candles, 20),
    macd: scannerMacd(closes),
    support20: recent20.length === 20 ? Math.min(...recent20.map((row) => row.low)) : null,
    resistance20: recent20.length === 20 ? Math.max(...recent20.map((row) => row.high)) : null,
    volumeTrend20,
    momentum5,
  };
}
