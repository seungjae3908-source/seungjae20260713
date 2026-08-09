import { clamp, round } from "./contracts.js";

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values) {
  const avg = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - avg) ** 2)));
}

function latestSlice(values, period) {
  if (values.length < period) throw new RangeError(`not enough values for period ${period}`);
  return values.slice(values.length - period);
}

export function sma(values, period) {
  return mean(latestSlice(values, period));
}

export function ema(values, period) {
  if (values.length < period) throw new RangeError(`not enough values for period ${period}`);
  const multiplier = 2 / (period + 1);
  let current = mean(values.slice(0, period));
  for (let i = period; i < values.length; i += 1) {
    current = (values[i] - current) * multiplier + current;
  }
  return current;
}

export function rsi(values, period = 14) {
  if (values.length <= period) throw new RangeError(`not enough values for RSI ${period}`);
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const delta = values[i] - values[i - 1];
    gains += Math.max(delta, 0);
    losses += Math.max(-delta, 0);
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  for (let i = period + 1; i < values.length; i += 1) {
    const delta = values[i] - values[i - 1];
    averageGain = ((averageGain * (period - 1)) + Math.max(delta, 0)) / period;
    averageLoss = ((averageLoss * (period - 1)) + Math.max(-delta, 0)) / period;
  }
  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
  const relativeStrength = averageGain / averageLoss;
  return 100 - (100 / (1 + relativeStrength));
}

export function atr(candles, period = 14) {
  if (candles.length <= period) throw new RangeError(`not enough candles for ATR ${period}`);
  const trueRanges = [];
  for (let i = 1; i < candles.length; i += 1) {
    const current = candles[i];
    const previousClose = candles[i - 1].close;
    trueRanges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previousClose),
      Math.abs(current.low - previousClose),
    ));
  }
  return mean(latestSlice(trueRanges, period));
}

function emaSeries(values, period) {
  if (values.length < period) throw new RangeError(`not enough values for EMA ${period}`);
  const result = new Array(period - 1).fill(null);
  const multiplier = 2 / (period + 1);
  let current = mean(values.slice(0, period));
  result.push(current);
  for (let i = period; i < values.length; i += 1) {
    current = (values[i] - current) * multiplier + current;
    result.push(current);
  }
  return result;
}

export function macd(values, fast = 12, slow = 26, signal = 9) {
  if (values.length < slow + signal) throw new RangeError("not enough values for MACD");
  const fastSeries = emaSeries(values, fast);
  const slowSeries = emaSeries(values, slow);
  const macdSeries = [];
  for (let i = slow - 1; i < values.length; i += 1) {
    macdSeries.push(fastSeries[i] - slowSeries[i]);
  }
  const signalValue = ema(macdSeries, signal);
  const macdValue = macdSeries.at(-1);
  return {
    macd: macdValue,
    signal: signalValue,
    histogram: macdValue - signalValue,
  };
}

export function bollinger(values, period = 20, deviations = 2) {
  const recent = latestSlice(values, period);
  const middle = mean(recent);
  const deviation = standardDeviation(recent);
  return {
    middle,
    upper: middle + (deviation * deviations),
    lower: middle - (deviation * deviations),
  };
}

function linearSlope(values) {
  const n = values.length;
  const xMean = (n - 1) / 2;
  const yMean = mean(values);
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i += 1) {
    numerator += (i - xMean) * (values[i] - yMean);
    denominator += (i - xMean) ** 2;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

function safeReturn(current, previous) {
  return previous === 0 ? 0 : (current / previous) - 1;
}

function finiteFeature(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

export function calculateFeatures(input) {
  const { candles, marketFeatures, derivativesFeatures } = input;
  const closes = candles.map((candle) => candle.close);
  const volumes = candles.map((candle) => candle.volume);
  const latest = candles.at(-1);
  const latestClose = latest.close;
  const ema20 = ema(closes, 20);
  const ema60 = ema(closes, 60);
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(candles, 14);
  const macdValues = macd(closes);
  const bands = bollinger(closes, 20, 2);
  const recent50 = candles.slice(-50);
  const support = Math.min(...recent50.map((candle) => candle.low));
  const resistance = Math.max(...recent50.map((candle) => candle.high));
  const averageVolume20 = sma(volumes, 20);
  const trendWindow = closes.slice(-20).map((value) => value / latestClose);

  const features = {
    return1: safeReturn(latestClose, closes.at(-2)),
    return5: safeReturn(latestClose, closes.at(-6)),
    return20: safeReturn(latestClose, closes.at(-21)),
    emaGap: (ema20 - ema60) / latestClose,
    closeToEma20: (latestClose - ema20) / latestClose,
    rsiCentered: (rsi14 - 50) / 50,
    macdHistogramPct: macdValues.histogram / latestClose,
    atrPct: atr14 / latestClose,
    volumeRatio: averageVolume20 > 0 ? latest.volume / averageVolume20 : 1,
    trendSlope: linearSlope(trendWindow),
    distanceToSupport: (latestClose - support) / latestClose,
    distanceToResistance: (resistance - latestClose) / latestClose,
    bollingerPosition: bands.upper === bands.lower
      ? 0.5
      : clamp((latestClose - bands.lower) / (bands.upper - bands.lower), 0, 1),
    breadth: clamp(marketFeatures.breadth ?? 0, -1, 1),
    benchmarkReturn: clamp(marketFeatures.benchmarkReturn ?? 0, -0.2, 0.2),
    sentimentScore: clamp(marketFeatures.sentimentScore ?? 0, -1, 1),
    foreignNetRatio: clamp(marketFeatures.foreignNetRatio ?? 0, -1, 1),
    institutionNetRatio: clamp(marketFeatures.institutionNetRatio ?? 0, -1, 1),
    openInterestChange: clamp(derivativesFeatures.openInterestChange ?? 0, -1, 1),
    fundingRate: clamp(derivativesFeatures.fundingRate ?? 0, -0.05, 0.05),
    fundingRateChange: clamp(derivativesFeatures.fundingRateChange ?? 0, -0.05, 0.05),
    fundingRateZScore: clamp(derivativesFeatures.fundingRateZScore ?? 0, -8, 8),
    longShortBias: clamp((derivativesFeatures.longShortRatio ?? 1) - 1, -2, 2),
    basisRate: clamp(derivativesFeatures.basisRate ?? 0, -0.2, 0.2),
    markPremium: clamp(derivativesFeatures.markPremium ?? 0, -0.2, 0.2),
    marketMarkSpread: clamp(derivativesFeatures.marketMarkSpread ?? 0, -0.2, 0.2),
  };

  for (const [key, value] of Object.entries(features)) {
    features[key] = round(finiteFeature(value), 8);
  }

  return Object.freeze({
    features: Object.freeze(features),
    indicators: Object.freeze({
      latestClose: round(latestClose, 8),
      ema20: round(ema20, 8),
      ema60: round(ema60, 8),
      rsi14: round(rsi14, 4),
      atr14: round(atr14, 8),
      atrPct: round(atr14 / latestClose, 8),
      macd: round(macdValues.macd, 8),
      macdSignal: round(macdValues.signal, 8),
      macdHistogram: round(macdValues.histogram, 8),
      bollingerUpper: round(bands.upper, 8),
      bollingerMiddle: round(bands.middle, 8),
      bollingerLower: round(bands.lower, 8),
      support: round(support, 8),
      resistance: round(resistance, 8),
      averageVolume20: round(averageVolume20, 4),
      volumeRatio: round(features.volumeRatio, 4),
    }),
  });
}
