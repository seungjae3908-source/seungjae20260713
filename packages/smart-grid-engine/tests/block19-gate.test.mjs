// block19-gate.test.mjs
// BLOCK 19 Step 4 — LIVE 차단 게이트 & Paper 실행 어댑터 테스트
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  LIVE_GATE_DEFAULTS,
  SAFE_LIVE_ENV,
  evaluateLiveGate,
  evaluateSafetyFlags,
  evaluateExecutionAuthority,
  evaluateApprovalToken,
} from '../src/live-order-gate.mjs';
import {
  PAPER_DEFAULTS,
  createPaperState,
  submitPaperOrder,
  applyFundingToOpenPositions,
  closePaperPosition,
  markPaperToMarket,
  paperSaveState,
  paperLoadState,
  paperLoadStateSafe,
  paperOrderKey,
} from '../src/paper-execution-adapter.mjs';
import { STRATEGY, DIRECTION } from '../src/ai-strategy-selector.mjs';

const NOW = 1_700_000_000_000;
const TOKEN = 'CONFIRM_THIS_IS_A_LIVE_TRADE_ACTION'; // 32자

function newTmpPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'b19g-')), 'paper.json');
}

function fullApprovedEnv() {
  return {
    LIVE_TRADING: true,
    AUTO_TRADING: true,
    REAL_ORDER_ENABLED: true,
    PRIVATE_TRADING_API_ALLOWED: true,
    EXECUTION_AUTHORITY: LIVE_GATE_DEFAULTS.REQUIRED_EXECUTION_AUTHORITY,
  };
}

function goodPlan() {
  return {
    ok: true,
    failClosed: false,
    allowNewEntry: true,
    direction: DIRECTION.LONG,
    strategy: STRATEGY.LONG_TRAILING_GRID,
    regime: 'STRONG_UPTREND',
    fallback: STRATEGY.STRATEGY_B_FALLBACK,
    grid: { lowerPrice: 98.5, upperPrice: 101.5, gridCount: 20, spacing: 0.158 },
    capital: { maxDeployKrw: 500_000, deployKrw: 150_000, reserveKrw: 350_000, deployUsdt: 111.11, exchangeRateKrw: 1350 },
    leverage: 2,
    leverageSource: 'AUTO',
    currentPrice: 100,
    decidedAtMs: NOW,
  };
}

function goodRisk() {
  return { ok: true, failClosed: false, allowNewEntry: true, orderKey: 'abc1234567890def' };
}

function goodMarketData() {
  return { lastUpdateMs: NOW - 1_000, nowMs: NOW };
}

function goodAccountData() {
  return {
    lastAccountSyncMs: NOW - 5_000,
    expected: { usdtBalance: 500, openPositionCount: 0 },
    observed: { usdtBalance: 500, openPositionCount: 0 },
  };
}

function baseArgs(overrides = {}) {
  return {
    plan: goodPlan(),
    riskEvaluation: goodRisk(),
    env: fullApprovedEnv(),
    explicitApprovalToken: TOKEN,
    expectedApprovalToken: TOKEN,
    marketData: goodMarketData(),
    accountData: goodAccountData(),
    quantity: 1,
    minQuantity: 0.0001,
    maxQuantity: 1000,
    maxNotionalUsdt: 500,
    nowMs: NOW,
    ...overrides,
  };
}

// ════════════════════════════════════════════════════
// A. LIVE 절대 실행 금지 (모든 경우)
// ════════════════════════════════════════════════════

test('A1: 정상 승인 경로에서도 allowed=false, wouldExecute=false, realApiCalled=false', () => {
  const r = evaluateLiveGate(baseArgs());
  assert.equal(r.allowed, false);
  assert.equal(r.wouldExecute, false);
  assert.equal(r.realApiCalled, false);
  assert.equal(r.candidateEligible, true, '모든 안전 검사는 통과해야 함');
});

test('A2: 안전 기본값(SAFE_LIVE_ENV)은 즉시 차단', () => {
  const r = evaluateLiveGate(baseArgs({ env: SAFE_LIVE_ENV }));
  assert.equal(r.allowed, false);
  assert.equal(r.candidateEligible, false);
});

