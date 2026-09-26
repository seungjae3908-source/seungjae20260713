import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CAPTURE_SELECTION_POLICY,
  CAPTURE_TRIGGER_TYPE,
  OOS_SELECTION_POLICY,
  assessProspectiveObservationEligibility,
  buildProspectiveLiquidityPolicyArtifact,
  resolveProspectiveCaptureSlot,
  verifyProspectiveLiquidityPolicyArtifact,
} from '../src/public-forward-liquidity-prospective-policy.mjs';

const HEAD = 'c369ca115cc1050775c9b423a20db242fd8eddf2';
const FROZEN = Date.UTC(2026, 7, 29, 22, 0, 0, 0);

function artifact(overrides = {}) {
  return buildProspectiveLiquidityPolicyArtifact({
    exactHeadSha: HEAD,
    policyFrozenAtMs: FROZEN,
    ...overrides,
  });
}

function observationFor(value, offsetMs = 1_000, aggressiveSide = 'BUY') {
  return {
    eventTimestampMs: value.cohort.cohortEligibleAfterMs + offsetMs,
    sampleClass: 'FORWARD_NATURAL_SAMPLE',
    market: 'CRYPTO_FUTURES',
    symbol: 'BTCUSDT',
    aggressiveSide,
  };
}

function captureContextFor(value, observation) {
  const slot = resolveProspectiveCaptureSlot({ artifact: value, eventTimestampMs: observation.eventTimestampMs });
  assert.equal(slot.valid, true);
  return {
    triggerType: CAPTURE_TRIGGER_TYPE,
    captureSelectionPolicyDigest: value.captureSelectionPolicy.captureSelectionPolicyDigest,
    cohortIdentity: value.cohort.cohortIdentity,
    slotIndex: slot.slotIndex,
    slotStartMs: slot.slotStartMs,
    slotEndExclusiveMs: slot.slotEndExclusiveMs,
    captureAttemptedAtMs: slot.slotStartMs + 1,
    captureAttemptOrdinal: 1,
    operatorSelected: false,
    replay: false,
    backfill: false,
  };
}

test('freezes V2 with unchanged minima/horizon and deterministic complete-window capture selection', () => {
  const value = artifact();
  assert.equal(verifyProspectiveLiquidityPolicyArtifact(value).valid, true);
  assert.equal(value.policy.policyVersion, '2');
  assert.deepEqual(value.policy.overallMinimums, { train: 18, validation: 6, oos: 6 });
  assert.equal(value.policy.scopeMinimums[0].minimums.train, 9);
  assert.equal(value.policy.scopeMinimums[1].minimums.oos, 3);
  assert.equal(value.outcomeMethodology.outcomeHorizonMs, 60_000);
  assert.equal(value.outcomeMethodology.outcomeSelectionPolicy, OOS_SELECTION_POLICY);
  assert.equal(value.captureSelectionPolicy.selectionPolicy, CAPTURE_SELECTION_POLICY);
  assert.equal(value.captureSelectionPolicy.triggerType, CAPTURE_TRIGGER_TYPE);
  assert.equal(value.captureSelectionPolicy.slotIntervalMs, 30 * 60 * 1000);
  assert.deepEqual(value.captureSelectionPolicy.slotCounts, { train: 24, validation: 12, oos: 12 });
  assert.equal(value.captureSelectionPolicy.manualDispatchCredit, 0);
  assert.equal(value.captureSelectionPolicy.operatorSelectedDispatchCredit, 0);
  assert.equal(value.captureSelectionPolicy.completeWindowAttemptLogRequired, true);
  assert.equal(value.captureSelectionPolicy.scheduleActivationRequired, true);
  assert.equal(value.supersedes.supersededBeforeFirstSample, true);
  assert.equal(value.supersedes.priorProspectiveSampleCredit, 0);
  assert.equal(value.readiness.NEW_PROSPECTIVE_SAMPLE_N, 0);
  assert.equal(value.readiness.FULL_COST_READY, false);
  assert.equal(value.readiness.EVIDENCE_COMPLETE, 0);
});

