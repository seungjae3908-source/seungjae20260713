import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { canonicalJson, sha256 } from '../src/public-forward-liquidity-calibration.mjs';
import {
  SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT,
  buildSuccessorScheduleReliabilityV3SlotDescriptor,
  materializeSuccessorScheduleReliabilityV3Contract,
  verifySuccessorScheduleReliabilityV3Contract,
} from '../src/public-forward-liquidity-successor-schedule-reliability-v3.mjs';
import {
  SUCCESSOR_V3_ARTIFACT_RECEIPT_SCHEMA,
  SUCCESSOR_V3_SCHEDULE_CRONS_UTC,
  executeSuccessorScheduledCaptureSeamV3,
  finalizeSuccessorArtifactReceipt,
  resolveSuccessorScheduledAuthorityV3,
  verifySuccessorScheduleReliabilityV3FrozenBindings,
} from '../src/public-forward-liquidity-successor-schedule-seam-v1.mjs';

const EXACT_MAIN = 'e'.repeat(40);
const FREEZE_SHA =
  '10b157de8e1902865f9b386a02439bb56d67b5c2fcd20dd48870d851bdb97ff1';

const ACTIVATION_BOUNDARY_MS = Date.parse('2026-09-03T00:00:00.000Z');
const CUTOVER_START_MS = Date.parse('2026-09-03T01:17:00.000Z');

const TEST_ACTIVATION_BINDING = Object.freeze({
  schemaVersion:
    'public-forward-liquidity-successor-schedule-reliability-activation-binding-v3',
  authorityIssue: 23,
  authorityCommentId: 9999999999,
  activationBoundaryMs: ACTIVATION_BOUNDARY_MS,
  cutoverStartMs: CUTOVER_START_MS,
  authorizedCurrentMainSha: EXACT_MAIN,
  numericFreezeSha256: FREEZE_SHA,
  minActivationLeadSlots: 1,
  priorV2CreditImported: 0,
  priorV2MissedSlotRecovery: 0,
  priorV2DiagnosticArtifactCredit: 0,
  replayCredit: 0,
  backfillCredit: 0,
  syntheticCredit: 0,
});

const ACTIVE = materializeSuccessorScheduleReliabilityV3Contract(
  TEST_ACTIVATION_BINDING,
);

function sameMainResolver(...values) {
  let index = 0;
  return async () => values[Math.min(index++, values.length - 1)];
}

function validBatch({
  exactMainSha = EXACT_MAIN,
  privateApiUsed = false,
  observations = 1,
} = {}) {
  return {
    kind: 'public-forward-liquidity-calibration-batch',
    sampleClass: 'FORWARD_NATURAL_SAMPLE',
    capability: { PUBLIC_CALIBRATION_DATA_CAPABLE: true },
    datasetProvenance: {
      collectorCodeSha: exactMainSha,
      rawSource: { provider: 'BITGET_PUBLIC_UTA_V3', privateApiUsed },
      droppedReasons: observations > 0 ? {} : { NO_VALID_OBSERVATION: 1 },
    },
    safety: {
      publicDataOnly: true,
      executionAuthority: 'NONE',
      privateTradingApiAllowed: false,
      liveTradingAllowed: false,
      realOrderAllowed: false,
      financialMutationAllowed: false,
    },
    readiness: {
      LIQUIDITY_IMPACT_PRESENT: false,
      CALIBRATION_SAMPLE_SUFFICIENT: false,
      LIQUIDITY_IMPACT_STATUS: 'BLOCKED_DATA',
      FULL_COST_READY: false,
    },
    observations: Array.from({ length: observations }, (_, index) => ({
      observationId: `v3-observation:${index}`,
      sampleClass: 'FORWARD_NATURAL_SAMPLE',
      forwardCalibrationSampleCredit: 1,
      historicalBackfillForwardCredit: 0,
      collectorCodeSha: exactMainSha,
      market: 'CRYPTO_FUTURES',
      symbol: 'BTCUSDT',
      publicDataSource: 'BITGET_PUBLIC_UTA_V3',
      sourceDigest: String((index % 9) + 1).repeat(64),
      calibrationSourceOnly: true,
      executionCostEligible: false,
      liquidityImpactCoefficient: null,
      causalMarketImpactClaim: false,
      paperOrderSourceAllowed: false,
    })),
    droppedEvents: [],
  };
}

