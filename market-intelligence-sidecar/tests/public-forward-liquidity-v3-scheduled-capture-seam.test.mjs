import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildAttemptReceipt,
  buildCompleteWindowAttemptLog,
  CRON_UTC,
  FIRST_NOMINAL_SCHEDULED_AT_MS,
  MANUAL_TRIGGER_SOURCE,
  resolveScheduledAttempt,
  SCHEDULE_TRIGGER_SOURCE,
  slotDescriptor,
  SLOT_EXECUTION_OFFSET_MS,
  validateScheduledCaptureBatch,
  V3_COHORT_ELIGIBLE_AFTER_MS,
  V3_POLICY_HEAD,
  verifyV3ArtifactBinding,
} from '../src/public-forward-liquidity-v3-scheduled-capture-seam.mjs';

const exactMainSha = '7c6a6c754b0906abac7124945bb9b9014b2af4e0';

function artifactFixture() {
  return {
    schemaVersion: 'public-forward-liquidity-prospective-policy-artifact-v3',
    exactPolicyHeadSha: V3_POLICY_HEAD,
    artifactDigest: '6cd95ffb7bf23bab34d53ff7d0b2eb6c2fc3b58dcf9a36cad9ef883a68c02009',
    policy: { policyVersion: '3', policyDigest: '547bcd9fde985a7920f27c88e5e24f082c1dede18ef35a9ebdaa34edc056589b' },
    cohort: {
      cohortIdentity: 'PUBLIC_FORWARD_LIQUIDITY_NEW_PROSPECTIVE_COHORT_V3:43b15ea7cb4edfc84ce7e3055e6b8d7e5443c0f6',
      cohortDigest: 'a1f176c286e40b3ca4182167c9357e57b39a7c40540b81ff6e206402f67dff9c',
      cohortEligibleAfterMs: 1_788_129_740_000,
      cohortEndExclusiveMs: 1_788_216_140_000,
    },
    captureSelectionPolicy: {
      captureSelectionPolicyDigest: 'ab1ce473bb60ae4231f05f00358d67a0c5e927ec797722962ce9c02d02bf2fe4',
      triggerType: SCHEDULE_TRIGGER_SOURCE,
      slotIntervalMs: 1_800_000,
      manualDispatchCredit: 0,
      replaySlotCredit: 0,
      backfillSlotCredit: 0,
      operatorSelectedDispatchCredit: 0,
      exactlyOneCanonicalCaptureAttemptPerSlot: true,
      completeWindowAttemptLogRequired: true,
    },
    safety: { executionAuthority: 'NONE', privateApiUsed: false, liveTrading: false, orderSubmitted: false },
  };
}

function validBatch() {
  return {
    kind: 'public-forward-liquidity-calibration-batch',
    sampleClass: 'FORWARD_NATURAL_SAMPLE',
    datasetProvenance: { rawSource: { provider: 'BITGET_PUBLIC_UTA_V3', privateApiUsed: false }, collectorCodeSha: exactMainSha },
    safety: { executionAuthority: 'NONE', privateTradingApiAllowed: false, liveTradingAllowed: false, realOrderAllowed: false, financialMutationAllowed: false },
    observations: [{ symbol: 'BTCUSDT', market: 'CRYPTO_FUTURES', publicDataSource: 'BITGET_PUBLIC_UTA_V3', collectorCodeSha: exactMainSha }],
  };
}

test('V3 binding rejects policy digest mismatch', () => {
  const artifact = artifactFixture();
  artifact.policy.policyDigest = '0'.repeat(64);
  const result = verifyV3ArtifactBinding(artifact);
  assert.equal(result.valid, false);
  assert.ok(result.blockers.includes('V3_POLICY_DIGEST_MISMATCH'));
});

test('V3 binding rejects cohort digest mismatch', () => {
  const artifact = artifactFixture();
  artifact.cohort.cohortDigest = '0'.repeat(64);
  assert.ok(verifyV3ArtifactBinding(artifact).blockers.includes('V3_COHORT_DIGEST_MISMATCH'));
});

test('V3 binding rejects wrong policy head', () => {
  const artifact = artifactFixture();
  artifact.exactPolicyHeadSha = '0'.repeat(40);
  assert.ok(verifyV3ArtifactBinding(artifact).blockers.includes('V3_POLICY_HEAD_MISMATCH'));
});

test('slot mapping is deterministic from the V3 anchor', () => {
  assert.equal(FIRST_NOMINAL_SCHEDULED_AT_MS, 1_788_129_780_000);
  assert.equal(SLOT_EXECUTION_OFFSET_MS, 40_000);
  assert.equal(CRON_UTC, '13,43 * * * *');
  assert.equal(slotDescriptor(0).nominalScheduledAtMs, FIRST_NOMINAL_SCHEDULED_AT_MS);
  assert.equal(slotDescriptor(1).nominalScheduledAtMs, FIRST_NOMINAL_SCHEDULED_AT_MS + 1_800_000);
});

test('pre-eligibility scheduled attempt gets zero credit', () => {
  const result = resolveScheduledAttempt({
    runCreatedAtMs: V3_COHORT_ELIGIBLE_AFTER_MS - 1,
    actualRunStartedAtMs: V3_COHORT_ELIGIBLE_AFTER_MS - 1,
  });
  assert.equal(result.eligible, false);
  assert.equal(result.status, 'PRE_ELIGIBILITY');
  assert.equal(result.prospectiveSlotCredit, 0);
});

