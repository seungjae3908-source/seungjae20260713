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
      sourceDigest: String(index + 1).repeat(64).slice(0, 64),
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
  const slot = buildSuccessorSlotDescriptor(0);
  return {
    eventName: SUCCESSOR_SCHEDULE_EVENT_NAME,
    scheduleExpression: SUCCESSOR_SCHEDULE_CRON_UTC,
    actualRunStartedAtMs: slot.nominalScheduledAtMs,
    runAttempt: 1,
    duplicateCanonicalArtifact: false,
    ...overrides,
  };
}

test('frozen Successor cohort and 5000ms OOS contracts are valid before seam use', () => {
  const verdict = verifySuccessorScheduleSeamFrozenBindings();
  assert.equal(verdict.valid, true, verdict.blockers.join(','));
  assert.equal(SUCCESSOR_SCHEDULE_CRON_UTC, '17 * * * *');
  assert.equal(COHORT.slotCadenceMs, 3_600_000);
  assert.equal(COHORT.totalSlotN, 336);
  assert.equal(SUCCESSOR_OOS_HORIZON_CONTRACT.policyCore.outcomePolicy.outcomeHorizonMs, 5_000);
  assert.equal(
    SUCCESSOR_OOS_HORIZON_CONTRACT.policyCore.outcomePolicy.outcomeSelectionPolicy,
    'FIRST_PUBLIC_OBSERVATION_AT_OR_AFTER_HORIZON',
  );
});

test('actual start deterministically resolves the immutable Successor slot and split', () => {
  const first = resolveSuccessorScheduledAuthority(eligibleArgs());
  assert.equal(first.eligible, true);
  assert.equal(first.slot.slotIndex, 0);
  assert.equal(first.slot.split, 'TRAIN');
  assert.equal(first.slot.canonicalSlotKey.policyDigest, SUCCESSOR_PROSPECTIVE_CONTRACT.policyDigest);
  assert.equal(first.slot.canonicalSlotKey.cohortDigest, SUCCESSOR_PROSPECTIVE_CONTRACT.cohortDigest);

  const validation = resolveSuccessorScheduledAuthority(eligibleArgs({
    actualRunStartedAtMs: buildSuccessorSlotDescriptor(168).nominalScheduledAtMs,
  }));
  assert.equal(validation.slot.slotIndex, 168);
  assert.equal(validation.slot.split, 'VALIDATION');

  const oos = resolveSuccessorScheduledAuthority(eligibleArgs({
    actualRunStartedAtMs: buildSuccessorSlotDescriptor(252).nominalScheduledAtMs,
  }));
  assert.equal(oos.slot.slotIndex, 252);
  assert.equal(oos.slot.split, 'OOS');
});

test('the +20 minute start boundary is inclusive and one millisecond later is zero-credit MISSED_SLOT', () => {
  const slot = buildSuccessorSlotDescriptor(0);
  const boundary = resolveSuccessorScheduledAuthority(eligibleArgs({
    actualRunStartedAtMs: slot.allowedStartThroughMs,
  }));
  assert.equal(boundary.eligible, true);
  assert.equal(boundary.prospectiveSlotCredit, 1);

  const late = resolveSuccessorScheduledAuthority(eligibleArgs({
    actualRunStartedAtMs: slot.allowedStartThroughMs + 1,
  }));
  assert.equal(late.eligible, false);
  assert.equal(late.captureStatus, 'MISSED_SLOT');
  assert.equal(late.prospectiveSlotCredit, 0);
});

test('wrong event/cron, pre/post cohort, rerun, and duplicate never become eligible', () => {
  const cases = [
    eligibleArgs({ eventName: 'workflow_dispatch' }),
    eligibleArgs({ scheduleExpression: '18 * * * *' }),
    eligibleArgs({ actualRunStartedAtMs: COHORT.startInclusiveMs - 1 }),
    eligibleArgs({ actualRunStartedAtMs: COHORT.endExclusiveMs }),
    eligibleArgs({ runAttempt: 2 }),
    eligibleArgs({ duplicateCanonicalArtifact: true }),
  ];
  for (const candidate of cases) {
    const result = resolveSuccessorScheduledAuthority(candidate);
    assert.equal(result.eligible, false);
    assert.equal(result.prospectiveSlotCredit, 0);
  }
});

