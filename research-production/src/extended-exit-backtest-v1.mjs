// Extended exits for the canonical independent backtester: trailing stop and
// partial take-profit (scale-out), on top of the same closed-candle signal,
// next-open entry, ATR stop, stop-first ambiguous bars, shared execution-cost
// model and funding as `runIndependentSignalBacktest`.
//
// When an exit profile uses neither trailing nor partial targets this module
// DELEGATES to the canonical backtester, so every existing trial is byte-for-
// byte unchanged. The extended loop is proven equal to the canonical loop in
// tests by forcing it on plain exits (`forceExtendedLoop`).
//
// One position = one trade record, even when it is closed in several legs, so
// a scale-out never inflates the trade count used by the statistics.
// Research only: no orders, no account access, executionAuthority NONE.

import {
  runIndependentSignalBacktest,
  runIndependentSignalFinalHoldout,
} from '../../market-prediction-lab/src/independent-strategy-backtest.js';
import { calculateExecutionAwareTrade } from '../../market-prediction-lab/src/research-validation-layer.js';
import { normalizeResearchSymbol } from '../../market-prediction-lab/src/research-governance.js';
import { RESEARCH_BACKTEST_PERIOD } from '../../market-prediction-lab/src/multi-market-backtest-engine.js';

export const EXTENDED_EXIT_BACKTEST_VERSION = 'extended-exit-backtest/v1';

const CASH_MARKETS = new Set(['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT']);
const MARKETS = new Set([...CASH_MARKETS, 'CRYPTO_FUTURES']);
const EPSILON = 1e-12;

function fail(code, detail) {
  const error = new Error(detail ? `${code}:${detail}` : code);
  error.code = code;
  throw error;
}

function positiveFinite(value, code) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !(value > 0)) fail(code, String(value));
  return value;
}

/** Validates and freezes the optional extended exit block of an exit profile. */
export function normalizeExtendedExitV1(extended = null) {
  if (extended == null) return null;
  if (typeof extended !== 'object' || Array.isArray(extended)) fail('EXTENDED_EXIT_INVALID');
  const trailing = extended.trailing == null ? null : Object.freeze({
    atrMultiple: positiveFinite(extended.trailing.atrMultiple, 'TRAILING_ATR_MULTIPLE_INVALID'),
    activationRiskMultiple: extended.trailing.activationRiskMultiple == null ? 0
      : (Number.isFinite(extended.trailing.activationRiskMultiple) && extended.trailing.activationRiskMultiple >= 0
        ? extended.trailing.activationRiskMultiple : fail('TRAILING_ACTIVATION_INVALID')),
  });
  const partials = Object.freeze((extended.partials ?? []).map((row) => Object.freeze({
    riskMultiple: positiveFinite(row?.riskMultiple, 'PARTIAL_RISK_MULTIPLE_INVALID'),
    fraction: (Number.isFinite(row?.fraction) && row.fraction > 0 && row.fraction < 1) ? row.fraction : fail('PARTIAL_FRACTION_INVALID'),
  })));
  if (partials.length > 3) fail('PARTIALS_TOO_MANY');
  for (let i = 1; i < partials.length; i += 1) {
    if (!(partials[i].riskMultiple > partials[i - 1].riskMultiple)) fail('PARTIALS_NOT_ASCENDING');
  }
  const fractionSum = partials.reduce((sum, row) => sum + row.fraction, 0);
  if (fractionSum >= 1 - EPSILON) fail('PARTIALS_CLOSE_WHOLE_POSITION');
  const finalTargetRiskMultiple = extended.finalTargetRiskMultiple == null ? null
    : positiveFinite(extended.finalTargetRiskMultiple, 'FINAL_TARGET_INVALID');
  if (finalTargetRiskMultiple != null && partials.length > 0 && !(finalTargetRiskMultiple > partials.at(-1).riskMultiple)) {
    fail('FINAL_TARGET_BELOW_PARTIAL');
  }
  if (trailing == null && partials.length === 0) return null;
  if (trailing == null && finalTargetRiskMultiple == null) fail('EXTENDED_EXIT_WITHOUT_TERMINAL_EXIT');
  return Object.freeze({
    trailing,
    partials,
    finalTargetRiskMultiple,
    breakevenAfterFirstPartial: extended.breakevenAfterFirstPartial !== false,
  });
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
      let sum = 0;
      let ok = true;
      for (let k = index - period + 1; k <= index; k += 1) {
        if (!Number.isFinite(tr[k])) { ok = false; break; }
        sum += tr[k];
      }
      if (ok) result[index] = sum / period;
    }
  }
  return result;
}

