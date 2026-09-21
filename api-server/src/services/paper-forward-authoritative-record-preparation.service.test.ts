import assert from 'node:assert/strict';
import test from 'node:test';

import {
  preparePaperForwardAuthoritativeRecords,
  PAPER_FORWARD_AUTHORITATIVE_RECORD_PREPARATION_SAFETY,
} from './paper-forward-authoritative-record-preparation.service';

const SHA = 'a'.repeat(40);
const DIGEST_A = 'b'.repeat(64);
const DIGEST_B = 'c'.repeat(64);
const NOW = 1_800_000_000_000;

function riskRecord() {
  return {
    schemaVersion: 'authoritative-paper-generic-risk-policy-record-v1',
    recordId: 'risk-record-v1',
    recordVersion: 'v1',
    policyId: 'paper-risk-policy-v1',
    policyVersion: 'v1',
    source: 'EXPLICIT_HUMAN_CANONICAL_RECORD',
    provenance: ['human-approved-record'],
    observedAtMs: NOW - 1_000,
    maximumAgeMs: 60_000,
    researchCodeSha: SHA,
    marketScopes: ['CRYPTO_FUTURES'],
    strategyScopes: ['strategy-v1'],
    symbolScopes: ['BTCUSDT'],
    riskPercent: 0.5,
    requestedLeverage: 2,
    maximumLeverage: 3,
    marginMode: 'isolated',
  };
}

function baseInput() {
  return {
    targetSha: SHA,
    market: 'CRYPTO_FUTURES' as const,
    symbol: 'BTCUSDT',
    strategyScope: 'strategy-v1',
    side: 'LONG' as const,
    costPolicyId: 'cost-policy-v1',
    riskPolicyRecord: riskRecord(),
    liquidityRuntimeInput: {
      liquidityImpactFirewallInput: {
        expected: {
          market: 'CRYPTO_FUTURES',
          symbol: 'BTCUSDT',
          side: 'LONG',
        },
      },
    },
    partialFillArtifact: {} as never,
    partialFillExpected: {
      market: 'CRYPTO_FUTURES',
      symbol: 'BTCUSDT',
      side: 'LONG',
      producerCodeSha: SHA,
      calibrationCodeSha: SHA,
      quantityNotionalBucketIdentity: 'bucket-v1',
      volatilityRegimeIdentity: 'vol-v1',
      liquidityRegimeIdentity: 'liq-v1',
      maximumAgeMs: 60_000,
      nowMs: NOW,
      competingCostEvidence: [],
    } as never,
    nowMs: NOW,
  };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    validateRiskPolicy: async () => ({
      status: 'PRESENT' as const,
      blockers: [],
      executionAuthority: 'NONE',
      privateApiAllowed: false,
      liveTrading: false,
      realOrderAllowed: false,
      financialMutationAllowed: false,
    }),
    buildLiquidityEvidence: () => ({
      status: 'PRESENT',
      liquidityImpactStatus: 'PRESENT',
      evidence: {
        valuePercent: 0.02,
        quality: 'ESTIMATED',
        source: 'genuine-liquidity-runtime',
        observedAtMs: NOW - 2_000,
      },
      liquidityImpactArtifactDigest: DIGEST_A,
      runtimeCostCredit: 0,
      evidenceComplete: 0,
      fullCostReady: false,
      profitabilityProven: false,
      executionAuthority: 'NONE',
      privateApiUsed: false,
      liveTrading: false,
      orderSubmitted: false,
      unknownCostIsZero: false,
    }),
    buildPartialFillEvidence: () => ({
      status: 'PRESENT',
      evidence: {
        valuePercent: 0.01,
        quality: 'ESTIMATED',
        source: 'genuine-partial-fill-calibration',
        observedAtMs: NOW - 3_000,
      },
      artifactDigest: DIGEST_B,
      executionAuthority: 'NONE',
      privateApiUsed: false,
      liveTrading: false,
      realFillObserved: false,
      publicDepthIsRealFillProof: false,
      unknownCostIsZero: false,
    }),
    ...overrides,
  } as never;
}

