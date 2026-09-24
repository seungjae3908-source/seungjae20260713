import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { canonicalJson, sha256 } from '../src/public-forward-liquidity-calibration.mjs';
import {
  PUBLIC_FORWARD_LIQUIDITY_MULTI_LANE_POLICY_V1,
  buildPublicForwardLiquidityMultiLaneCurrentMainBinding,
  derivePublicForwardLiquidityMultiLaneActivation,
  resolvePublicForwardLiquidityMultiLaneCreditIdentity,
  verifyPublicForwardLiquidityMultiLanePolicyV1,
} from '../src/public-forward-liquidity-multi-lane-policy-v1.mjs';
import {
  SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT,
  buildSuccessorScheduleReliabilityV3SlotDescriptor,
} from '../src/public-forward-liquidity-successor-schedule-reliability-v3.mjs';
import {
  executeSuccessorScheduledCaptureSeamV3,
} from '../src/public-forward-liquidity-successor-schedule-seam-v1.mjs';

const EXACT_MAIN = 'e'.repeat(40);
const REQUIRED_JOBS = PUBLIC_FORWARD_LIQUIDITY_MULTI_LANE_POLICY_V1
  .config.activationPolicy.requiredSuccessfulJobs;
const SUCCESSOR_ACTIVE_TEST = Object.freeze({
  skip: SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.activationBound !== true
    ? 'preserved inactive-contract regression mode'
    : false,
});

function ciEvidence(overrides = {}) {
  const completedAt = overrides.completedAt ?? '2026-09-11T06:05:00.000Z';
  return {
    exactMainSha: EXACT_MAIN,
    workflowRun: {
      id: 40000000001,
      event: 'workflow_dispatch',
      head_branch: 'main',
      head_sha: EXACT_MAIN,
      status: 'completed',
      conclusion: 'success',
      ...overrides.workflowRun,
    },
    jobs: REQUIRED_JOBS.map((name) => ({
      name,
      status: 'completed',
      conclusion: 'success',
      completed_at: completedAt,
    })),
  };
}

function validBatch(eventTimestampMs) {
  return {
    kind: 'public-forward-liquidity-calibration-batch',
    sampleClass: 'FORWARD_NATURAL_SAMPLE',
    capability: { PUBLIC_CALIBRATION_DATA_CAPABLE: true },
    datasetProvenance: {
      collectorCodeSha: EXACT_MAIN,
      rawSource: { provider: 'BITGET_PUBLIC_UTA_V3', privateApiUsed: false },
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
      observationId: 'phase2-observation-1',
      sampleClass: 'FORWARD_NATURAL_SAMPLE',
      forwardCalibrationSampleCredit: 1,
      historicalBackfillForwardCredit: 0,
      collectorCodeSha: EXACT_MAIN,
      market: 'CRYPTO_FUTURES',
      symbol: 'BTCUSDT',
      publicDataSource: 'BITGET_PUBLIC_UTA_V3',
      eventTimestampMs,
      sourceDigest: '1'.repeat(64),
      calibrationSourceOnly: true,
      executionCostEligible: false,
      liquidityImpactCoefficient: null,
      causalMarketImpactClaim: false,
      paperOrderSourceAllowed: false,
    }],
    droppedEvents: [],
  };
}

test('Option B policy, digests, checkpoint, and safety boundary are frozen', () => {
  const policy = PUBLIC_FORWARD_LIQUIDITY_MULTI_LANE_POLICY_V1;
  const verdict = verifyPublicForwardLiquidityMultiLanePolicyV1(policy);
  assert.equal(verdict.valid, true, verdict.blockers.join(','));
  assert.equal(policy.policyVersion, 'public-forward-liquidity-multi-lane-prospective-policy-v1');
  assert.equal(policy.policyDigest, '8aa18555127272d7aa914d0b622b5ce9b463ffb0a9e53d6d93ffe679409a8993');
  assert.deepEqual(policy.laneRegistry.map(({ laneId, scheduleIdentity }) => ({ laneId, scheduleIdentity })), [
    { laneId: 'P2_V3_BTCUSDT_UTC17', scheduleIdentity: '17 * * * *' },
    { laneId: 'P2_V3_BTCUSDT_UTC37', scheduleIdentity: '37 * * * *' },
  ]);
  assert.equal(policy.config.utc27Policy.additionalIndependentCredit, 0);
  assert.equal(policy.config.utc27Policy.thirdLaneAllowed, false);
  assert.equal(policy.config.approvedCheckpoint.rawAcceptedN, 1025);
  assert.equal(policy.config.approvedCheckpoint.effectiveIndependentN, 74);
  assert.equal(policy.config.approvedCheckpoint.authoritativeIndexArtifactId, 10180662199);
  assert.equal(
    policy.config.approvedCheckpoint.authoritativeIndexArtifactDigest,
    '5167e9ebc9d904c0b99941f0d17e00dbb07b7cfafa6aa77c654318f663656aea',
  );
  assert.equal(policy.config.safety.executionAuthority, 'NONE');
  assert.equal(policy.config.safety.liveTradingAllowed, false);
  assert.equal(policy.config.safety.privateTradingApiAllowed, false);
});

