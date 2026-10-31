// ai-risk-orchestrator.mjs
// BLOCK 19 Step 3 — AI 위험 오케스트레이터
//
// 원칙:
//   - risk-manager.mjs::checkRiskLimits 래핑 (기존 파일 수정 금지)
//   - 500,000 KRW 하드 캡 / 65% 최대 투입 / 30% 최소 예비금
//   - 레버리지 1~10 (자동 결정은 5 이하)
//   - 일일 손실 한도 (UTC 기준) — 재시작 후에도 유지
//   - 중복 주문 방지 — symbol + direction + strategy + grid 서명
//   - 청산 위험: 정보 부족 시 추정 금지 → FAIL_CLOSED
//   - 수수료·펀딩비 반영 (grid-math.mjs::calculateFee 재사용)
//   - 완전 실패 시 fail-closed (신규 진입 절대 금지)

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { checkRiskLimits as legacyCheckRiskLimits } from './risk-manager.mjs';
import { calculateFee } from './grid-math.mjs';
import { STRATEGY, DIRECTION } from './ai-strategy-selector.mjs';

export const RISK_DEFAULTS = Object.freeze({
  HARD_CAP_KRW: 500_000,
  MAX_DEPLOY_FRACTION: 0.65,
  MIN_RESERVE_FRACTION: 0.30,
  MIN_LEVERAGE: 1,
  MAX_LEVERAGE: 10,
  HEURISTIC_MAX_LEVERAGE: 5,
  DAILY_LOSS_LIMIT_KRW: 100_000,
  MIN_LIQUIDATION_SAFETY_PCT: 0.10,
  MAINTENANCE_MARGIN_RATE: 0.005,
  DEFAULT_FEE_RATE: 0.0006,
  DEFAULT_FUNDING_PERIODS: 1,
  DUPLICATE_ORDER_TTL_MS: 60 * 60 * 1000,
  DEFAULT_EXCHANGE_RATE_KRW: 1350,
  DEFAULT_STATE_PATH: null,
});

// ── 유틸 ──────────────────────────────────────────
function isFinitePositive(x) {
  return typeof x === 'number' && Number.isFinite(x) && x > 0;
}
function isFiniteNonNegative(x) {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0;
}

export function utcDayKey(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function defaultStatePath() {
  return path.join(process.cwd(), '.runtime', 'block19-risk-state.json');
}

// ── 상태 저장/복원 ────────────────────────────────
export function emptyState() {
  return {
    version: 1,
    dayKey: null,
    realizedLossKrw: 0,
    activeOrders: {},
    lastUpdatedMs: null,
  };
}

export function loadState({ statePath } = {}) {
  if (!statePath) return emptyState();
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) {
      return emptyState();
    }
    return {
      version: 1,
      dayKey: typeof parsed.dayKey === 'string' ? parsed.dayKey : null,
      realizedLossKrw: Number.isFinite(parsed.realizedLossKrw) ? parsed.realizedLossKrw : 0,
      activeOrders:
        parsed.activeOrders && typeof parsed.activeOrders === 'object'
          ? parsed.activeOrders : {},
      lastUpdatedMs: Number.isFinite(parsed.lastUpdatedMs) ? parsed.lastUpdatedMs : null,
    };
  } catch {
    return emptyState();
  }
}

export function saveState({ statePath, state } = {}) {
  if (!statePath || !state) return { saved: false };
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
    return { saved: true };
  } catch (err) {
    return { saved: false, error: err.message };
  }
}

export function rollStateDay(state, nowMs) {
  const key = utcDayKey(nowMs);
  if (state.dayKey !== key) {
    return {
      ...state,
      dayKey: key,
      realizedLossKrw: 0,
      lastUpdatedMs: nowMs,
    };
  }
  return { ...state, lastUpdatedMs: nowMs };
}

export function recordRealizedLoss(state, lossKrw, nowMs) {
  const next = rollStateDay(state, nowMs);
  const add = Math.max(0, Number(lossKrw) || 0);
  return {
    ...next,
    realizedLossKrw: next.realizedLossKrw + add,
    lastUpdatedMs: nowMs,
  };
}

export function applyRealizedLossToState({ state, statePath, lossKrw, nowMs }) {
  const base = state || loadState({ statePath });
  const next = recordRealizedLoss(base, lossKrw, nowMs);
  saveState({ statePath, state: next });
  return next;
}