function activeArgs(overrides = {}) {
  const slot = buildSuccessorScheduleReliabilityV3SlotDescriptor(
    overrides.slotIndex ?? 0,
    ACTIVE,
  );
  const actual = overrides.actualRunStartedAtMs ?? slot.nominalScheduledAtMs;
  return {
    eventName: 'schedule',
    scheduleExpression: '17 * * * *',
    scheduledRunCreatedAtMs:
      overrides.scheduledRunCreatedAtMs ?? slot.nominalScheduledAtMs,
    actualRunStartedAtMs: actual,
    runAttempt: 1,
    contract: ACTIVE,
    ...overrides,
  };
}

test('V3 numeric freeze materializes inactive by default and preserves V2/OOS authority boundaries', () => {
  const verdict = verifySuccessorScheduleReliabilityV3FrozenBindings();
  assert.equal(verdict.valid, true, verdict.blockers.join(','));
  assert.equal(verdict.activationBound, false);
  assert.deepEqual(SUCCESSOR_V3_SCHEDULE_CRONS_UTC, [
    '17 * * * *',
    '27 * * * *',
    '37 * * * *',
  ]);

  const contractVerdict = verifySuccessorScheduleReliabilityV3Contract();
  assert.equal(contractVerdict.valid, true, contractVerdict.blockers.join(','));
  assert.equal(SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.activationBound, false);
  assert.equal(
    SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.numericFreezeSha256,
    FREEZE_SHA,
  );

  const cohort =
    SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.policyCore.cohort;
  assert.equal(cohort.slotCadenceMs, 3_600_000);
  assert.equal(cohort.scheduledAttemptNPerSlot, 3);
  assert.equal(cohort.allowedStartDelayMs, 2_700_000);
  assert.equal(cohort.allowedCompletionDelayMs, 600_000);
  assert.equal(cohort.hardSafetyGapMs, 300_000);
  assert.equal(
    cohort.allowedStartDelayMs
      + cohort.allowedCompletionDelayMs
      + cohort.hardSafetyGapMs,
    cohort.slotCadenceMs,
  );
  assert.equal(cohort.totalSlotN, 1024);
  assert.equal(
    SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.policyCore.oosBinding
      .outcomeHorizonMs,
    5_000,
  );
  assert.equal(
    SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.policyCore.oosBinding
      .outcomeHorizonRetuned,
    false,
  );
});

test('without separate activation binding V3 is inert and cannot invoke collector', async () => {
  const result = resolveSuccessorScheduledAuthorityV3({
    eventName: 'schedule',
    scheduleExpression: '17 * * * *',
    scheduledRunCreatedAtMs: CUTOVER_START_MS,
    actualRunStartedAtMs: CUTOVER_START_MS,
  });
  assert.equal(result.eligible, false);
  assert.equal(result.captureStatus, 'V3_ACTIVATION_BINDING_MISSING');
  assert.equal(result.prospectiveSlotCredit, 0);

  let calls = 0;
  const executed = await executeSuccessorScheduledCaptureSeamV3({
    eventName: 'schedule',
    scheduleExpression: '17 * * * *',
    scheduledRunCreatedAtMs: CUTOVER_START_MS,
    actualRunStartedAtMs: CUTOVER_START_MS,
    exactMainSha: EXACT_MAIN,
    hasPriorCreditedSlot: async () => false,
    getRemoteMainSha: sameMainResolver(EXACT_MAIN),
    collector: async () => {
      calls += 1;
      return validBatch();
    },
  });
  assert.equal(calls, 0);
  assert.equal(executed.batch, null);
  assert.equal(executed.captureReceipt.activationBound, false);
  assert.equal(
    executed.captureReceipt.captureStatus,
    'V3_ACTIVATION_BINDING_MISSING',
  );
  assert.equal(executed.captureReceipt.prospectiveSlotCredit, 0);
  assert.equal(executed.captureReceipt.priorV2CreditImported, 0);
});

