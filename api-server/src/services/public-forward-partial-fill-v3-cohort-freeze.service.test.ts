import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PUBLIC_FORWARD_PARTIAL_FILL_V3_COHORT_FREEZE_AUTHORITY,
  PUBLIC_FORWARD_PARTIAL_FILL_V3_COHORT_FREEZE_DIGEST,
  describePublicForwardPartialFillV3Slot,
  verifyPublicForwardPartialFillV3CohortFreeze,
} from './public-forward-partial-fill-v3-cohort-freeze.service';

test('V3 cohort freeze is exact, strictly prospective and internally consistent', () => {
  const verdict = verifyPublicForwardPartialFillV3CohortFreeze();
  assert.equal(verdict.valid, true, verdict.blockers.join(','));
  assert.deepEqual(verdict.blockers, []);
  assert.equal(verdict.digest, PUBLIC_FORWARD_PARTIAL_FILL_V3_COHORT_FREEZE_DIGEST);

  const value = PUBLIC_FORWARD_PARTIAL_FILL_V3_COHORT_FREEZE_AUTHORITY;
  assert.equal(value.cohortFrozenAtMs, 1790207015000);
  assert.equal(value.effectiveStartMs, 1790263020000);
  assert.ok(value.effectiveStartMs > value.cohortFrozenAtMs);
  assert.equal(value.endExclusiveMs - value.effectiveStartMs, 1024 * 3_600_000);
  assert.equal(value.effectiveStartKst, '2026-09-25T00:17:00+09:00');
  assert.equal(value.endExclusiveKst, '2026-11-06T16:17:00+09:00');
});

test('V3 preserves exact V2 numeric criteria and frozen authority digests', () => {
  const value = PUBLIC_FORWARD_PARTIAL_FILL_V3_COHORT_FREEZE_AUTHORITY;
  assert.equal(value.inheritedV2Authority.perScopeEffectiveIndependentMinimum, 178);
  assert.equal(value.inheritedV2Authority.scopeCellCount, 4);
  assert.equal(value.inheritedV2Authority.mechanicalFloorEffectiveIndependent, 712);
  assert.match(value.inheritedV2Authority.policyDigest, /^[a-f0-9]{64}$/u);
  assert.match(value.inheritedV2Authority.cohortDigest, /^[a-f0-9]{64}$/u);
  for (const digest of Object.values(value.frozenComponentDigests)) {
    assert.match(digest, /^[a-f0-9]{64}$/u);
  }
});

test('V3 chronological split is exactly 512/256/256 across 1024 hourly slots', () => {
  const first = describePublicForwardPartialFillV3Slot(0);
  const lastTrain = describePublicForwardPartialFillV3Slot(511);
  const firstValidation = describePublicForwardPartialFillV3Slot(512);
  const lastValidation = describePublicForwardPartialFillV3Slot(767);
  const firstOos = describePublicForwardPartialFillV3Slot(768);
  const last = describePublicForwardPartialFillV3Slot(1023);

  assert.equal(first.split, 'TRAIN');
  assert.equal(lastTrain.split, 'TRAIN');
  assert.equal(firstValidation.split, 'VALIDATION');
  assert.equal(lastValidation.split, 'VALIDATION');
  assert.equal(firstOos.split, 'OOS');
  assert.equal(last.split, 'OOS');
  assert.equal(first.nominalScheduledAtMs, 1790263020000);
  assert.equal(last.slotEndExclusiveMs, 1793949420000);
  assert.equal(first.prospectiveCreditAuthority, 0);
  assert.equal(last.prospectiveCreditAuthority, 0);
  assert.throws(() => describePublicForwardPartialFillV3Slot(-1), /V3_COHORT_SLOT_INDEX_INVALID/u);
  assert.throws(() => describePublicForwardPartialFillV3Slot(1024), /V3_COHORT_SLOT_INDEX_INVALID/u);
});

test('schedule, capture, deployment and execution authority remain absent after freeze', () => {
  const value = PUBLIC_FORWARD_PARTIAL_FILL_V3_COHORT_FREEZE_AUTHORITY;
  assert.equal(value.scheduleTrigger, 'NONE');
  assert.equal(value.scheduleActivationApproved, false);
  assert.equal(value.captureApproved, false);
  assert.equal(value.workflowDispatchApproved, false);
  assert.equal(value.stagingDeployApproved, false);
  assert.equal(value.productionDeployApproved, false);
  assert.equal(value.dbSecretEnvServerMutationApproved, false);
  assert.equal(value.executionAuthority, 'NONE');
  assert.equal(value.privateTradingApiAllowed, false);
  assert.equal(value.liveTrading, false);
  assert.equal(value.autoTrading, false);
  assert.equal(value.realOrderEnabled, false);
  assert.equal(value.replitAllowed, false);
});

