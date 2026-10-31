// adaptive-grid-planner.mjs
// BLOCK 19 Step 2 — ATR 기반 적응형 그리드 플래너
//
// 안전 원칙:
//   - 500,000 KRW 하드 캡
//   - 전액 투입 절대 금지 (MAX_DEPLOY_FRACTION 0.65, 예비금 >= 30%)
//   - 레버리지 1~10 강제, 자동 결정은 HEURISTIC_MAX_LEVERAGE(=5) 이하
//   - grid-math.mjs::calculateDynamicBounds 재사용 (수정 없음)
//   - FAIL_CLOSED 시 신규 그리드 계획을 반환하지 않음 (grid=null)

import { calculateDynamicBounds } from './grid-math.mjs';
import { selectAIPlan, STRATEGY, DIRECTION } from './ai-strategy-selector.mjs';
import { REGIME } from './market-regime-classifier.mjs';

export const GRID_PLAN_DEFAULTS = Object.freeze({
  HARD_CAP_KRW: 500_000,
  DEFAULT_EXCHANGE_RATE_KRW: 1350,

  MIN_LEVERAGE: 1,
  MAX_LEVERAGE: 10,
  HEURISTIC_MAX_LEVERAGE: 5,
  DEFAULT_LEVERAGE: 2,

  MIN_GRID_COUNT: 5,
  MAX_GRID_COUNT: 50,
  DEFAULT_GRID_COUNT: 20,

  MAX_DEPLOY_FRACTION: 0.65,
  MIN_RESERVE_FRACTION: 0.30,

  DEPLOY_FRACTION_BY_STRATEGY: Object.freeze({
    [STRATEGY.LONG_TRAILING_GRID]: 0.55,
    [STRATEGY.SHORT_TRAILING_GRID]: 0.55,
    [STRATEGY.NEUTRAL_GRID]: 0.45,
    [STRATEGY.NO_NEW_ENTRY]: 0,
    [STRATEGY.SAFE_WAIT]: 0,
  }),

  ATR_MULTIPLIER_LOW_VOL: 2.5,
  ATR_MULTIPLIER_MID_VOL: 3.0,
  ATR_MULTIPLIER_HIGH_VOL: 4.0,

  MIN_REBALANCE_PRICE_DRIFT_PCT: 0.02,
  MIN_REBALANCE_INTERVAL_MS: 5 * 60_000,
  MIN_REBALANCE_GRID_COUNT_DELTA: 2,

  PRICE_PLACE: 2,
});

function isFinitePositive(x) {
  return typeof x === 'number' && Number.isFinite(x) && x > 0;
}
function isFiniteNonNegative(x) {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0;
}
function clampInt(x, min, max) {
  const v = Math.round(Number(x));
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}

function normalizeBounds(bounds) {
  if (!bounds) return { lowerPrice: null, upperPrice: null };
  const lowerPrice = bounds.lowerPrice ?? bounds.lower ?? null;
  const upperPrice = bounds.upperPrice ?? bounds.upper ?? null;
  return { lowerPrice, upperPrice };
}

function failPlan(reason, extra = {}) {
  return {
    ok: false,
    failClosed: true,
    allowNewEntry: false,
    strategy: STRATEGY.SAFE_WAIT,
    direction: DIRECTION.NONE,
    regime: extra.regime ?? null,
    reasons: [reason],
    fallback: STRATEGY.STRATEGY_B_FALLBACK,
    grid: null,
    capital: null,
    leverage: null,
    leverageSource: null,
    rebalance: { rebalance: false, reasons: [reason] },
    decidedAtMs: extra.nowMs ?? Date.now(),
  };
}

function pickGridCount({ atrPct, lowerPrice, upperPrice, strategy, currentPrice, feeRate, cfg }) {
  let base = cfg.DEFAULT_GRID_COUNT;
  if (atrPct >= 0.02) base = Math.round(base * 0.75);
  else if (atrPct <= 0.005) base = Math.round(base * 1.25);
  if (strategy === STRATEGY.NEUTRAL_GRID) base = Math.round(base * 1.1);
  else if (strategy === STRATEGY.LONG_TRAILING_GRID || strategy === STRATEGY.SHORT_TRAILING_GRID) {
    base = Math.round(base * 0.9);
  }
  let n = clampInt(base, cfg.MIN_GRID_COUNT, cfg.MAX_GRID_COUNT);
  const range = upperPrice - lowerPrice;
  const minSpacing = Math.max(currentPrice * feeRate, 0.0001);
  while (n > cfg.MIN_GRID_COUNT && (range / (n - 1)) < minSpacing) {
    n -= 1;
  }
  return n;
}

