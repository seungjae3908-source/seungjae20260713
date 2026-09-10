import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { canonicalJson, sha256 } from '../src/public-forward-liquidity-calibration.mjs';
import {
  SUCCESSOR_PROSPECTIVE_CONTRACT,
  buildSuccessorSlotDescriptor,
} from '../src/public-forward-liquidity-successor-prospective-cohort.mjs';
import {
  SUCCESSOR_OOS_HORIZON_CONTRACT,
} from '../src/public-forward-liquidity-successor-oos-outcome-horizon.mjs';
import {
  SUCCESSOR_SCHEDULE_CRON_UTC,
  SUCCESSOR_SCHEDULE_EVENT_NAME,
  executeSuccessorScheduledCaptureSeam,
  finalizeSuccessorArtifactReceipt,
  resolveSuccessorScheduledAuthority,
  verifySuccessorScheduleSeamFrozenBindings,
} from '../src/public-forward-liquidity-successor-schedule-seam-v1.mjs';

const EXACT_MAIN = '9d01c7a80b5d33faf29a59990d75cc2292441f82';
const COHORT = SUCCESSOR_PROSPECTIVE_CONTRACT.policyCore.cohort;
const noPriorCredit = async () => false;

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
      observationId: `successor-observation:${index}`,
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

function sameMainResolver(...values) {
  let index = 0;
  return async () => values[Math.min(index++, values.length - 1)];
}

function eligibleArgs(overrides = {}) {
  const slot0 = buildSuccessorSlotDescriptor(0);
  const actual = overrides.actualRunStartedAtMs ?? slot0.nominalScheduledAtMs;
  let created = slot0.nominalScheduledAtMs;
  if (actual >= COHORT.startInclusiveMs && actual < COHORT.endExclusiveMs) {
    const index = Math.floor((actual - COHORT.startInclusiveMs) / COHORT.slotCadenceMs);
    created = buildSuccessorSlotDescriptor(index).nominalScheduledAtMs;
  }
  return {
    eventName: SUCCESSOR_SCHEDULE_EVENT_NAME,
    scheduleExpression: SUCCESSOR_SCHEDULE_CRON_UTC,
    scheduledRunCreatedAtMs: overrides.scheduledRunCreatedAtMs ?? created,
    actualRunStartedAtMs: actual,
    runAttempt: 1,
    ...overrides,
  };
}

test('frozen Successor 1024-slot cohort and 5000ms OOS contracts are valid before seam use', () => {
  const verdict = verifySuccessorScheduleSeamFrozenBindings();
  assert.equal(verdict.valid, true, verdict.blockers.join(','));
  assert.equal(SUCCESSOR_SCHEDULE_CRON_UTC, '17 * * * *');
  assert.equal(COHORT.slotCadenceMs, 3_600_000);
  assert.equal(COHORT.totalSlotN, 1024);
  assert.equal(SUCCESSOR_OOS_HORIZON_CONTRACT.policyCore.outcomePolicy.outcomeHorizonMs, 5_000);
  assert.equal(
    SUCCESSOR_OOS_HORIZON_CONTRACT.policyCore.outcomePolicy.outcomeSelectionPolicy,
    'FIRST_PUBLIC_OBSERVATION_AT_OR_AFTER_HORIZON',
  );
});

test('resolver only grants attempt eligibility and never sample credit by itself', () => {
  const first = resolveSuccessorScheduledAuthority(eligibleArgs());
  assert.equal(first.eligible, true);
  assert.equal(first.creditEligibleIfPresent, true);
  assert.equal(first.maximumProspectiveSlotCredit, 1);
  assert.equal(first.prospectiveSlotCredit, 0);
  assert.equal(first.captureStatus, 'ELIGIBLE_TO_ATTEMPT_CAPTURE');
  assert.equal(first.slot.slotIndex, 0);
  assert.equal(first.slot.split, 'TRAIN');
  assert.equal(first.slot.canonicalSlotKey.policyDigest, SUCCESSOR_PROSPECTIVE_CONTRACT.policyDigest);
  assert.equal(first.slot.canonicalSlotKey.cohortDigest, SUCCESSOR_PROSPECTIVE_CONTRACT.cohortDigest);

  const validation = resolveSuccessorScheduledAuthority(eligibleArgs({
    actualRunStartedAtMs: buildSuccessorSlotDescriptor(512).nominalScheduledAtMs,
  }));
  assert.equal(validation.slot.slotIndex, 512);
  assert.equal(validation.slot.split, 'VALIDATION');
  assert.equal(validation.prospectiveSlotCredit, 0);

  const oos = resolveSuccessorScheduledAuthority(eligibleArgs({
    actualRunStartedAtMs: buildSuccessorSlotDescriptor(768).nominalScheduledAtMs,
  }));
  assert.equal(oos.slot.slotIndex, 768);
  assert.equal(oos.slot.split, 'OOS');
  assert.equal(oos.prospectiveSlotCredit, 0);
});

