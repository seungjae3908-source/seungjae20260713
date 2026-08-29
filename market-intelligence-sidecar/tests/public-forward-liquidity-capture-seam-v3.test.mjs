import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { canonicalJson, sha256 } from '../src/public-forward-liquidity-calibration.mjs';
import {
  CAPTURE_PARAMETER_POLICY,
  CAPTURE_PARAMETER_POLICY_DIGEST,
  FIRST_NOMINAL_SCHEDULED_AT_MS,
  MANUAL_TRIGGER_SOURCE,
  SCHEDULED_TRIGGER_SOURCE,
  SLOT_EXECUTION_OFFSET_MS,
  SLOT_EXECUTION_RULE,
  V3_POLICY_BINDING,
  buildCompleteWindowAttemptLog,
  buildV3ScheduleEntries,
  executeCaptureSeam,
  resolveScheduledAuthority,
  verifyActivationContract,
  verifyV3PolicyBinding,
} from '../src/public-forward-liquidity-capture-seam-v3.mjs';

const EXACT_MAIN = '7c6a6c754b0906abac7124945bb9b9014b2af4e0';

function validBatch({ privateApiUsed = false, symbol = 'BTCUSDT' } = {}) {
  return {
    kind: 'public-forward-liquidity-calibration-batch',
    sampleClass: 'FORWARD_NATURAL_SAMPLE',
    capability: { PUBLIC_CALIBRATION_DATA_CAPABLE: true },
    datasetProvenance: {
      collectorCodeSha: EXACT_MAIN,
      rawSource: { provider: 'BITGET_PUBLIC_UTA_V3', privateApiUsed },
      droppedReasons: {},
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
    observations: [{
      observationId: 'liquidity-observation:test',
      sampleClass: 'FORWARD_NATURAL_SAMPLE',
      forwardCalibrationSampleCredit: 1,
      historicalBackfillForwardCredit: 0,
      collectorCodeSha: EXACT_MAIN,
      market: 'CRYPTO_FUTURES',
      symbol,
      publicDataSource: 'BITGET_PUBLIC_UTA_V3',
      sourceDigest: 'a'.repeat(64),
      calibrationSourceOnly: true,
      executionCostEligible: false,
      liquidityImpactCoefficient: null,
      causalMarketImpactClaim: false,
      paperOrderSourceAllowed: false,
    }],
    droppedEvents: [],
  };
}

function activationContract(overrides = {}) {
  const body = {
    activationContractVersion: 'public-forward-liquidity-v3-activation-contract-v1',
    v3PolicyHeadSha: V3_POLICY_BINDING.policyHeadSha,
    v3PolicyDigest: V3_POLICY_BINDING.policyDigest,
    v3PolicyArtifactId: V3_POLICY_BINDING.policyArtifactId,
    v3PolicyArtifactDigest: V3_POLICY_BINDING.policyArtifactDigest,
    v3PolicyInternalArtifactDigest: V3_POLICY_BINDING.policyInternalArtifactDigest,
    v3CohortDigest: V3_POLICY_BINDING.cohortDigest,
    exactScheduledWorkflowSha: '1'.repeat(40),
    captureWorkflowSha: '2'.repeat(40),
    collectorCodeSha: CAPTURE_PARAMETER_POLICY.collectorImplementationBlobSha,
    collectorCodeShaSemantics: 'GIT_BLOB_SHA1_OF_CANONICAL_COLLECTOR_IMPLEMENTATION',
    runtimeCollectorCodeShaRule: 'EQUALS_EXACT_MAIN_SHA_AT_RUN',
    slotExecutionRule: SLOT_EXECUTION_RULE,
    slotExecutionOffsetMs: SLOT_EXECUTION_OFFSET_MS,
    cronUtc: buildV3ScheduleEntries().map((entry) => entry.cronUtc),
    captureParameterPolicyDigest: CAPTURE_PARAMETER_POLICY_DIGEST,
    defaultBranchRequired: true,
    manualCredit: 0,
    createdAt: '2026-08-29T23:00:00.000Z',
    initialCompleteWindowAttemptLog: buildCompleteWindowAttemptLog([], { asOfMs: V3_POLICY_BINDING.cohortEligibleAfterMs - 1 }),
    ...overrides,
  };
  return { ...body, activationContractDigest: sha256(canonicalJson(body)) };
}

test('V3 slot mapping is deterministic, complete, and date-scoped in UTC', () => {
  const slots = buildV3ScheduleEntries();
  assert.equal(slots.length, 48);
  assert.equal(new Set(slots.map((slot) => slot.cronUtc)).size, 48);
  assert.equal(FIRST_NOMINAL_SCHEDULED_AT_MS, Math.ceil(V3_POLICY_BINDING.cohortEligibleAfterMs / 60_000) * 60_000);
  assert.equal(SLOT_EXECUTION_OFFSET_MS, 40_000);
  assert.equal(slots[0].cronUtc, '43 22 30 8 *');
  assert.equal(slots.at(-1).cronUtc, '13 22 31 8 *');
  assert.deepEqual(
    slots.reduce((counts, slot) => ({ ...counts, [slot.split]: (counts[slot.split] ?? 0) + 1 }), {}),
    { TRAIN: 24, VALIDATION: 12, OOS: 12 },
  );
  for (const slot of slots) {
    assert.ok(slot.slotStartMs <= slot.nominalScheduledAtMs);
    assert.ok(slot.nominalScheduledAtMs < slot.slotEndMs);
  }
});

test('correct scheduled slot is eligible but the same event delayed into the next slot is MISSED_SLOT', () => {
  const [slot0, slot1] = buildV3ScheduleEntries();
  const eligible = resolveScheduledAuthority({
    scheduleExpression: slot0.cronUtc,
    actualRunStartedAtMs: slot0.nominalScheduledAtMs,
    runAttempt: 1,
  });
  assert.equal(eligible.eligible, true);
  assert.equal(eligible.prospectiveSlotCredit, 1);
  const late = resolveScheduledAuthority({
    scheduleExpression: slot0.cronUtc,
    actualRunStartedAtMs: slot1.nominalScheduledAtMs,
    runAttempt: 1,
  });
  assert.equal(late.eligible, false);
  assert.equal(late.captureStatus, 'MISSED_SLOT');
  assert.equal(late.prospectiveSlotCredit, 0);
});

test('pre-eligibility, rerun, and duplicate attempts are zero-credit', () => {
  const [slot0] = buildV3ScheduleEntries();
  const pre = resolveScheduledAuthority({
    scheduleExpression: slot0.cronUtc,
    actualRunStartedAtMs: slot0.nominalScheduledAtMs - 1,
    runAttempt: 1,
  });
  assert.equal(pre.captureStatus, 'PRE_ELIGIBILITY_ATTEMPT');
  assert.equal(pre.prospectiveSlotCredit, 0);
  const rerun = resolveScheduledAuthority({
    scheduleExpression: slot0.cronUtc,
    actualRunStartedAtMs: slot0.nominalScheduledAtMs,
    runAttempt: 2,
  });
  assert.equal(rerun.captureStatus, 'DIAGNOSTIC_ONLY');
  assert.equal(rerun.prospectiveSlotCredit, 0);
  const duplicate = resolveScheduledAuthority({
    scheduleExpression: slot0.cronUtc,
    actualRunStartedAtMs: slot0.nominalScheduledAtMs,
    duplicateCanonicalArtifact: true,
  });
  assert.equal(duplicate.captureStatus, 'DIAGNOSTIC_ONLY');
  assert.equal(duplicate.prospectiveSlotCredit, 0);
});

test('manual capture preserves existing symbol scope but cannot receive V3 scheduled credit', async () => {
  const result = await executeCaptureSeam({
    triggerSource: MANUAL_TRIGGER_SOURCE,
    exactMainSha: EXACT_MAIN,
    symbol: 'ETHUSDT',
    actualRunStartedAtMs: V3_POLICY_BINDING.cohortEligibleAfterMs,
    collector: async () => validBatch({ symbol: 'ETHUSDT' }),
  });
  assert.equal(result.captureReceipt.triggerSource, MANUAL_TRIGGER_SOURCE);
  assert.equal(result.captureReceipt.symbol, 'ETHUSDT');
  assert.equal(result.captureReceipt.captureStatus, 'PRESENT');
  assert.equal(result.captureReceipt.prospectiveSlotCredit, 0);
  assert.equal(result.captureReceipt.manualCredit, 0);
  assert.equal(result.captureReceipt.replayCredit, 0);
  assert.equal(result.captureReceipt.backfillCredit, 0);
  assert.equal(result.captureReceipt.operatorSelectedCredit, 0);
});

test('scheduled receipt binds V3 policy/cohort/slot and only credits a PRESENT first attempt', async () => {
  const [slot0] = buildV3ScheduleEntries();
  const authority = resolveScheduledAuthority({
    scheduleExpression: slot0.cronUtc,
    actualRunStartedAtMs: slot0.nominalScheduledAtMs,
  });
  const contract = activationContract();
  const result = await executeCaptureSeam({
    triggerSource: SCHEDULED_TRIGGER_SOURCE,
    exactMainSha: EXACT_MAIN,
    actualRunStartedAtMs: slot0.nominalScheduledAtMs,
    scheduledAuthority: authority,
    activationContract: contract,
    collector: async () => validBatch(),
  });
  const receipt = result.captureReceipt;
  assert.equal(receipt.captureStatus, 'PRESENT');
  assert.equal(receipt.prospectiveSlotCredit, 1);
  assert.equal(receipt.policyVersion, '3');
  assert.equal(receipt.policyDigest, V3_POLICY_BINDING.policyDigest);
  assert.equal(receipt.policyArtifactId, V3_POLICY_BINDING.policyArtifactId);
  assert.equal(receipt.policyArtifactDigest, V3_POLICY_BINDING.policyArtifactDigest);
  assert.equal(receipt.cohortId, V3_POLICY_BINDING.cohortId);
  assert.equal(receipt.cohortDigest, V3_POLICY_BINDING.cohortDigest);
  assert.equal(receipt.slotIndex, 0);
  assert.equal(receipt.activationContractDigest, contract.activationContractDigest);
  assert.equal(receipt.executionAuthority, 'NONE');
  assert.equal(receipt.privateApiUsed, false);
  assert.equal(receipt.liveTrading, false);
  assert.equal(receipt.orderSubmitted, false);
});

test('provider failure still leaves ATTEMPTED=true and zero credit', async () => {
  const [slot0] = buildV3ScheduleEntries();
  const authority = resolveScheduledAuthority({
    scheduleExpression: slot0.cronUtc,
    actualRunStartedAtMs: slot0.nominalScheduledAtMs,
  });
  const result = await executeCaptureSeam({
    triggerSource: SCHEDULED_TRIGGER_SOURCE,
    exactMainSha: EXACT_MAIN,
    actualRunStartedAtMs: slot0.nominalScheduledAtMs,
    scheduledAuthority: authority,
    activationContract: activationContract(),
    collector: async () => { throw new Error('NETWORK_UNAVAILABLE'); },
  });
  assert.equal(result.batch, null);
  assert.equal(result.captureReceipt.ATTEMPTED, true);
  assert.equal(result.captureReceipt.captureStatus, 'PROVIDER_FAILURE');
  assert.equal(result.captureReceipt.prospectiveSlotCredit, 0);
});

test('private provider or wrong scheduled symbol cannot gain scheduled credit', async () => {
  const [slot0] = buildV3ScheduleEntries();
  const authority = resolveScheduledAuthority({
    scheduleExpression: slot0.cronUtc,
    actualRunStartedAtMs: slot0.nominalScheduledAtMs,
  });
  const privateProvider = await executeCaptureSeam({
    triggerSource: SCHEDULED_TRIGGER_SOURCE,
    exactMainSha: EXACT_MAIN,
    actualRunStartedAtMs: slot0.nominalScheduledAtMs,
    scheduledAuthority: authority,
    activationContract: activationContract(),
    collector: async () => validBatch({ privateApiUsed: true }),
  });
  assert.equal(privateProvider.captureReceipt.captureStatus, 'VALIDATION_FAILURE');
  assert.equal(privateProvider.captureReceipt.prospectiveSlotCredit, 0);
  await assert.rejects(() => executeCaptureSeam({
    triggerSource: SCHEDULED_TRIGGER_SOURCE,
    exactMainSha: EXACT_MAIN,
    symbol: 'ETHUSDT',
    actualRunStartedAtMs: slot0.nominalScheduledAtMs,
    scheduledAuthority: authority,
    activationContract: activationContract(),
    collector: async () => validBatch({ symbol: 'ETHUSDT' }),
  }), /CAPTURE_SYMBOL_NOT_V3_SCOPE/u);
});

test('replay/backfill trigger classes are rejected instead of promoted', async () => {
  await assert.rejects(() => executeCaptureSeam({
    triggerSource: 'REPLAY',
    exactMainSha: EXACT_MAIN,
  }), /CAPTURE_TRIGGER_SOURCE_INVALID/u);
  await assert.rejects(() => executeCaptureSeam({
    triggerSource: 'BACKFILL',
    exactMainSha: EXACT_MAIN,
  }), /CAPTURE_TRIGGER_SOURCE_INVALID/u);
});

test('activation contract rejects V3 artifact, cohort, policy-head, and digest mismatches', () => {
  assert.equal(verifyActivationContract(activationContract()).valid, true);
  for (const override of [
    { v3PolicyHeadSha: '0'.repeat(40) },
    { v3PolicyDigest: '0'.repeat(64) },
    { v3PolicyArtifactDigest: '0'.repeat(64) },
    { v3CohortDigest: '0'.repeat(64) },
  ]) {
    const candidate = activationContract(override);
    assert.equal(verifyActivationContract(candidate).valid, false);
  }
  const corrupted = activationContract();
  corrupted.manualCredit = 1;
  assert.equal(verifyActivationContract(corrupted).valid, false);
});

test('V3 policy binding rejects a wrong policy head', () => {
  assert.equal(verifyV3PolicyBinding().valid, true);
  assert.equal(verifyV3PolicyBinding({ ...V3_POLICY_BINDING, policyHeadSha: '0'.repeat(40) }).valid, false);
});

test('complete-window audit is zero before cohort and fails closed on missing slots after the window', () => {
  const before = buildCompleteWindowAttemptLog([], { asOfMs: V3_POLICY_BINDING.cohortEligibleAfterMs - 1 });
  assert.equal(before.splits.TRAIN.attemptedSlotN, 0);
  assert.equal(before.splits.TRAIN.missingSlotN, 0);
  assert.equal(before.splits.VALIDATION.missingSlotN, 0);
  assert.equal(before.splits.OOS.missingSlotN, 0);
  assert.equal(before.selectionComplete, false);
  const after = buildCompleteWindowAttemptLog([], { asOfMs: V3_POLICY_BINDING.cohortEndExclusiveMs });
  assert.equal(after.splits.TRAIN.expectedSlotN, 24);
  assert.equal(after.splits.VALIDATION.expectedSlotN, 12);
  assert.equal(after.splits.OOS.expectedSlotN, 12);
  assert.equal(after.splits.TRAIN.missingSlotN, 24);
  assert.equal(after.splits.VALIDATION.missingSlotN, 12);
  assert.equal(after.splits.OOS.missingSlotN, 12);
  assert.equal(after.selectionComplete, false);
});

test('capture parameter policy exactly reuses merged collector defaults', async () => {
  const source = await readFile(new URL('../src/public-forward-liquidity-calibration.mjs', import.meta.url), 'utf8');
  assert.match(source, /eventObservationDelayMs = 2_000/u);
  assert.match(source, /postObservationDelaysMs = \[1_000, 5_000\]/u);
  assert.match(source, /maxPreEventBookAgeMs = 5_000/u);
  assert.equal(CAPTURE_PARAMETER_POLICY.eventObservationDelayMs, 2_000);
  assert.deepEqual(CAPTURE_PARAMETER_POLICY.postObservationDelaysMs, [1_000, 5_000]);
  assert.equal(CAPTURE_PARAMETER_POLICY.maxPreEventBookAgeMs, 5_000);
  assert.equal(CAPTURE_PARAMETER_POLICY_DIGEST, 'ab4193df073303568dd8b4c55caa5d6c5a2a88547857935d1db13dacb9e8154f');
});

test('scheduled wrapper cron set is exactly the 48 V3-derived UTC slots and manual workflow remains unscheduled', async () => {
  const scheduledWorkflow = await readFile(new URL('../../.github/workflows/public-forward-liquidity-calibration-scheduled-v3.yml', import.meta.url), 'utf8');
  const declaredCron = [...scheduledWorkflow.matchAll(/^\s+- cron: '([^']+)'\s*$/gmu)].map((match) => match[1]);
  assert.deepEqual(declaredCron, buildV3ScheduleEntries().map((entry) => entry.cronUtc));
  assert.match(scheduledWorkflow, /schedule:/u);
  assert.match(scheduledWorkflow, /github\.event_name == 'schedule'/u);
  assert.match(scheduledWorkflow, /date \+%s%3N/u);
  assert.match(scheduledWorkflow, /github\.rest\.actions\.getArtifact/u);
  assert.doesNotMatch(scheduledWorkflow, /getWorkflowRun/u);
  const manualWorkflow = await readFile(new URL('../../.github/workflows/public-forward-liquidity-calibration-capture.yml', import.meta.url), 'utf8');
  assert.match(manualWorkflow, /workflow_dispatch:/u);
  assert.doesNotMatch(manualWorkflow, /^\s+schedule:/mu);
  assert.match(manualWorkflow, /MANUAL_WORKFLOW_DISPATCH/u);
});

test('shared runner preserves legacy manual v1 receipts for #811 while scheduled receipts remain V3', async () => {
  const runner = await readFile(new URL('../scripts/run-public-forward-liquidity-capture-seam-v3.mjs', import.meta.url), 'utf8');
  assert.match(runner, /buildLegacyManualCaptureReceipt/u);
  assert.match(runner, /public-forward-liquidity-capture-receipt-v1/u);
  assert.match(runner, /PUBLIC_FORWARD_LIQUIDITY_CAPTURE_RECEIPT/u);
  assert.match(runner, /public-forward-liquidity-capture-artifact-receipt-v1/u);
  assert.match(runner, /captureReceipt\.schemaVersion === 'public-forward-liquidity-capture-receipt-v1'/u);
  assert.match(runner, /seamSourceBlobSha/u);
  assert.match(runner, /seamRunnerBlobSha/u);
});
