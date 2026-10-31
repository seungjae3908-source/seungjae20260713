// block19-strategy.test.mjs
// BLOCK 19 Step 2 — 전략 선택기 & 적응형 그리드 플래너 테스트
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  selectAIPlan,
  isFallbackRetained,
  allowsNewEntry as planAllowsNewEntry,
  STRATEGY,
  DIRECTION,
} from '../src/ai-strategy-selector.mjs';
import {
  planAdaptiveGrid,
  shouldRebalance,
  GRID_PLAN_DEFAULTS,
} from '../src/adaptive-grid-planner.mjs';
import { REGIME } from '../src/market-regime-classifier.mjs';

const NOW = 1_700_000_000_000;

function makeCandles(n = 50) {
  return Array.from({ length: n }, (_, i) => ({
    open: 100 + i * 0.1, high: 101 + i * 0.1,
    low: 99 + i * 0.1, close: 100.5 + i * 0.1, volume: 1000 + i * 10,
  }));
}

function baseInput(overrides = {}) {
  return {
    nowMs: NOW,
    lastUpdateMs: NOW - 1_000,
    candles: makeCandles(),
    atr: 0.5,
    adx: 15,
    rsi: 50,
    macdHistogram: 0,
    bbWidth: 0.02,
    vwap: 100,
    currentPrice: 100,
    ...overrides,
  };
}

// ════════════════════════════════════════════════════
// A. AI 전략 선택 (4 국면 + fail-closed)
// ════════════════════════════════════════════════════

test('A1: STRONG_UPTREND → LONG_TRAILING_GRID / LONG', () => {
  const p = selectAIPlan(baseInput({
    adx: 35, rsi: 60, macdHistogram: 0.5, vwap: 98, currentPrice: 100,
  }));
  assert.equal(p.ok, true);
  assert.equal(p.allowNewEntry, true);
  assert.equal(p.regime, REGIME.STRONG_UPTREND);
  assert.equal(p.strategy, STRATEGY.LONG_TRAILING_GRID);
  assert.equal(p.direction, DIRECTION.LONG);
});

test('A2: STRONG_DOWNTREND → SHORT_TRAILING_GRID / SHORT', () => {
  const p = selectAIPlan(baseInput({
    adx: 35, rsi: 35, macdHistogram: -0.5, vwap: 102, currentPrice: 100,
  }));
  assert.equal(p.ok, true);
  assert.equal(p.allowNewEntry, true);
  assert.equal(p.regime, REGIME.STRONG_DOWNTREND);
  assert.equal(p.strategy, STRATEGY.SHORT_TRAILING_GRID);
  assert.equal(p.direction, DIRECTION.SHORT);
});

test('A3: SIDEWAYS → NEUTRAL_GRID / NEUTRAL', () => {
  const p = selectAIPlan(baseInput({
    adx: 15, rsi: 50, macdHistogram: 0.01, vwap: 100, currentPrice: 100,
  }));
  assert.equal(p.ok, true);
  assert.equal(p.allowNewEntry, true);
  assert.equal(p.regime, REGIME.SIDEWAYS);
  assert.equal(p.strategy, STRATEGY.NEUTRAL_GRID);
  assert.equal(p.direction, DIRECTION.NEUTRAL);
});

test('A4: HIGH_VOLATILITY → NO_NEW_ENTRY (신규 진입 금지)', () => {
  const p = selectAIPlan(baseInput({
    adx: 35, rsi: 60, macdHistogram: 0.5, vwap: 98,
    bbWidth: 0.10, atr: 5,   // 둘 다 고변동
  }));
  assert.equal(p.ok, true);
  assert.equal(p.failClosed, false);
  assert.equal(p.allowNewEntry, false);
  assert.equal(p.regime, REGIME.HIGH_VOLATILITY);
  assert.equal(p.strategy, STRATEGY.NO_NEW_ENTRY);
  assert.equal(p.direction, DIRECTION.NONE);
});

test('A5: FAIL_CLOSED → SAFE_WAIT (failClosed=true)', () => {
  const p = selectAIPlan(baseInput({ lastUpdateMs: NOW - 10 * 60_000 }));
  assert.equal(p.ok, false);
  assert.equal(p.failClosed, true);
  assert.equal(p.allowNewEntry, false);
  assert.equal(p.strategy, STRATEGY.SAFE_WAIT);
  assert.equal(p.direction, DIRECTION.NONE);
});

// ════════════════════════════════════════════════════
// B. B fallback 유지 원칙
// ════════════════════════════════════════════════════

