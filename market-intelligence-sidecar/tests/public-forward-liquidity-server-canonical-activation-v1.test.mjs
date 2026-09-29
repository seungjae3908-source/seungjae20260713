import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalJson, sha256 } from '../src/public-forward-liquidity-calibration.mjs';
import {
  prepareProtectedServerCanonicalActivation,
  verifyProtectedServerCanonicalActivationRecord,
} from '../src/public-forward-liquidity-server-canonical-activation-v1.mjs';
import {
  SERVER_EVIDENCE_SHADOW_MODE,
  SERVER_EVIDENCE_SHADOW_SCHEMA,
  SERVER_EVIDENCE_STATE_CONTRACT,
} from '../src/public-forward-liquidity-server-shadow-worker-v1.mjs';
import {
  buildSuccessorScheduleReliabilityV3SlotDescriptor,
  materializeSuccessorScheduleReliabilityV3Contract,
} from '../src/public-forward-liquidity-successor-schedule-reliability-v3.mjs';

const ACTIVATION_BINDING = Object.freeze({
  schemaVersion: 'public-forward-liquidity-successor-schedule-reliability-activation-binding-v3',
  authorityIssue: 23,
  authorityCommentId: 5805902930,
  hubFreezeAuthorityCommentId: 5804802177,
  hubFreezeTimestampCommentId: 5804808369,
  frozenCohortFreezeBlobSha: '65ef02d9ef5611c767755e71b40b840737b0658a',
  frozenCohortFreezeMs: 1790207015000,
  frozenCohortEffectiveStartMs: 1790263020000,
  activationBoundaryMs: 1790212089000,
  cutoverStartMs: 1790263020000,
  authorizedCurrentMainSha: '24d9c8b4bbca54c1b3bce4ad28a8c1286beaff92',
  numericFreezeSha256: '10b157de8e1902865f9b386a02439bb56d67b5c2fcd20dd48870d851bdb97ff1',
  minActivationLeadSlots: 1,
  priorV2CreditImported: 0,
  priorV2MissedSlotRecovery: 0,
  priorV2DiagnosticArtifactCredit: 0,
  replayCredit: 0,
  backfillCredit: 0,
  syntheticCredit: 0,
});
const contract = materializeSuccessorScheduleReliabilityV3Contract(ACTIVATION_BINDING);

const MAIN = 'a'.repeat(40);
const OLD_MAIN = 'b'.repeat(40);
const RECEIPT_ID = 12345;
const AUTHORITY_ID = 23456;
const bindingDigest = sha256(canonicalJson(ACTIVATION_BINDING));

function shadowReceipt({ authorizedAtMs, slotIndex = 100 } = {}) {
  const slot = buildSuccessorScheduleReliabilityV3SlotDescriptor(slotIndex, contract);
  const body = {
    schemaVersion: SERVER_EVIDENCE_SHADOW_SCHEMA,
    stateContract: SERVER_EVIDENCE_STATE_CONTRACT,
    mode: SERVER_EVIDENCE_SHADOW_MODE,
    captureStatus: 'PRESENT_SHADOW',
    shadowOnly: true,
    serverCanonical: false,
    codeSha: MAIN,
    activationReceiptCommentId: RECEIPT_ID,
    activationReceiptMainSha: MAIN,
    activationBindingDigest: bindingDigest,
    policyDigest: contract.policyDigest,
    cohortDigest: contract.cohortDigest,
    slotIndex,
    split: slot.split,
    nominalScheduledAtMs: slot.nominalScheduledAtMs,
    allowedStartThroughMs: slot.allowedStartThroughMs,
    triggerMinuteUtc: 17,
    triggerAttemptIndex: 0,
    triggerAtMs: slot.nominalScheduledAtMs + 10_000,
    serverStartedAtMs: Math.max(slot.nominalScheduledAtMs + 10_000, authorizedAtMs + 1),
    triggerLagMs: 10_000,
    ntpSynchronized: true,
    sampleClass: 'CALIBRATION_RESEARCH_SAMPLE',
    rawBatchDigest: 'c'.repeat(64),
    blockers: [],
    prospectiveSlotCredit: 0,
    canonicalEconomicCredit: 0,
    economicSampleCredit: 0,
    profitabilityCredit: 0,
    replayCredit: 0,
    backfillCredit: 0,
    manualCredit: 0,
    syntheticCredit: 0,
    hindsightCredit: 0,
    fullCostReady: false,
    evidenceComplete: 0,
    profitabilityProven: false,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: 'NONE',
  };
  return Object.freeze({ ...body, receiptDigest: sha256(canonicalJson(body)) });
}

