import { PredictionInputError } from "./contracts.js";
import { buildStockOosSegments, normalizeOptimizerCandles } from "./stock-swing-optimizer.js";

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function sma(candles, endIndex, period) {
  const start = endIndex - period + 1;
  if (start < 0) return null;
  let total = 0;
  for (let index = start; index <= endIndex; index += 1) total += candles[index].close;
  return total / period;
}

function trueRange(candle, previousClose) {
  return Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
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

function highestHighBefore(candles, index, period) {
  const start = index - period;
  if (start < 0) return null;
  let highest = -Infinity;
  for (let cursor = start; cursor < index; cursor += 1) highest = Math.max(highest, candles[cursor].high);
  return Number.isFinite(highest) ? highest : null;
}

function averageVolumeBefore(candles, index, period) {
  const start = index - period;
  if (start < 0) return null;
  let total = 0;
  for (let cursor = start; cursor < index; cursor += 1) total += candles[cursor].volume;
  return total / period;
}

function summarize(trades) {
  const returns = trades.map((trade) => trade.netReturn);
  const wins = returns.filter((value) => value > 0);
  const losses = returns.filter((value) => value < 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  for (const value of returns) {
    equity *= Math.max(0.000001, 1 + value);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - equity) / peak : 0);
  }
  return Object.freeze({
    tradeCount: returns.length,
    winRate: returns.length ? wins.length / returns.length : 0,
    expectancy: mean(returns) ?? 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Number.POSITIVE_INFINITY : 0,
    maxDrawdown,
    netReturn: equity - 1,
  });
}

function validateParams(raw) {
  const params = {
    trendMaPeriod: Number(raw.trendMaPeriod),
    slopeLookback: Number(raw.slopeLookback ?? 5),
    pullbackLookback: Number(raw.pullbackLookback),
    atrPeriod: 14,
    minPullbackAtr: Number(raw.minPullbackAtr ?? 0.5),
    maxPullbackAtr: Number(raw.maxPullbackAtr),
    atrStopMultiplier: Number(raw.atrStopMultiplier),
    rewardRisk: Number(raw.rewardRisk),
    maxHoldBars: Number(raw.maxHoldBars),
    relativeVolumePeriod: 20,
    minRelativeVolume: Number(raw.minRelativeVolume),
    maxGapPercent: Number(raw.maxGapPercent),
  };
  for (const name of ["trendMaPeriod", "slopeLookback", "pullbackLookback", "maxHoldBars"]) {
    if (!Number.isInteger(params[name]) || params[name] < 2 || params[name] > 250) throw new PredictionInputError(`invalid ${name}`);
  }
  for (const name of ["minPullbackAtr", "maxPullbackAtr", "atrStopMultiplier", "rewardRisk", "minRelativeVolume"]) {
    if (!Number.isFinite(params[name]) || params[name] <= 0) throw new PredictionInputError(`invalid ${name}`);
  }
  if (params.maxPullbackAtr <= params.minPullbackAtr) throw new PredictionInputError("maxPullbackAtr must exceed minPullbackAtr");
  if (!Number.isFinite(params.maxGapPercent) || params.maxGapPercent < 0 || params.maxGapPercent > 50) throw new PredictionInputError("invalid maxGapPercent");
  return Object.freeze(params);
}

