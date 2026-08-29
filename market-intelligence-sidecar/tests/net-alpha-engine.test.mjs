import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateNetAlpha } from '../src/net-alpha-engine.mjs';

const NOW = Date.UTC(2026, 7, 22, 3, 20, 0);
const IDENTITY = Object.freeze({
  strategyId: 'scanner-12-strategy',
  strategyVersion: 'v7',
  parameterHash: 'param-hash-v7',
  researchCodeSha: 'a'.repeat(40),
  market: 'CRYPTO_FUTURES',
  symbol: 'BTCUSDT',
  timeframe: '15m',
  horizon: 15,
  direction: 'LONG',
});

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
    costAsOf: NOW - 5_000,
    market: 'CRYPTO_FUTURES',
    evidenceReady: true,
    forwardDataComplete: true,
    fullCostReady: true,
    evidenceComplete: 1,
    profitabilityProven: true,
    source: 'forward-recommendation-profit-calibration-v2',
    sourceSchemaVersion: 'forward-calibration-gross-edge-v2',
    grossEvidenceSource: 'LIVE_RECOMMENDATION',
    costSource: 'FULL_COST_EVIDENCE_V1',
    costPolicyVersion: 'cost-v7',
    grossIdentity: { ...IDENTITY },
    costIdentity: { ...IDENTITY },
    expectedGrossEdgeBps: 20,
    conformalLowerEdgeBps: 15,
    attestedNetEdgeBps: 15,
    costs: costs(),
    ...overrides,
  };
}