test('eligible exact-main scheduled capture uses the canonical collector contract and earns only receipt credit', async () => {
  const slot = buildSuccessorSlotDescriptor(0);
  let collectorCalls = 0;
  let received = null;
  const result = await executeSuccessorScheduledCaptureSeam({
    ...eligibleArgs(),
    exactMainSha: EXACT_MAIN,
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
  assert.equal(result.captureReceipt.prospectiveSlotCredit, 1);
  assert.equal(result.captureReceipt.slotIndex, 0);
  assert.equal(result.captureReceipt.split, 'TRAIN');
  assert.equal(result.captureReceipt.executionAuthority, 'NONE');
  assert.equal(result.captureReceipt.canonicalDatasetPersistencePerformed, false);
  assert.equal(result.captureReceipt.oosValidationComplete, false);
  assert.equal(result.captureReceipt.fullCostReady, false);
  assert.equal(result.captureReceipt.profitabilityProven, false);
});

test('remote main mismatch before capture prevents collector invocation', async () => {
  let calls = 0;
  const result = await executeSuccessorScheduledCaptureSeam({
    ...eligibleArgs(),
    exactMainSha: EXACT_MAIN,
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
    getRemoteMainSha: sameMainResolver(EXACT_MAIN, 'f'.repeat(40)),
    clock: () => buildSuccessorSlotDescriptor(0).nominalScheduledAtMs + 5_000,
    collector: async () => batch,
  });
  assert.deepEqual(result.batch, batch);
  assert.equal(result.captureReceipt.captureStatus, 'PRESENT_ZERO_CREDIT');
  assert.equal(result.captureReceipt.prospectiveSlotCredit, 0);
  assert.ok(result.captureReceipt.blockers.includes('SUCCESSOR_REMOTE_MAIN_CHANGED_DURING_CAPTURE'));
});

test('invalid or private batch fails closed and cannot receive prospective credit', async () => {
  const result = await executeSuccessorScheduledCaptureSeam({
    ...eligibleArgs(),
    exactMainSha: EXACT_MAIN,
    getRemoteMainSha: sameMainResolver(EXACT_MAIN, EXACT_MAIN),
    clock: () => buildSuccessorSlotDescriptor(0).nominalScheduledAtMs + 5_000,
    collector: async () => validBatch({ privateApiUsed: true }),
  });
  assert.equal(result.captureReceipt.captureStatus, 'VALIDATION_FAILURE');
  assert.equal(result.captureReceipt.prospectiveSlotCredit, 0);
});

test('empty genuine collector result is BLOCKED_DATA, never measured zero success', async () => {
  const result = await executeSuccessorScheduledCaptureSeam({
    ...eligibleArgs(),
    exactMainSha: EXACT_MAIN,
    getRemoteMainSha: sameMainResolver(EXACT_MAIN, EXACT_MAIN),
    clock: () => buildSuccessorSlotDescriptor(0).nominalScheduledAtMs + 5_000,
    collector: async () => validBatch({ observations: 0 }),
  });
  assert.equal(result.captureReceipt.captureStatus, 'BLOCKED_DATA');
  assert.equal(result.captureReceipt.prospectiveObservationCount, 0);
  assert.equal(result.captureReceipt.prospectiveSlotCredit, 0);
});

test('artifact receipt binds immutable raw lineage without promoting downstream authority', async () => {
  const slot = buildSuccessorSlotDescriptor(0);
  const capture = await executeSuccessorScheduledCaptureSeam({
    ...eligibleArgs(),
    exactMainSha: EXACT_MAIN,
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