export function simulateStockPullbackStrategy(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PredictionInputError("pullback simulation input must be an object");
  const candles = normalizeOptimizerCandles(raw.candles);
  const params = validateParams(raw.params);
  const costRatePerSide = Number(raw.costRatePerSide ?? 0.0015);
  if (!Number.isFinite(costRatePerSide) || costRatePerSide < 0 || costRatePerSide >= 0.05) throw new PredictionInputError("invalid pullback costRatePerSide");
  const warmup = Math.max(params.trendMaPeriod + params.slopeLookback, params.pullbackLookback, params.atrPeriod, params.relativeVolumePeriod) + 1;
  const startIndex = Math.max(warmup, Number.isInteger(raw.startIndex) ? raw.startIndex : warmup);
  const endIndex = Math.min(candles.length - 1, Number.isInteger(raw.endIndex) ? raw.endIndex : candles.length - 1);
  const trades = [];
  let signalIndex = startIndex;

  while (signalIndex < endIndex) {
    const signal = candles[signalIndex];
    const previous = candles[signalIndex - 1];
    const trendMa = sma(candles, signalIndex, params.trendMaPeriod);
    const priorTrendMa = sma(candles, signalIndex - params.slopeLookback, params.trendMaPeriod);
    const signalAtr = atr(candles, signalIndex, params.atrPeriod);
    const recentHigh = highestHighBefore(candles, signalIndex, params.pullbackLookback);
    const baseVolume = averageVolumeBefore(candles, signalIndex, params.relativeVolumePeriod);
    const relativeVolume = baseVolume != null && baseVolume > 0 ? signal.volume / baseVolume : null;
    const pullbackAtr = recentHigh != null && signalAtr != null && signalAtr > 0 ? (recentHigh - signal.close) / signalAtr : null;
    const qualifies = trendMa != null
      && priorTrendMa != null
      && signalAtr != null
      && signalAtr > 0
      && recentHigh != null
      && relativeVolume != null
      && pullbackAtr != null
      && signal.close > trendMa
      && trendMa > priorTrendMa
      && pullbackAtr >= params.minPullbackAtr
      && pullbackAtr <= params.maxPullbackAtr
      && signal.close > signal.open
      && signal.close > previous.close
      && relativeVolume >= params.minRelativeVolume;
    if (!qualifies) {
      signalIndex += 1;
      continue;
    }

    const entryIndex = signalIndex + 1;
    if (entryIndex > endIndex) break;
    const entry = candles[entryIndex];
    const gapPercent = Math.abs(entry.open / signal.close - 1) * 100;
    if (gapPercent > params.maxGapPercent) {
      signalIndex += 1;
      continue;
    }
    const entryPrice = entry.open * (1 + costRatePerSide);
    const stopDistance = signalAtr * params.atrStopMultiplier;
    const stopPrice = entry.open - stopDistance;
    const targetPrice = entry.open + stopDistance * params.rewardRisk;
    if (!(stopPrice > 0)) {
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
    trades.push(Object.freeze({
      signalIndex,
      entryIndex,
      exitIndex,
      entryPrice,
      exitPrice,
      stopPrice,
      targetPrice,
      gapPercent,
      pullbackAtr,
      relativeVolume,
      exitReason,
      netReturn: exitPrice / entryPrice - 1,
    }));
    signalIndex = exitIndex + 1;
  }

  return Object.freeze({ params, costRatePerSide, trades: Object.freeze(trades), metrics: summarize(trades) });
}

function expandGrid(raw = {}) {
  const values = {
    trendMaPeriod: raw.trendMaPeriod ?? [50, 100, 200],
    pullbackLookback: raw.pullbackLookback ?? [5, 10],
    maxPullbackAtr: raw.maxPullbackAtr ?? [1.5, 2.5],
    atrStopMultiplier: raw.atrStopMultiplier ?? [1.5, 2.5],
    rewardRisk: raw.rewardRisk ?? [1.5, 2],
    maxHoldBars: raw.maxHoldBars ?? [5, 10],
    minRelativeVolume: raw.minRelativeVolume ?? [0.8, 1],
    maxGapPercent: raw.maxGapPercent ?? [4],
  };
  const result = [];
  for (const trendMaPeriod of values.trendMaPeriod)
    for (const pullbackLookback of values.pullbackLookback)
      for (const maxPullbackAtr of values.maxPullbackAtr)
        for (const atrStopMultiplier of values.atrStopMultiplier)
          for (const rewardRisk of values.rewardRisk)
            for (const maxHoldBars of values.maxHoldBars)
              for (const minRelativeVolume of values.minRelativeVolume)
                for (const maxGapPercent of values.maxGapPercent) result.push(Object.freeze({
                  trendMaPeriod,
                  slopeLookback: 5,
                  pullbackLookback,
                  minPullbackAtr: 0.5,
                  maxPullbackAtr,
                  atrStopMultiplier,
                  rewardRisk,
                  maxHoldBars,
                  minRelativeVolume,
                  maxGapPercent,
                }));
  return Object.freeze(result);
}

function normalizeDatasets(raw, label) {
  if (!Array.isArray(raw) || raw.length < 3) throw new PredictionInputError(`${label} requires at least three datasets`);
  const seen = new Set();
  return Object.freeze(raw.map((dataset, index) => {
    const symbol = String(dataset?.symbol ?? "").trim().toUpperCase();
    if (!symbol || seen.has(symbol)) throw new PredictionInputError(`${label} symbols must be unique`, { index, symbol });
    seen.add(symbol);
    return Object.freeze({ symbol, candles: normalizeOptimizerCandles(dataset.candles) });
  }));
}

function aggregate(results) {
  const allTrades = results.flatMap((item) => item.simulation.trades.map((trade) => ({ ...trade, symbol: item.symbol })));
  return Object.freeze({
    metrics: summarize(allTrades),
    positiveSymbols: results.filter((item) => item.simulation.metrics.expectancy > 0 && item.simulation.metrics.profitFactor > 1).length,
    symbolCount: results.length,
    perSymbol: Object.freeze(Object.fromEntries(results.map((item) => [item.symbol, item.simulation.metrics]))),
  });
}

function evaluateSegment(datasets, params, segmentName, costRatePerSide, multiplier = 1) {
  return aggregate(datasets.map((dataset) => {
    const segment = buildStockOosSegments(dataset.candles.length)[segmentName];
    return {
      symbol: dataset.symbol,
      simulation: simulateStockPullbackStrategy({ candles: dataset.candles, params, costRatePerSide: costRatePerSide * multiplier, ...segment }),
    };
  }));
}

function objective(summary) {
  const metrics = summary.metrics;
  if (metrics.tradeCount < Math.max(8, summary.symbolCount * 2)) return -1_000;
  const pf = Number.isFinite(metrics.profitFactor) ? Math.min(metrics.profitFactor, 5) : 5;
  return metrics.expectancy * 100 + metrics.netReturn * 5 + (pf - 1) * 2 + summary.positiveSymbols / summary.symbolCount - metrics.maxDrawdown * 8;
}

function pass(summary, minimumTrades) {
  return summary.metrics.tradeCount >= minimumTrades
    && summary.metrics.expectancy > 0
    && summary.metrics.profitFactor >= 1.05
    && summary.metrics.maxDrawdown <= 0.35
    && summary.positiveSymbols >= Math.ceil(summary.symbolCount * 0.6);
}

export function optimizeUsStockPullback(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PredictionInputError("US pullback optimizer input must be an object");
  const seed = normalizeDatasets(raw.seedDatasets, "seedDatasets");
  const holdout = normalizeDatasets(raw.holdoutDatasets, "holdoutDatasets");
  const overlap = seed.some((item) => holdout.some((candidate) => candidate.symbol === item.symbol));
  if (overlap) throw new PredictionInputError("seed and holdout symbols must not overlap");
  const costRatePerSide = Number(raw.costRatePerSide ?? 0.0015);
  const stressMultiplier = Number(raw.stressMultiplier ?? 1.5);
  if (!Number.isFinite(costRatePerSide) || costRatePerSide < 0 || costRatePerSide >= 0.05) throw new PredictionInputError("invalid US pullback cost");
  if (!Number.isFinite(stressMultiplier) || stressMultiplier < 1 || stressMultiplier > 3) throw new PredictionInputError("invalid US pullback stressMultiplier");
  const grid = expandGrid(raw.grid);
  if (!grid.length || grid.length > 2500) throw new PredictionInputError("US pullback grid must contain 1..2500 candidates");

  const trained = grid.map((params) => ({ params, train: evaluateSegment(seed, params, "train", costRatePerSide) }))
    .sort((left, right) => objective(right.train) - objective(left.train));
  const finalists = trained.slice(0, Math.min(24, trained.length)).map((candidate) => ({
    ...candidate,
    validation: evaluateSegment(seed, candidate.params, "validation", costRatePerSide),
  })).sort((left, right) => objective(right.validation) - objective(left.validation));
  const selected = finalists.find((candidate) => pass(candidate.validation, Math.max(8, seed.length * 2))) ?? finalists[0];
  if (!selected) throw new PredictionInputError("US pullback optimizer could not select a candidate");

  const seedTest = evaluateSegment(seed, selected.params, "test", costRatePerSide);
  const holdoutTest = evaluateSegment(holdout, selected.params, "test", costRatePerSide);
  const stressedHoldout = evaluateSegment(holdout, selected.params, "test", costRatePerSide, stressMultiplier);
  const validationPassed = pass(selected.validation, Math.max(8, seed.length * 2));
  const seedTestPassed = pass(seedTest, Math.max(8, seed.length * 2));
  const holdoutPassed = pass(holdoutTest, Math.max(10, holdout.length * 2));
  const stressPassed = pass(stressedHoldout, Math.max(8, holdout.length * 2));
  const status = validationPassed && seedTestPassed && holdoutPassed && stressPassed ? "cross_symbol_research_candidate" : "research_hold";

  return Object.freeze({
    schemaVersion: 1,
    market: "US_STOCK",
    strategyFamily: "trend_pullback",
    status,
    researchOnly: true,
    liveExecutionAllowed: false,
    privateAccountRequestAllowed: false,
    selectionContract: Object.freeze({
      testUsedForSelection: false,
      holdoutSymbolsUsedForSelection: false,
      seedSymbols: Object.freeze(seed.map((item) => item.symbol)),
      holdoutSymbols: Object.freeze(holdout.map((item) => item.symbol)),
      nextBarOpenEntry: true,
      sameBarStopTargetPolicy: "stop_first_conservative",
    }),
    params: selected.params,
    validation: selected.validation,
    seedTest,
    holdoutTest,
    stressedHoldout,
    gates: Object.freeze({ validationPassed, seedTestPassed, holdoutPassed, stressPassed }),
    costAssumptions: Object.freeze({ costRatePerSide, stressMultiplier, stressedCostRatePerSide: costRatePerSide * stressMultiplier }),
    limitations: Object.freeze([
      "This strategy family was introduced after the earlier breakout family failed, so the historical period is not a pristine global holdout.",
      "Unseen-symbol holdouts reduce but do not eliminate adaptive research bias.",
      "A future-time walk-forward/Shadow period is required before any stronger promotion.",
    ]),
  });
}
