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

test('complete regime and alpha evidence produce only a reduction advisory until the rest of the sizing chain is evidenced', () => {
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
  assert.ok(result.dynamicSizing.advisoryMultiplier <= 1);
  assert.equal(result.dynamicSizing.recommendedMultiplier, null);
  assert.equal(result.dynamicSizing.suggestedNotional, null);
  assert.equal(result.dynamicSizing.safety.canIncreaseParentExposure, false);
  assert.equal(result.autoTrading.orderAllowed, false);
});
