// Paper Forward Trailing Engine - stateful incremental, no I/O
import { calculateGridLevels, calculateGridQuantity } from './grid-math.mjs';
import { roundPrice, applySlippage } from './grid-utils.mjs';

const FEE_RATE = 0.0006, SLIPPAGE = 0.0002, MAINT_MARGIN = 0.005;
const FUNDING_MS = 8 * 3600 * 1000;
const TRAIL_STEP = 0.05, MAX_TOTAL_SHIFT = 0.20, MIN_CANDLES_BETWEEN = 5, CHASE_STOP = 0.05;

export function initStateB({ symbol, startPrice, gridCount, investmentUsdt, leverage, rangePct, pricePlace, volumePlace, minTradeNum }) {
  const lowerPrice = startPrice * (1 - rangePct), upperPrice = startPrice * (1 + rangePct);
  const levels = calculateGridLevels({ lowerPrice, upperPrice, gridCount, mode: 'arithmetic', pricePlace, priceEndStep: 0 });
  const quantity = calculateGridQuantity({ totalInvestmentUsdt: investmentUsdt, gridCount, currentPrice: startPrice, leverage, volumePlace, minTradeNum });
  const pendingOrders = [];
  for (const lvl of levels) {
    if (lvl < startPrice) pendingOrders.push({ id: pendingOrders.length + 1, type: 'BUY', price: lvl, status: 'PENDING' });
    else if (lvl > startPrice) pendingOrders.push({ id: pendingOrders.length + 1, type: 'SELL', price: lvl, status: 'PENDING' });
  }
  return {
    meta: { symbol, gridCount, investmentUsdt, leverage, rangePct, pricePlace, volumePlace, minTradeNum, feeRate: FEE_RATE, slippage: SLIPPAGE, maintMargin: MAINT_MARGIN },
    levels, quantity, startPrice, currentLower: lowerPrice, currentUpper: upperPrice,
    cumulativeShift: 0, lastShiftIdx: -999, trailStopped: false,
    pendingOrders, positions: [], closedPositions: [],
    realizedPnl: 0, totalFees: 0, totalFunding: 0, liquidations: 0,
    fillUncertaintyCount: 0, trailShifts: 0, rangeBreaches: 0,
    equityCurve: [investmentUsdt], peak: investmentUsdt, maxDD: 0,
    lastCandleTs: 0, lastFundingTs: 0, processedCandles: 0, duplicateCandles: 0, processedCandleIdx: 0,
    lastEquity: investmentUsdt, lastClose: startPrice, startedAt: Date.now(),
    fundingHistory: [], processedFundings: [], lastProcessedFundingAt: 0, accountId: 'B',
  };
}

function resetPending(state, newLower, newUpper, lastClose) {
  const newLevels = calculateGridLevels({ lowerPrice: newLower, upperPrice: newUpper, gridCount: state.meta.gridCount, mode: 'arithmetic', pricePlace: state.meta.pricePlace, priceEndStep: 0 });
  state.pendingOrders = state.pendingOrders.filter(o => o.status === 'FILLED');
  for (const lvl of newLevels) {
    if (state.positions.some(p => p.status === 'OPEN' && Math.abs(p.price - lvl) < 1e-6)) continue;
    if (lvl < lastClose) state.pendingOrders.push({ id: state.pendingOrders.length + 1, type: 'BUY', price: lvl, status: 'PENDING' });
    else if (lvl > lastClose) state.pendingOrders.push({ id: state.pendingOrders.length + 1, type: 'SELL', price: lvl, status: 'PENDING' });
  }
  state.levels = newLevels; state.currentLower = newLower; state.currentUpper = newUpper;
}

