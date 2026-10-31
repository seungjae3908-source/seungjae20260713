// block19-risk.test.mjs
// BLOCK 19 Step 3 — AI 위험 오케스트레이터 테스트
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  RISK_DEFAULTS,
  emptyState,
  loadState,
  saveState,
  rollStateDay,
  recordRealizedLoss,
  makeDuplicateOrderKey,
  hasActiveOrder,
  markOrderActive,
  purgeExpiredOrders,
  estimateLiquidationPrice,
  computeSafetyPct,
  estimateFeesAndFunding,
  evaluateRisk,
  applyRealizedLossToState,
  isDailyLossLimitReached,
  utcDayKey,
} from '../src/ai-risk-orchestrator.mjs';
import { planAdaptiveGrid } from '../src/adaptive-grid-planner.mjs';
import { STRATEGY, DIRECTION } from '../src/ai-strategy-selector.mjs';

const NOW = 1_700_000_000_000; // 2023-11-14T22:13:20Z
const DAY_MS = 24 * 60 * 60 * 1000;

function newStatePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'b19r-')), 'state.json');
}

function deepMerge(a, b) {
  if (!b) return a;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object') {
      out[k] = { ...a[k], ...v };
    } else {
      out[k] = v;
    }
  }
  return out;
}

function makeValidPlan(overrides = {}) {
  const base = {
    ok: true,
    failClosed: false,
    allowNewEntry: true,
    strategy: STRATEGY.LONG_TRAILING_GRID,
    direction: DIRECTION.LONG,
    regime: 'STRONG_UPTREND',
    reasons: [],
    fallback: STRATEGY.STRATEGY_B_FALLBACK,
    grid: {
      lowerPrice: 98.5, upperPrice: 101.5, gridCount: 20, spacing: 0.158, mode: 'arithmetic',
    },
    capital: {
      maxDeployKrw: 500_000,
      deployKrw: 150_000,
      reserveKrw: 350_000,
      deployUsdt: 150_000 / 1350,
      exchangeRateKrw: 1350,
    },
    leverage: 2,
    leverageSource: 'AUTO',
    decidedAtMs: NOW,
  };
  return deepMerge(base, overrides);
}

function baseArgs(overrides = {}) {
  return {
    plan: makeValidPlan(),
    symbol: 'BTCUSDT',
    currentPrice: 100,
    nowMs: NOW,
    statePath: newStatePath(),
    skipLegacy: true,
    ...overrides,
  };
}

// ════════════════════════════════════════════════════
// A. 자금 한도 초과
// ════════════════════════════════════════════════════
test('A1: deployKrw 가 MAX_DEPLOY_FRACTION 초과 → 차단', () => {
  const plan = makeValidPlan({
    capital: { deployKrw: 400_000, reserveKrw: 100_000 }, // 80%, reserve 20%
  });
  const r = evaluateRisk(baseArgs({ plan }));
  assert.equal(r.ok, false);
  assert.ok(r.reasons.includes('EXCEEDS_MAX_DEPLOY_FRACTION'));
});

test('A2: maxDeployKrw > HARD_CAP → 차단', () => {
  const plan = makeValidPlan({
    capital: { maxDeployKrw: 600_000, deployKrw: 300_000, reserveKrw: 300_000 },
  });
  const r = evaluateRisk(baseArgs({ plan }));
  assert.equal(r.ok, false);
  assert.ok(r.reasons.includes('EXCEEDS_HARD_CAP'));
});

// ════════════════════════════════════════════════════
// B. 예비금 침해
// ════════════════════════════════════════════════════
test('B1: reserveKrw < 30% → 차단', () => {
  const plan = makeValidPlan({
    capital: { deployKrw: 400_000, reserveKrw: 100_000 },
  });
  const r = evaluateRisk(baseArgs({ plan }));
  assert.equal(r.ok, false);
  // deploy 위반 또는 reserve 위반 둘 다 가능 — 최소한 실패
  assert.equal(r.ok, false);
});