test('B1: B fallback 은 모든 정상 plan에 항상 유지된다', () => {
  const cases = [
    baseInput({ adx: 35, rsi: 60, macdHistogram: 0.5, vwap: 98, currentPrice: 100 }),
    baseInput({ adx: 35, rsi: 35, macdHistogram: -0.5, vwap: 102, currentPrice: 100 }),
    baseInput({ adx: 15, rsi: 50, macdHistogram: 0.01, vwap: 100, currentPrice: 100 }),
    baseInput({ bbWidth: 0.10, atr: 5, adx: 35, rsi: 60, macdHistogram: 0.5, vwap: 98 }),
  ];
  for (const input of cases) {
    const p = selectAIPlan(input);
    assert.equal(p.fallback, STRATEGY.STRATEGY_B_FALLBACK);
    assert.equal(isFallbackRetained(p), true);
  }
});

test('B2: FAIL_CLOSED 여도 B fallback 은 유지된다', () => {
  const p = selectAIPlan(baseInput({ lastUpdateMs: NOW - 10 * 60_000 }));
  assert.equal(p.fallback, STRATEGY.STRATEGY_B_FALLBACK);
});

test('B3: legacyStrategy 는 래핑되어 캡처된다 (에러 없이)', () => {
  const p = selectAIPlan(baseInput({
    adx: 35, rsi: 60, macdHistogram: 0.5, vwap: 98, currentPrice: 100,
  }));
  assert.equal(p.legacyError, null);
  assert.notEqual(p.legacyStrategy, undefined, 'legacyStrategy 필드는 항상 존재해야 함');
});

test('B4: legacy 입력 누락 시 legacyStrategy=null, legacyError=null', () => {
  const input = baseInput({ adx: 15, rsi: 50, macdHistogram: 0.01, vwap: 100 });
  delete input.macdHistogram;
  const p = selectAIPlan(input);
  // regime 분류가 FAIL_CLOSED 될 수도 있으므로 필드 존재만 확인
  assert.equal(p.legacyStrategy, null);
  assert.equal(p.legacyError, null);
});

test('B5: allowsNewEntry 헬퍼는 FAIL_CLOSED/HIGH_VOL 에 false', () => {
  assert.equal(
    planAllowsNewEntry(selectAIPlan(baseInput({ lastUpdateMs: NOW - 10 * 60_000 }))),
    false,
  );
  assert.equal(
    planAllowsNewEntry(selectAIPlan(baseInput({
      bbWidth: 0.10, atr: 5, adx: 35, rsi: 60, macdHistogram: 0.5, vwap: 98,
    }))),
    false,
  );
});

// ════════════════════════════════════════════════════
// C. ATR 그리드 범위
// ════════════════════════════════════════════════════

function validUpInput(extra = {}) {
  return {
    currentPrice: 100,
    atr: 0.5,
    availableCapitalKrw: 500_000,
    exchangeRateKrw: 1350,
    nowMs: NOW,
    regimeInput: {
      nowMs: NOW,
      lastUpdateMs: NOW - 1_000,
      candles: makeCandles(),
      adx: 35, rsi: 60, macdHistogram: 0.5, vwap: 98,
      bbWidth: 0.02,
      currentPrice: 100,
      atr: 0.5,
    },
    ...extra,
  };
}

test('C1: 정상 상승장 plan 은 lower < mid < upper', () => {
  const p = planAdaptiveGrid(validUpInput());
  assert.equal(p.ok, true);
  assert.equal(p.allowNewEntry, true);
  assert.ok(p.grid.lowerPrice < 100);
  assert.ok(p.grid.upperPrice > 100);
  assert.ok(p.grid.lowerPrice < p.grid.upperPrice);
});

test('C2: gridCount 는 [MIN, MAX] 범위', () => {
  const p = planAdaptiveGrid(validUpInput());
  assert.ok(p.grid.gridCount >= GRID_PLAN_DEFAULTS.MIN_GRID_COUNT);
  assert.ok(p.grid.gridCount <= GRID_PLAN_DEFAULTS.MAX_GRID_COUNT);
});

test('C3: spacing > 0 이고 최소 간격 이상', () => {
  const p = planAdaptiveGrid(validUpInput());
  const minSpacing = 100 * 0.0006; // currentPrice * feeRate
  assert.ok(p.grid.spacing > 0);
  assert.ok(p.grid.spacing >= minSpacing);
});

