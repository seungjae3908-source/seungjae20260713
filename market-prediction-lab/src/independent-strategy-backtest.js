import {
  ResearchContractError,
  calculateSignalExcursion,
  normalizeResearchSymbol,
} from "./research-governance.js";
import {
  calculateExecutionAwareTrade,
  summarizeResearchPerformance,
} from "./research-validation-layer.js";
import { RESEARCH_BACKTEST_PERIOD } from "./multi-market-backtest-engine.js";

const MARKETS = new Set(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"]);
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

function normalizeSide(market, side) {
  if (!SIDES.has(side)) throw new ResearchContractError("INVALID_SIDE", "side must be long or short", { side });
  if (CASH_MARKETS.has(market) && side !== "long") {
    throw new ResearchContractError("CASH_SHORT_NOT_ALLOWED", `${market} independent backtests are long-only`, { market, side });
  }
  return side;
}

function normalizeRiskModel(market, input = {}) {
  const risk = {
    riskPerTrade: input.riskPerTrade ?? 0.01,
    maximumCapitalFraction: input.maximumCapitalFraction ?? 1,
    leverage: input.leverage ?? 1,
    quantityStep: input.quantityStep ?? null,
  };
  positive(risk.riskPerTrade, "riskModel.riskPerTrade");
  positive(risk.maximumCapitalFraction, "riskModel.maximumCapitalFraction");
  positive(risk.leverage, "riskModel.leverage");
  if (risk.riskPerTrade > 1 || risk.maximumCapitalFraction > 1) {
    throw new ResearchContractError("INVALID_RISK_MODEL", "riskPerTrade and maximumCapitalFraction must be <= 1", { risk });
  }
  if (market !== "CRYPTO_FUTURES" && risk.leverage !== 1) {
    throw new ResearchContractError("INVALID_LEVERAGE", `${market} leverage must be 1`, { leverage: risk.leverage });
  }
  if (market === "CRYPTO_FUTURES" && risk.leverage > 10) {
    throw new ResearchContractError("INVALID_LEVERAGE", "CRYPTO_FUTURES leverage must be <= 10", { leverage: risk.leverage });
  }
  if (risk.quantityStep !== null) positive(risk.quantityStep, "riskModel.quantityStep");
  return Object.freeze(risk);
}

function normalizeCostModel(input = {}) {
  const base = Object.freeze({
    entryFeeRate: input.entryFeeRate ?? 0,
    exitFeeRate: input.exitFeeRate ?? 0,
    taxRate: input.taxRate ?? 0,
    slippageRate: input.slippageRate ?? 0,
    spreadRate: input.spreadRate ?? 0,
    latencyBars: input.latencyBars ?? 0,
    latencyDriftRate: input.latencyDriftRate ?? 0,
  });
  const schedule = Array.isArray(input.schedule)
    ? input.schedule.map((row) => Object.freeze({ ...base, ...row })).sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0))
    : [];
  return Object.freeze({ ...base, schedule: Object.freeze(schedule) });
}

function costAt(model, timestamp) {
  const matching = model.schedule.filter((row) => (row.startTime ?? Number.MIN_SAFE_INTEGER) <= timestamp && timestamp <= (row.endTime ?? Number.MAX_SAFE_INTEGER));
  if (matching.length > 1) throw new ResearchContractError("OVERLAPPING_COST_SCHEDULE", "multiple cost schedule rows match timestamp", { timestamp });
  return matching[0] ?? model;
}

function normalizeFunding(rows = []) {
  if (!Array.isArray(rows)) throw new ResearchContractError("INVALID_FUNDING", "fundingRates must be an array");
  return Object.freeze(rows.map((row) => Object.freeze({ timestamp: row.timestamp, rate: row.rate })).sort((a, b) => a.timestamp - b.timestamp));
}

function fundingForTrade(rows, entryTime, exitTime) {
  return rows.filter((row) => row.timestamp > entryTime && row.timestamp <= exitTime).map((row) => row.rate);
}

