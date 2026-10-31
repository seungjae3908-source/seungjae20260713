// neutral-grid-paper.mjs
// BLOCK 19 Step 6-C — NEUTRAL_GRID 전용 Paper 실행 엔진
//
// 안전 원칙:
//   - 네트워크/API 호출 0건 (fs/경로만 사용)
//   - 실주문 함수 0건
//   - LIVE 게이트 우회 없음 (호출자가 게이트 통과 확인)
//   - LONG/SHORT 경로와 완전 독립 (별도 state 파일, 별도 로직)
//   - 잘못된 입력/NaN/Infinity → fail-closed (상태 미변경)

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { calculateGridLevels } from './grid-math.mjs';
import { DIRECTION } from './ai-strategy-selector.mjs';

export const NEUTRAL_DEFAULTS = Object.freeze({
  DEFAULT_FEE_RATE: 0.0006,
  MIN_GRID_COUNT: 3,
});

function isPositive(x) { return typeof x === 'number' && Number.isFinite(x) && x > 0; }
function isFiniteNum(x) { return typeof x === 'number' && Number.isFinite(x); }

function reject(reason, extra = {}) {
  return { ok: false, reason, realApiCalled: false, ...extra };
}

export function createNeutralGridState({
  symbol, lowerPrice, upperPrice, gridCount, quantityPerGrid,
  initialUsdt, feeRate = NEUTRAL_DEFAULTS.DEFAULT_FEE_RATE, nowMs = Date.now(),
} = {}) {
  if (typeof symbol !== 'string' || !symbol) return reject('SYMBOL_INVALID');
  if (!isPositive(lowerPrice)) return reject('LOWER_INVALID');
  if (!isPositive(upperPrice)) return reject('UPPER_INVALID');
  if (!(upperPrice > lowerPrice)) return reject('RANGE_INVALID');
  if (!Number.isInteger(gridCount) || gridCount < NEUTRAL_DEFAULTS.MIN_GRID_COUNT) {
    return reject('GRID_COUNT_INVALID');
  }
  if (!isPositive(quantityPerGrid)) return reject('QTY_INVALID');
  if (!isPositive(initialUsdt)) return reject('INITIAL_USDT_INVALID');
  if (!isFiniteNum(feeRate) || feeRate < 0) return reject('FEE_RATE_INVALID');

  let rawLevels;
  try {
    // grid-math::calculateGridLevels 는 gridCount+1 개를 반환 (lower..upper 간격 분할).
    // NEUTRAL 은 자본을 gridCount 개 레벨에 균등 분할하므로 앞에서 gridCount 개만 사용.
    rawLevels = calculateGridLevels({ lowerPrice, upperPrice, gridCount, mode: 'arithmetic', pricePlace: 2 });
  } catch (e) { return reject('LEVELS_THROW', { error: e.message }); }
  if (!Array.isArray(rawLevels) || rawLevels.length < gridCount) return reject('LEVELS_INVALID');
  rawLevels = rawLevels.slice(0, gridCount);

  const levels = rawLevels.map((price, idx) => ({
    idx, price, state: 'EMPTY', qty: 0, entryPrice: 0, entryTs: null, entryFee: 0,
  }));
  const spacing = (upperPrice - lowerPrice) / (gridCount - 1);
  if (!isPositive(spacing)) return reject('SPACING_INVALID');

  return {
    ok: true, realApiCalled: false,
    state: {
      version: 1, symbol, lowerPrice, upperPrice, gridCount, spacing, quantityPerGrid,
      initialUsdt, usdtBalance: initialUsdt, baseHolding: 0, feeRate, levels,
      realizedPnl: 0, feesPaid: 0, roundTrips: 0, fills: [],
      boundaryState: 'IN_RANGE', lastCandleTs: null, lastUpdatedMs: nowMs,
    },
  };
}

export function saveNeutralState({ statePath, state } = {}) {
  if (!statePath || !state) return { saved: false, error: 'ARG_MISSING' };
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
    return { saved: true };
  } catch (err) { return { saved: false, error: err.message }; }
}

export function loadNeutralStateSafe({ statePath } = {}) {
  if (!statePath) return { ok: true, state: null, initialized: false };
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1) {
      const ts = Date.now();
      const q = `${statePath}.corrupt.${ts}.${randomUUID().slice(0, 8)}`;
      try { fs.renameSync(statePath, q); } catch {}
      return { ok: false, failClosed: true, corrupt: true, quarantinePath: q, state: null, reason: 'VERSION_INVALID' };
    }
    return { ok: true, state: parsed };
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true, state: null, initialized: false };
    const ts = Date.now();
    const q = `${statePath}.corrupt.${ts}.${randomUUID().slice(0, 8)}`;
    try { fs.renameSync(statePath, q); } catch {}
    return { ok: false, failClosed: true, corrupt: true, quarantinePath: q, state: null, reason: 'PARSE_ERROR' };
  }
}

export function validateCandle(candle) {
  if (!candle || typeof candle !== 'object') return { ok: false, reason: 'CANDLE_MISSING' };
  for (const k of ['open', 'high', 'low', 'close']) {
    if (!isFiniteNum(candle[k])) return { ok: false, reason: `CANDLE_${k.toUpperCase()}_NAN_OR_INF` };
    if (candle[k] <= 0) return { ok: false, reason: `CANDLE_${k.toUpperCase()}_NON_POSITIVE` };
  }
  if (candle.high < candle.low) return { ok: false, reason: 'CANDLE_HIGH_LT_LOW' };
  if (candle.close > candle.high || candle.close < candle.low) return { ok: false, reason: 'CANDLE_CLOSE_OUTSIDE' };
  if (!isFiniteNum(candle.ts)) return { ok: false, reason: 'CANDLE_TS_INVALID' };
  return { ok: true };
}

