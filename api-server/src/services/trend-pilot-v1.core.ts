// Trend pilot v1 — pure strategy core (no I/O, no orders).
//
// Owner decision 2026-10-18: BTCUSDT / ETHUSDT Bitget USDT-futures, 4h bars,
// long-short breakout trend following, sized from the real futures balance.
// The rules mirror research-production/src/trend-pilot-backtest-v1.mjs
// (variant H4_CAP25) so live behaviour can be compared with the backtest:
//   entry   closed 4h bar closes above the prior 55-bar high and above EMA200
//           (long) / below the prior 55-bar low and below EMA200 (short)
//   stop    2 × ATR14 (simple mean of true range), never wider than 2.5%
//   manage  stop → entry after +1R; chandelier trail best − 2.5 × ATR;
//           a stop only ever tightens; flat after 180 bars
//   size    balance × 2% ÷ stop distance, ≤ member max order, ≤ 5x margin
//   guards  no new entry after the KST day lost 2% of its starting balance;
//           everything stops at −40% from the balance peak (owner choice 2026-10-18:
//           risk 2% + kill −40%; backtest +58%, max drawdown −27%)
// Every function is pure and returns explicit blockers instead of throwing on
// bad market data, so a caller can fail closed.

export const TREND_PILOT_V1 = Object.freeze({
  strategyId: 'TREND_PILOT_BTC_ETH_4H_V1',
  strategyVersion: 'trend-pilot-v1.0.0',
  symbols: Object.freeze(['BTCUSDT', 'ETHUSDT'] as const),
  timeframe: '4h',
  intervalMs: 4 * 60 * 60 * 1000,
  channelBars: 55,
  emaBars: 200,
  atrBars: 14,
  minimumBars: 215,
  stopAtrMultiple: 2,
  maxStopFraction: 0.025,
  breakevenAfterR: 1,
  trailAtrMultiple: 2.5,
  maxHoldBars: 180,
  riskFraction: 0.02,
  leverage: 5,
  marginMode: 'isolated' as const,
  dailyLossFraction: 0.02,
  killDrawdownFraction: 0.4,
  // Isolated liquidation must stay at least this many stop distances away.
  liquidationSafetyMultiple: 3,
  maintenanceMarginRate: 0.005,
});

export type TrendPilotSymbol = (typeof TREND_PILOT_V1.symbols)[number];
export type TrendPilotSide = 'long' | 'short';