test('last redesigned slot remains eligible while slot 1024 is post-cohort', () => {
  const last = buildSuccessorSlotDescriptor(1023);
  const eligible = resolveSuccessorScheduledAuthority(eligibleArgs({
    actualRunStartedAtMs: last.nominalScheduledAtMs,
  }));
  assert.equal(eligible.eligible, true);
  assert.equal(eligible.slot.slotIndex, 1023);
  assert.equal(eligible.slot.split, 'OOS');

  const post = resolveSuccessorScheduledAuthority(eligibleArgs({
    scheduledRunCreatedAtMs: COHORT.endExclusiveMs,
    actualRunStartedAtMs: COHORT.endExclusiveMs,
  }));
  assert.equal(post.eligible, false);
  assert.equal(post.captureStatus, 'POST_COHORT_ATTEMPT');
  assert.equal(post.prospectiveSlotCredit, 0);
});

test('queued old schedule event cannot cross an hour boundary and masquerade as the next slot', () => {
  const slot0 = buildSuccessorSlotDescriptor(0);
  const slot1 = buildSuccessorSlotDescriptor(1);
  const delayed = resolveSuccessorScheduledAuthority(eligibleArgs({
    scheduledRunCreatedAtMs: slot0.nominalScheduledAtMs,
    actualRunStartedAtMs: slot1.nominalScheduledAtMs,
  }));
  assert.equal(delayed.eligible, false);
  assert.equal(delayed.captureStatus, 'SCHEDULE_PROVENANCE_INVALID');
  assert.equal(delayed.blocker, 'SUCCESSOR_SCHEDULE_QUEUE_CROSSED_SLOT_BOUNDARY');
  assert.equal(delayed.prospectiveSlotCredit, 0);
});

test('the +20 minute start boundary is inclusive and one millisecond later is zero-credit MISSED_SLOT', () => {
  const slot = buildSuccessorSlotDescriptor(0);
  const boundary = resolveSuccessorScheduledAuthority(eligibleArgs({
    actualRunStartedAtMs: slot.allowedStartThroughMs,
  }));
  assert.equal(boundary.eligible, true);
  assert.equal(boundary.creditEligibleIfPresent, true);
  assert.equal(boundary.prospectiveSlotCredit, 0);

  const late = resolveSuccessorScheduledAuthority(eligibleArgs({
    actualRunStartedAtMs: slot.allowedStartThroughMs + 1,
  }));
  assert.equal(late.eligible, false);
  assert.equal(late.captureStatus, 'MISSED_SLOT');
  assert.equal(late.prospectiveSlotCredit, 0);
});

test('wrong event/cron, pre/post cohort, and rerun never become eligible', () => {
  const cases = [
    eligibleArgs({ eventName: 'workflow_dispatch' }),
    eligibleArgs({ scheduleExpression: '18 * * * *' }),
    eligibleArgs({ actualRunStartedAtMs: COHORT.startInclusiveMs - 1 }),
    eligibleArgs({
      scheduledRunCreatedAtMs: COHORT.endExclusiveMs,
      actualRunStartedAtMs: COHORT.endExclusiveMs,
    }),
    eligibleArgs({ runAttempt: 2 }),
  ];
  for (const candidate of cases) {
    const result = resolveSuccessorScheduledAuthority(candidate);
    assert.equal(result.eligible, false);
    assert.equal(result.creditEligibleIfPresent, false);
    assert.equal(result.prospectiveSlotCredit, 0);
  }
});

