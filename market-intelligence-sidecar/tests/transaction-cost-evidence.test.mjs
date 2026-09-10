import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTransactionCostEvidence } from '../src/transaction-cost-evidence.mjs';

const NOW = Date.UTC(2026, 7, 22, 5, 0, 0);

function staticPolicy(valueBps, policyVersion = 'fees-v1') {
  return {
    sourceType: 'STATIC_POLICY',
    source: 'VERSIONED_MARKET_COST_POLICY',
    valueBps,
    asOf: NOW - 24 * 60 * 60 * 1_000,
    policyVersion,
  };
}

function observed(valueBps, source = 'PUBLIC_ORDER_BOOK') {
  return {
    sourceType: 'OBSERVED_MARKET',
    source,
    valueBps,
    asOf: NOW - 30_000,
    sampleSize: 1,
  };
}

function realized(valueBps) {
  return {
    sourceType: 'REALIZED_EXECUTION',
    source: 'SETTLED_EXECUTION_TCA',
    valueBps,
    asOf: NOW - 60 * 60 * 1_000,
    sampleSize: 20,
  };
}

function calibrated(valueBps, conservativeUpperBps, modelId = 'cost-model-v1') {
  return {
    sourceType: 'CALIBRATED_MODEL',
    source: 'UNTOUCHED_COST_MODEL_EVALUATION',
    valueBps,
    conservativeUpperBps,
    asOf: NOW - 60 * 60 * 1_000,
    sampleSize: 1_000,
    modelId,
  };
}

function futuresComponents() {
  return {
    commissionBps: staticPolicy(1),
    taxBps: staticPolicy(0),
    spreadBps: observed(1),
    slippageBps: calibrated(1, 2, 'slippage-v3'),
    fundingBps: observed(0.5, 'PUBLIC_FUNDING_SNAPSHOT'),
    latencyBps: realized(0.25),
    liquidityImpactBps: calibrated(1, 1.5, 'liquidity-v2'),
    partialFillImpactBps: calibrated(0.5, 1, 'partial-fill-v2'),
  };
}

test('complete futures evidence exposes point and conservative cost vectors without granting authority', () => {
  const result = evaluateTransactionCostEvidence({
    now: NOW,
    market: 'CRYPTO_FUTURES',
    evidenceSetVersion: 'cost-evidence-2026-08-22-v1',
    components: futuresComponents(),
  });

  assert.equal(result.status, 'READY');
  assert.equal(result.readyForNetAlpha, true);
  assert.equal(result.totalPointCostBps, 5.25);
  assert.equal(result.totalConservativeCostBps, 7.25);
  assert.equal(result.pointCosts.slippageBps, 1);
  assert.equal(result.conservativeCosts.slippageBps, 2);
  assert.equal(result.components.taxBps.valueBps, 0);
  assert.equal(result.safety.executionAuthority, 'NONE');
  assert.equal(result.safety.orderAllowed, false);
  assert.equal(result.safety.promotionAuthority, false);
  assert.equal(result.safety.liveTradingAuthority, false);
});

for (const market of ['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT']) {
  test(`${market} accepts funding zero only as explicit structural not-applicable evidence`, () => {
    const components = futuresComponents();
    components.fundingBps = {
      sourceType: 'NOT_APPLICABLE',
      notApplicableReason: 'NON_FUTURES_MARKET',
    };
    const result = evaluateTransactionCostEvidence({
      now: NOW,
      market,
      evidenceSetVersion: `cost-${market}-v1`,
      components,
    });
    assert.equal(result.status, 'READY');
    assert.equal(result.pointCosts.fundingBps, 0);
    assert.equal(result.conservativeCosts.fundingBps, 0);
    assert.equal(result.components.fundingBps.source, 'STRUCTURAL_MARKET_RULE');
  });
}

