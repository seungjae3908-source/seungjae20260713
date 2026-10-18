// Managed-exit backtester (research only, never places orders).
//
// Same entry contract as the canonical independent backtester
// (market-prediction-lab/src/independent-strategy-backtest.js): closed-candle
// signal, next-candle-open entry, ATR stop, risk-budget sizing, the shared
// execution cost model and funding. On top of that it can manage the exit:
//
//   * partial take-profits at R multiples (e.g. 30% at 1R, 30% at 2R)
//   * stop to breakeven once a given R has been reached
//   * an ATR trailing stop (chandelier: best price since entry − k × ATR)
//   * a time stop: leave after N bars if the trade never reached +X R
//   * pyramiding: start smaller and add only while the trade is working
//
// With no partials, no trailing, no breakeven, no time stop and a single entry,
// it reproduces the canonical backtester trade for trade (see the equivalence
// test). The canonical file itself is left untouched.
//
// Conservative fill rules on 1h bars, where the order of high and low inside a
// bar is unknown:
//   * gap through the stop at the open → exit at the open
//   * stop and any favourable level in the same bar → the stop wins
//   * an add order and the stop in the same bar → the add fills first, then the
//     stop (the worst case for pyramiding)
//   * breakeven and trailing updates use the closed bar and apply from the next
//     bar, so a level is never moved and hit inside the same bar
import {
  ResearchContractError,
  calculateSignalExcursion,
  normalizeResearchSymbol,
} from '../../market-prediction-lab/src/research-governance.js';
import {
  calculateExecutionAwareTrade,
  summarizeResearchPerformance,
} from '../../market-prediction-lab/src/research-validation-layer.js';
import { RESEARCH_BACKTEST_PERIOD } from '../../market-prediction-lab/src/multi-market-backtest-engine.js';

export const MANAGED_EXIT_BACKTEST_CONTRACT_V1 = 'managed-exit-backtest/v1';

const MARKETS = new Set(['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES']);
const CASH_MARKETS = new Set(['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT']);
const EPSILON = 1e-12;

function contractError(code, message, details) {
  return new ResearchContractError(code, message, details);
}

function finitePositive(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !(value > 0)) {
    throw contractError('NON_POSITIVE_NUMBER', `${label} must be a finite number greater than zero`, { label, value });
  }
  return value;
}

function fraction(value, label) {
  finitePositive(value, label);
  if (value > 1) throw contractError('INVALID_FRACTION', `${label} must be <= 1`, { label, value });
  return value;
}