function validInputs() {
  const slot99 = buildSuccessorScheduleReliabilityV3SlotDescriptor(99, contract);
  const authorizedAtMs = slot99.nominalScheduledAtMs + 20 * 60_000;
  const shadow = shadowReceipt({ authorizedAtMs, slotIndex: 100 });
  const runtimeActivationSlot = buildSuccessorScheduleReliabilityV3SlotDescriptor(100, contract);
  const runtimeActivatedAtMs = Math.max(
    shadow.serverStartedAtMs + 1,
    runtimeActivationSlot.nominalScheduledAtMs + 20 * 60_000,
  );
  return {
    currentMainSha: MAIN,
    activationBindingDigest: bindingDigest,
    latestActivationReceipt: {
      issueNumber: 23,
      action: 'AUTHORIZE',
      targetMainSha: MAIN,
      activationBindingDigest: bindingDigest,
      commentId: RECEIPT_ID,
      authorAssociation: 'OWNER',
      actorLogin: 'seungjae3908-source',
      body: `/authorize-public-only-partial-fill-v3-schedule-activation ${MAIN} ${bindingDigest}`,
      latestForTargetBinding: true,
    },
    requiredCi: {
      runId: 987654,
      headSha: MAIN,
      workflowId: 325169344,
      workflowName: 'Application CI',
      workflowPath: '.github/workflows/futures-public-network-smoke.yml',
      event: 'push',
      headBranch: 'main',
      runAttempt: 1,
      status: 'completed',
      conclusion: 'success',
      contexts: {
        'application-ci/verified': 'success',
        'browser-ui/verified': 'success',
        'database-rls/verified': 'success',
        'security-integration/verified': 'success',
        'ai-privacy/verified': 'success',
        'futures-public-network-smoke/verified': 'success',
      },
    },
    githubDelivery: {
      targetWorkflowId: 347888347,
      targetWorkflowState: 'active',
      targetLatestScheduleWorkflowId: 347888347,
      targetLatestScheduleEvent: 'schedule',
      targetLatestScheduleHeadSha: OLD_MAIN,
      targetLatestScheduleCreatedAtMs: authorizedAtMs - 4_000_000,
      targetCurrentMainScheduleRunCount: 0,
      repositoryLatestScheduleCreatedAtMs: authorizedAtMs - 60_000,
      repositoryLatestScheduleWorkflowId: 123456789,
      repositoryLatestScheduleEvent: 'schedule',
      repositoryLatestScheduleHeadSha: MAIN,
      observedAtMs: authorizedAtMs + 1000,
    },
    serverRuntime: {
      deployedSha: MAIN,
      timerEnabled: true,
      timerActive: true,
      persistent: false,
      timerUnit: 'public-forward-liquidity-server-shadow-worker-v1.timer',
      serviceUnit: 'public-forward-liquidity-server-shadow-worker-v1.service',
      timerTimezone: 'UTC',
      onCalendarUtc: ['*-*-* *:17:00 UTC', '*-*-* *:27:00 UTC', '*-*-* *:37:00 UTC'],
      accuracySec: 1,
      randomizedDelaySec: 0,
      ntpSynchronized: true,
      shadowOnly: true,
      serverCanonical: false,
      receiptPersistence: 'CREATE_ONLY_WX',
      productionAppMutationPerformed: false,
      manualCapturePerformed: false,
      executionAuthority: 'NONE',
      triggerMinutesUtc: [17, 27, 37],
    },
    shadowReceipt: shadow,
    canonicalCreditLedger: {
      lookupComplete: true,
      sourcePrecedence: ['GITHUB_V3_SCHEDULE', 'SERVER_NATURAL_TIMER'],
      creditKey: {
        policyDigest: shadow.policyDigest,
        cohortDigest: shadow.cohortDigest,
        slotIndex: shadow.slotIndex,
      },
      matchingCanonicalCredits: [],
      maximumCanonicalEconomicCredit: 1,
    },
    activationReceiptCommentId: RECEIPT_ID,
    authorityCommentId: AUTHORITY_ID,
    authorizedAtMs,
    runtimeActivatedAtMs,
    baselineEvidence: {
      canonicalTrainReceiptN: 4,
      independentN: 4,
      validationN: 0,
      oosN: 0,
      retroactiveRecomputePerformed: false,
      historicalShadowPromotionPerformed: false,
    },
    historicalShadowLedger: {
      lookupComplete: true,
      canonicalCreditN: 0,
      retroactivePromotionPerformed: false,
    },
    contract,
  };
}