function normalizeRisk(market, input = {}) {
  const risk = {
    riskPerTrade: input.riskPerTrade ?? 0.01,
    maximumCapitalFraction: input.maximumCapitalFraction ?? 1,
    leverage: input.leverage ?? 1,
    quantityStep: input.quantityStep ?? null,
  };
  positiveFinite(risk.riskPerTrade, 'RISK_PER_TRADE_INVALID');
  positiveFinite(risk.maximumCapitalFraction, 'MAX_CAPITAL_FRACTION_INVALID');
  positiveFinite(risk.leverage, 'LEVERAGE_INVALID');
  if (risk.riskPerTrade > 1 || risk.maximumCapitalFraction > 1) fail('INVALID_RISK_MODEL');
  if (market !== 'CRYPTO_FUTURES' && risk.leverage !== 1) fail('INVALID_LEVERAGE', market);
  if (market === 'CRYPTO_FUTURES' && risk.leverage > 10) fail('INVALID_LEVERAGE', market);
  return Object.freeze(risk);
}

function normalizeCost(input = {}) {
  if (Array.isArray(input.schedule) && input.schedule.length > 0) fail('COST_SCHEDULE_UNSUPPORTED_BY_EXTENDED_EXITS');
  return Object.freeze({
    entryFeeRate: input.entryFeeRate ?? 0,
    exitFeeRate: input.exitFeeRate ?? 0,
    taxRate: input.taxRate ?? 0,
    slippageRate: input.slippageRate ?? 0,
    spreadRate: input.spreadRate ?? 0,
    latencyBars: input.latencyBars ?? 0,
    latencyDriftRate: input.latencyDriftRate ?? 0,
  });
}

function positionSize({ equity, entryPrice, stopPrice, risk }) {
  const stopDistance = Math.abs(entryPrice - stopPrice);
  if (!(equity > 0 && stopDistance > 0)) return 0;
  const byRisk = (equity * risk.riskPerTrade) / stopDistance;
  const byCapital = (equity * risk.maximumCapitalFraction * risk.leverage) / entryPrice;
  const quantity = Math.min(byRisk, byCapital);
  return risk.quantityStep == null ? quantity : Math.floor(quantity / risk.quantityStep) * risk.quantityStep;
}

// Forward paper trading starts the day after the predeclared research end.
// Nothing at or after this instant was used to select or tune any rule.
export const FORWARD_PAPER_START_MS = RESEARCH_BACKTEST_PERIOD.defaultEndTime + 1;

function resolvePeriod(period = {}, finalHoldout) {
  const startTime = period.startTime ?? RESEARCH_BACKTEST_PERIOD.startTime;
  const endTime = period.endTime ?? RESEARCH_BACKTEST_PERIOD.validationEndTime;
  if (!Number.isInteger(startTime) || !Number.isInteger(endTime) || startTime >= endTime) fail('INVALID_PERIOD');
  if (finalHoldout === 'forward') {
    if (period.forwardPaper !== true) fail('FORWARD_PAPER_EXPLICIT_OPT_IN_REQUIRED');
    if (startTime < FORWARD_PAPER_START_MS) fail('FORWARD_PAPER_STARTS_AFTER_RESEARCH_END');
    return { startTime, endTime };
  }
  if (finalHoldout) {
    if (period.includeFinalHoldout !== true) fail('FINAL_HOLDOUT_EXPLICIT_OPT_IN_REQUIRED');
    if (startTime !== RESEARCH_BACKTEST_PERIOD.finalHoldoutStartTime) fail('FINAL_HOLDOUT_START_MISMATCH');
    if (endTime > RESEARCH_BACKTEST_PERIOD.defaultEndTime) fail('FINAL_HOLDOUT_END_EXCEEDED');
    return { startTime, endTime };
  }
  if (period.includeFinalHoldout === true || endTime >= RESEARCH_BACKTEST_PERIOD.finalHoldoutStartTime) fail('INDEPENDENT_HOLDOUT_LOCKED');
  return { startTime, endTime };
}

