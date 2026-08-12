import { PredictionInputError } from "./contracts.js";
import { buildStockOosSegments, normalizeOptimizerCandles } from "./stock-swing-optimizer.js";

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function stddev(values) {
  if (values.length < 2) return null;
  const avg = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(Math.max(0, variance));
}

function sma(candles, endIndex, period) {
  const start = endIndex - period + 1;
  if (start < 0) return null;
  return mean(candles.slice(start, endIndex + 1).map((row) => row.close));
}

function trueRange(candle, previousClose) {
  return Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
}

function atr(candles, endIndex, period = 14) {
  if (endIndex < period) return null;
  let total = 0;
  for (let index = endIndex - period + 1; index <= endIndex; index += 1) {
    if (index <= 0) return null;
    total += trueRange(candles[index], candles[index - 1].close);
  }
  return total / period;
}

function efficiencyRatio(candles, endIndex, period) {
  const start = endIndex - period;
  if (start < 0) return null;
  const displacement = Math.abs(candles[endIndex].close - candles[start].close);
  let path = 0;
  for (let index = start + 1; index <= endIndex; index += 1) path += Math.abs(candles[index].close - candles[index - 1].close);
  return path > 0 ? displacement / path : 0;
}

function averageVolumeBefore(candles, index, period = 20) {
  const start = index - period;
  if (start < 0) return null;
  return mean(candles.slice(start, index).map((row) => row.volume));
}

function highestHighBefore(candles, index, period) {
  const start = index - period;
  if (start < 0) return null;
  return Math.max(...candles.slice(start, index).map((row) => row.high));
}

function zscore(candles, endIndex, period) {
  const start = endIndex - period + 1;
  if (start < 0) return null;
  const closes = candles.slice(start, endIndex + 1).map((row) => row.close);
  const avg = mean(closes);
  const deviation = stddev(closes);
  return deviation != null && deviation > 0 ? (candles[endIndex].close - avg) / deviation : null;
}

export function classifyStockRegime(candles, index, rawParams = {}) {
  const params = {
    regimeLookback: Number(rawParams.regimeLookback ?? 30),
    regimeMaPeriod: Number(rawParams.regimeMaPeriod ?? 60),
    regimeSlopeBars: Number(rawParams.regimeSlopeBars ?? 5),
    trendEfficiencyMin: Number(rawParams.trendEfficiencyMin ?? 0.3),
    rangeEfficiencyMax: Number(rawParams.rangeEfficiencyMax ?? 0.2),
    rangeMaxMaSlopePercent: Number(rawParams.rangeMaxMaSlopePercent ?? 2),
  };
  const er = efficiencyRatio(candles, index, params.regimeLookback);
  const currentMa = sma(candles, index, params.regimeMaPeriod);
  const priorMa = sma(candles, index - params.regimeSlopeBars, params.regimeMaPeriod);
  if (er == null || currentMa == null || priorMa == null || !(priorMa > 0)) return Object.freeze({ regime: "unknown", efficiencyRatio: er, maSlopePercent: null });
  const maSlopePercent = (currentMa / priorMa - 1) * 100;
  if (er >= params.trendEfficiencyMin && maSlopePercent > 0 && candles[index].close > currentMa) {
    return Object.freeze({ regime: "trend", efficiencyRatio: er, maSlopePercent });
  }
  if (er <= params.rangeEfficiencyMax && Math.abs(maSlopePercent) <= params.rangeMaxMaSlopePercent) {
    return Object.freeze({ regime: "range", efficiencyRatio: er, maSlopePercent });
  }
  return Object.freeze({ regime: "transition", efficiencyRatio: er, maSlopePercent });
}