test('artifact, policy and selection digests are deterministic and tampering fails closed', () => {
  const left = artifact();
  const right = artifact();
  assert.equal(left.artifactDigest, right.artifactDigest);
  assert.equal(left.policy.policyDigest, right.policy.policyDigest);
  assert.equal(left.captureSelectionPolicy.captureSelectionPolicyDigest, right.captureSelectionPolicy.captureSelectionPolicyDigest);

  for (const mutate of [
    (value) => { value.policy.overallMinimums.train = 1; },
    (value) => { value.captureSelectionPolicy.slotIntervalMs = 60_000; },
    (value) => { value.captureSelectionPolicy.manualDispatchCredit = 1; },
    (value) => { value.outcomeMethodology.outcomeHorizonMs = 5_000; },
    (value) => { value.scopePolicy.quantityNotionalBucketIdentity = 'TAMPER'; },
    (value) => { value.regimePolicy.volatilityRegimeIdentity = 'TAMPER'; },
  ]) {
    const tampered = structuredClone(left);
    mutate(tampered);
    const result = verifyProspectiveLiquidityPolicyArtifact(tampered);
    assert.equal(result.valid, false);
  }
});

test('rejects retrospective observation before V2 cohort eligibility', () => {
  const value = artifact();
  const observation = observationFor(value, -1, 'SELL');
  const result = assessProspectiveObservationEligibility({ artifact: value, observation, captureContext: {} });
  assert.equal(result.eligible, false);
  assert.ok(result.blockers.includes('EVENT_PREDATES_PROSPECTIVE_COHORT'));
});

test('accepts a genuine scheduled capture only with exact slot and policy binding', () => {
  const value = artifact();
  for (const side of ['BUY', 'SELL']) {
    const observation = observationFor(value, 1_000, side);
    const captureContext = captureContextFor(value, observation);
    const result = assessProspectiveObservationEligibility({ artifact: value, observation, captureContext });
    assert.equal(result.eligible, true);
    assert.equal(result.slot.split, 'TRAIN');
    assert.equal(result.slot.slotIndex, 0);
  }
});

test('manual/opportunistic capture receives zero eligibility credit', () => {
  const value = artifact();
  const observation = observationFor(value);
  const captureContext = captureContextFor(value, observation);
  captureContext.triggerType = 'WORKFLOW_DISPATCH';
  captureContext.operatorSelected = true;
  const result = assessProspectiveObservationEligibility({ artifact: value, observation, captureContext });
  assert.equal(result.eligible, false);
  assert.ok(result.blockers.includes('SCHEDULED_CAPTURE_TRIGGER_REQUIRED'));
  assert.ok(result.blockers.includes('OPERATOR_SELECTED_CAPTURE_FORBIDDEN'));
});

test('wrong slot, selection digest, cohort or replay/backfill fails closed', () => {
  const value = artifact();
  const observation = observationFor(value);
  const captureContext = captureContextFor(value, observation);
  captureContext.slotIndex += 1;
  captureContext.captureSelectionPolicyDigest = '0'.repeat(64);
  captureContext.cohortIdentity = 'wrong';
  captureContext.replay = true;
  captureContext.backfill = true;
  const result = assessProspectiveObservationEligibility({ artifact: value, observation, captureContext });
  assert.equal(result.eligible, false);
  for (const blocker of [
    'CAPTURE_SLOT_INDEX_MISMATCH',
    'CAPTURE_SELECTION_POLICY_DIGEST_MISMATCH',
    'CAPTURE_COHORT_IDENTITY_MISMATCH',
    'REPLAY_CAPTURE_FORBIDDEN',
    'BACKFILL_CAPTURE_FORBIDDEN',
  ]) assert.ok(result.blockers.includes(blocker));
});

test('V1 artifact shape is rejected by V2 verifier rather than silently rewritten', () => {
  const value = structuredClone(artifact());
  value.schemaVersion = 'public-forward-liquidity-prospective-policy-artifact-v1';
  assert.equal(verifyProspectiveLiquidityPolicyArtifact(value).valid, false);
});

test('refuses side minima above overall and capture plans with too few deterministic slots', () => {
  assert.throws(() => artifact({
    overallMinimums: { train: 18, validation: 6, oos: 6 },
    perSideMinimums: { train: 10, validation: 3, oos: 3 },
  }), /SIDE_MINIMUM_EXCEEDS_OVERALL_TRAIN/u);
  assert.throws(() => artifact({ captureIntervalMs: 60 * 60 * 1000 }), /CAPTURE_SLOTS_BELOW_MINIMUM_TRAIN/u);
});