function legResult({ position, price, quantity, exitTime, costModel, fundingRates }) {
  return calculateExecutionAwareTrade({
    market: position.market,
    action: position.action,
    entryPrice: position.entryPrice,
    exitPrice: price,
    quantity,
    leverage: position.leverage,
    entryFeeRate: costModel.entryFeeRate,
    exitFeeRate: costModel.exitFeeRate,
    taxRate: costModel.taxRate,
    slippageRate: costModel.slippageRate,
    spreadRate: costModel.spreadRate,
    latencyBars: costModel.latencyBars,
    latencyDriftRate: costModel.latencyDriftRate,
    fundingRates: fundingRates.filter((row) => row.timestamp > position.entryTime && row.timestamp <= exitTime).map((row) => row.rate),
  });
}

function closeLeg(position, { price, quantity, exitTime, reason }, context) {
  const execution = legResult({ position, price, quantity, exitTime, ...context });
  position.legs.push(Object.freeze({ price, quantity, exitTime, reason, netPnl: execution.netPnl, costs: execution.costs.total }));
  position.remaining -= quantity;
  if (position.remaining < position.quantity * 1e-9) position.remaining = 0;
}

function finalizeTrade(position, equity) {
  const netPnl = position.legs.reduce((sum, leg) => sum + leg.netPnl, 0);
  const costs = position.legs.reduce((sum, leg) => sum + leg.costs, 0);
  const last = position.legs.at(-1);
  const reasons = position.legs.map((leg) => leg.reason);
  const exitReason = reasons.length === 1 ? reasons[0] : `${reasons.slice(0, -1).join('+')}+${reasons.at(-1)}`;
  const weightedExit = position.legs.reduce((sum, leg) => sum + (leg.price * leg.quantity), 0) / position.quantity;
  return Object.freeze({
    id: `${position.strategyVersion}:${position.market}:${position.symbol}:${position.entryTime}:${last.exitTime}:${position.side}`,
    market: position.market,
    symbol: position.symbol,
    strategy: position.strategy,
    strategyVersion: position.strategyVersion,
    timeframe: position.timeframe,
    side: position.side,
    action: position.action,
    regime: 'independent_structure',
    signalTime: position.signalTime,
    entryTime: position.entryTime,
    exitTime: last.exitTime,
    entryPrice: position.entryPrice,
    averageExitPrice: weightedExit,
    initialStopPrice: position.initialStopPrice,
    finalStopPrice: position.stopPrice,
    quantity: position.quantity,
    leverage: position.leverage,
    riskBudget: position.riskBudget,
    exitReason,
    legs: Object.freeze([...position.legs]),
    netPnl,
    costsTotal: costs,
    costsIncluded: true,
    equityBefore: equity,
    equityAfter: equity + netPnl,
  });
}

/**
 * Processes one bar for an open position. Order of checks is conservative and
 * identical to the canonical loop for plain exits: gap through stop, gap
 * through the next target, then stop-first when the bar touches both.
 * Trailing and break-even updates use only the finished bar and take effect
 * from the NEXT bar, so nothing is filled at a level computed from the same
 * bar's future extreme.
 */
