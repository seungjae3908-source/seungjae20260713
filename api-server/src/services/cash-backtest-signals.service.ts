export type CashSignalStrategy =
  | 'trend_pullback'
  | 'breakout'
  | 'vwap_reclaim'
  | 'regime_pullback'
  | 'regime_rsi_reversal'
  | 'regime_breakout_retest';

export type CashSignalRequest = {
  strategy: CashSignalStrategy;
  timeframe: string;
  parameters?: Record<string, number>;
};

export type CashSignalCandle = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type CashSignal = { index: number; action: 'BUY' | 'SELL' };
type TrendSnapshot = { fast: number; slow: number; slopePercent: number; bullish: boolean };

const HOUR_MS = 60 * 60_000;
const TIMEFRAME_MS: Record<string, number> = {
  '1m': 60_000,
  '3m': 3 * 60_000,
  '5m': 5 * 60_000,
  '10m': 10 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
};
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const numberParam = (request: CashSignalRequest, key: string, fallback: number) => finite(request.parameters?.[key]) ? request.parameters![key] : fallback;

function ema(values: readonly number[], period: number) {
  const output: Array<number | null> = Array(values.length).fill(null);
  if (values.length < period) return output;
  const multiplier = 2 / (period + 1);
  let current = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  output[period - 1] = current;
  for (let index = period; index < values.length; index += 1) {
    current = values[index] * multiplier + current * (1 - multiplier);
    output[index] = current;
  }
  return output;
}

export function cashAtrSeries(candles: readonly CashSignalCandle[], period: number) {
  const output: Array<number | null> = Array(candles.length).fill(null);
  if (candles.length < period) return output;
  const trueRanges = candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low;
    const previousClose = candles[index - 1].close;
    return Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
  });
  let current = trueRanges.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  output[period - 1] = current;
  for (let index = period; index < candles.length; index += 1) {
    current = (current * (period - 1) + trueRanges[index]) / period;
    output[index] = current;
  }
  return output;
}

function rsi(values: readonly number[], period: number) {
  const output: Array<number | null> = Array(values.length).fill(null);
  if (values.length <= period) return output;
  let averageGain = 0;
  let averageLoss = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain += Math.max(change, 0);
    averageLoss += Math.max(-change, 0);
  }
  averageGain /= period;
  averageLoss /= period;
  const valueFor = () => {
    if (averageLoss === 0 && averageGain === 0) return 50;
    if (averageLoss === 0) return 100;
    const relativeStrength = averageGain / averageLoss;
    return 100 - 100 / (1 + relativeStrength);
  };
  output[period] = valueFor();
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    averageGain = (averageGain * (period - 1) + gain) / period;
    averageLoss = (averageLoss * (period - 1) + loss) / period;
    output[index] = valueFor();
  }
  return output;
}

function averageVolume(candles: readonly CashSignalCandle[], period: number) {
  return candles.map((_candle, index) => {
    if (index < period) return null;
    const window = candles.slice(index - period, index);
    return window.reduce((sum, candle) => sum + candle.volume, 0) / period;
  });
}

function completedTrendSeries(candles: readonly CashSignalCandle[], baseTimeframeMs: number, bucketMs: number, fastPeriod: number, slowPeriod: number) {
  const buckets: Array<{ endIndex: number; close: number }> = [];
  let currentKey: number | null = null;
  let currentEndIndex = -1;
  let currentClose = 0;
  let currentTimestamp = 0;
  const finalize = () => {
    if (currentKey == null || currentEndIndex < 0) return;
    const bucketEnd = (currentKey + 1) * bucketMs;
    if (currentTimestamp + baseTimeframeMs >= bucketEnd) buckets.push({ endIndex: currentEndIndex, close: currentClose });
  };
  for (let index = 0; index < candles.length; index += 1) {
    const key = Math.floor(candles[index].timestamp / bucketMs);
    if (currentKey != null && key !== currentKey) finalize();
    if (key !== currentKey) currentKey = key;
    currentEndIndex = index;
    currentClose = candles[index].close;
    currentTimestamp = candles[index].timestamp;
  }
  finalize();
  const closes = buckets.map((bucket) => bucket.close);
  const fast = ema(closes, fastPeriod);
  const slow = ema(closes, slowPeriod);
  const snapshots = buckets.map((_bucket, index): TrendSnapshot | null => {
    const fastNow = fast[index];
    const slowNow = slow[index];
    const fastPrevious = index > 0 ? fast[index - 1] : null;
    if (fastNow == null || slowNow == null || fastPrevious == null || fastPrevious === 0) return null;
    return { fast: fastNow, slow: slowNow, slopePercent: (fastNow / fastPrevious - 1) * 100, bullish: fastNow > slowNow };
  });
  const output: Array<TrendSnapshot | null> = Array(candles.length).fill(null);
  let cursor = 0;
  let available: TrendSnapshot | null = null;
  for (let index = 0; index < candles.length; index += 1) {
    while (cursor < buckets.length && buckets[cursor].endIndex <= index) {
      available = snapshots[cursor];
      cursor += 1;
    }
    output[index] = available;
  }
  return output;
}