test('activation materialization requires at least one full-slot lead and primary-minute alignment', () => {
  const verdict = verifySuccessorScheduleReliabilityV3Contract(ACTIVE);
  assert.equal(verdict.valid, true, verdict.blockers.join(','));
  assert.equal(verdict.activationBound, true);
  assert.match(ACTIVE.policyDigest, /^[a-f0-9]{64}$/u);
  assert.match(ACTIVE.cohortDigest, /^[a-f0-9]{64}$/u);
  assert.equal(ACTIVE.policyCore.cohort.startInclusiveMs, CUTOVER_START_MS);
  assert.equal(
    ACTIVE.policyCore.cohort.endExclusiveMs,
    CUTOVER_START_MS + 1024 * 3_600_000,
  );

  const tooSoon = materializeSuccessorScheduleReliabilityV3Contract({
    ...TEST_ACTIVATION_BINDING,
    cutoverStartMs: Date.parse('2026-09-03T00:17:00.000Z'),
  });
  const tooSoonVerdict = verifySuccessorScheduleReliabilityV3Contract(tooSoon);
  assert.equal(tooSoonVerdict.valid, false);
  assert.ok(
    tooSoonVerdict.blockers.includes('SUCCESSOR_V3_CUTOVER_LEAD_TOO_SHORT'),
  );

  const misaligned = materializeSuccessorScheduleReliabilityV3Contract({
    ...TEST_ACTIVATION_BINDING,
    cutoverStartMs: Date.parse('2026-09-03T01:18:00.000Z'),
  });
  const misalignedVerdict =
    verifySuccessorScheduleReliabilityV3Contract(misaligned);
  assert.equal(misalignedVerdict.valid, false);
  assert.ok(
    misalignedVerdict.blockers.includes(
      'SUCCESSOR_V3_CUTOVER_NOT_ALIGNED_TO_PRIMARY_MINUTE',
    ),
  );
});

test('all three frozen automatic trigger expressions share one hourly V3 slot authority', () => {
  const slot = buildSuccessorScheduleReliabilityV3SlotDescriptor(0, ACTIVE);
  for (const scheduleExpression of SUCCESSOR_V3_SCHEDULE_CRONS_UTC) {
    const result = resolveSuccessorScheduledAuthorityV3(activeArgs({
      scheduleExpression,
      scheduledRunCreatedAtMs: slot.nominalScheduledAtMs + 34 * 60_000,
      actualRunStartedAtMs: slot.nominalScheduledAtMs + 35 * 60_000,
    }));
    assert.equal(result.eligible, true, scheduleExpression);
    assert.equal(result.slot.slotIndex, 0);
    assert.equal(result.slot.split, 'TRAIN');
    assert.equal(result.prospectiveSlotCredit, 0);
  }
});

test('+45 minute V3 start boundary is inclusive and one millisecond later is zero-credit', () => {
  const slot = buildSuccessorScheduleReliabilityV3SlotDescriptor(0, ACTIVE);
  const boundary = resolveSuccessorScheduledAuthorityV3(activeArgs({
    scheduleExpression: '37 * * * *',
    scheduledRunCreatedAtMs: slot.allowedStartThroughMs,
    actualRunStartedAtMs: slot.allowedStartThroughMs,
  }));
  assert.equal(boundary.eligible, true);

  const late = resolveSuccessorScheduledAuthorityV3(activeArgs({
    scheduleExpression: '37 * * * *',
    scheduledRunCreatedAtMs: slot.allowedStartThroughMs,
    actualRunStartedAtMs: slot.allowedStartThroughMs + 1,
  }));
  assert.equal(late.eligible, false);
  assert.equal(late.captureStatus, 'MISSED_SLOT');
  assert.equal(late.prospectiveSlotCredit, 0);
});