function validateParams(raw) {
  const params = {
    regimeLookback: Number(raw.regimeLookback),
    regimeMaPeriod: Number(raw.regimeMaPeriod),
    regimeSlopeBars: 5,
    trendEfficiencyMin: Number(raw.trendEfficiencyMin),
    rangeEfficiencyMax: Number(raw.rangeEfficiencyMax),
    rangeMaxMaSlopePercent: Number(raw.rangeMaxMaSlopePercent ?? 2),
    trendPullbackLookback: Number(raw.trendPullbackLookback ?? 10),
    trendMinPullbackAtr: 0.35,
    trendMaxPullbackAtr: Number(raw.trendMaxPullbackAtr),
    trendMinRelativeVolume: Number(raw.trendMinRelativeVolume),
    trendStopAtr: Number(raw.trendStopAtr),
    trendRewardRisk: Number(raw.trendRewardRisk),
    rangeZPeriod: Number(raw.rangeZPeriod ?? 20),
    rangeEntryZ: Number(raw.rangeEntryZ),
    rangeExitZ: Number(raw.rangeExitZ),
    rangeStopAtr: Number(raw.rangeStopAtr),
    maxHoldBars: Number(raw.maxHoldBars),
    maxGapPercent: Number(raw.maxGapPercent),
  };
  for (const name of ["regimeLookback", "regimeMaPeriod", "trendPullbackLookback", "rangeZPeriod", "maxHoldBars"]) {
    if (!Number.isInteger(params[name]) || params[name] < 2 || params[name] > 250) throw new PredictionInputError(`invalid ${name}`);
  }
  if (!(params.trendEfficiencyMin > params.rangeEfficiencyMax && params.trendEfficiencyMin <= 1 && params.rangeEfficiencyMax >= 0)) throw new PredictionInputError("regime efficiency thresholds must be ordered within 0..1");
  for (const name of ["trendMaxPullbackAtr", "trendMinRelativeVolume", "trendStopAtr", "trendRewardRisk", "rangeStopAtr"]) {
    if (!Number.isFinite(params[name]) || params[name] <= 0) throw new PredictionInputError(`invalid ${name}`);
  }
  if (!(params.rangeEntryZ < params.rangeExitZ)) throw new PredictionInputError("rangeEntryZ must be below rangeExitZ");
  if (!Number.isFinite(params.maxGapPercent) || params.maxGapPercent < 0 || params.maxGapPercent > 20) throw new PredictionInputError("invalid maxGapPercent");
  return Object.freeze(params);
}

function trendSignal(candles, index, params, regime) {
  if (regime.regime !== "trend") return null;
  const signalAtr = atr(candles, index, 14);
  const recentHigh = highestHighBefore(candles, index, params.trendPullbackLookback);
  const baseVolume = averageVolumeBefore(candles, index, 20);
  if (!(signalAtr > 0 && recentHigh > 0 && baseVolume > 0)) return null;
  const pullbackAtr = (recentHigh - candles[index].close) / signalAtr;
  const relativeVolume = candles[index].volume / baseVolume;
  const recovery = index > 0 && candles[index].close > candles[index].open && candles[index].close > candles[index - 1].close;
  if (!recovery || pullbackAtr < params.trendMinPullbackAtr || pullbackAtr > params.trendMaxPullbackAtr || relativeVolume < params.trendMinRelativeVolume) return null;
  return Object.freeze({ atr: signalAtr, pullbackAtr, relativeVolume });
}

function rangeSignal(candles, index, params, regime) {
  if (regime.regime !== "range") return null;
  const signalZ = zscore(candles, index, params.rangeZPeriod);
  const signalAtr = atr(candles, index, 14);
  if (signalZ == null || !(signalAtr > 0) || signalZ > params.rangeEntryZ) return null;
  return Object.freeze({ atr: signalAtr, signalZ });
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
    tradeCount: trades.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    expectancy: trades.length ? returns.reduce((sum, value) => sum + value, 0) / trades.length : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Number.POSITIVE_INFINITY : 0,
    maxDrawdown,
    netReturn: equity - 1,
    regimeCounts: Object.freeze({
      trend: trades.filter((trade) => trade.regime === "trend").length,
      range: trades.filter((trade) => trade.regime === "range").length,
    }),
  });
}

