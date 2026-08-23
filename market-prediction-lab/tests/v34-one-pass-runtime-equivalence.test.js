import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  RESEARCH_BACKTEST_PERIOD,
  calculateV1Signal,
  runV1Backtest,
} from "../src/multi-market-backtest-engine.js";
import { summarizeResearchPerformance } from "../src/research-validation-layer.js";
import {
  calculateV3SignalFeatures,
  runV3FilteredBacktest,
} from "../src/v3-market-filter-optimizer.js";
import {
  calculateV4SignalFeatures,
  runV4FilteredBacktest,
} from "../src/v4-momentum-regime-optimizer.js";

const EPSILON = 1e-9;
const RSI_PERIOD = 14;
const MACD_FAST = 12;
const MACD_SLOW = 26;
const MACD_SIGNAL = 9;
const REGIME_EMA_PERIOD = 200;

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function emaSeries(values, period) {
  const result = new Array(values.length).fill(null);
  if (values.length < period) return result;
  const multiplier = 2 / (period + 1);
  let current = mean(values.slice(0, period));
  result[period - 1] = current;
  for (let index = period; index < values.length; index += 1) {
    current = (values[index] - current) * multiplier + current;
    result[index] = current;
  }
  return result;
}

function atrSeries(candles, period) {
  const result = new Array(candles.length).fill(null);
  if (candles.length <= period) return result;
  const trueRanges = new Array(candles.length).fill(null);
  for (let index = 1; index < candles.length; index += 1) {
    const candle = candles[index];
    const previousClose = candles[index - 1].close;
    trueRanges[index] = Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
    if (index >= period) {
      const window = trueRanges.slice(index - period + 1, index + 1);
      if (window.every(Number.isFinite)) result[index] = mean(window);
    }
  }
  return result;
}

function rsiSeries(values, period = RSI_PERIOD) {
  const result = new Array(values.length).fill(null);
  if (values.length <= period) return result;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const delta = values[index] - values[index - 1];
    gains += Math.max(delta, 0);
    losses += Math.max(-delta, 0);
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  const resolve = () => averageLoss === 0 ? (averageGain === 0 ? 50 : 100) : 100 - (100 / (1 + averageGain / averageLoss));
  result[period] = resolve();
  for (let index = period + 1; index < values.length; index += 1) {
    const delta = values[index] - values[index - 1];
    averageGain = ((averageGain * (period - 1)) + Math.max(delta, 0)) / period;
    averageLoss = ((averageLoss * (period - 1)) + Math.max(-delta, 0)) / period;
    result[index] = resolve();
  }
  return result;
}

function macdHistogramSeries(values) {
  const fast = emaSeries(values, MACD_FAST);
  const slow = emaSeries(values, MACD_SLOW);
  const macd = new Array(values.length).fill(null);
  for (let index = MACD_SLOW - 1; index < values.length; index += 1) {
    if (Number.isFinite(fast[index]) && Number.isFinite(slow[index])) macd[index] = fast[index] - slow[index];
  }
  const available = [];
  const indexes = [];
  for (let index = 0; index < macd.length; index += 1) {
    if (Number.isFinite(macd[index])) {
      available.push(macd[index]);
      indexes.push(index);
    }
  }
  const signalCompact = emaSeries(available, MACD_SIGNAL);
  const histogram = new Array(values.length).fill(null);
  for (let compactIndex = 0; compactIndex < indexes.length; compactIndex += 1) {
    const fullIndex = indexes[compactIndex];
    if (Number.isFinite(signalCompact[compactIndex])) histogram[fullIndex] = macd[fullIndex] - signalCompact[compactIndex];
  }
  return histogram;
}

function buildV3Indicators(candles, parameters) {
  const closes = candles.map((candle) => candle.close);
  return Object.freeze({
    fast: Object.freeze(emaSeries(closes, parameters.fastPeriod)),
    slow: Object.freeze(emaSeries(closes, parameters.slowPeriod)),
    atr: Object.freeze(atrSeries(candles, parameters.atrPeriod)),
  });
}

function buildV4Indicators(candles, parameters) {
  const closes = candles.map((candle) => candle.close);
  return Object.freeze({
    fast: Object.freeze(emaSeries(closes, parameters.fastPeriod)),
    slow: Object.freeze(emaSeries(closes, parameters.slowPeriod)),
    atr: Object.freeze(atrSeries(candles, parameters.atrPeriod)),
    regime: Object.freeze(emaSeries(closes, REGIME_EMA_PERIOD)),
    rsi: Object.freeze(rsiSeries(closes)),
    macdHistogram: Object.freeze(macdHistogramSeries(closes)),
  });
}

function passesV3(features, filter) {
  return features !== null
    && features.rvol + EPSILON >= filter.rvolMin
    && features.volumeExpansion + EPSILON >= filter.volumeExpansionMin
    && features.trendStrength + EPSILON >= filter.trendStrengthMin;
}