test('A3: env={} (완전 빈 env) 도 차단', () => {
  const r = evaluateLiveGate(baseArgs({ env: {} }));
  assert.equal(r.allowed, false);
  assert.equal(r.candidateEligible, false);
});

test('A4: 100회 반복해도 realApiCalled=false 유지', () => {
  for (let i = 0; i < 100; i++) {
    const r = evaluateLiveGate(baseArgs({ env: i % 2 ? {} : fullApprovedEnv() }));
    assert.equal(r.realApiCalled, false);
    assert.equal(r.wouldExecute, false);
    assert.equal(r.allowed, false);
  }
});

// ════════════════════════════════════════════════════
// B. 승인 토큰 누락
// ════════════════════════════════════════════════════

test('B1: explicitApprovalToken=null → 차단', () => {
  const r = evaluateLiveGate(baseArgs({ explicitApprovalToken: null }));
  assert.equal(r.candidateEligible, false);
  assert.ok(r.reasons.some((x) => x.includes('TOKEN')));
});

test('B2: expectedApprovalToken 이 너무 짧음 → 차단', () => {
  const r = evaluateLiveGate(baseArgs({ expectedApprovalToken: 'short' }));
  assert.equal(r.candidateEligible, false);
  assert.ok(r.reasons.includes('EXPECTED_TOKEN_MISSING_OR_TOO_SHORT'));
});

test('B3: 토큰 mismatch → 차단', () => {
  const r = evaluateLiveGate(baseArgs({ explicitApprovalToken: TOKEN + 'X' }));
  assert.equal(r.candidateEligible, false);
  assert.ok(r.reasons.includes('TOKEN_MISMATCH'));
});

test('B4: 평가 유틸 직접 검증', () => {
  assert.equal(evaluateApprovalToken(TOKEN, TOKEN).pass, true);
  assert.equal(evaluateApprovalToken(null, TOKEN).pass, false);
  assert.equal(evaluateApprovalToken('', TOKEN).pass, false);
  assert.equal(evaluateApprovalToken(TOKEN, null).pass, false);
});

// ════════════════════════════════════════════════════
// C. executionAuthority
// ════════════════════════════════════════════════════

test('C1: EXECUTION_AUTHORITY=NONE → 차단', () => {
  const r = evaluateLiveGate(baseArgs({
    env: { ...fullApprovedEnv(), EXECUTION_AUTHORITY: 'NONE' },
  }));
  assert.equal(r.candidateEligible, false);
  assert.ok(r.reasons.includes('EXECUTION_AUTHORITY_NONE'));
});

test('C2: EXECUTION_AUTHORITY 누락 → 차단', () => {
  const env = { ...fullApprovedEnv() };
  delete env.EXECUTION_AUTHORITY;
  const r = evaluateLiveGate(baseArgs({ env }));
  assert.equal(r.candidateEligible, false);
  assert.ok(r.reasons.includes('EXECUTION_AUTHORITY_NONE'));
});

test('C3: 잘못된 EXECUTION_AUTHORITY 문자열 → 차단', () => {
  const r = evaluateLiveGate(baseArgs({
    env: { ...fullApprovedEnv(), EXECUTION_AUTHORITY: 'SOMETHING_ELSE' },
  }));
  assert.equal(r.candidateEligible, false);
  assert.ok(r.reasons.some((x) => x.startsWith('EXECUTION_AUTHORITY_INVALID')));
});

test('C4: authority 유틸 직접 검증', () => {
  assert.equal(evaluateExecutionAuthority({ EXECUTION_AUTHORITY: 'EXPLICIT_LIVE' }).pass, true);
  assert.equal(evaluateExecutionAuthority({ EXECUTION_AUTHORITY: 'NONE' }).pass, false);
  assert.equal(evaluateExecutionAuthority({}).pass, false);
});

// ════════════════════════════════════════════════════
// D. 각 안전 플래그 OFF → 차단
// ════════════════════════════════════════════════════

for (const flag of LIVE_GATE_DEFAULTS.REQUIRED_FLAGS_TRUE) {
  test(`D: ${flag}=false → 차단`, () => {
    const env = { ...fullApprovedEnv(), [flag]: false };
    const r = evaluateLiveGate(baseArgs({ env }));
    assert.equal(r.candidateEligible, false);
    assert.ok(r.reasons.includes(`FLAG_OFF:${flag}`));
  });
}