function netReturn(entryOpen, rawExit, costRatePerSide) {
  return rawExit * (1 - costRatePerSide) / (entryOpen * (1 + costRatePerSide)) - 1;
}

export function simulateStockRegimeRouter(raw = {}) {
  if (!raw || typeof raw !== "object") throw new PredictionInputError("stock regime router input must be an object");
  const candles = normalizeOptimizerCandles(raw.candles);
  const params = validateParams(raw.params);
  const costRatePerSide = Number(raw.costRatePerSide ?? 0.002);
  if (!Number.isFinite(costRatePerSide) || costRatePerSide < 0 || costRatePerSide >= 0.05) throw new PredictionInputError("invalid stock regime cost");
  const warmup = Math.max(params.regimeLookback, params.regimeMaPeriod + params.regimeSlopeBars, params.trendPullbackLookback, params.rangeZPeriod, 20) + 2;
  const startIndex = Math.max(warmup, Number.isInteger(raw.startIndex) ? raw.startIndex : warmup);
  const endIndex = Math.min(candles.length - 1, Number.isInteger(raw.endIndex) ? raw.endIndex : candles.length - 1);
  const trades = [];
  let signalIndex = startIndex;
  while (signalIndex < endIndex) {
    const regime = classifyStockRegime(candles, signalIndex, params);
    const trend = trendSignal(candles, signalIndex, params, regime);
    const range = trend ? null : rangeSignal(candles, signalIndex, params, regime);
    const signal = trend ?? range;
    if (!signal) { signalIndex += 1; continue; }
    const entryIndex = signalIndex + 1;
    if (entryIndex > endIndex) break;
    const entry = candles[entryIndex];
    const gapPercent = Math.abs(entry.open / candles[signalIndex].close - 1) * 100;
    if (gapPercent > params.maxGapPercent) { signalIndex += 1; continue; }
    const isTrend = Boolean(trend);
    const stopDistance = signal.atr * (isTrend ? params.trendStopAtr : params.rangeStopAtr);
    const stop = entry.open - stopDistance;
    if (!(stop > 0)) { signalIndex += 1; continue; }
    const target = isTrend ? entry.open + stopDistance * params.trendRewardRisk : null;
    const last = Math.min(endIndex, entryIndex + params.maxHoldBars - 1);
    let exitIndex = last;
    let rawExit = candles[last].close;
    let exitReason = "time";
    for (let index = entryIndex; index <= last; index += 1) {
      const candle = candles[index];
      if (candle.open <= stop) { exitIndex = index; rawExit = candle.open; exitReason = "stop_gap"; break; }
      if (candle.low <= stop && (!isTrend || candle.high < target)) { exitIndex = index; rawExit = stop; exitReason = "stop"; break; }
      if (isTrend) {
        const stopHit = candle.low <= stop;
        const targetHit = candle.high >= target;
        if (stopHit && targetHit) { exitIndex = index; rawExit = stop; exitReason = "stop_same_bar"; break; }
        if (stopHit) { exitIndex = index; rawExit = stop; exitReason = "stop"; break; }
        if (targetHit) { exitIndex = index; rawExit = target; exitReason = "target"; break; }
      } else {
        const exitZ = zscore(candles, index, params.rangeZPeriod);
        if (exitZ != null && exitZ >= params.rangeExitZ) {
          if (index + 1 <= endIndex) { exitIndex = index + 1; rawExit = candles[index + 1].open; exitReason = "range_revert_next_open"; }
          else { exitIndex = index; rawExit = candle.close; exitReason = "range_revert_terminal_close"; }
          break;
        }
      }
    }
    trades.push(Object.freeze({
      signalIndex,
      entryIndex,
      exitIndex,
      signalTimestamp: candles[signalIndex].timestamp,
      entryTimestamp: entry.timestamp,
      exitTimestamp: candles[exitIndex].timestamp,
      regime: isTrend ? "trend" : "range",
      regimeEvidence: regime,
      gapPercent,
      exitReason,
      netReturn: netReturn(entry.open, rawExit, costRatePerSide),
    }));
    signalIndex = exitIndex + 1;
  }
  return Object.freeze({ params, costRatePerSide, trades: Object.freeze(trades), metrics: summarize(trades) });
}