test('activation derives only from exact-main terminal 6/6 after one complete hourly lead slot', () => {
  const activation = derivePublicForwardLiquidityMultiLaneActivation(ciEvidence());
  assert.equal(activation.postMergeRequiredCiHeadSha, EXACT_MAIN);
  assert.equal(activation.postMergeRequiredCiCompletedAtMs, Date.parse('2026-09-11T06:05:00.000Z'));
  assert.equal(activation.completeLeadSlotStartMs, Date.parse('2026-09-11T07:00:00.000Z'));
  assert.equal(activation.completeLeadSlotEndMs, Date.parse('2026-09-11T08:00:00.000Z'));
  assert.equal(activation.activationBoundaryMs, Date.parse('2026-09-11T08:17:00.000Z'));
  assert.equal(
    activation.activationBoundaryDigest,
    sha256(canonicalJson(Object.fromEntries(
      Object.entries(activation).filter(([key]) => key !== 'activationBoundaryDigest'),
    ))),
  );
});

test('activation fails closed for moved HEAD, missing Browser UI, or non-terminal CI', () => {
  const moved = ciEvidence({ workflowRun: { head_sha: 'd'.repeat(40) } });
  assert.throws(
    () => derivePublicForwardLiquidityMultiLaneActivation(moved),
    /PHASE2_ACTIVATION_CI_RUN_INVALID/,
  );
  const missingBrowser = ciEvidence();
  missingBrowser.jobs = missingBrowser.jobs.filter(
    (job) => job.name !== 'Playwright desktop and mobile application UI',
  );
  assert.throws(
    () => derivePublicForwardLiquidityMultiLaneActivation(missingBrowser),
    /PHASE2_ACTIVATION_REQUIRED_CI_NOT_SUCCESS/,
  );
  const pending = ciEvidence();
  pending.workflowRun.status = 'in_progress';
  assert.throws(
    () => derivePublicForwardLiquidityMultiLaneActivation(pending),
    /PHASE2_ACTIVATION_CI_RUN_INVALID/,
  );
});

test('lane keys are distinct, global slot key is shared, and UTC27 is never a third lane', () => {
  const activation = derivePublicForwardLiquidityMultiLaneActivation(ciEvidence());
  const slotIndex = activation.activationSlotIndex;
  const before = resolvePublicForwardLiquidityMultiLaneCreditIdentity({
    scheduleExpression: '17 * * * *',
    actualRunStartedAtMs: activation.activationBoundaryMs - 1,
    slotIndex: slotIndex - 1,
    activation,
  });
  assert.deepEqual(before, { active: false, reason: 'PHASE2_PRE_ACTIVATION_OLD_POLICY' });
  const utc17 = resolvePublicForwardLiquidityMultiLaneCreditIdentity({
    scheduleExpression: '17 * * * *',
    actualRunStartedAtMs: activation.activationBoundaryMs,
    slotIndex,
    activation,
  });
  const utc37 = resolvePublicForwardLiquidityMultiLaneCreditIdentity({
    scheduleExpression: '37 * * * *',
    actualRunStartedAtMs: activation.activationBoundaryMs + 20 * 60_000,
    slotIndex,
    activation,
  });
  assert.notEqual(utc17.laneCreditKeyDigest, utc37.laneCreditKeyDigest);
  assert.equal(utc17.globalSlotKeyDigest, utc37.globalSlotKeyDigest);
  assert.equal(utc17.maxCreditPerLanePerSlot, 1);
  assert.equal(utc17.maxTotalCreditPerSlot, 2);
  const utc27 = resolvePublicForwardLiquidityMultiLaneCreditIdentity({
    scheduleExpression: '27 * * * *',
    actualRunStartedAtMs: activation.activationBoundaryMs + 10 * 60_000,
    slotIndex,
    activation,
  });
  assert.equal(utc27.laneId, null);
  assert.equal(utc27.additionalIndependentCredit, 0);
  assert.equal(utc27.thirdLaneAllowed, false);
});

