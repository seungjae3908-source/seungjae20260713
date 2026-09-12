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

function completeRegime(overrides = {}) {
  return passGate({
    status: 'READY',
    regime: { label: 'TREND_UP' },
    drift: { status: 'STABLE' },
    safety: { executionAuthority: 'NONE', liveTrading: false },
    ...overrides,
  });
}

function completeNetAlpha(overrides = {}) {
  return passGate({
    status: 'READY',
    role: 'CONSERVATIVE_CROSS_CHECK_ONLY',
    source: 'forward-recommendation-profit-calibration-v2',
    conservativeNetAlphaBps: 8,
    readiness: {
      forwardDataComplete: true,
      fullCostReady: true,
      evidenceComplete: true,
      profitabilityProven: true,
    },
    safety: {
      executionAuthority: 'NONE',
      liveTrading: false,
      aiNumericalAuthority: false,
      profitabilityClaimAllowed: false,
    },
    ...overrides,
  });
}

function readyInput(overrides = {}) {
  return {
    market: 'CRYPTO_FUTURES',
    direction: 'LONG',
    regimeBrain: completeRegime(),
    netAlpha: completeNetAlpha(),
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
  assert.equal(result.advisoryMultiplier, 0.8);
  assert.equal(result.suggestedRiskFraction, 0.008);
  assert.equal(result.suggestedNotional, 800_000);
  assert.ok(result.recommendedMultiplier <= 1);
  assert.ok(result.suggestedNotional <= result.parentBaseNotional);
  assert.equal(result.safety.canIncreaseParentExposure, false);
  assert.equal(result.safety.reductionOnly, true);
  assert.equal(result.safety.aiNumericalAuthority, false);
  assert.equal(result.safety.userMultiplierAuthority, false);
  assert.equal(result.safety.executionAuthority, 'NONE');
  assert.equal(result.safety.liveTrading, false);
  assert.equal(result.autoTrading.orderAllowed, false);
});

test('high volatility and drift watch automatically apply the stricter reduction', () => {
  const result = evaluateDynamicBetSizing(readyInput({
    regimeBrain: completeRegime({
      regime: { label: 'HIGH_VOL' },
      drift: { status: 'WATCH' },
    }),
  }));
  assert.equal(result.state, 'PASS');
  assert.equal(result.factors.regime, 0.5);
  assert.equal(result.recommendedMultiplier, 0.5);
});

test('SHORT is reduced in a TREND_UP futures regime without flipping direction', () => {
  const result = evaluateDynamicBetSizing(readyInput({ direction: 'SHORT' }));
  assert.equal(result.state, 'PASS');
  assert.equal(result.direction, 'SHORT');
  assert.equal(result.factors.regime, 0.5);
  assert.equal(result.recommendedMultiplier, 0.5);
});

test('a veto anywhere in the decision chain forces every sizing multiplier to zero', () => {
  const result = evaluateDynamicBetSizing(readyInput({
    netAlpha: completeNetAlpha({
      conservativeNetAlphaBps: -2,
      autoTrading: { state: 'VETO', reasons: ['CONSERVATIVE_NET_ALPHA_BELOW_MINIMUM'] },
    }),
  }));
  assert.equal(result.state, 'VETO');
  assert.equal(result.advisoryMultiplier, 0);
  assert.equal(result.recommendedMultiplier, 0);
  assert.equal(result.suggestedNotional, 0);
  assert.equal(result.autoTrading.orderAllowed, false);
});

test('NO_TRADE and SIGNAL_CONFLICT are preserved as zero-exposure vetoes', () => {
  for (const direction of ['NO_TRADE', 'SIGNAL_CONFLICT']) {
    const result = evaluateDynamicBetSizing(readyInput({ direction }));
    assert.equal(result.state, 'VETO');
    assert.equal(result.direction, direction);
    assert.equal(result.advisoryMultiplier, 0);
    assert.equal(result.recommendedMultiplier, 0);
    assert.equal(result.suggestedNotional, 0);
  }
});

test('long-only markets cannot be converted into SHORT or SELL exposure', () => {
  for (const market of ['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT']) {
    for (const direction of ['SHORT', 'SELL']) {
      const result = evaluateDynamicBetSizing(readyInput({ market, direction }));
      assert.equal(result.state, 'VETO');
      assert.equal(result.advisoryMultiplier, 0);
      assert.equal(result.recommendedMultiplier, 0);
      assert.ok(result.reasons.includes('DIRECTION_NOT_ALLOWED_FOR_MARKET'));
    }
  }
});

test('noncanonical futures BUY or SELL direction is vetoed rather than normalized', () => {
  for (const direction of ['BUY', 'SELL']) {
    const result = evaluateDynamicBetSizing(readyInput({ direction }));
    assert.equal(result.state, 'VETO');
    assert.equal(result.advisoryMultiplier, 0);
    assert.equal(result.recommendedMultiplier, 0);
    assert.ok(result.reasons.includes('DIRECTION_NOT_ALLOWED_FOR_MARKET'));
  }
});