export function expandStockRegimeGrid(raw = {}) {
  const values = {
    regimeLookback: raw.regimeLookback ?? [20, 40],
    regimeMaPeriod: raw.regimeMaPeriod ?? [50, 100],
    trendEfficiencyMin: raw.trendEfficiencyMin ?? [0.25, 0.35],
    rangeEfficiencyMax: raw.rangeEfficiencyMax ?? [0.12, 0.20],
    trendMaxPullbackAtr: raw.trendMaxPullbackAtr ?? [1.5, 2.5],
    trendMinRelativeVolume: raw.trendMinRelativeVolume ?? [0.8, 1.0],
    trendStopAtr: raw.trendStopAtr ?? [1.5, 2.5],
    trendRewardRisk: raw.trendRewardRisk ?? [1.5, 2],
    rangeEntryZ: raw.rangeEntryZ ?? [-1.5, -2],
    rangeExitZ: raw.rangeExitZ ?? [-0.25, 0],
    rangeStopAtr: raw.rangeStopAtr ?? [1.5, 2.5],
    maxHoldBars: raw.maxHoldBars ?? [10, 20],
    maxGapPercent: raw.maxGapPercent ?? [4],
  };
  const grid = [];
  for (const regimeLookback of values.regimeLookback)
    for (const regimeMaPeriod of values.regimeMaPeriod)
      for (const trendEfficiencyMin of values.trendEfficiencyMin)
        for (const rangeEfficiencyMax of values.rangeEfficiencyMax)
          for (const trendMaxPullbackAtr of values.trendMaxPullbackAtr)
            for (const trendMinRelativeVolume of values.trendMinRelativeVolume)
              for (const trendStopAtr of values.trendStopAtr)
                for (const trendRewardRisk of values.trendRewardRisk)
                  for (const rangeEntryZ of values.rangeEntryZ)
                    for (const rangeExitZ of values.rangeExitZ)
                      for (const rangeStopAtr of values.rangeStopAtr)
                        for (const maxHoldBars of values.maxHoldBars)
                          for (const maxGapPercent of values.maxGapPercent) {
                            if (trendEfficiencyMin <= rangeEfficiencyMax) continue;
                            grid.push(Object.freeze({
                              regimeLookback, regimeMaPeriod, trendEfficiencyMin, rangeEfficiencyMax,
                              rangeMaxMaSlopePercent: 2, trendPullbackLookback: 10, trendMaxPullbackAtr,
                              trendMinRelativeVolume, trendStopAtr, trendRewardRisk, rangeZPeriod: 20,
                              rangeEntryZ, rangeExitZ, rangeStopAtr, maxHoldBars, maxGapPercent,
                            }));
                          }
  return Object.freeze(grid);
}

function normalizeDatasets(raw, label, minimum = 3) {
  if (!Array.isArray(raw) || raw.length < minimum) throw new PredictionInputError(`${label} requires at least ${minimum} datasets`);
  const seen = new Set();
  return Object.freeze(raw.map((dataset, index) => {
    const symbol = String(dataset?.symbol ?? "").trim().toUpperCase();
    if (!symbol || seen.has(symbol)) throw new PredictionInputError(`${label} symbols must be unique`, { index, symbol });
    seen.add(symbol);
    return Object.freeze({ symbol, candles: normalizeOptimizerCandles(dataset.candles) });
  }));
}