function stepPosition(position, candle, index, atrNow, context) {
  const long = position.side === 'long';
  const worse = (a, b) => (long ? a <= b : a >= b);
  const better = (a, b) => (long ? a >= b : a <= b);
  const exitAll = (price, reason) => closeLeg(position, { price, quantity: position.remaining, exitTime: candle.timestamp, reason }, context);
  const targets = position.targets;

  if (worse(candle.open, position.stopPrice)) { exitAll(candle.open, position.trailingActive ? 'trailing_stop_gap' : 'stop_loss_gap'); return; }
  if (targets.length > 0 && better(candle.open, targets[0].price)) {
    // Gap through one or more targets: fill each at its own level (no credit
    // for the better open), exactly as the canonical take_profit gap rule.
    while (targets.length > 0 && better(candle.open, targets[0].price) && position.remaining > 0) {
      const target = targets.shift();
      if (target.final) exitAll(target.price, 'take_profit');
      else closeLeg(position, { price: target.price, quantity: Math.min(position.remaining, position.quantity * target.fraction), exitTime: candle.timestamp, reason: 'partial_take_profit' }, context);
      if (!target.final) position.partialsFilled += 1;
    }
    if (position.remaining <= 0) return;
  }
  const extremeAgainst = long ? candle.low : candle.high;
  const extremeFor = long ? candle.high : candle.low;
  const stopHit = worse(extremeAgainst, position.stopPrice);
  const targetHit = targets.length > 0 && better(extremeFor, targets[0].price);
  if (stopHit && targetHit) { exitAll(position.stopPrice, position.trailingActive ? 'trailing_stop_same_bar' : 'stop_loss_same_bar'); return; }
  if (stopHit) { exitAll(position.stopPrice, position.trailingActive ? 'trailing_stop' : 'stop_loss'); return; }
  while (targets.length > 0 && better(extremeFor, targets[0].price) && position.remaining > 0) {
    const target = targets.shift();
    if (target.final) exitAll(target.price, 'take_profit');
    else {
      closeLeg(position, { price: target.price, quantity: Math.min(position.remaining, position.quantity * target.fraction), exitTime: candle.timestamp, reason: 'partial_take_profit' }, context);
      position.partialsFilled += 1;
    }
  }
  if (position.remaining <= 0) return;
  if (position.timeBars !== null && index - position.entryIndex + 1 >= position.timeBars) { exitAll(candle.close, 'time_exit'); return; }

  // ----- end-of-bar ratchets (effective from the next bar) -----
  position.bestPrice = long ? Math.max(position.bestPrice, candle.high) : Math.min(position.bestPrice, candle.low);
  const extended = position.extended;
  if (extended?.breakevenAfterFirstPartial && position.partialsFilled > 0) {
    position.stopPrice = long ? Math.max(position.stopPrice, position.entryPrice) : Math.min(position.stopPrice, position.entryPrice);
  }
  if (extended?.trailing && Number.isFinite(atrNow) && atrNow > 0) {
    const favourable = long ? position.bestPrice - position.entryPrice : position.entryPrice - position.bestPrice;
    if (favourable >= extended.trailing.activationRiskMultiple * position.riskDistance - EPSILON) {
      const trail = long ? position.bestPrice - (atrNow * extended.trailing.atrMultiple) : position.bestPrice + (atrNow * extended.trailing.atrMultiple);
      const tightened = long ? Math.max(position.stopPrice, trail) : Math.min(position.stopPrice, trail);
      if (tightened !== position.stopPrice) position.trailingActive = true;
      position.stopPrice = tightened;
    }
  }
}

