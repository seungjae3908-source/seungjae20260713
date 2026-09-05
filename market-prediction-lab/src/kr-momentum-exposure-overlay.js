import { PredictionInputError } from "./contracts.js";
import { normalizeOptimizerCandles } from "./stock-swing-optimizer.js";
import { buildKrMomentumSegments } from "./kr-cross-sectional-momentum.js";
import {
  KR_MOMENTUM_SIGNAL_CANDIDATE,
  KR_MOMENTUM_SIGNAL_CANDIDATE_SHA256,
} from "./kr-momentum-risk-overlay-candidate.js";

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function stddev(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1));
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

function atr(candles, endIndex, period = 14) {
  if (endIndex < period) return null;
  let total = 0;
  for (let index = endIndex - period + 1; index <= endIndex; index += 1) {
    if (index <= 0) return null;
    total += trueRange(candles[index], candles[index - 1].close);
  }
  return total / period;
}

function normalizeDatasets(raw, label) {
  if (!Array.isArray(raw) || raw.length < 4) throw new PredictionInputError(`${label} requires at least four datasets`);
  const seen = new Set();
  return Object.freeze(raw.map((dataset, index) => {
    const symbol = String(dataset?.symbol ?? "").trim();
    if (!/^\d{6}$/.test(symbol) || seen.has(symbol)) throw new PredictionInputError(`${label} symbols must be unique six-digit KR codes`, { index, symbol });
    seen.add(symbol);
    return Object.freeze({ symbol, candles: normalizeOptimizerCandles(dataset.candles) });
  }));
}

function alignDatasets(datasets) {
  const sets = datasets.map((dataset) => new Set(dataset.candles.map((row) => row.timestamp)));
  const timestamps = datasets[0].candles.map((row) => row.timestamp).filter((timestamp) => sets.every((set) => set.has(timestamp)));
  if (timestamps.length < 500) throw new PredictionInputError("KR overlay requires at least 500 common sessions", { commonSessions: timestamps.length });
  const candlesBySymbol = Object.fromEntries(datasets.map((dataset) => {
    const byTime = new Map(dataset.candles.map((row) => [row.timestamp, row]));
    return [dataset.symbol, Object.freeze(timestamps.map((timestamp) => byTime.get(timestamp)))];
  }));
  return Object.freeze({ timestamps: Object.freeze(timestamps), candlesBySymbol: Object.freeze(candlesBySymbol) });
}

function rankAt(aligned, symbols, index) {
  const params = KR_MOMENTUM_SIGNAL_CANDIDATE.frozenSignalParams;
  const rows = [];
  for (const symbol of symbols) {
    const candles = aligned.candlesBySymbol[symbol];
    const priorIndex = index - params.momentumLookback;
    if (priorIndex < 0) continue;
    const trendMa = sma(candles, index, params.trendMaPeriod);
    const signalAtr = atr(candles, index, 14);
    if (!(trendMa > 0 && signalAtr > 0 && candles[priorIndex].close > 0)) continue;
    const momentum = candles[index].close / candles[priorIndex].close - 1;
    if (momentum < params.minMomentum || candles[index].close <= trendMa) continue;
    rows.push(Object.freeze({ symbol, momentum, atr: signalAtr }));
  }
  rows.sort((a, b) => b.momentum - a.momentum || a.symbol.localeCompare(b.symbol));
  return Object.freeze(rows.slice(0, params.topCount));
}

function closePosition(position, rawExit, candle, reason, costRatePerSide) {
  const exitPrice = rawExit * (1 - costRatePerSide);
  const proceeds = position.quantity * exitPrice;
  const initialCost = position.quantity * position.entryPrice;
  return Object.freeze({
    proceeds,
    trade: Object.freeze({
      symbol: position.symbol,
      signalTimestamp: position.signalTimestamp,
      entryTimestamp: position.entryTimestamp,
      exitTimestamp: candle.timestamp,
      entryOpen: position.entryOpen,
      entryPrice: position.entryPrice,
      exitPrice,
      stopPrice: position.stopPrice,
      momentum: position.momentum,
      exitReason: reason,
      netReturn: initialCost > 0 ? proceeds / initialCost - 1 : 0,
    }),
  });
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
  });
}

