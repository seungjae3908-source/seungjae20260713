import { PredictionInputError } from "./contracts.js";
import { normalizeOptimizerCandles } from "./stock-swing-optimizer.js";

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function stddev(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1));
}

function trueRange(candle, previousClose) {
  return Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
}

function sma(candles, endIndex, period) {
  const start = endIndex - period + 1;
  if (start < 0) return null;
  let total = 0;
  for (let index = start; index <= endIndex; index += 1) total += candles[index].close;
  return total / period;
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

function normalizeParams(raw = {}) {
  const params = {
    momentumLookback: Number(raw.momentumLookback ?? 120),
    trendMaPeriod: Number(raw.trendMaPeriod ?? 200),
    topCount: Number(raw.topCount ?? 2),
    rebalanceBars: Number(raw.rebalanceBars ?? 20),
    atrPeriod: 14,
    stopAtrMultiple: Number(raw.stopAtrMultiple ?? 3.5),
    minMomentum: Number(raw.minMomentum ?? 0),
  };
  for (const name of ["momentumLookback", "trendMaPeriod", "topCount", "rebalanceBars", "atrPeriod"]) {
    if (!Number.isInteger(params[name]) || params[name] < 1 || params[name] > 260) throw new PredictionInputError(`invalid ${name}`, { value: params[name] });
  }
  if (!(params.topCount >= 1 && params.topCount <= 10)) throw new PredictionInputError("topCount must be 1..10");
  if (!(params.stopAtrMultiple >= 1 && params.stopAtrMultiple <= 8)) throw new PredictionInputError("stopAtrMultiple must be 1..8");
  if (!Number.isFinite(params.minMomentum) || params.minMomentum < -0.5 || params.minMomentum > 1) throw new PredictionInputError("invalid minMomentum");
  return Object.freeze(params);
}

function normalizeDatasets(raw, label = "datasets") {
  if (!Array.isArray(raw) || raw.length < 4) throw new PredictionInputError(`${label} requires at least four datasets`);
  const seen = new Set();
  return Object.freeze(raw.map((dataset, index) => {
    const symbol = String(dataset?.symbol ?? "").trim().toUpperCase();
    if (!/^\d{6}$/.test(symbol) || seen.has(symbol)) throw new PredictionInputError(`${label} symbols must be unique six-digit KR codes`, { index, symbol });
    seen.add(symbol);
    return Object.freeze({ symbol, candles: normalizeOptimizerCandles(dataset.candles) });
  }));
}

function alignDatasets(datasets) {
  const timestampSets = datasets.map((dataset) => new Set(dataset.candles.map((row) => row.timestamp)));
  const commonTimestamps = datasets[0].candles
    .map((row) => row.timestamp)
    .filter((timestamp) => timestampSets.every((set) => set.has(timestamp)));
  if (commonTimestamps.length < 500) throw new PredictionInputError("KR cross-sectional datasets need at least 500 common sessions", { commonSessions: commonTimestamps.length });
  const aligned = Object.fromEntries(datasets.map((dataset) => {
    const byTimestamp = new Map(dataset.candles.map((row) => [row.timestamp, row]));
    return [dataset.symbol, Object.freeze(commonTimestamps.map((timestamp) => byTimestamp.get(timestamp)))];
  }));
  return Object.freeze({ timestamps: Object.freeze(commonTimestamps), candlesBySymbol: Object.freeze(aligned) });
}

export function buildKrMomentumSegments(sessionCount, raw = {}) {
  if (!Number.isInteger(sessionCount) || sessionCount < 500) throw new PredictionInputError("sessionCount must be at least 500");
  const trainRatio = Number(raw.trainRatio ?? 0.6);
  const validationRatio = Number(raw.validationRatio ?? 0.2);
  if (!(trainRatio > 0.45 && trainRatio < 0.75) || !(validationRatio >= 0.15 && validationRatio <= 0.25) || trainRatio + validationRatio >= 0.9) {
    throw new PredictionInputError("invalid KR momentum split ratios");
  }
  const trainEnd = Math.floor(sessionCount * trainRatio) - 1;
  const validationEnd = Math.floor(sessionCount * (trainRatio + validationRatio)) - 1;
  return Object.freeze({
    train: Object.freeze({ startIndex: 0, endIndex: trainEnd }),
    validation: Object.freeze({ startIndex: trainEnd + 1, endIndex: validationEnd }),
    test: Object.freeze({ startIndex: validationEnd + 1, endIndex: sessionCount - 1 }),
  });
}

function rankAt(candlesBySymbol, symbols, index, params) {
  const ranked = [];
  for (const symbol of symbols) {
    const candles = candlesBySymbol[symbol];
    const priorIndex = index - params.momentumLookback;
    if (priorIndex < 0) continue;
    const current = candles[index];
    const prior = candles[priorIndex];
    const trendMa = sma(candles, index, params.trendMaPeriod);
    const signalAtr = atr(candles, index, params.atrPeriod);
    if (!(trendMa > 0 && signalAtr > 0 && prior.close > 0)) continue;
    const momentum = current.close / prior.close - 1;
    if (momentum < params.minMomentum || current.close <= trendMa) continue;
    ranked.push(Object.freeze({ symbol, momentum, atr: signalAtr, signalClose: current.close }));
  }
  ranked.sort((a, b) => b.momentum - a.momentum || a.symbol.localeCompare(b.symbol));
  return Object.freeze(ranked.slice(0, params.topCount));
}

function summarizeTrades(trades) {
  const returns = trades.map((trade) => trade.netReturn).filter(Number.isFinite);
  const wins = returns.filter((value) => value > 0);
  const losses = returns.filter((value) => value < 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  const expectancy = mean(returns);
  const deviation = stddev(returns);
  return Object.freeze({
    tradeCount: returns.length,
    winRate: returns.length ? wins.length / returns.length : 0,
    expectancy,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Number.POSITIVE_INFINITY : 0,
    sharpeLike: deviation > 0 ? expectancy / deviation * Math.sqrt(Math.max(1, returns.length)) : 0,
    averageHoldBars: trades.length ? trades.reduce((sum, trade) => sum + trade.holdBars, 0) / trades.length : 0,
  });
}

function equityValue(cash, positions, candlesBySymbol, index, costRatePerSide) {
  let total = cash;
  for (const position of positions.values()) {
    const close = candlesBySymbol[position.symbol][index].close;
    total += position.quantity * close * (1 - costRatePerSide);
  }
  return total;
}

function closePosition(position, rawExit, exitIndex, reason, costRatePerSide, candlesBySymbol) {
  const exitPrice = rawExit * (1 - costRatePerSide);
  const proceeds = position.quantity * exitPrice;
  const initialCost = position.quantity * position.entryPrice;
  const netReturn = initialCost > 0 ? proceeds / initialCost - 1 : 0;
  return Object.freeze({
    trade: Object.freeze({
      symbol: position.symbol,
      signalTimestamp: position.signalTimestamp,
      entryTimestamp: position.entryTimestamp,
      exitTimestamp: candlesBySymbol[position.symbol][exitIndex].timestamp,
      entryOpen: position.entryOpen,
      entryPrice: position.entryPrice,
      exitPrice,
      stopPrice: position.stopPrice,
      momentum: position.momentum,
      holdBars: exitIndex - position.entryIndex + 1,
      exitReason: reason,
      netReturn,
    }),
    proceeds,
  });
}

export function simulateKrCrossSectionalMomentum(raw = {}) {
  const datasets = normalizeDatasets(raw.datasets);
  const params = normalizeParams(raw.params);
  if (params.topCount >= datasets.length) throw new PredictionInputError("topCount must be smaller than dataset count");
  const costRatePerSide = Number(raw.costRatePerSide ?? 0.0025);
  if (!Number.isFinite(costRatePerSide) || costRatePerSide < 0 || costRatePerSide >= 0.05) throw new PredictionInputError("invalid KR momentum costRatePerSide");
  const initialCapital = Number(raw.initialCapital ?? 1_000_000);
  if (!(initialCapital > 0 && Number.isFinite(initialCapital))) throw new PredictionInputError("initialCapital must be positive");
  const aligned = alignDatasets(datasets);
  const symbols = datasets.map((dataset) => dataset.symbol);
  const warmup = Math.max(params.momentumLookback, params.trendMaPeriod, params.atrPeriod) + 1;
  const startIndex = Math.max(warmup, Number.isInteger(raw.startIndex) ? raw.startIndex : warmup);
  const endIndex = Math.min(aligned.timestamps.length - 1, Number.isInteger(raw.endIndex) ? raw.endIndex : aligned.timestamps.length - 1);
  if (endIndex <= startIndex + 2) return Object.freeze({ params, costRatePerSide, alignedSessions: aligned.timestamps.length, trades: Object.freeze([]), metrics: Object.freeze({ ...summarizeTrades([]), netReturn: 0, maxDrawdown: 0, finalEquity: initialCapital, rebalanceCount: 0, selectedSymbolCount: 0 }) });

  let cash = initialCapital;
  const positions = new Map();
  const trades = [];
  let rebalanceCount = 0;
  const selectedSymbols = new Set();
  let peakEquity = initialCapital;
  let maxDrawdown = 0;
  let pendingSelection = null;

  for (let index = startIndex; index <= endIndex; index += 1) {
    if (pendingSelection && pendingSelection.entryIndex === index) {
      for (const position of [...positions.values()]) {
        const candle = aligned.candlesBySymbol[position.symbol][index];
        const closed = closePosition(position, candle.open, index, "rebalance", costRatePerSide, aligned.candlesBySymbol);
        cash += closed.proceeds;
        trades.push(closed.trade);
        positions.delete(position.symbol);
      }
      const selections = pendingSelection.selections;
      if (selections.length) {
        const sleeve = cash / selections.length;
        let committed = 0;
        for (const selection of selections) {
          const candle = aligned.candlesBySymbol[selection.symbol][index];
          const entryPrice = candle.open * (1 + costRatePerSide);
          const quantity = sleeve / entryPrice;
          const stopPrice = candle.open - selection.atr * params.stopAtrMultiple;
          if (!(quantity > 0 && stopPrice > 0)) continue;
          const spent = quantity * entryPrice;
          committed += spent;
          positions.set(selection.symbol, Object.freeze({
            symbol: selection.symbol,
            signalTimestamp: aligned.timestamps[index - 1],
            entryTimestamp: candle.timestamp,
            entryIndex: index,
            entryOpen: candle.open,
            entryPrice,
            quantity,
            stopPrice,
            momentum: selection.momentum,
          }));
          selectedSymbols.add(selection.symbol);
        }
        cash = Math.max(0, cash - committed);
      }
      pendingSelection = null;
      rebalanceCount += 1;
    }

    for (const position of [...positions.values()]) {
      const candle = aligned.candlesBySymbol[position.symbol][index];
      let rawExit = null;
      let reason = null;
      if (candle.open <= position.stopPrice) {
        rawExit = candle.open;
        reason = "stop_gap";
      } else if (candle.low <= position.stopPrice) {
        rawExit = position.stopPrice;
        reason = "stop";
      }
      if (rawExit != null) {
        const closed = closePosition(position, rawExit, index, reason, costRatePerSide, aligned.candlesBySymbol);
        cash += closed.proceeds;
        trades.push(closed.trade);
        positions.delete(position.symbol);
      }
    }

    const equity = equityValue(cash, positions, aligned.candlesBySymbol, index, costRatePerSide);
    peakEquity = Math.max(peakEquity, equity);
    if (peakEquity > 0) maxDrawdown = Math.max(maxDrawdown, (peakEquity - equity) / peakEquity);

    const barsFromStart = index - startIndex;
    const isSignalDay = barsFromStart % params.rebalanceBars === 0;
    if (isSignalDay && index < endIndex) {
      pendingSelection = Object.freeze({
        entryIndex: index + 1,
        selections: rankAt(aligned.candlesBySymbol, symbols, index, params),
      });
    }
  }

  for (const position of [...positions.values()]) {
    const candle = aligned.candlesBySymbol[position.symbol][endIndex];
    const closed = closePosition(position, candle.close, endIndex, "terminal", costRatePerSide, aligned.candlesBySymbol);
    cash += closed.proceeds;
    trades.push(closed.trade);
    positions.delete(position.symbol);
  }
  const finalEquity = cash;
  const tradeMetrics = summarizeTrades(trades);
  return Object.freeze({
    params,
    costRatePerSide,
    initialCapital,
    alignedSessions: aligned.timestamps.length,
    segment: Object.freeze({ startIndex, endIndex, startTimestamp: aligned.timestamps[startIndex], endTimestamp: aligned.timestamps[endIndex] }),
    trades: Object.freeze(trades),
    metrics: Object.freeze({
      ...tradeMetrics,
      netReturn: finalEquity / initialCapital - 1,
      maxDrawdown,
      finalEquity,
      rebalanceCount,
      selectedSymbolCount: selectedSymbols.size,
    }),
  });
}

export function expandKrMomentumGrid(raw = {}) {
  const values = {
    momentumLookback: raw.momentumLookback ?? [60, 120, 180],
    trendMaPeriod: raw.trendMaPeriod ?? [100, 200],
    topCount: raw.topCount ?? [2, 3],
    rebalanceBars: raw.rebalanceBars ?? [20, 40],
    stopAtrMultiple: raw.stopAtrMultiple ?? [2.5, 3.5],
  };
  const result = [];
  for (const momentumLookback of values.momentumLookback)
    for (const trendMaPeriod of values.trendMaPeriod)
      for (const topCount of values.topCount)
        for (const rebalanceBars of values.rebalanceBars)
          for (const stopAtrMultiple of values.stopAtrMultiple) result.push(Object.freeze({
            momentumLookback,
            trendMaPeriod,
            topCount,
            rebalanceBars,
            stopAtrMultiple,
            minMomentum: 0,
          }));
  return Object.freeze(result);
}

function passGate(result, minimumTrades) {
  const metrics = result.metrics;
  return metrics.tradeCount >= minimumTrades
    && metrics.netReturn > 0
    && metrics.expectancy > 0
    && metrics.profitFactor >= 1.05
    && metrics.maxDrawdown <= 0.35;
}

function compareResults(left, right) {
  const leftPass = passGate(left, 12);
  const rightPass = passGate(right, 12);
  if (leftPass !== rightPass) return leftPass ? -1 : 1;
  if ((left.metrics.profitFactor ?? 0) !== (right.metrics.profitFactor ?? 0)) return (right.metrics.profitFactor ?? 0) - (left.metrics.profitFactor ?? 0);
  if (left.metrics.expectancy !== right.metrics.expectancy) return right.metrics.expectancy - left.metrics.expectancy;
  if (left.metrics.netReturn !== right.metrics.netReturn) return right.metrics.netReturn - left.metrics.netReturn;
  if (left.metrics.maxDrawdown !== right.metrics.maxDrawdown) return left.metrics.maxDrawdown - right.metrics.maxDrawdown;
  return JSON.stringify(left.params).localeCompare(JSON.stringify(right.params));
}

function evaluateSegment(datasets, params, segmentName, costRatePerSide, multiplier = 1) {
  const aligned = alignDatasets(normalizeDatasets(datasets));
  const segment = buildKrMomentumSegments(aligned.timestamps.length)[segmentName];
  return simulateKrCrossSectionalMomentum({ datasets, params, costRatePerSide: costRatePerSide * multiplier, ...segment });
}

function rollingAudit(datasets, params, costRatePerSide, count = 4) {
  const aligned = alignDatasets(normalizeDatasets(datasets));
  const total = aligned.timestamps.length;
  const warmup = Math.max(params.momentumLookback, params.trendMaPeriod, 14) + 1;
  const usableStart = Math.max(warmup, Math.floor(total * 0.5));
  const span = total - usableStart;
  const windowSize = Math.max(120, Math.floor(span / count));
  const windows = [];
  for (let index = 0; index < count; index += 1) {
    const startIndex = usableStart + index * windowSize;
    const endIndex = index === count - 1 ? total - 1 : Math.min(total - 1, startIndex + windowSize - 1);
    if (endIndex - startIndex < 80) continue;
    const simulation = simulateKrCrossSectionalMomentum({ datasets, params, costRatePerSide, startIndex, endIndex });
    windows.push(Object.freeze({ index, startIndex, endIndex, metrics: simulation.metrics, passed: passGate(simulation, 4) }));
  }
  return Object.freeze({ windows: Object.freeze(windows), positiveWindows: windows.filter((row) => row.passed).length, windowCount: windows.length, parametersRetunedPerWindow: false });
}

export function optimizeKrCrossSectionalMomentum(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PredictionInputError("KR momentum optimizer input must be an object");
  const designDatasets = normalizeDatasets(raw.designDatasets, "designDatasets");
  const holdoutDatasets = normalizeDatasets(raw.holdoutDatasets, "holdoutDatasets");
  const overlap = designDatasets.some((left) => holdoutDatasets.some((right) => left.symbol === right.symbol));
  if (overlap) throw new PredictionInputError("KR momentum design and holdout symbols must not overlap");
  const costRatePerSide = Number(raw.costRatePerSide ?? 0.0025);
  const stressMultiplier = Number(raw.stressMultiplier ?? 1.5);
  if (!Number.isFinite(costRatePerSide) || costRatePerSide < 0 || costRatePerSide >= 0.05) throw new PredictionInputError("invalid KR momentum cost");
  if (!Number.isFinite(stressMultiplier) || stressMultiplier < 1 || stressMultiplier > 3) throw new PredictionInputError("invalid KR momentum stress multiplier");
  const grid = expandKrMomentumGrid(raw.grid);
  if (!grid.length || grid.length > 200) throw new PredictionInputError("KR momentum grid must contain 1..200 candidates");

  const trained = grid.map((params) => ({ params, simulation: evaluateSegment(designDatasets, params, "train", costRatePerSide) }))
    .sort((left, right) => compareResults(left.simulation, right.simulation));
  const finalists = trained.slice(0, Math.min(16, trained.length)).map((candidate) => ({
    params: candidate.params,
    train: candidate.simulation,
    validation: evaluateSegment(designDatasets, candidate.params, "validation", costRatePerSide),
  })).sort((left, right) => compareResults(left.validation, right.validation));
  const selected = finalists.find((candidate) => passGate(candidate.validation, 10)) ?? finalists[0];
  if (!selected) throw new PredictionInputError("KR momentum optimizer could not select a candidate");

  const designTest = evaluateSegment(designDatasets, selected.params, "test", costRatePerSide);
  const stressedDesignTest = evaluateSegment(designDatasets, selected.params, "test", costRatePerSide, stressMultiplier);
  const holdoutTest = evaluateSegment(holdoutDatasets, selected.params, "test", costRatePerSide);
  const stressedHoldout = evaluateSegment(holdoutDatasets, selected.params, "test", costRatePerSide, stressMultiplier);
  const rolling = rollingAudit(holdoutDatasets, selected.params, costRatePerSide, 4);
  const validationPassed = passGate(selected.validation, 10);
  const designTestPassed = passGate(designTest, 10);
  const stressPassed = passGate(stressedDesignTest, 10);
  const holdoutPassed = passGate(holdoutTest, 10);
  const holdoutStressPassed = passGate(stressedHoldout, 10);
  const rollingPassed = rolling.windowCount >= 3 && rolling.positiveWindows >= Math.ceil(rolling.windowCount * 0.75);
  const status = validationPassed && designTestPassed && stressPassed && holdoutPassed && holdoutStressPassed && rollingPassed
    ? "cross_symbol_research_candidate"
    : "research_hold";

  return Object.freeze({
    schemaVersion: 1,
    market: "KR_STOCK",
    strategy: "cross_sectional_relative_strength",
    status,
    researchOnly: true,
    liveExecutionAllowed: false,
    privateAccountRequestAllowed: false,
    selectionContract: Object.freeze({
      gridCandidates: grid.length,
      validationFinalists: finalists.length,
      scalarWeightedScoreUsed: false,
      deterministicLexicographicSelection: ["gate", "profitFactor", "expectancy", "netReturn", "maxDrawdown"],
      designTestUsedForSelection: false,
      holdoutUsedForSelection: false,
      holdoutStressUsedForSelection: false,
      rollingUsedForSelection: false,
      parametersRetunedOnHoldout: false,
    }),
    costAssumptions: Object.freeze({ costRatePerSide, stressMultiplier, stressedCostRatePerSide: costRatePerSide * stressMultiplier, note: "research all-in per-side cost assumption, not a broker fee schedule" }),
    params: selected.params,
    train: selected.train,
    validation: selected.validation,
    designTest,
    stressedDesignTest,
    holdoutTest,
    stressedHoldout,
    rolling,
    gates: Object.freeze({ validationPassed, designTestPassed, stressPassed, holdoutPassed, holdoutStressPassed, rollingPassed }),
    designSymbols: Object.freeze(designDatasets.map((row) => row.symbol)),
    holdoutSymbols: Object.freeze(holdoutDatasets.map((row) => row.symbol)),
    limitations: Object.freeze([
      "current-symbol history is not a point-in-time investable universe",
      "delisted-name survivorship coverage is not integrated",
      "fractional-share research sizing ignores KR board-lot integer rounding",
      "public daily OHLC uses stop-first/gap-conservative exits and cannot reconstruct intraday path",
      "future Shadow validation remains required before any execution promotion",
    ]),
    safeguards: Object.freeze({ actualOrders: 0, privateAccountRequests: 0, liveExecutionAllowed: false }),
  });
}