function regimeEntryGate(request: CashSignalRequest, candles: readonly CashSignalCandle[]) {
  const enabled = numberParam(request, 'regimeFilterEnabled', 0) >= 1;
  if (!enabled) return Array(candles.length).fill(true) as boolean[];
  const baseTimeframeMs = TIMEFRAME_MS[request.timeframe];
  if (!baseTimeframeMs) return Array(candles.length).fill(false) as boolean[];
  const fast1h = Math.max(2, Math.trunc(numberParam(request, 'regimeFastPeriod1h', 12)));
  const slow1h = Math.max(fast1h + 1, Math.trunc(numberParam(request, 'regimeSlowPeriod1h', 26)));
  const fast4h = Math.max(2, Math.trunc(numberParam(request, 'regimeFastPeriod4h', 12)));
  const slow4h = Math.max(fast4h + 1, Math.trunc(numberParam(request, 'regimeSlowPeriod4h', 26)));
  const minimumSlopePercent = numberParam(request, 'minimumTrendSlopePercent', 0);
  const oneHour = completedTrendSeries(candles, baseTimeframeMs, HOUR_MS, fast1h, slow1h);
  const fourHour = completedTrendSeries(candles, baseTimeframeMs, 4 * HOUR_MS, fast4h, slow4h);
  return candles.map((candle, index) => {
    const oneHourState = oneHour[index];
    const fourHourState = fourHour[index];
    return Boolean(oneHourState && fourHourState && oneHourState.bullish && fourHourState.bullish
      && oneHourState.slopePercent >= minimumSlopePercent && fourHourState.slopePercent >= minimumSlopePercent
      && candle.close >= oneHourState.slow && candle.close >= fourHourState.slow);
  });
}

