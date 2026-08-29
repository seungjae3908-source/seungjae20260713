import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMarketIntelligence } from '../src/engine.mjs';

const NOW = Date.UTC(2026, 7, 22, 3, 20, 0);

function baseInput() {
  return {
    now: NOW,
    asOf: NOW,
    market: 'CRYPTO_SPOT',
    symbol: 'KRW-BTC',
    direction: 'BUY',
    orderBook: { bids: [[100, 10]], asks: [[100.1, 10]], ts: NOW },
    trades: [
      { side: 'buy', price: 100.05, size: 1, ts: NOW - 1_000 },
      { side: 'sell', price: 100.04, size: 1, ts: NOW },
    ],
    validation: {
      forwardSamples: 500,
      profitFactor: 1.5,
      expectedNetEdgeBps: 5,
      maxDrawdownPct: 8,
      regimeCount: 3,
    },
  };
}

function explicitCosts(overrides = {}) {
  return {
    commissionBps: 0.5,
    taxBps: 0,
    spreadBps: 1,
    slippageBps: 0.5,
    fundingBps: 0,
    latencyBps: 0.5,
    liquidityImpactBps: 0.5,
    partialFillImpactBps: 0.5,
    ...overrides,
  };
}

function stableRegime(overrides = {}) {
  return {
    asOf: NOW,
    trendScore: 0.7,
    realizedVol: 0.015,
    referenceVol: 0.015,
    referenceSpreadBps: 5,
    referenceTopDepthNotional: 2_000,
    referenceSamples: 500,
    drift: {
      evaluatedAt: NOW,
      sampleSize: 500,
      featurePsi: { trend: 0.05, volatility: 0.04 },
    },
    ...overrides,
  };
}

test('P0 modules are observe-only by default and do not break existing forward-ready parent eligibility', () => {
  const result = evaluateMarketIntelligence(baseInput());
  assert.equal(result.autoTrading.evidenceReady, true);
  assert.equal(result.autoTrading.mode, 'ELIGIBLE_FOR_PARENT_GATE');
  assert.equal(result.regimeBrain.policy.enforcement, 'OBSERVE_ONLY');
  assert.equal(result.netAlpha.policy.enforcement, 'OBSERVE_ONLY');
  assert.equal(result.dynamicSizing.policy.enforcement, 'OBSERVE_ONLY');
  assert.equal(result.scanner.candidateDeletionAllowed, false);
  assert.equal(result.autoTrading.orderAllowed, false);
  assert.equal(result.safety.executionAuthority, 'NONE');
});

test('required conservative net alpha veto blocks a positive point estimate after explicit costs', () => {
  const result = evaluateMarketIntelligence({
    ...baseInput(),
    netAlpha: {
      asOf: NOW,
      evidenceReady: true,
      source: 'SERVER_STRATEGY_PROMOTION',
      costPolicyVersion: 'cost-v1',
      expectedGrossEdgeBps: 6,
      conformalLowerEdgeBps: 2,
      attestedNetEdgeBps: 3,
      costs: explicitCosts(),
    },
    netAlphaPolicy: { enforcement: 'REQUIRED_FOR_PARENT_GATE' },
  });
  assert.equal(result.netAlpha.expectedNetEdgeBps, 2.5);
  assert.equal(result.netAlpha.conservativeNetAlphaBps, -1.5);
  assert.equal(result.netAlpha.autoTrading.state, 'VETO');
  assert.equal(result.autoTrading.mode, 'BLOCKED_RISK');
  assert.equal(result.autoTrading.hardBlockReason, 'CONSERVATIVE_NET_ALPHA_BELOW_MINIMUM');
  assert.equal(result.autoTrading.orderAllowed, false);
});