export interface TrendPilotCandle {
  timestamp: number; // bar open, ms UTC
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface TrendPilotContractRules {
  minTradeNum: number; // minimum base quantity
  sizeStep: number; // base quantity step (sizeMultiplier)
  minTradeUsdt: number; // minimum notional in USDT
  priceStep: number; // price tick
}

const EPSILON = 1e-12;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositive(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

// ---------------------------------------------------------------- arithmetic

/** Division that returns null instead of Infinity/NaN. */
export function safeDivide(numerator: number, denominator: number): number | null {
  if (!isFiniteNumber(numerator) || !isFiniteNumber(denominator) || Math.abs(denominator) < EPSILON) return null;
  const value = numerator / denominator;
  return Number.isFinite(value) ? value : null;
}

/** Floors a quantity to the exchange step (guards float error like 0.30000000004). */
export function floorToStep(value: number, step: number): number | null {
  if (!isFiniteNumber(value) || value < 0 || !isPositive(step)) return null;
  const units = Math.floor((value / step) + 1e-9);
  const decimals = Math.max(0, Math.min(12, Math.ceil(-Math.log10(step))));
  return Number((units * step).toFixed(decimals));
}

/** Rounds a stop price to the tick, toward the side that keeps the stop at least as tight. */
export function roundStopToTick(price: number, tick: number, side: TrendPilotSide): number | null {
  if (!isPositive(price) || !isPositive(tick)) return null;
  const units = side === 'long' ? Math.ceil((price / tick) - 1e-9) : Math.floor((price / tick) + 1e-9);
  const decimals = Math.max(0, Math.min(12, Math.ceil(-Math.log10(tick))));
  const rounded = Number((units * tick).toFixed(decimals));
  return rounded > 0 ? rounded : null;
}

/** Signed P&L in quote currency for a position (fees excluded). */
export function computePositionPnl(side: TrendPilotSide, entryPrice: number, exitPrice: number, quantity: number): number | null {
  if (!isPositive(entryPrice) || !isPositive(exitPrice) || !isFiniteNumber(quantity) || quantity < 0) return null;
  const direction = side === 'long' ? 1 : -1;
  return direction * (exitPrice - entryPrice) * quantity;
}

/** Return on margin (ROI) for an isolated position; null when margin is zero. */
export function computeReturnOnMargin(pnl: number, marginUsed: number): number | null {
  if (!isFiniteNumber(pnl) || !isPositive(marginUsed)) return null;
  return safeDivide(pnl, marginUsed);
}

/** R multiple of a price move relative to the initial risk unit. */
export function computeRMultiple(side: TrendPilotSide, entryPrice: number, price: number, riskUnit: number): number | null {
  if (!isPositive(entryPrice) || !isPositive(price) || !isPositive(riskUnit)) return null;
  const direction = side === 'long' ? 1 : -1;
  return safeDivide(direction * (price - entryPrice), riskUnit);
}

/** Quantity-weighted average entry price; null on empty or invalid fills. */
export function computeAverageEntryPrice(fills: ReadonlyArray<{ price: number; quantity: number }>): number | null {
  let notional = 0;
  let quantity = 0;
  for (const fill of fills) {
    if (!isPositive(fill?.price) || !isPositive(fill?.quantity)) return null;
    notional += fill.price * fill.quantity;
    quantity += fill.quantity;
  }
  return safeDivide(notional, quantity);
}

/**
 * Approximate isolated-margin liquidation price (linear USDT contract):
 * long  = entry × (1 − 1/leverage + mmr), short = entry × (1 + 1/leverage − mmr).
 */
export function estimateIsolatedLiquidationPrice(side: TrendPilotSide, entryPrice: number, leverage: number, maintenanceMarginRate: number): number | null {
  if (!isPositive(entryPrice) || !isPositive(leverage) || leverage < 1 || !isFiniteNumber(maintenanceMarginRate) || maintenanceMarginRate < 0) return null;
  const inverse = safeDivide(1, leverage);
  if (inverse === null) return null;
  const price = side === 'long'
    ? entryPrice * (1 - inverse + maintenanceMarginRate)
    : entryPrice * (1 + inverse - maintenanceMarginRate);
  return price > 0 ? price : null;
}

// ---------------------------------------------------------------- indicators

/** Bars whose close time is at or before nowMs, sorted, de-duplicated, validated. */
export function selectClosedBars(candles: ReadonlyArray<TrendPilotCandle>, nowMs: number, intervalMs: number = TREND_PILOT_V1.intervalMs): TrendPilotCandle[] {
  const byTime = new Map<number, TrendPilotCandle>();
  for (const c of candles ?? []) {
    if (!c || !Number.isSafeInteger(c.timestamp)) continue;
    if (![c.open, c.high, c.low, c.close].every(isPositive)) continue;
    if (c.high + EPSILON < Math.max(c.open, c.close) || c.low - EPSILON > Math.min(c.open, c.close)) continue;
    if (c.timestamp + intervalMs > nowMs) continue;
    byTime.set(c.timestamp, c);
  }
  return [...byTime.values()].sort((a, b) => a.timestamp - b.timestamp);
}

/** ATR as the simple mean of the last `period` true ranges (same as the backtest). */
export function computeAtrSeries(candles: ReadonlyArray<TrendPilotCandle>, period: number = TREND_PILOT_V1.atrBars): Array<number | null> {
  const result: Array<number | null> = new Array(candles.length).fill(null);
  const tr: number[] = new Array(candles.length).fill(Number.NaN);
  for (let i = 1; i < candles.length; i += 1) {
    tr[i] = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    );
    if (i >= period) {
      let sum = 0;
      let ok = true;
      for (let j = i - period + 1; j <= i; j += 1) {
        if (!Number.isFinite(tr[j])) { ok = false; break; }
        sum += tr[j];
      }
      result[i] = ok ? sum / period : null;
    }
  }
  return result;
}

/** EMA seeded with the first close (same as the backtest). */
export function computeEmaSeries(candles: ReadonlyArray<TrendPilotCandle>, period: number = TREND_PILOT_V1.emaBars): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let ema: number | null = null;
  for (const c of candles) {
    ema = ema === null ? c.close : (c.close * k) + (ema * (1 - k));
    out.push(ema);
  }
  return out;
}