export function simulateKrMomentumExposureOverlay(raw = {}) {
  const datasets = normalizeDatasets(raw.datasets, "datasets");
  const aligned = alignDatasets(datasets);
  const symbols = datasets.map((row) => row.symbol);
  const grossExposureFraction = Number(raw.grossExposureFraction);
  if (!Number.isFinite(grossExposureFraction) || grossExposureFraction <= 0 || grossExposureFraction > 1) throw new PredictionInputError("grossExposureFraction must be >0 and <=1");
  const costRatePerSide = Number(raw.costRatePerSide ?? 0.0025);
  if (!Number.isFinite(costRatePerSide) || costRatePerSide < 0 || costRatePerSide >= 0.05) throw new PredictionInputError("invalid KR overlay costRatePerSide");
  const initialCapital = Number(raw.initialCapital ?? 1_000_000);
  if (!(Number.isFinite(initialCapital) && initialCapital > 0)) throw new PredictionInputError("initialCapital must be positive");
  const params = KR_MOMENTUM_SIGNAL_CANDIDATE.frozenSignalParams;
  const warmup = Math.max(params.momentumLookback, params.trendMaPeriod, 14) + 1;
  const startIndex = Math.max(warmup, Number.isInteger(raw.startIndex) ? raw.startIndex : warmup);
  const endIndex = Math.min(aligned.timestamps.length - 1, Number.isInteger(raw.endIndex) ? raw.endIndex : aligned.timestamps.length - 1);
  if (endIndex <= startIndex + 2) throw new PredictionInputError("KR overlay segment is too short");

  let cash = initialCapital;
  const positions = new Map();
  const trades = [];
  const exposureSamples = [];
  let pending = null;
  let peak = initialCapital;
  let maximumDrawdown = 0;
  let rebalanceCount = 0;

  for (let index = startIndex; index <= endIndex; index += 1) {
    if (pending?.entryIndex === index) {
      for (const position of [...positions.values()]) {
        const candle = aligned.candlesBySymbol[position.symbol][index];
        const closed = closePosition(position, candle.open, candle, "rebalance", costRatePerSide);
        cash += closed.proceeds;
        trades.push(closed.trade);
        positions.delete(position.symbol);
      }
      const selections = pending.selections;
      if (selections.length) {
        const investable = cash * grossExposureFraction;
        const sleeve = investable / selections.length;
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
            entryOpen: candle.open,
            entryPrice,
            quantity,
            stopPrice,
            momentum: selection.momentum,
          }));
        }
        cash = Math.max(0, cash - committed);
      }
      pending = null;
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
        const closed = closePosition(position, rawExit, candle, reason, costRatePerSide);
        cash += closed.proceeds;
        trades.push(closed.trade);
        positions.delete(position.symbol);
      }
    }

    let markedPositions = 0;
    for (const position of positions.values()) {
      const close = aligned.candlesBySymbol[position.symbol][index].close;
      markedPositions += position.quantity * close * (1 - costRatePerSide);
    }
    const equity = cash + markedPositions;
    peak = Math.max(peak, equity);
    maximumDrawdown = Math.max(maximumDrawdown, peak > 0 ? (peak - equity) / peak : 0);
    exposureSamples.push(equity > 0 ? markedPositions / equity : 0);

    if ((index - startIndex) % params.rebalanceBars === 0 && index < endIndex) {
      pending = Object.freeze({ entryIndex: index + 1, selections: rankAt(aligned, symbols, index) });
    }
  }

  for (const position of [...positions.values()]) {
    const candle = aligned.candlesBySymbol[position.symbol][endIndex];
    const closed = closePosition(position, candle.close, candle, "terminal", costRatePerSide);
    cash += closed.proceeds;
    trades.push(closed.trade);
  }
  const tradeMetrics = summarizeTrades(trades);
  return Object.freeze({
    schemaVersion: 1,
    candidateId: KR_MOMENTUM_SIGNAL_CANDIDATE.id,
    candidateManifestSha256: KR_MOMENTUM_SIGNAL_CANDIDATE_SHA256,
    grossExposureFraction,
    costRatePerSide,
    signalParams: params,
    segment: Object.freeze({ startIndex, endIndex, startTimestamp: aligned.timestamps[startIndex], endTimestamp: aligned.timestamps[endIndex] }),
    trades: Object.freeze(trades),
    metrics: Object.freeze({
      ...tradeMetrics,
      netReturn: cash / initialCapital - 1,
      finalEquity: cash,
      maxDrawdown: maximumDrawdown,
      averageGrossExposure: mean(exposureSamples),
      rebalanceCount,
    }),
    safeguards: Object.freeze({ researchOnly: true, actualOrders: 0, liveExecutionAllowed: false }),
  });
}

