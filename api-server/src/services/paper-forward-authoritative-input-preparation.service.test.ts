import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PAPER_FORWARD_AUTHORITATIVE_INPUT_PREPARATION_VERSION,
  preparePaperForwardAuthoritativeInputs,
} from './paper-forward-authoritative-input-preparation.service';

const SHA = 'a'.repeat(40);
const NOW = 1_800_000_000_000;

function baseInput() {
  return {
    researchCodeSha: SHA,
    riskPolicyRecord: {
      schemaVersion: 'authoritative-paper-generic-risk-policy-record-v1',
      recordId: 'risk-record-1',
      recordVersion: 'v1',
      policyId: 'paper-risk-v1',
      policyVersion: 'v1',
      source: 'OWNER_APPROVED_CANONICAL_RECORD',
      provenance: ['owner-approved'],
      observedAtMs: NOW - 1_000,
      maximumAgeMs: 30_000,
      researchCodeSha: SHA,
      marketScopes: ['CRYPTO_FUTURES'],
      strategyScopes: ['strategy-v1'],
      symbolScopes: ['BTCUSDT'],
      riskPercent: 0.5,
      requestedLeverage: 2,
      maximumLeverage: 10,
      marginMode: 'isolated',
    },
    riskPolicyRequest: {
      market: 'CRYPTO_FUTURES',
      symbol: 'BTCUSDT',
      strategyScope: 'strategy-v1',
      researchCodeSha: SHA,
    },
    costPolicyId: 'cost-policy-v1',
    liquidity: {
      calibrationArtifactInput: {},
      producerOutput: {},
      liquidityImpactFirewallInput: {
        expected: {
          market: 'CRYPTO_FUTURES',
          symbol: 'BTCUSDT',
          side: 'LONG',
        },
      },
      bridge: {},
    },
    partialFill: {
      artifact: null,
      expected: {
        market: 'CRYPTO_FUTURES',
        symbol: 'BTCUSDT',
        side: 'LONG',
        quantityNotionalBucketIdentity: 'bucket',
        volatilityRegimeIdentity: 'vol',
        liquidityRegimeIdentity: 'liq',
        producerCodeSha: SHA,
        calibrationCodeSha: SHA,
        nowMs: NOW,
        maximumAgeMs: 30_000,
        competingCostEvidence: [],
      },
    },
    nowMs: NOW,
    maximumAgeMs: 30_000,
  };
}

function readyDependencies() {
  return {
    createRiskProducer: () => async () => ({
      status: 'PRESENT',
      policyEvidence: { schemaVersion: 'authoritative-paper-generic-risk-policy-evidence-v1' },
      blockers: [],
    }),
    buildLiquidity: () => ({
      status: 'PRESENT',
      liquidityImpactStatus: 'PRESENT',
      evidence: {
        valuePercent: 0.02,
        quality: 'ESTIMATED',
        source: 'GENUINE_LIQUIDITY_RUNTIME',
        observedAtMs: NOW - 2_000,
      },
      blockers: [],
    }),
    buildPartialFill: () => ({
      status: 'PRESENT',
      evidence: {
        valuePercent: 0.01,
        quality: 'ESTIMATED',
        source: 'GENUINE_PARTIAL_FILL_CALIBRATION',
        observedAtMs: NOW - 3_000,
      },
      blockers: [],
    }),
  };
}

test('READY packages only existing validated evidence and creates zero credit', async () => {
  const result = await preparePaperForwardAuthoritativeInputs(baseInput(), readyDependencies());
  assert.equal(result.schemaVersion, PAPER_FORWARD_AUTHORITATIVE_INPUT_PREPARATION_VERSION);
  assert.equal(result.status, 'READY');
  assert.equal(result.supplementalCostInput?.liquidityImpact.valuePercent, 0.02);
  assert.equal(result.supplementalCostInput?.partialFillImpact.valuePercent, 0.01);
  assert.equal(result.supplementalCostInput?.observedAtMs, NOW - 3_000);
  assert.equal(result.evidenceClasses.latency, 'RUNTIME_MEASURED_LATER');
  assert.equal(result.evidenceClasses.funding, 'CANDIDATE_BOUND_RUNTIME_LATER');
  assert.equal(result.economicCreditCreated, false);
  assert.equal(result.profitabilityCredit, 0);
  assert.equal(result.executionAuthority, 'NONE');
  assert.equal(result.liveTrading, false);
});

test('missing liquidity evidence remains BLOCKED_DATA and no files become ready', async () => {
  const deps = readyDependencies();
  const result = await preparePaperForwardAuthoritativeInputs(baseInput(), {
    ...deps,
    buildLiquidity: () => ({
      status: 'BLOCKED_DATA',
      liquidityImpactStatus: 'BLOCKED_DATA',
      evidence: null,
      blockers: ['LIQUIDITY_CALIBRATION_NOT_READY'],
    }),
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.equal(result.riskPolicyRecord, null);
  assert.equal(result.supplementalCostInput, null);
  assert.ok(result.blockers.includes('LIQUIDITY:LIQUIDITY_CALIBRATION_NOT_READY'));
});

test('missing partial-fill evidence remains BLOCKED_DATA', async () => {
  const deps = readyDependencies();
  const result = await preparePaperForwardAuthoritativeInputs(baseInput(), {
    ...deps,
    buildPartialFill: () => ({
      status: 'BLOCKED_DATA',
      evidence: null,
      blockers: ['PARTIAL_FILL_CALIBRATION_ARTIFACT_REQUIRED'],
    }),
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('PARTIAL_FILL:PARTIAL_FILL_CALIBRATION_ARTIFACT_REQUIRED'));
});

test('stale evidence cannot be packaged as zero or READY', async () => {
  const deps = readyDependencies();
  const result = await preparePaperForwardAuthoritativeInputs(baseInput(), {
    ...deps,
    buildLiquidity: () => ({
      status: 'PRESENT',
      liquidityImpactStatus: 'PRESENT',
      evidence: {
        valuePercent: 0,
        quality: 'ESTIMATED',
        source: 'MEASURED_ZERO_WITH_PROVENANCE',
        observedAtMs: NOW - 60_000,
      },
      blockers: [],
    }),
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('LIQUIDITY:EVIDENCE_STALE_AT_PREPARATION'));
});

test('cross-source scope mismatch fails before validator execution', async () => {
  const input = baseInput();
  input.partialFill.expected.symbol = 'ETHUSDT';
  const result = await preparePaperForwardAuthoritativeInputs(input, {
    createRiskProducer: () => {
      throw new Error('must not execute');
    },
    buildLiquidity: () => {
      throw new Error('must not execute');
    },
    buildPartialFill: () => {
      throw new Error('must not execute');
    },
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('PREPARATION_PARTIAL_FILL_SCOPE_MISMATCH'));
});

test('invalid exact research SHA fails closed', async () => {
  const input = baseInput();
  input.researchCodeSha = 'not-a-sha';
  const result = await preparePaperForwardAuthoritativeInputs(input, {});
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('PREPARATION_EXACT_RESEARCH_SHA_REQUIRED'));
});
