import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDynamicBetSizing } from '../src/dynamic-bet-sizing.mjs';

function passGate(extra = {}) {
  return {
    policy: { enforcement: 'OBSERVE_ONLY' },
    autoTrading: { state: 'PASS', reasons: [], orderAllowed: false },
    ...extra,
  };
}

function completeAdvancedGate() {
  return passGate({
    uncertainty: { status: 'PASS' },
    metaLabel: { status: 'PASS' },
    eventRisk: { status: 'PASS' },
  });
}

function completeExecutionGate() {
  return passGate({
    bookWalk: { status: 'PASS' },
    fillModel: { status: 'PASS' },
  });
}

function completePortfolioGate() {
  return passGate({
    portfolio: { status: 'PASS' },
    expectedShortfall: { status: 'PASS' },
    signalFreshness: { status: 'PASS' },
  });
}

function readyInput(overrides = {}) {
  return {
    market: 'CRYPTO_FUTURES',
    direction: 'LONG',
    regimeBrain: passGate({
      status: 'READY',
      regime: { label: 'TREND_UP' },
      drift: { status: 'STABLE' },
    }),
    netAlpha: passGate({ status: 'READY', conservativeNetAlphaBps: 8 }),
    advancedGates: completeAdvancedGate(),
    executionQuality: completeExecutionGate(),
    portfolioSafety: completePortfolioGate(),
    currentDrawdownPct: 2,
    parentBaseRiskFraction: 0.01,
    parentBaseNotional: 1_000_000,
    ...overrides,
  };
}

test('recommended sizing can only reduce parent-authorized exposure', () => {
  const result = evaluateDynamicBetSizing(readyInput());
  assert.equal(result.state, 'PASS');
  assert.equal(result.recommendedMultiplier, 0.8);
  assert.equal(result.suggestedRiskFraction, 0.008);
  assert.equal(result.suggestedNotional, 800_000);
  assert.ok(result.recommendedMultiplier <= 1);
  assert.ok(result.suggestedNotional <= result.parentBaseNotional);
  assert.equal(result.safety.canIncreaseParentExposure, false);
  assert.equal(result.safety.reductionOnly, true);
  assert.equal(result.safety.aiNumericalAuthority, false);
  assert.equal(result.safety.userMultiplierAuthority, false);
  assert.equal(result.autoTrading.orderAllowed, false);
});

test('high volatility and drift watch automatically apply the stricter reduction', () => {
  const result = evaluateDynamicBetSizing(readyInput({
    regimeBrain: passGate({
      status: 'READY',
      regime: { label: 'HIGH_VOL' },
      drift: { status: 'WATCH' },
    }),
  }));
  assert.equal(result.state, 'PASS');
  assert.equal(result.factors.regime, 0.5);
  assert.equal(result.recommendedMultiplier, 0.5);
});

test('SHORT is reduced in a TREND_UP futures regime without flipping direction', () => {
  const result = evaluateDynamicBetSizing(readyInput({
    direction: 'SHORT',
    regimeBrain: passGate({
      status: 'READY',
      regime: { label: 'TREND_UP' },
      drift: { status: 'STABLE' },
    }),
  }));
  assert.equal(result.state, 'PASS');
  assert.equal(result.direction, 'SHORT');
  assert.equal(result.factors.regime, 0.5);
  assert.equal(result.recommendedMultiplier, 0.5);
});

test('a veto anywhere in the decision chain becomes zero new exposure, not an order', () => {
  const result = evaluateDynamicBetSizing(readyInput({
    netAlpha: {
      status: 'READY',
      policy: { enforcement: 'OBSERVE_ONLY' },
      conservativeNetAlphaBps: -2,
      autoTrading: { state: 'VETO', reasons: ['CONSERVATIVE_NET_ALPHA_BELOW_MINIMUM'] },
    },
  }));
  assert.equal(result.state, 'VETO');
  assert.equal(result.recommendedMultiplier, 0);
  assert.equal(result.suggestedNotional, 0);
  assert.equal(result.autoTrading.orderAllowed, false);
});

test('NO_TRADE and SIGNAL_CONFLICT are preserved as zero-exposure vetoes', () => {
  const noTrade = evaluateDynamicBetSizing(readyInput({ direction: 'NO_TRADE' }));
  assert.equal(noTrade.state, 'VETO');
  assert.equal(noTrade.direction, 'NO_TRADE');
  assert.equal(noTrade.recommendedMultiplier, 0);
  assert.ok(noTrade.reasons.includes('UPSTREAM_NO_TRADE'));

  const conflict = evaluateDynamicBetSizing(readyInput({ direction: 'SIGNAL_CONFLICT' }));
  assert.equal(conflict.state, 'VETO');
  assert.equal(conflict.direction, 'SIGNAL_CONFLICT');
  assert.equal(conflict.recommendedMultiplier, 0);
  assert.ok(conflict.reasons.includes('UPSTREAM_SIGNAL_CONFLICT'));
});