function passGate(result, minimumTrades = 10) {
  const metrics = result.metrics;
  return metrics.tradeCount >= minimumTrades
    && metrics.netReturn > 0
    && metrics.expectancy > 0
    && metrics.profitFactor >= 1.05
    && metrics.maxDrawdown <= 0.30;
}

function evaluateSegment(datasets, exposure, segmentName, costRatePerSide, multiplier = 1) {
  const aligned = alignDatasets(normalizeDatasets(datasets, "datasets"));
  const segment = buildKrMomentumSegments(aligned.timestamps.length)[segmentName];
  return simulateKrMomentumExposureOverlay({
    datasets,
    grossExposureFraction: exposure,
    costRatePerSide: costRatePerSide * multiplier,
    ...segment,
  });
}

function rollingAudit(datasets, exposure, costRatePerSide, count = 4) {
  const aligned = alignDatasets(normalizeDatasets(datasets, "datasets"));
  const total = aligned.timestamps.length;
  const params = KR_MOMENTUM_SIGNAL_CANDIDATE.frozenSignalParams;
  const warmup = Math.max(params.momentumLookback, params.trendMaPeriod, 14) + 1;
  const usableStart = Math.max(warmup, Math.floor(total * 0.5));
  const span = total - usableStart;
  const windowSize = Math.max(120, Math.floor(span / count));
  const windows = [];
  for (let index = 0; index < count; index += 1) {
    const startIndex = usableStart + index * windowSize;
    const endIndex = index === count - 1 ? total - 1 : Math.min(total - 1, startIndex + windowSize - 1);
    if (endIndex - startIndex < 80) continue;
    const simulation = simulateKrMomentumExposureOverlay({ datasets, grossExposureFraction: exposure, costRatePerSide, startIndex, endIndex });
    windows.push(Object.freeze({ index, metrics: simulation.metrics, passed: passGate(simulation, 4) }));
  }
  return Object.freeze({ windows: Object.freeze(windows), positiveWindows: windows.filter((row) => row.passed).length, windowCount: windows.length, exposureRetunedPerWindow: false });
}

