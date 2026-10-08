import test from 'node:test';
import assert from 'node:assert/strict';

import { canonicalJson, sha256 } from '../src/public-forward-liquidity-calibration.mjs';
import {
  SERVER_EVIDENCE_SHADOW_MODE,
  SERVER_EVIDENCE_SHADOW_SCHEMA,
  SERVER_EVIDENCE_STATE_CONTRACT,
} from '../src/public-forward-liquidity-server-shadow-worker-v1.mjs';
import {
  SERVER_CANONICAL_CUTOVER_AUTHORITY_SCHEMA,
  SERVER_CANONICAL_SOURCE_PRECEDENCE,
  buildServerCanonicalCutoverReadiness,
} from '../src/public-forward-liquidity-server-canonical-cutover-readiness-v1.mjs';
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
const ACTIVE_CONTRACT = materializeSuccessorScheduleReliabilityV3Contract(ACTIVATION_BINDING);

const MAIN = 'a'.repeat(40);
const BINDING = sha256(canonicalJson(ACTIVATION_BINDING));
const COMPONENT = 'd'.repeat(64);
const RAW = 'c'.repeat(64);
const RECEIPT_COMMENT_ID = 5881193542;
const AUTHORITY_COMMENT_ID = 6000000001;
const AUTHORIZATION_SLOT_INDEX = 105;
const FIRST_ELIGIBLE_SLOT_INDEX = AUTHORIZATION_SLOT_INDEX + 1;
const AUTHORIZATION_SLOT = buildSuccessorScheduleReliabilityV3SlotDescriptor(
  AUTHORIZATION_SLOT_INDEX,
  ACTIVE_CONTRACT,
);
const FUTURE_SLOT = buildSuccessorScheduleReliabilityV3SlotDescriptor(
  FIRST_ELIGIBLE_SLOT_INDEX,
  ACTIVE_CONTRACT,
);
const AUTHORIZED_AT_MS = AUTHORIZATION_SLOT.nominalScheduledAtMs + 5 * 60 * 1000;

function requiredCi(overrides = {}) {
  return {
    runId: 36501705672,
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
    ...overrides,
  };
}

function activationReceipt(overrides = {}) {
  return {
    issueNumber: 1555,
    issueTitle: 'Staging Readiness Control — Rollover 2026-10-02',
    releaseControlOpen: true,
    action: 'AUTHORIZE',
    currentMainSha: MAIN,
    componentDigest: COMPONENT,
    componentEquivalentCurrentMain: true,
    commentId: RECEIPT_COMMENT_ID,
    targetMainSha: MAIN,
    activationBindingDigest: BINDING,
    authorAssociation: 'OWNER',
    actorLogin: 'repository-owner',
    body: `/authorize-public-only-partial-fill-v3-schedule-activation ${MAIN} ${BINDING}`,
    latestForTargetBinding: true,
    ...overrides,
  };
}

function githubDelivery(overrides = {}) {
  return {
    targetWorkflowId: 347888347,
    targetWorkflowState: 'active',
    targetLatestScheduleWorkflowId: 347888347,
    targetLatestScheduleEvent: 'schedule',
    targetLatestScheduleHeadSha: 'f'.repeat(40),
    targetCurrentMainScheduleRunCount: 0,
    targetLatestScheduleCreatedAtMs: AUTHORIZED_AT_MS - 2 * 60 * 60 * 1000,
    repositoryLatestScheduleWorkflowId: 343418331,
    repositoryLatestScheduleEvent: 'schedule',
    repositoryLatestScheduleHeadSha: MAIN,
    repositoryLatestScheduleCreatedAtMs: AUTHORIZED_AT_MS - 5 * 60 * 1000,
    observedAtMs: AUTHORIZED_AT_MS,
    ...overrides,
  };
}

function serverRuntime(overrides = {}) {
  return {
    deployedSha: MAIN,
    evidenceSha: MAIN,
    currentMainSha: MAIN,
    componentDigest: COMPONENT,
    componentEquivalentCurrentMain: true,
    timerEnabled: true,
    timerActive: true,
    persistent: false,
    timerUnit: 'public-forward-liquidity-server-shadow-worker-v1.timer',
    serviceUnit: 'public-forward-liquidity-server-shadow-worker-v1.service',
    timerTimezone: 'UTC',
    onCalendarUtc: [
      '*-*-* *:17:00 UTC',
      '*-*-* *:27:00 UTC',
      '*-*-* *:37:00 UTC',
    ],
    accuracySec: 1,
    randomizedDelaySec: 0,
    ntpSynchronized: true,
    shadowOnly: true,
    serverCanonical: false,
    receiptPersistence: 'CREATE_ONLY_WX',
    triggerMinutesUtc: [17, 27, 37],
    productionAppMutationPerformed: false,
    manualCapturePerformed: false,
    executionAuthority: 'NONE',
    ...overrides,
  };
}

