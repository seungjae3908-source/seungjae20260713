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
  buildServerCanonicalCutoverReadiness,
} from '../src/public-forward-liquidity-server-canonical-cutover-readiness-v1.mjs';
import {
  SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT,
  buildSuccessorScheduleReliabilityV3SlotDescriptor,
} from '../src/public-forward-liquidity-successor-schedule-reliability-v3.mjs';

const MAIN = 'a'.repeat(40);
const BINDING = 'b'.repeat(64);
const RAW = 'c'.repeat(64);
const RECEIPT_COMMENT_ID = 5881193542;
const AUTHORITY_COMMENT_ID = 6000000001;
const AUTHORIZATION_SLOT_INDEX = 105;
const FIRST_ELIGIBLE_SLOT_INDEX = AUTHORIZATION_SLOT_INDEX + 1;
const AUTHORIZATION_SLOT = buildSuccessorScheduleReliabilityV3SlotDescriptor(
  AUTHORIZATION_SLOT_INDEX,
);
const FUTURE_SLOT = buildSuccessorScheduleReliabilityV3SlotDescriptor(
  FIRST_ELIGIBLE_SLOT_INDEX,
);
const AUTHORIZED_AT_MS = AUTHORIZATION_SLOT.nominalScheduledAtMs + 5 * 60 * 1000;

function requiredCi(overrides = {}) {
  return {
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
    action: 'AUTHORIZE',
    commentId: RECEIPT_COMMENT_ID,
    targetMainSha: MAIN,
    activationBindingDigest: BINDING,
    ...overrides,
  };
}

function githubDelivery(overrides = {}) {
  return {
    targetWorkflowId: 347888347,
    targetWorkflowState: 'active',
    targetLatestScheduleCreatedAtMs: AUTHORIZED_AT_MS - 2 * 60 * 60 * 1000,
    repositoryLatestScheduleCreatedAtMs: AUTHORIZED_AT_MS - 5 * 60 * 1000,
    observedAtMs: AUTHORIZED_AT_MS,
    ...overrides,
  };
}

function serverRuntime(overrides = {}) {
  return {
    deployedSha: MAIN,
    timerEnabled: true,
    timerActive: true,
    persistent: false,
    ntpSynchronized: true,
    shadowOnly: true,
    serverCanonical: false,
    triggerMinutesUtc: [17, 27, 37],
    productionAppMutationPerformed: false,
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
    policyDigest: SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.policyDigest,
    cohortDigest: SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT.cohortDigest,
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

function readiness(overrides = {}) {
  return buildServerCanonicalCutoverReadiness({
    currentMainSha: MAIN,
    activationBindingDigest: BINDING,
    latestActivationReceipt: activationReceipt(),
    requiredCi: requiredCi(),
    githubDelivery: githubDelivery(),
    serverRuntime: serverRuntime(),
    cutoverAuthority: cutoverAuthority(),
    shadowReceipt: receiptWithDigest(),
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
  assert.deepEqual(result.blockers, []);
  assert.equal(result.safety.executionAuthority, 'NONE');
  assert.equal(result.safety.replayCredit, 0);
  assert.equal(result.safety.backfillCredit, 0);
  assert.equal(result.safety.currentEconomicCredit, 0);
});

test('pre-authority shadow evidence can never be promoted retroactively', () => {
  const oldSlot = buildSuccessorScheduleReliabilityV3SlotDescriptor(
    AUTHORIZATION_SLOT_INDEX,
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

test('current-main CI and OWNER receipt mismatches fail closed', () => {
  const result = readiness({
    requiredCi: requiredCi({ headSha: 'd'.repeat(40) }),
    latestActivationReceipt: activationReceipt({ targetMainSha: 'e'.repeat(40) }),
  });

  assert.equal(result.readyForFutureCanonicalCutover, false);
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