test('required regime evidence stays paper-only when drift evidence is not available', () => {
  const regimeWithoutDrift = stableRegime();
  delete regimeWithoutDrift.drift;
  const result = evaluateMarketIntelligence({
    ...baseInput(),
    regimeBrain: regimeWithoutDrift,
    regimeBrainPolicy: { enforcement: 'REQUIRED_FOR_PARENT_GATE' },
  });
  assert.equal(result.regimeBrain.status, 'READY');
  assert.equal(result.regimeBrain.drift.status, 'NOT_AVAILABLE');
  assert.equal(result.regimeBrain.autoTrading.state, 'INSUFFICIENT_EVIDENCE');
  assert.equal(result.autoTrading.mode, 'PAPER_ONLY');
  assert.equal(result.autoTrading.hardBlockReason, null);
});

test('complete P0 evidence composes into a reduction-only sizing recommendation when the existing safety chain also passes', () => {
  const result = evaluateMarketIntelligence({
    ...baseInput(),
    regimeBrain: stableRegime(),
    netAlpha: {
      asOf: NOW,
      evidenceReady: true,
      source: 'SERVER_STRATEGY_PROMOTION',
      costPolicyVersion: 'cost-v1',
      expectedGrossEdgeBps: 12,
      conformalLowerEdgeBps: 10,
      attestedNetEdgeBps: 9,
      costs: explicitCosts(),
    },
    dynamicSizing: {
      currentDrawdownPct: 3,
      parentBaseNotional: 1_000_000,
    },
  });
  assert.equal(result.regimeBrain.autoTrading.state, 'PASS');
  assert.equal(result.netAlpha.autoTrading.state, 'PASS');
  assert.equal(result.netAlpha.conservativeNetAlphaBps, 6.5);
  assert.equal(result.dynamicSizing.state, 'PASS');
  assert.equal(result.dynamicSizing.advisoryMultiplier, 0.65);
  assert.equal(result.dynamicSizing.recommendedMultiplier, 0.65);
  assert.equal(result.dynamicSizing.suggestedNotional, 650_000);
  assert.equal(result.dynamicSizing.safety.canIncreaseParentExposure, false);
  assert.equal(result.dynamicSizing.safety.reductionOnly, true);
  assert.equal(result.autoTrading.orderAllowed, false);
});

test('nested net-alpha payload cannot replace the authoritative parent clock to make stale evidence look fresh', () => {
  const staleAt = NOW - 120_000;
  const result = evaluateMarketIntelligence({
    ...baseInput(),
    netAlpha: {
      now: staleAt,
      asOf: staleAt,
      evidenceReady: true,
      source: 'SERVER_STRATEGY_PROMOTION',
      costPolicyVersion: 'cost-v1',
      expectedGrossEdgeBps: 12,
      conformalLowerEdgeBps: 10,
      attestedNetEdgeBps: 9,
      costs: explicitCosts(),
    },
    netAlphaPolicy: { enforcement: 'REQUIRED_FOR_PARENT_GATE' },
  });
  assert.equal(result.netAlpha.status, 'NOT_AVAILABLE');
  assert.equal(result.netAlpha.autoTrading.state, 'INSUFFICIENT_EVIDENCE');
  assert.ok(result.netAlpha.reasons.includes('NET_ALPHA_EVIDENCE_STALE'));
  assert.equal(result.autoTrading.mode, 'PAPER_ONLY');
  assert.equal(result.autoTrading.parentEligibilityReady, false);
});