function aggregate(results) {
  const trades = results.flatMap((item) => item.simulation.trades.map((trade) => ({ ...trade, symbol: item.symbol })));
  const metrics = summarize(trades);
  const positiveSymbols = results.filter((item) => item.simulation.metrics.expectancy > 0 && item.simulation.metrics.profitFactor > 1).length;
  return Object.freeze({ metrics, positiveSymbols, symbolCount: results.length, perSymbol: Object.freeze(Object.fromEntries(results.map((item) => [item.symbol, item.simulation.metrics]))) });
}

function evaluate(datasets, params, segmentName, costRatePerSide, multiplier = 1) {
  return aggregate(datasets.map((dataset) => {
    const segment = buildStockOosSegments(dataset.candles.length)[segmentName];
    return Object.freeze({ symbol: dataset.symbol, simulation: simulateStockRegimeRouter({
      candles: dataset.candles, params, costRatePerSide: costRatePerSide * multiplier,
      startIndex: segment.startIndex, endIndex: segment.endIndex,
    }) });
  }));
}

function objective(summary) {
  const { metrics, positiveSymbols, symbolCount } = summary;
  if (metrics.tradeCount < Math.max(10, symbolCount * 3)) return -1_000;
  const pf = Number.isFinite(metrics.profitFactor) ? Math.min(metrics.profitFactor, 5) : 5;
  const regimeDiversity = metrics.regimeCounts.trend > 0 && metrics.regimeCounts.range > 0 ? 0.75 : 0;
  return metrics.expectancy * 100 + metrics.netReturn * 5 + (pf - 1) * 2 + positiveSymbols / symbolCount * 2 + regimeDiversity - metrics.maxDrawdown * 10;
}

function pass(summary, minimumTrades, requiredPositiveRatio = 2 / 3) {
  return summary.metrics.tradeCount >= minimumTrades
    && summary.metrics.expectancy > 0
    && summary.metrics.profitFactor >= 1.05
    && summary.metrics.maxDrawdown <= 0.35
    && summary.positiveSymbols >= Math.ceil(summary.symbolCount * requiredPositiveRatio)
    && summary.metrics.regimeCounts.trend >= 3
    && summary.metrics.regimeCounts.range >= 3;
}

function rollingAudit(seed, params, costRatePerSide) {
  const windows = [];
  for (let window = 0; window < 4; window += 1) {
    const results = seed.map((dataset) => {
      const segment = buildStockOosSegments(dataset.candles.length).test;
      const span = segment.endIndex - segment.startIndex + 1;
      const width = Math.floor(span / 4);
      const startIndex = segment.startIndex + window * width;
      const endIndex = window === 3 ? segment.endIndex : startIndex + width - 1;
      return Object.freeze({ symbol: dataset.symbol, simulation: simulateStockRegimeRouter({ candles: dataset.candles, params, costRatePerSide, startIndex, endIndex }) });
    });
    const summary = aggregate(results);
    windows.push(Object.freeze({ index: window + 1, summary, passed: summary.metrics.expectancy > 0 && summary.metrics.profitFactor > 1 }));
  }
  const positiveWindows = windows.filter((row) => row.passed).length;
  return Object.freeze({ passed: positiveWindows >= 3, activeWindows: 4, positiveWindows, windows: Object.freeze(windows), parametersRetunedPerWindow: false, futureWindowsUsedForSelection: false });
}