function passesV4(features, filter) {
  if (!features) return false;
  if (filter.requireRegimeAlignment && !features.regimeAligned) return false;
  if (features.emaSlopeAtr + EPSILON < filter.emaSlopeAtrMin) return false;
  if (features.directionalRsi + EPSILON < filter.rsiDirectionalThreshold) return false;
  if (features.directionalMacd <= EPSILON) return false;
  if (filter.macdMode === "accelerating" && features.macdAcceleration <= EPSILON) return false;
  return true;
}

function firstIndexAfter(candles, timestamp, startIndex) {
  let index = Math.max(0, startIndex);
  while (index < candles.length && candles[index].timestamp <= timestamp) index += 1;
  return index;
}

function compactPerformance(performance, initialCapital) {
  const overall = performance.overall;
  return Object.freeze({
    returnPercent: overall.totalReturn * 100,
    successRatePercent: overall.winRate * 100,
    profitFactor: overall.profitFactor,
    maximumDrawdownPercent: overall.maximumDrawdownPercent * 100,
    expectancy: overall.expectancy,
    trades: overall.sampleCount,
    finalCapital: initialCapital + overall.netPnl,
  });
}

function legacyFilteredBacktest({
  backtestInput,
  parameters,
  filter,
  period,
  version,
  strategy,
  indicators,
  featureAt,
  passes,
}) {
  const candles = [...backtestInput.candles]
    .filter((candle) => candle.timestamp <= period.endTime)
    .sort((left, right) => left.timestamp - right.timestamp);
  const initialCapital = backtestInput.initialCapital ?? RESEARCH_BACKTEST_PERIOD.initialCapital;
  const trades = [];
  let equity = initialCapital;
  let index = 1;

  while (index < candles.length - 1 && equity > 0) {
    const candle = candles[index];
    if (candle.timestamp < period.startTime) {
      index += 1;
      continue;
    }
    const side = backtestInput.side ?? "long";
    const baseSignal = calculateV1Signal({
      market: backtestInput.market,
      side,
      candles,
      indicators,
      index,
      parameters,
    });
    if (!baseSignal || !passes(featureAt({ side, candles, indicators, index }), filter)) {
      index += 1;
      continue;
    }
    const continuation = runV1Backtest({
      ...backtestInput,
      candles,
      parameters,
      initialCapital: equity,
      period: Object.freeze({
        startTime: candle.timestamp,
        endTime: period.endTime,
        includeFinalHoldout: false,
      }),
    });
    const trade = continuation.trades[0];
    assert.ok(trade, `${version} legacy fixture must produce a continuation trade`);
    assert.equal(trade.signalTime, candle.timestamp);
    const versionTrade = Object.freeze({
      ...trade,
      strategy,
      strategyVersion: version,
      entryFilter: filter,
    });
    trades.push(versionTrade);
    equity = versionTrade.equityAfter;
    index = firstIndexAfter(candles, versionTrade.exitTime, index + 1);
  }

  const performance = summarizeResearchPerformance(trades, { initialCapital });
  const metrics = compactPerformance(performance, initialCapital);
  const safeguards = version === "V3"
    ? Object.freeze({
      baseSignalReusesV1Logic: true,
      executionReusesV1Engine: true,
      filterUsesClosedSignalAndPastVolumeOnly: true,
      finalHoldoutUsedForSelection: false,
      orderSubmitted: false,
      privateAccountRequestAllowed: false,
    })
    : Object.freeze({
      baseSignalReusesV1Logic: true,
      executionReusesV1Engine: true,
      regimeUsesEma200AndPastSlopeOnly: true,
      momentumUsesClosedRsiAndMacdOnly: true,
      finalHoldoutUsedForSelection: false,
      orderSubmitted: false,
      privateAccountRequestAllowed: false,
    });
  return Object.freeze({
    ok: true,
    mode: "backtest-only",
    strategy,
    strategyVersion: version,
    market: backtestInput.market,
    symbol: backtestInput.symbol,
    side: backtestInput.side ?? "long",
    timeframe: backtestInput.timeframe,
    parameters: Object.freeze({ ...parameters }),
    filter,
    period: Object.freeze({ ...period, finalHoldoutLocked: true }),
    initialCapital,
    finalCapital: metrics.finalCapital,
    totalReturnPercent: metrics.returnPercent,
    successRatePercent: metrics.successRatePercent,
    profitFactor: metrics.profitFactor,
    maximumDrawdownPercent: metrics.maximumDrawdownPercent,
    expectancy: metrics.expectancy,
    totalTrades: metrics.trades,
    trades: Object.freeze(trades),
    performance,
    safeguards,
  });
}

function buildTrendCandles({ direction, count = 1200 }) {
  const start = Date.UTC(2024, 0, 1);
  const step = 15 * 60 * 1000;
  let anchor = direction > 0 ? 100 : 260;
  const candles = [];
  for (let index = 0; index < count; index += 1) {
    anchor += direction * 0.14;
    const phase = index % 32;
    let close = anchor;
    if (phase === 24) close -= direction * 2.2;
    if (phase === 25) close += direction * 1.15;
    const previousClose = candles.at(-1)?.close ?? close;
    const open = previousClose + direction * 0.025;
    const high = Math.max(open, close) + 0.85;
    const low = Math.min(open, close) - 0.85;
    const volume = 1100 + (index % 13) * 35 + (phase === 25 ? 800 : 0);
    candles.push(Object.freeze({
      timestamp: start + index * step,
      isClosed: true,
      open,
      high,
      low,
      close,
      volume,
    }));
  }
  return Object.freeze(candles);
}

