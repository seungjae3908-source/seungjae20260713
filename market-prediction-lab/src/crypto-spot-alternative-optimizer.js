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

function ma(candles, endIndex, period) {
  const start = endIndex - period + 1;
  if (start < 0) return null;
  return mean(candles.slice(start, endIndex + 1).map((row) => row.close));
}

function averageVolume(candles, endIndex, period) {
  const start = endIndex - period + 1;
  if (start < 0) return null;
  return mean(candles.slice(start, endIndex + 1).map((row) => row.volume));
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

function zscore(candles, endIndex, period) {
  const start = endIndex - period + 1;
  if (start < 0) return null;
  const values = candles.slice(start, endIndex + 1).map((row) => row.close);
  const avg = mean(values);
  const deviation = stddev(values);
  if (!(deviation > 0)) return null;
  return (candles[endIndex].close - avg) / deviation;
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
  });
}

function validateCost(value) {
  const cost = Number(value ?? 0.0015);
  if (!Number.isFinite(cost) || cost < 0 || cost >= 0.05) throw new PredictionInputError("invalid spot cost rate");
  return cost;
}

function netReturn(entryOpen, rawExit, cost) {
  const entry = entryOpen * (1 + cost);
  const exit = rawExit * (1 - cost);
  return exit / entry - 1;
}

function trendSignal(candles, index, params) {
  const fast = ma(candles, index, params.fastMa);
  const slow = ma(candles, index, params.slowMa);
  const priorFast = ma(candles, index - params.slopeBars, params.fastMa);
  const signalAtr = atr(candles, index, 14);
  const baselineVolume = averageVolume(candles, index - 1, 20);
  if (!(fast > 0 && slow > 0 && priorFast > 0 && signalAtr > 0 && baselineVolume > 0)) return null;
  const distanceAtr = Math.abs(candles[index].close - fast) / signalAtr;
  const relativeVolume = candles[index].volume / baselineVolume;
  const trigger = index > 0 && candles[index].close > candles[index - 1].high;
  const confirmed = candles[index].close > slow
    && fast > slow
    && fast > priorFast
    && distanceAtr <= params.maxFastMaDistanceAtr
    && relativeVolume >= params.minRelativeVolume
    && trigger;
  return confirmed ? Object.freeze({ atr: signalAtr, relativeVolume, fast, slow }) : null;
}

function meanReversionSignal(candles, index, params) {
  const signalZ = zscore(candles, index, params.zPeriod);
  const shortMa = ma(candles, index, params.zPeriod);
  const longMa = ma(candles, index, params.regimeMa);
  const signalAtr = atr(candles, index, 14);
  if (signalZ == null || !(shortMa > 0 && longMa > 0 && signalAtr > 0)) return null;
  const regimeGap = Math.abs(shortMa / longMa - 1);
  const confirmed = signalZ <= params.entryZ && regimeGap <= params.maxRegimeGap;
  return confirmed ? Object.freeze({ atr: signalAtr, signalZ, regimeGap }) : null;
}