export function processCandleB(state, candle) {
  if (candle.ts <= state.lastCandleTs) { state.duplicateCandles++; return { skipped: true, fills: 0, events: [] }; }
  const c = candle, events = [];
  const idx = state.processedCandleIdx;

  if (!state.trailStopped && idx - state.lastShiftIdx >= MIN_CANDLES_BETWEEN) {
    const rangeSize = state.currentUpper - state.currentLower;
    const shiftUp = c.high >= state.currentUpper - rangeSize * 0.1 && state.cumulativeShift + TRAIL_STEP <= MAX_TOTAL_SHIFT;
    const shiftDown = c.low <= state.currentLower + rangeSize * 0.1 && state.cumulativeShift + TRAIL_STEP <= MAX_TOTAL_SHIFT;
    const chaseUp = c.high > state.currentUpper * (1 + CHASE_STOP);
    const chaseDown = c.low < state.currentLower * (1 - CHASE_STOP);
    if (chaseUp || chaseDown) state.trailStopped = true;
    if (!state.trailStopped && shiftUp) {
      const delta = rangeSize * TRAIL_STEP / state.meta.rangePct;
      resetPending(state, state.currentLower + delta, state.currentUpper + delta, c.close);
      state.cumulativeShift += TRAIL_STEP; state.lastShiftIdx = idx; state.trailShifts++;
    } else if (!state.trailStopped && shiftDown) {
      const delta = rangeSize * TRAIL_STEP / state.meta.rangePct;
      resetPending(state, state.currentLower - delta, state.currentUpper - delta, c.close);
      state.cumulativeShift += TRAIL_STEP; state.lastShiftIdx = idx; state.trailShifts++;
    }
  }

  if (c.low < state.currentLower || c.high > state.currentUpper) state.rangeBreaches++;

  const candidates = state.pendingOrders.filter(o => o.status === 'PENDING' && (
    (o.type === 'BUY' && c.low <= o.price) || (o.type === 'SELL' && c.high >= o.price)));
  if (candidates.length > 0) {
    const hasBuy = candidates.some(o => o.type === 'BUY'), hasSell = candidates.some(o => o.type === 'SELL');
    if (hasBuy && hasSell) state.fillUncertaintyCount++;
    const isGreen = c.close >= c.open;
    const sorted = [...candidates].sort((a, b) => {
      if (a.type === b.type) return a.type === 'BUY' ? b.price - a.price : a.price - b.price;
      if (isGreen) return a.type === 'BUY' ? -1 : 1;
      return a.type === 'SELL' ? -1 : 1;
    });
    for (const order of sorted) {
      if (order.status !== 'PENDING') continue;
      let fillPrice = roundPrice(applySlippage(order.price, order.type, state.meta.slippage), state.meta.pricePlace);
      const fee = fillPrice * state.quantity * state.meta.feeRate;
      state.totalFees += fee; order.status = 'FILLED';
      const matchIdx = state.positions.findIndex(p => p.status === 'OPEN' && p.type !== order.type);
      if (matchIdx >= 0) {
        const m = state.positions[matchIdx];
        m.status = 'CLOSED'; m.closedAt = c.ts; m.exitPrice = fillPrice; m.exitFee = fee;
        const gross = m.type === 'BUY' ? (fillPrice - m.price) * state.quantity : (m.price - fillPrice) * state.quantity;
        m.pnl = gross - m.entryFee - fee; state.realizedPnl += m.pnl; state.closedPositions.push(m);
        events.push({ ts: c.ts, type: 'CLOSE', id: m.id, exitPrice: fillPrice, pnl: +m.pnl.toFixed(4) });
      } else {
        state.positions.push({ id: state.positions.length + 1, type: order.type, price: fillPrice, qty: state.quantity, status: 'OPEN', openedAt: c.ts, entryFee: fee });
        events.push({ ts: c.ts, type: 'OPEN', id: state.positions.length, price: fillPrice });
      }
      const lIdx = state.levels.findIndex(l => Math.abs(l - order.price) < 1e-6);
      if (order.type === 'BUY' && lIdx + 1 < state.levels.length) state.pendingOrders.push({ id: state.pendingOrders.length + 1, type: 'SELL', price: state.levels[lIdx + 1], status: 'PENDING' });
      else if (order.type === 'SELL' && lIdx - 1 >= 0) state.pendingOrders.push({ id: state.pendingOrders.length + 1, type: 'BUY', price: state.levels[lIdx - 1], status: 'PENDING' });
    }
  }

  for (const p of state.positions.filter(p => p.status === 'OPEN')) {
    const liq = p.type === 'BUY' ? p.price * (1 - 1/state.meta.leverage + MAINT_MARGIN) : p.price * (1 + 1/state.meta.leverage - MAINT_MARGIN);
    if ((p.type === 'BUY' && c.low <= liq) || (p.type === 'SELL' && c.high >= liq)) {
      p.status = 'LIQUIDATED'; p.closedAt = c.ts; p.exitPrice = liq;
      const loss = p.type === 'BUY' ? (liq - p.price) * state.quantity : (p.price - liq) * state.quantity;
      state.realizedPnl += loss; state.liquidations++;
      events.push({ ts: c.ts, type: 'LIQUIDATION', id: p.id, exitPrice: liq, loss: +loss.toFixed(4) });
    }
  }

  const openPos = state.positions.filter(p => p.status === 'OPEN');
  const unrealized = openPos.reduce((a, p) => a + ((p.type === 'BUY' ? c.close - p.price : p.price - c.close) * state.quantity - p.entryFee), 0);
  const eq = state.meta.investmentUsdt + state.realizedPnl - state.totalFees + unrealized;
  state.equityCurve.push(eq);
  if (eq > state.peak) state.peak = eq;
  const dd = (state.peak - eq) / state.peak * 100; if (dd > state.maxDD) state.maxDD = dd;
  state.lastCandleTs = c.ts; state.processedCandles++; state.processedCandleIdx++;
  state.lastEquity = eq; state.lastClose = c.close;
  return { events, fills: events.filter(e => e.type !== 'LIQUIDATION').length };
}