test('protected activation stays future-only and zero-credit', () => {
  const record = prepareProtectedServerCanonicalActivation(validInputs());
  assert.equal(record.cutoverAuthority.firstEligibleSlotIndex, 100);
  assert.equal(record.firstEligibleSlotIndex, 101);
  assert.equal(record.cutoverReadiness.readyForFutureCanonicalCutover, true);
  assert.equal(record.runtimeActivation.activationApplied, true);
  assert.equal(record.runtimeActivation.authorizedAtMs, record.runtimeActivatedAtMs);
  assert.equal(record.runtimeActivation.firstEligibleSlotIndex, 101);
  assert.equal(record.canonicalEconomicCredit, 0);
  assert.equal(record.canonicalIngestPerformed, false);
  assert.equal(record.independencePerformed, false);
  assert.equal(record.executionAuthority, 'NONE');
  assert.deepEqual(verifyProtectedServerCanonicalActivationRecord(record, contract), {
    valid: true,
    blockers: [],
  });
});


test('runtime activation in the shadow slot forces the following whole slot', () => {
  const input = validInputs();
  const record = prepareProtectedServerCanonicalActivation(input);
  const runtimeSlot = Math.floor(
    (record.runtimeActivatedAtMs - contract.policyCore.cohort.startInclusiveMs)
      / contract.policyCore.cohort.slotCadenceMs,
  );
  assert.equal(runtimeSlot, 100);
  assert.equal(record.firstEligibleSlotIndex, runtimeSlot + 1);
  assert.ok(record.firstEligibleSlotIndex > record.cutoverAuthority.firstEligibleSlotIndex);
});

test('readiness rejects a shadow receipt from before the +1 future slot', () => {
  const input = validInputs();
  input.shadowReceipt = shadowReceipt({ authorizedAtMs: input.authorizedAtMs, slotIndex: 99 });
  input.canonicalCreditLedger = {
    ...input.canonicalCreditLedger,
    creditKey: {
      policyDigest: input.shadowReceipt.policyDigest,
      cohortDigest: input.shadowReceipt.cohortDigest,
      slotIndex: 99,
    },
  };
  assert.throws(
    () => prepareProtectedServerCanonicalActivation(input),
    /SERVER_CANONICAL_CUTOVER_READINESS_BLOCKED/u,
  );
});

test('activation record digest is fail-closed', () => {
  const record = prepareProtectedServerCanonicalActivation(validInputs());
  const tampered = { ...record, canonicalEconomicCredit: 1 };
  const verdict = verifyProtectedServerCanonicalActivationRecord(tampered, contract);
  assert.equal(verdict.valid, false);
  assert.ok(verdict.blockers.includes('SERVER_CANONICAL_ACTIVATION_RECORD_DIGEST_INVALID'));
  assert.ok(verdict.blockers.includes('SERVER_CANONICAL_ACTIVATION_RECORD_SAFETY_INVALID'));
});