const PARAMETERS = Object.freeze({
  fastPeriod: 5,
  slowPeriod: 15,
  atrPeriod: 5,
  pullbackTolerancePct: 1,
  stopAtrMultiple: 1,
  targetRiskMultiple: 1.5,
});

function periodFor(candles) {
  return Object.freeze({
    startTime: candles[220].timestamp,
    endTime: candles.at(-1).timestamp,
    includeFinalHoldout: false,
  });
}

function commonInput({ market, side, candles, leverage, quantityStep, fundingRates = [] }) {
  return Object.freeze({
    market,
    side,
    symbol: "BTCUSDT",
    timeframe: "15m",
    candles,
    initialCapital: 1_000_000,
    riskModel: Object.freeze({
      riskPerTrade: 0.01,
      maximumCapitalFraction: 0.75,
      leverage,
      quantityStep,
    }),
    costModel: Object.freeze({
      entryFeeRate: 0.0004,
      exitFeeRate: 0.0004,
      slippageRate: 0.00025,
      spreadRate: 0.00015,
      latencyBars: 1,
      latencyDriftRate: 0.00005,
    }),
    fundingRates,
  });
}

test("V3 one-pass runtime is fully identical to the legacy suffix-V1 execution sequence", () => {
  const candles = buildTrendCandles({ direction: 1 });
  const filter = Object.freeze({ rvolMin: 0.8, volumeExpansionMin: 0.8, trendStrengthMin: 0.05 });
  const period = periodFor(candles);
  const backtestInput = commonInput({
    market: "CRYPTO_SPOT",
    side: "long",
    candles,
    leverage: 1,
    quantityStep: 0.0001,
  });
  const indicators = buildV3Indicators(candles, PARAMETERS);
  const legacy = legacyFilteredBacktest({
    backtestInput,
    parameters: PARAMETERS,
    filter,
    period,
    version: "V3",
    strategy: "v3_ema_atr_volume_trend",
    indicators,
    featureAt: ({ candles: rows, indicators: built, index }) => calculateV3SignalFeatures({ candles: rows, indicators: built, index }),
    passes: passesV3,
  });
  const onePass = runV3FilteredBacktest({ backtestInput, parameters: PARAMETERS, filter, period });
  assert.ok(legacy.totalTrades > 0);
  assert.deepEqual(onePass, legacy);
});

test("V4 one-pass runtime is fully identical to legacy futures-short execution including funding", () => {
  const candles = buildTrendCandles({ direction: -1 });
  const fundingRates = candles
    .filter((_, index) => index > 220 && index % 24 === 0)
    .map((candle, index) => Object.freeze({ timestamp: candle.timestamp, rate: index % 2 === 0 ? 0.0001 : -0.00005 }));
  const filter = Object.freeze({
    requireRegimeAlignment: false,
    emaSlopeAtrMin: 0,
    rsiDirectionalThreshold: 50,
    macdMode: "directional",
  });
  const period = periodFor(candles);
  const backtestInput = commonInput({
    market: "CRYPTO_FUTURES",
    side: "short",
    candles,
    leverage: 3,
    quantityStep: 0.001,
    fundingRates,
  });
  const indicators = buildV4Indicators(candles, PARAMETERS);
  const legacy = legacyFilteredBacktest({
    backtestInput,
    parameters: PARAMETERS,
    filter,
    period,
    version: "V4",
    strategy: "v4_ema_atr_regime_momentum",
    indicators,
    featureAt: ({ side, candles: rows, indicators: built, index }) => calculateV4SignalFeatures({ side, candles: rows, indicators: built, index }),
    passes: passesV4,
  });
  const onePass = runV4FilteredBacktest({ backtestInput, parameters: PARAMETERS, filter, period });
  assert.ok(legacy.totalTrades > 0);
  assert.deepEqual(onePass, legacy);
});

test("V3/V4 source performs at most one canonical suffix V1 verification per stage", async () => {
  for (const relativePath of [
    "../src/v3-market-filter-optimizer.js",
    "../src/v4-momentum-regime-optimizer.js",
  ]) {
    const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
    const runtimeStart = source.indexOf("export function runV");
    const optimizerStart = source.indexOf("\nfunction candidateRecord", runtimeStart);
    const runtime = source.slice(runtimeStart, optimizerStart);
    assert.equal((runtime.match(/runV1Backtest\s*\(/gu) ?? []).length, 1);
    assert.equal((runtime.match(/runIndependentSignalBacktest\s*\(/gu) ?? []).length, 1);
    assert.doesNotMatch(runtime, /while\s*\(index\s*<\s*candles\.length/u);
  }
});