test('eligible exact-main scheduled capture uses the canonical collector contract and earns credit only in final receipt', async () => {
  const slot = buildSuccessorSlotDescriptor(0);
  let collectorCalls = 0;
  let received = null;
  const result = await executeSuccessorScheduledCaptureSeam({
    ...eligibleArgs(),
    exactMainSha: EXACT_MAIN,
    hasPriorCreditedSlot: noPriorCredit,
    getRemoteMainSha: sameMainResolver(EXACT_MAIN, EXACT_MAIN),
    clock: () => slot.nominalScheduledAtMs + 5_000,
    runId: '12345',
    repository: 'seungjae3908-source/seungjae20260713',
    collector: async (input) => {
      collectorCalls += 1;
      received = input;
      return validBatch();
    },
  });

  assert.equal(collectorCalls, 1);
  assert.deepEqual(received.postObservationDelaysMs, [1_000, 5_000]);
  assert.equal(received.eventObservationDelayMs, 2_000);
  assert.equal(received.maxPreEventBookAgeMs, 5_000);
  assert.equal(received.collectorCodeSha, EXACT_MAIN);
  assert.equal(result.captureReceipt.captureStatus, 'PRESENT');
  assert.equal(result.captureReceipt.priorCreditedSlotCheck, 'CLEAR');
  assert.equal(result.captureReceipt.maximumProspectiveSlotCredit, 1);
  assert.equal(result.captureReceipt.prospectiveSlotCredit, 1);
  assert.equal(result.captureReceipt.slotIndex, 0);
  assert.equal(result.captureReceipt.split, 'TRAIN');
  assert.equal(result.captureReceipt.rawEvidencePreserved, true);
  assert.equal(result.captureReceipt.executionAuthority, 'NONE');
  assert.equal(result.captureReceipt.canonicalDatasetPersistencePerformed, false);
  assert.equal(result.captureReceipt.oosValidationComplete, false);
  assert.equal(result.captureReceipt.fullCostReady, false);
  assert.equal(result.captureReceipt.profitabilityProven, false);
});

test('prior credited slot lookup is mandatory and fail-closed before collector invocation', async () => {
  let collectorCalls = 0;
  const missingLookup = await executeSuccessorScheduledCaptureSeam({
    ...eligibleArgs(),
    exactMainSha: EXACT_MAIN,
    getRemoteMainSha: sameMainResolver(EXACT_MAIN),
    collector: async () => {
      collectorCalls += 1;
      return validBatch();
    },
  });
  assert.equal(collectorCalls, 0);
  assert.equal(missingLookup.captureReceipt.captureStatus, 'PRIOR_CREDIT_STATE_UNVERIFIED');
  assert.equal(missingLookup.captureReceipt.priorCreditedSlotCheck, 'UNVERIFIED');
  assert.equal(missingLookup.captureReceipt.prospectiveSlotCredit, 0);

  const duplicate = await executeSuccessorScheduledCaptureSeam({
    ...eligibleArgs(),
    exactMainSha: EXACT_MAIN,
    hasPriorCreditedSlot: async () => true,
    getRemoteMainSha: sameMainResolver(EXACT_MAIN),
    collector: async () => {
      collectorCalls += 1;
      return validBatch();
    },
  });
  assert.equal(collectorCalls, 0);
  assert.equal(duplicate.captureReceipt.captureStatus, 'DIAGNOSTIC_ONLY');
  assert.equal(duplicate.captureReceipt.priorCreditedSlotCheck, 'PRESENT');
  assert.equal(duplicate.captureReceipt.prospectiveSlotCredit, 0);
});