test('nested sizing payload cannot replace computed gate evidence or parent direction', () => {
  const fakePass = { autoTrading: { state: 'PASS', reasons: [], orderAllowed: false } };
  const result = evaluateMarketIntelligence({
    ...baseInput(),
    regimeBrain: stableRegime(),
    netAlpha: {
      asOf: NOW,
      evidenceReady: true,
      source: 'SERVER_STRATEGY_PROMOTION',
      costPolicyVersion: 'cost-v1',
      expectedGrossEdgeBps: 6,
      conformalLowerEdgeBps: 2,
      attestedNetEdgeBps: 3,
      costs: explicitCosts(),
    },
    dynamicSizing: {
      direction: 'SHORT',
      currentDrawdownPct: 3,
      parentBaseNotional: 1_000_000,
      regimeBrain: { ...fakePass, regime: { label: 'TREND_UP' }, drift: { status: 'STABLE' } },
      netAlpha: { ...fakePass, conservativeNetAlphaBps: 100 },
      advancedGates: fakePass,
      executionQuality: fakePass,
      portfolioSafety: fakePass,
    },
    dynamicSizingPolicy: { enforcement: 'REQUIRED_FOR_PARENT_GATE' },
  });
  assert.equal(result.netAlpha.autoTrading.state, 'VETO');
  assert.equal(result.dynamicSizing.state, 'VETO');
  assert.equal(result.dynamicSizing.direction, 'BUY');
  assert.equal(result.dynamicSizing.recommendedMultiplier, 0);
  assert.equal(result.dynamicSizing.suggestedNotional, 0);
  assert.equal(result.autoTrading.mode, 'BLOCKED_RISK');
  assert.equal(result.autoTrading.hardBlockReason, 'CONSERVATIVE_NET_ALPHA_BELOW_MINIMUM');
  assert.equal(result.autoTrading.orderAllowed, false);
});

test('nested execution-quality clock cannot make a stale calibrated fill model look fresh', () => {
  const staleAt = NOW - 8 * 24 * 60 * 60 * 1000;
  const result = evaluateMarketIntelligence({
    ...baseInput(),
    executionQuality: {
      now: staleAt,
      bookWalk: {
        direction: 'BUY',
        targetQty: 1,
        asks: [[100, 10]],
        arrivalPrice: 100,
      },
      fillModel: {
        modelId: 'fill-model-v1',
        fillProbability: 0.9,
        evaluationSamples: 500,
        brierScore: 0.1,
        calibrationError: 0.05,
        evaluatedAt: staleAt,
      },
    },
    executionQualityPolicy: { enforcement: 'REQUIRED_FOR_PARENT_GATE' },
  });
  assert.equal(result.executionQuality.fillModel.status, 'NOT_AVAILABLE');
  assert.equal(result.executionQuality.fillModel.reason, 'FILL_MODEL_EVIDENCE_STALE');
  assert.equal(result.executionQuality.autoTrading.state, 'INSUFFICIENT_EVIDENCE');
  assert.equal(result.autoTrading.mode, 'PAPER_ONLY');
  assert.equal(result.autoTrading.parentEligibilityReady, false);
});

test('nested portfolio-safety clock cannot make an expired signal look fresh', () => {
  const staleAt = NOW - 30 * 60 * 1000;
  const result = evaluateMarketIntelligence({
    ...baseInput(),
    portfolioSafety: {
      now: staleAt,
      portfolio: {
        equityKrw: 1_000_000,
        positions: [],
        proposedNotionalKrw: 10_000,
        proposedSymbol: 'KRW-BTC',
      },
      expectedShortfall: {
        lossSamplesPct: Array.from({ length: 250 }, () => 1),
      },
      signal: {
        generatedAt: staleAt,
        revalidatedAt: staleAt,
      },
    },
    portfolioSafetyPolicy: { enforcement: 'REQUIRED_FOR_PARENT_GATE' },
  });
  assert.equal(result.portfolioSafety.signalFreshness.status, 'VETO');
  assert.equal(result.portfolioSafety.signalFreshness.reason, 'SIGNAL_TTL_EXPIRED');
  assert.equal(result.portfolioSafety.autoTrading.state, 'VETO');
  assert.equal(result.autoTrading.mode, 'BLOCKED_RISK');
  assert.equal(result.autoTrading.hardBlockReason, 'SIGNAL_TTL_EXPIRED');
  assert.equal(result.autoTrading.orderAllowed, false);
});