function runExtendedLoop(input, finalHoldout, extended) {
  const { backtestInput, strategy, strategyVersion, parameters = {}, signalEvaluator, period } = input;
  if (!backtestInput || typeof backtestInput !== 'object') fail('INVALID_INDEPENDENT_INPUT');
  if (typeof signalEvaluator !== 'function') fail('INVALID_SIGNAL_EVALUATOR');
  const market = String(backtestInput.market ?? '');
  if (!MARKETS.has(market)) fail('INVALID_MARKET', market);
  const side = backtestInput.side ?? 'long';
  if (!['long', 'short'].includes(side)) fail('INVALID_SIDE');
  if (CASH_MARKETS.has(market) && side !== 'long') fail('CASH_SHORT_NOT_ALLOWED');
  const symbol = normalizeResearchSymbol(market, backtestInput.symbol);
  const timeframe = String(backtestInput.timeframe ?? '1d');
  const initialCapital = positiveFinite(backtestInput.initialCapital ?? RESEARCH_BACKTEST_PERIOD.initialCapital, 'INITIAL_CAPITAL_INVALID');
  const { startTime, endTime } = resolvePeriod(period, finalHoldout);
  const atrPeriod = parameters.atrPeriod ?? 14;
  const stopAtrMultiple = positiveFinite(parameters.stopAtrMultiple ?? 1.5, 'STOP_ATR_MULTIPLE_INVALID');
  const plainTargetMultiple = parameters.targetRiskMultiple ?? 2;
  const timeBars = parameters.timeBars ?? null;
  if (!Number.isInteger(atrPeriod) || atrPeriod < 2) fail('INVALID_ATR_PERIOD');
  if (timeBars !== null && (!Number.isSafeInteger(timeBars) || timeBars < 1)) fail('INVALID_TIME_BARS');
  const risk = normalizeRisk(market, backtestInput.riskModel ?? {});
  const costModel = normalizeCost(backtestInput.costModel ?? {});
  const fundingRates = [...(backtestInput.fundingRates ?? [])].map((row) => ({ timestamp: row.timestamp, rate: row.rate }))
    .sort((a, b) => a.timestamp - b.timestamp);
  const candles = [...(backtestInput.candles ?? [])].filter((row) => row.timestamp <= endTime).sort((a, b) => a.timestamp - b.timestamp);
  if (candles.length < atrPeriod + 3) fail('INSUFFICIENT_CANDLES');
  const atr = atrSeries(candles, atrPeriod);
  const action = market === 'CRYPTO_FUTURES' ? (side === 'long' ? 'LONG' : 'SHORT') : 'BUY';
  const context = { costModel, fundingRates };
  const trades = [];
  let equity = initialCapital;
  let position = null;

  const settle = () => {
    const trade = finalizeTrade(position, equity);
    trades.push(trade);
    equity = trade.equityAfter;
    position = null;
  };

  for (let index = 1; index < candles.length; index += 1) {
    const candle = candles[index];
    if (position) {
      stepPosition(position, candle, index, atr[index], context);
      if (position.remaining <= 0) settle();
      continue;
    }
    if (equity <= 0) break;
    if (candle.timestamp < startTime || candle.timestamp > endTime) continue;
    if (index + 1 >= candles.length) continue;
    const entryCandle = candles[index + 1];
    if (entryCandle.timestamp > endTime) continue;
    const atrNow = atr[index];
    if (!Number.isFinite(atrNow) || atrNow <= 0) continue;
    const signalContext = signalEvaluator({ market, side, symbol, timeframe, candles, atr, index, atrNow });
    if (!signalContext) continue;
    const entryPrice = entryCandle.open;
    const riskDistance = atrNow * stopAtrMultiple;
    const long = side === 'long';
    const stopPrice = long ? entryPrice - riskDistance : entryPrice + riskDistance;
    const at = (multiple) => (long ? entryPrice + (riskDistance * multiple) : entryPrice - (riskDistance * multiple));
    const targets = [];
    if (extended) {
      for (const row of extended.partials) targets.push({ price: at(row.riskMultiple), fraction: row.fraction, final: false });
      if (extended.finalTargetRiskMultiple != null) targets.push({ price: at(extended.finalTargetRiskMultiple), fraction: 1, final: true });
    } else {
      targets.push({ price: at(plainTargetMultiple), fraction: 1, final: true });
    }
    if (!(stopPrice > 0) || targets.some((row) => !(row.price > 0))) continue;
    const quantity = positionSize({ equity, entryPrice, stopPrice, risk });
    if (!(quantity > 0)) continue;
    position = {
      market, symbol, timeframe, side, action,
      strategy: String(strategy ?? 'independent_signal'),
      strategyVersion: String(strategyVersion ?? 'INDEPENDENT'),
      signalTime: candle.timestamp,
      entryTime: entryCandle.timestamp,
      entryIndex: index + 1,
      entryPrice,
      stopPrice,
      initialStopPrice: stopPrice,
      riskDistance,
      targets,
      timeBars,
      quantity,
      remaining: quantity,
      leverage: risk.leverage,
      riskBudget: equity * risk.riskPerTrade,
      bestPrice: entryPrice,
      trailingActive: false,
      partialsFilled: 0,
      extended,
      legs: [],
      signalContext: Object.freeze({ ...signalContext }),
    };
    // The entry bar itself is evaluated on the next loop iteration (index + 1),
    // matching the canonical loop where the entry candle is also the first
    // candle checked for stop/target.
  }
  if (position) {
    const last = candles.at(-1);
    if (last.timestamp >= position.entryTime) {
      closeLeg(position, { price: last.close, quantity: position.remaining, exitTime: last.timestamp, reason: 'end_of_data' }, context);
      settle();
    }
  }
  return Object.freeze({
    ok: true,
    mode: 'backtest-only',
    engine: EXTENDED_EXIT_BACKTEST_VERSION,
    market, symbol, side, timeframe, initialCapital,
    finalCapital: equity,
    totalTrades: trades.length,
    trades: Object.freeze(trades.sort((a, b) => a.exitTime - b.exitTime || a.id.localeCompare(b.id))),
    extendedExit: extended,
    safeguards: Object.freeze({
      signalUsesClosedCandle: true,
      entryUsesNextCandleOpen: true,
      stopFirstOnAmbiguousBar: true,
      trailingUsesFinishedBarOnly: true,
      oneTradeRecordPerPosition: true,
      finalHoldoutUsedForSelection: false,
      orderSubmitted: false,
      executionAuthority: 'NONE',
    }),
  });
}

