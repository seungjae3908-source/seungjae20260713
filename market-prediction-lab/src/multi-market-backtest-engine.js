import { MARKETS } from "./contracts.js";
import {
  ResearchContractError,
  calculateSignalExcursion,
  normalizeResearchSymbol,
} from "./research-governance.js";
import {
  calculateExecutionAwareTrade,
  summarizeResearchPerformance,
} from "./research-validation-layer.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export const RESEARCH_BACKTEST_PERIOD = Object.freeze({
  startTime: Date.UTC(2020, 0, 1),
  developmentEndTime: Date.UTC(2025, 0, 1) - 1,
  validationStartTime: Date.UTC(2025, 0, 1),
  validationEndTime: Date.UTC(2026, 0, 1) - 1,
  finalHoldoutStartTime: Date.UTC(2026, 0, 1),
  defaultEndTime: Date.UTC(2026, 7, 9, 23, 59, 59, 999),
  initialCapital: 1_000_000,
});

export const V1_STRATEGY_ID = "v1_ema_atr";

export const V1_DEFAULT_PARAMETERS = Object.freeze({
  fastPeriod: 20,
  slowPeriod: 50,
  atrPeriod: 14,
  pullbackTolerancePct: 0.5,
  stopAtrMultiple: 1.5,
  targetRiskMultiple: 2,
});

export const DEFAULT_RISK_MODEL = Object.freeze({
  riskPerTrade: 0.01,
  maximumCapitalFraction: 1,
  leverage: 1,
  quantityStep: null,
});

export const ZERO_COST_MODEL = Object.freeze({
  entryFeeRate: 0,
  exitFeeRate: 0,
  taxRate: 0,
  slippageRate: 0,
  spreadRate: 0,
  latencyBars: 0,
  latencyDriftRate: 0,
  schedule: Object.freeze([]),
});

const CASH_MARKETS = new Set(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT"]);
const SIDES = new Set(["long", "short"]);

function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ResearchContractError("NON_FINITE_NUMBER", `${label} must be finite`, { label, value });
  }
  return value;
}

function positive(value, label) {
  finite(value, label);
  if (!(value > 0)) throw new ResearchContractError("NON_POSITIVE_NUMBER", `${label} must be greater than zero`, { label, value });
  return value;
}

function nonNegativeRate(value, label) {
  finite(value, label);
  if (value < 0 || value >= 1) throw new ResearchContractError("INVALID_RATE", `${label} must be between 0 and 1`, { label, value });
  return value;
}

function percent(value, label) {
  finite(value, label);
  if (value < 0 || value > 100) throw new ResearchContractError("INVALID_PERCENT", `${label} must be between 0 and 100`, { label, value });
  return value;
}

function integerAtLeast(value, minimum, label) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new ResearchContractError("INVALID_INTEGER", `${label} must be an integer >= ${minimum}`, { label, value });
  }
  return value;
}

function assertMarket(market) {
  if (!MARKETS.includes(market)) throw new ResearchContractError("INVALID_MARKET", `unsupported market: ${market}`, { market });
  return market;
}

function assertSide(market, side) {
  if (!SIDES.has(side)) throw new ResearchContractError("INVALID_SIDE", "side must be long or short", { side });
  if (CASH_MARKETS.has(market) && side !== "long") {
    throw new ResearchContractError("CASH_SHORT_NOT_ALLOWED", `${market} V1 backtests are long-only`, { market, side });
  }
  return side;
}

function normalizeParameters(input = {}) {
  const parameters = {
    ...V1_DEFAULT_PARAMETERS,
    ...(input ?? {}),
  };
  integerAtLeast(parameters.fastPeriod, 2, "parameters.fastPeriod");
  integerAtLeast(parameters.slowPeriod, parameters.fastPeriod + 1, "parameters.slowPeriod");
  integerAtLeast(parameters.atrPeriod, 2, "parameters.atrPeriod");
  percent(parameters.pullbackTolerancePct, "parameters.pullbackTolerancePct");
  positive(parameters.stopAtrMultiple, "parameters.stopAtrMultiple");
  positive(parameters.targetRiskMultiple, "parameters.targetRiskMultiple");
  return Object.freeze(parameters);
}