function simulateTrend(candles, params, cost, startIndex, endIndex) {
  const trades = [];
  let signalIndex = Math.max(startIndex, params.slowMa + params.slopeBars + 2, 25);
  while (signalIndex < endIndex) {
    const signal = trendSignal(candles, signalIndex, params);
    if (!signal) { signalIndex += 1; continue; }
    const entryIndex = signalIndex + 1;
    if (entryIndex > endIndex) break;
    const entry = candles[entryIndex].open;
    const stop = entry - signal.atr * params.stopAtrMultiple;
    const target = entry + signal.atr * params.stopAtrMultiple * params.rewardRisk;
    if (!(stop > 0 && target > entry)) { signalIndex += 1; continue; }
    const last = Math.min(endIndex, entryIndex + params.maxHoldBars - 1);
    let exitIndex = last;
    let rawExit = candles[last].close;
    let reason = "time";
    for (let index = entryIndex; index <= last; index += 1) {
      const candle = candles[index];
      if (candle.open <= stop) { exitIndex = index; rawExit = candle.open; reason = "stop_gap"; break; }
      if (candle.open >= target) { exitIndex = index; rawExit = target; reason = "target_gap"; break; }
      const stopHit = candle.low <= stop;
      const targetHit = candle.high >= target;
      if (stopHit && targetHit) { exitIndex = index; rawExit = stop; reason = "stop_same_bar"; break; }
      if (stopHit) { exitIndex = index; rawExit = stop; reason = "stop"; break; }
      if (targetHit) { exitIndex = index; rawExit = target; reason = "target"; break; }
    }
    trades.push(Object.freeze({ family: "trend_pullback", signalIndex, entryIndex, exitIndex, exitReason: reason, netReturn: netReturn(entry, rawExit, cost) }));
    signalIndex = exitIndex + 1;
  }
  return Object.freeze({ trades: Object.freeze(trades), metrics: summarize(trades) });
}

function simulateMeanReversion(candles, params, cost, startIndex, endIndex) {
  const trades = [];
  let signalIndex = Math.max(startIndex, params.regimeMa + 2, params.zPeriod + 2, 20);
  while (signalIndex < endIndex) {
    const signal = meanReversionSignal(candles, signalIndex, params);
    if (!signal) { signalIndex += 1; continue; }
    const entryIndex = signalIndex + 1;
    if (entryIndex > endIndex) break;
    const entry = candles[entryIndex].open;
    const stop = entry - signal.atr * params.stopAtrMultiple;
    if (!(stop > 0)) { signalIndex += 1; continue; }
    const last = Math.min(endIndex, entryIndex + params.maxHoldBars - 1);
    let exitIndex = last;
    let rawExit = candles[last].close;
    let reason = "time";
    for (let index = entryIndex; index <= last; index += 1) {
      const candle = candles[index];
      if (candle.open <= stop) { exitIndex = index; rawExit = candle.open; reason = "stop_gap"; break; }
      if (candle.low <= stop) { exitIndex = index; rawExit = stop; reason = "stop"; break; }
      const exitZ = zscore(candles, index, params.zPeriod);
      if (exitZ != null && exitZ >= params.exitZ) {
        if (index + 1 <= endIndex) {
          exitIndex = index + 1;
          rawExit = candles[index + 1].open;
          reason = "z_revert_next_open";
        } else {
          exitIndex = index;
          rawExit = candle.close;
          reason = "z_revert_terminal_close";
        }
        break;
      }
    }
    trades.push(Object.freeze({ family: "mean_reversion", signalIndex, entryIndex, exitIndex, exitReason: reason, entryZ: signal.signalZ, netReturn: netReturn(entry, rawExit, cost) }));
    signalIndex = exitIndex + 1;
  }
  return Object.freeze({ trades: Object.freeze(trades), metrics: summarize(trades) });
}

export function simulateSpotAlternativeStrategy(raw) {
  const candles = normalizeOptimizerCandles(raw?.candles);
  const family = raw?.params?.family;
  const cost = validateCost(raw?.costRatePerSide);
  const startIndex = Math.max(0, Number.isInteger(raw?.startIndex) ? raw.startIndex : 0);
  const endIndex = Math.min(candles.length - 1, Number.isInteger(raw?.endIndex) ? raw.endIndex : candles.length - 1);
  if (family === "trend_pullback") return simulateTrend(candles, raw.params, cost, startIndex, endIndex);
  if (family === "mean_reversion") return simulateMeanReversion(candles, raw.params, cost, startIndex, endIndex);
  throw new PredictionInputError("spot alternative family must be trend_pullback or mean_reversion");
}

