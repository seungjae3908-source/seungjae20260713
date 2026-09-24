import test from 'node:test';
import assert from 'node:assert/strict';

import { preparePaperForwardAuthoritativeInputs } from './paper-forward-authoritative-input-preparation.service';

const SHA = 'a'.repeat(40);
const NOW = 1_800_000_000_000;

test('matching invalid side identities fail closed before downstream validators execute', async () => {
  const input = {
    researchCodeSha: SHA,
    riskPolicyRecord: {},
    riskPolicyRequest: {
      market: 'CRYPTO_FUTURES',
      symbol: 'BTCUSDT',
      strategyScope: 'strategy-v1',
      researchCodeSha: SHA,
    },
    costPolicyId: 'cost-policy-v1',
    liquidity: {
      liquidityImpactFirewallInput: {
        expected: {
          market: 'CRYPTO_FUTURES',
          symbol: 'BTCUSDT',
          side: 'SIDEWAYS',
        },
      },
    },
    partialFill: {
      artifact: null,
      expected: {
        market: 'CRYPTO_FUTURES',
        symbol: 'BTCUSDT',
        side: 'SIDEWAYS',
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
  } as any;

  const mustNotExecute = () => {
    throw new Error('downstream validator must not execute');
  };

  const result = await preparePaperForwardAuthoritativeInputs(input, {
    createRiskProducer: mustNotExecute,
    buildLiquidity: mustNotExecute,
    buildPartialFill: mustNotExecute,
  } as any);

  assert.equal(result.status, 'BLOCKED_DATA');
  assert.equal(result.supplementalCostInput, null);
  assert.ok(result.blockers.includes('PREPARATION_PARTIAL_FILL_SCOPE_MISMATCH'));
  assert.ok(result.blockers.includes('PREPARATION_LIQUIDITY_SCOPE_MISMATCH'));
  assert.equal(result.economicCreditCreated, false);
  assert.equal(result.executionAuthority, 'NONE');
});
