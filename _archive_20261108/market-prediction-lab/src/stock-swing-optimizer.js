import { PredictionInputError } from "./contracts.js";

function finitePositive(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new PredictionInputError(`${name} must be a positive finite number`, { name, value });
  }
  return value;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function stddev(values) {
  if (values.length < 2) return null;
  const avg = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(Math.max(0, variance));
}

function validateCandle(raw, index, previousTimestamp) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PredictionInputError(`candles[${index}] must be an object`);
  }
  const timestamp = Number(raw.timestamp);
  if (!Number.isInteger(timestamp) || timestamp <= 0 || (previousTimestamp != null && timestamp <= previousTimestamp)) {
    throw new PredictionInputError("candles must have strictly increasing positive millisecond timestamps", { index, timestamp });
  }
  const open = finitePositive(Number(raw.open), `candles[${index}].open`);
  const high = finitePositive(Number(raw.high), `candles[${index}].high`);
  const low = finitePositive(Number(raw.low), `candles[${index}].low`);
  const close = finitePositive(Number(raw.close), `candles[${index}].close`);
  const volume = Number(raw.volume);
  if (!Number.isFinite(volume) || volume < 0) throw new PredictionInputError(`candles[${index}].volume must be non-negative`);
  if (high < Math.max(open, close) || low > Math.min(open, close) || high < low) {
    throw new PredictionInputError(`candles[${index}] has inconsistent OHLC`);
  }
  return Object.freeze({ timestamp, open, high, low, close, volume });
}

export function normalizeOptimizerCandles(rawCandles) {
  if (!Array.isArray(rawCandles) || rawCandles.length < 80) {
    throw new PredictionInputError("at least 80 candles are required for stock optimizer");
  }
  const result = [];
  let previousTimestamp = null;
  for (let index = 0; index < rawCandles.length; index += 1) {
    const candle = validateCandle(rawCandles[index], index, previousTimestamp);
    result.push(candle);
    previousTimestamp = candle.timestamp;
  }
  return Object.freeze(result);
}

function simpleMovingAverage(candles, endIndex, period) {
  const start = endIndex - period + 1;
  if (start < 0) return null;
  let total = 0;
  for (let index = start; index <= endIndex; index += 1) total += candles[index].close;
  return total / period;
}

function averageVolumeBefore(candles, index, period) {
  const start = index - period;
  if (start < 0) return null;
  let total = 0;
  for (let cursor = start; cursor < index; cursor += 1) total += candles[cursor].volume;
  return total / period;
}

function highestHighBefore(candles, index, period) {
  const start = index - period;
  if (start < 0) return null;
  let highest = -Infinity;
  for (let cursor = start; cursor < index; cursor += 1) highest = Math.max(highest, candles[cursor].high);
  return Number.isFinite(highest) ? highest : null;
}

function trueRange(candle, previousClose) {
  return Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - previousClose),
    Math.abs(candle.low - previousClose),
  );
}

function atr(candles, endIndex, period) {
  if (endIndex < period) return null;
  let total = 0;
  for (let index = endIndex - period + 1; index <= endIndex; index += 1) {
    if (index <= 0) return null;
    total += trueRange(candles[index], candles[index - 1].close);
  }
  return total / period;
}

function validateParams(raw = {}) {
  const params = {
    breakoutLookback: Number(raw.breakoutLookback ?? 20),
    maPeriod: Number(raw.maPeriod ?? 60),
    atrPeriod: Number(raw.atrPeriod ?? 14),
    atrStopMultiplier: Number(raw.atrStopMultiplier ?? 2),
    rewardRisk: Number(raw.rewardRisk ?? 2),
    maxHoldBars: Number(raw.maxHoldBars ?? 10),
    relativeVolumePeriod: Number(raw.relativeVolumePeriod ?? 20),
    minRelativeVolume: Number(raw.minRelativeVolume ?? 1.1),
    maxGapPercent: Number(raw.maxGapPercent ?? 6),
  };
  for (const name of ["breakoutLookback", "maPeriod", "atrPeriod", "maxHoldBars", "relativeVolumePeriod"]) {
    if (!Number.isInteger(params[name]) || params[name] < 2 || params[name] > 250) {
      throw new PredictionInputError(`${name} must be an integer between 2 and 250`, { value: params[name] });
    }
  }
  for (const name of ["atrStopMultiplier", "rewardRisk", "minRelativeVolume"]) finitePositive(params[name], name);
  if (!Number.isFinite(params.maxGapPercent) || params.maxGapPercent < 0 || params.maxGapPercent > 50) {
    throw new PredictionInputError("maxGapPercent must be between 0 and 50");
  }
  return Object.freeze(params);
}