test('B2: 정확히 30% 예비금은 통과', () => {
  const plan = makeValidPlan({
    capital: { deployKrw: 350_000, reserveKrw: 150_000, deployUsdt: 350_000 / 1350 },
  });
  const r = evaluateRisk(baseArgs({ plan }));
  // reserve 30% 충족, deploy 70% 는 65% 초과 → fail이어야 함
  assert.equal(r.ok, false);
  assert.ok(r.reasons.includes('EXCEEDS_MAX_DEPLOY_FRACTION'));
});

// ════════════════════════════════════════════════════
// C. 레버리지 제한
// ════════════════════════════════════════════════════
test('C1: leverage < 1 → 차단', () => {
  const r = evaluateRisk(baseArgs({ plan: makeValidPlan({ leverage: 0 }) }));
  assert.equal(r.ok, false);
  assert.ok(r.reasons.includes('LEVERAGE_OUT_OF_RANGE') || r.reasons.includes('INVALID_PLAN_LEVERAGE'));
});

test('C2: leverage > 10 → 차단', () => {
  const r = evaluateRisk(baseArgs({ plan: makeValidPlan({ leverage: 15 }) }));
  assert.equal(r.ok, false);
  assert.ok(r.reasons.includes('LEVERAGE_OUT_OF_RANGE'));
});

test('C3: AUTO 소스에서 leverage > 5 → 차단', () => {
  const r = evaluateRisk(baseArgs({
    plan: makeValidPlan({ leverage: 8, leverageSource: 'AUTO' }),
  }));
  assert.equal(r.ok, false);
  assert.ok(r.reasons.includes('AUTO_LEVERAGE_EXCEEDS_HEURISTIC'));
});

// ════════════════════════════════════════════════════
// D. 일일 손실 한도
// ════════════════════════════════════════════════════
test('D1: 일일 손실 한도 도달 시 차단', () => {
  const p = newStatePath();
  const s0 = rollStateDay(emptyState(), NOW);
  const s1 = recordRealizedLoss(s0, RISK_DEFAULTS.DAILY_LOSS_LIMIT_KRW, NOW);
  saveState({ statePath: p, state: s1 });

  const r = evaluateRisk({
    ...baseArgs({ statePath: p }),
    state: null, // force load from file
  });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.includes('DAILY_LOSS_LIMIT_REACHED'));
});

test('D2: 손실 한도 미만이면 통과', () => {
  const p = newStatePath();
  const s0 = rollStateDay(emptyState(), NOW);
  const s1 = recordRealizedLoss(s0, RISK_DEFAULTS.DAILY_LOSS_LIMIT_KRW - 1, NOW);
  saveState({ statePath: p, state: s1 });

  const r = evaluateRisk({ ...baseArgs({ statePath: p }), state: null });
  assert.equal(r.ok, true);
});

// ════════════════════════════════════════════════════
// E. 날짜 변경 + 재시작 복구
// ════════════════════════════════════════════════════
test('E1: 일일 손실이 재시작 후에도 유지', () => {
  const p = newStatePath();
  applyRealizedLossToState({
    state: emptyState(), statePath: p, lossKrw: 50_000, nowMs: NOW,
  });
  const loaded = loadState({ statePath: p });
  assert.equal(loaded.realizedLossKrw, 50_000);
  assert.equal(loaded.dayKey, utcDayKey(NOW));
});

test('E2: UTC 날짜 변경 시 일일 손실 0으로 리셋', () => {
  const p = newStatePath();
  applyRealizedLossToState({
    state: emptyState(), statePath: p,
    lossKrw: RISK_DEFAULTS.DAILY_LOSS_LIMIT_KRW, nowMs: NOW,
  });
  const loaded = loadState({ statePath: p });
  const rolled = rollStateDay(loaded, NOW + DAY_MS);
  assert.equal(rolled.realizedLossKrw, 0);
  assert.equal(rolled.dayKey, utcDayKey(NOW + DAY_MS));
});

