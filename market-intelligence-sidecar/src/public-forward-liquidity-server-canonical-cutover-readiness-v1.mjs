import { canonicalJson, sha256 } from './public-forward-liquidity-calibration.mjs';
import {
  SERVER_EVIDENCE_SHADOW_SCHEMA,
} from './public-forward-liquidity-server-shadow-worker-v1.mjs';
import {
  SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT,
  buildSuccessorScheduleReliabilityV3SlotDescriptor,
  verifySuccessorScheduleReliabilityV3Contract,
} from './public-forward-liquidity-successor-schedule-reliability-v3.mjs';

export const SERVER_CANONICAL_CUTOVER_READINESS_SCHEMA =
  'public-forward-liquidity-server-canonical-cutover-readiness-v1';
export const SERVER_CANONICAL_CUTOVER_AUTHORITY_SCHEMA =
  'public-forward-liquidity-server-canonical-cutover-authority-v1';
export const SERVER_CANONICAL_GITHUB_OUTAGE_MATURITY_MS = 45 * 60 * 1000;

const REQUIRED_CI_CONTEXTS = Object.freeze([
  'application-ci/verified',
  'browser-ui/verified',
  'database-rls/verified',
  'security-integration/verified',
  'ai-privacy/verified',
  'futures-public-network-smoke/verified',
]);
const SERVER_TRIGGER_MINUTES = Object.freeze([17, 27, 37]);

function add(blockers, code) {
  if (!blockers.includes(code)) blockers.push(code);
}

function exactSha(value) {
  return typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
}

