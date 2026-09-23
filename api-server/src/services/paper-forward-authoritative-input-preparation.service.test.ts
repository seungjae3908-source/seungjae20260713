import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PAPER_FORWARD_AUTHORITATIVE_INPUT_PREPARATION_SAFETY,
  PAPER_FORWARD_AUTHORITATIVE_INPUT_PREPARATION_VERSION,
  preparePaperForwardAuthoritativeInputs,
  type PaperForwardAuthoritativeInputPreparationInput,
} from './paper-forward-authoritative-input-preparation.service';
import {
  PARTIAL_FILL_CALIBRATION_POLICY_MAXIMUM_AGE_MS,
} from './authoritative-paper-partial-fill-cost-evidence.service';

const SHA = 'a'.repeat(40);
const NOW = 1_800_000_000_000;

function baseInput(): PaperForwardAuthoritativeInputPreparationInput {
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

function readyDependencies(): any {
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

test('preparation passes frozen calibration freshness separately from runtime freshness', async () => {
  const deps = readyDependencies();
  let receivedExpected: any = null;
  const result = await preparePaperForwardAuthoritativeInputs(baseInput(), {
    ...deps,
    buildPartialFill: (value: any) => {
      receivedExpected = value.expected;
      return deps.buildPartialFill(value);
    },
  });
  assert.equal(result.status, 'READY');
  assert.equal(receivedExpected.maximumAgeMs, 30_000);
  assert.equal(
    receivedExpected.calibrationMaximumAgeMs,
    PARTIAL_FILL_CALIBRATION_POLICY_MAXIMUM_AGE_MS,
  );
  assert.equal(
    PAPER_FORWARD_AUTHORITATIVE_INPUT_PREPARATION_SAFETY.partialFillCalibrationMaximumAgeMs,
    PARTIAL_FILL_CALIBRATION_POLICY_MAXIMUM_AGE_MS,
  );
  assert.equal(
    PAPER_FORWARD_AUTHORITATIVE_INPUT_PREPARATION_SAFETY.partialFillCalibrationAndRuntimeFreshnessSeparated,
    true,
  );
});

test('caller cannot widen the frozen calibration freshness through preparation input', async () => {
  const input = structuredClone(baseInput()) as any;
  input.partialFill.expected.calibrationMaximumAgeMs =
    PARTIAL_FILL_CALIBRATION_POLICY_MAXIMUM_AGE_MS * 10;
  const deps = readyDependencies();
  let receivedExpected: any = null;
  const result = await preparePaperForwardAuthoritativeInputs(input, {
    ...deps,
    buildPartialFill: (value: any) => {
      receivedExpected = value.expected;
      return deps.buildPartialFill(value);
    },
  });
  assert.equal(result.status, 'READY');
  assert.equal(
    receivedExpected.calibrationMaximumAgeMs,
    PARTIAL_FILL_CALIBRATION_POLICY_MAXIMUM_AGE_MS,
  );
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

test('future-dated liquidity evidence cannot bypass preparation freshness', async () => {
  const deps = readyDependencies();
  const result = await preparePaperForwardAuthoritativeInputs(baseInput(), {
    ...deps,
    buildLiquidity: () => ({
      status: 'PRESENT',
      liquidityImpactStatus: 'PRESENT',
      evidence: {
        valuePercent: 0.02,
        quality: 'ESTIMATED',
        source: 'GENUINE_LIQUIDITY_RUNTIME',
        observedAtMs: NOW + 1,
      },
      blockers: [],
    }),
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.equal(result.supplementalCostInput, null);
  assert.ok(result.blockers.includes('LIQUIDITY:EVIDENCE_FROM_FUTURE_AT_PREPARATION'));
});

test('future-dated partial-fill evidence cannot bypass preparation freshness', async () => {
  const deps = readyDependencies();
  const result = await preparePaperForwardAuthoritativeInputs(baseInput(), {
    ...deps,
    buildPartialFill: () => ({
      status: 'PRESENT',
      evidence: {
        valuePercent: 0.01,
        quality: 'ESTIMATED',
        source: 'GENUINE_PARTIAL_FILL_CALIBRATION',
        observedAtMs: NOW + 1,
      },
      blockers: [],
    }),
  });
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.equal(result.supplementalCostInput, null);
  assert.ok(result.blockers.includes('PARTIAL_FILL:EVIDENCE_FROM_FUTURE_AT_PREPARATION'));
});

test('cross-source scope mismatch fails before validator execution', async () => {
  const input = structuredClone(baseInput()) as any;
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

test('separator-distinct partial-fill symbol identities fail closed before validator execution', async () => {
  const input = structuredClone(baseInput()) as any;
  input.riskPolicyRequest.symbol = 'BTC-USDT';
  input.riskPolicyRecord.symbolScopes = ['BTC-USDT'];
  input.liquidity.liquidityImpactFirewallInput.expected.symbol = 'BTC-USDT';
  input.partialFill.expected.symbol = 'BTC_USDT';
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

test('separator-distinct liquidity symbol identities fail closed before validator execution', async () => {
  const input = structuredClone(baseInput()) as any;
  input.riskPolicyRequest.symbol = 'BTC-USDT';
  input.riskPolicyRecord.symbolScopes = ['BTC-USDT'];
  input.partialFill.expected.symbol = 'BTC-USDT';
  input.liquidity.liquidityImpactFirewallInput.expected.symbol = 'BTC_USDT';
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
  assert.ok(result.blockers.includes('PREPARATION_LIQUIDITY_SCOPE_MISMATCH'));
});

test('invalid exact research SHA fails closed', async () => {
  const input = structuredClone(baseInput()) as any;
  input.researchCodeSha = 'not-a-sha';
  const result = await preparePaperForwardAuthoritativeInputs(input, {});
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('PREPARATION_EXACT_RESEARCH_SHA_REQUIRED'));
});


test('service fails closed when canonical liquidity runtime builder is not explicitly bound', async () => {
  const result = await preparePaperForwardAuthoritativeInputs(baseInput());
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('LIQUIDITY:CANONICAL_LIQUIDITY_RUNTIME_BUILDER_NOT_BOUND'));
  assert.equal(result.economicCreditCreated, false);
  assert.equal(result.executionAuthority, 'NONE');
});


test('preparation freshness cannot exceed Natural runtime 30 second contract', async () => {
  const input = structuredClone(baseInput()) as any;
  input.maximumAgeMs = 30_001;
  const result = await preparePaperForwardAuthoritativeInputs(input, readyDependencies());
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.ok(result.blockers.includes('PREPARATION_MAXIMUM_AGE_EXCEEDS_NATURAL_RUNTIME'));
});