test('missing decision evidence stays unknown rather than being presented as full size or measured zero', () => {
  const result = evaluateDynamicBetSizing(readyInput({ portfolioSafety: undefined }));
  assert.equal(result.state, 'INSUFFICIENT_EVIDENCE');
  assert.equal(result.recommendedMultiplier, null);
  assert.equal(result.advisoryMultiplier, null);
  assert.equal(result.suggestedNotional, null);
  assert.ok(result.reasons.includes('PORTFOLIO_EVIDENCE_INCOMPLETE'));
});

test('missing market or direction is insufficient evidence not a full-size fallback', () => {
  const marketMissing = evaluateDynamicBetSizing(readyInput({ market: '' }));
  assert.equal(marketMissing.state, 'INSUFFICIENT_EVIDENCE');
  assert.equal(marketMissing.recommendedMultiplier, null);

  const directionMissing = evaluateDynamicBetSizing(readyInput({ direction: '' }));
  assert.equal(directionMissing.state, 'INSUFFICIENT_EVIDENCE');
  assert.equal(directionMissing.recommendedMultiplier, null);
});

test('NET_ALPHA READY wrapper without complete Full Cost Evidence and profitability provenance is still insufficient', () => {
  const partial = evaluateDynamicBetSizing(readyInput({
    netAlpha: completeNetAlpha({
      readiness: {
        forwardDataComplete: true,
        fullCostReady: false,
        evidenceComplete: true,
        profitabilityProven: true,
      },
    }),
  }));
  assert.equal(partial.state, 'INSUFFICIENT_EVIDENCE');
  assert.equal(partial.advisoryMultiplier, null);
  assert.equal(partial.recommendedMultiplier, null);
  assert.ok(partial.reasons.includes('NET_ALPHA_EVIDENCE_INCOMPLETE'));

  const notProven = evaluateDynamicBetSizing(readyInput({
    netAlpha: completeNetAlpha({
      readiness: {
        forwardDataComplete: true,
        fullCostReady: true,
        evidenceComplete: true,
        profitabilityProven: false,
      },
    }),
  }));
  assert.equal(notProven.state, 'INSUFFICIENT_EVIDENCE');
  assert.equal(notProven.recommendedMultiplier, null);
  assert.ok(notProven.reasons.includes('NET_ALPHA_EVIDENCE_INCOMPLETE'));
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

test('AI user nested multiplier and maxMultiplier payloads have no numeric authority', () => {
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

test('numeric strings cannot become sizing authority', () => {
  const drawdownString = evaluateDynamicBetSizing(readyInput({ currentDrawdownPct: '2' }));
  assert.equal(drawdownString.state, 'INSUFFICIENT_EVIDENCE');
  assert.equal(drawdownString.recommendedMultiplier, null);
  assert.ok(drawdownString.reasons.includes('DRAWDOWN_EVIDENCE_MISSING'));

  const alphaString = evaluateDynamicBetSizing(readyInput({
    netAlpha: completeNetAlpha({ conservativeNetAlphaBps: '8' }),
  }));
  assert.equal(alphaString.state, 'INSUFFICIENT_EVIDENCE');
  assert.equal(alphaString.recommendedMultiplier, null);
  assert.ok(alphaString.reasons.includes('NET_ALPHA_SIZING_EVIDENCE_MISSING'));
});

test('request-supplied sizing thresholds cannot increase or otherwise reshape canonical exposure policy', () => {
  assert.throws(
    () => evaluateDynamicBetSizing(readyInput(), { highVolMultiplier: 0.9 }),
    /DYNAMIC_SIZING_POLICY_OVERRIDE_NOT_ALLOWED:highVolMultiplier/,
  );
  assert.throws(
    () => evaluateDynamicBetSizing(readyInput(), { minimumActiveMultiplier: 0 }),
    /DYNAMIC_SIZING_POLICY_OVERRIDE_NOT_ALLOWED:minimumActiveMultiplier/,
  );
  const required = evaluateDynamicBetSizing(readyInput(), { enforcement: 'REQUIRED_FOR_PARENT_GATE' });
  assert.equal(required.policy.enforcement, 'REQUIRED_FOR_PARENT_GATE');
  assert.equal(required.policy.highVolMultiplier, 0.60);
});

test('across varied valid conservative alpha and drawdown inputs multiplier never exceeds one', () => {
  for (const alpha of [1, 2, 5, 10, 20, 1000]) {
    for (const dd of [0, 2, 5, 7, 10, 14]) {
      const result = evaluateDynamicBetSizing(readyInput({
        netAlpha: completeNetAlpha({ conservativeNetAlphaBps: alpha }),
        currentDrawdownPct: dd,
      }));
      assert.equal(result.state, 'PASS');
      assert.ok(result.recommendedMultiplier >= 0);
      assert.ok(result.recommendedMultiplier <= 1);
      assert.ok(result.advisoryMultiplier <= 1);
    }
  }
});