/**
 * Same contract as `runIndependentSignalBacktest`, plus `parameters.extended`
 * ({ trailing, partials, finalTargetRiskMultiple, breakevenAfterFirstPartial }).
 */
export function runExtendedExitBacktestV1(input = {}, { forceExtendedLoop = false } = {}) {
  const { extended: rawExtended, ...plainParameters } = input.parameters ?? {};
  const extended = normalizeExtendedExitV1(rawExtended);
  if (!extended && !forceExtendedLoop) return runIndependentSignalBacktest({ ...input, parameters: plainParameters });
  return runExtendedLoop({ ...input, parameters: plainParameters }, false, extended);
}

export function runExtendedExitFinalHoldoutV1(input = {}, { forceExtendedLoop = false } = {}) {
  const { extended: rawExtended, ...plainParameters } = input.parameters ?? {};
  const extended = normalizeExtendedExitV1(rawExtended);
  if (!extended && !forceExtendedLoop) return runIndependentSignalFinalHoldout({ ...input, parameters: plainParameters });
  return runExtendedLoop({ ...input, parameters: plainParameters }, true, extended);
}

/**
 * Forward (paper) evaluation on data after the research end. Always uses the
 * extended loop (proven equal to the canonical loop on plain exits) because
 * the canonical backtester only accepts research and holdout periods. Signals
 * before `period.startTime` are ignored; earlier candles only warm up ATR.
 */
export function runExtendedExitForwardV1(input = {}) {
  const { extended: rawExtended, ...plainParameters } = input.parameters ?? {};
  const extended = normalizeExtendedExitV1(rawExtended);
  return runExtendedLoop({ ...input, parameters: plainParameters }, 'forward', extended);
}
