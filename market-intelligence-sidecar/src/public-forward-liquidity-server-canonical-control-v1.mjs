import { canonicalJson, sha256 } from './public-forward-liquidity-calibration.mjs';
import {
  SERVER_CANONICAL_CUTOVER_AUTHORITY_SCHEMA,
  SERVER_CANONICAL_SOURCE_PRECEDENCE,
  buildServerCanonicalCutoverReadiness,
} from './public-forward-liquidity-server-canonical-cutover-readiness-v1.mjs';
import {
  SERVER_CANONICAL_RUNTIME_ACTIVATION_SCHEMA,
} from './public-forward-liquidity-server-canonical-runtime-v1.mjs';
import {
  SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT,
  verifySuccessorScheduleReliabilityV3Contract,
} from './public-forward-liquidity-successor-schedule-reliability-v3.mjs';

export const SERVER_CANONICAL_CONTROL_SCHEMA =
  'public-forward-liquidity-server-canonical-control-v1';

function exactSha(value, code) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(normalized)) throw new Error(code);
  return normalized;
}

function exactDigest(value, code) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw new Error(code);
  return normalized;
}

function positiveInteger(value, code) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(code);
  return parsed;
}

function cohortSlotIndex(atMs, contract, code) {
  const timestamp = positiveInteger(atMs, code);
  const cohort = contract?.policyCore?.cohort;
  if (!Number.isSafeInteger(cohort?.startInclusiveMs)
    || !Number.isSafeInteger(cohort?.endExclusiveMs)
    || !Number.isSafeInteger(cohort?.slotCadenceMs)
    || timestamp < cohort.startInclusiveMs
    || timestamp >= cohort.endExclusiveMs) {
    throw new Error(code);
  }
  const slotIndex = Math.floor(
    (timestamp - cohort.startInclusiveMs) / cohort.slotCadenceMs,
  );
  if (!Number.isSafeInteger(slotIndex)
    || slotIndex < 0
    || slotIndex >= cohort.totalSlotN) {
    throw new Error(code);
  }
  return slotIndex;
}

function requireActiveContract(contract) {
  const verdict = verifySuccessorScheduleReliabilityV3Contract(contract);
  if (!verdict.valid || !verdict.activationBound) {
    throw new Error(
      `SERVER_CANONICAL_CONTROL_V3_CONTRACT_INVALID:${verdict.blockers.join(',')}`,
    );
  }
}

export function buildServerCanonicalCutoverAuthority({
  authorityCommentId,
  authorizedAtMs,
  targetMainSha,
  activationBindingDigest,
  activationReceiptCommentId,
  contract = SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT,
} = {}) {
  requireActiveContract(contract);
  const currentMainSha = exactSha(
    targetMainSha,
    'SERVER_CANONICAL_CONTROL_TARGET_MAIN_SHA_INVALID',
  );
  const bindingDigest = exactDigest(
    activationBindingDigest,
    'SERVER_CANONICAL_CONTROL_BINDING_DIGEST_INVALID',
  );
  const commentId = positiveInteger(
    authorityCommentId,
    'SERVER_CANONICAL_CONTROL_AUTHORITY_COMMENT_ID_INVALID',
  );
  const receiptCommentId = positiveInteger(
    activationReceiptCommentId,
    'SERVER_CANONICAL_CONTROL_ACTIVATION_RECEIPT_COMMENT_ID_INVALID',
  );
  const timestamp = positiveInteger(
    authorizedAtMs,
    'SERVER_CANONICAL_CONTROL_AUTHORIZED_AT_INVALID',
  );
  const authoritySlotIndex = cohortSlotIndex(
    timestamp,
    contract,
    'SERVER_CANONICAL_CONTROL_AUTHORITY_OUTSIDE_COHORT',
  );
  const firstEligibleSlotIndex = authoritySlotIndex + 1;
  if (firstEligibleSlotIndex >= contract.policyCore.cohort.totalSlotN) {
    throw new Error('SERVER_CANONICAL_CONTROL_NO_FUTURE_SLOT_AVAILABLE');
  }
  return Object.freeze({
    schemaVersion: SERVER_CANONICAL_CUTOVER_AUTHORITY_SCHEMA,
    authorityCommentId: commentId,
    targetMainSha: currentMainSha,
    activationBindingDigest: bindingDigest,
    activationReceiptCommentId: receiptCommentId,
    authorizedAtMs: timestamp,
    firstEligibleSlotIndex,
    replayCredit: 0,
    backfillCredit: 0,
    manualCredit: 0,
    syntheticCredit: 0,
    hindsightCredit: 0,
    executionAuthority: 'NONE',
  });
}