test('D5: flags 유틸은 4개 모두 true 일 때만 pass', () => {
  assert.equal(evaluateSafetyFlags(fullApprovedEnv()).pass, true);
  assert.equal(evaluateSafetyFlags({}).pass, false);
  assert.equal(evaluateSafetyFlags({ LIVE_TRADING: true }).pass, false);
});

// ════════════════════════════════════════════════════
// E. 위험관리 실패 → 차단
// ════════════════════════════════════════════════════

test('E1: riskEvaluation 누락 → 차단', () => {
  const r = evaluateLiveGate(baseArgs({ riskEvaluation: null }));
  assert.equal(r.candidateEligible, false);
  assert.ok(r.reasons.includes('RISK_EVAL_MISSING'));
});

test('E2: riskEvaluation.ok=false → 차단', () => {
  const r = evaluateLiveGate(baseArgs({ riskEvaluation: { ok: false } }));
  assert.equal(r.candidateEligible, false);
  assert.ok(r.reasons.includes('RISK_EVAL_NOT_OK'));
});

test('E3: riskEvaluation.failClosed=true → 차단', () => {
  const r = evaluateLiveGate(baseArgs({
    riskEvaluation: { ok: true, allowNewEntry: true, failClosed: true, orderKey: 'x' },
  }));
  assert.equal(r.candidateEligible, false);
  assert.ok(r.reasons.includes('RISK_EVAL_FAIL_CLOSED'));
});

test('E4: riskEvaluation.allowNewEntry=false → 차단', () => {
  const r = evaluateLiveGate(baseArgs({
    riskEvaluation: { ok: true, allowNewEntry: false, orderKey: 'x' },
  }));
  assert.equal(r.candidateEligible, false);
  assert.ok(r.reasons.includes('RISK_EVAL_NO_ENTRY'));
});

// ════════════════════════════════════════════════════
// F. 오래된 데이터 → 차단
// ════════════════════════════════════════════════════

test('F1: marketData 오래됨 → 차단', () => {
  const r = evaluateLiveGate(baseArgs({
    marketData: { lastUpdateMs: NOW - 10 * 60_000, nowMs: NOW },
  }));
  assert.equal(r.candidateEligible, false);
  assert.ok(r.reasons.some((x) => x.startsWith('MARKET_DATA_STALE')));
});

test('F2: accountData 오래됨 → 차단', () => {
  const r = evaluateLiveGate(baseArgs({
    accountData: { ...goodAccountData(), lastAccountSyncMs: NOW - 30 * 60_000 },
  }));
  assert.equal(r.candidateEligible, false);
  assert.ok(r.reasons.some((x) => x.startsWith('ACCOUNT_STALE')));
});

test('F3: marketData.lastUpdateMs 누락 → 차단', () => {
  const r = evaluateLiveGate(baseArgs({ marketData: {} }));
  assert.equal(r.candidateEligible, false);
  assert.ok(r.reasons.includes('MARKET_DATA_TS_UNKNOWN'));
});

test('F4: 미래 시각(clock skew) → 차단', () => {
  const r = evaluateLiveGate(baseArgs({
    marketData: { lastUpdateMs: NOW + 60_000, nowMs: NOW },
  }));
  assert.equal(r.candidateEligible, false);
  assert.ok(r.reasons.includes('MARKET_DATA_CLOCK_SKEW'));
});

// ════════════════════════════════════════════════════
// G. 계좌 상태 불일치 → 차단
// ════════════════════════════════════════════════════

test('G1: 잔고 mismatch (10% 차이) → 차단', () => {
  const r = evaluateLiveGate(baseArgs({
    accountData: {
      ...goodAccountData(),
      expected: { usdtBalance: 500, openPositionCount: 0 },
      observed: { usdtBalance: 550, openPositionCount: 0 },
    },
  }));
  assert.equal(r.candidateEligible, false);
  assert.ok(r.reasons.some((x) => x.startsWith('ACCOUNT_BALANCE_MISMATCH')));
});

test('G2: 포지션 개수 mismatch → 차단', () => {
  const r = evaluateLiveGate(baseArgs({
    accountData: {
      ...goodAccountData(),
      expected: { usdtBalance: 500, openPositionCount: 0 },
      observed: { usdtBalance: 500, openPositionCount: 1 },
    },
  }));
  assert.equal(r.candidateEligible, false);
  assert.ok(r.reasons.some((x) => x.startsWith('POSITION_COUNT_MISMATCH')));
});