test('passes only after every authoritative readiness gate explicit cost and identity lineage are present', () => {
  const result = evaluateNetAlpha(readyInput());
  assert.equal(result.status, 'READY');
  assert.equal(result.totalExpectedCostBps, 5);
  assert.equal(result.expectedNetEdgeBps, 15);
  assert.equal(result.conservativeNetAlphaBps, 10);
  assert.equal(result.decision, 'TAKE');
  assert.equal(result.autoTrading.state, 'PASS');
  assert.equal(result.readiness.forwardDataComplete, true);
  assert.equal(result.readiness.fullCostReady, true);
  assert.equal(result.readiness.evidenceComplete, true);
  assert.equal(result.readiness.profitabilityProven, true);
  assert.equal(result.profitabilityClaimAllowed, false);
  assert.equal(result.safety.aiNumericalAuthority, false);
  assert.equal(result.safety.executionAuthority, 'NONE');
  assert.equal(result.safety.liveTrading, false);
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

test('gross edge or conformal lower edge missing keeps Net Alpha unavailable', () => {
  const grossMissing = evaluateNetAlpha(readyInput({ expectedGrossEdgeBps: Number.NaN }));
  assert.equal(grossMissing.status, 'NOT_AVAILABLE');
  assert.ok(grossMissing.reasons.includes('EXPECTED_GROSS_EDGE_NOT_AVAILABLE'));

  const lowerMissing = evaluateNetAlpha(readyInput({ conformalLowerEdgeBps: null }));
  assert.equal(lowerMissing.status, 'NOT_AVAILABLE');
  assert.ok(lowerMissing.reasons.includes('CONFORMAL_LOWER_EDGE_NOT_AVAILABLE'));
});

test('Forward Data Full Cost and Evidence Complete readiness are independent hard gates', () => {
  const forwardBlocked = evaluateNetAlpha(readyInput({ forwardDataComplete: false }));
  assert.equal(forwardBlocked.status, 'NOT_AVAILABLE');
  assert.ok(forwardBlocked.reasons.includes('FORWARD_DATA_INCOMPLETE'));

  const fullCostBlocked = evaluateNetAlpha(readyInput({ fullCostReady: false }));
  assert.equal(fullCostBlocked.status, 'NOT_AVAILABLE');
  assert.ok(fullCostBlocked.reasons.includes('FULL_COST_NOT_READY'));

  const evidenceBlocked = evaluateNetAlpha(readyInput({ evidenceComplete: 0 }));
  assert.equal(evidenceBlocked.status, 'NOT_AVAILABLE');
  assert.ok(evidenceBlocked.reasons.includes('EVIDENCE_COMPLETE_NOT_READY'));
});

test('numeric strings cannot manufacture readiness gross edge or cost evidence', () => {
  const evidenceString = evaluateNetAlpha(readyInput({ evidenceComplete: '1' }));
  assert.equal(evidenceString.status, 'NOT_AVAILABLE');
  assert.ok(evidenceString.reasons.includes('EVIDENCE_COMPLETE_NOT_READY'));

  const grossString = evaluateNetAlpha(readyInput({ expectedGrossEdgeBps: '20' }));
  assert.equal(grossString.status, 'NOT_AVAILABLE');
  assert.ok(grossString.reasons.includes('EXPECTED_GROSS_EDGE_NOT_AVAILABLE'));

  const costString = evaluateNetAlpha(readyInput({ costs: costs({ slippageBps: '1' }) }));
  assert.equal(costString.status, 'NOT_AVAILABLE');
  assert.ok(costString.reasons.includes('COST_EVIDENCE_MISSING:slippageBps'));
});

test('missing or partial cost evidence stays unavailable rather than assuming zero', () => {
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

test('canonical Gross Edge source schema and identity lineage are mandatory', () => {
  const wrongSource = evaluateNetAlpha(readyInput({ source: 'scanner-score' }));
  assert.equal(wrongSource.status, 'NOT_AVAILABLE');
  assert.ok(wrongSource.reasons.includes('CANONICAL_GROSS_EDGE_SOURCE_REQUIRED'));

  const wrongEvidenceSource = evaluateNetAlpha(readyInput({ grossEvidenceSource: 'SYNTHETIC' }));
  assert.equal(wrongEvidenceSource.status, 'NOT_AVAILABLE');
  assert.ok(wrongEvidenceSource.reasons.includes('CANONICAL_GROSS_EDGE_EVIDENCE_SOURCE_REQUIRED'));

  const wrongSchema = evaluateNetAlpha(readyInput({ sourceSchemaVersion: 'v1' }));
  assert.equal(wrongSchema.status, 'NOT_AVAILABLE');
  assert.ok(wrongSchema.reasons.includes('CANONICAL_GROSS_EDGE_SCHEMA_REQUIRED'));

  const missingIdentity = evaluateNetAlpha(readyInput({ grossIdentity: null }));
  assert.equal(missingIdentity.status, 'NOT_AVAILABLE');
  assert.ok(missingIdentity.reasons.includes('GROSS_IDENTITY_PROVENANCE_NOT_AVAILABLE'));

  const mismatch = evaluateNetAlpha(readyInput({
    costIdentity: { ...IDENTITY, horizon: 60 },
  }));
  assert.equal(mismatch.status, 'NOT_AVAILABLE');
  assert.ok(mismatch.reasons.includes('NET_ALPHA_IDENTITY_MISMATCH'));
});

test('cost provenance and clock are mandatory and independently fail closed', () => {
  const noClock = evaluateNetAlpha(readyInput({ now: undefined }));
  assert.equal(noClock.status, 'NOT_AVAILABLE');
  assert.ok(noClock.reasons.includes('AUTHORITATIVE_CLOCK_NOT_AVAILABLE'));

  const noSource = evaluateNetAlpha(readyInput({ costSource: '' }));
  assert.equal(noSource.status, 'NOT_AVAILABLE');
  assert.ok(noSource.reasons.includes('FULL_COST_SOURCE_REQUIRED'));

  const stale = evaluateNetAlpha(readyInput({ costAsOf: NOW - 120_000 }));
  assert.equal(stale.status, 'NOT_AVAILABLE');
  assert.ok(stale.reasons.includes('COST_EVIDENCE_STALE'));

  const future = evaluateNetAlpha(readyInput({ costAsOf: NOW + 5_000 }));
  assert.equal(future.status, 'NOT_AVAILABLE');
  assert.ok(future.reasons.includes('COST_EVIDENCE_FROM_FUTURE'));
});

test('non-finite and negative cost components cannot enter the sum', () => {
  const nonFinite = evaluateNetAlpha(readyInput({ costs: costs({ slippageBps: Number.POSITIVE_INFINITY }) }));
  assert.equal(nonFinite.status, 'NOT_AVAILABLE');
  assert.ok(nonFinite.reasons.includes('COST_EVIDENCE_MISSING:slippageBps'));

  const negative = evaluateNetAlpha(readyInput({ costs: costs({ latencyBps: -0.1 }) }));
  assert.equal(negative.status, 'NOT_AVAILABLE');
  assert.ok(negative.reasons.includes('COST_EVIDENCE_INVALID:latencyBps'));
});

test('gross and cost freshness use the authoritative parent clock and reject future evidence', () => {
  const staleGross = evaluateNetAlpha(readyInput({ asOf: NOW - 120_000 }));
  assert.ok(staleGross.reasons.includes('NET_ALPHA_EVIDENCE_STALE'));

  const futureGross = evaluateNetAlpha(readyInput({ asOf: NOW + 5_000 }));
  assert.ok(futureGross.reasons.includes('NET_ALPHA_EVIDENCE_FROM_FUTURE'));
});

test('server attestation mismatch fails closed instead of trusting either number', () => {
  const result = evaluateNetAlpha(readyInput({ attestedNetEdgeBps: 9 }));
  assert.equal(result.status, 'NOT_AVAILABLE');
  assert.equal(result.autoTrading.state, 'INSUFFICIENT_EVIDENCE');
  assert.ok(result.reasons.includes('NET_EDGE_ATTESTATION_MISMATCH'));
});

test('request-supplied Net Alpha thresholds and freshness windows cannot weaken canonical policy', () => {
  assert.throws(
    () => evaluateNetAlpha(readyInput(), { maxEvidenceAgeMs: 120_000 }),
    /NET_ALPHA_POLICY_OVERRIDE_NOT_ALLOWED:maxEvidenceAgeMs/,
  );
  assert.throws(
    () => evaluateNetAlpha(readyInput(), { minConservativeNetAlphaBps: -10 }),
    /NET_ALPHA_POLICY_OVERRIDE_NOT_ALLOWED:minConservativeNetAlphaBps/,
  );
  const required = evaluateNetAlpha(readyInput(), { enforcement: 'REQUIRED_FOR_PARENT_GATE' });
  assert.equal(required.policy.enforcement, 'REQUIRED_FOR_PARENT_GATE');
  assert.equal(required.policy.minConservativeNetAlphaBps, 1);
});