function pickLeverage({ atrPct, strategy, override, cfg }) {
  if (override != null && Number.isFinite(override)) {
    return {
      value: clampInt(Math.floor(override), cfg.MIN_LEVERAGE, cfg.MAX_LEVERAGE),
      source: 'OVERRIDE',
    };
  }
  let lev;
  if (atrPct >= 0.02) lev = 1;
  else if (atrPct >= 0.01) lev = 2;
  else if (atrPct >= 0.005) lev = 3;
  else lev = 4;
  if (strategy === STRATEGY.NEUTRAL_GRID) lev = Math.min(lev, 2);
  lev = Math.min(lev, cfg.HEURISTIC_MAX_LEVERAGE);
  return {
    value: clampInt(lev, cfg.MIN_LEVERAGE, cfg.MAX_LEVERAGE),
    source: 'AUTO',
  };
}

function pickDeployFraction({ strategy, cfg }) {
  const raw = cfg.DEPLOY_FRACTION_BY_STRATEGY[strategy] ?? 0;
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.max(0, Math.min(cfg.MAX_DEPLOY_FRACTION, raw));
}

/**
 * 그리드 계획 수립.
 */
export function planAdaptiveGrid(args = {}, opts = {}) {
  const cfg = { ...GRID_PLAN_DEFAULTS, ...opts };
  const {
    currentPrice,
    atr,
    availableCapitalKrw = cfg.HARD_CAP_KRW,
    exchangeRateKrw = cfg.DEFAULT_EXCHANGE_RATE_KRW,
    regimeInput = {},
    feeRate = 0.0006,
    leverageOverride = null,
    lastPlan = null,
    nowMs = Date.now(),
    forceRebalance = false,
  } = args;

  if (!isFinitePositive(currentPrice)) return failPlan('INVALID_CURRENT_PRICE', { nowMs });
  if (!isFiniteNonNegative(atr)) return failPlan('INVALID_ATR', { nowMs });
  if (!isFinitePositive(availableCapitalKrw)) return failPlan('INVALID_CAPITAL', { nowMs });
  if (!isFinitePositive(exchangeRateKrw)) return failPlan('INVALID_FX', { nowMs });
  if (!isFiniteNonNegative(feeRate)) return failPlan('INVALID_FEE_RATE', { nowMs });

  const plan = selectAIPlan({
    ...regimeInput,
    currentPrice,
    atr,
    lastUpdateMs: regimeInput.lastUpdateMs ?? nowMs,
    nowMs: regimeInput.nowMs ?? nowMs,
  });

  if (plan.failClosed || !plan.allowNewEntry) {
    return {
      ok: true,
      failClosed: plan.failClosed,
      allowNewEntry: false,
      strategy: plan.strategy,
      direction: plan.direction,
      regime: plan.regime,
      reasons: [...plan.reasons, `ENTRY_BLOCKED_BY:${plan.strategy}`],
      fallback: plan.fallback,
      grid: null,
      capital: null,
      leverage: null,
      leverageSource: null,
      rebalance: { rebalance: false, reasons: ['NO_NEW_ENTRY'] },
      decidedAtMs: nowMs,
    };
  }

  const atrPct = atr / currentPrice;
  const multiplier = atrPct >= 0.02 ? cfg.ATR_MULTIPLIER_HIGH_VOL
    : atrPct >= 0.005 ? cfg.ATR_MULTIPLIER_MID_VOL
    : cfg.ATR_MULTIPLIER_LOW_VOL;

  let rawBounds;
  try {
    rawBounds = calculateDynamicBounds({
      currentPrice,
      atr,
      multiplier,
      pricePlace: cfg.PRICE_PLACE,
    });
  } catch (err) {
    return failPlan('BOUNDS_THROW', { regime: plan.regime, nowMs });
  }
  const { lowerPrice, upperPrice } = normalizeBounds(rawBounds);

  if (!isFinitePositive(lowerPrice) || !isFinitePositive(upperPrice) || lowerPrice >= upperPrice) {
    return failPlan('BOUNDS_INVALID', { regime: plan.regime, nowMs });
  }

  const gridCount = pickGridCount({
    atrPct, lowerPrice, upperPrice, strategy: plan.strategy, currentPrice, feeRate, cfg,
  });
  const spacing = (upperPrice - lowerPrice) / Math.max(1, gridCount - 1);
  const minSpacing = Math.max(currentPrice * feeRate, 0.0001);
  if (!(spacing >= minSpacing)) {
    return failPlan('SPACING_TOO_TIGHT', { regime: plan.regime, nowMs });
  }

  const lev = pickLeverage({ atrPct, strategy: plan.strategy, override: leverageOverride, cfg });
  if (!(lev.value >= cfg.MIN_LEVERAGE && lev.value <= cfg.MAX_LEVERAGE)) {
    return failPlan('LEVERAGE_OUT_OF_RANGE', { regime: plan.regime, nowMs });
  }

  const deployFraction = pickDeployFraction({ strategy: plan.strategy, cfg });
  if (!(deployFraction > 0)) {
    return failPlan('DEPLOY_FRACTION_ZERO', { regime: plan.regime, nowMs });
  }

  const maxDeployKrw = Math.min(cfg.HARD_CAP_KRW, Math.floor(availableCapitalKrw));
  const deployKrw = Math.min(
    Math.floor(maxDeployKrw * deployFraction),
    Math.floor(maxDeployKrw * cfg.MAX_DEPLOY_FRACTION),
  );
  const reserveKrw = maxDeployKrw - deployKrw;
  if (deployKrw <= 0 || reserveKrw < Math.floor(maxDeployKrw * cfg.MIN_RESERVE_FRACTION)) {
    return failPlan('CAPITAL_RESERVE_INSUFFICIENT', { regime: plan.regime, nowMs });
  }

  const deployUsdt = deployKrw / exchangeRateKrw;

  const candidate = {
    ok: true,
    failClosed: false,
    allowNewEntry: true,
    strategy: plan.strategy,
    direction: plan.direction,
    regime: plan.regime,
    reasons: plan.reasons.slice(),
    fallback: plan.fallback,
    grid: { lowerPrice, upperPrice, gridCount, spacing, mode: 'arithmetic' },
    capital: { maxDeployKrw, deployKrw, reserveKrw, deployUsdt, exchangeRateKrw },
    leverage: lev.value,
    leverageSource: lev.source,
    decidedAtMs: nowMs,
  };

  candidate.rebalance = evaluateRebalance({
    currentPlan: lastPlan,
    nextPlan: candidate,
    nowMs,
    forceRebalance,
    cfg,
  });

  return candidate;
}