test('G3: 계좌 데이터 없음 → 차단', () => {
  const r = evaluateLiveGate(baseArgs({
    accountData: { lastAccountSyncMs: NOW - 1_000, expected: null, observed: null },
  }));
  assert.equal(r.candidateEligible, false);
  assert.ok(r.reasons.includes('ACCOUNT_DATA_MISSING'));
});

// ════════════════════════════════════════════════════
// H. 크기/자금 한도 위반 → 차단
// ════════════════════════════════════════════════════

test('H1: quantity <= 0 → 차단', () => {
  const r = evaluateLiveGate(baseArgs({ quantity: 0 }));
  assert.equal(r.candidateEligible, false);
  assert.ok(r.reasons.includes('QUANTITY_INVALID'));
});

test('H2: quantity < min → 차단', () => {
  const r = evaluateLiveGate(baseArgs({ quantity: 0.00001, minQuantity: 0.01 }));
  assert.equal(r.candidateEligible, false);
  assert.ok(r.reasons.some((x) => x.startsWith('QUANTITY_BELOW_MIN')));
});

test('H3: notional > maxNotionalUsdt → 차단', () => {
  const r = evaluateLiveGate(baseArgs({ quantity: 100, maxNotionalUsdt: 100 }));
  assert.equal(r.candidateEligible, false);
  assert.ok(r.reasons.some((x) => x.startsWith('NOTIONAL_EXCEEDS_MAX')));
});

// ════════════════════════════════════════════════════
// I. 재시작 후에도 LIVE 차단 유지
// ════════════════════════════════════════════════════

test('I1: 프로세스 재시작 시뮬레이션 후에도 gate 는 여전히 차단', () => {
  // 이 모듈은 stateless 이므로 "재시작" 후에도 상태 없음 → 기본 차단.
  // 복원된 상태로 검사해도 candidateEligible=false 여야 함.
  const restored = { anyRestoredState: true };
  const r = evaluateLiveGate(baseArgs({ env: SAFE_LIVE_ENV, _restored: restored }));
  assert.equal(r.allowed, false);
  assert.equal(r.candidateEligible, false);
});

test('I2: 100번 반복해도 allowed=true 반환 안됨', () => {
  for (let i = 0; i < 100; i++) {
    const r = evaluateLiveGate(baseArgs());
    assert.equal(r.allowed, false);
  }
});

// ════════════════════════════════════════════════════
// J. Paper 실행 — 가상 체결
// ════════════════════════════════════════════════════

test('J1: Paper 계좌 생성 — 초기 잔고', () => {
  const s = createPaperState({ initialUsdt: 1000, nowMs: NOW });
  assert.equal(s.usdtBalance, 1000);
  assert.equal(s.initialUsdt, 1000);
  assert.equal(s.version, 1);
});

test('J2: Paper 주문 제출 → 가상 체결 + 잔고/포지션 갱신', () => {
  const s0 = createPaperState({ initialUsdt: 1000, nowMs: NOW });
  const r = submitPaperOrder({
    state: s0,
    symbol: 'BTCUSDT',
    direction: DIRECTION.LONG,
    strategy: STRATEGY.LONG_TRAILING_GRID,
    quantity: 0.1,
    price: 100,
    leverage: 2,
    nowMs: NOW,
  });
  assert.equal(r.ok, true);
  assert.equal(r.realApiCalled, false);
  assert.ok(r.fill.price > 100, 'slippage 로 LONG 은 체결가가 높아야 함');
  assert.equal(r.state.positions.BTCUSDT.status, 'OPEN');
  assert.ok(r.state.fills.length === 1);
  assert.ok(r.state.usdtBalance < 1000);
});