function normalizeRiskModel(market, input = {}) {
  const risk = { ...DEFAULT_RISK_MODEL, ...(input ?? {}) };
  positive(risk.riskPerTrade, "riskModel.riskPerTrade");
  if (risk.riskPerTrade > 1) throw new ResearchContractError("INVALID_RISK_PER_TRADE", "riskPerTrade must be <= 1", { value: risk.riskPerTrade });
  positive(risk.maximumCapitalFraction, "riskModel.maximumCapitalFraction");
  if (risk.maximumCapitalFraction > 1) {
    throw new ResearchContractError("INVALID_CAPITAL_FRACTION", "maximumCapitalFraction must be <= 1", { value: risk.maximumCapitalFraction });
  }
  positive(risk.leverage, "riskModel.leverage");
  const maximumLeverage = market === "CRYPTO_FUTURES" ? 10 : 1;
  if (risk.leverage > maximumLeverage) {
    throw new ResearchContractError("INVALID_LEVERAGE", `leverage must be <= ${maximumLeverage} for ${market}`, { market, leverage: risk.leverage });
  }
  if (risk.quantityStep !== null && risk.quantityStep !== undefined) positive(risk.quantityStep, "riskModel.quantityStep");
  return Object.freeze(risk);
}

function normalizeCostRates(model, label) {
  const normalized = {
    entryFeeRate: model?.entryFeeRate ?? 0,
    exitFeeRate: model?.exitFeeRate ?? 0,
    taxRate: model?.taxRate ?? 0,
    slippageRate: model?.slippageRate ?? 0,
    spreadRate: model?.spreadRate ?? 0,
    latencyBars: model?.latencyBars ?? 0,
    latencyDriftRate: model?.latencyDriftRate ?? 0,
  };
  nonNegativeRate(normalized.entryFeeRate, `${label}.entryFeeRate`);
  nonNegativeRate(normalized.exitFeeRate, `${label}.exitFeeRate`);
  nonNegativeRate(normalized.taxRate, `${label}.taxRate`);
  nonNegativeRate(normalized.slippageRate, `${label}.slippageRate`);
  nonNegativeRate(normalized.spreadRate, `${label}.spreadRate`);
  if (!Number.isInteger(normalized.latencyBars) || normalized.latencyBars < 0 || normalized.latencyBars > 100) {
    throw new ResearchContractError("INVALID_LATENCY_BARS", `${label}.latencyBars must be an integer between 0 and 100`);
  }
  nonNegativeRate(normalized.latencyDriftRate, `${label}.latencyDriftRate`);
  return Object.freeze(normalized);
}

function normalizeCostModel(market, input = {}) {
  const base = normalizeCostRates({ ...ZERO_COST_MODEL, ...(input ?? {}) }, "costModel");
  if (market !== "KR_STOCK" && market !== "US_STOCK" && base.taxRate !== 0) {
    throw new ResearchContractError("TAX_NOT_APPLICABLE", `${market} taxRate must be zero`);
  }
  const schedule = Array.isArray(input?.schedule) ? input.schedule.map((row, index) => {
    if (!row || typeof row !== "object") throw new ResearchContractError("INVALID_COST_SCHEDULE", `costModel.schedule[${index}] must be an object`);
    const startTime = row.startTime ?? Number.MIN_SAFE_INTEGER;
    const endTime = row.endTime ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isInteger(startTime) || !Number.isInteger(endTime) || startTime > endTime) {
      throw new ResearchContractError("INVALID_COST_SCHEDULE", `costModel.schedule[${index}] has invalid time bounds`);
    }
    const rates = normalizeCostRates({ ...base, ...row }, `costModel.schedule[${index}]`);
    if (market !== "KR_STOCK" && market !== "US_STOCK" && rates.taxRate !== 0) {
      throw new ResearchContractError("TAX_NOT_APPLICABLE", `${market} cost schedule taxRate must be zero`);
    }
    return Object.freeze({ startTime, endTime, ...rates });
  }) : [];
  schedule.sort((left, right) => left.startTime - right.startTime || left.endTime - right.endTime);
  return Object.freeze({ ...base, schedule: Object.freeze(schedule) });
}