test('crypto futures cannot mark funding as not applicable', () => {
  const components = futuresComponents();
  components.fundingBps = {
    sourceType: 'NOT_APPLICABLE',
    notApplicableReason: 'TRY_TO_SKIP_FUNDING',
  };
  const result = evaluateTransactionCostEvidence({
    now: NOW,
    market: 'CRYPTO_FUTURES',
    evidenceSetVersion: 'cost-futures-v2',
    components,
  });
  assert.equal(result.status, 'NOT_AVAILABLE');
  assert.equal(result.readyForNetAlpha, false);
  assert.ok(result.reasons.includes('fundingBps:COST_NOT_APPLICABLE_NOT_ALLOWED'));
  assert.equal(result.pointCosts.fundingBps, null);
  assert.equal(result.totalConservativeCostBps, null);
});

test('missing cost evidence remains null and cannot silently become zero', () => {
  const components = futuresComponents();
  delete components.spreadBps;
  const result = evaluateTransactionCostEvidence({
    now: NOW,
    market: 'CRYPTO_FUTURES',
    evidenceSetVersion: 'cost-missing-v1',
    components,
  });
  assert.equal(result.status, 'NOT_AVAILABLE');
  assert.equal(result.pointCosts.spreadBps, null);
  assert.equal(result.conservativeCosts.spreadBps, null);
  assert.equal(result.totalPointCostBps, null);
  assert.ok(result.reasons.includes('spreadBps:COST_COMPONENT_EVIDENCE_MISSING'));
});

test('stale observed spread evidence fails closed instead of being reused', () => {
  const components = futuresComponents();
  components.spreadBps = {
    ...observed(1),
    asOf: NOW - 3 * 60_000,
  };
  const result = evaluateTransactionCostEvidence({
    now: NOW,
    market: 'CRYPTO_FUTURES',
    evidenceSetVersion: 'cost-stale-v1',
    components,
  });
  assert.equal(result.status, 'NOT_AVAILABLE');
  assert.ok(result.reasons.includes('spreadBps:COST_EVIDENCE_STALE'));
});

test('calibrated cost models need enough untouched samples and a conservative upper bound', () => {
  const lowSample = futuresComponents();
  lowSample.slippageBps = {
    ...calibrated(1, 2),
    sampleSize: 100,
  };
  const lowSampleResult = evaluateTransactionCostEvidence({
    now: NOW,
    market: 'CRYPTO_FUTURES',
    evidenceSetVersion: 'cost-model-low-n-v1',
    components: lowSample,
  });
  assert.equal(lowSampleResult.status, 'NOT_AVAILABLE');
  assert.ok(lowSampleResult.reasons.includes('slippageBps:COST_MODEL_SAMPLE_INSUFFICIENT'));

  const noUpper = futuresComponents();
  noUpper.liquidityImpactBps = {
    ...calibrated(1, 1.5),
    conservativeUpperBps: null,
  };
  const noUpperResult = evaluateTransactionCostEvidence({
    now: NOW,
    market: 'CRYPTO_FUTURES',
    evidenceSetVersion: 'cost-model-upper-v1',
    components: noUpper,
  });
  assert.equal(noUpperResult.status, 'NOT_AVAILABLE');
  assert.ok(noUpperResult.reasons.includes('liquidityImpactBps:COST_MODEL_CONSERVATIVE_UPPER_BOUND_INVALID'));
});

test('explicit measured or policy zero is preserved as valid evidence', () => {
  const components = futuresComponents();
  components.taxBps = staticPolicy(0, 'tax-policy-zero-v2');
  const result = evaluateTransactionCostEvidence({
    now: NOW,
    market: 'CRYPTO_FUTURES',
    evidenceSetVersion: 'cost-zero-v1',
    components,
  });
  assert.equal(result.status, 'READY');
  assert.equal(result.components.taxBps.valueBps, 0);
  assert.equal(result.components.taxBps.policyVersion, 'tax-policy-zero-v2');
});