test('prepares exact risk record and only validated liquidity/partial-fill supplemental components', async () => {
  const input = baseInput();
  const result = await preparePaperForwardAuthoritativeRecords(input, dependencies());

  assert.equal(result.status, 'PREPARED');
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.riskPolicyRecord, input.riskPolicyRecord);
  assert.equal(result.supplementalCostRecord?.costPolicyId, 'cost-policy-v1');
  assert.equal(result.supplementalCostRecord?.observedAtMs, NOW - 3_000);
  assert.equal(result.supplementalCostRecord?.liquidityImpact.valuePercent, 0.02);
  assert.equal(result.supplementalCostRecord?.partialFillImpact.valuePercent, 0.01);
  assert.equal(result.supplementalCostRecord?.evidenceBindings.liquidityImpactArtifactDigest, DIGEST_A);
  assert.equal(result.supplementalCostRecord?.evidenceBindings.partialFillArtifactDigest, DIGEST_B);
  assert.equal(result.economicCreditCreated, false);
  assert.equal(result.executionAuthority, 'NONE');
});

test('does not invent or normalize financial policy values', async () => {
  const input = baseInput();
  const custom = {
    ...riskRecord(),
    riskPercent: 0.37,
    requestedLeverage: 3,
    marginMode: 'cross',
  };
  input.riskPolicyRecord = custom;
  const result = await preparePaperForwardAuthoritativeRecords(input, dependencies());
  assert.equal(result.status, 'PREPARED');
  assert.equal(result.riskPolicyRecord?.riskPercent, 0.37);
  assert.equal(result.riskPolicyRecord?.requestedLeverage, 3);
  assert.equal(result.riskPolicyRecord?.marginMode, 'cross');
});

test('fails closed on candidate/evidence scope mismatch before preparation', async () => {
  const input = baseInput();
  input.liquidityRuntimeInput = {
    liquidityImpactFirewallInput: {
      expected: { market: 'CRYPTO_FUTURES', symbol: 'ETHUSDT', side: 'LONG' },
    },
  };
  const result = await preparePaperForwardAuthoritativeRecords(input, dependencies());
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('LIQUIDITY_RUNTIME_SCOPE_MISMATCH'));
  assert.equal(result.supplementalCostRecord, null);
});

test('fails closed when canonical risk policy is absent or invalid', async () => {
  const result = await preparePaperForwardAuthoritativeRecords(
    baseInput(),
    dependencies({
      validateRiskPolicy: async () => ({
        status: 'BLOCKED_DATA',
        blockers: ['RISK_POLICY_CANONICAL_RECORD_MISSING'],
        executionAuthority: 'NONE',
        privateApiAllowed: false,
        liveTrading: false,
        realOrderAllowed: false,
        financialMutationAllowed: false,
      }),
    }),
  );
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('RISK_POLICY_CANONICAL_RECORD_MISSING'));
});

test('fails closed when either measured cost component is not PRESENT', async () => {
  const result = await preparePaperForwardAuthoritativeRecords(
    baseInput(),
    dependencies({
      buildPartialFillEvidence: () => ({
        status: 'BLOCKED_DATA',
        blockers: ['PARTIAL_FILL_OOS_VALIDATION_REFERENCE_INVALID'],
        executionAuthority: 'NONE',
        privateApiUsed: false,
        liveTrading: false,
        realFillObserved: false,
        publicDepthIsRealFillProof: false,
        unknownCostIsZero: false,
      }),
    }),
  );
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('PARTIAL_FILL_RUNTIME_EVIDENCE_NOT_PRESENT'));
  assert.equal(result.supplementalCostRecord, null);
});

test('safety contract grants no activation, server, trading, or economic authority', () => {
  assert.equal(PAPER_FORWARD_AUTHORITATIVE_RECORD_PREPARATION_SAFETY.riskPolicyDefaultsAllowed, false);
  assert.equal(PAPER_FORWARD_AUTHORITATIVE_RECORD_PREPARATION_SAFETY.missingCostConvertedToZero, false);
  assert.equal(PAPER_FORWARD_AUTHORITATIVE_RECORD_PREPARATION_SAFETY.scheduleActivationAuthority, false);
  assert.equal(PAPER_FORWARD_AUTHORITATIVE_RECORD_PREPARATION_SAFETY.serverMutationAuthority, false);
  assert.equal(PAPER_FORWARD_AUTHORITATIVE_RECORD_PREPARATION_SAFETY.economicCreditCreated, false);
  assert.equal(PAPER_FORWARD_AUTHORITATIVE_RECORD_PREPARATION_SAFETY.executionAuthority, 'NONE');
});