export function expandSpotAlternativeGrid() {
  const grid = [];
  for (const fastMa of [20, 30]) for (const slowMa of [60, 100]) for (const slopeBars of [3, 6])
    for (const maxFastMaDistanceAtr of [0.75, 1.25]) for (const minRelativeVolume of [0.8, 1.0])
      for (const stopAtrMultiple of [1.5, 2]) for (const rewardRisk of [1.5, 2]) for (const maxHoldBars of [6, 12]) {
        if (fastMa >= slowMa) continue;
        grid.push(Object.freeze({ family: "trend_pullback", fastMa, slowMa, slopeBars, maxFastMaDistanceAtr, minRelativeVolume, stopAtrMultiple, rewardRisk, maxHoldBars }));
      }
  for (const zPeriod of [20, 30]) for (const regimeMa of [60, 100]) for (const entryZ of [-1.25, -1.75, -2.25])
    for (const exitZ of [-0.25, 0]) for (const maxRegimeGap of [0.03, 0.06]) for (const stopAtrMultiple of [1.5, 2.5])
      for (const maxHoldBars of [6, 12, 24]) {
        grid.push(Object.freeze({ family: "mean_reversion", zPeriod, regimeMa, entryZ, exitZ, maxRegimeGap, stopAtrMultiple, maxHoldBars }));
      }
  return Object.freeze(grid);
}

function normalizeDatasets(raw, minimum = 1) {
  if (!Array.isArray(raw) || raw.length < minimum) throw new PredictionInputError(`at least ${minimum} spot datasets are required`);
  const seen = new Set();
  return Object.freeze(raw.map((dataset, index) => {
    const symbol = String(dataset?.symbol ?? "").trim().toUpperCase();
    if (!symbol || seen.has(symbol)) throw new PredictionInputError("spot dataset symbols must be unique", { index, symbol });
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
    return Object.freeze({ symbol: dataset.symbol, simulation: simulateSpotAlternativeStrategy({
      candles: dataset.candles,
      params,
      costRatePerSide: costRatePerSide * multiplier,
      startIndex: segment.startIndex,
      endIndex: segment.endIndex,
    }) });
  }));
}

function objective(summary) {
  const { metrics, positiveSymbols, symbolCount } = summary;
  if (metrics.tradeCount < Math.max(10, symbolCount * 4)) return -1_000;
  const pf = Number.isFinite(metrics.profitFactor) ? Math.min(metrics.profitFactor, 5) : 5;
  return metrics.expectancy * 150 + metrics.netReturn * 5 + (pf - 1) * 2 + positiveSymbols / symbolCount * 2 - metrics.maxDrawdown * 8;
}

function passGate(summary, minimumTrades, requireAllSymbols = true) {
  return summary.metrics.tradeCount >= minimumTrades
    && summary.metrics.expectancy > 0
    && summary.metrics.profitFactor >= 1.05
    && summary.metrics.maxDrawdown <= 0.35
    && summary.positiveSymbols >= (requireAllSymbols ? summary.symbolCount : Math.ceil(summary.symbolCount * 2 / 3));
}

function rollingAudit(datasets, params, costRatePerSide) {
  const windows = [];
  for (let window = 0; window < 4; window += 1) {
    const results = datasets.map((dataset) => {
      const segment = buildStockOosSegments(dataset.candles.length).test;
      const span = segment.endIndex - segment.startIndex + 1;
      const width = Math.floor(span / 4);
      const startIndex = segment.startIndex + window * width;
      const endIndex = window === 3 ? segment.endIndex : startIndex + width - 1;
      return Object.freeze({ symbol: dataset.symbol, simulation: simulateSpotAlternativeStrategy({ candles: dataset.candles, params, costRatePerSide, startIndex, endIndex }) });
    });
    const summary = aggregate(results);
    windows.push(Object.freeze({ index: window + 1, summary, passed: summary.metrics.expectancy > 0 && summary.metrics.profitFactor > 1 }));
  }
  const positiveWindows = windows.filter((item) => item.passed).length;
  return Object.freeze({
    passed: positiveWindows >= 3,
    activeWindows: windows.length,
    positiveWindows,
    windows: Object.freeze(windows),
    parametersRetunedPerWindow: false,
    futureWindowsUsedForSelection: false,
  });
}