export function applyFundingB(state, fundingTime, rate) {
  if (!Array.isArray(state.processedFundings)) state.processedFundings = [];
  if (state.processedFundings.includes(fundingTime)) return 0;
  if (fundingTime <= state.lastFundingTs) return 0;
  state.lastFundingTs = fundingTime; state.lastProcessedFundingAt = Date.now();
  state.processedFundings.push(fundingTime);
  if (state.processedFundings.length > 500) state.processedFundings = state.processedFundings.slice(-500);
  let cost = 0;
  for (const p of state.positions.filter(p => p.status === 'OPEN')) cost += p.price * p.qty * Math.abs(rate);
  state.totalFunding += cost; state.realizedPnl -= cost;
  return cost;
}

export function computeMetricsB(state) {
  const closed = state.closedPositions;
  const wins = closed.filter(p => p.pnl > 0).length;
  const grossP = closed.filter(p => p.pnl > 0).reduce((s, p) => s + p.pnl, 0);
  const grossL = Math.abs(closed.filter(p => p.pnl < 0).reduce((s, p) => s + p.pnl, 0));
  const pf = grossL > 0 ? grossP / grossL : (grossP > 0 ? Infinity : 0);
  let maxConsec = 0, curr = 0;
  for (const t of closed) { if (t.pnl < 0) { curr++; if (curr > maxConsec) maxConsec = curr; } else curr = 0; }
  const openPos = state.positions.filter(p => p.status === 'OPEN');
  const lastPrice = state.lastClose || state.startPrice;
  const unrealized = openPos.reduce((a, p) => a + ((p.type === 'BUY' ? lastPrice - p.price : p.price - lastPrice) * state.quantity - p.entryFee), 0);
  const netPnl = state.realizedPnl - state.totalFees;
  const finalEquity = state.meta.investmentUsdt + netPnl + unrealized;
  const marginUsed = openPos.reduce((s, p) => s + (p.price * p.qty) / state.meta.leverage, 0);
  return {
    trades: closed.length, wins, losses: closed.length - wins,
    winRate: closed.length > 0 ? +((wins / closed.length) * 100).toFixed(2) : 0,
    realizedPnl: +state.realizedPnl.toFixed(4), totalFees: +state.totalFees.toFixed(4), totalFunding: +state.totalFunding.toFixed(4),
    netPnl: +netPnl.toFixed(4), unrealizedPnl: +unrealized.toFixed(4), finalEquity: +finalEquity.toFixed(4),
    returnPct: +((finalEquity - state.meta.investmentUsdt) / state.meta.investmentUsdt * 100).toFixed(2),
    profitFactor: +pf.toFixed(2), maxDD: +state.maxDD.toFixed(2), liquidations: state.liquidations,
    openPositions: openPos.length, maxConsecLosses: maxConsec, fillUncertaintyCount: state.fillUncertaintyCount,
    trailShifts: state.trailShifts, trailStopped: state.trailStopped, rangeBreaches: state.rangeBreaches,
    processedCandles: state.processedCandles, duplicateCandles: state.duplicateCandles,
    marginUsedUsdt: +marginUsed.toFixed(2), marginUsagePct: +((marginUsed / state.meta.investmentUsdt) * 100).toFixed(2),
  };
}