export function buildProtectedServerCanonicalActivation({
  activationAuthorityCommentId,
  activationAuthorizedAtMs,
  currentMainSha,
  activationBindingDigest,
  latestActivationReceipt,
  requiredCi,
  githubDelivery,
  serverRuntime,
  cutoverAuthority,
  shadowReceipt,
  canonicalCreditLedger,
  contract = SUCCESSOR_SCHEDULE_RELIABILITY_V3_CONTRACT,
} = {}) {
  requireActiveContract(contract);
  const targetMainSha = exactSha(
    currentMainSha,
    'SERVER_CANONICAL_CONTROL_TARGET_MAIN_SHA_INVALID',
  );
  const bindingDigest = exactDigest(
    activationBindingDigest,
    'SERVER_CANONICAL_CONTROL_BINDING_DIGEST_INVALID',
  );
  const authorityCommentId = positiveInteger(
    activationAuthorityCommentId,
    'SERVER_CANONICAL_CONTROL_ACTIVATION_AUTHORITY_COMMENT_ID_INVALID',
  );
  const authorizedAtMs = positiveInteger(
    activationAuthorizedAtMs,
    'SERVER_CANONICAL_CONTROL_ACTIVATION_AUTHORIZED_AT_INVALID',
  );
  const readiness = buildServerCanonicalCutoverReadiness({
    currentMainSha: targetMainSha,
    activationBindingDigest: bindingDigest,
    latestActivationReceipt,
    requiredCi,
    githubDelivery,
    serverRuntime,
    cutoverAuthority,
    shadowReceipt,
    canonicalCreditLedger,
    contract,
  });
  if (!readiness.readyForFutureCanonicalCutover) {
    throw new Error(
      `SERVER_CANONICAL_CONTROL_READINESS_BLOCKED:${readiness.blockers.join(',')}`,
    );
  }

  const activationSlotIndex = cohortSlotIndex(
    authorizedAtMs,
    contract,
    'SERVER_CANONICAL_CONTROL_ACTIVATION_OUTSIDE_COHORT',
  );
  const firstEligibleSlotIndex = Math.max(
    readiness.firstEligibleSlotIndex,
    activationSlotIndex + 1,
  );
  if (firstEligibleSlotIndex >= contract.policyCore.cohort.totalSlotN) {
    throw new Error('SERVER_CANONICAL_CONTROL_NO_FUTURE_ACTIVATION_SLOT_AVAILABLE');
  }
  const readinessDigest = sha256(canonicalJson(readiness));
  const body = Object.freeze({
    schemaVersion: SERVER_CANONICAL_RUNTIME_ACTIVATION_SCHEMA,
    activationApplied: true,
    defaultOffAcknowledged: true,
    targetMainSha,
    activationBindingDigest: bindingDigest,
    readinessDigest,
    activationReceiptCommentId: positiveInteger(
      latestActivationReceipt?.commentId,
      'SERVER_CANONICAL_CONTROL_OWNER_RECEIPT_COMMENT_ID_INVALID',
    ),
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
  const runtimeActivation = Object.freeze({
    ...body,
    activationDigest: sha256(canonicalJson(body)),
  });

  return Object.freeze({
    schemaVersion: SERVER_CANONICAL_CONTROL_SCHEMA,
    cutoverAuthority,
    readiness,
    runtimeActivation,
    baselinePreserved: Object.freeze({
      canonicalTrainReceiptN: 4,
      independentN: 4,
      validationN: 0,
      oosN: 0,
      historicalShadowPromotionPerformed: false,
      retroactiveRecomputePerformed: false,
    }),
    safety: Object.freeze({
      productionApplicationMutationAllowed: false,
      databaseMutationAllowed: false,
      secretMutationAllowed: false,
      replayCredit: 0,
      backfillCredit: 0,
      manualCredit: 0,
      syntheticCredit: 0,
      hindsightCredit: 0,
      privateTradingApiAllowed: false,
      liveTrading: false,
      autoTrading: false,
      realOrderEnabled: false,
      executionAuthority: 'NONE',
      replitAllowed: false,
    }),
  });
}
