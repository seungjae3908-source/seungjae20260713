import assert from 'node:assert/strict';
import test from 'node:test';

import {
  V3_COHORT_START_DELAY_MS,
  buildProspectiveLiquidityPolicyV3Artifact,
  verifyProspectiveLiquidityPolicyV3Artifact,
} from '../src/public-forward-liquidity-prospective-policy-v3.mjs';

const HEAD = '1234567890abcdef1234567890abcdef12345678';
const FROZEN = Date.UTC(2026, 7, 30, 0, 0, 0, 0);

function artifact() {
  return buildProspectiveLiquidityPolicyV3Artifact({
    exactHeadSha: HEAD,
    policyFrozenAtMs: FROZEN,
  });
}

function reseal(value) {
  const clone = structuredClone(value);
  delete clone.artifactDigest;
  const canonicalize = (input) => {
    if (Array.isArray(input)) return input.map(canonicalize);
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonicalize(child)]));
    }
    return input;
  };
  return { ...clone, artifactDigest: (await import('node:crypto')).createHash('sha256').update(JSON.stringify(canonicalize(clone))).digest('hex') };
}

test('V3 supersedes V2 before first genuine sample and changes no empirical policy value', () => {
  const value = artifact();
  assert.equal(verifyProspectiveLiquidityPolicyV3Artifact(value).valid, true);
  assert.equal(value.policy.policyVersion, '3');
  assert.equal(value.supersedes.policyVersion, '2');
  assert.equal(value.supersedes.priorProspectiveSampleCredit, 0);
  assert.equal(value.supersedes.supersededBeforeFirstGenuineSample, true);

  assert.deepEqual(value.policy.overallMinimums, { train: 18, validation: 6, oos: 6 });
  assert.deepEqual(value.policy.scopeMinimums.map(({ aggressiveSide, minimums }) => ({ aggressiveSide, minimums })), [
    { aggressiveSide: 'BUY', minimums: { train: 9, validation: 3, oos: 3 } },
    { aggressiveSide: 'SELL', minimums: { train: 9, validation: 3, oos: 3 } },
  ]);
  assert.equal(value.policy.windows.train.endExclusiveMs - value.policy.windows.train.startInclusiveMs, 12 * 60 * 60 * 1000);
  assert.equal(value.policy.windows.validation.endExclusiveMs - value.policy.windows.validation.startInclusiveMs, 6 * 60 * 60 * 1000);
  assert.equal(value.policy.windows.oos.endExclusiveMs - value.policy.windows.oos.startInclusiveMs, 6 * 60 * 60 * 1000);
  assert.equal(value.captureSelectionPolicy.slotIntervalMs, 30 * 60 * 1000);
  assert.deepEqual(value.captureSelectionPolicy.slotCounts, { train: 24, validation: 12, oos: 12 });
  assert.equal(value.outcomeMethodology.outcomeHorizonMs, 60 * 1000);
  assert.equal(value.regimePolicy.maxRegimeEvidenceAgeMs, 15 * 60 * 1000);
  assert.equal(value.scopePolicy.market, 'CRYPTO_FUTURES');
  assert.equal(value.scopePolicy.symbol, 'BTCUSDT');
});

test('V3 freeze creates a strict 24-hour future buffer without changing 30-minute cadence', () => {
  const value = artifact();
  assert.equal(value.cohort.cohortEligibleAfterMs, FROZEN + V3_COHORT_START_DELAY_MS);
  assert.equal(value.captureSelectionPolicy.anchorMs, value.cohort.cohortEligibleAfterMs);
  assert.equal(value.captureSelectionPolicy.exactlyOneCanonicalCaptureAttemptPerSlot, true);
  assert.equal(value.captureSelectionPolicy.completeWindowAttemptLogRequired, true);
  assert.equal(value.captureSelectionPolicy.missingScheduledSlotFailsSelectionCompleteness, true);
});

test('manual operator replay and backfill credit remain exactly zero', () => {
  const value = artifact();
  for (const field of ['manualDispatchCredit', 'operatorSelectedDispatchCredit', 'replaySlotCredit', 'backfillSlotCredit']) {
    assert.equal(value.captureSelectionPolicy[field], 0);
  }
  for (const field of ['historicalObservationCredit', 'replayCredit', 'backfillCredit', 'duplicateCredit', 'manualDispatchCredit']) {
    assert.equal(value.cohort[field], 0);
  }
  assert.equal(value.readiness.CAPTURE_SCHEDULE_ACTIVATED, false);
  assert.equal(value.readiness.NEW_PROSPECTIVE_SAMPLE_N, 0);
  assert.equal(value.readiness.FULL_COST_READY, false);
  assert.equal(value.readiness.EVIDENCE_COMPLETE, 0);
});

test('observed outcomes cannot retune V3 carry-forward values', () => {
  const value = artifact();
  assert.equal(value.carryForward.sourceValuesChangedForObservedOutcome, false);
  assert.equal(value.rationale.observedLegacyCohortUsedToChooseValues, false);
  assert.equal(value.rationale.v1ProspectiveOutcomesUsedToChooseValues, false);
  assert.equal(value.rationale.v2ProspectiveOutcomesUsedToChooseValues, false);
  assert.equal(value.rationale.v2ProspectiveSampleCreditAtSupersession, 0);
});

test('V3 builder refuses shortening or extending the predeclared 24-hour activation buffer', () => {
  assert.throws(() => buildProspectiveLiquidityPolicyV3Artifact({
    exactHeadSha: HEAD,
    policyFrozenAtMs: FROZEN,
    cohortStartDelayMs: 30 * 60 * 1000,
  }), /V3_COHORT_START_DELAY_MUST_REMAIN_24H/u);
});

test('V3 verifier rejects cadence, minima, horizon, non-scheduled credit and safety tampering', () => {
  const cases = [
    (value) => { value.captureSelectionPolicy.slotIntervalMs = 60 * 60 * 1000; },
    (value) => { value.policy.overallMinimums.train = 17; },
    (value) => { value.outcomeMethodology.outcomeHorizonMs = 120000; },
    (value) => { value.captureSelectionPolicy.manualDispatchCredit = 1; },
    (value) => { value.safety.executionAuthority = 'ORDER'; },
  ];
  for (const mutate of cases) {
    const value = structuredClone(artifact());
    mutate(value);
    assert.equal(verifyProspectiveLiquidityPolicyV3Artifact(value).valid, false);
  }
});

test('V3 verifier rejects artifact digest tampering', () => {
  const value = structuredClone(artifact());
  value.artifactDigest = '0'.repeat(64);
  assert.equal(verifyProspectiveLiquidityPolicyV3Artifact(value).valid, false);
});