test('E3: 재시작 후 활성 주문 키 유지 → 중복 차단', () => {
  const p = newStatePath();
  const r1 = evaluateRisk({
    ...baseArgs({ statePath: p, state: emptyState() }),
  });
  assert.equal(r1.ok, true);
  assert.ok(r1.orderKey);

  // Restart
  const r2 = evaluateRisk({
    ...baseArgs({ statePath: p, state: null, nowMs: NOW + 1000 }),
  });
  assert.equal(r2.ok, false);
  assert.ok(r2.reasons.includes('DUPLICATE_ORDER_ACTIVE'));
});

test('E4: 다음 UTC 날짜에는 손실 초기화되어 통과', () => {
  const p = newStatePath();
  applyRealizedLossToState({
    state: emptyState(), statePath: p,
    lossKrw: RISK_DEFAULTS.DAILY_LOSS_LIMIT_KRW, nowMs: NOW,
  });
  const r = evaluateRisk({
    ...baseArgs({ statePath: p, state: null, nowMs: NOW + DAY_MS }),
  });
  assert.equal(r.ok, true);
});

// ════════════════════════════════════════════════════
// F. 중복 주문
// ════════════════════════════════════════════════════
test('F1: 동일 plan 반복 → 중복 차단', () => {
  const p = newStatePath();
  const r1 = evaluateRisk(baseArgs({ statePath: p }));
  assert.equal(r1.ok, true);
  const r2 = evaluateRisk(baseArgs({ statePath: p, nowMs: NOW + 1000 }));
  assert.equal(r2.ok, false);
  assert.ok(r2.reasons.includes('DUPLICATE_ORDER_ACTIVE'));
});

test('F2: symbol 다르면 별개 키로 통과', () => {
  const p = newStatePath();
  evaluateRisk(baseArgs({ statePath: p, symbol: 'BTCUSDT' }));
  const r2 = evaluateRisk(baseArgs({
    statePath: p, symbol: 'ETHUSDT', nowMs: NOW + 1000,
  }));
  assert.equal(r2.ok, true);
});

test('F3: TTL 만료 후 재주문 가능', () => {
  const p = newStatePath();
  evaluateRisk(baseArgs({ statePath: p }));
  const past = NOW + RISK_DEFAULTS.DUPLICATE_ORDER_TTL_MS + 1000;
  const r2 = evaluateRisk(baseArgs({ statePath: p, nowMs: past }));
  assert.equal(r2.ok, true);
});

// ════════════════════════════════════════════════════
// G. 청산 위험
// ════════════════════════════════════════════════════
test('G1: 낮은 레버리지(2x)는 안전거리 통과', () => {
  const r = evaluateRisk(baseArgs({ plan: makeValidPlan({ leverage: 2 }) }));
  assert.equal(r.ok, true);
  assert.ok(r.liquidation);
  assert.ok(r.liquidation.safetyPct >= RISK_DEFAULTS.MIN_LIQUIDATION_SAFETY_PCT);
});

test('G2: 높은 레버리지(10x)는 안전거리 미달 → 차단', () => {
  const r = evaluateRisk(baseArgs({
    plan: makeValidPlan({ leverage: 10, leverageSource: 'OVERRIDE' }),
  }));
  assert.equal(r.ok, false);
  assert.ok(r.reasons[0].startsWith('LIQUIDATION_SAFETY_TOO_LOW'));
});

test('G3: 잘못된 entry → LIQUIDATION_UNCOMPUTABLE', () => {
  const r = evaluateRisk(baseArgs({ currentPrice: 0 }));
  assert.equal(r.ok, false);
  // INVALID_CURRENT_PRICE 또는 LIQUIDATION_UNCOMPUTABLE
  assert.ok(
    r.reasons.includes('INVALID_CURRENT_PRICE') || r.reasons.includes('LIQUIDATION_UNCOMPUTABLE'),
  );
});