export interface TrendPilotSignal {
  side: TrendPilotSide | null;
  signalBarOpenMs: number | null;
  close: number | null;
  atr: number | null;
  ema: number | null;
  channelHigh: number | null;
  channelLow: number | null;
  blocker: string | null;
}

/** Signal on the LAST closed bar only. Pass closed bars (selectClosedBars). */
export function evaluateTrendPilotSignal(closedBars: ReadonlyArray<TrendPilotCandle>): TrendPilotSignal {
  const empty: TrendPilotSignal = { side: null, signalBarOpenMs: null, close: null, atr: null, ema: null, channelHigh: null, channelLow: null, blocker: null };
  if (!Array.isArray(closedBars) || closedBars.length < TREND_PILOT_V1.minimumBars) return { ...empty, blocker: 'INSUFFICIENT_BARS' };
  for (let i = 1; i < closedBars.length; i += 1) {
    if (closedBars[i].timestamp - closedBars[i - 1].timestamp !== TREND_PILOT_V1.intervalMs) return { ...empty, blocker: 'BAR_GAP' };
  }
  const index = closedBars.length - 1;
  const bar = closedBars[index];
  const ema = computeEmaSeries(closedBars)[index];
  const atr = computeAtrSeries(closedBars)[index];
  let channelHigh = -Infinity;
  let channelLow = Infinity;
  for (let j = index - TREND_PILOT_V1.channelBars; j < index; j += 1) {
    channelHigh = Math.max(channelHigh, closedBars[j].high);
    channelLow = Math.min(channelLow, closedBars[j].low);
  }
  const base = { ...empty, signalBarOpenMs: bar.timestamp, close: bar.close, atr, ema, channelHigh, channelLow };
  if (!isPositive(atr)) return { ...base, blocker: 'ATR_UNAVAILABLE' };
  if (bar.close > channelHigh && bar.close > ema) return { ...base, side: 'long' };
  if (bar.close < channelLow && bar.close < ema) return { ...base, side: 'short' };
  return base;
}

// ---------------------------------------------------------------- sizing

export interface TrendPilotEntryInput {
  side: TrendPilotSide;
  referencePrice: number; // expected fill (ask for long, bid for short), USDT
  atr: number; // USDT
  equityKrw: number; // live futures account equity in KRW
  usdKrw: number; // KRW per USDT
  maxOrderKrw: number; // member policy cap (role cap 500k / admin 1M)
  openMarginKrw: number; // margin already used by other open pilot positions
  contract: TrendPilotContractRules;
  riskFraction?: number;
  leverage?: number;
}

export interface TrendPilotEntryPlan {
  ok: boolean;
  blockers: string[];
  side: TrendPilotSide;
  stopPrice: number | null;
  riskUnit: number | null; // USDT per 1 base unit
  stopFraction: number | null;
  quantity: number | null;
  notionalUsdt: number | null;
  notionalKrw: number | null;
  marginKrw: number | null;
  riskKrw: number | null; // loss if the initial stop fills exactly
  wantedNotionalKrw: number | null;
  capReason: 'RISK' | 'MAX_ORDER' | 'MARGIN' | null;
  liquidationPrice: number | null;
  leverage: number;
}