test('prior credited slot lookup failure cannot invoke collector or create credit', async () => {
  let calls = 0;
  const result = await executeSuccessorScheduledCaptureSeam({
    ...eligibleArgs(),
    exactMainSha: EXACT_MAIN,
    hasPriorCreditedSlot: async () => { throw new Error('ARTIFACT_INDEX_UNAVAILABLE'); },
    getRemoteMainSha: sameMainResolver(EXACT_MAIN),
    collector: async () => {
      calls += 1;
      return validBatch();
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.captureReceipt.priorCreditedSlotCheck, 'UNVERIFIED');
  assert.equal(result.captureReceipt.captureStatus, 'PRIOR_CREDIT_STATE_UNVERIFIED');
  assert.equal(result.captureReceipt.prospectiveSlotCredit, 0);
});

test('remote main mismatch before capture prevents collector invocation', async () => {
  let calls = 0;
  const result = await executeSuccessorScheduledCaptureSeam({
    ...eligibleArgs(),
    exactMainSha: EXACT_MAIN,
    hasPriorCreditedSlot: noPriorCredit,
    getRemoteMainSha: sameMainResolver('0'.repeat(40)),
    collector: async () => {
      calls += 1;
      return validBatch();
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.batch, null);
  assert.equal(result.captureReceipt.captureStatus, 'STALE_MAIN_PRE_CAPTURE');
  assert.equal(result.captureReceipt.prospectiveSlotCredit, 0);
});

test('completion after +10 minutes preserves raw evidence but gives zero prospective credit', async () => {
  const slot = buildSuccessorSlotDescriptor(0);
  const batch = validBatch();
  const result = await executeSuccessorScheduledCaptureSeam({
    ...eligibleArgs(),
    exactMainSha: EXACT_MAIN,
    hasPriorCreditedSlot: noPriorCredit,
    getRemoteMainSha: sameMainResolver(EXACT_MAIN, EXACT_MAIN),
    clock: () => slot.nominalScheduledAtMs + COHORT.allowedCompletionDelayMs + 1,
    collector: async () => batch,
  });
  assert.deepEqual(result.batch, batch);
  assert.equal(result.captureReceipt.captureStatus, 'PRESENT_ZERO_CREDIT');
  assert.equal(result.captureReceipt.prospectiveSlotCredit, 0);
  assert.ok(result.captureReceipt.blockers.includes('SUCCESSOR_CAPTURE_COMPLETED_AFTER_ALLOWED_DELAY'));
  assert.equal(result.captureReceipt.rawBatchDigest, sha256(canonicalJson(batch)));
});

test('main moving during capture preserves raw evidence but gives zero prospective credit', async () => {
  const batch = validBatch();
  const result = await executeSuccessorScheduledCaptureSeam({
    ...eligibleArgs(),
    exactMainSha: EXACT_MAIN,
    hasPriorCreditedSlot: noPriorCredit,
    getRemoteMainSha: sameMainResolver(EXACT_MAIN, 'f'.repeat(40)),
    clock: () => buildSuccessorSlotDescriptor(0).nominalScheduledAtMs + 5_000,
    collector: async () => batch,
  });
  assert.deepEqual(result.batch, batch);
  assert.equal(result.captureReceipt.captureStatus, 'PRESENT_ZERO_CREDIT');
  assert.equal(result.captureReceipt.prospectiveSlotCredit, 0);
  assert.ok(result.captureReceipt.blockers.includes('SUCCESSOR_REMOTE_MAIN_CHANGED_DURING_CAPTURE'));
});

test('invalid or private batch is preserved only as diagnostic raw evidence and cannot receive credit', async () => {
  const batch = validBatch({ privateApiUsed: true });
  const result = await executeSuccessorScheduledCaptureSeam({
    ...eligibleArgs(),
    exactMainSha: EXACT_MAIN,
    hasPriorCreditedSlot: noPriorCredit,
    getRemoteMainSha: sameMainResolver(EXACT_MAIN, EXACT_MAIN),
    clock: () => buildSuccessorSlotDescriptor(0).nominalScheduledAtMs + 5_000,
    collector: async () => batch,
  });
  assert.deepEqual(result.batch, batch);
  assert.equal(result.captureReceipt.rawEvidencePreserved, true);
  assert.equal(result.captureReceipt.captureStatus, 'VALIDATION_FAILURE');
  assert.equal(result.captureReceipt.prospectiveSlotCredit, 0);
  assert.equal(result.captureReceipt.rawBatchDigest, sha256(canonicalJson(batch)));
});

test('provider failure preserves the attempted receipt but has no fabricated raw evidence', async () => {
  const result = await executeSuccessorScheduledCaptureSeam({
    ...eligibleArgs(),
    exactMainSha: EXACT_MAIN,
    hasPriorCreditedSlot: noPriorCredit,
    getRemoteMainSha: sameMainResolver(EXACT_MAIN, EXACT_MAIN),
    clock: () => buildSuccessorSlotDescriptor(0).nominalScheduledAtMs + 5_000,
    collector: async () => { throw new Error('NETWORK_UNAVAILABLE'); },
  });
  assert.equal(result.batch, null);
  assert.equal(result.captureReceipt.ATTEMPTED, true);
  assert.equal(result.captureReceipt.rawEvidencePreserved, false);
  assert.equal(result.captureReceipt.rawBatchDigest, null);
  assert.equal(result.captureReceipt.captureStatus, 'PROVIDER_FAILURE');
  assert.equal(result.captureReceipt.prospectiveSlotCredit, 0);
});

test('empty genuine collector result is BLOCKED_DATA, never measured zero success', async () => {
  const result = await executeSuccessorScheduledCaptureSeam({
    ...eligibleArgs(),
    exactMainSha: EXACT_MAIN,
    hasPriorCreditedSlot: noPriorCredit,
    getRemoteMainSha: sameMainResolver(EXACT_MAIN, EXACT_MAIN),
    clock: () => buildSuccessorSlotDescriptor(0).nominalScheduledAtMs + 5_000,
    collector: async () => validBatch({ observations: 0 }),
  });
  assert.equal(result.captureReceipt.captureStatus, 'BLOCKED_DATA');
  assert.equal(result.captureReceipt.prospectiveObservationCount, 0);
  assert.equal(result.captureReceipt.prospectiveSlotCredit, 0);
});

test('wrong trigger remains visible as wrong trigger in its zero-credit attempt receipt', async () => {
  let calls = 0;
  const result = await executeSuccessorScheduledCaptureSeam({
    ...eligibleArgs({ eventName: 'workflow_dispatch' }),
    exactMainSha: EXACT_MAIN,
    hasPriorCreditedSlot: noPriorCredit,
    getRemoteMainSha: sameMainResolver(EXACT_MAIN),
    collector: async () => {
      calls += 1;
      return validBatch();
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.captureReceipt.eventName, 'workflow_dispatch');
  assert.equal(result.captureReceipt.captureStatus, 'WRONG_EVENT');
  assert.equal(result.captureReceipt.prospectiveSlotCredit, 0);
});

test('artifact receipt binds immutable raw lineage without promoting downstream authority', async () => {
  const slot = buildSuccessorSlotDescriptor(0);
  const capture = await executeSuccessorScheduledCaptureSeam({
    ...eligibleArgs(),
    exactMainSha: EXACT_MAIN,
    hasPriorCreditedSlot: noPriorCredit,
    getRemoteMainSha: sameMainResolver(EXACT_MAIN, EXACT_MAIN),
    clock: () => slot.nominalScheduledAtMs + 5_000,
    collector: async () => validBatch(),
  });
  const receipt = finalizeSuccessorArtifactReceipt({
    captureReceipt: capture.captureReceipt,
    artifactId: '987654321',
    artifactDigest: 'b'.repeat(64),
    artifactName: 'public-forward-liquidity-successor-slot-0',
    artifactReference: 'github-actions-artifact',
  });
  assert.equal(receipt.artifactId, '987654321');
  assert.equal(receipt.policyDigest, SUCCESSOR_PROSPECTIVE_CONTRACT.policyDigest);
  assert.equal(receipt.cohortDigest, SUCCESSOR_PROSPECTIVE_CONTRACT.cohortDigest);
  assert.equal(receipt.oosHorizonPolicyDigest, SUCCESSOR_OOS_HORIZON_CONTRACT.policyDigest);
  assert.match(receipt.receiptDigest, /^[a-f0-9]{64}$/u);
  assert.equal(receipt.canonicalDatasetCreditApplied, false);
  assert.equal(receipt.oosValidationComplete, false);
  assert.equal(receipt.executionAuthority, 'NONE');
});

test('Stage-1 validation workflow is pull-request-only and cannot activate capture', async () => {
  const workflow = await readFile(
    new URL('../../.github/workflows/public-forward-liquidity-successor-schedule-seam-validation.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /^\s{2}pull_request:\s*$/mu);
  assert.doesNotMatch(workflow, /^\s{2}schedule:\s*$/mu);
  assert.doesNotMatch(workflow, /^\s{2}workflow_dispatch:\s*$/mu);
  assert.doesNotMatch(workflow, /^\s*-\s*cron:/mu);
  assert.match(workflow, /permissions:\s*\n\s+contents:\s+read/mu);
});