test('correct scheduled slot is eligible', () => {
  const result = resolveScheduledAttempt({
    runCreatedAtMs: FIRST_NOMINAL_SCHEDULED_AT_MS + 2_000,
    actualRunStartedAtMs: FIRST_NOMINAL_SCHEDULED_AT_MS + 5_000,
    runAttempt: 1,
    priorScheduleRuns: [],
  });
  assert.equal(result.eligible, true);
  assert.equal(result.slotIndex, 0);
  assert.equal(result.status, 'ELIGIBLE_SCHEDULED_ATTEMPT');
});

test('same-slot duplicate distinct run is diagnostic-only zero credit', () => {
  const result = resolveScheduledAttempt({
    runCreatedAtMs: FIRST_NOMINAL_SCHEDULED_AT_MS + 3_000,
    actualRunStartedAtMs: FIRST_NOMINAL_SCHEDULED_AT_MS + 5_000,
    runAttempt: 1,
    priorScheduleRuns: [{ runAttempt: 1, createdAtMs: FIRST_NOMINAL_SCHEDULED_AT_MS + 1_000 }],
  });
  assert.equal(result.status, 'DIAGNOSTIC_ONLY_DUPLICATE_SLOT');
  assert.equal(result.prospectiveSlotCredit, 0);
});

test('rerun is diagnostic-only zero credit', () => {
  const result = resolveScheduledAttempt({
    runCreatedAtMs: FIRST_NOMINAL_SCHEDULED_AT_MS + 1_000,
    actualRunStartedAtMs: FIRST_NOMINAL_SCHEDULED_AT_MS + 2_000,
    runAttempt: 2,
  });
  assert.equal(result.status, 'DIAGNOSTIC_ONLY_RERUN');
  assert.equal(result.prospectiveSlotCredit, 0);
});

test('late previous-slot run fails closed instead of receiving next-slot credit', () => {
  const slot0 = slotDescriptor(0);
  const result = resolveScheduledAttempt({
    runCreatedAtMs: slot0.nominalScheduledAtMs + 1_000,
    actualRunStartedAtMs: slot0.slotEndMs + 1,
    runAttempt: 1,
  });
  assert.equal(result.status, 'MISSED_SLOT');
  assert.equal(result.prospectiveSlotCredit, 0);
});

test('manual trigger receipt always has zero scheduled/replay/backfill/operator credit', () => {
  const receipt = buildAttemptReceipt({
    triggerSource: MANUAL_TRIGGER_SOURCE,
    runId: '1', runAttempt: 1,
    exactMainSha, collectorCodeSha: exactMainSha,
    actualRunStartedAtMs: FIRST_NOMINAL_SCHEDULED_AT_MS,
    runCreatedAtMs: FIRST_NOMINAL_SCHEDULED_AT_MS,
    captureStatus: 'PRESENT', rawBatchDigest: 'a'.repeat(64), prospectiveObservationCount: 1, droppedObservationCount: 0,
  });
  assert.equal(receipt.prospectiveSlotCredit, 0);
  assert.equal(receipt.manualCredit, 0);
  assert.equal(receipt.replayCredit, 0);
  assert.equal(receipt.backfillCredit, 0);
  assert.equal(receipt.operatorSelectedCredit, 0);
});

test('wrong symbol and private provider are rejected', () => {
  const batch = validBatch();
  batch.datasetProvenance.rawSource.provider = 'PRIVATE_PROVIDER';
  batch.datasetProvenance.rawSource.privateApiUsed = true;
  batch.observations[0].symbol = 'ETHUSDT';
  const result = validateScheduledCaptureBatch(batch, { exactMainSha, symbol: 'BTCUSDT' });
  assert.equal(result.valid, false);
  assert.ok(result.blockers.includes('PRIVATE_OR_WRONG_PROVIDER'));
  assert.ok(result.blockers.includes('PRIVATE_API_USED'));
  assert.ok(result.blockers.includes('WRONG_SYMBOL'));
});

test('missing elapsed slot makes completeness false', () => {
  const asOfMs = slotDescriptor(0).slotEndMs + 1;
  const log = buildCompleteWindowAttemptLog([], { asOfMs });
  assert.equal(log.splits.TRAIN.expectedSlotN, 1);
  assert.equal(log.splits.TRAIN.attemptedSlotN, 0);
  assert.equal(log.splits.TRAIN.missingSlotN, 1);
  assert.equal(log.complete, false);
});

test('before first slot closes all dynamic completeness counters remain zero', () => {
  const log = buildCompleteWindowAttemptLog([], { asOfMs: FIRST_NOMINAL_SCHEDULED_AT_MS });
  assert.equal(log.splits.TRAIN.expectedSlotN, 0);
  assert.equal(log.splits.TRAIN.attemptedSlotN, 0);
  assert.equal(log.splits.TRAIN.missingSlotN, 0);
  assert.equal(log.splits.VALIDATION.expectedSlotN, 0);
  assert.equal(log.splits.OOS.expectedSlotN, 0);
});

test('main manual workflow remains manual-only and scheduled seam does not alter it', async () => {
  const manualPath = process.env.MANUAL_CAPTURE_WORKFLOW_PATH;
  if (!manualPath) return;
  const text = await readFile(manualPath, 'utf8');
  assert.match(text, /workflow_dispatch:/u);
  assert.doesNotMatch(text, /^\s+schedule:/mu);
  assert.match(text, /triggerSource:\s*'MANUAL_WORKFLOW_DISPATCH'/u);
});
