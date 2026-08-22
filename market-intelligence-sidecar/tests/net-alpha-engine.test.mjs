import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateNetAlpha } from '../src/net-alpha-engine.mjs';

const NOW = Date.UTC(2026, 7, 22, 3, 20, 0);

function costs(overrides = {}) {
  return {
    commissionBps: 0.5,
    taxBps: 0,
    spreadBps: 1,
    slippageBps: 1,
    fundingBps: 0.5,
    latencyBps: 0.5,
    liquidityImpactBps: 0.5,
    partialFillImpactBps: 1,
    ...overrides,
  };
}

function readyInput(overrides = {}) {
  return {
    now: NOW,
    asOf: NOW - 5_000,
    market: 'CRYPTO_FUTURES',
    evidenceReady: true,
    source: 'SERVER_STRATEGY_PROMOTION',
    costPolicyVersion: 'cost-v7',
    expectedGrossEdgeBps: 20,
    conformalLowerEdgeBps: 15,
    attestedNetEdgeBps: 15,
    costs: costs(),
    ...overrides,
  };
}

test('passes only after every explicit expected cost is deducted from the conservative edge', () => {
  const result = evaluateNetAlpha(readyInput());
  assert.equal(result.status, 'READY');
  assert.equal(result.totalExpectedCostBps, 5);
  assert.equal(result.expectedNetEdgeBps, 15);
  assert.equal(result.conservativeNetAlphaBps, 10);
  assert.equal(result.decision, 'TAKE');
  assert.equal(result.autoTrading.state, 'PASS');
  assert.equal(result.safety.executionAuthority, 'NONE');
  assert.equal(result.safety.orderAllowed, false);
});

test('positive point estimate is skipped when the conservative lower edge is not positive after costs', () => {
  const result = evaluateNetAlpha(readyInput({
    conformalLowerEdgeBps: 4,
    attestedNetEdgeBps: 15,
  }));
  assert.equal(result.expectedNetEdgeBps, 15);
  assert.equal(result.conservativeNetAlphaBps, -1);
  assert.equal(result.decision, 'SKIP');
  assert.equal(result.autoTrading.state, 'VETO');
  assert.ok(result.reasons.includes('CONSERVATIVE_NET_ALPHA_BELOW_MINIMUM'));
});

test('missing cost evidence stays unavailable rather than assuming zero', () => {
  const explicit = costs();
  delete explicit.liquidityImpactBps;
  const result = evaluateNetAlpha(readyInput({ costs: explicit }));
  assert.equal(result.status, 'NOT_AVAILABLE');
  assert.equal(result.decision, 'NOT_AVAILABLE');
  assert.equal(result.autoTrading.state, 'INSUFFICIENT_EVIDENCE');
  assert.ok(result.reasons.includes('COST_EVIDENCE_MISSING:liquidityImpactBps'));
});

test('an explicitly measured zero cost is valid evidence', () => {
  const zeroCosts = Object.fromEntries(Object.keys(costs()).map((key) => [key, 0]));
  const result = evaluateNetAlpha(readyInput({
    costs: zeroCosts,
    attestedNetEdgeBps: 20,
  }));
  assert.equal(result.totalExpectedCostBps, 0);
  assert.equal(result.expectedNetEdgeBps, 20);
  assert.equal(result.conservativeNetAlphaBps, 15);
  assert.equal(result.autoTrading.state, 'PASS');
});

test('server attestation mismatch fails closed instead of trusting either number', () => {
  const result = evaluateNetAlpha(readyInput({ attestedNetEdgeBps: 9 }));
  assert.equal(result.status, 'NOT_AVAILABLE');
  assert.equal(result.autoTrading.state, 'INSUFFICIENT_EVIDENCE');
  assert.ok(result.reasons.includes('NET_EDGE_ATTESTATION_MISMATCH'));
});