export function optimizeSpotAlternativeStrategies(raw = {}) {
  const seedDatasets = normalizeDatasets(raw.seedDatasets, 2);
  const holdoutDatasets = normalizeDatasets(raw.holdoutDatasets, 1);
  const costRatePerSide = validateCost(raw.costRatePerSide ?? 0.0015);
  const stressMultiplier = Number(raw.stressMultiplier ?? 1.5);
  if (!Number.isFinite(stressMultiplier) || stressMultiplier < 1 || stressMultiplier > 3) throw new PredictionInputError("invalid spot stress multiplier");
  const grid = expandSpotAlternativeGrid();

  const trained = grid.map((params) => ({ params, train: evaluate(seedDatasets, params, "train", costRatePerSide) }))
    .sort((a, b) => objective(b.train) - objective(a.train));
  const finalists = trained.slice(0, 32).map((candidate) => ({ ...candidate, validation: evaluate(seedDatasets, candidate.params, "validation", costRatePerSide) }))
    .sort((a, b) => objective(b.validation) - objective(a.validation));
  const minimumTrades = Math.max(12, seedDatasets.length * 5);
  const selected = finalists.find((candidate) => passGate(candidate.validation, minimumTrades)) ?? finalists[0];
  if (!selected) throw new PredictionInputError("spot alternative optimizer could not select a candidate");

  const seedTest = evaluate(seedDatasets, selected.params, "test", costRatePerSide);
  const stressedSeedTest = evaluate(seedDatasets, selected.params, "test", costRatePerSide, stressMultiplier);
  const holdout = evaluate(holdoutDatasets, selected.params, "test", costRatePerSide);
  const stressedHoldout = evaluate(holdoutDatasets, selected.params, "test", costRatePerSide, stressMultiplier);
  const rolling = rollingAudit(seedDatasets, selected.params, costRatePerSide);
  const validationPassed = passGate(selected.validation, minimumTrades);
  const seedTestPassed = passGate(seedTest, minimumTrades);
  const stressPassed = passGate(stressedSeedTest, Math.max(10, seedDatasets.length * 4));
  const holdoutPassed = passGate(holdout, Math.max(10, holdoutDatasets.length * 5));
  const holdoutStressPassed = passGate(stressedHoldout, Math.max(8, holdoutDatasets.length * 4));
  const status = validationPassed && seedTestPassed && stressPassed && holdoutPassed && holdoutStressPassed && rolling.passed
    ? "shadow_research_candidate"
    : "research_hold";

  return Object.freeze({
    schemaVersion: 1,
    market: "CRYPTO_SPOT",
    exchange: "UPBIT",
    status,
    researchOnly: true,
    liveExecutionAllowed: false,
    privateAccountRequestAllowed: false,
    longOnly: true,
    selectedFamily: selected.params.family,
    selectionContract: Object.freeze({
      gridCandidates: grid.length,
      validationFinalists: finalists.length,
      seedTestUsedForSelection: false,
      unseenHoldoutUsedForSelection: false,
      familySelectedOnValidationOnly: true,
      futureWindowsUsedForSelection: false,
    }),
    costAssumptions: Object.freeze({ costRatePerSide, stressMultiplier, stressedCostRatePerSide: costRatePerSide * stressMultiplier }),
    params: selected.params,
    train: selected.train,
    validation: selected.validation,
    seedTest,
    stressedSeedTest,
    unseenHoldout: holdout,
    stressedUnseenHoldout: stressedHoldout,
    futureTimeRolling: rolling,
    gates: Object.freeze({ validationPassed, seedTestPassed, stressPassed, holdoutPassed, holdoutStressPassed, rollingPassed: rolling.passed }),
    limitations: Object.freeze([
      "strategy family was introduced after the prior breakout family failed, so adaptive research bias remains",
      "candle-only historical execution cannot reproduce full order-book depth",
      "future Shadow evidence is required before any execution promotion",
    ]),
  });
}
