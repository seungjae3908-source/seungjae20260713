import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  PUBLIC_FORWARD_LIQUIDITY_V4_FUTURE_ACTIVATION_BINDING_SCHEMA,
  PUBLIC_FORWARD_LIQUIDITY_V4_INACTIVE_INTEGRATION_GATE,
  evaluateV4InactiveIntegrationGate,
  verifyV4FutureActivationBinding,
} from '../src/public-forward-liquidity-v4-inactive-integration-gate.mjs';

function validFutureBinding() {
  return {
    schemaVersion: PUBLIC_FORWARD_LIQUIDITY_V4_FUTURE_ACTIVATION_BINDING_SCHEMA,
    technicalIdentitySchemaVersion:
      PUBLIC_FORWARD_LIQUIDITY_V4_INACTIVE_INTEGRATION_GATE.technicalIdentitySchemaVersion,
    technicalIdentityDigest:
      PUBLIC_FORWARD_LIQUIDITY_V4_INACTIVE_INTEGRATION_GATE.technicalIdentityDigest,
    activationDecision: 'APPROVED_FOR_SEPARATE_ACTIVATION_PR_ONLY',
    humanAuthorityRef: 'human-authority:future-v4:test-only',
    targetMainSha: 'a'.repeat(40),
    approvedAtMs: 1_800_000_000_000,
  };
}

test('missing activation binding fails closed with zero collector invocation and zero credit', async () => {
  let collectorCalls = 0;
  const result = await evaluateV4InactiveIntegrationGate({
    collector: async () => {
      collectorCalls += 1;
      throw new Error('collector must never run');
    },
  });

  assert.equal(result.status, 'BLOCKED_ACTIVATION');
  assert.equal(result.readyForSeparateActivationPr, false);
  assert.equal(result.collectorProvided, true);
  assert.equal(result.collectorInvoked, false);
  assert.equal(collectorCalls, 0);
  assert.equal(result.runtimeActivationEnabled, false);
  assert.equal(result.scheduledRuntimeMutationAllowed, false);
  assert.equal(result.prospectiveEconomicCredit, 0);
  assert.equal(result.executionAuthority, 'NONE');
});

test('even a valid future human binding only makes a separate activation PR ready and still cannot run V4', async () => {
  let collectorCalls = 0;
  const binding = validFutureBinding();
  const verification = verifyV4FutureActivationBinding(binding);
  assert.equal(verification.valid, true);
  assert.deepEqual(verification.blockers, []);

  const result = await evaluateV4InactiveIntegrationGate({
    activationBinding: binding,
    collector: async () => {
      collectorCalls += 1;
      throw new Error('collector must never run');
    },
  });

  assert.equal(result.status, 'READY_FOR_SEPARATE_ACTIVATION_PR');
  assert.equal(result.readyForSeparateActivationPr, true);
  assert.equal(result.collectorInvoked, false);
  assert.equal(collectorCalls, 0);
  assert.equal(result.runtimeActivationEnabled, false);
  assert.equal(result.prospectiveEconomicCredit, 0);
  assert.equal(result.liveTradingAllowed, false);
  assert.equal(result.privateTradingApiAllowed, false);
  assert.equal(result.realOrderAllowed, false);
  assert.equal(result.executionAuthority, 'NONE');
});

test('technical identity drift invalidates the future activation binding', () => {
  const binding = validFutureBinding();
  binding.technicalIdentityDigest = 'f'.repeat(64);
  const result = verifyV4FutureActivationBinding(binding);
  assert.equal(result.valid, false);
  assert.ok(result.blockers.includes('V4_FUTURE_ACTIVATION_TECHNICAL_DIGEST_MISMATCH'));
});

test('current scheduled workflow remains V3-only and does not reference the V4 integration gate', async () => {
  const workflow = await readFile(
    new URL('../../.github/workflows/public-forward-liquidity-successor-scheduled-capture.yml', import.meta.url),
    'utf8',
  );

  assert.match(workflow, /capture-v3/u);
  assert.doesNotMatch(workflow, /capture-v4/u);
  assert.doesNotMatch(workflow, /public-forward-liquidity-v4-inactive-integration-gate/u);
  assert.doesNotMatch(workflow, /public-forward-liquidity-capture-seam-v4/u);
});
