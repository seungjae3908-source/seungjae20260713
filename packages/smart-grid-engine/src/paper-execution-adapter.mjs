// paper-execution-adapter.mjs
// BLOCK 19 Step 4 — Paper 실행 어댑터 (가상 체결 전용)
//
// 원칙:
//   - 실제 Bitget 주문 API를 절대 호출하지 않는다. (import 조차 없음)
//   - 이 모듈은 순수 in-memory 상태만 다룬다.
//   - 체결 불가능한 데이터(가격<=0, 수량<MIN, 레버리지 범위 밖 등)는
//     임의로 체결시키지 않고 거부한다.
//   - 상태 저장/복원은 Step 3과 동일한 방식 (JSON 파일).

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DIRECTION, STRATEGY } from './ai-strategy-selector.mjs';

export const PAPER_DEFAULTS = Object.freeze({
  INITIAL_USDT: 1000,
  DEFAULT_FEE_RATE: 0.0006,
  DEFAULT_SLIPPAGE_BPS: 5,
  MIN_QUANTITY: 0.0001,
  MAX_LEVERAGE: 10,
});

function quarantineCorruptFile(statePath) {
  try {
    const ts = Date.now();
    // UUID suffix 로 ms 이내 충돌 방지 — 격리본 유실 금지
    const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
    const qPath = `${statePath}.corrupt.${ts}.${suffix}`;
    fs.renameSync(statePath, qPath);
    return { quarantined: true, path: qPath };
  } catch (err) {
    return { quarantined: false, error: err.message };
  }
}

export function createPaperState(args = {}) {
  const { initialUsdt = PAPER_DEFAULTS.INITIAL_USDT, nowMs = Date.now() } = args;
  return {
    version: 1,
    initialUsdt,
    usdtBalance: initialUsdt,
    positions: {},
    orders: {},
    fills: [],
    feesPaid: 0,
    fundingPaid: 0,
    realizedPnl: 0,
    lastUpdatedMs: nowMs,
  };
}

export function paperSaveState({ statePath, state } = {}) {
  if (!statePath || !state) return { saved: false };
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
    return { saved: true };
  } catch (err) {
    return { saved: false, error: err.message };
  }
}

export function paperLoadState({ statePath, initialUsdt, nowMs = Date.now() } = {}) {
  if (!statePath) return createPaperState({ initialUsdt, nowMs });
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1) {
      quarantineCorruptFile(statePath);
      return createPaperState({ initialUsdt, nowMs });
    }
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') return createPaperState({ initialUsdt, nowMs });
    quarantineCorruptFile(statePath);
    return createPaperState({ initialUsdt, nowMs });
  }
}

export function paperLoadStateSafe({ statePath, initialUsdt, nowMs = Date.now() } = {}) {
  if (!statePath) {
    return { ok: true, state: createPaperState({ initialUsdt, nowMs }), initialized: true };
  }
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1) {
      const q = quarantineCorruptFile(statePath);
      return { ok: false, failClosed: true, corrupt: true,
               quarantinePath: q.path || null, quarantineError: q.error || null,
               state: null, reason: 'STATE_VERSION_INVALID' };
    }
    return { ok: true, state: parsed };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { ok: true, state: createPaperState({ initialUsdt, nowMs }), initialized: true };
    }
    const q = quarantineCorruptFile(statePath);
    return { ok: false, failClosed: true, corrupt: true,
             quarantinePath: q.path || null, quarantineError: q.error || null,
             state: null, reason: 'STATE_PARSE_ERROR', error: err.message };
  }
}

function applySlippage({ side, price, slippageBps }) {
  const bps = Number.isFinite(slippageBps) ? slippageBps : PAPER_DEFAULTS.DEFAULT_SLIPPAGE_BPS;
  const factor = 1 + bps / 10000;
  if (side === DIRECTION.LONG) return price * factor;
  if (side === DIRECTION.SHORT) return price / factor;
  return price;
}