test('C4: ATR 이 커지면 bounds 폭이 넓어진다', () => {
  const small = planAdaptiveGrid(validUpInput({ atr: 0.2 }));
  const large = planAdaptiveGrid(validUpInput({ atr: 1.0 }));
  const smallWidth = small.grid.upperPrice - small.grid.lowerPrice;
  const largeWidth = large.grid.upperPrice - large.grid.lowerPrice;
  assert.ok(largeWidth > smallWidth, `large=${largeWidth} small=${smallWidth}`);
});

// ════════════════════════════════════════════════════
// D. 레버리지
// ════════════════════════════════════════════════════

test('D1: 레버리지는 1 이상 10 이하', () => {
  const p = planAdaptiveGrid(validUpInput());
  assert.ok(p.leverage >= 1);
  assert.ok(p.leverage <= 10);
});

test('D2: 자동 결정 레버리지는 HEURISTIC_MAX_LEVERAGE 이하, 10배 아님', () => {
  const p = planAdaptiveGrid(validUpInput());
  assert.equal(p.leverageSource, 'AUTO');
  assert.ok(p.leverage <= GRID_PLAN_DEFAULTS.HEURISTIC_MAX_LEVERAGE);
  assert.notEqual(p.leverage, 10);
});

test('D3: leverageOverride 15 → 10 으로 클램프', () => {
  const p = planAdaptiveGrid(validUpInput({ leverageOverride: 15 }));
  assert.equal(p.leverage, 10);
  assert.equal(p.leverageSource, 'OVERRIDE');
});

test('D4: leverageOverride 0 → 1 로 클램프', () => {
  const p = planAdaptiveGrid(validUpInput({ leverageOverride: 0 }));
  assert.equal(p.leverage, 1);
});

test('D5: NEUTRAL_GRID 는 레버리지 2 이하', () => {
  const p = planAdaptiveGrid({
    ...validUpInput(),
    regimeInput: {
      ...validUpInput().regimeInput,
      adx: 15, rsi: 50, macdHistogram: 0.01,
      bbWidth: 0.01,
    },
  });
  assert.equal(p.strategy, STRATEGY.NEUTRAL_GRID);
  assert.ok(p.leverage <= 2);
});

// ════════════════════════════════════════════════════
// E. 자금 관리 (500K 한도 / 예비금)
// ════════════════════════════════════════════════════

test('E1: 자금이 충분해도 deployKrw + reserveKrw <= HARD_CAP', () => {
  const p = planAdaptiveGrid(validUpInput({ availableCapitalKrw: 1_000_000 }));
  assert.ok(p.capital.maxDeployKrw <= GRID_PLAN_DEFAULTS.HARD_CAP_KRW);
  assert.equal(
    p.capital.deployKrw + p.capital.reserveKrw,
    p.capital.maxDeployKrw,
  );
});

test('E2: deployKrw 는 MAX_DEPLOY_FRACTION 이하 (전액 투입 금지)', () => {
  const p = planAdaptiveGrid(validUpInput({ availableCapitalKrw: 500_000 }));
  assert.ok(
    p.capital.deployKrw <= p.capital.maxDeployKrw * GRID_PLAN_DEFAULTS.MAX_DEPLOY_FRACTION,
  );
});

test('E3: reserveKrw 는 30% 이상', () => {
  const p = planAdaptiveGrid(validUpInput({ availableCapitalKrw: 500_000 }));
  const reserveRatio = p.capital.reserveKrw / p.capital.maxDeployKrw;
  assert.ok(reserveRatio >= GRID_PLAN_DEFAULTS.MIN_RESERVE_FRACTION - 1e-9);
});

test('E4: HARD_CAP 초과 자금은 자동으로 500,000 으로 제한', () => {
  const p = planAdaptiveGrid(validUpInput({ availableCapitalKrw: 10_000_000 }));
  assert.equal(p.capital.maxDeployKrw, GRID_PLAN_DEFAULTS.HARD_CAP_KRW);
});

// ════════════════════════════════════════════════════
// F. 비정상 입력
// ════════════════════════════════════════════════════

test('F1: currentPrice=0 → INVALID_CURRENT_PRICE', () => {
  const p = planAdaptiveGrid(validUpInput({ currentPrice: 0 }));
  assert.equal(p.ok, false);
  assert.ok(p.reasons.includes('INVALID_CURRENT_PRICE'));
});

test('F2: atr 음수 → INVALID_ATR', () => {
  const p = planAdaptiveGrid(validUpInput({ atr: -0.1 }));
  assert.equal(p.ok, false);
  assert.ok(p.reasons.includes('INVALID_ATR'));
});

test('F3: atr NaN → INVALID_ATR', () => {
  const p = planAdaptiveGrid(validUpInput({ atr: NaN }));
  assert.equal(p.ok, false);
  assert.ok(p.reasons.includes('INVALID_ATR'));
});