export function computeTrendPilotEntryPlan(input: TrendPilotEntryInput): TrendPilotEntryPlan {
  const riskFraction = input.riskFraction ?? TREND_PILOT_V1.riskFraction;
  const leverage = input.leverage ?? TREND_PILOT_V1.leverage;
  const plan: TrendPilotEntryPlan = {
    ok: false, blockers: [], side: input.side, stopPrice: null, riskUnit: null, stopFraction: null, quantity: null,
    notionalUsdt: null, notionalKrw: null, marginKrw: null, riskKrw: null, wantedNotionalKrw: null, capReason: null,
    liquidationPrice: null, leverage,
  };
  const fail = (code: string): TrendPilotEntryPlan => ({ ...plan, blockers: [...plan.blockers, code] });
  if (input.side !== 'long' && input.side !== 'short') return fail('INVALID_SIDE');
  if (!isPositive(input.referencePrice)) return fail('INVALID_PRICE');
  if (!isPositive(input.atr)) return fail('INVALID_ATR');
  if (!isPositive(input.equityKrw)) return fail('NO_EQUITY');
  if (!isPositive(input.usdKrw)) return fail('INVALID_FX');
  if (!isPositive(input.maxOrderKrw)) return fail('INVALID_MAX_ORDER');
  if (!isFiniteNumber(input.openMarginKrw) || input.openMarginKrw < 0) return fail('INVALID_OPEN_MARGIN');
  if (!isPositive(riskFraction) || riskFraction > 0.03) return fail('RISK_FRACTION_OUT_OF_RANGE');
  if (!Number.isInteger(leverage) || leverage < 2 || leverage > 7) return fail('LEVERAGE_OUT_OF_RANGE');
  const c = input.contract;
  if (!c || !isPositive(c.minTradeNum) || !isPositive(c.sizeStep) || !isFiniteNumber(c.minTradeUsdt) || c.minTradeUsdt < 0 || !isPositive(c.priceStep)) return fail('INVALID_CONTRACT_RULES');

  const direction = input.side === 'long' ? 1 : -1;
  const riskUnitRaw = Math.min(input.atr * TREND_PILOT_V1.stopAtrMultiple, input.referencePrice * TREND_PILOT_V1.maxStopFraction);
  const stopPrice = roundStopToTick(input.referencePrice - (direction * riskUnitRaw), c.priceStep, input.side);
  if (stopPrice === null) return fail('INVALID_STOP');
  const riskUnit = Math.abs(input.referencePrice - stopPrice);
  if (!isPositive(riskUnit)) return fail('STOP_AT_ENTRY');
  const stopFraction = safeDivide(riskUnit, input.referencePrice);
  if (stopFraction === null) return fail('INVALID_STOP');

  const riskBudgetKrw = input.equityKrw * riskFraction;
  const wantedNotionalKrw = safeDivide(riskBudgetKrw, stopFraction);
  if (wantedNotionalKrw === null) return fail('INVALID_STOP');
  const marginRoomKrw = Math.max(0, input.equityKrw - input.openMarginKrw) * leverage;
  let notionalKrw = wantedNotionalKrw;
  let capReason: TrendPilotEntryPlan['capReason'] = 'RISK';
  if (input.maxOrderKrw < notionalKrw) { notionalKrw = input.maxOrderKrw; capReason = 'MAX_ORDER'; }
  if (marginRoomKrw < notionalKrw) { notionalKrw = marginRoomKrw; capReason = 'MARGIN'; }

  const priceKrw = input.referencePrice * input.usdKrw;
  const rawQuantity = safeDivide(notionalKrw, priceKrw);
  const quantity = rawQuantity === null ? null : floorToStep(rawQuantity, c.sizeStep);
  const liquidationPrice = estimateIsolatedLiquidationPrice(input.side, input.referencePrice, leverage, TREND_PILOT_V1.maintenanceMarginRate);
  const filled = {
    ...plan, stopPrice, riskUnit, stopFraction, wantedNotionalKrw, capReason, liquidationPrice,
  };
  if (quantity === null || quantity <= 0) return { ...filled, blockers: ['QUANTITY_BELOW_STEP'] };
  const notionalUsdt = quantity * input.referencePrice;
  const blockers: string[] = [];
  if (quantity + EPSILON < c.minTradeNum) blockers.push('BELOW_MIN_TRADE_NUM');
  if (notionalUsdt + EPSILON < c.minTradeUsdt) blockers.push('BELOW_MIN_NOTIONAL');
  if (liquidationPrice === null) blockers.push('LIQUIDATION_UNKNOWN');
  else if (Math.abs(input.referencePrice - liquidationPrice) < riskUnit * TREND_PILOT_V1.liquidationSafetyMultiple) blockers.push('STOP_TOO_CLOSE_TO_LIQUIDATION');
  const finalNotionalKrw = notionalUsdt * input.usdKrw;
  return {
    ...filled,
    ok: blockers.length === 0,
    blockers,
    quantity,
    notionalUsdt,
    notionalKrw: finalNotionalKrw,
    marginKrw: finalNotionalKrw / leverage,
    riskKrw: quantity * riskUnit * input.usdKrw,
  };
}