function costAt(model, timestamp) {
  const matching = model.schedule.filter((row) => row.startTime <= timestamp && timestamp <= row.endTime);
  if (matching.length > 1) {
    throw new ResearchContractError("OVERLAPPING_COST_SCHEDULE", "multiple cost schedule rows match the same timestamp", { timestamp });
  }
  return matching[0] ?? model;
}

function normalizeFundingRates(market, rows = []) {
  if (!Array.isArray(rows)) throw new ResearchContractError("INVALID_FUNDING", "fundingRates must be an array");
  if (market !== "CRYPTO_FUTURES" && rows.length > 0) {
    throw new ResearchContractError("FUNDING_NOT_APPLICABLE", `${market} cannot include funding rates`);
  }
  const normalized = rows.map((row, index) => {
    if (!row || typeof row !== "object") throw new ResearchContractError("INVALID_FUNDING", `fundingRates[${index}] must be an object`);
    if (!Number.isInteger(row.timestamp) || row.timestamp <= 0) throw new ResearchContractError("INVALID_FUNDING", `fundingRates[${index}].timestamp is invalid`);
    finite(row.rate, `fundingRates[${index}].rate`);
    return Object.freeze({ timestamp: row.timestamp, rate: row.rate });
  }).sort((left, right) => left.timestamp - right.timestamp);
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index].timestamp === normalized[index - 1].timestamp) {
      throw new ResearchContractError("DUPLICATE_FUNDING", "fundingRates contains duplicate timestamps", { timestamp: normalized[index].timestamp });
    }
  }
  return Object.freeze(normalized);
}

function fundingForTrade(rows, entryTime, exitTime) {
  return rows.filter((row) => row.timestamp > entryTime && row.timestamp <= exitTime).map((row) => row.rate);
}

function normalizeCandles({ market, symbol, candles, effectiveEndTime }) {
  if (!Array.isArray(candles)) throw new ResearchContractError("INVALID_CANDLES", "candles must be an array");
  const normalizedSymbol = normalizeResearchSymbol(market, symbol);
  const rows = candles.map((candle, index) => {
    if (!candle || typeof candle !== "object") throw new ResearchContractError("INVALID_CANDLE", `candles[${index}] must be an object`);
    if (!Number.isInteger(candle.timestamp) || candle.timestamp <= 0) throw new ResearchContractError("INVALID_TIMESTAMP", `candles[${index}].timestamp is invalid`);
    if (candle.isClosed === false) throw new ResearchContractError("OPEN_CANDLE", `candles[${index}] must be closed`);
    for (const field of ["open", "high", "low", "close"]) positive(candle[field], `candles[${index}].${field}`);
    finite(candle.volume ?? 0, `candles[${index}].volume`);
    if ((candle.volume ?? 0) < 0) throw new ResearchContractError("INVALID_VOLUME", `candles[${index}].volume cannot be negative`);
    if (candle.high < Math.max(candle.open, candle.close) || candle.low > Math.min(candle.open, candle.close) || candle.high < candle.low) {
      throw new ResearchContractError("INVALID_OHLC", `candles[${index}] has invalid OHLC relationships`);
    }
    if (candle.symbol !== undefined && normalizeResearchSymbol(market, candle.symbol) !== normalizedSymbol) {
      throw new ResearchContractError("SYMBOL_MISMATCH", `candles[${index}] symbol does not match requested symbol`);
    }
    return Object.freeze({
      symbol: normalizedSymbol,
      timestamp: candle.timestamp,
      observedAt: candle.observedAt ?? candle.timestamp,
      isClosed: true,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume ?? 0,
    });
  }).filter((candle) => candle.timestamp <= effectiveEndTime)
    .sort((left, right) => left.timestamp - right.timestamp);
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index].timestamp <= rows[index - 1].timestamp) {
      throw new ResearchContractError("DUPLICATE_OR_REVERSED_CANDLE", "candles must be strictly ordered with unique timestamps");
    }
  }
  return Object.freeze(rows);
}

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
      if (window.every((value) => Number.isFinite(value))) result[index] = mean(window);
    }
  }
  return result;
}