test('J3: 가격 <= 0 → 체결 거부', () => {
  const s = createPaperState({ initialUsdt: 1000, nowMs: NOW });
  const r = submitPaperOrder({
    state: s, symbol: 'BTCUSDT', direction: DIRECTION.LONG,
    quantity: 0.1, price: 0, leverage: 2, nowMs: NOW,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'PRICE_INVALID');
});

test('J4: 수량 < MIN → 체결 거부', () => {
  const s = createPaperState({ initialUsdt: 1000, nowMs: NOW });
  const r = submitPaperOrder({
    state: s, symbol: 'BTCUSDT', direction: DIRECTION.LONG,
    quantity: 0.00001, price: 100, leverage: 2, nowMs: NOW,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'QUANTITY_INVALID');
});

test('J5: 잔고 부족 → 체결 거부 (임의 체결 금지)', () => {
  const s = createPaperState({ initialUsdt: 1, nowMs: NOW });
  const r = submitPaperOrder({
    state: s, symbol: 'BTCUSDT', direction: DIRECTION.LONG,
    quantity: 1, price: 100, leverage: 1, nowMs: NOW,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'INSUFFICIENT_PAPER_BALANCE');
});

test('J6: 동일 심볼에 이미 포지션 존재 시 재진입 거부', () => {
  const s0 = createPaperState({ initialUsdt: 1000, nowMs: NOW });
  const r1 = submitPaperOrder({
    state: s0, symbol: 'BTCUSDT', direction: DIRECTION.LONG,
    quantity: 0.1, price: 100, leverage: 2, nowMs: NOW,
  });
  assert.equal(r1.ok, true);
  const r2 = submitPaperOrder({
    state: r1.state, symbol: 'BTCUSDT', direction: DIRECTION.SHORT,
    quantity: 0.1, price: 100, leverage: 2, nowMs: NOW + 100,
  });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'POSITION_EXISTS');
});

// ════════════════════════════════════════════════════
// K. Paper 수수료 / 펀딩비
// ════════════════════════════════════════════════════

test('K1: 진입 시 수수료가 잔고에서 차감된다', () => {
  const s0 = createPaperState({ initialUsdt: 1000, nowMs: NOW });
  const r = submitPaperOrder({
    state: s0, symbol: 'BTCUSDT', direction: DIRECTION.LONG,
    quantity: 0.1, price: 100, leverage: 2, feeRate: 0.001, nowMs: NOW,
  });
  assert.equal(r.ok, true);
  assert.ok(r.fill.fee > 0);
  assert.ok(r.state.feesPaid > 0);
});

test('K2: 펀딩비가 반영된다', () => {
  const s0 = createPaperState({ initialUsdt: 1000, nowMs: NOW });
  const r1 = submitPaperOrder({
    state: s0, symbol: 'BTCUSDT', direction: DIRECTION.LONG,
    quantity: 0.1, price: 100, leverage: 2, nowMs: NOW,
  });
  const balBefore = r1.state.usdtBalance;
  const r2 = applyFundingToOpenPositions({
    state: r1.state,
    fundingRates: { BTCUSDT: 0.0005 },
    nowMs: NOW + 3600_000,
  });
  assert.equal(r2.ok, true);
  assert.ok(r2.fundingTotal > 0);
  assert.ok(r2.state.usdtBalance < balBefore);
  assert.ok(r2.state.positions.BTCUSDT.fundingPaid > 0);
});

test('K3: fundingRate=0 이면 펀딩비 0', () => {
  const s0 = createPaperState({ initialUsdt: 1000, nowMs: NOW });
  const r1 = submitPaperOrder({
    state: s0, symbol: 'BTCUSDT', direction: DIRECTION.LONG,
    quantity: 0.1, price: 100, leverage: 2, nowMs: NOW,
  });
  const r2 = applyFundingToOpenPositions({
    state: r1.state, fundingRates: { BTCUSDT: 0 }, nowMs: NOW + 1000,
  });
  assert.equal(r2.fundingTotal, 0);
});

test('K4: 청산 시 realized PnL 과 수수료 반영', () => {
  const s0 = createPaperState({ initialUsdt: 1000, nowMs: NOW });
  const r1 = submitPaperOrder({
    state: s0, symbol: 'BTCUSDT', direction: DIRECTION.LONG,
    quantity: 0.1, price: 100, leverage: 2, nowMs: NOW,
  });
  const r2 = closePaperPosition({
    state: r1.state, symbol: 'BTCUSDT', price: 110,
    feeRate: 0.0006, nowMs: NOW + 1000,
  });
  assert.equal(r2.ok, true);
  assert.ok(r2.pnl > 0);
  assert.ok(r2.exitFee > 0);
  assert.equal(r2.state.positions.BTCUSDT.status, 'CLOSED');
});

// ════════════════════════════════════════════════════
// L. Paper 상태 저장/복구
// ════════════════════════════════════════════════════

test('L1: 저장 후 재로드 시 잔고/포지션 유지', () => {
  const p = newTmpPath();
  const s0 = createPaperState({ initialUsdt: 1000, nowMs: NOW });
  const r = submitPaperOrder({
    state: s0, symbol: 'BTCUSDT', direction: DIRECTION.LONG,
    quantity: 0.1, price: 100, leverage: 2, nowMs: NOW,
  });
  paperSaveState({ statePath: p, state: r.state });
  const loaded = paperLoadState({ statePath: p });
  assert.equal(loaded.usdtBalance, r.state.usdtBalance);
  assert.ok(loaded.positions.BTCUSDT);
  assert.equal(loaded.positions.BTCUSDT.status, 'OPEN');
});

test('L2: 손상된 state → 격리 후 빈 상태로 복구 (원본 보존)', () => {
  const p = newTmpPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '{corrupted-json', 'utf8');
  const loaded = paperLoadState({ statePath: p, initialUsdt: 500 });
  assert.equal(loaded.usdtBalance, 500);
  assert.deepEqual(loaded.positions, {});
  const files = fs.readdirSync(path.dirname(p));
  assert.ok(files.some(f => f.includes('.corrupt.')),
    `격리 파일 없음: ${files.join(',')}`);
  assert.equal(fs.existsSync(p), false, '원본 경로는 rename 됨');
});

test('L3: 저장 실패가 실행 흐름을 막지 않는다 (안전한 재시도 가능)', () => {
  // 부모가 "파일"인 경로 → mkdirSync 가 ENOTDIR 로 실패해야 함.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'b19g-l3-'));
  const blockerFile = path.join(tmpRoot, 'blocker');
  fs.writeFileSync(blockerFile, 'x', 'utf8');
  const impossiblePath = path.join(blockerFile, 'state.json'); // 부모가 파일

  const result = paperSaveState({ statePath: impossiblePath, state: createPaperState() });
  assert.equal(result.saved, false, '저장 실패 시 saved:false 여야 함');
  // 예외로 throw 되지 않아야 함 (테스트 통과 자체가 그것을 증명)
});

// ════════════════════════════════════════════════════
// M. mark-to-market / 유틸
// ════════════════════════════════════════════════════

test('M1: mark to market — unrealized 계산', () => {
  const s0 = createPaperState({ initialUsdt: 1000, nowMs: NOW });
  const r1 = submitPaperOrder({
    state: s0, symbol: 'BTCUSDT', direction: DIRECTION.LONG,
    quantity: 0.1, price: 100, leverage: 2, nowMs: NOW,
  });
  const mtm = markPaperToMarket({
    state: r1.state, prices: { BTCUSDT: 110 },
  });
  assert.equal(mtm.ok, true);
  assert.ok(mtm.unrealizedPnl > 0);
});

test('M2: paperOrderKey 는 그리드/심볼/방향/전략을 반영', () => {
  const k1 = paperOrderKey({
    symbol: 'BTCUSDT', direction: DIRECTION.LONG, strategy: STRATEGY.LONG_TRAILING_GRID,
    grid: { lowerPrice: 98, upperPrice: 102, gridCount: 20 },
  });
  const k2 = paperOrderKey({
    symbol: 'ETHUSDT', direction: DIRECTION.LONG, strategy: STRATEGY.LONG_TRAILING_GRID,
    grid: { lowerPrice: 98, upperPrice: 102, gridCount: 20 },
  });
  assert.notEqual(k1, k2);
  assert.equal(k1.length, 16);
});

// ════════════════════════════════════════════════════
// N. 실제 주문 API 호출 0건 증거
// ════════════════════════════════════════════════════

test('N1: 모든 gate 결과가 realApiCalled=false / wouldExecute=false', () => {
  const scenarios = [
    baseArgs(),
    baseArgs({ env: {} }),
    baseArgs({ env: SAFE_LIVE_ENV }),
    baseArgs({ plan: null }),
    baseArgs({ riskEvaluation: null }),
    baseArgs({ quantity: -1 }),
  ];
  for (const args of scenarios) {
    const r = evaluateLiveGate(args);
    assert.equal(r.realApiCalled, false);
    assert.equal(r.wouldExecute, false);
    assert.equal(r.allowed, false);
  }
});

test('N2: 모든 paper 결과가 realApiCalled=false', () => {
  const s0 = createPaperState({ nowMs: NOW });
  const results = [
    submitPaperOrder({ state: s0, symbol: 'X', direction: DIRECTION.LONG, quantity: 0.1, price: 100, nowMs: NOW }),
    submitPaperOrder({ state: s0, symbol: 'Y', direction: DIRECTION.LONG, quantity: 0.00001, price: 100, nowMs: NOW }),
    applyFundingToOpenPositions({ state: s0, fundingRates: { Z: 0.001 }, nowMs: NOW }),
    closePaperPosition({ state: s0, symbol: 'NON', price: 100, nowMs: NOW }),
    markPaperToMarket({ state: s0, prices: {} }),
  ];
  for (const r of results) {
    assert.equal(r.realApiCalled, false);
  }
});

test('N3: 모듈이 bitget-private-auth/readonly 를 import 하지 않는다 (정적 보증)', () => {
  // 상단에 이미 import fs / import path 가 있으므로 재사용.
  const dir = '/opt/smart-grid-dev/packages/smart-grid-engine/src';
  for (const file of ['live-order-gate.mjs', 'paper-execution-adapter.mjs']) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.equal(src.includes('bitget-private-auth'), false, `${file} 이 auth import 하면 안 됨`);
    assert.equal(src.includes('bitget-private-readonly'), false, `${file} 이 readonly import 하면 안 됨`);
    assert.equal(/fetch\s*\(/.test(src), false, `${file} 이 fetch 사용하면 안 됨`);
  }
});


// ════════════════════════════════════════════════════
// O. 검증 A — 저장 실패 시 안전성
// ════════════════════════════════════════════════════

function impossibleStatePath() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'b19g-o-'));
  const blocker = path.join(tmpRoot, 'blocker');
  fs.writeFileSync(blocker, 'x', 'utf8');
  return path.join(blocker, 'state.json'); // 부모가 파일 → 저장 실패
}