test('long-only markets cannot be converted into SHORT or SELL exposure', () => {
  for (const market of ['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT']) {
    for (const direction of ['SHORT', 'SELL']) {
      const result = evaluateDynamicBetSizing(readyInput({ market, direction }));
      assert.equal(result.state, 'VETO');
      assert.equal(result.recommendedMultiplier, 0);
      assert.ok(result.reasons.includes('DIRECTION_NOT_ALLOWED_FOR_MARKET'));
    }
  }
});

test('noncanonical futures BUY or SELL direction is vetoed rather than normalized', () => {
  for (const direction of ['BUY', 'SELL']) {
    const result = evaluateDynamicBetSizing(readyInput({ direction }));
    assert.equal(result.state, 'VETO');
    assert.equal(result.recommendedMultiplier, 0);
    assert.ok(result.reasons.includes('DIRECTION_NOT_ALLOWED_FOR_MARKET'));
  }
});

test('missing decision evidence stays unknown rather than being presented as a measured zero size', () => {
  const result = evaluateDynamicBetSizing(readyInput({ portfolioSafety: undefined }));
  assert.equal(result.state, 'INSUFFICIENT_EVIDENCE');
  assert.equal(result.recommendedMultiplier, null);
  assert.equal(result.advisoryMultiplier, null);
  assert.equal(result.suggestedNotional, null);
  assert.ok(result.reasons.includes('PORTFOLIO_EVIDENCE_INCOMPLETE'));
});

test('missing market or direction is insufficient evidence, not a full-size fallback', () => {
  const marketMissing = evaluateDynamicBetSizing(readyInput({ market: '' }));
  assert.equal(marketMissing.state, 'INSUFFICIENT_EVIDENCE');
  assert.equal(marketMissing.recommendedMultiplier, null);
  assert.ok(marketMissing.reasons.includes('MARKET_EVIDENCE_MISSING'));

  const directionMissing = evaluateDynamicBetSizing(readyInput({ direction: '' }));
  assert.equal(directionMissing.state, 'INSUFFICIENT_EVIDENCE');
  assert.equal(directionMissing.recommendedMultiplier, null);
  assert.ok(directionMissing.reasons.includes('DIRECTION_EVIDENCE_MISSING'));
});

test('observe-only PASS wrappers with missing underlying evidence cannot authorize a sizing recommendation', () => {
  const result = evaluateDynamicBetSizing(readyInput({
    advancedGates: passGate(),
    executionQuality: passGate(),
    portfolioSafety: passGate(),
  }));
  assert.equal(result.state, 'INSUFFICIENT_EVIDENCE');
  assert.equal(result.advisoryMultiplier, null);
  assert.equal(result.recommendedMultiplier, null);
  assert.ok(result.reasons.includes('ADVANCED_EVIDENCE_INCOMPLETE'));
  assert.ok(result.reasons.includes('EXECUTION_EVIDENCE_INCOMPLETE'));
  assert.ok(result.reasons.includes('PORTFOLIO_EVIDENCE_INCOMPLETE'));
});

test('AI, user, nested multiplier, and maxMultiplier payloads have no numeric authority', () => {
  const result = evaluateDynamicBetSizing(readyInput({
    multiplier: 2,
    maxMultiplier: 5,
    ai: { multiplier: 4 },
    user: { multiplier: 3 },
    sizing: { multiplier: 2 },
  }));
  assert.equal(result.state, 'PASS');
  assert.equal(result.recommendedMultiplier, 0.8);
  assert.equal(result.safety.maximumMultiplier, 1);
  assert.equal(result.safety.aiNumericalAuthority, false);
  assert.equal(result.safety.userMultiplierAuthority, false);
});

test('policy cannot configure a multiplier above parent exposure or below zero', () => {
  assert.throws(
    () => evaluateDynamicBetSizing(readyInput(), { highVolMultiplier: 1.2 }),
    /DYNAMIC_SIZING_MULTIPLIER_INVALID/,
  );
  assert.throws(
    () => evaluateDynamicBetSizing(readyInput(), { counterTrendMultiplier: -0.1 }),
    /DYNAMIC_SIZING_MULTIPLIER_INVALID/,
  );
});