function mean(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function atrSeries(candles, period) {
  const result = new Array(candles.length).fill(null);
  const tr = new Array(candles.length).fill(null);
  for (let index = 1; index < candles.length; index += 1) {
    tr[index] = Math.max(
      candles[index].high - candles[index].low,
      Math.abs(candles[index].high - candles[index - 1].close),
      Math.abs(candles[index].low - candles[index - 1].close),
    );
    if (index >= period) {
      const window = tr.slice(index - period + 1, index + 1);
      if (window.every(Number.isFinite)) result[index] = mean(window);
    }
  }
  return result;
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

function settle({ position, exit, exitCandle, exitIndex, candles, costModel, fundingRates, equity }) {
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
  const excursion = calculateSignalExcursion({
    action: position.action,
    entryPrice: position.entryPrice,
    candles: candles.slice(position.entryIndex, exitIndex + 1),
  });
  return Object.freeze({
    id: `${position.strategyVersion}:${position.market}:${position.symbol}:${position.entryTime}:${exitCandle.timestamp}:${position.side}`,
    market: position.market,
    symbol: position.symbol,
    strategy: position.strategy,
    strategyVersion: position.strategyVersion,
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
    signalContext: position.signalContext,
    equityBefore: equity,
    equityAfter: equity + execution.netPnl,
  });
}

function resolvePeriod(period = {}) {
  const startTime = period.startTime ?? RESEARCH_BACKTEST_PERIOD.startTime;
  const endTime = period.endTime ?? RESEARCH_BACKTEST_PERIOD.validationEndTime;
  if (!Number.isInteger(startTime) || !Number.isInteger(endTime) || startTime >= endTime) {
    throw new ResearchContractError("INVALID_PERIOD", "period must be ascending milliseconds", { startTime, endTime });
  }
  if (period.includeFinalHoldout === true || endTime >= RESEARCH_BACKTEST_PERIOD.finalHoldoutStartTime) {
    throw new ResearchContractError("INDEPENDENT_HOLDOUT_LOCKED", "independent strategy selection cannot use the 2026 final holdout");
  }
  return Object.freeze({ startTime, endTime, includeFinalHoldout: false, finalHoldoutLocked: true });
}

export function runIndependentSignalBacktest({
  backtestInput,
  strategy,
  strategyVersion,
  parameters,
  signalEvaluator,
  period,
} = {}) {
  if (!backtestInput || typeof backtestInput !== "object") throw new ResearchContractError("INVALID_INDEPENDENT_INPUT", "backtestInput is required");
  if (typeof signalEvaluator !== "function") throw new ResearchContractError("INVALID_SIGNAL_EVALUATOR", "signalEvaluator must be a function");
  const market = String(backtestInput.market ?? "");
  if (!MARKETS.has(market)) throw new ResearchContractError("INVALID_MARKET", `unsupported market: ${market}`);
  const side = normalizeSide(market, backtestInput.side ?? "long");
  const symbol = normalizeResearchSymbol(market, backtestInput.symbol);
  const timeframe = String(backtestInput.timeframe ?? "1d");
  const initialCapital = backtestInput.initialCapital ?? RESEARCH_BACKTEST_PERIOD.initialCapital;
  positive(initialCapital, "initialCapital");
  const normalizedPeriod = resolvePeriod(period);
  const atrPeriod = parameters?.atrPeriod ?? 14;
  const stopAtrMultiple = parameters?.stopAtrMultiple ?? 1.5;
  const targetRiskMultiple = parameters?.targetRiskMultiple ?? 2;
  if (!Number.isInteger(atrPeriod) || atrPeriod < 2) throw new ResearchContractError("INVALID_ATR_PERIOD", "atrPeriod must be integer >= 2");
  positive(stopAtrMultiple, "parameters.stopAtrMultiple");
  positive(targetRiskMultiple, "parameters.targetRiskMultiple");
  const riskModel = normalizeRiskModel(market, backtestInput.riskModel ?? {});
  const costModel = normalizeCostModel(backtestInput.costModel ?? {});
  const fundingRates = normalizeFunding(backtestInput.fundingRates ?? []);
  const candles = Object.freeze([...(backtestInput.candles ?? [])]
    .filter((candle) => candle.timestamp <= normalizedPeriod.endTime)
    .sort((a, b) => a.timestamp - b.timestamp));
  if (candles.length < atrPeriod + 3) throw new ResearchContractError("INSUFFICIENT_CANDLES", "independent strategy requires more candles");
  const atr = Object.freeze(atrSeries(candles, atrPeriod));
  const action = market === "CRYPTO_FUTURES" ? (side === "long" ? "LONG" : "SHORT") : "BUY";
  const trades = [];
  let equity = initialCapital;
  let position = null;

  for (let index = 1; index < candles.length; index += 1) {
    const candle = candles[index];
    if (position) {
      const exit = exitForCandle(position, candle);
      if (exit) {
        const trade = settle({ position, exit, exitCandle: candle, exitIndex: index, candles, costModel, fundingRates, equity });
        trades.push(trade);
        equity = trade.equityAfter;
        position = null;
      }
      continue;
    }
    if (equity <= 0) break;
    if (candle.timestamp < normalizedPeriod.startTime || candle.timestamp > normalizedPeriod.endTime) continue;
    if (index + 1 >= candles.length) continue;
    const entryCandle = candles[index + 1];
    if (entryCandle.timestamp > normalizedPeriod.endTime) continue;
    const atrNow = atr[index];
    if (!Number.isFinite(atrNow) || atrNow <= 0) continue;
    const signalContext = signalEvaluator({ market, side, symbol, timeframe, candles, atr, index, atrNow });
    if (!signalContext) continue;
    const entryPrice = entryCandle.open;
    const stopDistance = atrNow * stopAtrMultiple;
    const stopPrice = side === "long" ? entryPrice - stopDistance : entryPrice + stopDistance;
    const targetPrice = side === "long" ? entryPrice + stopDistance * targetRiskMultiple : entryPrice - stopDistance * targetRiskMultiple;
    if (!(stopPrice > 0 && targetPrice > 0)) continue;
    const quantity = positionSize({ equity, entryPrice, stopPrice, riskModel });
    if (!(quantity > 0)) continue;
    position = Object.freeze({
      market,
      symbol,
      timeframe,
      side,
      action,
      strategy: String(strategy ?? "independent_signal"),
      strategyVersion: String(strategyVersion ?? "INDEPENDENT"),
      signalTime: candle.timestamp,
      entryTime: entryCandle.timestamp,
      entryIndex: index + 1,
      entryPrice,
      stopPrice,
      targetPrice,
      quantity,
      leverage: riskModel.leverage,
      riskBudget: equity * riskModel.riskPerTrade,
      regime: "independent_structure",
      signalContext: Object.freeze({ ...signalContext }),
    });
  }

  if (position) {
    const exitIndex = candles.length - 1;
    const exitCandle = candles[exitIndex];
    if (exitCandle.timestamp >= position.entryTime) {
      const trade = settle({
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

  const orderedTrades = Object.freeze([...trades].sort((a, b) => a.exitTime - b.exitTime || a.id.localeCompare(b.id)));
  const performance = summarizeResearchPerformance(orderedTrades, { initialCapital });
  const overall = performance.overall;
  return Object.freeze({
    ok: true,
    mode: "backtest-only",
    strategy: String(strategy ?? "independent_signal"),
    strategyVersion: String(strategyVersion ?? "INDEPENDENT"),
    market,
    symbol,
    side,
    timeframe,
    initialCapital,
    finalCapital: initialCapital + overall.netPnl,
    totalReturnPercent: overall.totalReturn * 100,
    successRatePercent: overall.winRate * 100,
    profitFactor: overall.profitFactor,
    maximumDrawdownPercent: overall.maximumDrawdownPercent * 100,
    expectancy: overall.expectancy,
    totalTrades: overall.sampleCount,
    parameters: Object.freeze({ atrPeriod, stopAtrMultiple, targetRiskMultiple }),
    riskModel,
    costModel,
    period: normalizedPeriod,
    performance,
    trades: orderedTrades,
    safeguards: Object.freeze({
      signalUsesClosedCandle: true,
      entryUsesNextCandleOpen: true,
      stopFirstOnAmbiguousBar: true,
      executionUsesSharedCalculateExecutionAwareTrade: true,
      fundingIncludedForFutures: market === "CRYPTO_FUTURES",
      finalHoldoutUsedForSelection: false,
      orderSubmitted: false,
      privateAccountRequestAllowed: false,
    }),
  });
}