export function calculateCashSignals(request: CashSignalRequest, candles: readonly CashSignalCandle[]): CashSignal[] {
  const closes = candles.map((candle) => candle.close);
  const volumePeriod = Math.max(2, Math.trunc(numberParam(request, 'volumePeriod', 20)));
  const volumeMultiplier = Math.max(0, numberParam(request, 'volumeMultiplier', 1));
  const volumes = averageVolume(candles, volumePeriod);
  const rsiPeriod = Math.max(2, Math.trunc(numberParam(request, 'rsiPeriod', 14)));
  const minimumEntryRsi = Math.max(0, numberParam(request, 'minimumEntryRsi', 0));
  const maximumEntryRsi = Math.min(100, numberParam(request, 'maximumEntryRsi', 100));
  const rsiValues = rsi(closes, rsiPeriod);
  const signals: CashSignal[] = [];
  const entryGate = regimeEntryGate(request, candles);
  const cooldownBars = Math.max(0, Math.trunc(numberParam(request, 'cooldownBars', 0)));
  let lastBuyIndex = Number.NEGATIVE_INFINITY;
  const pushBuy = (index: number) => {
    const rsiValue = rsiValues[index];
    if (!entryGate[index] || rsiValue == null || rsiValue < minimumEntryRsi || rsiValue > maximumEntryRsi || index - lastBuyIndex <= cooldownBars) return;
    signals.push({ index, action: 'BUY' });
    lastBuyIndex = index;
  };

  if (request.strategy === 'regime_breakout_retest') {
    const lookback = Math.max(4, Math.trunc(numberParam(request, 'lookback', 48)));
    const atrPeriod = Math.max(2, Math.trunc(numberParam(request, 'atrPeriod', 14)));
    const minimumBreakoutAtr = Math.max(0, numberParam(request, 'minimumBreakoutAtr', 0.1));
    const maximumBreakoutAtr = Math.max(minimumBreakoutAtr, numberParam(request, 'maximumBreakoutAtr', 1));
    const retestBars = Math.max(1, Math.trunc(numberParam(request, 'retestBars', 12)));
    const retestTolerance = Math.max(0, numberParam(request, 'retestTolerancePercent', 0.25)) / 100;
    const invalidation = Math.max(0, numberParam(request, 'retestInvalidationPercent', 0.5)) / 100;
    const maximumExtension = Math.max(0, numberParam(request, 'maximumExtensionPercent', 0.75)) / 100;
    const atrValues = cashAtrSeries(candles, atrPeriod);
    let pending: { level: number; expiresAt: number } | null = null;
    for (let index = lookback; index < candles.length; index += 1) {
      const previousWindow = candles.slice(index - lookback, index);
      const previousHigh = Math.max(...previousWindow.map((candle) => candle.high));
      const previousLow = Math.min(...previousWindow.map((candle) => candle.low));
      const candle = candles[index];
      const average = volumes[index];
      const atrValue = atrValues[index];
      if (average == null || atrValue == null || atrValue <= 0) continue;

      if (pending) {
        const expired = index > pending.expiresAt;
        const invalidated = candle.close < pending.level * (1 - invalidation);
        if (expired || invalidated) {
          pending = null;
        } else {
          const touched = candle.low <= pending.level * (1 + retestTolerance);
          const reclaimed = candle.close >= pending.level && candle.close > candle.open && candle.close > candles[index - 1].close;
          const extensionOk = candle.close <= pending.level * (1 + maximumExtension);
          const volumeOk = candle.volume >= average * volumeMultiplier;
          if (touched && reclaimed && extensionOk && volumeOk) {
            pushBuy(index);
            pending = null;
          }
        }
      }

      if (!pending && entryGate[index]) {
        const breakoutDistance = candle.close - previousHigh;
        const breakoutRatio = breakoutDistance / atrValue;
        if (breakoutDistance > 0 && breakoutRatio >= minimumBreakoutAtr && breakoutRatio <= maximumBreakoutAtr) {
          pending = { level: previousHigh, expiresAt: index + retestBars };
        }
      }
      if (candle.close < previousLow) signals.push({ index, action: 'SELL' });
    }
  }

  if (request.strategy === 'regime_rsi_reversal') {
    const fastPeriod = Math.max(2, Math.trunc(numberParam(request, 'fastPeriod', 20)));
    const slowPeriod = Math.max(fastPeriod + 1, Math.trunc(numberParam(request, 'slowPeriod', 50)));
    const oversoldRsi = Math.max(0, Math.min(100, numberParam(request, 'oversoldRsi', 40)));
    const recoveryRsi = Math.max(oversoldRsi, Math.min(100, numberParam(request, 'recoveryRsi', 50)));
    const oversoldLookback = Math.max(2, Math.trunc(numberParam(request, 'oversoldLookback', 6)));
    const maximumExtension = Math.max(0, numberParam(request, 'maximumExtensionPercent', 1.5)) / 100;
    const fast = ema(closes, fastPeriod);
    const slow = ema(closes, slowPeriod);
    for (let index = Math.max(2, oversoldLookback); index < candles.length; index += 1) {
      const fastNow = fast[index];
      const slowNow = slow[index];
      const previousRsi = rsiValues[index - 1];
      const currentRsi = rsiValues[index];
      const average = volumes[index];
      if (fastNow == null || slowNow == null || previousRsi == null || currentRsi == null || average == null) continue;
      const recentRsi = rsiValues.slice(index - oversoldLookback, index).filter((value): value is number => value != null);
      const recentOversold = recentRsi.some((value) => value <= oversoldRsi);
      const recovered = previousRsi <= recoveryRsi && currentRsi > recoveryRsi;
      const current = candles[index];
      const previous = candles[index - 1];
      const trendHeld = fastNow > slowNow && current.close >= slowNow;
      const confirmed = current.close > current.open && current.close > previous.high && current.close <= fastNow * (1 + maximumExtension);
      const volumeOk = current.volume >= average * volumeMultiplier;
      if (trendHeld && recentOversold && recovered && confirmed && volumeOk) pushBuy(index);
      if (current.close < slowNow) signals.push({ index, action: 'SELL' });
    }
  }

  if (request.strategy === 'regime_pullback') {
    const fastPeriod = Math.max(2, Math.trunc(numberParam(request, 'fastPeriod', 20)));
    const slowPeriod = Math.max(fastPeriod + 1, Math.trunc(numberParam(request, 'slowPeriod', 50)));
    const tolerance = Math.max(0, numberParam(request, 'pullbackTolerancePercent', 0.25)) / 100;
    const maximumExtension = Math.max(0, numberParam(request, 'maximumExtensionPercent', 0.5)) / 100;
    const fast = ema(closes, fastPeriod);
    const slow = ema(closes, slowPeriod);
    for (let index = 2; index < candles.length; index += 1) {
      const fastNow = fast[index];
      const slowNow = slow[index];
      const fastPrevious = fast[index - 1];
      const slowPrevious = slow[index - 1];
      const average = volumes[index];
      if (fastNow == null || slowNow == null || fastPrevious == null || slowPrevious == null || average == null) continue;
      const previous = candles[index - 1];
      const current = candles[index];
      const trendHeld = fastNow > slowNow && fastPrevious > slowPrevious && previous.close >= slowPrevious;
      const pullbackTouched = previous.low <= fastPrevious * (1 + tolerance);
      const confirmed = current.close > current.open && current.close > previous.high && current.close > fastNow && current.close <= fastNow * (1 + maximumExtension);
      const volumeOk = current.volume >= average * volumeMultiplier;
      if (trendHeld && pullbackTouched && confirmed && volumeOk) pushBuy(index);
      if (current.close < slowNow) signals.push({ index, action: 'SELL' });
    }
  }

  if (request.strategy === 'trend_pullback') {
    const fastPeriod = Math.max(2, Math.trunc(numberParam(request, 'fastPeriod', 20)));
    const slowPeriod = Math.max(fastPeriod + 1, Math.trunc(numberParam(request, 'slowPeriod', 50)));
    const tolerance = Math.max(0, numberParam(request, 'pullbackTolerancePercent', 0.5)) / 100;
    const fast = ema(closes, fastPeriod);
    const slow = ema(closes, slowPeriod);
    for (let index = 1; index < candles.length; index += 1) {
      const fastNow = fast[index];
      const fastPrevious = fast[index - 1];
      const slowNow = slow[index];
      const average = volumes[index];
      if (fastNow == null || fastPrevious == null || slowNow == null || average == null) continue;
      const volumeOk = candles[index].volume >= average * volumeMultiplier;
      if (fastNow > slowNow && candles[index - 1].close <= fastPrevious * (1 + tolerance) && candles[index].close > fastNow && volumeOk) pushBuy(index);
      if (fastNow < slowNow || candles[index].close < fastNow) signals.push({ index, action: 'SELL' });
    }
  }

  if (request.strategy === 'breakout') {
    const lookback = Math.max(2, Math.trunc(numberParam(request, 'lookback', 20)));
    const atrPeriod = Math.max(2, Math.trunc(numberParam(request, 'atrPeriod', 14)));
    const minimumBreakoutAtr = Math.max(0, numberParam(request, 'minimumBreakoutAtr', 0));
    const maximumBreakoutAtr = Math.max(minimumBreakoutAtr, numberParam(request, 'maximumBreakoutAtr', Number.POSITIVE_INFINITY));
    const atrValues = cashAtrSeries(candles, atrPeriod);
    for (let index = lookback; index < candles.length; index += 1) {
      const previous = candles.slice(index - lookback, index);
      const high = Math.max(...previous.map((candle) => candle.high));
      const low = Math.min(...previous.map((candle) => candle.low));
      const average = volumes[index];
      if (average == null) continue;
      const breakoutDistance = candles[index].close - high;
      const atrValue = atrValues[index];
      const breakoutRatio = atrValue != null && atrValue > 0 ? breakoutDistance / atrValue : null;
      const breakoutDistanceOk = minimumBreakoutAtr === 0
        ? maximumBreakoutAtr === Number.POSITIVE_INFINITY || (breakoutRatio != null && breakoutRatio <= maximumBreakoutAtr)
        : breakoutRatio != null && breakoutRatio >= minimumBreakoutAtr && breakoutRatio <= maximumBreakoutAtr;
      if (breakoutDistance > 0 && breakoutDistanceOk && candles[index].volume >= average * volumeMultiplier) pushBuy(index);
      if (candles[index].close < low) signals.push({ index, action: 'SELL' });
    }
  }

  if (request.strategy === 'vwap_reclaim') {
    let cumulativeValue = 0;
    let cumulativeVolume = 0;
    let previousVwap: number | null = null;
    for (let index = 0; index < candles.length; index += 1) {
      const candle = candles[index];
      cumulativeValue += ((candle.high + candle.low + candle.close) / 3) * candle.volume;
      cumulativeVolume += candle.volume;
      const currentVwap = cumulativeVolume > 0 ? cumulativeValue / cumulativeVolume : null;
      const average = volumes[index];
      if (index > 0 && currentVwap != null && previousVwap != null && average != null) {
        if (candles[index - 1].close <= previousVwap && candle.close > currentVwap && candle.volume >= average * volumeMultiplier) pushBuy(index);
        if (candles[index - 1].close >= previousVwap && candle.close < currentVwap) signals.push({ index, action: 'SELL' });
      }
      previousVwap = currentVwap;
    }
  }
  return signals;
}

export function supportsRegimeTimeframe(timeframe: string) {
  return Boolean(TIMEFRAME_MS[timeframe]);
}
