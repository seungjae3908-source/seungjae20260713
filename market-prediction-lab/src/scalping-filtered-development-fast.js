import {
  DEFAULT_RISK_MODEL,
  RESEARCH_BACKTEST_PERIOD,
  ZERO_COST_MODEL,
  calculateV1Signal,
} from "./multi-market-backtest-engine.js";
import { calculateExecutionAwareTrade, summarizeResearchPerformance } from "./research-validation-layer.js";
import { calculateV3SignalFeatures } from "./v3-market-filter-optimizer.js";
import { calculateV4SignalFeatures } from "./v4-momentum-regime-optimizer.js";
import { calculateV5SignalFeatures } from "./v5-price-structure-optimizer.js";

const EPSILON = 1e-9;
const V4_REGIME_EMA_PERIOD = 200;
const V4_RSI_PERIOD = 14;
const V4_MACD_FAST = 12;
const V4_MACD_SLOW = 26;
const V4_MACD_SIGNAL = 9;
const PREPARED_CONTEXT_CACHE = new WeakMap();

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

function rsiSeries(values, period = V4_RSI_PERIOD) {
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
  const fast = emaSeries(values, V4_MACD_FAST);
  const slow = emaSeries(values, V4_MACD_SLOW);
  const macd = new Array(values.length).fill(null);
  for (let index = V4_MACD_SLOW - 1; index < values.length; index += 1) {
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
  const signalCompact = emaSeries(available, V4_MACD_SIGNAL);
  const histogram = new Array(values.length).fill(null);
  for (let compactIndex = 0; compactIndex < indexes.length; compactIndex += 1) {
    const fullIndex = indexes[compactIndex];
    if (Number.isFinite(signalCompact[compactIndex])) histogram[fullIndex] = macd[fullIndex] - signalCompact[compactIndex];
  }
  return histogram;
}

function buildIndicators(candles, parameters, version) {
  const closes = candles.map((candle) => candle.close);
  const base = {
    fast: Object.freeze(emaSeries(closes, parameters.fastPeriod)),
    slow: Object.freeze(emaSeries(closes, parameters.slowPeriod)),
    atr: Object.freeze(atrSeries(candles, parameters.atrPeriod)),
  };
  if (version !== "V4") return Object.freeze(base);
  return Object.freeze({
    ...base,
    regime: Object.freeze(emaSeries(closes, V4_REGIME_EMA_PERIOD)),
    rsi: Object.freeze(rsiSeries(closes, V4_RSI_PERIOD)),
    macdHistogram: Object.freeze(macdHistogramSeries(closes)),
  });
}

function passesFilter({ version, side, candles, indicators, index, filter, preparedFeature }) {
  if (version === "V3") {
    const features = preparedFeature ?? calculateV3SignalFeatures({ candles, indicators, index });
    return features !== null
      && features.rvol + EPSILON >= filter.rvolMin
      && features.volumeExpansion + EPSILON >= filter.volumeExpansionMin
      && features.trendStrength + EPSILON >= filter.trendStrengthMin;
  }
  if (version === "V4") {
    const features = preparedFeature ?? calculateV4SignalFeatures({ side, candles, indicators, index });
    if (!features) return false;
    if (filter.requireRegimeAlignment && !features.regimeAligned) return false;
    if (features.emaSlopeAtr + EPSILON < filter.emaSlopeAtrMin) return false;
    if (features.directionalRsi + EPSILON < filter.rsiDirectionalThreshold) return false;
    if (features.directionalMacd <= EPSILON) return false;
    if (filter.macdMode === "accelerating" && features.macdAcceleration <= EPSILON) return false;
    return true;
  }
  if (version === "V5") {
    const structure = calculateV5SignalFeatures({ side, candles, indicators, index, filter });
    return structure?.structureConfirmed === true;
  }
  throw new TypeError(`unsupported fast filtered development version: ${version}`);
}

function roundQuantity(quantity, step) {
  if (step === null || step === undefined) return quantity;
  return Math.floor(quantity / step) * step;
}

function positionSize({ equity, entryPrice, stopPrice, riskModel }) {
  const stopDistance = Math.abs(entryPrice - stopPrice);
  if (!(equity > 0 && stopDistance > 0)) return 0;
  const riskBudget = equity * riskModel.riskPerTrade;
  const quantityByRisk = riskBudget / stopDistance;
  const maximumNotional = equity * riskModel.maximumCapitalFraction * riskModel.leverage;
  const quantityByCapital = maximumNotional / entryPrice;
  return roundQuantity(Math.min(quantityByRisk, quantityByCapital), riskModel.quantityStep);
}

function exitForCandle(position, candle) {
  if (position.side === "long") {
    if (candle.open <= position.stopPrice) return { price: candle.open, reason: "stop_loss_gap" };
    if (candle.open >= position.targetPrice) return { price: position.targetPrice, reason: "take_profit" };
    const stopHit = candle.low <= position.stopPrice;
    const targetHit = candle.high >= position.targetPrice;
    if (stopHit && targetHit) return { price: position.stopPrice, reason: "stop_loss_same_bar" };
    if (stopHit) return { price: position.stopPrice, reason: "stop_loss" };
    if (targetHit) return { price: position.targetPrice, reason: "take_profit" };
    return null;
  }
  if (candle.open >= position.stopPrice) return { price: candle.open, reason: "stop_loss_gap" };
  if (candle.open <= position.targetPrice) return { price: position.targetPrice, reason: "take_profit" };
  const stopHit = candle.high >= position.stopPrice;
  const targetHit = candle.low <= position.targetPrice;
  if (stopHit && targetHit) return { price: position.stopPrice, reason: "stop_loss_same_bar" };
  if (stopHit) return { price: position.stopPrice, reason: "stop_loss" };
  if (targetHit) return { price: position.targetPrice, reason: "take_profit" };
  return null;
}

function normalizeRiskModel(input = {}) {
  return Object.freeze({ ...DEFAULT_RISK_MODEL, ...(input ?? {}) });
}

function normalizeCostModel(input = {}) {
  const base = { ...ZERO_COST_MODEL, ...(input ?? {}) };
  const schedule = Array.isArray(input?.schedule)
    ? input.schedule.map((row) => Object.freeze({ ...base, ...row, schedule: undefined }))
    : [];
  return Object.freeze({ ...base, schedule: Object.freeze(schedule) });
}

function costAt(model, timestamp) {
  const matching = model.schedule.filter((row) => row.startTime <= timestamp && timestamp <= row.endTime);
  if (matching.length > 1) throw new Error("FAST_FILTERED_DEVELOPMENT_OVERLAPPING_COST_SCHEDULE");
  return matching[0] ?? model;
}

function fundingForTrade(rows, entryTime, exitTime) {
  return rows.filter((row) => row.timestamp > entryTime && row.timestamp <= exitTime).map((row) => row.rate);
}

function regimeAt(indicators, index) {
  const fast = indicators.fast[index];
  const slow = indicators.slow[index];
  if (!Number.isFinite(fast) || !Number.isFinite(slow)) return "insufficient";
  if (fast > slow) return "uptrend";
  if (fast < slow) return "downtrend";
  return "ranging";
}

function settle({ position, exit, exitCandle, costModel, fundingRates, equity }) {
  const entryCosts = costAt(costModel, position.entryTime);
  const exitCosts = costAt(costModel, exitCandle.timestamp);
  const execution = calculateExecutionAwareTrade({
    market: position.market,
    action: position.action,
    entryPrice: position.entryPrice,
    exitPrice: exit.price,
    quantity: position.quantity,
    leverage: position.leverage,
    entryFeeRate: entryCosts.entryFeeRate,
    exitFeeRate: exitCosts.exitFeeRate,
    taxRate: exitCosts.taxRate,
    slippageRate: Math.max(entryCosts.slippageRate, exitCosts.slippageRate),
    spreadRate: Math.max(entryCosts.spreadRate, exitCosts.spreadRate),
    latencyBars: Math.max(entryCosts.latencyBars, exitCosts.latencyBars),
    latencyDriftRate: Math.max(entryCosts.latencyDriftRate, exitCosts.latencyDriftRate),
    fundingRates: fundingForTrade(fundingRates, position.entryTime, exitCandle.timestamp),
  });
  return Object.freeze({
    id: `${position.market}:${position.symbol}:${position.entryTime}:${exitCandle.timestamp}:${position.side}`,
    market: position.market,
    symbol: position.symbol,
    strategy: `scalping_${position.version.toLowerCase()}_development_fast`,
    strategyVersion: position.version,
    timeframe: position.timeframe,
    side: position.side,
    action: position.action,
    regime: position.regime,
    phase: "development",
    signalTime: position.signalTime,
    entryTime: position.entryTime,
    exitTime: exitCandle.timestamp,
    entryPrice: position.entryPrice,
    requestedExitPrice: exit.price,
    stopPrice: position.stopPrice,
    targetPrice: position.targetPrice,
    quantity: position.quantity,
    leverage: position.leverage,
    riskBudget: position.riskBudget,
    exitReason: exit.reason,
    netPnl: execution.netPnl,
    grossPnl: execution.grossPnl,
    netReturnOnMargin: execution.netReturnOnMargin,
    entryNotional: execution.entryNotional,
    costsIncluded: true,
    costs: execution.costs,
    execution,
    equityBefore: equity,
    equityAfter: equity + execution.netPnl,
  });
}

function normalizedDevelopmentPeriod(period) {
  const normalizedPeriod = period ?? Object.freeze({
    startTime: RESEARCH_BACKTEST_PERIOD.startTime,
    endTime: RESEARCH_BACKTEST_PERIOD.developmentEndTime,
    includeFinalHoldout: false,
  });
  if (normalizedPeriod.includeFinalHoldout === true || normalizedPeriod.endTime >= RESEARCH_BACKTEST_PERIOD.finalHoldoutStartTime) {
    throw new Error("FAST_FILTERED_DEVELOPMENT_HOLDOUT_LOCKED");
  }
  return normalizedPeriod;
}

function contextCacheKey({ version, market, side, parameters, period, sourceCandles }) {
  return JSON.stringify({
    version,
    market,
    side,
    parameters,
    startTime: period.startTime,
    endTime: period.endTime,
    candleCount: sourceCandles.length,
    firstTimestamp: sourceCandles[0]?.timestamp ?? null,
    lastTimestamp: sourceCandles[sourceCandles.length - 1]?.timestamp ?? null,
  });
}

function prepareInvariantContext({ version, backtestInput, parameters, period }) {
  const sourceCandles = backtestInput.candles ?? [];
  if (!Array.isArray(sourceCandles) || sourceCandles.length === 0) throw new TypeError("historical candles required");
  const key = contextCacheKey({ version, market: backtestInput.market, side: backtestInput.side ?? "long", parameters, period, sourceCandles });
  let bucket = PREPARED_CONTEXT_CACHE.get(sourceCandles);
  if (!bucket) {
    bucket = new Map();
    PREPARED_CONTEXT_CACHE.set(sourceCandles, bucket);
  }
  const cached = bucket.get(key);
  if (cached) return cached;

  const candles = [...sourceCandles]
    .filter((candle) => candle.timestamp <= period.endTime)
    .sort((left, right) => left.timestamp - right.timestamp);
  if (candles.length === 0) throw new TypeError("historical candles required");
  const indicators = buildIndicators(candles, parameters, version);
  const market = backtestInput.market;
  const side = backtestInput.side ?? "long";
  const baseSignals = new Array(candles.length).fill(false);
  const filterFeatures = version === "V3" || version === "V4" ? new Array(candles.length).fill(null) : null;

  for (let index = 1; index < candles.length - 1; index += 1) {
    const candle = candles[index];
    if (candle.timestamp < period.startTime) continue;
    const baseSignal = calculateV1Signal({ market, side, candles, indicators, index, parameters });
    baseSignals[index] = baseSignal;
    if (!baseSignal || filterFeatures === null) continue;
    filterFeatures[index] = version === "V3"
      ? calculateV3SignalFeatures({ candles, indicators, index })
      : calculateV4SignalFeatures({ side, candles, indicators, index });
  }

  const context = Object.freeze({
    candles: Object.freeze(candles),
    indicators,
    baseSignals: Object.freeze(baseSignals),
    filterFeatures: filterFeatures === null ? null : Object.freeze(filterFeatures),
  });
  bucket.set(key, context);
  return context;
}

export function runFastFilteredDevelopment({ version, backtestInput, parameters, filter, period } = {}) {
  if (!["V3", "V4", "V5"].includes(version)) throw new TypeError("V3, V4 or V5 required");
  if (!backtestInput || typeof backtestInput !== "object") throw new TypeError("backtestInput is required");
  if (!parameters || typeof parameters !== "object") throw new TypeError("parameters are required");
  if (!filter || typeof filter !== "object") throw new TypeError("filter is required");
  const normalizedPeriod = normalizedDevelopmentPeriod(period);
  const { candles, indicators, baseSignals, filterFeatures } = prepareInvariantContext({
    version,
    backtestInput,
    parameters,
    period: normalizedPeriod,
  });
  const market = backtestInput.market;
  const symbol = backtestInput.symbol;
  const side = backtestInput.side ?? "long";
  const timeframe = backtestInput.timeframe;
  const action = market === "CRYPTO_FUTURES" ? (side === "long" ? "LONG" : "SHORT") : "BUY";
  const initialCapital = backtestInput.initialCapital ?? RESEARCH_BACKTEST_PERIOD.initialCapital;
  const riskModel = normalizeRiskModel(backtestInput.riskModel);
  const costModel = normalizeCostModel(backtestInput.costModel);
  const fundingRates = Array.isArray(backtestInput.fundingRates) ? backtestInput.fundingRates : [];
  const trades = [];
  let equity = initialCapital;
  let index = 1;

  while (index < candles.length - 1 && equity > 0) {
    const candle = candles[index];
    if (candle.timestamp < normalizedPeriod.startTime) {
      index += 1;
      continue;
    }
    if (!baseSignals[index]) {
      index += 1;
      continue;
    }
    if (!passesFilter({
      version,
      side,
      candles,
      indicators,
      index,
      filter,
      preparedFeature: filterFeatures?.[index] ?? null,
    })) {
      index += 1;
      continue;
    }
    const entryIndex = index + 1;
    const entryCandle = candles[entryIndex];
    const atrNow = indicators.atr[index];
    const entryPrice = entryCandle.open;
    const stopDistance = atrNow * parameters.stopAtrMultiple;
    const stopPrice = side === "long" ? entryPrice - stopDistance : entryPrice + stopDistance;
    const targetPrice = side === "long"
      ? entryPrice + stopDistance * parameters.targetRiskMultiple
      : entryPrice - stopDistance * parameters.targetRiskMultiple;
    if (!(stopPrice > 0 && targetPrice > 0)) {
      index += 1;
      continue;
    }
    const quantity = positionSize({ equity, entryPrice, stopPrice, riskModel });
    if (!(quantity > 0)) {
      index += 1;
      continue;
    }
    const position = Object.freeze({
      version,
      market,
      symbol,
      timeframe,
      side,
      action,
      signalTime: candle.timestamp,
      entryTime: entryCandle.timestamp,
      entryPrice,
      stopPrice,
      targetPrice,
      quantity,
      leverage: riskModel.leverage,
      riskBudget: equity * riskModel.riskPerTrade,
      regime: regimeAt(indicators, index),
    });
    let exit = null;
    let exitIndex = entryIndex;
    for (; exitIndex < candles.length; exitIndex += 1) {
      exit = exitForCandle(position, candles[exitIndex]);
      if (exit) break;
    }
    if (!exit) {
      exitIndex = candles.length - 1;
      exit = { price: candles[exitIndex].close, reason: "end_of_data" };
    }
    const trade = settle({ position, exit, exitCandle: candles[exitIndex], costModel, fundingRates, equity });
    trades.push(trade);
    equity = trade.equityAfter;
    index = exitIndex + 1;
  }

  const performance = summarizeResearchPerformance(trades, { initialCapital });
  const overall = performance.overall;
  return Object.freeze({
    ok: true,
    mode: "backtest-only",
    strategyVersion: version,
    market,
    symbol,
    side,
    timeframe,
    parameters: Object.freeze({ ...parameters }),
    filter: Object.freeze({ ...filter }),
    period: Object.freeze({ ...normalizedPeriod, finalHoldoutLocked: true }),
    initialCapital,
    finalCapital: initialCapital + overall.netPnl,
    totalReturnPercent: overall.totalReturn * 100,
    successRatePercent: overall.winRate * 100,
    profitFactor: overall.profitFactor,
    maximumDrawdownPercent: overall.maximumDrawdownPercent * 100,
    expectancy: overall.expectancy,
    totalTrades: overall.sampleCount,
    trades: Object.freeze(trades),
    performance,
    safeguards: Object.freeze({
      baseSignalReusesV1Logic: true,
      executionRulesMirrorV1DevelopmentKernel: true,
      singlePassDevelopmentSearch: true,
      invariantSignalContextReusedAcrossCandidates: true,
      finalHoldoutUsedForSelection: false,
      orderSubmitted: false,
      privateAccountRequestAllowed: false,
    }),
  });
}