function evaluateRebalance({ currentPlan, nextPlan, nowMs, forceRebalance, cfg }) {
  if (forceRebalance) return { rebalance: true, reasons: ['FORCE_REBALANCE'] };
  if (!currentPlan || !currentPlan.ok || !currentPlan.grid) {
    return { rebalance: false, reasons: ['NO_LAST_PLAN'] };
  }
  if (!nextPlan || !nextPlan.grid) {
    return { rebalance: false, reasons: ['NO_NEXT_PLAN'] };
  }
  return shouldRebalance(currentPlan, nextPlan, { ...cfg, nowMs });
}

/**
 * 두 계획 사이의 재조정 필요성 판단.
 */
export function shouldRebalance(currentPlan, nextPlan, opts = {}) {
  const cfg = { ...GRID_PLAN_DEFAULTS, ...opts };
  if (!currentPlan || !currentPlan.ok || !currentPlan.grid) {
    return { rebalance: false, reasons: ['NO_CURRENT_PLAN'] };
  }
  if (!nextPlan || !nextPlan.ok || !nextPlan.grid) {
    return { rebalance: false, reasons: ['NO_NEXT_PLAN'] };
  }

  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const lastAt = Number.isFinite(currentPlan.decidedAtMs) ? currentPlan.decidedAtMs : 0;
  const sinceMs = nowMs - lastAt;

  const curMid = (currentPlan.grid.lowerPrice + currentPlan.grid.upperPrice) / 2;
  const nextMid = (nextPlan.grid.lowerPrice + nextPlan.grid.upperPrice) / 2;
  const drift = Math.abs(nextMid - curMid) / Math.max(curMid, 1e-9);

  const regimeChanged = currentPlan.regime !== nextPlan.regime;
  const gridDelta = Math.abs(
    (nextPlan.grid.gridCount || 0) - (currentPlan.grid.gridCount || 0),
  );

  const reasons = [];
  if (regimeChanged) reasons.push('REGIME_CHANGED');
  if (drift >= cfg.MIN_REBALANCE_PRICE_DRIFT_PCT) {
    reasons.push(`PRICE_DRIFT=${drift.toFixed(4)}`);
  }
  if (gridDelta >= cfg.MIN_REBALANCE_GRID_COUNT_DELTA) {
    reasons.push(`GRID_COUNT_DELTA=${gridDelta}`);
  }

  if (!regimeChanged && sinceMs < cfg.MIN_REBALANCE_INTERVAL_MS) {
    return {
      rebalance: false,
      reasons: ['RATE_LIMITED', `sinceMs=${sinceMs}`],
    };
  }

  if (reasons.length === 0) {
    return { rebalance: false, reasons: ['NO_MATERIAL_CHANGE'] };
  }
  return { rebalance: true, reasons };
}