test('modeled public evidence cannot become actual execution truth or economic credit', () => {
  const value = PUBLIC_FORWARD_PARTIAL_FILL_V3_COHORT_FREEZE_AUTHORITY;
  assert.equal(value.modeledEvidenceAuthority, 'RESEARCH_ONLY_NON_ECONOMIC');
  assert.equal(value.actualExecutionTruth, 'UNKNOWN_UNTIL_OBSERVED');
  assert.equal(value.modeledEvidenceMayBecomeActualEvidence, false);
  assert.equal(value.replayCredit, 0);
  assert.equal(value.backfillCredit, 0);
  assert.equal(value.manualCredit, 0);
  assert.equal(value.syntheticCredit, 0);
  assert.equal(value.hindsightCredit, 0);
  assert.equal(value.economicCreditCreated, false);
  assert.equal(value.profitabilityCredit, 0);
  assert.equal(value.fullCostReady, false);
  assert.equal(value.evidenceComplete, 0);
  assert.equal(value.profitabilityProven, false);
});

test('tampering start to freeze boundary fails closed', () => {
  const candidate = structuredClone(PUBLIC_FORWARD_PARTIAL_FILL_V3_COHORT_FREEZE_AUTHORITY) as any;
  candidate.effectiveStartMs = candidate.cohortFrozenAtMs;
  const verdict = verifyPublicForwardPartialFillV3CohortFreeze(candidate);
  assert.equal(verdict.valid, false);
  assert.ok(verdict.blockers.includes('V3_COHORT_NOT_STRICTLY_PROSPECTIVE'));
});

test('tampering V2 threshold or component authority fails closed', () => {
  const threshold = structuredClone(PUBLIC_FORWARD_PARTIAL_FILL_V3_COHORT_FREEZE_AUTHORITY) as any;
  threshold.inheritedV2Authority.perScopeEffectiveIndependentMinimum = 177;
  const thresholdVerdict = verifyPublicForwardPartialFillV3CohortFreeze(threshold);
  assert.equal(thresholdVerdict.valid, false);
  assert.ok(thresholdVerdict.blockers.includes('V3_COHORT_V2_AUTHORITY_DRIFT'));

  const component = structuredClone(PUBLIC_FORWARD_PARTIAL_FILL_V3_COHORT_FREEZE_AUTHORITY) as any;
  component.frozenComponentDigests.numericMinimumArtifact = '0'.repeat(64);
  const componentVerdict = verifyPublicForwardPartialFillV3CohortFreeze(component);
  assert.equal(componentVerdict.valid, false);
  assert.ok(componentVerdict.blockers.includes('V3_COHORT_COMPONENT_AUTHORITY_DRIFT'));
});

test('tampering schedule or profitability authority fails closed', () => {
  const activation = structuredClone(PUBLIC_FORWARD_PARTIAL_FILL_V3_COHORT_FREEZE_AUTHORITY) as any;
  activation.scheduleActivationApproved = true;
  activation.scheduleTrigger = '17 * * * *';
  const activationVerdict = verifyPublicForwardPartialFillV3CohortFreeze(activation);
  assert.equal(activationVerdict.valid, false);
  assert.ok(activationVerdict.blockers.includes('V3_COHORT_ACTIVATION_AUTHORITY_FORBIDDEN'));

  const credit = structuredClone(PUBLIC_FORWARD_PARTIAL_FILL_V3_COHORT_FREEZE_AUTHORITY) as any;
  credit.profitabilityCredit = 1;
  credit.evidenceComplete = 1;
  const creditVerdict = verifyPublicForwardPartialFillV3CohortFreeze(credit);
  assert.equal(creditVerdict.valid, false);
  assert.ok(creditVerdict.blockers.includes('V3_COHORT_ECONOMIC_CREDIT_FORBIDDEN'));
});

test('tampering split continuity fails closed', () => {
  const candidate = structuredClone(PUBLIC_FORWARD_PARTIAL_FILL_V3_COHORT_FREEZE_AUTHORITY) as any;
  candidate.splits.VALIDATION.startIndexInclusive = 511;
  const verdict = verifyPublicForwardPartialFillV3CohortFreeze(candidate);
  assert.equal(verdict.valid, false);
  assert.ok(verdict.blockers.includes('V3_COHORT_SPLITS_INVALID'));
});

test('tampering split timestamp anchors fails closed even when continuity is preserved', () => {
  const start = structuredClone(PUBLIC_FORWARD_PARTIAL_FILL_V3_COHORT_FREEZE_AUTHORITY) as any;
  start.splits.TRAIN.startInclusiveMs += 3_600_000;
  const startVerdict = verifyPublicForwardPartialFillV3CohortFreeze(start);
  assert.equal(startVerdict.valid, false);
  assert.ok(startVerdict.blockers.includes('V3_COHORT_SPLITS_INVALID'));

  const boundary = structuredClone(PUBLIC_FORWARD_PARTIAL_FILL_V3_COHORT_FREEZE_AUTHORITY) as any;
  boundary.splits.TRAIN.endExclusiveMs -= 3_600_000;
  boundary.splits.VALIDATION.startInclusiveMs = boundary.splits.TRAIN.endExclusiveMs;
  const boundaryVerdict = verifyPublicForwardPartialFillV3CohortFreeze(boundary);
  assert.equal(boundaryVerdict.valid, false);
  assert.ok(boundaryVerdict.blockers.includes('V3_COHORT_SPLITS_INVALID'));
});