test('a pre-cutover slot delayed past activation remains on immutable old V3 policy', () => {
  const activation = derivePublicForwardLiquidityMultiLaneActivation(ciEvidence());
  const identity = resolvePublicForwardLiquidityMultiLaneCreditIdentity({
    scheduleExpression: '17 * * * *',
    actualRunStartedAtMs: activation.activationBoundaryMs + 30_000,
    slotIndex: activation.activationSlotIndex - 1,
    activation,
  });
  assert.deepEqual(identity, {
    active: false,
    reason: 'PHASE2_PRE_ACTIVATION_OLD_POLICY',
  });
});

test('current-main ancestry binding changes without mutating the activation boundary', () => {
  const activation = derivePublicForwardLiquidityMultiLaneActivation(ciEvidence());
  const descendant = 'd'.repeat(40);
  const binding = buildPublicForwardLiquidityMultiLaneCurrentMainBinding({
    activation,
    currentMainSha: descendant,
    compareStatus: 'ahead',
    mergeBaseSha: activation.postMergeRequiredCiHeadSha,
  });
  assert.equal(binding.activationBoundaryDigest, activation.activationBoundaryDigest);
  assert.equal(binding.activationCiHeadSha, EXACT_MAIN);
  assert.equal(binding.currentMainSha, descendant);
  assert.equal(binding.relationship, 'DESCENDANT_OF_ACTIVATION_CI_HEAD');
  assert.throws(() => buildPublicForwardLiquidityMultiLaneCurrentMainBinding({
    activation,
    currentMainSha: descendant,
    compareStatus: 'diverged',
    mergeBaseSha: activation.postMergeRequiredCiHeadSha,
  }), /PHASE2_CURRENT_MAIN_ANCESTRY_INVALID/);
});

test('scheduled seam binds explicit lane identity and uses a lane-aware prior-credit key', SUCCESSOR_ACTIVE_TEST, async () => {
  const activation = derivePublicForwardLiquidityMultiLaneActivation(ciEvidence());
  const slot = buildSuccessorScheduleReliabilityV3SlotDescriptor(activation.activationSlotIndex);
  const lookups = [];
  const result = await executeSuccessorScheduledCaptureSeamV3({
    eventName: 'schedule',
    scheduleExpression: '17 * * * *',
    scheduledRunCreatedAtMs: slot.nominalScheduledAtMs,
    actualRunStartedAtMs: slot.nominalScheduledAtMs,
    runAttempt: 1,
    runId: '41000000001',
    repository: 'seungjae3908-source/seungjae20260713',
    exactMainSha: EXACT_MAIN,
    contract: SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT,
    multiLaneActivation: activation,
    hasPriorCreditedSlot: async (lookup) => {
      lookups.push(lookup);
      return false;
    },
    getRemoteMainSha: async () => EXACT_MAIN,
    clock: () => slot.nominalScheduledAtMs + 5_000,
    collector: async () => validBatch(slot.nominalScheduledAtMs),
  });
  assert.equal(result.captureReceipt.captureStatus, 'PRESENT');
  assert.equal(result.captureReceipt.prospectiveSlotCredit, 1);
  assert.equal(result.captureReceipt.laneId, 'P2_V3_BTCUSDT_UTC17');
  assert.equal(result.captureReceipt.scheduleIdentity, '17 * * * *');
  assert.equal(result.captureReceipt.multiLanePolicyDigest,
    PUBLIC_FORWARD_LIQUIDITY_MULTI_LANE_POLICY_V1.policyDigest);
  assert.equal(lookups.length, 1);
  assert.equal(lookups[0].laneId, 'P2_V3_BTCUSDT_UTC17');
  assert.equal(lookups[0].laneCreditKeyDigest, result.captureReceipt.laneCreditKeyDigest);
});

test('UTC27 scheduled seam preserves diagnostic evidence but grants zero additional credit', SUCCESSOR_ACTIVE_TEST, async () => {
  const activation = derivePublicForwardLiquidityMultiLaneActivation(ciEvidence());
  const slot = buildSuccessorScheduleReliabilityV3SlotDescriptor(activation.activationSlotIndex);
  const result = await executeSuccessorScheduledCaptureSeamV3({
    eventName: 'schedule',
    scheduleExpression: '27 * * * *',
    scheduledRunCreatedAtMs: slot.nominalScheduledAtMs + 10 * 60_000,
    actualRunStartedAtMs: slot.nominalScheduledAtMs + 10 * 60_000,
    runAttempt: 1,
    runId: '41000000002',
    repository: 'seungjae3908-source/seungjae20260713',
    exactMainSha: EXACT_MAIN,
    contract: SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT,
    multiLaneActivation: activation,
    hasPriorCreditedSlot: async () => false,
    getRemoteMainSha: async () => EXACT_MAIN,
    clock: () => slot.nominalScheduledAtMs + 10 * 60_000 + 5_000,
    collector: async () => validBatch(slot.nominalScheduledAtMs + 10 * 60_000),
  });
  assert.equal(result.batch !== null, true);
  assert.equal(result.captureReceipt.captureStatus, 'PRESENT_ZERO_CREDIT');
  assert.equal(result.captureReceipt.prospectiveSlotCredit, 0);
  assert.equal(result.captureReceipt.laneId, null);
  assert.equal(result.captureReceipt.utc27AdditionalIndependentCredit, 0);
  assert.ok(result.captureReceipt.blockers.includes('PHASE2_UTC27_ZERO_ADDITIONAL_CREDIT'));
});

