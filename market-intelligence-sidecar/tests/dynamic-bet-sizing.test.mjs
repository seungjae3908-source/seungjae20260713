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

function readyInput(overrides = {}) {
  return {
    market: 'CRYPTO_FUTURES',
    direction: 'LONG',
    regimeBrain: passGate({
      regime: { label: 'TREND_UP' },
      drift: { status: 'STABLE' },
    }),
    netAlpha: passGate({ conservativeNetAlphaBps: 8 }),
    advancedGates: passGate(),
    executionQuality: passGate(),
    portfolioSafety: passGate(),
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
  assert.equal(result.autoTrading.orderAllowed, false);
});

test('high volatility and drift watch automatically apply the stricter reduction', () => {
  const result = evaluateDynamicBetSizing(readyInput({
    regimeBrain: passGate({
      regime: { label: 'HIGH_VOL' },
      drift: { status: 'WATCH' },
    }),
  }));
  assert.equal(result.state, 'PASS');
  assert.equal(result.factors.regime, 0.5);
  assert.equal(result.recommendedMultiplier, 0.5);
});

test('a veto anywhere in the decision chain becomes zero new exposure, not an order', () => {
  const result = evaluateDynamicBetSizing(readyInput({
    netAlpha: {
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

test('missing decision evidence stays unknown rather than being presented as a measured zero size', () => {
  const result = evaluateDynamicBetSizing(readyInput({ portfolioSafety: undefined }));
  assert.equal(result.state, 'INSUFFICIENT_EVIDENCE');
  assert.equal(result.recommendedMultiplier, null);
  assert.equal(result.suggestedNotional, null);
  assert.ok(result.reasons.includes('PORTFOLIO_EVIDENCE_INCOMPLETE'));
});

test('policy cannot configure a multiplier above parent exposure', () => {
  assert.throws(
    () => evaluateDynamicBetSizing(readyInput(), { highVolMultiplier: 1.2 }),
    /DYNAMIC_SIZING_MULTIPLIER_INVALID/,
  );
});
