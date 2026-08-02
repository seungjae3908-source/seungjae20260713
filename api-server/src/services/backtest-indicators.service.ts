import type { NormalizedCandle } from './futures-market-data.service';

export type NullableSeries = Array<number | null>;

function finite(value: number) {
  return Number.isFinite(value);
}

function validPeriod(period: number) {
  return Number.isInteger(period) && period > 0;
}

export function smaSeries(values: readonly number[], period: number): NullableSeries {
  const result: NullableSeries = Array(values.length).fill(null);
  if (!validPeriod(period)) return result;
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!finite(value)) {
      sum = 0;
      continue;
    }
    sum += value;
    if (index >= period) sum -= values[index - period];
    if (index >= period - 1 && finite(sum)) result[index] = sum / period;
  }
  return result;
}

export function emaSeries(values: readonly number[], period: number): NullableSeries {
  const result: NullableSeries = Array(values.length).fill(null);
  if (!validPeriod(period) || values.length < period) return result;
  const seedValues = values.slice(0, period);
  if (seedValues.some((value) => !finite(value))) return result;
  let current = seedValues.reduce((sum, value) => sum + value, 0) / period;
  result[period - 1] = current;
  const multiplier = 2 / (period + 1);
  for (let index = period; index < values.length; index += 1) {
    const value = values[index];
    if (!finite(value)) {
      result[index] = null;
      continue;
    }
    current = (value - current) * multiplier + current;
    result[index] = finite(current) ? current : null;
  }
  return result;
}

export function rsiSeries(values: readonly number[], period = 14): NullableSeries {
  const result: NullableSeries = Array(values.length).fill(null);
  if (!validPeriod(period) || values.length <= period) return result;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    if (!finite(change)) return result;
    gains += Math.max(0, change);
    losses += Math.max(0, -change);
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  const toRsi = () => {
    if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
    const rs = averageGain / averageLoss;
    const value = 100 - 100 / (1 + rs);
    return finite(value) ? value : null;
  };
  result[period] = toRsi();
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    if (!finite(change)) {
      result[index] = null;
      continue;
    }
    averageGain = (averageGain * (period - 1) + Math.max(0, change)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(0, -change)) / period;
    result[index] = toRsi();
  }
  return result;
}

export function trueRangeSeries(candles: readonly NormalizedCandle[]): NullableSeries {
  return candles.map((candle, index) => {
    if (![candle.high, candle.low, candle.close].every(finite)) return null;
    if (index === 0) return candle.high - candle.low;
    const previousClose = candles[index - 1].close;
    if (!finite(previousClose)) return null;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
  });
}

export function atrSeries(candles: readonly NormalizedCandle[], period = 14): NullableSeries {
  const trueRanges = trueRangeSeries(candles);
  const result: NullableSeries = Array(candles.length).fill(null);
  if (!validPeriod(period) || trueRanges.length < period) return result;
  const seed = trueRanges.slice(0, period);
  if (seed.some((value) => value == null || !finite(value))) return result;
  let current = 0;
  for (const value of seed) current += value as number;
  current /= period;
  result[period - 1] = current;
  for (let index = period; index < trueRanges.length; index += 1) {
    const value = trueRanges[index];
    if (value == null || !finite(value)) {
      result[index] = null;
      continue;
    }
    current = (current * (period - 1) + value) / period;
    result[index] = finite(current) ? current : null;
  }
  return result;
}

function utcSessionKey(timestamp: number) {
  const date = new Date(timestamp);
  return `${date.getUTCFullYear()}-${date.getUTCMonth()}-${date.getUTCDate()}`;
}

export function utcSessionVwapSeries(candles: readonly NormalizedCandle[]): NullableSeries {
  const result: NullableSeries = Array(candles.length).fill(null);
  let session = '';
  let cumulativePriceVolume = 0;
  let cumulativeVolume = 0;
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    const key = utcSessionKey(candle.timestamp);
    if (key !== session) {
      session = key;
      cumulativePriceVolume = 0;
      cumulativeVolume = 0;
    }
    if (![candle.high, candle.low, candle.close, candle.volume].every(finite) || candle.volume < 0) {
      result[index] = null;
      continue;
    }
    const typical = (candle.high + candle.low + candle.close) / 3;
    cumulativePriceVolume += typical * candle.volume;
    cumulativeVolume += candle.volume;
    result[index] = cumulativeVolume > 0 && finite(cumulativePriceVolume / cumulativeVolume)
      ? cumulativePriceVolume / cumulativeVolume
      : null;
  }
  return result;
}

export function averageVolumeSeries(candles: readonly NormalizedCandle[], period: number): NullableSeries {
  return smaSeries(candles.map((candle) => candle.volume), period);
}

export function rollingHighestSeries(
  values: readonly number[],
  period: number,
  options: { excludeCurrent?: boolean } = {},
): NullableSeries {
  const result: NullableSeries = Array(values.length).fill(null);
  if (!validPeriod(period)) return result;
  for (let index = 0; index < values.length; index += 1) {
    const end = options.excludeCurrent ? index : index + 1;
    const start = end - period;
    if (start < 0) continue;
    const window = values.slice(start, end);
    if (window.length !== period || window.some((value) => !finite(value))) continue;
    result[index] = Math.max(...window);
  }
  return result;
}

export function rollingLowestSeries(
  values: readonly number[],
  period: number,
  options: { excludeCurrent?: boolean } = {},
): NullableSeries {
  const result: NullableSeries = Array(values.length).fill(null);
  if (!validPeriod(period)) return result;
  for (let index = 0; index < values.length; index += 1) {
    const end = options.excludeCurrent ? index : index + 1;
    const start = end - period;
    if (start < 0) continue;
    const window = values.slice(start, end);
    if (window.length !== period || window.some((value) => !finite(value))) continue;
    result[index] = Math.min(...window);
  }
  return result;
}

export function sanitizeClosedCandles(candles: readonly NormalizedCandle[]): {
  data: NormalizedCandle[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const byTimestamp = new Map<number, NormalizedCandle>();
  let invalid = 0;
  let open = 0;
  for (const candle of candles) {
    const valid = Number.isFinite(candle.timestamp)
      && candle.timestamp > 0
      && [candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite)
      && candle.open > 0
      && candle.high > 0
      && candle.low > 0
      && candle.close > 0
      && candle.volume >= 0
      && candle.high >= candle.low
      && candle.open <= candle.high
      && candle.open >= candle.low
      && candle.close <= candle.high
      && candle.close >= candle.low;
    if (!valid) {
      invalid += 1;
      continue;
    }
    if (!candle.isClosed) {
      open += 1;
      continue;
    }
    byTimestamp.set(candle.timestamp, candle);
  }
  if (invalid) warnings.push(`유효하지 않은 캔들 ${invalid}개를 제외했습니다.`);
  if (open) warnings.push(`미완성 캔들 ${open}개를 제외했습니다.`);
  if (byTimestamp.size !== candles.length - invalid - open) {
    warnings.push('중복 timestamp 캔들을 제거했습니다.');
  }
  return {
    data: [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp),
    warnings,
  };
}