test('O1: submitPaperOrder + statePath 저장 실패 → ok:false, reason=SAVE_FAILED', () => {
  const s0 = createPaperState({ initialUsdt: 1000, nowMs: NOW });
  const badPath = impossibleStatePath();
  const r = submitPaperOrder({
    state: s0, statePath: badPath,
    symbol: 'BTCUSDT', direction: DIRECTION.LONG,
    quantity: 0.1, price: 100, leverage: 2, nowMs: NOW,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'SAVE_FAILED');
  assert.equal(r.realApiCalled, false);
  assert.equal(r.state, undefined, '저장 실패 시 nextState 반환 금지');
});

test('O2: 저장 실패 후 s0 는 완전히 무변경 (재시도 안전)', () => {
  const s0 = createPaperState({ initialUsdt: 1000, nowMs: NOW });
  const beforeBal = s0.usdtBalance;
  const beforePos = Object.keys(s0.positions || {}).length;
  const badPath = impossibleStatePath();
  submitPaperOrder({
    state: s0, statePath: badPath,
    symbol: 'BTCUSDT', direction: DIRECTION.LONG,
    quantity: 0.1, price: 100, leverage: 2, nowMs: NOW,
  });
  assert.equal(s0.usdtBalance, beforeBal);
  assert.equal(Object.keys(s0.positions || {}).length, beforePos);
});

test('O3: 저장 성공 시 ok:true + 디스크 상태 일치', () => {
  const p = newTmpPath();
  const s0 = createPaperState({ initialUsdt: 1000, nowMs: NOW });
  const r = submitPaperOrder({
    state: s0, statePath: p,
    symbol: 'BTCUSDT', direction: DIRECTION.LONG,
    quantity: 0.1, price: 100, leverage: 2, nowMs: NOW,
  });
  assert.equal(r.ok, true);
  const loaded = paperLoadState({ statePath: p });
  assert.equal(loaded.positions.BTCUSDT.status, 'OPEN');
  assert.equal(loaded.positions.BTCUSDT.quantity, 0.1);
});

test('O4: 저장 실패 후 정상 경로로 재시도 → 단일 체결만 디스크에 존재', () => {
  const p = newTmpPath();
  const s0 = createPaperState({ initialUsdt: 1000, nowMs: NOW });
  // 1차: 실패하는 경로로 시도
  const badPath = impossibleStatePath();
  const r1 = submitPaperOrder({
    state: s0, statePath: badPath,
    symbol: 'BTCUSDT', direction: DIRECTION.LONG,
    quantity: 0.1, price: 100, leverage: 2, nowMs: NOW,
  });
  assert.equal(r1.ok, false);
  // 2차: 정상 경로로 재시도 (s0 는 무변경이므로 안전)
  const r2 = submitPaperOrder({
    state: s0, statePath: p,
    symbol: 'BTCUSDT', direction: DIRECTION.LONG,
    quantity: 0.1, price: 100, leverage: 2, nowMs: NOW,
  });
  assert.equal(r2.ok, true);
  const loaded = paperLoadState({ statePath: p });
  assert.equal(loaded.fills.length, 1, '체결 1건만 기록되어야 함 (중복 없음)');
});

// ════════════════════════════════════════════════════
// P. 검증 B — 손상 상태 FAIL_CLOSED 및 보존
// ════════════════════════════════════════════════════

test('P1: paperLoadStateSafe — 손상 파일 → ok:false, corrupt:true, failClosed:true', () => {
  const p = newTmpPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '{corrupted-json', 'utf8');
  const r = paperLoadStateSafe({ statePath: p });
  assert.equal(r.ok, false);
  assert.equal(r.corrupt, true);
  assert.equal(r.failClosed, true);
  assert.ok(r.quarantinePath);
  assert.equal(fs.existsSync(r.quarantinePath), true);
  assert.equal(fs.existsSync(p), false, '원본 경로는 rename 됨');
});