// ---------------------------------------------------------------- management

export interface TrendPilotPositionState {
  side: TrendPilotSide;
  entryPrice: number;
  riskUnit: number;
  entryAtr: number;
  stopPrice: number;
  stopKind: 'initial' | 'breakeven' | 'trailing';
  bestPrice: number;
  maxFavorableR: number;
  entryBarOpenMs: number; // the 4h bar during which the entry filled
  lastProcessedBarOpenMs: number | null;
}

export interface TrendPilotStopUpdate {
  state: TrendPilotPositionState;
  stopChanged: boolean;
  exit: 'TIME_EXIT' | 'STOP_BREACHED_ON_CLOSE' | null;
  barsHeld: number;
}

/**
 * Applies one newly closed bar to an open position. The exchange holds the
 * actual stop order; this only decides the next stop (tighten-only) and the
 * holding-cap exit. Bars already processed or before the entry bar are ignored.
 */
export function advanceTrendPilotStop(state: TrendPilotPositionState, closedBar: TrendPilotCandle, atrNow: number | null, priceStep: number): TrendPilotStopUpdate {
  const direction = state.side === 'long' ? 1 : -1;
  if (!closedBar || !Number.isSafeInteger(closedBar.timestamp)) return { state, stopChanged: false, exit: null, barsHeld: 0 };
  const barsHeld = Math.floor((closedBar.timestamp - state.entryBarOpenMs) / TREND_PILOT_V1.intervalMs) + 1;
  const unchanged: TrendPilotStopUpdate = { state, stopChanged: false, exit: null, barsHeld };
  if (closedBar.timestamp < state.entryBarOpenMs) return unchanged;
  if (state.lastProcessedBarOpenMs !== null && closedBar.timestamp <= state.lastProcessedBarOpenMs) return unchanged;
  if (![closedBar.high, closedBar.low, closedBar.close].every(isPositive)) return unchanged;

  const favourable = state.side === 'long' ? closedBar.high : closedBar.low;
  const bestPrice = state.side === 'long' ? Math.max(state.bestPrice, favourable) : Math.min(state.bestPrice, favourable);
  const bestR = computeRMultiple(state.side, state.entryPrice, bestPrice, state.riskUnit) ?? state.maxFavorableR;
  const maxFavorableR = Math.max(state.maxFavorableR, bestR);
  let stop = state.stopPrice;
  let kind = state.stopKind;
  const tighten = (price: number | null, nextKind: TrendPilotPositionState['stopKind']) => {
    if (price === null || !isPositive(price)) return;
    const better = state.side === 'long' ? price > stop + EPSILON : price < stop - EPSILON;
    if (better) { stop = price; kind = nextKind; }
  };
  if (maxFavorableR >= TREND_PILOT_V1.breakevenAfterR - EPSILON) tighten(roundStopToTick(state.entryPrice, priceStep, state.side), 'breakeven');
  const trailAtr = isPositive(atrNow) ? atrNow : state.entryAtr;
  tighten(roundStopToTick(bestPrice - (direction * TREND_PILOT_V1.trailAtrMultiple * trailAtr), priceStep, state.side), 'trailing');

  const next: TrendPilotPositionState = { ...state, bestPrice, maxFavorableR, stopPrice: stop, stopKind: kind, lastProcessedBarOpenMs: closedBar.timestamp };
  // A stop that already sits beyond the last close cannot be placed as a resting
  // stop on the exchange; close at market instead.
  const breached = state.side === 'long' ? closedBar.close <= stop : closedBar.close >= stop;
  let exit: TrendPilotStopUpdate['exit'] = null;
  if (barsHeld >= TREND_PILOT_V1.maxHoldBars) exit = 'TIME_EXIT';
  else if (breached) exit = 'STOP_BREACHED_ON_CLOSE';
  return { state: next, stopChanged: stop !== state.stopPrice, exit, barsHeld };
}