export function isDailyLossLimitReached({ state, statePath, nowMs = Date.now() }) {
  const s = rollStateDay(state || loadState({ statePath }), nowMs);
  return s.realizedLossKrw >= RISK_DEFAULTS.DAILY_LOSS_LIMIT_KRW;
}

// ── 중복 주문 방지 ────────────────────────────────
export function makeDuplicateOrderKey({ symbol, direction, strategy, grid }) {
  const gridId = grid
    ? `${grid.lowerPrice}-${grid.upperPrice}-${grid.gridCount}-${grid.spacing}`
    : 'nogrid';
  const raw = `${symbol || 'SYM'}|${direction || 'DIR'}|${strategy || 'STRAT'}|${gridId}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

export function hasActiveOrder(state, key, nowMs, ttlMs) {
  const entry = state?.activeOrders?.[key];
  if (!entry) return false;
  if (!Number.isFinite(entry.addedAtMs)) return false;
  if (nowMs - entry.addedAtMs > ttlMs) return false;
  return true;
}

export function markOrderActive(state, key, nowMs) {
  return {
    ...state,
    activeOrders: {
      ...(state.activeOrders || {}),
      [key]: { addedAtMs: nowMs },
    },
    lastUpdatedMs: nowMs,
  };
}

export function purgeExpiredOrders(state, nowMs, ttlMs) {
  const active = state.activeOrders || {};
  const kept = {};
  for (const [k, v] of Object.entries(active)) {
    if (Number.isFinite(v?.addedAtMs) && nowMs - v.addedAtMs <= ttlMs) {
      kept[k] = v;
    }
  }
  return { ...state, activeOrders: kept, lastUpdatedMs: nowMs };
}

// ── 청산 위험 ─────────────────────────────────────
export function estimateLiquidationPrice({
  direction, entryPrice, leverage, maintenanceMarginRate,
}) {
  if (!isFinitePositive(entryPrice)) return { ok: false, error: 'INVALID_ENTRY_PRICE' };
  if (!isFinitePositive(leverage)) return { ok: false, error: 'INVALID_LEVERAGE' };
  if (!isFiniteNonNegative(maintenanceMarginRate)) return { ok: false, error: 'INVALID_MMR' };
  if (direction !== DIRECTION.LONG && direction !== DIRECTION.SHORT) {
    return { ok: false, error: 'INVALID_DIRECTION' };
  }
  if (direction === DIRECTION.LONG) {
    const liq = entryPrice * (1 - 1 / leverage + maintenanceMarginRate);
    return liq > 0 ? { ok: true, price: liq } : { ok: false, error: 'LIQ_NON_POSITIVE' };
  }
  const liq = entryPrice * (1 + 1 / leverage - maintenanceMarginRate);
  return liq > 0 ? { ok: true, price: liq } : { ok: false, error: 'LIQ_NON_POSITIVE' };
}

export function computeSafetyPct({ direction, currentPrice, liquidationPrice }) {
  if (!isFinitePositive(currentPrice)) return null;
  if (!isFinitePositive(liquidationPrice)) return null;
  if (direction === DIRECTION.LONG) {
    if (currentPrice <= liquidationPrice) return 0;
    return (currentPrice - liquidationPrice) / currentPrice;
  }
  if (direction === DIRECTION.SHORT) {
    if (liquidationPrice <= currentPrice) return 0;
    return (liquidationPrice - currentPrice) / currentPrice;
  }
  return null;
}

// ── 수수료 + 펀딩비 ───────────────────────────────
export function estimateFeesAndFunding({
  deployUsdt, leverage, feeRate, fundingRate, fundingPeriods, notionalUsdt,
}) {
  const notional = Number.isFinite(notionalUsdt)
    ? notionalUsdt
    : (Number(deployUsdt) * Number(leverage));
  if (!isFinitePositive(notional)) return { ok: false, error: 'INVALID_NOTIONAL' };
  if (!isFiniteNonNegative(feeRate)) return { ok: false, error: 'INVALID_FEE_RATE' };

  let entryFee = 0;
  try {
    entryFee = Number(calculateFee({ price: 1, quantity: notional, feeRate })) || 0;
  } catch {
    entryFee = notional * feeRate;
  }
  const exitFee = entryFee;
  const totalFees = entryFee + exitFee;

  let fundingCost = 0;
  if (Number.isFinite(fundingRate) && fundingRate !== 0) {
    const periods = Number.isFinite(fundingPeriods) ? fundingPeriods : 1;
    fundingCost = Math.abs(notional * fundingRate * periods);
  }

  return {
    ok: true,
    notional,
    entryFee,
    exitFee,
    totalFees,
    fundingCost,
    totalCost: totalFees + fundingCost,
  };
}

// ── 메인 오케스트레이터 ───────────────────────────
export function evaluateRisk(args = {}, opts = {}) {
  const cfg = { ...RISK_DEFAULTS, ...(opts || {}) };
  const {
    plan,
    symbol,
    currentPrice,
    exchangeRateKrw = cfg.DEFAULT_EXCHANGE_RATE_KRW,
    availableCapitalKrw = cfg.HARD_CAP_KRW,
    feeRate = cfg.DEFAULT_FEE_RATE,
    fundingRate = null,
    fundingPeriods = cfg.DEFAULT_FUNDING_PERIODS,
    maintenanceMarginRate = cfg.MAINTENANCE_MARGIN_RATE,
    nowMs = Date.now(),
    state: inputState = null,
    statePath = cfg.DEFAULT_STATE_PATH,
    quoteBalanceUsdt = null,
    skipLegacy = false,
  } = args;

  let state = inputState || loadState({ statePath });
  state = rollStateDay(state, nowMs);
  state = purgeExpiredOrders(state, nowMs, cfg.DUPLICATE_ORDER_TTL_MS);

  const fail = (reason, extra = {}) => {
    saveState({ statePath, state });
    return {
      ok: false,
      failClosed: true,
      allowNewEntry: false,
      reasons: [reason],
      state,
      orderKey: extra.orderKey || null,
      fees: extra.fees || null,
      liquidation: extra.liquidation || null,
      legacyCheck: extra.legacyCheck || null,
      fallback: plan?.fallback || null,
      decidedAtMs: nowMs,
    };
  };

  // 1) 플랜 유효성
  if (!plan || plan.ok !== true || plan.allowNewEntry !== true) {
    return fail('PLAN_NOT_ENTRY_ALLOWED');
  }
  // 2) 기본 입력
  if (!isFinitePositive(currentPrice)) return fail('INVALID_CURRENT_PRICE');
  if (!isFinitePositive(exchangeRateKrw)) return fail('INVALID_FX');
  if (!isFiniteNonNegative(feeRate)) return fail('INVALID_FEE_RATE');
  if (!isFinitePositive(availableCapitalKrw)) return fail('INVALID_CAPITAL');

  const planCap = plan.capital;
  const planLev = plan.leverage;
  if (!planCap || !isFinitePositive(planCap.deployKrw)) return fail('INVALID_PLAN_CAPITAL');
  if (!isFinitePositive(planLev)) return fail('INVALID_PLAN_LEVERAGE');

  // 3) 자금 한도 / 투입 / 예비금
  const maxDeployKrw = Math.min(cfg.HARD_CAP_KRW, Math.floor(availableCapitalKrw));
  if (planCap.maxDeployKrw > cfg.HARD_CAP_KRW) return fail('EXCEEDS_HARD_CAP');
  if (planCap.deployKrw > Math.floor(maxDeployKrw * cfg.MAX_DEPLOY_FRACTION)) {
    return fail('EXCEEDS_MAX_DEPLOY_FRACTION');
  }
  if (planCap.reserveKrw < Math.floor(maxDeployKrw * cfg.MIN_RESERVE_FRACTION)) {
    return fail('RESERVE_BELOW_MINIMUM');
  }

  // 4) 레버리지
  if (planLev < cfg.MIN_LEVERAGE || planLev > cfg.MAX_LEVERAGE) {
    return fail('LEVERAGE_OUT_OF_RANGE');
  }
  if (plan.leverageSource === 'AUTO' && planLev > cfg.HEURISTIC_MAX_LEVERAGE) {
    return fail('AUTO_LEVERAGE_EXCEEDS_HEURISTIC');
  }

  // 5) 일일 손실 한도
  if (state.realizedLossKrw >= cfg.DAILY_LOSS_LIMIT_KRW) {
    return fail('DAILY_LOSS_LIMIT_REACHED');
  }

  // 6) 기존 checkRiskLimits 래핑 (수정 금지, 옵션으로 skip 가능)
  let legacyCheck;
  if (skipLegacy) {
    legacyCheck = { called: false, skipped: true };
  } else {
    try {
      const totalInvestmentUsdt = planCap.deployUsdt || (planCap.deployKrw / exchangeRateKrw);
      const legacyResult = legacyCheckRiskLimits({
        totalInvestmentUsdt,
        exchangeRateKrw,
        maxLimitKrw: cfg.HARD_CAP_KRW,
        currentPrice,
        lowerPrice: plan.grid?.lowerPrice ?? 0,
        leverage: planLev,
      });
      const explicitFail =
        legacyResult === false ||
        (legacyResult && typeof legacyResult === 'object' && legacyResult.ok === false);
      if (explicitFail) {
        return fail('LEGACY_RISK_LIMIT_FAILED', {
          legacyCheck: { called: true, result: legacyResult },
        });
      }
      legacyCheck = { called: true, result: legacyResult };
    } catch (err) {
      return fail('LEGACY_RISK_LIMIT_THREW', {
        legacyCheck: { called: true, error: err.message },
      });
    }
  }

  // 7) 중복 주문
  const orderKey = makeDuplicateOrderKey({
    symbol: symbol || plan.symbol || 'UNKNOWN',
    direction: plan.direction,
    strategy: plan.strategy,
    grid: plan.grid,
  });
  if (hasActiveOrder(state, orderKey, nowMs, cfg.DUPLICATE_ORDER_TTL_MS)) {
    return fail('DUPLICATE_ORDER_ACTIVE', { orderKey });
  }

  // 8) 청산 위험
  let liquidation = null;
  let safetyPct = null;
  if (plan.direction === DIRECTION.NEUTRAL) {
    const liqLong = estimateLiquidationPrice({
      direction: DIRECTION.LONG, entryPrice: currentPrice, leverage: planLev, maintenanceMarginRate,
    });
    const liqShort = estimateLiquidationPrice({
      direction: DIRECTION.SHORT, entryPrice: currentPrice, leverage: planLev, maintenanceMarginRate,
    });
    if (!liqLong.ok || !liqShort.ok) return fail('LIQUIDATION_UNCOMPUTABLE', { orderKey });
    const sL = computeSafetyPct({ direction: DIRECTION.LONG, currentPrice, liquidationPrice: liqLong.price });
    const sS = computeSafetyPct({ direction: DIRECTION.SHORT, currentPrice, liquidationPrice: liqShort.price });
    safetyPct = Math.min(sL, sS);
    liquidation = { liqLong: liqLong.price, liqShort: liqShort.price, safetyPct };
  } else if (plan.direction === DIRECTION.LONG || plan.direction === DIRECTION.SHORT) {
    const liq = estimateLiquidationPrice({
      direction: plan.direction, entryPrice: currentPrice, leverage: planLev, maintenanceMarginRate,
    });
    if (!liq.ok) return fail('LIQUIDATION_UNCOMPUTABLE', { orderKey });
    safetyPct = computeSafetyPct({ direction: plan.direction, currentPrice, liquidationPrice: liq.price });
    liquidation = { price: liq.price, safetyPct };
  } else {
    return fail('INVALID_DIRECTION', { orderKey });
  }

  if (safetyPct == null || safetyPct < cfg.MIN_LIQUIDATION_SAFETY_PCT) {
    return fail(
      `LIQUIDATION_SAFETY_TOO_LOW:${safetyPct != null ? safetyPct.toFixed(4) : 'null'}`,
      { orderKey, liquidation },
    );
  }

  // 9) 수수료 + 펀딩비
  const planUsdt = planCap.deployUsdt || (planCap.deployKrw / exchangeRateKrw);
  const fees = estimateFeesAndFunding({
    deployUsdt: planUsdt, leverage: planLev, feeRate, fundingRate, fundingPeriods,
  });
  if (!fees.ok) return fail('FEES_UNCOMPUTABLE', { orderKey, fees });

  // 10) 실 잔고 검증 (선택)
  if (Number.isFinite(quoteBalanceUsdt)) {
    const requiredUsdt = planUsdt + fees.totalCost;
    if (quoteBalanceUsdt < requiredUsdt) {
      return fail('INSUFFICIENT_QUOTE_BALANCE', { orderKey, fees });
    }
  }

  // 11) 통과
  state = markOrderActive(state, orderKey, nowMs);
  saveState({ statePath, state });

  return {
    ok: true,
    failClosed: false,
    allowNewEntry: true,
    reasons: ['RISK_APPROVED'],
    state,
    orderKey,
    fees,
    liquidation,
    legacyCheck,
    fallback: plan.fallback || null,
    decidedAtMs: nowMs,
  };
}