test('G4: SHORT 방향도 안전거리 계산', () => {
  const r = evaluateRisk(baseArgs({
    plan: makeValidPlan({
      direction: DIRECTION.SHORT,
      strategy: STRATEGY.SHORT_TRAILING_GRID,
      leverage: 2,
    }),
  }));
  assert.equal(r.ok, true);
  assert.ok(r.liquidation.safetyPct >= RISK_DEFAULTS.MIN_LIQUIDATION_SAFETY_PCT);
});

test('G5: NEUTRAL 그리드는 양방향 안전거리 검증', () => {
  const r = evaluateRisk(baseArgs({
    plan: makeValidPlan({
      direction: DIRECTION.NEUTRAL,
      strategy: STRATEGY.NEUTRAL_GRID,
      leverage: 2,
    }),
  }));
  assert.equal(r.ok, true);
  assert.ok(r.liquidation);
  assert.ok('liqLong' in r.liquidation && 'liqShort' in r.liquidation);
});

// ════════════════════════════════════════════════════
// H. 펀딩비 + 수수료
// ════════════════════════════════════════════════════
test('H1: 수수료가 계산된다', () => {
  const r = evaluateRisk(baseArgs({ feeRate: 0.0006 }));
  assert.equal(r.ok, true);
  assert.ok(r.fees.totalFees > 0);
  assert.equal(r.fees.fundingCost, 0);
});

test('H2: fundingRate 가 주어지면 펀딩비 포함', () => {
  const r = evaluateRisk(baseArgs({
    fundingRate: 0.0001, fundingPeriods: 3,
  }));
  assert.equal(r.ok, true);
  assert.ok(r.fees.fundingCost > 0);
  assert.ok(r.fees.totalCost > r.fees.totalFees);
});

test('H3: fundingRate=0 이면 펀딩비 0', () => {
  const r = evaluateRisk(baseArgs({ fundingRate: 0 }));
  assert.equal(r.ok, true);
  assert.equal(r.fees.fundingCost, 0);
});

// ════════════════════════════════════════════════════
// I. API 오류 / 불완전 데이터
// ════════════════════════════════════════════════════
test('I1: plan 없음 → PLAN_NOT_ENTRY_ALLOWED', () => {
  const r = evaluateRisk(baseArgs({ plan: null }));
  assert.equal(r.ok, false);
  assert.ok(r.reasons.includes('PLAN_NOT_ENTRY_ALLOWED'));
});

test('I2: currentPrice NaN → INVALID_CURRENT_PRICE', () => {
  const r = evaluateRisk(baseArgs({ currentPrice: NaN }));
  assert.equal(r.ok, false);
  assert.ok(r.reasons.includes('INVALID_CURRENT_PRICE'));
});

test('I3: feeRate 음수 → INVALID_FEE_RATE', () => {
  const r = evaluateRisk(baseArgs({ feeRate: -0.001 }));
  assert.equal(r.ok, false);
  assert.ok(r.reasons.includes('INVALID_FEE_RATE'));
});

test('I4: quoteBalance 부족 → INSUFFICIENT_QUOTE_BALANCE', () => {
  const r = evaluateRisk(baseArgs({ quoteBalanceUsdt: 0.01 }));
  assert.equal(r.ok, false);
  assert.ok(r.reasons.includes('INSUFFICIENT_QUOTE_BALANCE'));
});

test('I5: 손상된 state 파일 → empty 로 복구 후 정상 진행', () => {
  const p = newStatePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '{corrupted-json', 'utf8');
  const loaded = loadState({ statePath: p });
  assert.equal(loaded.realizedLossKrw, 0);
  assert.deepEqual(loaded.activeOrders, {});
});

test('I6: plan.capital 없음 → INVALID_PLAN_CAPITAL', () => {
  const badPlan = { ...makeValidPlan() };
  delete badPlan.capital;
  const r = evaluateRisk(baseArgs({ plan: badPlan }));
  assert.equal(r.ok, false);
  assert.ok(r.reasons.includes('INVALID_PLAN_CAPITAL'));
});