// ---------------------------------------------------------------- account guards

export interface TrendPilotGuardInput {
  equityKrw: number;
  peakEquityKrw: number;
  dayStartEquityKrw: number;
  dayRealizedPnlKrw: number;
  killed: boolean;
}

export interface TrendPilotGuardResult {
  allowEntry: boolean;
  killNow: boolean;
  drawdownFraction: number | null;
  dayLossFraction: number | null;
  blockers: string[];
}

export function evaluateTrendPilotGuards(input: TrendPilotGuardInput): TrendPilotGuardResult {
  const blockers: string[] = [];
  if (input.killed) blockers.push('KILL_SWITCH_ACTIVE');
  if (!isPositive(input.equityKrw)) blockers.push('NO_EQUITY');
  if (!isPositive(input.peakEquityKrw)) blockers.push('INVALID_PEAK');
  if (!isPositive(input.dayStartEquityKrw)) blockers.push('INVALID_DAY_START');
  if (!isFiniteNumber(input.dayRealizedPnlKrw)) blockers.push('INVALID_DAY_PNL');
  const peak = isPositive(input.peakEquityKrw) ? Math.max(input.peakEquityKrw, isPositive(input.equityKrw) ? input.equityKrw : 0) : null;
  const drawdownFraction = peak !== null && isFiniteNumber(input.equityKrw) ? safeDivide(peak - input.equityKrw, peak) : null;
  const dayLossFraction = isPositive(input.dayStartEquityKrw) && isFiniteNumber(input.dayRealizedPnlKrw)
    ? safeDivide(-Math.min(0, input.dayRealizedPnlKrw), input.dayStartEquityKrw) : null;
  const killNow = !input.killed && drawdownFraction !== null && drawdownFraction >= TREND_PILOT_V1.killDrawdownFraction - EPSILON;
  if (killNow) blockers.push('KILL_DRAWDOWN_REACHED');
  if (dayLossFraction !== null && dayLossFraction >= TREND_PILOT_V1.dailyLossFraction - EPSILON) blockers.push('DAILY_LOSS_LIMIT');
  return { allowEntry: blockers.length === 0, killNow, drawdownFraction, dayLossFraction, blockers };
}

/** KST calendar day key (YYYY-MM-DD) for daily-loss accounting. */
export function kstDayKey(ms: number): string | null {
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + (9 * 60 * 60 * 1000)).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- ledger state

export interface TrendPilotOpenPosition extends TrendPilotPositionState {
  symbol: TrendPilotSymbol;
  quantity: number;
  marginKrw: number;
  signalBarOpenMs: number;
  clientOid: string;
  openedAtMs: number;
}

export interface TrendPilotLedger {
  version: 'trend-pilot-ledger-v1';
  memberId: string;
  peakEquityKrw: number | null;
  dayKey: string | null;
  dayStartEquityKrw: number | null;
  dayRealizedPnlKrw: number;
  killed: boolean;
  killedAtMs: number | null;
  killReason: string | null;
  lastSignalBarOpenMs: Partial<Record<TrendPilotSymbol, number>>;
  open: TrendPilotOpenPosition[];
  closedCount: number;
  realizedPnlKrw: number;
  updatedAtMs: number | null;
}

export function createTrendPilotLedger(memberId: string): TrendPilotLedger {
  return {
    version: 'trend-pilot-ledger-v1', memberId, peakEquityKrw: null, dayKey: null, dayStartEquityKrw: null,
    dayRealizedPnlKrw: 0, killed: false, killedAtMs: null, killReason: null, lastSignalBarOpenMs: {}, open: [],
    closedCount: 0, realizedPnlKrw: 0, updatedAtMs: null,
  };
}

