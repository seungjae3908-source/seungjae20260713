// live-order-gate.mjs
// BLOCK 19 Step 4 — LIVE 주문 게이트 (영구 기본 차단)
//
// 원칙 (모든 상황에서 절대 준수):
//   - 이 모듈은 어떤 입력이 와도 실제 주문을 실행하지 않는다.
//   - evaluateLiveGate() 는 항상 { allowed:false, wouldExecute:false, realApiCalled:false }
//     를 반환한다. (이번 BLOCK에서는 LIVE 활성화를 하지 않는다.)
//   - candidateEligible 은 "모든 안전 검사를 통과했는가"의 여부일 뿐이며,
//     이 값이 true 여도 주문 실행 권한을 부여하지 않는다.
//   - 승인 후보 판정(candidateEligible)과 실제 실행 권한(allowed)은 완전히 분리.
//   - 이 모듈은 fs, network, child_process 등 어떤 부작용도 사용하지 않는다.

export const LIVE_GATE_DEFAULTS = Object.freeze({
  REQUIRED_EXECUTION_AUTHORITY: 'EXPLICIT_LIVE',
  BLOCKED_EXECUTION_AUTHORITY: 'NONE',
  REQUIRED_FLAGS_TRUE: Object.freeze([
    'LIVE_TRADING',
    'AUTO_TRADING',
    'REAL_ORDER_ENABLED',
    'PRIVATE_TRADING_API_ALLOWED',
  ]),
  MAX_MARKET_DATA_AGE_MS: 60_000,
  MAX_ACCOUNT_DATA_AGE_MS: 120_000,
  MIN_APPROVAL_TOKEN_LENGTH: 16,
  ACCOUNT_BALANCE_TOLERANCE: 0.01,
});

// 가장 안전한 기본 env — 이 값을 쓰면 무조건 차단된다.
export const SAFE_LIVE_ENV = Object.freeze({
  LIVE_TRADING: false,
  AUTO_TRADING: false,
  REAL_ORDER_ENABLED: false,
  PRIVATE_TRADING_API_ALLOWED: false,
  EXECUTION_AUTHORITY: 'NONE',
});

function isTruthy(x) {
  return x === true || x === 'true' || x === '1' || x === 1;
}

export function evaluateSafetyFlags(env = {}) {
  const reasons = [];
  const checks = {};
  for (const flag of LIVE_GATE_DEFAULTS.REQUIRED_FLAGS_TRUE) {
    const v = isTruthy(env[flag]);
    checks[flag] = v;
    if (!v) reasons.push(`FLAG_OFF:${flag}`);
  }
  return { pass: reasons.length === 0, checks, reasons };
}

export function evaluateExecutionAuthority(env = {}) {
  const auth = env.EXECUTION_AUTHORITY ?? env.executionAuthority;
  if (auth === LIVE_GATE_DEFAULTS.REQUIRED_EXECUTION_AUTHORITY) {
    return { pass: true, value: auth, reasons: [] };
  }
  if (auth == null || auth === LIVE_GATE_DEFAULTS.BLOCKED_EXECUTION_AUTHORITY) {
    return { pass: false, value: auth ?? null, reasons: ['EXECUTION_AUTHORITY_NONE'] };
  }
  return { pass: false, value: auth, reasons: [`EXECUTION_AUTHORITY_INVALID:${auth}`] };
}

export function evaluateApprovalToken(given, expected) {
  const min = LIVE_GATE_DEFAULTS.MIN_APPROVAL_TOKEN_LENGTH;
  if (typeof expected !== 'string' || expected.length < min) {
    return { pass: false, reasons: ['EXPECTED_TOKEN_MISSING_OR_TOO_SHORT'] };
  }
  if (typeof given !== 'string' || given.length < min) {
    return { pass: false, reasons: ['GIVEN_TOKEN_MISSING_OR_TOO_SHORT'] };
  }
  if (given !== expected) {
    return { pass: false, reasons: ['TOKEN_MISMATCH'] };
  }
  return { pass: true, reasons: [] };
}