test('queued schedule provenance can never cross a V3 slot boundary or be reassigned backward', () => {
  const slot0 = buildSuccessorScheduleReliabilityV3SlotDescriptor(0, ACTIVE);
  const slot1 = buildSuccessorScheduleReliabilityV3SlotDescriptor(1, ACTIVE);
  const crossed = resolveSuccessorScheduledAuthorityV3(activeArgs({
    scheduledRunCreatedAtMs: slot0.allowedStartThroughMs,
    actualRunStartedAtMs: slot1.nominalScheduledAtMs,
  }));
  assert.equal(crossed.eligible, false);
  assert.equal(crossed.captureStatus, 'SCHEDULE_PROVENANCE_INVALID');
  assert.equal(
    crossed.blocker,
    'SUCCESSOR_V3_SCHEDULE_QUEUE_CROSSED_SLOT_BOUNDARY',
  );
  assert.equal(crossed.prospectiveSlotCredit, 0);
});

test('wrong event, non-frozen cron, and rerun never become V3 eligible', () => {
  const candidates = [
    activeArgs({ eventName: 'workflow_dispatch' }),
    activeArgs({ scheduleExpression: '47 * * * *' }),
    activeArgs({ runAttempt: 2 }),
  ];
  for (const candidate of candidates) {
    const result = resolveSuccessorScheduledAuthorityV3(candidate);
    assert.equal(result.eligible, false);
    assert.equal(result.prospectiveSlotCredit, 0);
  }
});