function cutoverAuthority(overrides = {}) {
  return {
    schemaVersion: SERVER_CANONICAL_CUTOVER_AUTHORITY_SCHEMA,
    authorityCommentId: AUTHORITY_COMMENT_ID,
    targetMainSha: MAIN,
    activationBindingDigest: BINDING,
    activationReceiptCommentId: RECEIPT_COMMENT_ID,
    authorizedAtMs: AUTHORIZED_AT_MS,
    firstEligibleSlotIndex: FIRST_ELIGIBLE_SLOT_INDEX,
    replayCredit: 0,
    backfillCredit: 0,
    manualCredit: 0,
    syntheticCredit: 0,
    hindsightCredit: 0,
    executionAuthority: 'NONE',
    ...overrides,
  };
}

function receiptWithDigest(overrides = {}) {
  const body = {
    schemaVersion: SERVER_EVIDENCE_SHADOW_SCHEMA,
    stateContract: SERVER_EVIDENCE_STATE_CONTRACT,
    mode: SERVER_EVIDENCE_SHADOW_MODE,
    captureStatus: 'PRESENT_SHADOW',
    shadowOnly: true,
    serverCanonical: false,
    codeSha: MAIN,
    activationReceiptCommentId: RECEIPT_COMMENT_ID,
    activationReceiptMainSha: MAIN,
    activationBindingDigest: BINDING,
    policyDigest: ACTIVE_CONTRACT.policyDigest,
    cohortDigest: ACTIVE_CONTRACT.cohortDigest,
    slotIndex: FUTURE_SLOT.slotIndex,
    split: FUTURE_SLOT.split,
    nominalScheduledAtMs: FUTURE_SLOT.nominalScheduledAtMs,
    allowedStartThroughMs: FUTURE_SLOT.allowedStartThroughMs,
    triggerMinuteUtc: 17,
    triggerAttemptIndex: 1,
    triggerAtMs: FUTURE_SLOT.nominalScheduledAtMs,
    serverStartedAtMs: FUTURE_SLOT.nominalScheduledAtMs + 10_000,
    triggerLagMs: 10_000,
    ntpSynchronized: true,
    sampleClass: 'CALIBRATION_RESEARCH_SAMPLE',
    rawBatchDigest: RAW,
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
    ...overrides,
  };
  return {
    ...body,
    receiptDigest: sha256(canonicalJson(body)),
  };
}

function canonicalCreditLedger(receipt = receiptWithDigest(), overrides = {}) {
  return {
    lookupComplete: true,
    creditKey: {
      policyDigest: receipt.policyDigest,
      cohortDigest: receipt.cohortDigest,
      slotIndex: receipt.slotIndex,
    },
    sourcePrecedence: [...SERVER_CANONICAL_SOURCE_PRECEDENCE],
    matchingCanonicalCredits: [],
    maximumCanonicalEconomicCredit: 1,
    ...overrides,
  };
}

function readiness(overrides = {}) {
  const shadowReceipt = overrides.shadowReceipt ?? receiptWithDigest();
  return buildServerCanonicalCutoverReadiness({
    currentMainSha: MAIN,
    activationBindingDigest: BINDING,
    latestActivationReceipt: activationReceipt(),
    requiredCi: requiredCi(),
    githubDelivery: githubDelivery(),
    serverRuntime: serverRuntime(),
    cutoverAuthority: cutoverAuthority(),
    shadowReceipt,
    canonicalCreditLedger: canonicalCreditLedger(shadowReceipt),
    contract: ACTIVE_CONTRACT,
    ...overrides,
  });
}