function exactDigest(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function sameArray(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function shadowReceiptBody(receipt) {
  const { receiptDigest: _receiptDigest, ...body } = receipt ?? {};
  return body;
}

function authorizationCurrentSlotIndex(authorizedAtMs, contract) {
  const cohort = contract.policyCore.cohort;
  if (!Number.isSafeInteger(authorizedAtMs)
    || authorizedAtMs < cohort.startInclusiveMs
    || authorizedAtMs >= cohort.endExclusiveMs) {
    return null;
  }
  return Math.floor(
    (authorizedAtMs - cohort.startInclusiveMs) / cohort.slotCadenceMs,
  );
}

export function buildServerCanonicalCutoverReadiness({
  currentMainSha,
  activationBindingDigest,
  latestActivationReceipt,
  requiredCi,
  githubDelivery,
  serverRuntime,
  cutoverAuthority,
  shadowReceipt,
  contract = SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT,
} = {}) {
  const blockers = [];
  const contractVerdict = verifySuccessorScheduleReliabilityV3Contract(contract);

  if (!contractVerdict.valid || contract.activationBound !== true) {
    add(blockers, 'SERVER_CANONICAL_V3_CONTRACT_NOT_ACTIVE');
  }

  if (!exactSha(currentMainSha)) {
    add(blockers, 'SERVER_CANONICAL_CURRENT_MAIN_SHA_INVALID');
  }
  if (!exactDigest(activationBindingDigest)) {
    add(blockers, 'SERVER_CANONICAL_BINDING_DIGEST_INVALID');
  }

  if (latestActivationReceipt?.action !== 'AUTHORIZE'
    || latestActivationReceipt?.targetMainSha !== currentMainSha
    || latestActivationReceipt?.activationBindingDigest !== activationBindingDigest
    || !positiveInteger(latestActivationReceipt?.commentId)) {
    add(blockers, 'SERVER_CANONICAL_CURRENT_MAIN_OWNER_RECEIPT_INVALID');
  }

  const contexts = requiredCi?.contexts ?? {};
  const requiredContextsReady = REQUIRED_CI_CONTEXTS.every(
    (name) => contexts?.[name] === 'success',
  );
  if (requiredCi?.headSha !== currentMainSha
    || requiredCi?.workflowId !== 325169344
    || requiredCi?.workflowName !== 'Application CI'
    || requiredCi?.workflowPath !== '.github/workflows/futures-public-network-smoke.yml'
    || !['push', 'workflow_dispatch'].includes(requiredCi?.event)
    || requiredCi?.headBranch !== 'main'
    || requiredCi?.runAttempt !== 1
    || requiredCi?.status !== 'completed'
    || requiredCi?.conclusion !== 'success'
    || requiredContextsReady !== true) {
    add(blockers, 'SERVER_CANONICAL_REQUIRED_CI_PROVENANCE_INVALID');
  }

  if (githubDelivery?.targetWorkflowId !== 347888347
    || githubDelivery?.targetWorkflowState !== 'active') {
    add(blockers, 'SERVER_CANONICAL_GITHUB_TARGET_WORKFLOW_NOT_ACTIVE');
  }
  if (!positiveInteger(githubDelivery?.targetLatestScheduleCreatedAtMs)
    || !positiveInteger(githubDelivery?.observedAtMs)
    || githubDelivery.observedAtMs - githubDelivery.targetLatestScheduleCreatedAtMs
      <= SERVER_CANONICAL_GITHUB_OUTAGE_MATURITY_MS) {
    add(blockers, 'SERVER_CANONICAL_GITHUB_TARGET_OUTAGE_NOT_MATURED');
  }
  if (!positiveInteger(githubDelivery?.repositoryLatestScheduleCreatedAtMs)
    || githubDelivery.repositoryLatestScheduleCreatedAtMs
      <= githubDelivery.targetLatestScheduleCreatedAtMs) {
    add(blockers, 'SERVER_CANONICAL_REPOSITORY_SCHEDULE_HEALTH_NOT_OBSERVED');
  }

  if (serverRuntime?.deployedSha !== currentMainSha
    || serverRuntime?.timerEnabled !== true
    || serverRuntime?.timerActive !== true
    || serverRuntime?.persistent !== false
    || serverRuntime?.ntpSynchronized !== true
    || serverRuntime?.shadowOnly !== true
    || serverRuntime?.serverCanonical !== false
    || serverRuntime?.productionAppMutationPerformed !== false
    || serverRuntime?.executionAuthority !== 'NONE'
    || !sameArray(serverRuntime?.triggerMinutesUtc, SERVER_TRIGGER_MINUTES)) {
    add(blockers, 'SERVER_CANONICAL_SHADOW_RUNTIME_NOT_READY');
  }

  const authoritySlot = authorizationCurrentSlotIndex(
    cutoverAuthority?.authorizedAtMs,
    contract,
  );
  if (cutoverAuthority?.schemaVersion !== SERVER_CANONICAL_CUTOVER_AUTHORITY_SCHEMA
    || cutoverAuthority?.targetMainSha !== currentMainSha
    || cutoverAuthority?.activationBindingDigest !== activationBindingDigest
    || cutoverAuthority?.activationReceiptCommentId !== latestActivationReceipt?.commentId
    || !positiveInteger(cutoverAuthority?.authorityCommentId)
    || !positiveInteger(cutoverAuthority?.authorizedAtMs)
    || !nonNegativeInteger(cutoverAuthority?.firstEligibleSlotIndex)
    || cutoverAuthority?.replayCredit !== 0
    || cutoverAuthority?.backfillCredit !== 0
    || cutoverAuthority?.manualCredit !== 0
    || cutoverAuthority?.syntheticCredit !== 0
    || cutoverAuthority?.hindsightCredit !== 0
    || cutoverAuthority?.executionAuthority !== 'NONE') {
    add(blockers, 'SERVER_CANONICAL_CUTOVER_AUTHORITY_INVALID');
  }
  if (authoritySlot == null
    || cutoverAuthority?.firstEligibleSlotIndex < authoritySlot + 1) {
    add(blockers, 'SERVER_CANONICAL_CUTOVER_FUTURE_SLOT_LEAD_REQUIRED');
  }

  if (!shadowReceipt || shadowReceipt.schemaVersion !== SERVER_EVIDENCE_SHADOW_SCHEMA
    || shadowReceipt.captureStatus !== 'PRESENT_SHADOW'
    || shadowReceipt.mode !== 'SHADOW_ONLY'
    || shadowReceipt.shadowOnly !== true
    || shadowReceipt.serverCanonical !== false
    || shadowReceipt.codeSha !== currentMainSha
    || shadowReceipt.activationReceiptMainSha !== currentMainSha
    || shadowReceipt.activationReceiptCommentId !== latestActivationReceipt?.commentId
    || shadowReceipt.activationBindingDigest !== activationBindingDigest
    || shadowReceipt.policyDigest !== contract.policyDigest
    || shadowReceipt.cohortDigest !== contract.cohortDigest
    || shadowReceipt.ntpSynchronized !== true
    || shadowReceipt.prospectiveSlotCredit !== 0
    || shadowReceipt.canonicalEconomicCredit !== 0
    || shadowReceipt.economicSampleCredit !== 0
    || shadowReceipt.profitabilityCredit !== 0
    || shadowReceipt.replayCredit !== 0
    || shadowReceipt.backfillCredit !== 0
    || shadowReceipt.manualCredit !== 0
    || shadowReceipt.syntheticCredit !== 0
    || shadowReceipt.hindsightCredit !== 0
    || shadowReceipt.fullCostReady !== false
    || shadowReceipt.evidenceComplete !== 0
    || shadowReceipt.profitabilityProven !== false
    || shadowReceipt.liveTrading !== false
    || shadowReceipt.autoTrading !== false
    || shadowReceipt.realOrderEnabled !== false
    || shadowReceipt.privateTradingApiAllowed !== false
    || shadowReceipt.executionAuthority !== 'NONE'
    || !exactDigest(shadowReceipt.rawBatchDigest)
    || !exactDigest(shadowReceipt.receiptDigest)
    || sha256(canonicalJson(shadowReceiptBody(shadowReceipt))) !== shadowReceipt.receiptDigest
    || !Array.isArray(shadowReceipt.blockers)
    || shadowReceipt.blockers.length !== 0) {
    add(blockers, 'SERVER_CANONICAL_SHADOW_RECEIPT_INVALID');
  }

  if (shadowReceipt && nonNegativeInteger(shadowReceipt.slotIndex)) {
    try {
      const slot = buildSuccessorScheduleReliabilityV3SlotDescriptor(
        shadowReceipt.slotIndex,
        contract,
      );
      if (shadowReceipt.split !== slot.split
        || shadowReceipt.nominalScheduledAtMs !== slot.nominalScheduledAtMs
        || shadowReceipt.allowedStartThroughMs !== slot.allowedStartThroughMs
        || shadowReceipt.triggerAtMs < slot.nominalScheduledAtMs
        || shadowReceipt.triggerAtMs > slot.allowedStartThroughMs) {
        add(blockers, 'SERVER_CANONICAL_SHADOW_SLOT_IDENTITY_INVALID');
      }
    } catch {
      add(blockers, 'SERVER_CANONICAL_SHADOW_SLOT_IDENTITY_INVALID');
    }
  } else {
    add(blockers, 'SERVER_CANONICAL_SHADOW_SLOT_IDENTITY_INVALID');
  }

  if (positiveInteger(cutoverAuthority?.authorizedAtMs)
    && positiveInteger(shadowReceipt?.serverStartedAtMs)
    && shadowReceipt.serverStartedAtMs <= cutoverAuthority.authorizedAtMs) {
    add(blockers, 'SERVER_CANONICAL_RETROACTIVE_SHADOW_RECEIPT_FORBIDDEN');
  }
  if (nonNegativeInteger(shadowReceipt?.slotIndex)
    && nonNegativeInteger(cutoverAuthority?.firstEligibleSlotIndex)
    && shadowReceipt.slotIndex < cutoverAuthority.firstEligibleSlotIndex) {
    add(blockers, 'SERVER_CANONICAL_PRE_CUTOVER_SLOT_FORBIDDEN');
  }

  const readyForFutureCanonicalCutover = blockers.length === 0;
  return Object.freeze({
    schemaVersion: SERVER_CANONICAL_CUTOVER_READINESS_SCHEMA,
    status: readyForFutureCanonicalCutover
      ? 'READY_FOR_SEPARATE_FUTURE_CANONICAL_ACTIVATION'
      : 'BLOCKED',
    readyForFutureCanonicalCutover,
    activationApplied: false,
    currentShadowReceiptCanonical: false,
    currentShadowReceiptEconomicCredit: 0,
    futureCanonicalCreditPermittedByThisReadinessCheck: false,
    requiresSeparateProtectedRuntimeActivation: true,
    firstEligibleSlotIndex:
      nonNegativeInteger(cutoverAuthority?.firstEligibleSlotIndex)
        ? cutoverAuthority.firstEligibleSlotIndex
        : null,
    blockers: Object.freeze(blockers),
    safety: Object.freeze({
      replayCredit: 0,
      backfillCredit: 0,
      manualCredit: 0,
      syntheticCredit: 0,
      hindsightCredit: 0,
      currentEconomicCredit: 0,
      currentProfitabilityCredit: 0,
      fullCostReady: false,
      evidenceComplete: 0,
      profitabilityProven: false,
      liveTrading: false,
      autoTrading: false,
      realOrderEnabled: false,
      privateTradingApiAllowed: false,
      executionAuthority: 'NONE',
      productionAppMutationPerformed: false,
      replitAllowed: false,
    }),
  });
}