/** Rolls the KST day and the peak with the latest live equity. */
export function observeTrendPilotEquity(ledger: TrendPilotLedger, equityKrw: number, nowMs: number): TrendPilotLedger {
  if (!isPositive(equityKrw)) return ledger;
  const day = kstDayKey(nowMs);
  const sameDay = day !== null && day === ledger.dayKey;
  return {
    ...ledger,
    peakEquityKrw: Math.max(ledger.peakEquityKrw ?? equityKrw, equityKrw),
    dayKey: day,
    dayStartEquityKrw: sameDay && isPositive(ledger.dayStartEquityKrw) ? ledger.dayStartEquityKrw : equityKrw,
    dayRealizedPnlKrw: sameDay ? ledger.dayRealizedPnlKrw : 0,
    updatedAtMs: nowMs,
  };
}

/** Records a closed position (realized P&L in KRW, fees included by the caller). */
export function recordTrendPilotClose(ledger: TrendPilotLedger, symbol: TrendPilotSymbol, realizedPnlKrw: number, nowMs: number): TrendPilotLedger {
  const pnl = isFiniteNumber(realizedPnlKrw) ? realizedPnlKrw : 0;
  const day = kstDayKey(nowMs);
  const sameDay = day !== null && day === ledger.dayKey;
  return {
    ...ledger,
    open: ledger.open.filter((p) => p.symbol !== symbol),
    dayKey: day,
    dayRealizedPnlKrw: (sameDay ? ledger.dayRealizedPnlKrw : 0) + pnl,
    realizedPnlKrw: ledger.realizedPnlKrw + pnl,
    closedCount: ledger.closedCount + 1,
    updatedAtMs: nowMs,
  };
}

export function killTrendPilot(ledger: TrendPilotLedger, reason: string, nowMs: number): TrendPilotLedger {
  if (ledger.killed) return ledger;
  return { ...ledger, killed: true, killedAtMs: nowMs, killReason: reason, updatedAtMs: nowMs };
}

/** Owner-only: re-arm after a kill (new peak = current equity). */
export function rearmTrendPilot(ledger: TrendPilotLedger, equityKrw: number, nowMs: number): TrendPilotLedger {
  if (!isPositive(equityKrw)) return ledger;
  return { ...ledger, killed: false, killedAtMs: null, killReason: null, peakEquityKrw: equityKrw, updatedAtMs: nowMs };
}

/** Deterministic client order id: one entry per member, symbol and signal bar. */
export function trendPilotClientOid(memberId: string, symbol: TrendPilotSymbol, signalBarOpenMs: number): string {
  let hash = 2166136261;
  for (const ch of memberId) { hash ^= ch.charCodeAt(0); hash = Math.imul(hash, 16777619) >>> 0; }
  return `tp1-${symbol.slice(0, 3).toLowerCase()}-${hash.toString(36)}-${Math.floor(signalBarOpenMs / 1000).toString(36)}`;
}

// ---------------------------------------------------------------- Upbit KRW spot (long only)
//
// Owner decision 2026-10-18 (four-market backtest: Upbit 6 coins +157%, recent
// segment +80%): the same breakout on Upbit KRW spot, long only, no leverage.
// Upbit has no resting stop orders, so the stop is watched by the worker and
// closed with a market sell; between checks the loss can exceed the plan.

export const TREND_PILOT_SPOT_V1 = Object.freeze({
  strategyId: 'TREND_PILOT_UPBIT_SPOT_4H_V1',
  strategyVersion: 'trend-pilot-spot-v1.0.0',
  symbols: Object.freeze(['KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-SOL', 'KRW-DOGE', 'KRW-ADA'] as const),
  minOrderKrw: 5_000, // Upbit KRW market minimum
  volumeDecimals: 8,
  feeRate: 0.0005,
});

export type TrendPilotSpotSymbol = (typeof TREND_PILOT_SPOT_V1.symbols)[number];

export interface TrendPilotSpotEntryInput {
  referencePriceKrw: number; // best ask
  atrKrw: number;
  equityKrw: number; // KRW cash + market value of all Upbit holdings
  availableKrw: number; // free KRW cash
  maxOrderKrw: number;
  riskFraction?: number;
}

