import test from 'node:test';
import assert from 'node:assert/strict';

import { preparePaperForwardAuthoritativeInputs } from './paper-forward-authoritative-input-preparation.service';

const SHA = 'a'.repeat(40);
const NOW = 1_800_000_000_000;

test('missing liquidity expected scope fails closed before validator execution', async () => {
  const input: any = {
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
      liquidityImpactFirewallInput: {},
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
  assert.equal(result.supplementalCostInput, null);
  assert.ok(result.blockers.includes('PREPARATION_LIQUIDITY_SCOPE_REQUIRED'));
});