function mean(values) {
  if (!values.length) return null;
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

function normalizeRiskModel(market, input = {}) {
  const risk = {
    riskPerTrade: input.riskPerTrade ?? 0.01,
    maximumCapitalFraction: input.maximumCapitalFraction ?? 1,
    leverage: input.leverage ?? 1,
  };
  fraction(risk.riskPerTrade, 'riskModel.riskPerTrade');
  fraction(risk.maximumCapitalFraction, 'riskModel.maximumCapitalFraction');
  finitePositive(risk.leverage, 'riskModel.leverage');
  if (market !== 'CRYPTO_FUTURES' && risk.leverage !== 1) throw contractError('INVALID_LEVERAGE', `${market} leverage must be 1`);
  if (market === 'CRYPTO_FUTURES' && risk.leverage > 10) throw contractError('INVALID_LEVERAGE', 'CRYPTO_FUTURES leverage must be <= 10');
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
  if (matching.length > 1) throw contractError('OVERLAPPING_COST_SCHEDULE', 'multiple cost schedule rows match timestamp', { timestamp });
  return matching[0] ?? model;
}

function sortedFunding(rows = []) {
  if (!Array.isArray(rows)) throw contractError('INVALID_FUNDING', 'fundingRates must be an array');
  return rows.map((row) => ({ timestamp: row.timestamp, rate: row.rate })).sort((a, b) => a.timestamp - b.timestamp);
}

function fundingBetween(rows, entryTime, exitTime) {
  return rows.filter((row) => row.timestamp > entryTime && row.timestamp <= exitTime).map((row) => row.rate);
}

/**
 * Exit plan, all distances in R (R = initial stop distance):
 *   stopAtrMultiple       initial stop distance in ATR
 *   maxStopFraction       optional cap of the stop distance as a price fraction (e.g. 0.025)
 *   targetR               final target for whatever is still open (null = none)
 *   partials              [{ atR, fraction }] fraction of the total opened quantity
 *   breakevenAfterR       stop → entry once the best price reached this R (null = never)
 *   trailing              { atrMultiple, activateAtR } chandelier trail (null = none)
 *   timeStop              { bars, minFavorableR } leave if not working after N bars
 *   maxHoldBars           hard holding cap (null = none)
 * Entry plan:
 *   initialFraction       share of the risk-sized quantity bought at the signal
 *   adds                  [{ atR, fraction }] stop-entry adds, fraction of the risk-sized quantity
 *   moveStopToEntryOnAdd  after an add fills, the stop moves to the first entry price
 */
export function normalizeManagedPlanV1(plan = {}) {
  const exit = plan.exit ?? {};
  const entry = plan.entry ?? {};
  const stopAtrMultiple = finitePositive(exit.stopAtrMultiple ?? 1.5, 'exit.stopAtrMultiple');
  const targetR = exit.targetR === null || exit.targetR === undefined ? null : finitePositive(exit.targetR, 'exit.targetR');
  const partials = (exit.partials ?? []).map((row, index) => Object.freeze({
    atR: finitePositive(row.atR, `exit.partials[${index}].atR`),
    fraction: fraction(row.fraction, `exit.partials[${index}].fraction`),
  })).sort((a, b) => a.atR - b.atR);
  const partialTotal = partials.reduce((sum, row) => sum + row.fraction, 0);
  if (partialTotal > 1 + EPSILON) throw contractError('INVALID_PARTIALS', 'partial fractions cannot exceed 1', { partialTotal });
  if (targetR !== null && partials.some((row) => row.atR >= targetR)) {
    throw contractError('INVALID_PARTIALS', 'every partial must sit below the final target');
  }
  const breakevenAfterR = exit.breakevenAfterR === null || exit.breakevenAfterR === undefined ? null : finitePositive(exit.breakevenAfterR, 'exit.breakevenAfterR');
  const trailing = exit.trailing ? Object.freeze({
    atrMultiple: finitePositive(exit.trailing.atrMultiple, 'exit.trailing.atrMultiple'),
    activateAtR: exit.trailing.activateAtR === undefined || exit.trailing.activateAtR === 0 ? 0 : finitePositive(exit.trailing.activateAtR, 'exit.trailing.activateAtR'),
  }) : null;
  if (targetR === null && trailing === null && partialTotal < 1 - EPSILON && exit.maxHoldBars == null) {
    throw contractError('UNBOUNDED_EXIT', 'without a target or trailing stop a holding cap is required');
  }
  const timeStop = exit.timeStop ? Object.freeze({
    bars: exit.timeStop.bars,
    minFavorableR: exit.timeStop.minFavorableR ?? 0,
  }) : null;
  if (timeStop && (!Number.isSafeInteger(timeStop.bars) || timeStop.bars < 1 || !Number.isFinite(timeStop.minFavorableR))) {
    throw contractError('INVALID_TIME_STOP', 'timeStop needs integer bars >= 1 and a finite minFavorableR');
  }
  const maxHoldBars = exit.maxHoldBars ?? null;
  const maxStopFraction = exit.maxStopFraction == null ? null : fraction(exit.maxStopFraction, 'exit.maxStopFraction');
  if (maxHoldBars !== null && (!Number.isSafeInteger(maxHoldBars) || maxHoldBars < 1)) {
    throw contractError('INVALID_TIME_BARS', 'maxHoldBars must be an integer >= 1');
  }
  const initialFraction = fraction(entry.initialFraction ?? 1, 'entry.initialFraction');
  const adds = (entry.adds ?? []).map((row, index) => Object.freeze({
    atR: finitePositive(row.atR, `entry.adds[${index}].atR`),
    fraction: fraction(row.fraction, `entry.adds[${index}].fraction`),
  })).sort((a, b) => a.atR - b.atR);
  return Object.freeze({
    exit: Object.freeze({ stopAtrMultiple, maxStopFraction, targetR, partials: Object.freeze(partials), breakevenAfterR, trailing, timeStop, maxHoldBars }),
    entry: Object.freeze({ initialFraction, adds: Object.freeze(adds), moveStopToEntryOnAdd: entry.moveStopToEntryOnAdd !== false }),
  });
}

function phaseForTimestamp(timestamp) {
  if (timestamp <= RESEARCH_BACKTEST_PERIOD.developmentEndTime) return 'development';
  if (timestamp <= RESEARCH_BACKTEST_PERIOD.validationEndTime) return 'validation';
  return 'final_holdout';
}

// ---------- position helpers (direction aware) ----------

const reached = (dir, price, level) => (dir > 0 ? price >= level - EPSILON : price <= level + EPSILON);
const levelPrice = (position, r) => position.firstEntryPrice + (position.dir * r * position.riskUnit);
const better = (dir, a, b) => (dir > 0 ? Math.max(a, b) : Math.min(a, b));
const openQuantity = (position) => position.legs.reduce((sum, leg) => sum + leg.open, 0);

function closeQuantity(position, quantity, price, reason, candle, index) {
  const total = openQuantity(position);
  if (!(total > EPSILON)) return;
  const closeAll = quantity >= total - EPSILON;
  const share = closeAll ? 1 : quantity / total;
  for (const leg of position.legs) {
    if (!(leg.open > EPSILON)) continue;
    const chunk = closeAll ? leg.open : leg.open * share;
    leg.open = closeAll ? 0 : leg.open - chunk;
    position.fills.push({ kind: 'exit', reason, legEntryPrice: leg.entryPrice, legEntryTime: leg.entryTime, price, quantity: chunk, time: candle.timestamp, index });
  }
  position.lastExitReason = reason;
}

function addLeg(position, quantity, price, candle, index) {
  if (!(quantity > EPSILON)) return;
  position.legs.push({ entryPrice: price, entryTime: candle.timestamp, entryIndex: index, open: quantity, opened: quantity });
  position.openedQuantity += quantity;
  position.fills.push({ kind: 'add', price, quantity, time: candle.timestamp, index });
  if (position.plan.entry.moveStopToEntryOnAdd) position.pendingStop = better(position.dir, position.pendingStop ?? position.stopPrice, position.firstEntryPrice);
}

function addQuantity(position, add, price) {
  const wanted = position.baseQuantity * add.fraction;
  const openNotional = position.legs.reduce((sum, leg) => sum + (leg.open * leg.entryPrice), 0);
  const room = Math.max(0, position.maximumNotional - openNotional) / price;
  return Math.min(wanted, room);
}

function fillPartial(position, partial, price, candle, index) {
  const wanted = position.openedQuantity * partial.fraction;
  closeQuantity(position, Math.min(wanted, openQuantity(position)), price, `partial_${partial.atR}R`, candle, index);
}

/** Processes one bar for an open position. Returns true when it is flat. */
function stepPosition(position, candle, index, atrNow) {
  const { dir, plan } = position;
  const exitPlan = plan.exit;
  const adverse = (price) => (dir > 0 ? price <= position.stopPrice + EPSILON : price >= position.stopPrice - EPSILON);
  const stopReason = position.stopKind === 'initial' ? 'stop_loss' : `${position.stopKind}_stop`;

  // 1. gap through the stop at the open
  if (adverse(candle.open)) {
    closeQuantity(position, Infinity, candle.open, position.stopKind === 'initial' ? 'stop_loss_gap' : `${position.stopKind}_stop_gap`, candle, index);
    return true;
  }
  // 2. favourable levels already passed at the open
  const targetPrice = exitPlan.targetR === null ? null : levelPrice(position, exitPlan.targetR);
  if (targetPrice !== null && reached(dir, candle.open, targetPrice)) {
    closeQuantity(position, Infinity, targetPrice, 'take_profit', candle, index);
    return true;
  }
  while (position.nextPartial < exitPlan.partials.length && reached(dir, candle.open, levelPrice(position, exitPlan.partials[position.nextPartial].atR))) {
    const partial = exitPlan.partials[position.nextPartial];
    fillPartial(position, partial, levelPrice(position, partial.atR), candle, index);
    position.nextPartial += 1;
  }
  while (position.nextAdd < plan.entry.adds.length && reached(dir, candle.open, levelPrice(position, plan.entry.adds[position.nextAdd].atR))) {
    const add = plan.entry.adds[position.nextAdd];
    addLeg(position, addQuantity(position, add, candle.open), candle.open, candle, index);
    position.nextAdd += 1;
  }
  if (!(openQuantity(position) > EPSILON)) return true;

  // 3. the stop inside the bar wins over every favourable level
  const extremeAdverse = dir > 0 ? candle.low : candle.high;
  const extremeFavourable = dir > 0 ? candle.high : candle.low;
  if (adverse(extremeAdverse)) {
    // Worst case for pyramiding: pending adds inside the range fill first.
    while (position.nextAdd < plan.entry.adds.length && reached(dir, extremeFavourable, levelPrice(position, plan.entry.adds[position.nextAdd].atR))) {
      const add = plan.entry.adds[position.nextAdd];
      const price = levelPrice(position, add.atR);
      addLeg(position, addQuantity(position, add, price), price, candle, index);
      position.nextAdd += 1;
    }
    const sameBarTarget = targetPrice !== null && reached(dir, extremeFavourable, targetPrice);
    closeQuantity(position, Infinity, position.stopPrice, sameBarTarget && position.stopKind === 'initial' ? 'stop_loss_same_bar' : stopReason, candle, index);
    return true;
  }
  // 4. favourable levels inside the bar
  while (position.nextPartial < exitPlan.partials.length && reached(dir, extremeFavourable, levelPrice(position, exitPlan.partials[position.nextPartial].atR))) {
    const partial = exitPlan.partials[position.nextPartial];
    fillPartial(position, partial, levelPrice(position, partial.atR), candle, index);
    position.nextPartial += 1;
  }
  while (position.nextAdd < plan.entry.adds.length && reached(dir, extremeFavourable, levelPrice(position, plan.entry.adds[position.nextAdd].atR))) {
    const add = plan.entry.adds[position.nextAdd];
    const price = levelPrice(position, add.atR);
    addLeg(position, addQuantity(position, add, price), price, candle, index);
    position.nextAdd += 1;
  }
  if (!(openQuantity(position) > EPSILON)) return true;
  if (targetPrice !== null && reached(dir, extremeFavourable, targetPrice)) {
    closeQuantity(position, Infinity, targetPrice, 'take_profit', candle, index);
    return true;
  }

  // 5. closed-bar updates, effective from the next bar
  position.bestPrice = better(dir, position.bestPrice, extremeFavourable);
  position.maxFavorableR = Math.max(position.maxFavorableR, (dir * (position.bestPrice - position.firstEntryPrice)) / position.riskUnit);
  let nextStop = position.stopPrice;
  let nextKind = position.stopKind;
  const moveTo = (price, kind) => {
    const candidate = better(dir, nextStop, price);
    if (candidate !== nextStop) { nextStop = candidate; nextKind = kind; }
  };
  if (position.pendingStop !== null) { moveTo(position.pendingStop, 'breakeven'); position.pendingStop = null; }
  if (exitPlan.breakevenAfterR !== null && position.maxFavorableR >= exitPlan.breakevenAfterR - EPSILON) moveTo(position.firstEntryPrice, 'breakeven');
  if (exitPlan.trailing && position.maxFavorableR >= exitPlan.trailing.activateAtR - EPSILON) {
    const atrForTrail = Number.isFinite(atrNow) && atrNow > 0 ? atrNow : position.entryAtr;
    moveTo(position.bestPrice - (dir * exitPlan.trailing.atrMultiple * atrForTrail), 'trailing');
  }
  position.stopPrice = nextStop;
  position.stopKind = nextKind;

  // 6. time stop and holding cap at the close
  const barsHeld = index - position.entryIndex + 1;
  if (exitPlan.timeStop && barsHeld === exitPlan.timeStop.bars && position.maxFavorableR < exitPlan.timeStop.minFavorableR) {
    closeQuantity(position, Infinity, candle.close, 'time_stop', candle, index);
    return true;
  }
  if (exitPlan.maxHoldBars !== null && barsHeld >= exitPlan.maxHoldBars) {
    closeQuantity(position, Infinity, candle.close, 'time_exit', candle, index);
    return true;
  }
  return false;
}

const COST_KEYS = ['entryFee', 'exitFee', 'tax', 'funding', 'slippage', 'spread', 'latency', 'total'];

function settleManaged({ position, exitCandle, exitIndex, candles, costModel, fundingRates, equity }) {
  const costs = Object.fromEntries(COST_KEYS.map((key) => [key, 0]));
  let netPnl = 0; let grossPnl = 0; let entryNotional = 0; let exitValue = 0; let exitQuantity = 0;
  const exits = position.fills.filter((fill) => fill.kind === 'exit');
  for (const fill of exits) {
    const entryCosts = costAt(costModel, fill.legEntryTime);
    const exitCosts = costAt(costModel, fill.time);
    const execution = calculateExecutionAwareTrade({
      market: position.market,
      action: position.action,
      entryPrice: fill.legEntryPrice,
      exitPrice: fill.price,
      quantity: fill.quantity,
      leverage: position.leverage,
      entryFeeRate: entryCosts.entryFeeRate,
      exitFeeRate: exitCosts.exitFeeRate,
      taxRate: exitCosts.taxRate,
      slippageRate: Math.max(entryCosts.slippageRate, exitCosts.slippageRate),
      spreadRate: Math.max(entryCosts.spreadRate, exitCosts.spreadRate),
      latencyBars: Math.max(entryCosts.latencyBars, exitCosts.latencyBars),
      latencyDriftRate: Math.max(entryCosts.latencyDriftRate, exitCosts.latencyDriftRate),
      fundingRates: fundingBetween(fundingRates, fill.legEntryTime, fill.time),
    });
    netPnl += execution.netPnl;
    grossPnl += execution.grossPnl;
    entryNotional += execution.entryNotional;
    exitValue += fill.price * fill.quantity;
    exitQuantity += fill.quantity;
    for (const key of COST_KEYS) costs[key] += execution.costs[key] ?? 0;
  }
  const openedValue = position.legs.reduce((sum, leg) => sum + (leg.opened * leg.entryPrice), 0);
  const excursion = calculateSignalExcursion({
    action: position.action,
    entryPrice: position.firstEntryPrice,
    candles: candles.slice(position.entryIndex, exitIndex + 1),
  });
  const margin = entryNotional / position.leverage;
  return Object.freeze({
    id: `${position.strategyVersion}:${position.market}:${position.symbol}:${position.entryTime}:${exitCandle.timestamp}:${position.side}`,
    market: position.market,
    symbol: position.symbol,
    strategy: position.strategy,
    strategyVersion: position.strategyVersion,
    timeframe: position.timeframe,
    side: position.side,
    action: position.action,
    regime: 'independent_structure',
    phase: phaseForTimestamp(position.signalTime),
    signalTime: position.signalTime,
    entryTime: position.entryTime,
    exitTime: exitCandle.timestamp,
    entryPrice: position.firstEntryPrice,
    averageEntryPrice: openedValue / position.openedQuantity,
    requestedExitPrice: exitQuantity > 0 ? exitValue / exitQuantity : null,
    stopPrice: position.initialStopPrice,
    finalStopPrice: position.stopPrice,
    targetPrice: position.plan.exit.targetR === null ? null : levelPrice(position, position.plan.exit.targetR),
    quantity: position.openedQuantity,
    leverage: position.leverage,
    riskBudget: position.riskBudget,
    exitReason: position.lastExitReason,
    partialExits: exits.filter((fill) => fill.reason.startsWith('partial_')).length,
    adds: position.fills.filter((fill) => fill.kind === 'add').length,
    barsHeld: exitIndex - position.entryIndex + 1,
    maxFavorableR: position.maxFavorableR,
    rMultiple: position.riskBudget > 0 ? netPnl / position.riskBudget : null,
    netPnl,
    grossPnl,
    netReturnOnMargin: margin > 0 ? netPnl / margin : 0,
    entryNotional,
    costsIncluded: true,
    costs: Object.freeze(costs),
    fills: Object.freeze(position.fills.map((fill) => Object.freeze({ ...fill }))),
    maximumFavorableExcursion: excursion.maximumFavorableExcursion,
    maximumAdverseExcursion: excursion.maximumAdverseExcursion,
    signalContext: position.signalContext,
    equityBefore: equity,
    equityAfter: equity + netPnl,
  });
}

/**
 * Research backtest with a managed exit plan. Selection data only: any candle on
 * or after 2026-01-01 is refused, so the sealed holdout cannot leak in here.
 */
export function runManagedExitBacktestV1({
  backtestInput,
  strategy = 'managed_exit_v1',
  strategyVersion = 'MANAGED_EXIT_V1',
  plan,
  atrPeriod = 14,
  signalEvaluator,
  period = {},
} = {}) {
  if (!backtestInput || typeof backtestInput !== 'object') throw contractError('INVALID_INDEPENDENT_INPUT', 'backtestInput is required');
  if (typeof signalEvaluator !== 'function') throw contractError('INVALID_SIGNAL_EVALUATOR', 'signalEvaluator must be a function');
  const market = String(backtestInput.market ?? '');
  if (!MARKETS.has(market)) throw contractError('INVALID_MARKET', `unsupported market: ${market}`);
  const side = backtestInput.side ?? 'long';
  if (side !== 'long' && side !== 'short') throw contractError('INVALID_SIDE', 'side must be long or short');
  if (CASH_MARKETS.has(market) && side !== 'long') throw contractError('CASH_SHORT_NOT_ALLOWED', `${market} backtests are long-only`);
  const symbol = normalizeResearchSymbol(market, backtestInput.symbol);
  const timeframe = String(backtestInput.timeframe ?? '1d');
  const initialCapital = finitePositive(backtestInput.initialCapital ?? RESEARCH_BACKTEST_PERIOD.initialCapital, 'initialCapital');
  if (!Number.isInteger(atrPeriod) || atrPeriod < 2) throw contractError('INVALID_ATR_PERIOD', 'atrPeriod must be integer >= 2');
  const normalizedPlan = normalizeManagedPlanV1(plan);
  const riskModel = normalizeRiskModel(market, backtestInput.riskModel ?? {});
  const costModel = normalizeCostModel(backtestInput.costModel ?? {});
  const fundingRates = sortedFunding(backtestInput.fundingRates ?? []);
  const candles = [...(backtestInput.candles ?? [])].sort((a, b) => a.timestamp - b.timestamp);
  if (candles.some((candle) => candle.timestamp >= RESEARCH_BACKTEST_PERIOD.finalHoldoutStartTime)) {
    throw contractError('INDEPENDENT_HOLDOUT_LOCKED', 'managed-exit research cannot read the 2026 final holdout');
  }
  if (candles.length < atrPeriod + 3) throw contractError('INSUFFICIENT_CANDLES', 'managed-exit backtest requires more candles');
  const startTime = period.startTime ?? candles[0].timestamp;
  const endTime = period.endTime ?? candles.at(-1).timestamp;
  const inPeriod = candles.filter((candle) => candle.timestamp <= endTime);
  const atr = atrSeries(inPeriod, atrPeriod);
  const dir = side === 'long' ? 1 : -1;
  const action = market === 'CRYPTO_FUTURES' ? (side === 'long' ? 'LONG' : 'SHORT') : 'BUY';
  const trades = [];
  let equity = initialCapital;
  let position = null;

  const finish = (exitCandle, exitIndex) => {
    const trade = settleManaged({ position, exitCandle, exitIndex, candles: inPeriod, costModel, fundingRates, equity });
    trades.push(trade);
    equity = trade.equityAfter;
    position = null;
  };

  for (let index = 1; index < inPeriod.length; index += 1) {
    const candle = inPeriod[index];
    if (position) {
      if (stepPosition(position, candle, index, atr[index])) finish(candle, index);
      continue;
    }
    if (equity <= 0) break;
    if (candle.timestamp < startTime || candle.timestamp > endTime) continue;
    if (index + 1 >= inPeriod.length) continue;
    const entryCandle = inPeriod[index + 1];
    const atrNow = atr[index];
    if (!Number.isFinite(atrNow) || atrNow <= 0) continue;
    const signalContext = signalEvaluator({ market, side, symbol, timeframe, candles: inPeriod, atr, index, atrNow });
    if (!signalContext) continue;
    const entryPrice = entryCandle.open;
    const riskUnit = normalizedPlan.exit.maxStopFraction === null
      ? atrNow * normalizedPlan.exit.stopAtrMultiple
      : Math.min(atrNow * normalizedPlan.exit.stopAtrMultiple, entryPrice * normalizedPlan.exit.maxStopFraction);
    const stopPrice = entryPrice - (dir * riskUnit);
    if (!(stopPrice > 0)) continue;
    if (normalizedPlan.exit.targetR !== null && !(entryPrice + (dir * riskUnit * normalizedPlan.exit.targetR) > 0)) continue;
    const riskBudget = equity * riskModel.riskPerTrade;
    const maximumNotional = equity * riskModel.maximumCapitalFraction * riskModel.leverage;
    const baseQuantity = Math.min(riskBudget / riskUnit, maximumNotional / entryPrice);
    const initialQuantity = baseQuantity * normalizedPlan.entry.initialFraction;
    if (!(initialQuantity > 0)) continue;
    position = {
      market, symbol, timeframe, side, action, dir, plan: normalizedPlan,
      strategy: String(strategy), strategyVersion: String(strategyVersion),
      signalTime: candle.timestamp, entryTime: entryCandle.timestamp, entryIndex: index + 1,
      firstEntryPrice: entryPrice, riskUnit, entryAtr: atrNow,
      stopPrice, initialStopPrice: stopPrice, stopKind: 'initial', pendingStop: null,
      bestPrice: entryPrice, maxFavorableR: 0,
      baseQuantity, maximumNotional, openedQuantity: initialQuantity,
      legs: [{ entryPrice, entryTime: entryCandle.timestamp, entryIndex: index + 1, open: initialQuantity, opened: initialQuantity }],
      fills: [{ kind: 'entry', price: entryPrice, quantity: initialQuantity, time: entryCandle.timestamp, index: index + 1 }],
      nextPartial: 0, nextAdd: 0, lastExitReason: null,
      leverage: riskModel.leverage, riskBudget,
      signalContext: Object.freeze({ ...signalContext }),
    };
  }

  if (position) {
    const exitIndex = inPeriod.length - 1;
    const exitCandle = inPeriod[exitIndex];
    if (exitCandle.timestamp >= position.entryTime) {
      closeQuantity(position, Infinity, exitCandle.close, 'end_of_data', exitCandle, exitIndex);
      finish(exitCandle, exitIndex);
    }
  }

  const orderedTrades = Object.freeze([...trades].sort((a, b) => a.exitTime - b.exitTime || a.id.localeCompare(b.id)));
  const performance = summarizeResearchPerformance(orderedTrades, { initialCapital });
  return Object.freeze({
    ok: true,
    contract: MANAGED_EXIT_BACKTEST_CONTRACT_V1,
    mode: 'backtest-only',
    market, symbol, side, timeframe, initialCapital,
    finalCapital: initialCapital + performance.overall.netPnl,
    plan: normalizedPlan,
    riskModel, costModel,
    performance,
    trades: orderedTrades,
    safeguards: Object.freeze({
      signalUsesClosedCandle: true,
      entryUsesNextCandleOpen: true,
      stopFirstOnAmbiguousBar: true,
      addBeforeStopOnAmbiguousBar: true,
      stopUpdatesApplyNextBar: true,
      executionUsesSharedCalculateExecutionAwareTrade: true,
      fundingIncludedForFutures: market === 'CRYPTO_FUTURES',
      finalHoldoutUsedForSelection: false,
      orderSubmitted: false,
      privateAccountRequestAllowed: false,
    }),
  });
}