test('already-credited V3 slot stops later fallback before collector invocation', async () => {
  const slot = buildSuccessorScheduleReliabilityV3SlotDescriptor(0, ACTIVE);
  let calls = 0;
  const result = await executeSuccessorScheduledCaptureSeamV3({
    ...activeArgs({
      scheduleExpression: '37 * * * *',
      scheduledRunCreatedAtMs: slot.nominalScheduledAtMs + 20 * 60_000,
      actualRunStartedAtMs: slot.nominalScheduledAtMs + 21 * 60_000,
    }),
    exactMainSha: EXACT_MAIN,
    hasPriorCreditedSlot: async () => true,
    getRemoteMainSha: sameMainResolver(EXACT_MAIN),
    collector: async () => {
      calls += 1;
      return validBatch();
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.batch, null);
  assert.equal(result.captureReceipt.captureStatus, 'DIAGNOSTIC_ONLY');
  assert.equal(result.captureReceipt.priorCreditedSlotCheck, 'PRESENT');
  assert.equal(result.captureReceipt.prospectiveSlotCredit, 0);
  assert.ok(
    result.captureReceipt.blockers.includes(
      'SUCCESSOR_V3_DUPLICATE_SLOT_ATTEMPT_ZERO_CREDIT',
    ),
  );
});

test('eligible delayed V3 automatic capture can earn at most one slot credit', async () => {
  const slot = buildSuccessorScheduleReliabilityV3SlotDescriptor(0, ACTIVE);
  const actual = slot.nominalScheduledAtMs + 35 * 60_000;
  let calls = 0;
  const batch = validBatch();
  const result = await executeSuccessorScheduledCaptureSeamV3({
    ...activeArgs({
      scheduleExpression: '37 * * * *',
      scheduledRunCreatedAtMs: slot.nominalScheduledAtMs + 34 * 60_000,
      actualRunStartedAtMs: actual,
    }),
    exactMainSha: EXACT_MAIN,
    hasPriorCreditedSlot: async () => false,
    getRemoteMainSha: sameMainResolver(EXACT_MAIN, EXACT_MAIN),
    clock: () => actual + 5_000,
    collector: async () => {
      calls += 1;
      return batch;
    },
  });

  assert.equal(calls, 1);
  assert.deepEqual(result.batch, batch);
  assert.equal(result.captureReceipt.captureStatus, 'PRESENT');
  assert.equal(result.captureReceipt.prospectiveSlotCredit, 1);
  assert.equal(result.captureReceipt.maximumProspectiveSlotCredit, 1);
  assert.equal(result.captureReceipt.slotIndex, 0);
  assert.equal(result.captureReceipt.cronUtc, '37 * * * *');
  assert.deepEqual(result.captureReceipt.triggerMinutesUtc, [17, 27, 37]);
  assert.equal(result.captureReceipt.allowedStartDelayMs, 2_700_000);
  assert.equal(result.captureReceipt.allowedCompletionDelayMs, 600_000);
  assert.equal(result.captureReceipt.hardSafetyGapMs, 300_000);
  assert.equal(result.captureReceipt.priorV2CreditImported, 0);
  assert.equal(result.captureReceipt.replayCredit, 0);
  assert.equal(result.captureReceipt.backfillCredit, 0);
  assert.equal(result.captureReceipt.syntheticCredit, 0);
  assert.equal(result.captureReceipt.oosOutcomeHorizonMs, 5_000);
  assert.equal(result.captureReceipt.oosOutcomeHorizonRetuned, false);
  assert.equal(result.captureReceipt.fullCostReady, false);
  assert.equal(result.captureReceipt.profitabilityProven, false);
  assert.equal(result.captureReceipt.executionAuthority, 'NONE');

  const artifactReceipt = finalizeSuccessorArtifactReceipt({
    captureReceipt: result.captureReceipt,
    artifactId: '123456789',
    artifactDigest: 'a'.repeat(64),
    artifactName: 'public-forward-liquidity-successor-slot-0-test',
    artifactReference: 'github-actions-artifact',
  });
  assert.equal(artifactReceipt.schemaVersion, SUCCESSOR_V3_ARTIFACT_RECEIPT_SCHEMA);
  assert.match(artifactReceipt.receiptDigest, /^[a-f0-9]{64}$/u);
});

test('V3 completion after +10 minutes preserves raw evidence but earns zero credit', async () => {
  const slot = buildSuccessorScheduleReliabilityV3SlotDescriptor(0, ACTIVE);
  const actual = slot.nominalScheduledAtMs + 30 * 60_000;
  const batch = validBatch();
  const result = await executeSuccessorScheduledCaptureSeamV3({
    ...activeArgs({
      scheduleExpression: '27 * * * *',
      scheduledRunCreatedAtMs: slot.nominalScheduledAtMs + 29 * 60_000,
      actualRunStartedAtMs: actual,
    }),
    exactMainSha: EXACT_MAIN,
    hasPriorCreditedSlot: async () => false,
    getRemoteMainSha: sameMainResolver(EXACT_MAIN, EXACT_MAIN),
    clock: () => actual + ACTIVE.policyCore.cohort.allowedCompletionDelayMs + 1,
    collector: async () => batch,
  });
  assert.deepEqual(result.batch, batch);
  assert.equal(result.captureReceipt.captureStatus, 'PRESENT_ZERO_CREDIT');
  assert.equal(result.captureReceipt.prospectiveSlotCredit, 0);
  assert.ok(
    result.captureReceipt.blockers.includes(
      'SUCCESSOR_V3_CAPTURE_COMPLETED_AFTER_ALLOWED_DELAY',
    ),
  );
  assert.equal(result.captureReceipt.rawBatchDigest, sha256(canonicalJson(batch)));
});

test('Draft workflow carries all three frozen triggers, queue:max, and no manual activation surface', async () => {
  const workflow = await readFile(
    new URL(
      '../../.github/workflows/public-forward-liquidity-successor-scheduled-capture.yml',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(workflow, /cron: '17 \* \* \* \*'/u);
  assert.match(workflow, /cron: '27 \* \* \* \*'/u);
  assert.match(workflow, /cron: '37 \* \* \* \*'/u);
  assert.match(workflow, /^\s{2}queue:\s+max\s*$/mu);
  assert.match(workflow, /^\s{2}cancel-in-progress:\s+false\s*$/mu);
  assert.doesNotMatch(workflow, /^\s{2}workflow_dispatch:\s*$/mu);
  assert.match(workflow, /capture-v3/u);
});