function buildIndicators(candles, parameters) {
  const closes = candles.map((candle) => candle.close);
  return Object.freeze({
    fast: Object.freeze(emaSeries(closes, parameters.fastPeriod)),
    slow: Object.freeze(emaSeries(closes, parameters.slowPeriod)),
    atr: Object.freeze(atrSeries(candles, parameters.atrPeriod)),
  });
}

function regimeAt(indicators, index) {
  const fast = indicators.fast[index];
  const slow = indicators.slow[index];
  if (!Number.isFinite(fast) || !Number.isFinite(slow)) return "insufficient";
  if (fast > slow) return "uptrend";
  if (fast < slow) return "downtrend";
  return "ranging";
}

export function calculateV1Signal({ market, side, candles, indicators, index, parameters = V1_DEFAULT_PARAMETERS }) {
  assertMarket(market);
  assertSide(market, side);
  const normalizedParameters = normalizeParameters(parameters);
  if (!Number.isInteger(index) || index < 1 || index >= candles.length) return false;
  const fastNow = indicators.fast[index];
  const slowNow = indicators.slow[index];
  const fastPrevious = indicators.fast[index - 1];
  const atrNow = indicators.atr[index];
  if (![fastNow, slowNow, fastPrevious, atrNow].every(Number.isFinite) || atrNow <= 0) return false;
  const tolerance = normalizedParameters.pullbackTolerancePct / 100;
  if (side === "long") {
    return fastNow > slowNow
      && candles[index - 1].close <= fastPrevious * (1 + tolerance)
      && candles[index].close > fastNow;
  }
  return fastNow < slowNow
    && candles[index - 1].close >= fastPrevious * (1 - tolerance)
    && candles[index].close < fastNow;
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

function phaseForTimestamp(timestamp) {
  if (timestamp <= RESEARCH_BACKTEST_PERIOD.developmentEndTime) return "development";
  if (timestamp <= RESEARCH_BACKTEST_PERIOD.validationEndTime) return "validation";
  return "final_holdout";
}

function resolvePeriod(input = {}) {
  const startTime = input.startTime ?? RESEARCH_BACKTEST_PERIOD.startTime;
  const requestedEndTime = input.endTime ?? RESEARCH_BACKTEST_PERIOD.defaultEndTime;
  if (!Number.isInteger(startTime) || !Number.isInteger(requestedEndTime) || startTime >= requestedEndTime) {
    throw new ResearchContractError("INVALID_PERIOD", "startTime and endTime must define an ascending millisecond range");
  }
  const includeFinalHoldout = input.includeFinalHoldout === true;
  const effectiveEndTime = includeFinalHoldout
    ? requestedEndTime
    : Math.min(requestedEndTime, RESEARCH_BACKTEST_PERIOD.finalHoldoutStartTime - 1);
  return Object.freeze({
    startTime,
    requestedEndTime,
    effectiveEndTime,
    includeFinalHoldout,
    finalHoldoutLocked: !includeFinalHoldout && requestedEndTime >= RESEARCH_BACKTEST_PERIOD.finalHoldoutStartTime,
  });
}

function tradeCostInputs({ costModel, entryTime, exitTime }) {
  const entryCosts = costAt(costModel, entryTime);
  const exitCosts = costAt(costModel, exitTime);
  return Object.freeze({
    entryFeeRate: entryCosts.entryFeeRate,
    exitFeeRate: exitCosts.exitFeeRate,
    taxRate: exitCosts.taxRate,
    slippageRate: Math.max(entryCosts.slippageRate, exitCosts.slippageRate),
    spreadRate: Math.max(entryCosts.spreadRate, exitCosts.spreadRate),
    latencyBars: Math.max(entryCosts.latencyBars, exitCosts.latencyBars),
    latencyDriftRate: Math.max(entryCosts.latencyDriftRate, exitCosts.latencyDriftRate),
  });
}

function settlePosition({ position, exit, exitCandle, exitIndex, candles, costModel, fundingRates, equity }) {
  const costInputs = tradeCostInputs({ costModel, entryTime: position.entryTime, exitTime: exitCandle.timestamp });
  const execution = calculateExecutionAwareTrade({
    market: position.market,
    action: position.action,
    entryPrice: position.entryPrice,
    exitPrice: exit.price,
    quantity: position.quantity,
    leverage: position.leverage,
    entryFeeRate: costInputs.entryFeeRate,
    exitFeeRate: costInputs.exitFeeRate,
    taxRate: costInputs.taxRate,
    slippageRate: costInputs.slippageRate,
    spreadRate: costInputs.spreadRate,
    latencyBars: costInputs.latencyBars,
    latencyDriftRate: costInputs.latencyDriftRate,
    fundingRates: fundingForTrade(fundingRates, position.entryTime, exitCandle.timestamp),
  });
  const path = candles.slice(position.entryIndex, exitIndex + 1);
  const excursion = calculateSignalExcursion({ action: position.action, entryPrice: position.entryPrice, candles: path });
  return Object.freeze({
    id: `${position.market}:${position.symbol}:${position.entryTime}:${exitCandle.timestamp}:${position.side}`,
    market: position.market,
    symbol: position.symbol,
    strategy: V1_STRATEGY_ID,
    strategyVersion: "V1",
    timeframe: position.timeframe,
    side: position.side,
    action: position.action,
    regime: position.regime,
    phase: phaseForTimestamp(position.signalTime),
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
    maximumFavorableExcursion: excursion.maximumFavorableExcursion,
    maximumAdverseExcursion: excursion.maximumAdverseExcursion,
    equityBefore: equity,
    equityAfter: equity + execution.netPnl,
  });
}

function summarizeByPhase(trades, initialCapital) {
  return Object.freeze(Object.fromEntries(["development", "validation", "final_holdout"].map((phase) => {
    const rows = trades.filter((trade) => trade.phase === phase);
    return [phase, summarizeResearchPerformance(rows, { initialCapital }).overall];
  })));
}

function summarizeByYear(trades, initialCapital, startTime, endTime) {
  const firstYear = new Date(startTime).getUTCFullYear();
  const lastYear = new Date(endTime).getUTCFullYear();
  const rows = [];
  let startingEquity = initialCapital;
  for (let year = firstYear; year <= lastYear; year += 1) {
    const yearTrades = trades.filter((trade) => new Date(trade.exitTime).getUTCFullYear() === year);
    const summary = summarizeResearchPerformance(yearTrades, { initialCapital: startingEquity }).overall;
    const endingEquity = startingEquity + summary.netPnl;
    rows.push(Object.freeze({
      year,
      startingEquity,
      endingEquity,
      trades: summary.sampleCount,
      wins: yearTrades.filter((trade) => trade.netPnl > 0).length,
      losses: yearTrades.filter((trade) => trade.netPnl < 0).length,
      successRate: summary.winRate,
      netPnl: summary.netPnl,
      returnPercent: startingEquity > 0 ? summary.netPnl / startingEquity * 100 : 0,
      profitFactor: summary.profitFactor,
      maximumDrawdown: summary.maximumDrawdown,
      maximumDrawdownPercent: summary.maximumDrawdownPercent * 100,
    }));
    startingEquity = endingEquity;
  }
  return Object.freeze(rows);
}

export function runV1Backtest(input) {
  if (!input || typeof input !== "object") throw new ResearchContractError("INVALID_BACKTEST_INPUT", "backtest input is required");
  const market = assertMarket(input.market);
  const side = assertSide(market, input.side ?? "long");
  const symbol = normalizeResearchSymbol(market, input.symbol);
  const timeframe = String(input.timeframe ?? "15m");
  if (timeframe.length === 0) throw new ResearchContractError("INVALID_TIMEFRAME", "timeframe is required");
  const initialCapital = input.initialCapital ?? RESEARCH_BACKTEST_PERIOD.initialCapital;
  positive(initialCapital, "initialCapital");
  const parameters = normalizeParameters(input.parameters);
  const riskModel = normalizeRiskModel(market, input.riskModel);
  const costModel = normalizeCostModel(market, input.costModel);
  const fundingRates = normalizeFundingRates(market, input.fundingRates ?? []);
  const period = resolvePeriod(input.period);
  const candles = normalizeCandles({ market, symbol, candles: input.candles, effectiveEndTime: period.effectiveEndTime });
  const minimumCandles = Math.max(parameters.slowPeriod, parameters.atrPeriod) + 3;
  if (candles.length < minimumCandles) {
    throw new ResearchContractError("INSUFFICIENT_CANDLES", `at least ${minimumCandles} candles are required for V1`, { minimumCandles, actual: candles.length });
  }
  const indicators = buildIndicators(candles, parameters);
  const action = market === "CRYPTO_FUTURES" ? (side === "long" ? "LONG" : "SHORT") : "BUY";
  const trades = [];
  let equity = initialCapital;
  let position = null;

  for (let index = 1; index < candles.length; index += 1) {
    const candle = candles[index];
    if (position) {
      const exit = exitForCandle(position, candle);
      if (exit) {
        const trade = settlePosition({ position, exit, exitCandle: candle, exitIndex: index, candles, costModel, fundingRates, equity });
        trades.push(trade);
        equity = trade.equityAfter;
        position = null;
      }
      continue;
    }
    if (equity <= 0) break;
    if (candle.timestamp < period.startTime || candle.timestamp > period.effectiveEndTime) continue;
    if (index + 1 >= candles.length) continue;
    const entryCandle = candles[index + 1];
    if (entryCandle.timestamp > period.effectiveEndTime) continue;
    const hasSignal = calculateV1Signal({ market, side, candles, indicators, index, parameters });
    if (!hasSignal) continue;
    const atrNow = indicators.atr[index];
    const entryPrice = entryCandle.open;
    const stopDistance = atrNow * parameters.stopAtrMultiple;
    const stopPrice = side === "long" ? entryPrice - stopDistance : entryPrice + stopDistance;
    const targetPrice = side === "long"
      ? entryPrice + stopDistance * parameters.targetRiskMultiple
      : entryPrice - stopDistance * parameters.targetRiskMultiple;
    if (!(stopPrice > 0 && targetPrice > 0)) continue;
    const quantity = positionSize({ equity, entryPrice, stopPrice, riskModel });
    if (!(quantity > 0)) continue;
    position = Object.freeze({
      market,
      symbol,
      timeframe,
      side,
      action,
      signalTime: candle.timestamp,
      entryTime: entryCandle.timestamp,
      entryIndex: index + 1,
      entryPrice,
      stopPrice,
      targetPrice,
      quantity,
      leverage: riskModel.leverage,
      riskBudget: equity * riskModel.riskPerTrade,
      regime: regimeAt(indicators, index),
    });
  }

  if (position) {
    const exitIndex = candles.length - 1;
    const exitCandle = candles[exitIndex];
    if (exitCandle.timestamp >= position.entryTime) {
      const trade = settlePosition({
        position,
        exit: { price: exitCandle.close, reason: "end_of_data" },
        exitCandle,
        exitIndex,
        candles,
        costModel,
        fundingRates,
        equity,
      });
      trades.push(trade);
      equity = trade.equityAfter;
    }
  }

  const orderedTrades = Object.freeze([...trades].sort((left, right) => left.exitTime - right.exitTime || left.id.localeCompare(right.id)));
  const performance = summarizeResearchPerformance(orderedTrades, { initialCapital });
  const overall = performance.overall;
  return Object.freeze({
    ok: true,
    mode: "backtest-only",
    orderSubmitted: false,
    privateAccountRequestAllowed: false,
    strategy: V1_STRATEGY_ID,
    strategyVersion: "V1",
    market,
    symbol,
    side,
    timeframe,
    initialCapital,
    finalCapital: initialCapital + overall.netPnl,
    netPnl: overall.netPnl,
    totalReturnPercent: overall.totalReturn * 100,
    successRatePercent: overall.winRate * 100,
    totalTrades: overall.sampleCount,
    profitFactor: overall.profitFactor,
    maximumDrawdown: overall.maximumDrawdown,
    maximumDrawdownPercent: overall.maximumDrawdownPercent * 100,
    expectancy: overall.expectancy,
    averageWin: overall.averageWin,
    averageLoss: overall.averageLoss,
    maximumConsecutiveLosses: overall.maximumConsecutiveLosses,
    tradeSharpe: overall.tradeSharpe,
    turnover: overall.turnover,
    totalExecutionCost: overall.totalExecutionCost,
    parameters,
    riskModel,
    costModel,
    period,
    performance,
    byPhase: summarizeByPhase(orderedTrades, initialCapital),
    byYear: summarizeByYear(orderedTrades, initialCapital, period.startTime, period.effectiveEndTime),
    trades: orderedTrades,
    safeguards: Object.freeze({
      signalUsesClosedCandle: true,
      entryUsesNextCandleOpen: true,
      stopFirstOnAmbiguousBar: true,
      finalHoldoutLocked: period.finalHoldoutLocked,
      costsIncluded: true,
      liveOrderAllowed: false,
    }),
  });
}

export function runV1UniverseBacktest(input) {
  if (!input || typeof input !== "object") throw new ResearchContractError("INVALID_UNIVERSE_BACKTEST", "universe backtest input is required");
  if (!Array.isArray(input.datasets) || input.datasets.length === 0) {
    throw new ResearchContractError("EMPTY_DATASETS", "datasets must contain at least one symbol dataset");
  }
  const market = assertMarket(input.market);
  const side = assertSide(market, input.side ?? "long");
  const initialCapital = input.initialCapital ?? RESEARCH_BACKTEST_PERIOD.initialCapital;
  positive(initialCapital, "initialCapital");
  const sleeveCapital = initialCapital / input.datasets.length;
  const symbolResults = input.datasets.map((dataset, index) => {
    if (!dataset || typeof dataset !== "object") throw new ResearchContractError("INVALID_DATASET", `datasets[${index}] must be an object`);
    return runV1Backtest({
      ...input,
      datasets: undefined,
      symbol: dataset.symbol,
      candles: dataset.candles,
      fundingRates: dataset.fundingRates ?? input.fundingRates ?? [],
      initialCapital: sleeveCapital,
      market,
      side,
    });
  });
  const trades = Object.freeze(symbolResults.flatMap((result) => result.trades).sort((left, right) => left.exitTime - right.exitTime || left.id.localeCompare(right.id)));
  const performance = summarizeResearchPerformance(trades, { initialCapital });
  const bySymbol = Object.freeze(Object.fromEntries(symbolResults.map((result) => [result.symbol, Object.freeze({
    initialCapital: result.initialCapital,
    finalCapital: result.finalCapital,
    totalReturnPercent: result.totalReturnPercent,
    successRatePercent: result.successRatePercent,
    totalTrades: result.totalTrades,
    profitFactor: result.profitFactor,
    maximumDrawdownPercent: result.maximumDrawdownPercent,
  })])));
  return Object.freeze({
    ok: true,
    mode: "backtest-only",
    orderSubmitted: false,
    privateAccountRequestAllowed: false,
    strategy: V1_STRATEGY_ID,
    strategyVersion: "V1",
    market,
    side,
    timeframe: String(input.timeframe ?? "15m"),
    allocationMode: "equal_sleeves",
    initialCapital,
    sleeveCapital,
    finalCapital: symbolResults.reduce((sum, result) => sum + result.finalCapital, 0),
    netPnl: performance.overall.netPnl,
    totalReturnPercent: performance.overall.totalReturn * 100,
    successRatePercent: performance.overall.winRate * 100,
    totalTrades: performance.overall.sampleCount,
    profitFactor: performance.overall.profitFactor,
    maximumDrawdown: performance.overall.maximumDrawdown,
    maximumDrawdownPercent: performance.overall.maximumDrawdownPercent * 100,
    performance,
    bySymbol,
    symbolResults: Object.freeze(symbolResults),
    trades,
    safeguards: Object.freeze({
      totalCapitalFixedAtOneMillionByDefault: initialCapital === RESEARCH_BACKTEST_PERIOD.initialCapital,
      equalSleevesPreventCapitalDoubleCounting: true,
      liveOrderAllowed: false,
    }),
  });
}

export function compareBacktestVersions({ baseline, candidate }) {
  if (!baseline || !candidate) throw new ResearchContractError("INVALID_VERSION_COMPARISON", "baseline and candidate results are required");
  if (baseline.market !== candidate.market || baseline.side !== candidate.side || baseline.initialCapital !== candidate.initialCapital) {
    throw new ResearchContractError("INCOMPARABLE_RESULTS", "baseline and candidate must use the same market, side and initial capital");
  }
  const returnDelta = candidate.totalReturnPercent - baseline.totalReturnPercent;
  const successDelta = candidate.successRatePercent - baseline.successRatePercent;
  const mddDelta = candidate.maximumDrawdownPercent - baseline.maximumDrawdownPercent;
  const profitFactorDelta = Number.isFinite(candidate.profitFactor) && Number.isFinite(baseline.profitFactor)
    ? candidate.profitFactor - baseline.profitFactor
    : null;
  let verdict = "hold";
  if (returnDelta > 0 && successDelta >= 0) verdict = mddDelta <= 0 ? "adopt" : "risk_review";
  else if (successDelta > 0 && returnDelta >= 0) verdict = mddDelta <= 0 ? "adopt" : "risk_review";
  else if (returnDelta < 0 && successDelta < 0) verdict = "reject";
  else if (returnDelta !== 0 || successDelta !== 0) verdict = "tradeoff_review";
  return Object.freeze({
    baselineVersion: baseline.strategyVersion ?? baseline.strategy,
    candidateVersion: candidate.strategyVersion ?? candidate.strategy,
    returnDeltaPercentagePoints: returnDelta,
    successRateDeltaPercentagePoints: successDelta,
    maximumDrawdownDeltaPercentagePoints: mddDelta,
    profitFactorDelta,
    tradeCountDelta: candidate.totalTrades - baseline.totalTrades,
    verdict,
    weightedScoreUsed: false,
    objective: "joint_return_and_success_rate",
    note: "No scalar score is used; return and success rate must be reviewed together with drawdown and sample size.",
  });
}

export function buildBacktestTable(results) {
  if (!Array.isArray(results)) throw new ResearchContractError("INVALID_RESULTS", "results must be an array");
  return Object.freeze(results.map((result) => Object.freeze({
    market: result.market,
    side: result.side,
    version: result.strategyVersion ?? result.strategy,
    initialCapital: result.initialCapital,
    finalCapital: result.finalCapital,
    netReturnPercent: result.totalReturnPercent,
    successRatePercent: result.successRatePercent,
    profitFactor: result.profitFactor,
    maximumDrawdownPercent: result.maximumDrawdownPercent,
    trades: result.totalTrades,
  })));
}

export function buildYearRange({ startYear = 2020, endYear = 2026 } = {}) {
  integerAtLeast(startYear, 1970, "startYear");
  integerAtLeast(endYear, startYear, "endYear");
  return Object.freeze(Array.from({ length: endYear - startYear + 1 }, (_, offset) => {
    const year = startYear + offset;
    const startTime = Date.UTC(year, 0, 1);
    const endTime = year === 2026 ? RESEARCH_BACKTEST_PERIOD.defaultEndTime : Date.UTC(year + 1, 0, 1) - 1;
    return Object.freeze({ year, startTime, endTime, days: Math.ceil((endTime - startTime + 1) / DAY_MS) });
  }));
}