test('P2: paperLoadStateSafe — 파일 없음 → ok:true, initialized:true', () => {
  const p = newTmpPath();
  const r = paperLoadStateSafe({ statePath: p });
  assert.equal(r.ok, true);
  assert.equal(r.initialized, true);
  assert.ok(r.state);
});

test('P3: paperLoadStateSafe — 정상 파일 → ok:true, 원본 그대로', () => {
  const p = newTmpPath();
  const s0 = createPaperState({ initialUsdt: 500, nowMs: NOW });
  paperSaveState({ statePath: p, state: s0 });
  const r = paperLoadStateSafe({ statePath: p });
  assert.equal(r.ok, true);
  assert.equal(r.state.usdtBalance, 500);
  assert.equal(fs.existsSync(p), true, '정상 파일은 rename 되지 않음');
});

test('P4: 격리 파일의 내용이 원본과 100% 동일 (유실 없음)', () => {
  const p = newTmpPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const original = 'THIS_IS_NOT_JSON_BUT_MUST_BE_PRESERVED_12345';
  fs.writeFileSync(p, original, 'utf8');
  const r = paperLoadStateSafe({ statePath: p });
  assert.equal(r.corrupt, true);
  const qContent = fs.readFileSync(r.quarantinePath, 'utf8');
  assert.equal(qContent, original, '격리 파일은 원본과 완전 동일해야 함');
});

test('P5: 손상 파일 2회 로드 시 격리본 누적 (덮어쓰기 없음)', () => {
  const p = newTmpPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '{corrupted-1', 'utf8');
  paperLoadState({ statePath: p });
  fs.writeFileSync(p, '{corrupted-2', 'utf8');
  paperLoadState({ statePath: p });
  const files = fs.readdirSync(path.dirname(p)).filter(f => f.includes('.corrupt.'));
  assert.equal(files.length, 2, '2건의 격리 파일이 각각 존재해야 함');
});

test('P6: paperLoadStateSafe — state.version 이 1이 아니어도 격리', () => {
  const p = newTmpPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ version: 99, balance: 100 }), 'utf8');
  const r = paperLoadStateSafe({ statePath: p });
  assert.equal(r.ok, false);
  assert.equal(r.corrupt, true);
  assert.equal(r.reason, 'STATE_VERSION_INVALID');
  assert.equal(fs.existsSync(r.quarantinePath), true);
});
