// ai-strategy-selector.mjs
// BLOCK 19 Step 2 — AI 전략 선택기
//
// 원칙:
//   - Step 1 market-regime-classifier 재사용 (수정 없음)
//   - risk-manager.mjs::selectStrategy 래핑 (수정 없음)
//   - B 트레일링 fallback 은 AI 판단과 무관하게 항상 유지
//   - HIGH_VOLATILITY / FAIL_CLOSED → 신규 진입 금지

import { classifyRegime, REGIME } from './market-regime-classifier.mjs';
import { selectStrategy as legacySelectStrategy } from './risk-manager.mjs';

export const STRATEGY = Object.freeze({
  LONG_TRAILING_GRID: 'LONG_TRAILING_GRID',
  SHORT_TRAILING_GRID: 'SHORT_TRAILING_GRID',
  NEUTRAL_GRID: 'NEUTRAL_GRID',
  NO_NEW_ENTRY: 'NO_NEW_ENTRY',
  SAFE_WAIT: 'SAFE_WAIT',
  STRATEGY_B_FALLBACK: 'STRATEGY_B_FALLBACK',
});

export const DIRECTION = Object.freeze({
  LONG: 'LONG',
  SHORT: 'SHORT',
  NEUTRAL: 'NEUTRAL',
  NONE: 'NONE',
});

const REGIME_TO_STRATEGY = Object.freeze({
  [REGIME.STRONG_UPTREND]: STRATEGY.LONG_TRAILING_GRID,
  [REGIME.STRONG_DOWNTREND]: STRATEGY.SHORT_TRAILING_GRID,
  [REGIME.SIDEWAYS]: STRATEGY.NEUTRAL_GRID,
  [REGIME.HIGH_VOLATILITY]: STRATEGY.NO_NEW_ENTRY,
  [REGIME.FAIL_CLOSED]: STRATEGY.SAFE_WAIT,
});

const STRATEGY_TO_DIRECTION = Object.freeze({
  [STRATEGY.LONG_TRAILING_GRID]: DIRECTION.LONG,
  [STRATEGY.SHORT_TRAILING_GRID]: DIRECTION.SHORT,
  [STRATEGY.NEUTRAL_GRID]: DIRECTION.NEUTRAL,
  [STRATEGY.NO_NEW_ENTRY]: DIRECTION.NONE,
  [STRATEGY.SAFE_WAIT]: DIRECTION.NONE,
});

const LEGACY_REQUIRED_KEYS = ['rsi', 'macdHistogram', 'adx', 'currentPrice', 'atr'];

function hasAllLegacyInputs(input) {
  return LEGACY_REQUIRED_KEYS.every((k) => {
    const v = input?.[k];
    return typeof v === 'number' && Number.isFinite(v);
  });
}

function callLegacySafely(input) {
  if (!hasAllLegacyInputs(input)) {
    return { value: null, error: null, called: false };
  }
  try {
    const value = legacySelectStrategy({
      rsi: input.rsi,
      macdHistogram: input.macdHistogram,
      adx: input.adx,
      currentPrice: input.currentPrice,
      atr: input.atr,
    });
    return { value, error: null, called: true };
  } catch (err) {
    return {
      value: null,
      error: err?.message || 'LEGACY_SELECT_THREW',
      called: true,
    };
  }
}

/**
 * AI 시장 판단 + 전략 선택 통합.
 *
 * 반환 필드:
 *   ok, failClosed, allowNewEntry, regime, strategy, direction,
 *   confidence, reasons[], fallback(항상 STRATEGY_B_FALLBACK),
 *   legacyStrategy(B 결과 그대로), legacyError
 */
export function selectAIPlan(input = {}, opts = {}) {
  const classification = classifyRegime(input, opts.classifyOpts || {});

  const legacy = opts.includeLegacy === false
    ? { value: null, error: null, called: false }
    : callLegacySafely(input);

  const regime = classification.regime;
  const mapped = REGIME_TO_STRATEGY[regime] || STRATEGY.SAFE_WAIT;

  const base = {
    regime,
    confidence: classification.confidence,
    reasons: Array.isArray(classification.reasons) ? classification.reasons.slice() : [],
    fallback: STRATEGY.STRATEGY_B_FALLBACK,
    legacyStrategy: legacy.value,
    legacyError: legacy.error,
  };

  if (classification.failClosed) {
    return {
      ...base,
      ok: false,
      failClosed: true,
      allowNewEntry: false,
      strategy: STRATEGY.SAFE_WAIT,
      direction: DIRECTION.NONE,
    };
  }

  const allowNewEntry =
    classification.allowNewEntry === true &&
    mapped !== STRATEGY.NO_NEW_ENTRY &&
    mapped !== STRATEGY.SAFE_WAIT;

  return {
    ...base,
    ok: true,
    failClosed: false,
    allowNewEntry,
    strategy: mapped,
    direction: STRATEGY_TO_DIRECTION[mapped] || DIRECTION.NONE,
  };
}

/** AI 판단과 무관하게 B fallback 이 항상 유지되는지 확인. */
export function isFallbackRetained(plan) {
  return Boolean(plan && plan.fallback === STRATEGY.STRATEGY_B_FALLBACK);
}

/** 진입 허용 여부 간편 확인. */
export function allowsNewEntry(plan) {
  return Boolean(plan && plan.ok === true && plan.allowNewEntry === true);
}