function validateCostRate(value) {
  const rate = Number(value ?? 0.002);
  if (!Number.isFinite(rate) || rate < 0 || rate >= 0.05) {
    throw new PredictionInputError("costRatePerSide must be between 0 and 0.05", { value });
  }
  return rate;
}

function maxDrawdown(equityCurve) {
  let peak = 1;
  let maximum = 0;
  for (const equity of equityCurve) {
    peak = Math.max(peak, equity);
    if (peak > 0) maximum = Math.max(maximum, (peak - equity) / peak);
  }
  return maximum;
}

function summarizeTrades(trades) {
  const returns = trades.map((trade) => trade.netReturn);
  const wins = returns.filter((value) => value > 0);
  const losses = returns.filter((value) => value < 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  let equity = 1;
  const equityCurve = [];
  for (const value of returns) {
    equity *= Math.max(0.000001, 1 + value);
    equityCurve.push(equity);
  }
  const deviation = stddev(returns);
  const expectancy = mean(returns) ?? 0;
  return Object.freeze({
    tradeCount: trades.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    netReturn: equity - 1,
    expectancy,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Number.POSITIVE_INFINITY : 0,
    maxDrawdown: maxDrawdown(equityCurve),
    sharpeLike: deviation != null && deviation > 0 ? expectancy / deviation * Math.sqrt(trades.length) : 0,
    averageHoldBars: trades.length ? trades.reduce((sum, trade) => sum + trade.holdBars, 0) / trades.length : 0,
  });
}

export function simulateStockSwingStrategy(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PredictionInputError("simulation input must be an object");
  const candles = normalizeOptimizerCandles(raw.candles);
  const params = validateParams(raw.params);
  const costRatePerSide = validateCostRate(raw.costRatePerSide);
  const warmup = Math.max(params.breakoutLookback, params.maPeriod, params.atrPeriod, params.relativeVolumePeriod) + 1;
  const startIndex = Math.max(warmup, Number.isInteger(raw.startIndex) ? raw.startIndex : warmup);
  const endIndex = Math.min(candles.length - 1, Number.isInteger(raw.endIndex) ? raw.endIndex : candles.length - 1);
  if (endIndex <= startIndex + 1) return Object.freeze({ params, costRatePerSide, trades: Object.freeze([]), metrics: summarizeTrades([]) });

  const trades = [];
  let signalIndex = startIndex;
  while (signalIndex < endIndex) {
    const signal = candles[signalIndex];
    const resistance = highestHighBefore(candles, signalIndex, params.breakoutLookback);
    const ma = simpleMovingAverage(candles, signalIndex, params.maPeriod);
    const signalAtr = atr(candles, signalIndex, params.atrPeriod);
    const baselineVolume = averageVolumeBefore(candles, signalIndex, params.relativeVolumePeriod);
    const relativeVolume = baselineVolume != null && baselineVolume > 0 ? signal.volume / baselineVolume : null;
    const qualifies = resistance != null
      && ma != null
      && signalAtr != null
      && signalAtr > 0
      && relativeVolume != null
      && signal.close > resistance
      && signal.close > ma
      && relativeVolume >= params.minRelativeVolume;
    if (!qualifies) {
      signalIndex += 1;
      continue;
    }

    const entryIndex = signalIndex + 1;
    if (entryIndex > endIndex) break;
    const entryCandle = candles[entryIndex];
    const gapPercent = Math.abs(entryCandle.open / signal.close - 1) * 100;
    if (gapPercent > params.maxGapPercent) {
      signalIndex += 1;
      continue;
    }
    const entryPrice = entryCandle.open * (1 + costRatePerSide);
    const stopDistance = signalAtr * params.atrStopMultiplier;
    const stopPrice = entryCandle.open - stopDistance;
    const targetPrice = entryCandle.open + stopDistance * params.rewardRisk;
    if (!(stopPrice > 0) || !(targetPrice > entryCandle.open)) {
      signalIndex += 1;
      continue;
    }

    const lastExitIndex = Math.min(endIndex, entryIndex + params.maxHoldBars - 1);
    let exitIndex = lastExitIndex;
    let rawExitPrice = candles[lastExitIndex].close;
    let exitReason = "time";
    for (let index = entryIndex; index <= lastExitIndex; index += 1) {
      const candle = candles[index];
      const stopTouched = candle.low <= stopPrice;
      const targetTouched = candle.high >= targetPrice;
      if (stopTouched && targetTouched) {
        exitIndex = index;
        rawExitPrice = stopPrice;
        exitReason = "stop_same_bar_conservative";
        break;
      }
      if (stopTouched) {
        exitIndex = index;
        rawExitPrice = stopPrice;
        exitReason = "stop";
        break;
      }
      if (targetTouched) {
        exitIndex = index;
        rawExitPrice = targetPrice;
        exitReason = "target";
        break;
      }
    }
    const exitPrice = rawExitPrice * (1 - costRatePerSide);
    const netReturn = exitPrice / entryPrice - 1;
    trades.push(Object.freeze({
      signalIndex,
      entryIndex,
      exitIndex,
      signalTimestamp: signal.timestamp,
      entryTimestamp: entryCandle.timestamp,
      exitTimestamp: candles[exitIndex].timestamp,
      signalClose: signal.close,
      entryOpen: entryCandle.open,
      entryPrice,
      exitPrice,
      stopPrice,
      targetPrice,
      relativeVolume,
      gapPercent,
      holdBars: exitIndex - entryIndex + 1,
      exitReason,
      netReturn,
    }));
    signalIndex = exitIndex + 1;
  }

  return Object.freeze({
    params,
    costRatePerSide,
    trades: Object.freeze(trades),
    metrics: summarizeTrades(trades),
  });
}

export function buildStockOosSegments(candleCount, raw = {}) {
  if (!Number.isInteger(candleCount) || candleCount < 300) throw new PredictionInputError("candleCount must be at least 300");
  const trainRatio = Number(raw.trainRatio ?? 0.6);
  const validationRatio = Number(raw.validationRatio ?? 0.2);
  if (!(trainRatio > 0.4 && trainRatio < 0.8) || !(validationRatio > 0.1 && validationRatio < 0.3) || trainRatio + validationRatio >= 0.9) {
    throw new PredictionInputError("invalid stock OOS split ratios");
  }
  const trainEnd = Math.floor(candleCount * trainRatio) - 1;
  const validationEnd = Math.floor(candleCount * (trainRatio + validationRatio)) - 1;
  return Object.freeze({
    train: Object.freeze({ startIndex: 0, endIndex: trainEnd }),
    validation: Object.freeze({ startIndex: trainEnd + 1, endIndex: validationEnd }),
    test: Object.freeze({ startIndex: validationEnd + 1, endIndex: candleCount - 1 }),
  });
}

function aggregateDatasetResults(results) {
  const allTrades = results.flatMap((item) => item.simulation.trades.map((trade) => ({ ...trade, symbol: item.symbol })));
  const metrics = summarizeTrades(allTrades);
  const positiveSymbols = results.filter((item) => item.simulation.metrics.expectancy > 0 && item.simulation.metrics.profitFactor > 1).length;
  return Object.freeze({
    metrics,
    positiveSymbols,
    symbolCount: results.length,
    perSymbol: Object.fromEntries(results.map((item) => [item.symbol, item.simulation.metrics])),
  });
}

function objective(summary) {
  const { metrics, positiveSymbols, symbolCount } = summary;
  if (metrics.tradeCount < Math.max(8, symbolCount * 3)) return -1_000;
  const profitFactor = Number.isFinite(metrics.profitFactor) ? Math.min(metrics.profitFactor, 5) : 5;
  return metrics.expectancy * 100
    + metrics.netReturn * 8
    + (profitFactor - 1) * 2
    + metrics.sharpeLike * 0.25
    + (positiveSymbols / Math.max(1, symbolCount)) * 2
    - metrics.maxDrawdown * 8;
}

function passResearchGate(summary, minimumTrades) {
  const { metrics, positiveSymbols, symbolCount } = summary;
  return metrics.tradeCount >= minimumTrades
    && metrics.expectancy > 0
    && metrics.profitFactor >= 1.05
    && metrics.maxDrawdown <= 0.30
    && positiveSymbols >= Math.ceil(symbolCount * 2 / 3);
}

export function expandStockParameterGrid(raw = {}) {
  const values = {
    breakoutLookback: raw.breakoutLookback ?? [10, 20, 40],
    maPeriod: raw.maPeriod ?? [20, 60, 120],
    atrStopMultiplier: raw.atrStopMultiplier ?? [1.5, 2, 2.5],
    rewardRisk: raw.rewardRisk ?? [1.5, 2, 2.5],
    maxHoldBars: raw.maxHoldBars ?? [5, 10, 20],
    minRelativeVolume: raw.minRelativeVolume ?? [0.9, 1.1, 1.3],
    maxGapPercent: raw.maxGapPercent ?? [4, 7],
  };
  const result = [];
  for (const breakoutLookback of values.breakoutLookback)
    for (const maPeriod of values.maPeriod)
      for (const atrStopMultiplier of values.atrStopMultiplier)
        for (const rewardRisk of values.rewardRisk)
          for (const maxHoldBars of values.maxHoldBars)
            for (const minRelativeVolume of values.minRelativeVolume)
              for (const maxGapPercent of values.maxGapPercent) {
                result.push(Object.freeze({
                  breakoutLookback,
                  maPeriod,
                  atrPeriod: 14,
                  atrStopMultiplier,
                  rewardRisk,
                  maxHoldBars,
                  relativeVolumePeriod: 20,
                  minRelativeVolume,
                  maxGapPercent,
                }));
              }
  return Object.freeze(result);
}

function evaluateAcrossDatasets(datasets, params, segmentName, costRatePerSide, costMultiplier = 1) {
  const results = datasets.map((dataset) => {
    const candles = normalizeOptimizerCandles(dataset.candles);
    const segments = buildStockOosSegments(candles.length);
    const segment = segments[segmentName];
    return {
      symbol: dataset.symbol,
      simulation: simulateStockSwingStrategy({
        candles,
        params,
        costRatePerSide: costRatePerSide * costMultiplier,
        startIndex: segment.startIndex,
        endIndex: segment.endIndex,
      }),
    };
  });
  return aggregateDatasetResults(results);
}

export function optimizeStockSwingMarket(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PredictionInputError("optimizer input must be an object");
  const market = raw.market;
  if (market !== "KR_STOCK" && market !== "US_STOCK") throw new PredictionInputError("market must be KR_STOCK or US_STOCK");
  if (!Array.isArray(raw.datasets) || raw.datasets.length < 2) throw new PredictionInputError("at least two stock datasets are required");
  const seen = new Set();
  const datasets = raw.datasets.map((dataset, index) => {
    const symbol = String(dataset?.symbol ?? "").trim().toUpperCase();
    if (!symbol || seen.has(symbol)) throw new PredictionInputError("stock optimizer symbols must be non-empty and unique", { index, symbol });
    seen.add(symbol);
    return Object.freeze({ symbol, candles: normalizeOptimizerCandles(dataset.candles) });
  });
  const costRatePerSide = validateCostRate(raw.costRatePerSide);
  const stressMultiplier = Number(raw.stressMultiplier ?? 1.5);
  if (!Number.isFinite(stressMultiplier) || stressMultiplier < 1 || stressMultiplier > 3) throw new PredictionInputError("stressMultiplier must be between 1 and 3");
  const grid = raw.grid ? expandStockParameterGrid(raw.grid) : expandStockParameterGrid();
  if (!grid.length || grid.length > 5_000) throw new PredictionInputError("stock optimizer grid must contain between 1 and 5000 candidates");

  const trained = grid.map((params) => ({
    params,
    train: evaluateAcrossDatasets(datasets, params, "train", costRatePerSide),
  })).sort((left, right) => objective(right.train) - objective(left.train));
  const finalists = trained.slice(0, Math.min(20, trained.length)).map((candidate) => ({
    ...candidate,
    validation: evaluateAcrossDatasets(datasets, candidate.params, "validation", costRatePerSide),
  })).sort((left, right) => objective(right.validation) - objective(left.validation));
  const selected = finalists.find((candidate) => passResearchGate(candidate.validation, Math.max(8, datasets.length * 3))) ?? finalists[0];
  if (!selected) throw new PredictionInputError("stock optimizer could not select a candidate");

  const test = evaluateAcrossDatasets(datasets, selected.params, "test", costRatePerSide);
  const stressedTest = evaluateAcrossDatasets(datasets, selected.params, "test", costRatePerSide, stressMultiplier);
  const validationPassed = passResearchGate(selected.validation, Math.max(8, datasets.length * 3));
  const testPassed = passResearchGate(test, Math.max(8, datasets.length * 3));
  const stressPassed = passResearchGate(stressedTest, Math.max(6, datasets.length * 2));
  const status = validationPassed && testPassed && stressPassed ? "oos_candidate" : "research_hold";

  return Object.freeze({
    schemaVersion: 1,
    market,
    status,
    researchOnly: true,
    liveExecutionAllowed: false,
    privateAccountRequestAllowed: false,
    selectionContract: Object.freeze({
      trainGridCandidates: grid.length,
      validationFinalists: finalists.length,
      testUsedForSelection: false,
      nextBarOpenEntry: true,
      sameBarStopTargetPolicy: "stop_first_conservative",
    }),
    costAssumptions: Object.freeze({
      costRatePerSide,
      stressMultiplier,
      stressedCostRatePerSide: costRatePerSide * stressMultiplier,
      note: "research execution-cost stress assumption, not a broker fee schedule",
    }),
    params: selected.params,
    train: selected.train,
    validation: selected.validation,
    test,
    stressedTest,
    gates: Object.freeze({ validationPassed, testPassed, stressPassed }),
  });
}