export function optimizeKrMomentumExposureOverlay(raw = {}) {
  const designDatasets = normalizeDatasets(raw.designDatasets, "designDatasets");
  const holdoutDatasets = normalizeDatasets(raw.holdoutDatasets, "holdoutDatasets");
  const designSymbols = designDatasets.map((row) => row.symbol);
  const holdoutSymbols = holdoutDatasets.map((row) => row.symbol);
  const prior = new Set(KR_MOMENTUM_SIGNAL_CANDIDATE.priorResearchSymbols);
  if ([...designSymbols, ...holdoutSymbols].some((symbol) => prior.has(symbol))) throw new PredictionInputError("risk overlay symbols must not reuse prior KR research symbols");
  if (designSymbols.some((symbol) => holdoutSymbols.includes(symbol))) throw new PredictionInputError("risk overlay design and holdout symbols must not overlap");
  const registeredDesign = [...KR_MOMENTUM_SIGNAL_CANDIDATE.overlayDesignSymbols];
  const registeredHoldout = [...KR_MOMENTUM_SIGNAL_CANDIDATE.overlayHoldoutSymbols];
  if (JSON.stringify(designSymbols) !== JSON.stringify(registeredDesign) || JSON.stringify(holdoutSymbols) !== JSON.stringify(registeredHoldout)) {
    throw new PredictionInputError("risk overlay universe must match the preregistered fresh symbols");
  }
  const costRatePerSide = Number(raw.costRatePerSide ?? 0.0025);
  const stressMultiplier = Number(raw.stressMultiplier ?? 1.5);
  const exposures = [...KR_MOMENTUM_SIGNAL_CANDIDATE.overlaySearch.grossExposureFraction];
  const candidates = exposures.map((exposure) => Object.freeze({
    exposure,
    train: evaluateSegment(designDatasets, exposure, "train", costRatePerSide),
    validation: evaluateSegment(designDatasets, exposure, "validation", costRatePerSide),
  }));
  const passingValidation = candidates.filter((candidate) => passGate(candidate.validation, 10));
  const selected = [...(passingValidation.length ? passingValidation : candidates)].sort((left, right) => {
    if (left.validation.metrics.netReturn !== right.validation.metrics.netReturn) return right.validation.metrics.netReturn - left.validation.metrics.netReturn;
    if (left.validation.metrics.maxDrawdown !== right.validation.metrics.maxDrawdown) return left.validation.metrics.maxDrawdown - right.validation.metrics.maxDrawdown;
    return left.exposure - right.exposure;
  })[0];
  if (!selected) throw new PredictionInputError("risk overlay could not select an exposure");

  const designTest = evaluateSegment(designDatasets, selected.exposure, "test", costRatePerSide);
  const stressedDesignTest = evaluateSegment(designDatasets, selected.exposure, "test", costRatePerSide, stressMultiplier);
  const holdoutTest = evaluateSegment(holdoutDatasets, selected.exposure, "test", costRatePerSide);
  const stressedHoldout = evaluateSegment(holdoutDatasets, selected.exposure, "test", costRatePerSide, stressMultiplier);
  const rolling = rollingAudit(holdoutDatasets, selected.exposure, costRatePerSide, 4);
  const validationPassed = passGate(selected.validation, 10);
  const designTestPassed = passGate(designTest, 10);
  const stressPassed = passGate(stressedDesignTest, 10);
  const holdoutPassed = passGate(holdoutTest, 10);
  const holdoutStressPassed = passGate(stressedHoldout, 10);
  const rollingPassed = rolling.windowCount >= 3 && rolling.positiveWindows >= Math.ceil(rolling.windowCount * 0.75);
  const status = validationPassed && designTestPassed && stressPassed && holdoutPassed && holdoutStressPassed && rollingPassed
    ? "risk_controlled_cross_symbol_candidate"
    : "research_hold";

  return Object.freeze({
    schemaVersion: 1,
    market: "KR_STOCK",
    strategy: "cross_sectional_relative_strength_with_cash_reserve",
    status,
    candidateId: KR_MOMENTUM_SIGNAL_CANDIDATE.id,
    candidateManifestSha256: KR_MOMENTUM_SIGNAL_CANDIDATE_SHA256,
    selectedGrossExposureFraction: selected.exposure,
    signalParams: KR_MOMENTUM_SIGNAL_CANDIDATE.frozenSignalParams,
    train: selected.train,
    validation: selected.validation,
    designTest,
    stressedDesignTest,
    holdoutTest,
    stressedHoldout,
    rolling,
    gates: Object.freeze({ validationPassed, designTestPassed, stressPassed, holdoutPassed, holdoutStressPassed, rollingPassed }),
    selectionContract: Object.freeze({
      signalParametersRetuned: false,
      searchedDimension: "grossExposureFraction_only",
      exposureCandidates: Object.freeze(exposures),
      sourceHoldoutUsedForSelection: false,
      overlayHoldoutUsedForSelection: false,
      designTestUsedForSelection: false,
      rollingUsedForSelection: false,
    }),
    designSymbols: Object.freeze(designSymbols),
    holdoutSymbols: Object.freeze(holdoutSymbols),
    safeguards: Object.freeze({ researchOnly: true, liveExecutionAllowed: false, privateAccountRequestAllowed: false, actualOrders: 0 }),
    limitations: Object.freeze([
      "current-symbol Yahoo history is not a point-in-time investable universe",
      "delisted-name survivorship coverage remains missing",
      "fractional-share research sizing ignores KR integer share rounding",
      "future Shadow validation remains required",
    ]),
  });
}