export interface TrendPilotSpotEntryPlan {
  ok: boolean;
  blockers: string[];
  stopPriceKrw: number | null;
  riskUnitKrw: number | null;
  stopFraction: number | null;
  orderKrw: number | null; // KRW amount for a market buy (fee added on top by Upbit)
  expectedVolume: number | null;
  riskKrw: number | null;
  capReason: 'RISK' | 'MAX_ORDER' | 'CASH' | null;
}

export function computeTrendPilotSpotEntryPlan(input: TrendPilotSpotEntryInput): TrendPilotSpotEntryPlan {
  const riskFraction = input.riskFraction ?? TREND_PILOT_V1.riskFraction;
  const plan: TrendPilotSpotEntryPlan = { ok: false, blockers: [], stopPriceKrw: null, riskUnitKrw: null, stopFraction: null, orderKrw: null, expectedVolume: null, riskKrw: null, capReason: null };
  const fail = (code: string): TrendPilotSpotEntryPlan => ({ ...plan, blockers: [code] });
  if (!isPositive(input.referencePriceKrw)) return fail('INVALID_PRICE');
  if (!isPositive(input.atrKrw)) return fail('INVALID_ATR');
  if (!isPositive(input.equityKrw)) return fail('NO_EQUITY');
  if (!isFiniteNumber(input.availableKrw) || input.availableKrw < 0) return fail('INVALID_CASH');
  if (!isPositive(input.maxOrderKrw)) return fail('INVALID_MAX_ORDER');
  if (!isPositive(riskFraction) || riskFraction > 0.03) return fail('RISK_FRACTION_OUT_OF_RANGE');
  const riskUnitKrw = Math.min(input.atrKrw * TREND_PILOT_V1.stopAtrMultiple, input.referencePriceKrw * TREND_PILOT_V1.maxStopFraction);
  const stopPriceKrw = input.referencePriceKrw - riskUnitKrw;
  const stopFraction = safeDivide(riskUnitKrw, input.referencePriceKrw);
  if (!isPositive(stopPriceKrw) || stopFraction === null || stopFraction <= 0) return fail('INVALID_STOP');
  const wanted = safeDivide(input.equityKrw * riskFraction, stopFraction);
  if (wanted === null) return fail('INVALID_STOP');
  // Keep room for the buy fee so the order never exceeds free cash.
  const cashRoom = Math.max(0, input.availableKrw / (1 + TREND_PILOT_SPOT_V1.feeRate));
  let orderKrw = wanted;
  let capReason: TrendPilotSpotEntryPlan['capReason'] = 'RISK';
  if (input.maxOrderKrw < orderKrw) { orderKrw = input.maxOrderKrw; capReason = 'MAX_ORDER'; }
  if (cashRoom < orderKrw) { orderKrw = cashRoom; capReason = 'CASH'; }
  orderKrw = Math.floor(orderKrw);
  const expectedVolume = floorToStep(orderKrw / input.referencePriceKrw, 10 ** -TREND_PILOT_SPOT_V1.volumeDecimals);
  const filled = { ...plan, stopPriceKrw, riskUnitKrw, stopFraction, orderKrw, expectedVolume, capReason, riskKrw: expectedVolume === null ? null : expectedVolume * riskUnitKrw };
  if (orderKrw < TREND_PILOT_SPOT_V1.minOrderKrw) return { ...filled, blockers: ['BELOW_MIN_ORDER'] };
  if (expectedVolume === null || expectedVolume <= 0) return { ...filled, blockers: ['VOLUME_BELOW_STEP'] };
  return { ...filled, ok: true };
}

/** Spot exit while the bar is still open: market sell once the price touches the stop. */
export function spotStopTouched(stopPriceKrw: number, lastPriceKrw: number): boolean | null {
  if (!isPositive(stopPriceKrw) || !isPositive(lastPriceKrw)) return null;
  return lastPriceKrw <= stopPriceKrw;
}

/** Signal on spot bars: long side only (a short signal is ignored). */
export function evaluateTrendPilotSpotSignal(closedBars: ReadonlyArray<TrendPilotCandle>): TrendPilotSignal {
  const signal = evaluateTrendPilotSignal(closedBars);
  return signal.side === 'short' ? { ...signal, side: null } : signal;
}