test('a lane run cannot credit provider evidence whose observation began before cutover', SUCCESSOR_ACTIVE_TEST, async () => {
  const activation = derivePublicForwardLiquidityMultiLaneActivation(ciEvidence());
  const slot = buildSuccessorScheduleReliabilityV3SlotDescriptor(activation.activationSlotIndex);
  const result = await executeSuccessorScheduledCaptureSeamV3({
    eventName: 'schedule',
    scheduleExpression: '17 * * * *',
    scheduledRunCreatedAtMs: slot.nominalScheduledAtMs,
    actualRunStartedAtMs: slot.nominalScheduledAtMs,
    runAttempt: 1,
    runId: '41000000003',
    repository: 'seungjae3908-source/seungjae20260713',
    exactMainSha: EXACT_MAIN,
    contract: SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT,
    multiLaneActivation: activation,
    hasPriorCreditedSlot: async () => false,
    getRemoteMainSha: async () => EXACT_MAIN,
    clock: () => slot.nominalScheduledAtMs + 5_000,
    collector: async () => validBatch(activation.activationBoundaryMs - 1),
  });
  assert.equal(result.captureReceipt.prospectiveSlotCredit, 0);
  assert.equal(result.captureReceipt.captureStatus, 'VALIDATION_FAILURE');
  assert.ok(result.captureReceipt.blockers.some(
    (value) => value.includes('PHASE2_PRE_BOUNDARY_OBSERVATION_FORBIDDEN'),
  ));
});

test('Phase 2 workflow wiring preserves automatic-only safety and separates lane receipts from slots', async () => {
  const workflowRoot = new URL('../../.github/workflows/', import.meta.url);
  const [capture, ingest, independenceWorkflow, captureRunner] = await Promise.all([
    readFile(new URL('public-forward-liquidity-successor-scheduled-capture.yml', workflowRoot), 'utf8'),
    readFile(new URL('public-forward-liquidity-v3-capture-ingest.yml', workflowRoot), 'utf8'),
    readFile(new URL('public-forward-liquidity-v3-independence.yml', workflowRoot), 'utf8'),
    readFile(new URL('../scripts/run-public-forward-liquidity-successor-schedule-seam-v1.mjs', import.meta.url), 'utf8'),
  ]);
  for (const workflow of [capture, ingest, independenceWorkflow]) {
    assert.ok(workflow.includes('public-forward-liquidity-multi-lane-policy-v1.mjs'));
    assert.ok(!workflow.includes('contents: write'));
    assert.ok(!workflow.includes('actions: write'));
  }
  assert.ok(!/^\s{2}workflow_dispatch:\s*$/mu.test(capture));
  assert.ok(capture.includes("PHASE2_UTC27_DIAGNOSTIC"));
  assert.ok(capture.includes("test \"$PROSPECTIVE_SLOT_CREDIT\" = '0'"));
  assert.ok(ingest.includes('creditedReceiptN: entries.length'));
  assert.ok(ingest.includes('(?:-diagnostic-[0-9]+-[0-9]+)?$/u'));
  assert.ok(ingest.includes('genuineScheduledSlotN: new Set(entries.map((entry) => entry.slotIndex)).size'));
  assert.ok(ingest.includes('genuineScheduledLaneReceiptN: Number(process.env.CREDITED_RECEIPT_N)'));
  assert.ok(independenceWorkflow.includes('crossLanePairAssessments: result.audit.crossLanePairAssessments'));
  assert.ok(independenceWorkflow.includes('preCutoverIndexFreeze: index.preCutoverIndexFreeze'));
  assert.ok(captureRunner.includes('status=completed'));
  assert.ok(!captureRunner.includes('status=success'));
  assert.ok(captureRunner.includes('PHASE2_FIRST_POLICY_CI_UNVERIFIED'));
});