export function processNeutralGridCandle(state, candle, opts = {}) {
  if (!state || state.version !== 1) return reject('STATE_INVALID');
  const v = validateCandle(candle);
  if (!v.ok) return reject(v.reason);

  if (state.lastCandleTs != null && candle.ts <= state.lastCandleTs) {
    return { ok: true, realApiCalled: false, skipped: 'DUPLICATE_TS', state, fills: [], boundaryState: state.boundaryState };
  }

  const next = JSON.parse(JSON.stringify(state));
  const fills = [];
  const feeRate = opts.feeRate ?? next.feeRate;

  // 경계 판정
  if (candle.close > next.upperPrice) next.boundaryState = 'BREACH_HIGH';
  else if (candle.close < next.lowerPrice) next.boundaryState = 'BREACH_LOW';
  else next.boundaryState = 'IN_RANGE';
  const allowNewEntry = next.boundaryState === 'IN_RANGE';

  // (1) HOLDING exit (다음 레벨 매도)
  for (const level of next.levels) {
    if (level.state !== 'HOLDING') continue;
    const nextIdx = level.idx + 1;
    if (nextIdx >= next.levels.length) continue;
    const sellPrice = next.levels[nextIdx].price;
    if (candle.high >= sellPrice) {
      const qty = level.qty;
      const exitFee = qty * sellPrice * feeRate;
      const grossProceeds = qty * sellPrice;
      const netProceeds = grossProceeds - exitFee;
      const cost = qty * level.entryPrice + level.entryFee;
      const pnl = netProceeds - cost;
      next.usdtBalance += netProceeds;
      next.baseHolding = Math.max(0, next.baseHolding - qty);
      next.feesPaid += exitFee;
      next.realizedPnl += pnl;
      next.roundTrips += 1;
      fills.push({ id: randomUUID(), type: 'SELL', levelIdx: level.idx, price: sellPrice, qty, fee: exitFee, pnl, ts: candle.ts });
      level.state = 'EMPTY'; level.qty = 0; level.entryPrice = 0; level.entryTs = null; level.entryFee = 0;
    }
  }

  // (2) BUY_PENDING fill
  for (const level of next.levels) {
    if (level.state !== 'BUY_PENDING') continue;
    if (candle.low > level.price) continue;
    const qty = next.quantityPerGrid;
    const entryFee = qty * level.price * feeRate;
    const cost = qty * level.price + entryFee;
    if (next.usdtBalance < cost) continue; // 잔고 부족 → 이번 fill 스킵 (fail-safe)
    next.usdtBalance -= cost;
    next.baseHolding += qty;
    next.feesPaid += entryFee;
    fills.push({ id: randomUUID(), type: 'BUY', levelIdx: level.idx, price: level.price, qty, fee: entryFee, ts: candle.ts });
    level.state = 'HOLDING';
    level.qty = qty; level.entryPrice = level.price; level.entryTs = candle.ts; level.entryFee = entryFee;
  }

  // (3) 재장전 (경계 내부에서만 신규 진입 허용)
  if (allowNewEntry) {
    for (const level of next.levels) {
      if (level.state === 'EMPTY' && level.price < candle.close && level.price >= next.lowerPrice) {
        level.state = 'BUY_PENDING';
      }
    }
  }

  next.lastCandleTs = candle.ts;
  next.lastUpdatedMs = opts.nowMs ?? Date.now();

  return { ok: true, realApiCalled: false, state: next, fills, boundaryState: next.boundaryState, allowNewEntry };
}

export function executeNeutralGridStep({
  state, statePath, symbol, candle, gridPlan, feeRate, nowMs = Date.now(),
} = {}) {
  if (!gridPlan || !gridPlan.grid) return reject('GRID_PLAN_MISSING');
  if (gridPlan.direction !== DIRECTION.NEUTRAL) return reject('NOT_NEUTRAL');
  if (!gridPlan.ok || gridPlan.failClosed) return reject('PLAN_INVALID');

  const { lowerPrice, upperPrice, gridCount } = gridPlan.grid;
  const initialUsdt = gridPlan.capital?.deployUsdt ?? 0;
  if (!isPositive(initialUsdt)) return reject('CAPITAL_INVALID');
  const quantityPerGrid = initialUsdt / gridCount;
  if (!isPositive(quantityPerGrid)) return reject('QTY_PER_GRID_INVALID');

  let current = state;
  if (!current) {
    const loaded = loadNeutralStateSafe({ statePath });
    if (loaded.corrupt) return reject('STATE_CORRUPT', { quarantinePath: loaded.quarantinePath });
    current = loaded.state;
  }

  if (!current) {
    const init = createNeutralGridState({ symbol, lowerPrice, upperPrice, gridCount, quantityPerGrid, initialUsdt, feeRate, nowMs });
    if (!init.ok) return init;
    for (const level of init.state.levels) {
      if (level.price < candle.close) level.state = 'BUY_PENDING';
    }
    current = init.state;
  }

  const step = processNeutralGridCandle(current, candle, { feeRate, nowMs });
  if (!step.ok) return step;

  if (statePath) {
    const saved = saveNeutralState({ statePath, state: step.state });
    if (!saved.saved) return reject('SAVE_FAILED', { error: saved.error });
  }

  return { ok: true, realApiCalled: false, state: step.state, fills: step.fills, boundaryState: step.boundaryState, allowNewEntry: step.allowNewEntry };
}