export function paperOrderKey({ symbol, direction, strategy, grid } = {}) {
  const gridId = grid ? `${grid.lowerPrice}-${grid.upperPrice}-${grid.gridCount}` : 'nogrid';
  const raw = `paper|${symbol || 'SYM'}|${direction || 'DIR'}|${strategy || 'STRAT'}|${gridId}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function reject(reason, extra = {}) {
  return {
    ok: false,
    reason,
    realApiCalled: false,
    ...extra,
  };
}

export function submitPaperOrder(args = {}) {
  const {
    state,
    symbol,
    direction,
    strategy = STRATEGY.NEUTRAL_GRID,
    grid = null,
    quantity,
    price,
    leverage = 1,
    feeRate = PAPER_DEFAULTS.DEFAULT_FEE_RATE,
    slippageBps = PAPER_DEFAULTS.DEFAULT_SLIPPAGE_BPS,
    nowMs = Date.now(),
    statePath = null,
  } = args;

  if (!state || typeof state !== 'object') return reject('STATE_MISSING');
  if (typeof symbol !== 'string' || !symbol) return reject('SYMBOL_INVALID');
  if (direction !== DIRECTION.LONG && direction !== DIRECTION.SHORT) {
    return reject('DIRECTION_INVALID');
  }
  if (!Number.isFinite(price) || price <= 0) return reject('PRICE_INVALID');
  if (!Number.isFinite(quantity) || quantity < PAPER_DEFAULTS.MIN_QUANTITY) {
    return reject('QUANTITY_INVALID');
  }
  if (!Number.isFinite(leverage) || leverage < 1 || leverage > PAPER_DEFAULTS.MAX_LEVERAGE) {
    return reject('LEVERAGE_INVALID');
  }
  if (!Number.isFinite(feeRate) || feeRate < 0) return reject('FEE_INVALID');

  const key = paperOrderKey({ symbol, direction, strategy, grid });
  if (state.positions && state.positions[symbol] && state.positions[symbol].status === 'OPEN') {
    return reject('POSITION_EXISTS', { orderKey: key });
  }

  const fillPrice = applySlippage({ side: direction, price, slippageBps });
  const notional = fillPrice * quantity;
  const requiredMargin = notional / leverage;
  const entryFee = notional * feeRate;
  const neededUsdt = requiredMargin + entryFee;

  if (state.usdtBalance < neededUsdt) {
    return reject('INSUFFICIENT_PAPER_BALANCE', { neededUsdt, availableUsdt: state.usdtBalance });
  }

  const orderId = randomUUID();
  const position = {
    symbol,
    side: direction,
    entryPrice: fillPrice,
    quantity,
    leverage,
    notional,
    margin: requiredMargin,
    openedAtMs: nowMs,
    fundingPaid: 0,
    realizedPnl: 0,
    status: 'OPEN',
    strategy,
    orderKey: key,
  };

  const nextState = {
    ...state,
    usdtBalance: state.usdtBalance - neededUsdt,
    positions: { ...(state.positions || {}), [symbol]: position },
    orders: {
      ...(state.orders || {}),
      [orderId]: { status: 'FILLED', price: fillPrice, quantity, fee: entryFee, side: direction, createdAtMs: nowMs },
    },
    fills: [...(state.fills || []), { orderId, symbol, side: direction, price: fillPrice, quantity, fee: entryFee, filledAtMs: nowMs }],
    feesPaid: (state.feesPaid || 0) + entryFee,
    lastUpdatedMs: nowMs,
  };

  if (statePath) {
    const saved = paperSaveState({ statePath, state: nextState });
    if (!saved.saved) {
      return reject('SAVE_FAILED', { saveError: saved.error, orderKey: key });
    }
  }

  return {
    ok: true,
    realApiCalled: false,
    orderId,
    orderKey: key,
    fill: { symbol, side: direction, price: fillPrice, quantity, fee: entryFee, notional },
    state: nextState,
  };
}

export function applyFundingToOpenPositions(args = {}) {
  const { state, fundingRates = {}, nowMs = Date.now() } = args;
  if (!state || typeof state !== 'object') return reject('STATE_MISSING');

  const positions = { ...(state.positions || {}) };
  let fundingTotal = 0;
  for (const sym of Object.keys(positions)) {
    const rate = fundingRates[sym];
    if (!Number.isFinite(rate) || rate === 0) continue;
    const p = positions[sym];
    if (!p || p.status !== 'OPEN') continue;
    const cost = Math.abs(p.notional * rate);
    positions[sym] = { ...p, fundingPaid: (p.fundingPaid || 0) + cost };
    fundingTotal += cost;
  }

  const nextState = {
    ...state,
    positions,
    fundingPaid: (state.fundingPaid || 0) + fundingTotal,
    usdtBalance: state.usdtBalance - fundingTotal,
    lastUpdatedMs: nowMs,
  };

  return { ok: true, realApiCalled: false, fundingTotal, state: nextState };
}

export function closePaperPosition(args = {}) {
  const {
    state, symbol, price,
    feeRate = PAPER_DEFAULTS.DEFAULT_FEE_RATE,
    nowMs = Date.now(),
  } = args;

  if (!state || typeof state !== 'object') return reject('STATE_MISSING');
  const p = state.positions?.[symbol];
  if (!p || p.status !== 'OPEN') return reject('POSITION_NOT_OPEN');
  if (!Number.isFinite(price) || price <= 0) return reject('PRICE_INVALID');

  const pnl = p.side === DIRECTION.LONG
    ? (price - p.entryPrice) * p.quantity
    : (p.entryPrice - price) * p.quantity;
  const exitFee = price * p.quantity * feeRate;
  const returnedMargin = p.margin + pnl - exitFee;
  const netPnl = pnl - exitFee;

  const nextState = {
    ...state,
    usdtBalance: state.usdtBalance + returnedMargin,
    positions: {
      ...state.positions,
      [symbol]: { ...p, status: 'CLOSED', exitPrice: price, realizedPnl: netPnl, closedAtMs: nowMs },
    },
    fills: [
      ...(state.fills || []),
      { symbol, side: p.side === DIRECTION.LONG ? 'SELL' : 'BUY', price, quantity: p.quantity, fee: exitFee, filledAtMs: nowMs },
    ],
    feesPaid: (state.feesPaid || 0) + exitFee,
    realizedPnl: (state.realizedPnl || 0) + netPnl,
    lastUpdatedMs: nowMs,
  };

  return {
    ok: true,
    realApiCalled: false,
    pnl,
    exitFee,
    returnedMargin,
    state: nextState,
  };
}

export function markPaperToMarket({ state, prices = {} } = {}) {
  if (!state || typeof state !== 'object') return reject('STATE_MISSING');
  let unrealized = 0;
  for (const [sym, p] of Object.entries(state.positions || {})) {
    if (!p || p.status !== 'OPEN') continue;
    const px = prices[sym];
    if (!Number.isFinite(px) || px <= 0) continue;
    const delta = p.side === DIRECTION.LONG
      ? (px - p.entryPrice) * p.quantity
      : (p.entryPrice - px) * p.quantity;
    unrealized += delta;
  }
  return { ok: true, realApiCalled: false, unrealizedPnl: unrealized };
}