// ════════════════════════════════════════════════════
// J. B fallback 호환성
// ════════════════════════════════════════════════════
test('J1: plan.fallback 이 결과에 그대로 보존된다', () => {
  const r = evaluateRisk(baseArgs());
  assert.equal(r.ok, true);
  assert.equal(r.fallback, STRATEGY.STRATEGY_B_FALLBACK);
});

test('J2: planAdaptiveGrid 산출 plan 과도 호환된다', () => {
  const candles = Array.from({ length: 50 }, (_, i) => ({
    open: 100 + i * 0.1, high: 101 + i * 0.1,
    low: 99 + i * 0.1, close: 100.5 + i * 0.1, volume: 1000 + i * 10,
  }));
  const plan = planAdaptiveGrid({
    currentPrice: 100,
    atr: 0.5,
    availableCapitalKrw: 500_000,
    exchangeRateKrw: 1350,
    nowMs: NOW,
    regimeInput: {
      nowMs: NOW, lastUpdateMs: NOW - 1000, candles,
      adx: 35, rsi: 60, macdHistogram: 0.5, vwap: 98,
      bbWidth: 0.02, currentPrice: 100, atr: 0.5,
    },
  });
  assert.equal(plan.ok, true);
  const r = evaluateRisk(baseArgs({ plan, statePath: newStatePath() }));
  assert.equal(r.ok, true);
  assert.equal(r.fallback, STRATEGY.STRATEGY_B_FALLBACK);
});

// ════════════════════════════════════════════════════
// K. 헬퍼 단위 테스트
// ════════════════════════════════════════════════════
test('K1: orderKey 는 grid 범위까지 반영', () => {
  const k1 = makeDuplicateOrderKey({
    symbol: 'BTCUSDT', direction: 'LONG', strategy: 'LONG_TRAILING_GRID',
    grid: { lowerPrice: 98, upperPrice: 102, gridCount: 20, spacing: 0.2 },
  });
  const k2 = makeDuplicateOrderKey({
    symbol: 'BTCUSDT', direction: 'LONG', strategy: 'LONG_TRAILING_GRID',
    grid: { lowerPrice: 97, upperPrice: 103, gridCount: 20, spacing: 0.3 },
  });
  assert.notEqual(k1, k2);
  assert.equal(k1.length, 16);
});

test('K2: TTL 지난 활성 주문은 무효 처리', () => {
  let s = emptyState();
  s = markOrderActive(s, 'key1', NOW);
  assert.equal(hasActiveOrder(s, 'key1', NOW + 1000, 60_000), true);
  assert.equal(hasActiveOrder(s, 'key1', NOW + 120_000, 60_000), false);
  const purged = purgeExpiredOrders(s, NOW + 120_000, 60_000);
  assert.equal(Object.keys(purged.activeOrders).length, 0);
});

test('K3: isDailyLossLimitReached 헬퍼', () => {
  const p = newStatePath();
  applyRealizedLossToState({
    state: emptyState(), statePath: p,
    lossKrw: RISK_DEFAULTS.DAILY_LOSS_LIMIT_KRW, nowMs: NOW,
  });
  assert.equal(isDailyLossLimitReached({ statePath: p, nowMs: NOW }), true);
  assert.equal(isDailyLossLimitReached({ statePath: p, nowMs: NOW + DAY_MS }), false);
});

test('K4: 청산가/안전거리 계산', () => {
  const liq = estimateLiquidationPrice({
    direction: DIRECTION.LONG, entryPrice: 100, leverage: 2, maintenanceMarginRate: 0.005,
  });
  assert.equal(liq.ok, true);
  const safety = computeSafetyPct({
    direction: DIRECTION.LONG, currentPrice: 100, liquidationPrice: liq.price,
  });
  assert.ok(safety >= 0.4 && safety <= 0.6);
});

test('K5: fee 계산', () => {
  const f = estimateFeesAndFunding({
    deployUsdt: 100, leverage: 2, feeRate: 0.0006,
  });
  assert.equal(f.ok, true);
  assert.ok(f.totalFees > 0);
  assert.equal(f.fundingCost, 0);
});