test('future natural server receipt can become cutover-ready but receives zero credit from readiness', () => {
  const result = readiness();

  assert.equal(result.status, 'READY_FOR_SEPARATE_FUTURE_CANONICAL_ACTIVATION');
  assert.equal(result.readyForFutureCanonicalCutover, true);
  assert.equal(result.activationApplied, false);
  assert.equal(result.currentShadowReceiptCanonical, false);
  assert.equal(result.currentShadowReceiptEconomicCredit, 0);
  assert.equal(result.futureCanonicalCreditPermittedByThisReadinessCheck, false);
  assert.equal(result.requiresSeparateProtectedRuntimeActivation, true);
  assert.equal(result.firstEligibleSlotIndex, FIRST_ELIGIBLE_SLOT_INDEX);
  assert.deepEqual(result.sourcePrecedence, [
    'GITHUB_V3_SCHEDULE',
    'SERVER_NATURAL_TIMER',
  ]);
  assert.equal(result.maximumCanonicalEconomicCreditPerPolicyCohortSlot, 1);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.safety.executionAuthority, 'NONE');
  assert.equal(result.safety.replayCredit, 0);
  assert.equal(result.safety.backfillCredit, 0);
  assert.equal(result.safety.currentEconomicCredit, 0);
});

test('component-equivalent ancestor Shadow evidence survives an unrelated main move', () => {
  const evidenceSha = 'b'.repeat(40);
  const shadow = receiptWithDigest({
    codeSha: evidenceSha,
    activationReceiptMainSha: evidenceSha,
  });
  const result = readiness({
    latestActivationReceipt: activationReceipt({
      targetMainSha: evidenceSha,
      currentMainSha: MAIN,
      componentDigest: COMPONENT,
      componentEquivalentCurrentMain: true,
      body: `/authorize-public-only-partial-fill-v3-schedule-activation ${evidenceSha} ${BINDING}`,
    }),
    serverRuntime: serverRuntime({
      deployedSha: evidenceSha,
      evidenceSha,
      currentMainSha: MAIN,
      componentDigest: COMPONENT,
      componentEquivalentCurrentMain: true,
    }),
    shadowReceipt: shadow,
    canonicalCreditLedger: canonicalCreditLedger(shadow),
  });

  assert.equal(result.status, 'READY_FOR_SEPARATE_FUTURE_CANONICAL_ACTIVATION');
  assert.equal(result.evidenceSha, evidenceSha);
  assert.equal(result.currentMainSha, MAIN);
  assert.equal(result.componentDigest, COMPONENT);
  assert.equal(result.componentEquivalentCurrentMain, true);
  assert.deepEqual(result.blockers, []);
});

test('missing component equivalence still fails closed', () => {
  const result = readiness({
    latestActivationReceipt: activationReceipt({
      componentEquivalentCurrentMain: false,
    }),
  });
  assert.equal(result.readyForFutureCanonicalCutover, false);
  assert.ok(result.blockers.includes('SERVER_CANONICAL_CURRENT_MAIN_OWNER_RECEIPT_INVALID'));
});

test('pre-authority shadow evidence can never be promoted retroactively', () => {
  const oldSlot = buildSuccessorScheduleReliabilityV3SlotDescriptor(
    AUTHORIZATION_SLOT_INDEX,
    ACTIVE_CONTRACT,
  );
  const result = readiness({
    shadowReceipt: receiptWithDigest({
      slotIndex: oldSlot.slotIndex,
      split: oldSlot.split,
      nominalScheduledAtMs: oldSlot.nominalScheduledAtMs,
      allowedStartThroughMs: oldSlot.allowedStartThroughMs,
      triggerAtMs: oldSlot.nominalScheduledAtMs,
      serverStartedAtMs: AUTHORIZED_AT_MS - 1_000,
    }),
  });

  assert.equal(result.readyForFutureCanonicalCutover, false);
  assert.ok(result.blockers.includes('SERVER_CANONICAL_RETROACTIVE_SHADOW_RECEIPT_FORBIDDEN'));
  assert.ok(result.blockers.includes('SERVER_CANONICAL_PRE_CUTOVER_SLOT_FORBIDDEN'));
  assert.equal(result.currentShadowReceiptEconomicCredit, 0);
});

test('cutover authority must lead by at least one whole future slot', () => {
  const result = readiness({
    cutoverAuthority: cutoverAuthority({
      firstEligibleSlotIndex: AUTHORIZATION_SLOT_INDEX,
    }),
  });

  assert.equal(result.readyForFutureCanonicalCutover, false);
  assert.ok(result.blockers.includes('SERVER_CANONICAL_CUTOVER_FUTURE_SLOT_LEAD_REQUIRED'));
});

