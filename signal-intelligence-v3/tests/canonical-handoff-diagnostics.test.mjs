import assert from 'node:assert/strict';
import test from 'node:test';

import { diagnoseCanonicalHandoffJoin } from '../src/canonical-handoff-diagnostics.mjs';

const sha = 'a'.repeat(40);

function card(overrides = {}) {
  return {
    signalId: 'signal-1', signalGrade: 'S', strongSignalEligible: true,
    dataState: 'complete', dataQuality: { state: 'TRUSTED', strongSignalAllowed: true },
    ...overrides,
  };
}

function handoff() {
  return {
    schemaVersion: 'member-auto-trading-paper-handoff-v1', status: 'READY',
    entryCount: 1,
    entries: [{ identity: {
      signalId: 'signal-1', candidateId: 'candidate-1', market: 'CRYPTO_SPOT', symbol: 'BTC',
      timeframe: '1D', horizon: 5, direction: 'BUY', strategyId: 'strategy-1',
      strategyVersion: 'v1', parameterHash: 'parameter-1', researchCodeSha: sha,
      costPolicyVersion: 'cost-v1',
    } }],
    blockers: [],
  };
}

const canonical = { 'signal-1': { paperCandidate: { signal: {
  signalId: 'signal-1', market: 'CRYPTO_SPOT', symbol: 'BTC', timeframe: '1D', horizon: 5,
  direction: 'BUY', strategyIdentity: { candidateId: 'candidate-1', strategyId: 'strategy-1',
    strategyVersion: 'v1', parameterHash: 'parameter-1', researchCodeSha: sha, costPolicyVersion: 'cost-v1' },
} }, blockers: [] } };
const risk = { 'signal-1': { status: 'APPROVED', source: 'TRADING_RISK_ENGINE', allowed: true,
  simulatedOnly: true, executionAuthority: 'NONE', blockCodes: [] } };

test('separates candidate shortage from handoff and SHA readiness', () => {
  const result = diagnoseCanonicalHandoffJoin({ lanes: [{ cards: [] }], serviceSha: sha, expectedServiceSha: sha });
  assert.equal(result.canonicalHandoffJoin, 0);
  assert.equal(result.causes.candidateShortage.active, true);
  assert.equal(result.causes.handoffFileDisconnected.active, true);
  assert.equal(result.causes.serviceShaMismatch.status, 'MATCH');
  assert.equal(result.worker.status, 'NOT_RUN_NO_ACTUAL_JOIN');
});

test('reports canonical and risk evidence deficits independently', () => {
  const missingIdentity = diagnoseCanonicalHandoffJoin({ lanes: [{ cards: [card()] }], canonicalBySignalId: {} });
  assert.equal(missingIdentity.causes.canonicalEvidenceInsufficient.identityBlocked, 1);
  assert.deepEqual(missingIdentity.causes.canonicalEvidenceInsufficient.canonicalBlockers, { CANONICAL_RESOLUTION_NOT_RUN: 1 });

  const missingRisk = diagnoseCanonicalHandoffJoin({ lanes: [{ cards: [card()] }], canonicalBySignalId: canonical });
  assert.equal(missingRisk.causes.canonicalEvidenceInsufficient.identityBlocked, 0);
  assert.equal(missingRisk.causes.canonicalEvidenceInsufficient.riskBlocked, 1);
});

test('counts an actual joined signal only when data, canonical identity, risk, handoff and SHA agree', () => {
  const result = diagnoseCanonicalHandoffJoin({
    lanes: [{ cards: [card()] }], canonicalBySignalId: canonical, riskBySignalId: risk,
    handoff: handoff(), serviceSha: sha, expectedServiceSha: sha,
    workerResult: { entries: 1, evaluated: 1, privateTradingRequests: 0, liveOrders: 0 },
  });
  assert.equal(result.canonicalHandoffJoin, 1);
  assert.equal(result.worker.status, 'DELIVERED_WITHOUT_REAL_ORDER');
  assert.equal(result.safety.realOrderObserved, false);
});

test('does not call a missing SHA a mismatch and blocks a proven mismatch', () => {
  const missing = diagnoseCanonicalHandoffJoin({ lanes: [{ cards: [card()] }], serviceSha: null, expectedServiceSha: sha });
  assert.equal(missing.causes.serviceShaMismatch.active, false);
  assert.equal(missing.causes.serviceShaMismatch.status, 'NOT_EVALUABLE');

  const mismatch = diagnoseCanonicalHandoffJoin({
    lanes: [{ cards: [card()] }], canonicalBySignalId: canonical, riskBySignalId: risk,
    handoff: handoff(), serviceSha: sha, expectedServiceSha: 'b'.repeat(40),
  });
  assert.equal(mismatch.causes.serviceShaMismatch.active, true);
  assert.equal(mismatch.canonicalHandoffJoin, 0);
});

test('does not join a handoff whose canonical identity differs despite the same signal id', () => {
  const mismatched = handoff();
  mismatched.entries[0].identity.parameterHash = 'different-parameter';
  const result = diagnoseCanonicalHandoffJoin({
    lanes: [{ cards: [card()] }], canonicalBySignalId: canonical, riskBySignalId: risk,
    handoff: mismatched, serviceSha: sha, expectedServiceSha: sha,
  });
  assert.equal(result.canonicalHandoffJoin, 0);
  assert.equal(result.causes.canonicalEvidenceInsufficient.handoffIdentityBlocked, 1);
});