test('F4: availableCapitalKrw=0 → INVALID_CAPITAL', () => {
  const p = planAdaptiveGrid(validUpInput({ availableCapitalKrw: 0 }));
  assert.equal(p.ok, false);
  assert.ok(p.reasons.includes('INVALID_CAPITAL'));
});

test('F5: exchangeRateKrw=0 → INVALID_FX', () => {
  const p = planAdaptiveGrid(validUpInput({ exchangeRateKrw: 0 }));
  assert.equal(p.ok, false);
  assert.ok(p.reasons.includes('INVALID_FX'));
});

test('F6: atr=0 → bounds 무효로 fail-closed', () => {
  const p = planAdaptiveGrid(validUpInput({ atr: 0 }));
  assert.equal(p.ok, false);
  assert.ok(
    p.reasons.includes('BOUNDS_INVALID') ||
    p.reasons.includes('SPACING_TOO_TIGHT'),
    `reason=${JSON.stringify(p.reasons)}`,
  );
});

// ════════════════════════════════════════════════════
// G. 재조정 조건
// ════════════════════════════════════════════════════

test('G1: 국면 변화 시 즉시 재조정', () => {
  const cur = planAdaptiveGrid(validUpInput());
  const next = planAdaptiveGrid({
    ...validUpInput(),
    nowMs: NOW + 100,
    regimeInput: {
      ...validUpInput().regimeInput,
      adx: 35, rsi: 35, macdHistogram: -0.5, vwap: 102,
    },
  });
  const r = shouldRebalance(cur, next, { nowMs: NOW + 100 });
  assert.equal(r.rebalance, true);
  assert.ok(r.reasons.includes('REGIME_CHANGED'));
});

test('G2: 국면 변화 없고 시간 간격 부족 → rate-limited', () => {
  const cur = planAdaptiveGrid(validUpInput());
  const next = planAdaptiveGrid({
    ...validUpInput(),
    currentPrice: 100.5, // 작은 변동
    nowMs: NOW + 100,
    regimeInput: {
      ...validUpInput().regimeInput,
      currentPrice: 100.5, vwap: 98,
    },
  });
  const r = shouldRebalance(cur, next, { nowMs: NOW + 100 });
  assert.equal(r.rebalance, false);
  assert.ok(r.reasons.includes('RATE_LIMITED'));
});

test('G3: 큰 가격 드리프트 + 충분한 시간 경과 → 재조정', () => {
  const cur = planAdaptiveGrid(validUpInput());
  const futureMs = NOW + GRID_PLAN_DEFAULTS.MIN_REBALANCE_INTERVAL_MS + 1_000;
  const next = planAdaptiveGrid({
    ...validUpInput(),
    currentPrice: 105,
    nowMs: futureMs,
    regimeInput: {
      ...validUpInput().regimeInput,
      currentPrice: 105,
      nowMs: futureMs,
      lastUpdateMs: futureMs - 1_000,
    },
  });
  const r = shouldRebalance(cur, next, { nowMs: futureMs });
  assert.equal(r.rebalance, true);
  assert.ok(r.reasons.some((x) => x.startsWith('PRICE_DRIFT=')));
});

test('G4: NO_LAST_PLAN 이면 재조정 없음', () => {
  const r = shouldRebalance(null, null, { nowMs: NOW });
  assert.equal(r.rebalance, false);
  assert.ok(r.reasons.includes('NO_CURRENT_PLAN'));
});

// ════════════════════════════════════════════════════
// H. 기존 전략 로직 호환성
// ════════════════════════════════════════════════════

test('H1: 기존 selectStrategy 래핑이 예외 없이 실행된다', () => {
  const p = selectAIPlan(baseInput({
    adx: 35, rsi: 60, macdHistogram: 0.5, vwap: 98, currentPrice: 100,
  }));
  assert.equal(p.legacyError, null);
});

test('H2: AI plan 은 legacy 결과와 독립적으로 확정된다', () => {
  const p = selectAIPlan(baseInput({
    adx: 35, rsi: 60, macdHistogram: 0.5, vwap: 98, currentPrice: 100,
  }));
  // AI 판단이 확정되어 있고, fallback 도 유지되어 있어야 함
  assert.equal(p.strategy, STRATEGY.LONG_TRAILING_GRID);
  assert.equal(p.fallback, STRATEGY.STRATEGY_B_FALLBACK);
  // legacyStrategy 값은 존재 여부만 확인 (내용은 기존 함수 결정)
  assert.notEqual(p.legacyStrategy, undefined);
});