test('GitHub target outage must be mature while other repository schedules remain observable', () => {
  const result = readiness({
    githubDelivery: githubDelivery({
      targetLatestScheduleCreatedAtMs: AUTHORIZED_AT_MS - 10 * 60 * 1000,
    }),
  });

  assert.equal(result.readyForFutureCanonicalCutover, false);
  assert.ok(result.blockers.includes('SERVER_CANONICAL_GITHUB_TARGET_OUTAGE_NOT_MATURED'));
});

test('current-main GitHub schedule absence and other-schedule current-main identity must be proven', () => {
  const result = readiness({
    githubDelivery: githubDelivery({
      targetCurrentMainScheduleRunCount: 1,
      repositoryLatestScheduleHeadSha: 'e'.repeat(40),
    }),
  });

  assert.equal(result.readyForFutureCanonicalCutover, false);
  assert.ok(result.blockers.includes(
    'SERVER_CANONICAL_CURRENT_MAIN_GITHUB_SCHEDULE_ABSENCE_UNPROVEN',
  ));
  assert.ok(result.blockers.includes(
    'SERVER_CANONICAL_REPOSITORY_SCHEDULE_HEALTH_NOT_OBSERVED',
  ));
});

test('current-main CI and OWNER receipt mismatches fail closed', () => {
  const result = readiness({
    requiredCi: requiredCi({ headSha: 'd'.repeat(40) }),
    latestActivationReceipt: activationReceipt({ targetMainSha: 'e'.repeat(40) }),
  });

  assert.equal(result.readyForFutureCanonicalCutover, false);
  assert.ok(result.blockers.includes('SERVER_CANONICAL_REQUIRED_CI_PROVENANCE_INVALID'));
  assert.ok(result.blockers.includes('SERVER_CANONICAL_CURRENT_MAIN_OWNER_RECEIPT_INVALID'));
});

test('OWNER receipt body and exact Application CI run provenance fail closed when incomplete', () => {
  const result = readiness({
    requiredCi: requiredCi({ runId: null }),
    latestActivationReceipt: activationReceipt({
      body: '/authorize-public-only-partial-fill-v3-schedule-activation wrong',
      latestForTargetBinding: false,
    }),
  });

  assert.ok(result.blockers.includes('SERVER_CANONICAL_REQUIRED_CI_PROVENANCE_INVALID'));
  assert.ok(result.blockers.includes('SERVER_CANONICAL_CURRENT_MAIN_OWNER_RECEIPT_INVALID'));
});

test('shadow receipts that already claim canonical or economic credit are rejected', () => {
  const result = readiness({
    shadowReceipt: receiptWithDigest({
      serverCanonical: true,
      prospectiveSlotCredit: 1,
      canonicalEconomicCredit: 1,
    }),
  });

  assert.equal(result.readyForFutureCanonicalCutover, false);
  assert.ok(result.blockers.includes('SERVER_CANONICAL_SHADOW_RECEIPT_INVALID'));
  assert.equal(result.currentShadowReceiptEconomicCredit, 0);
});

test('unsafe server runtime state fails closed before any cutover', () => {
  const result = readiness({
    serverRuntime: serverRuntime({
      persistent: true,
      ntpSynchronized: false,
      executionAuthority: 'LIVE',
    }),
  });

  assert.equal(result.readyForFutureCanonicalCutover, false);
  assert.ok(result.blockers.includes('SERVER_CANONICAL_SHADOW_RUNTIME_NOT_READY'));
  assert.equal(result.activationApplied, false);
});

test('timer calendar, create-only receipt persistence, and prior-credit lookup are mandatory', () => {
  const shadowReceipt = receiptWithDigest();
  const result = readiness({
    shadowReceipt,
    serverRuntime: serverRuntime({
      onCalendarUtc: ['*-*-* *:17:00 UTC'],
      receiptPersistence: 'OVERWRITE',
    }),
    canonicalCreditLedger: canonicalCreditLedger(shadowReceipt, {
      matchingCanonicalCredits: [{ source: 'GITHUB_V3_SCHEDULE' }],
    }),
  });

  assert.ok(result.blockers.includes('SERVER_CANONICAL_SHADOW_RUNTIME_NOT_READY'));
  assert.ok(result.blockers.includes('SERVER_CANONICAL_PRIOR_CREDIT_DEDUPE_UNPROVEN'));
});