export function optimizeStockRegimeRouter(raw = {}) {
  const market = raw.market;
  if (market !== "KR_STOCK" && market !== "US_STOCK") throw new PredictionInputError("market must be KR_STOCK or US_STOCK");
  const seed = normalizeDatasets(raw.seedDatasets, "seedDatasets", 3);
  const holdout = normalizeDatasets(raw.holdoutDatasets, "holdoutDatasets", 3);
  if (seed.some((row) => holdout.some((candidate) => candidate.symbol === row.symbol))) throw new PredictionInputError("seed and holdout symbols must not overlap");
  const costRatePerSide = Number(raw.costRatePerSide ?? (market === "KR_STOCK" ? 0.0025 : 0.0015));
  const stressMultiplier = Number(raw.stressMultiplier ?? 1.5);
  if (!Number.isFinite(costRatePerSide) || costRatePerSide < 0 || costRatePerSide >= 0.05) throw new PredictionInputError("invalid stock regime cost");
  if (!Number.isFinite(stressMultiplier) || stressMultiplier < 1 || stressMultiplier > 3) throw new PredictionInputError("invalid stock regime stress multiplier");
  const grid = expandStockRegimeGrid(raw.grid);
  if (!grid.length || grid.length > 5000) throw new PredictionInputError("stock regime grid must contain 1..5000 candidates");
  const trained = grid.map((params) => ({ params, train: evaluate(seed, params, "train", costRatePerSide) })).sort((a, b) => objective(b.train) - objective(a.train));
  const finalists = trained.slice(0, Math.min(28, trained.length)).map((candidate) => ({ ...candidate, validation: evaluate(seed, candidate.params, "validation", costRatePerSide) })).sort((a, b) => objective(b.validation) - objective(a.validation));
  const selected = finalists.find((candidate) => pass(candidate.validation, Math.max(10, seed.length * 3))) ?? finalists[0];
  if (!selected) throw new PredictionInputError("stock regime router could not select a candidate");
  const seedTest = evaluate(seed, selected.params, "test", costRatePerSide);
  const stressedSeedTest = evaluate(seed, selected.params, "test", costRatePerSide, stressMultiplier);
  const holdoutTest = evaluate(holdout, selected.params, "test", costRatePerSide);
  const stressedHoldout = evaluate(holdout, selected.params, "test", costRatePerSide, stressMultiplier);
  const rolling = rollingAudit(seed, selected.params, costRatePerSide);
  const validationPassed = pass(selected.validation, Math.max(10, seed.length * 3));
  const seedTestPassed = pass(seedTest, Math.max(10, seed.length * 3));
  const stressPassed = pass(stressedSeedTest, Math.max(8, seed.length * 2));
  const holdoutPassed = pass(holdoutTest, Math.max(14, holdout.length * 2), 0.6);
  const holdoutStressPassed = pass(stressedHoldout, Math.max(12, holdout.length * 2), 0.6);
  const status = validationPassed && seedTestPassed && stressPassed && holdoutPassed && holdoutStressPassed && rolling.passed ? "cross_symbol_research_candidate" : "research_hold";
  return Object.freeze({
    schemaVersion: 1,
    market,
    status,
    researchOnly: true,
    liveExecutionAllowed: false,
    privateAccountRequestAllowed: false,
    selectedStrategy: "regime_router_trend_plus_range",
    selectionContract: Object.freeze({ gridCandidates: grid.length, validationFinalists: finalists.length, seedTestUsedForSelection: false, holdoutUsedForSelection: false, futureWindowsUsedForSelection: false, parametersRetunedOnHoldout: false }),
    costAssumptions: Object.freeze({ costRatePerSide, stressMultiplier, stressedCostRatePerSide: costRatePerSide * stressMultiplier, note: "research execution-cost stress assumption, not a broker fee schedule" }),
    params: selected.params,
    train: selected.train,
    validation: selected.validation,
    seedTest,
    stressedSeedTest,
    unseenHoldout: holdoutTest,
    stressedUnseenHoldout: stressedHoldout,
    futureTimeRolling: rolling,
    gates: Object.freeze({ validationPassed, seedTestPassed, stressPassed, holdoutPassed, holdoutStressPassed, rollingPassed: rolling.passed }),
    limitations: Object.freeze([
      "current-symbol public history is not a point-in-time constituent universe",
      "delisted-name and survivorship protection remains incomplete",
      "this regime family was introduced after earlier strategy failures, so adaptive research bias remains",
      "future Shadow evidence is required before execution promotion",
    ]),
  });
}