export function evaluateMarketDataFreshness({ lastUpdateMs, nowMs, maxAgeMs = LIVE_GATE_DEFAULTS.MAX_MARKET_DATA_AGE_MS } = {}) {
  if (!Number.isFinite(lastUpdateMs)) return { pass: false, reasons: ['MARKET_DATA_TS_UNKNOWN'] };
  if (!Number.isFinite(nowMs)) return { pass: false, reasons: ['NOW_MS_INVALID'] };
  if (lastUpdateMs > nowMs + 5_000) return { pass: false, reasons: ['MARKET_DATA_CLOCK_SKEW'] };
  const age = nowMs - lastUpdateMs;
  if (age > maxAgeMs) return { pass: false, reasons: [`MARKET_DATA_STALE:${age}ms`], ageMs: age };
  return { pass: true, reasons: [], ageMs: age };
}

export function evaluateAccountDataFreshness({ lastAccountSyncMs, nowMs, maxAgeMs = LIVE_GATE_DEFAULTS.MAX_ACCOUNT_DATA_AGE_MS } = {}) {
  if (!Number.isFinite(lastAccountSyncMs)) return { pass: false, reasons: ['ACCOUNT_TS_UNKNOWN'] };
  if (!Number.isFinite(nowMs)) return { pass: false, reasons: ['NOW_MS_INVALID'] };
  const age = nowMs - lastAccountSyncMs;
  if (age > maxAgeMs) return { pass: false, reasons: [`ACCOUNT_STALE:${age}ms`], ageMs: age };
  return { pass: true, reasons: [], ageMs: age };
}

export function evaluateAccountConsistency({ expected, observed } = {}) {
  if (!expected || !observed) return { pass: false, reasons: ['ACCOUNT_DATA_MISSING'] };
  const reasons = [];
  const tol = LIVE_GATE_DEFAULTS.ACCOUNT_BALANCE_TOLERANCE;
  const eBal = Number(expected.usdtBalance);
  const oBal = Number(observed.usdtBalance);
  if (!Number.isFinite(eBal) || !Number.isFinite(oBal)) {
    reasons.push('ACCOUNT_BALANCE_INVALID');
  } else if (Math.abs(eBal - oBal) / Math.max(eBal, 1) > tol) {
    reasons.push(`ACCOUNT_BALANCE_MISMATCH:${eBal}vs${oBal}`);
  }
  if (Number.isFinite(expected.openPositionCount) &&
      Number.isFinite(observed.openPositionCount) &&
      expected.openPositionCount !== observed.openPositionCount) {
    reasons.push(`POSITION_COUNT_MISMATCH:${expected.openPositionCount}vs${observed.openPositionCount}`);
  }
  return { pass: reasons.length === 0, reasons };
}

export function evaluateRiskEvaluation(riskEvaluation) {
  if (!riskEvaluation || typeof riskEvaluation !== 'object') {
    return { pass: false, reasons: ['RISK_EVAL_MISSING'] };
  }
  const reasons = [];
  if (riskEvaluation.ok !== true) reasons.push('RISK_EVAL_NOT_OK');
  if (riskEvaluation.failClosed === true) reasons.push('RISK_EVAL_FAIL_CLOSED');
  if (riskEvaluation.allowNewEntry !== true) reasons.push('RISK_EVAL_NO_ENTRY');
  if (!riskEvaluation.orderKey) reasons.push('RISK_ORDER_KEY_MISSING');
  return { pass: reasons.length === 0, reasons };
}

