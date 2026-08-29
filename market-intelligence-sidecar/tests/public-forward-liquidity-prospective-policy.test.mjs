import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OOS_SELECTION_POLICY,
  assessProspectiveObservationEligibility,
  buildProspectiveLiquidityPolicyArtifact,
  verifyProspectiveLiquidityPolicyArtifact,
} from '../src/public-forward-liquidity-prospective-policy.mjs';

const HEAD = '2447c1dd427ebbf4c8a78ee5595928344bfac5cd';
const FROZEN = Date.UTC(2026, 7, 29, 18, 0, 0, 0);

function artifact(overrides = {}) {
  return buildProspectiveLiquidityPolicyArtifact({
    exactHeadSha: HEAD,
    policyFrozenAtMs: FROZEN,
    ...overrides,
  });
}

test('freezes a deterministic future-only policy compatible with chronological split contract', () => {
  const value = artifact();
  assert.equal(verifyProspectiveLiquidityPolicyArtifact(value).valid, true);
  assert.equal(value.policy.overallMinimums.train, 18);
  assert.equal(value.policy.overallMinimums.validation, 6);
  assert.equal(value.policy.overallMinimums.oos, 6);
  assert.deepEqual(value.policy.scopeMinimums.map((entry) => entry.aggressiveSide), ['BUY', 'SELL']);
  assert.equal(value.policy.scopeMinimums[0].minimums.train, 9);
  assert.equal(value.policy.scopeMinimums[1].minimums.oos, 3);
  assert.ok(value.policy.policyFrozenAtMs < value.policy.windows.train.startInclusiveMs);
  assert.equal(value.policy.windows.train.endExclusiveMs, value.policy.windows.validation.startInclusiveMs);
  assert.equal(value.policy.windows.validation.endExclusiveMs, value.policy.windows.oos.startInclusiveMs);
  assert.equal(value.outcomeMethodology.outcomeHorizonMs, 60_000);
  assert.equal(value.outcomeMethodology.outcomeSelectionPolicy, OOS_SELECTION_POLICY);
  assert.equal(value.rationale.observedLegacyCohortUsedToChooseValues, false);
  assert.equal(value.readiness.FULL_COST_READY, false);
  assert.equal(value.readiness.EVIDENCE_COMPLETE, 0);
  assert.equal(value.safety.executionAuthority, 'NONE');
});

test('artifact digest is deterministic and tampering fails closed', () => {
  const left = artifact();
  const right = artifact();
  assert.equal(left.artifactDigest, right.artifactDigest);
  assert.equal(left.policy.policyDigest, right.policy.policyDigest);
  const tampered = structuredClone(left);
  tampered.policy.overallMinimums.train = 1;
  const result = verifyProspectiveLiquidityPolicyArtifact(tampered);
  assert.equal(result.valid, false);
  assert.ok(result.blockers.includes('POLICY_DIGEST_MISMATCH') || result.blockers.includes('ARTIFACT_DIGEST_MISMATCH'));
});

test('rejects any observation from before the frozen prospective cohort', () => {
  const value = artifact();
  const oldObservation = {
    eventTimestampMs: value.cohort.cohortEligibleAfterMs - 1,
    sampleClass: 'FORWARD_NATURAL_SAMPLE',
    market: 'CRYPTO_FUTURES',
    symbol: 'BTCUSDT',
    aggressiveSide: 'SELL',
  };
  const result = assessProspectiveObservationEligibility({ artifact: value, observation: oldObservation });
  assert.equal(result.eligible, false);
  assert.deepEqual(result.blockers, ['EVENT_PREDATES_PROSPECTIVE_COHORT']);
});

test('accepts only genuine future BUY/SELL observations in the declared cohort', () => {
  const value = artifact();
  for (const aggressiveSide of ['BUY', 'SELL']) {
    const result = assessProspectiveObservationEligibility({
      artifact: value,
      observation: {
        eventTimestampMs: value.cohort.cohortEligibleAfterMs,
        sampleClass: 'FORWARD_NATURAL_SAMPLE',
        market: 'CRYPTO_FUTURES',
        symbol: 'BTCUSDT',
        aggressiveSide,
      },
    });
    assert.equal(result.eligible, true);
  }
});

test('refuses asymmetric side minimums that exceed the declared overall minimum', () => {
  assert.throws(() => artifact({
    overallMinimums: { train: 18, validation: 6, oos: 6 },
    perSideMinimums: { train: 10, validation: 3, oos: 3 },
  }), /SIDE_MINIMUM_EXCEEDS_OVERALL_TRAIN/u);
});
