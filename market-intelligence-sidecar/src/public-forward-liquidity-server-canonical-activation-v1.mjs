import { canonicalJson, sha256 } from './public-forward-liquidity-calibration.mjs';
import {
  buildServerCanonicalCutoverReadiness,
  SERVER_CANONICAL_CUTOVER_AUTHORITY_SCHEMA,
  SERVER_CANONICAL_SOURCE_PRECEDENCE,
} from './public-forward-liquidity-server-canonical-cutover-readiness-v1.mjs';
import {
  SERVER_CANONICAL_RUNTIME_ACTIVATION_SCHEMA,
} from './public-forward-liquidity-server-canonical-runtime-v1.mjs';
import {
  SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT,
} from './public-forward-liquidity-successor-schedule-reliability-v3.mjs';

export const SERVER_CANONICAL_PROTECTED_ACTIVATION_RECORD_SCHEMA =
  'public-forward-liquidity-server-canonical-protected-activation-record-v1';

function exactSha(value) {
  return typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
}

function exactDigest(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function activationSlotIndex(authorizedAtMs, contract) {
  const cohort = contract?.policyCore?.cohort;
  if (!positiveInteger(authorizedAtMs)
    || !Number.isSafeInteger(cohort?.startInclusiveMs)
    || !Number.isSafeInteger(cohort?.endExclusiveMs)
    || !Number.isSafeInteger(cohort?.slotCadenceMs)
    || authorizedAtMs < cohort.startInclusiveMs
    || authorizedAtMs >= cohort.endExclusiveMs) {
    throw new Error('SERVER_CANONICAL_AUTHORITY_TIME_OUTSIDE_ACTIVE_COHORT');
  }
  return Math.floor((authorizedAtMs - cohort.startInclusiveMs) / cohort.slotCadenceMs);
}

export function buildServerCanonicalCutoverAuthority({
  currentMainSha,
  activationBindingDigest,
  activationReceiptCommentId,
  authorityCommentId,
  authorizedAtMs,
  contract = SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT,
} = {}) {
  if (!exactSha(currentMainSha)) throw new Error('SERVER_CANONICAL_AUTHORITY_MAIN_INVALID');
  if (!exactDigest(activationBindingDigest)) throw new Error('SERVER_CANONICAL_AUTHORITY_BINDING_INVALID');
  if (!positiveInteger(activationReceiptCommentId)) throw new Error('SERVER_CANONICAL_AUTHORITY_RECEIPT_INVALID');
  if (!positiveInteger(authorityCommentId)) throw new Error('SERVER_CANONICAL_AUTHORITY_COMMENT_INVALID');
  const authoritySlotIndex = activationSlotIndex(authorizedAtMs, contract);
  const firstEligibleSlotIndex = authoritySlotIndex + 1;
  if (firstEligibleSlotIndex >= contract.policyCore.cohort.totalSlotN) {
    throw new Error('SERVER_CANONICAL_AUTHORITY_NO_FUTURE_SLOT');
  }
  return Object.freeze({
    schemaVersion: SERVER_CANONICAL_CUTOVER_AUTHORITY_SCHEMA,
    targetMainSha: currentMainSha,
    activationBindingDigest,
    activationReceiptCommentId,
    authorityCommentId,
    authorizedAtMs,
    authoritySlotIndex,
    firstEligibleSlotIndex,
    replayCredit: 0,
    backfillCredit: 0,
    manualCredit: 0,
    syntheticCredit: 0,
    hindsightCredit: 0,
    executionAuthority: 'NONE',
  });
}

export function buildProtectedServerCanonicalRuntimeActivation({
  currentMainSha,
  activationBindingDigest,
  activationReceiptCommentId,
  authorityCommentId,
  authorizedAtMs,
  cutoverReadiness,
  firstEligibleSlotIndex,
} = {}) {
  const body = Object.freeze({
    schemaVersion: SERVER_CANONICAL_RUNTIME_ACTIVATION_SCHEMA,
    activationApplied: true,
    defaultOffAcknowledged: true,
    targetMainSha: currentMainSha,
    activationBindingDigest,
    readinessDigest: sha256(canonicalJson(cutoverReadiness)),
    activationReceiptCommentId,
    authorityCommentId,
    authorizedAtMs,
    firstEligibleSlotIndex,
    sourcePrecedence: [...SERVER_CANONICAL_SOURCE_PRECEDENCE],
    preAuthorityShadowCanonicalCredit: 0,
    preCutoverShadowCanonicalCredit: 0,
    replayCredit: 0,
    backfillCredit: 0,
    manualCredit: 0,
    syntheticCredit: 0,
    hindsightCredit: 0,
    executionAuthority: 'NONE',
  });
  return Object.freeze({
    ...body,
    activationDigest: sha256(canonicalJson(body)),
  });
}

export function prepareProtectedServerCanonicalActivation({
  currentMainSha,
  activationBindingDigest,
  latestActivationReceipt,
  requiredCi,
  githubDelivery,
  serverRuntime,
  shadowReceipt,
  canonicalCreditLedger,
  activationReceiptCommentId,
  authorityCommentId,
  authorizedAtMs,
  baselineEvidence,
  historicalShadowLedger,
  contract = SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT,
} = {}) {
  const cutoverAuthority = buildServerCanonicalCutoverAuthority({
    currentMainSha,
    activationBindingDigest,
    activationReceiptCommentId,
    authorityCommentId,
    authorizedAtMs,
    contract,
  });
  const readiness = buildServerCanonicalCutoverReadiness({
    currentMainSha,
    activationBindingDigest,
    latestActivationReceipt,
    requiredCi,
    githubDelivery,
    serverRuntime,
    cutoverAuthority,
    shadowReceipt,
    canonicalCreditLedger,
    contract,
  });
  if (readiness.readyForFutureCanonicalCutover !== true) {
    const error = new Error(`SERVER_CANONICAL_CUTOVER_READINESS_BLOCKED:${readiness.blockers.join(',')}`);
    error.readiness = readiness;
    throw error;
  }
  const runtimeActivation = buildProtectedServerCanonicalRuntimeActivation({
    currentMainSha,
    activationBindingDigest,
    activationReceiptCommentId,
    authorityCommentId,
    authorizedAtMs,
    cutoverReadiness: readiness,
    firstEligibleSlotIndex: cutoverAuthority.firstEligibleSlotIndex,
  });
  const body = Object.freeze({
    schemaVersion: SERVER_CANONICAL_PROTECTED_ACTIVATION_RECORD_SCHEMA,
    targetMainSha: currentMainSha,
    activationBindingDigest,
    activationReceiptCommentId,
    authorityCommentId,
    authorizedAtMs,
    firstEligibleSlotIndex: cutoverAuthority.firstEligibleSlotIndex,
    cutoverAuthority,
    cutoverReadiness: readiness,
    runtimeActivation,
    baselineEvidence,
    historicalShadowLedger,
    sourcePrecedence: [...SERVER_CANONICAL_SOURCE_PRECEDENCE],
    canonicalEconomicCredit: 0,
    canonicalIngestPerformed: false,
    independencePerformed: false,
    fullCostReady: false,
    profitabilityProven: false,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: 'NONE',
    productionAppMutationPerformed: false,
    databaseMutationCount: 0,
    secretMutationCount: 0,
    replitUsed: false,
  });
  return Object.freeze({
    ...body,
    recordDigest: sha256(canonicalJson(body)),
  });
}

export function verifyProtectedServerCanonicalActivationRecord(
  record,
  contract = SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT,
) {
  const blockers = [];
  const { recordDigest: _recordDigest, ...body } = record ?? {};
  if (record?.schemaVersion !== SERVER_CANONICAL_PROTECTED_ACTIVATION_RECORD_SCHEMA) {
    blockers.push('SERVER_CANONICAL_ACTIVATION_RECORD_SCHEMA_INVALID');
  }
  if (!exactSha(record?.targetMainSha)) blockers.push('SERVER_CANONICAL_ACTIVATION_RECORD_MAIN_INVALID');
  if (!exactDigest(record?.activationBindingDigest)) blockers.push('SERVER_CANONICAL_ACTIVATION_RECORD_BINDING_INVALID');
  if (!exactDigest(record?.recordDigest)
    || record.recordDigest !== sha256(canonicalJson(body))) {
    blockers.push('SERVER_CANONICAL_ACTIVATION_RECORD_DIGEST_INVALID');
  }
  if (record?.cutoverReadiness?.readyForFutureCanonicalCutover !== true
    || record?.runtimeActivation?.activationApplied !== true
    || record?.runtimeActivation?.activationDigest == null
    || record?.firstEligibleSlotIndex !== record?.runtimeActivation?.firstEligibleSlotIndex
    || record?.firstEligibleSlotIndex !== record?.cutoverAuthority?.firstEligibleSlotIndex) {
    blockers.push('SERVER_CANONICAL_ACTIVATION_RECORD_LINEAGE_INVALID');
  }
  const expectedAuthoritySlot = (() => {
    try { return activationSlotIndex(record?.authorizedAtMs, contract); } catch { return null; }
  })();
  if (expectedAuthoritySlot == null
    || record?.firstEligibleSlotIndex < expectedAuthoritySlot + 1) {
    blockers.push('SERVER_CANONICAL_ACTIVATION_RECORD_FUTURE_SLOT_INVALID');
  }
  if (record?.canonicalEconomicCredit !== 0
    || record?.canonicalIngestPerformed !== false
    || record?.independencePerformed !== false
    || record?.fullCostReady !== false
    || record?.profitabilityProven !== false
    || record?.liveTrading !== false
    || record?.autoTrading !== false
    || record?.realOrderEnabled !== false
    || record?.privateTradingApiAllowed !== false
    || record?.executionAuthority !== 'NONE'
    || record?.productionAppMutationPerformed !== false
    || record?.databaseMutationCount !== 0
    || record?.secretMutationCount !== 0
    || record?.replitUsed !== false) {
    blockers.push('SERVER_CANONICAL_ACTIVATION_RECORD_SAFETY_INVALID');
  }
  return Object.freeze({ valid: blockers.length === 0, blockers: Object.freeze(blockers) });
}