export function evaluateSizeAndCapital({
  plan, quantity, minQuantity, maxQuantity, maxNotionalUsdt,
} = {}) {
  if (!plan || typeof plan !== 'object') return { pass: false, reasons: ['PLAN_MISSING'] };
  const reasons = [];
  const q = Number(quantity);
  if (!Number.isFinite(q) || q <= 0) reasons.push('QUANTITY_INVALID');
  if (Number.isFinite(minQuantity) && q < minQuantity) reasons.push(`QUANTITY_BELOW_MIN:${q}<${minQuantity}`);
  if (Number.isFinite(maxQuantity) && q > maxQuantity) reasons.push(`QUANTITY_ABOVE_MAX:${q}>${maxQuantity}`);
  const price = Number(plan.currentPrice ?? plan.entryPrice ?? plan.grid?.lowerPrice ?? 0);
  const notional = q * price;
  if (!Number.isFinite(notional) || notional <= 0) {
    reasons.push('NOTIONAL_INVALID');
  } else if (Number.isFinite(maxNotionalUsdt) && notional > maxNotionalUsdt) {
    reasons.push(`NOTIONAL_EXCEEDS_MAX:${notional}>${maxNotionalUsdt}`);
  }
  return { pass: reasons.length === 0, reasons, notional };
}

/**
 * LIVE 주문 게이트 — 절대 실행 없음.
 *
 * 반환:
 *   {
 *     allowed: false,               // 항상 false
 *     wouldExecute: false,          // 항상 false
 *     realApiCalled: false,         // 항상 false
 *     candidateEligible: boolean,   // 모든 안전 검사를 통과했는가 (실행 권한 아님)
 *     reasons: string[],            // 차단 사유
 *     checks: object,               // 각 검사 결과
 *     evaluatedAtMs: number,
 *   }
 */
export function evaluateLiveGate(args = {}) {
  const {
    plan = null,
    riskEvaluation = null,
    env = {},
    explicitApprovalToken = null,
    expectedApprovalToken = null,
    marketData = { lastUpdateMs: null },
    accountData = { lastAccountSyncMs: null, expected: null, observed: null },
    quantity = null,
    minQuantity = null,
    maxQuantity = null,
    maxNotionalUsdt = null,
    nowMs = Date.now(),
  } = args;

  const reasons = [];
  const checks = {};

  const flags = evaluateSafetyFlags(env);
  checks.flags = flags;
  if (!flags.pass) reasons.push(...flags.reasons);

  const authority = evaluateExecutionAuthority(env);
  checks.authority = authority;
  if (!authority.pass) reasons.push(...authority.reasons);

  const approval = evaluateApprovalToken(explicitApprovalToken, expectedApprovalToken);
  checks.approval = approval;
  if (!approval.pass) reasons.push(...approval.reasons);

  const market = evaluateMarketDataFreshness({
    lastUpdateMs: marketData.lastUpdateMs,
    nowMs: marketData.nowMs ?? nowMs,
  });
  checks.market = market;
  if (!market.pass) reasons.push(...market.reasons);

  const account = evaluateAccountDataFreshness({
    lastAccountSyncMs: accountData.lastAccountSyncMs,
    nowMs,
  });
  checks.account = account;
  if (!account.pass) reasons.push(...account.reasons);

  const consistency = evaluateAccountConsistency({
    expected: accountData.expected,
    observed: accountData.observed,
  });
  checks.consistency = consistency;
  if (!consistency.pass) reasons.push(...consistency.reasons);

  const risk = evaluateRiskEvaluation(riskEvaluation);
  checks.risk = risk;
  if (!risk.pass) reasons.push(...risk.reasons);

  const size = evaluateSizeAndCapital({
    plan, quantity, minQuantity, maxQuantity, maxNotionalUsdt,
  });
  checks.size = size;
  if (!size.pass) reasons.push(...size.reasons);

  const candidateEligible = reasons.length === 0;

  // ── 절대 안전 ──
  // 어떤 경우에도 이번 BLOCK에서는 실행하지 않는다.
  return {
    allowed: false,
    wouldExecute: false,
    realApiCalled: false,
    candidateEligible,
    reasons,
    checks,
    evaluatedAtMs: nowMs,
  };
}
