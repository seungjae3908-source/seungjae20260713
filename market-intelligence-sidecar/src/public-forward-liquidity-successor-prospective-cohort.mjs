import { readFileSync } from 'node:fs';

import { canonicalJson, sha256 } from './public-forward-liquidity-calibration.mjs';

export const SUCCESSOR_PROSPECTIVE_CONTRACT_PATH = new URL(
  '../config/public-forward-liquidity-successor-prospective-cohort-v2.json',
  import.meta.url,
);

export const SUCCESSOR_PROSPECTIVE_CONTRACT = Object.freeze(
  JSON.parse(readFileSync(SUCCESSOR_PROSPECTIVE_CONTRACT_PATH, 'utf8')),
);

const SPLIT_NAMES = Object.freeze(['TRAIN', 'VALIDATION', 'OOS']);

function add(blockers, code) {
  if (!blockers.includes(code)) blockers.push(code);
}

function exactSha(value) {
  return typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
}

function exactDigest(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function integer(value) {
  return Number.isInteger(value);
}

function expectedCohortIdentityCore(contract) {
  const policy = contract.policyCore;
  return {
    schemaVersion: 'public-forward-liquidity-successor-prospective-cohort-identity-v2',
    cohortId: contract.cohortId,
    policyDigest: contract.policyDigest,
    startInclusiveMs: policy.cohort.startInclusiveMs,
    endExclusiveMs: policy.cohort.endExclusiveMs,
    slotCadenceMs: policy.cohort.slotCadenceMs,
    totalSlotN: policy.cohort.totalSlotN,
    splits: policy.splits,
  };
}

export function splitForSuccessorSlotIndex(slotIndex, contract = SUCCESSOR_PROSPECTIVE_CONTRACT) {
  if (!integer(slotIndex) || slotIndex < 0 || slotIndex >= contract.policyCore.cohort.totalSlotN) {
    throw new Error('SUCCESSOR_SLOT_INDEX_INVALID');
  }
  for (const name of SPLIT_NAMES) {
    const split = contract.policyCore.splits[name];
    if (slotIndex >= split.startIndexInclusive && slotIndex <= split.endIndexInclusive) return name;
  }
  throw new Error('SUCCESSOR_SLOT_SPLIT_UNBOUND');
}

export function buildSuccessorSlotDescriptor(slotIndex, contract = SUCCESSOR_PROSPECTIVE_CONTRACT) {
  const cohort = contract.policyCore.cohort;
  const split = splitForSuccessorSlotIndex(slotIndex, contract);
  const nominalScheduledAtMs = cohort.startInclusiveMs + (slotIndex * cohort.slotCadenceMs);
  const slotEndExclusiveMs = nominalScheduledAtMs + cohort.slotCadenceMs;
  const allowedStartThroughMs = nominalScheduledAtMs + cohort.allowedStartDelayMs;
  const latestCompletionIfLatestEligibleStartMs = allowedStartThroughMs + cohort.allowedCompletionDelayMs;
  return Object.freeze({
    slotIndex,
    split,
    nominalScheduledAtMs,
    slotEndExclusiveMs,
    allowedStartThroughMs,
    latestCompletionIfLatestEligibleStartMs,
    cronUtc: cohort.cronUtc,
    canonicalSlotKey: Object.freeze({
      policyDigest: contract.policyDigest,
      cohortDigest: contract.cohortDigest,
      slotIndex,
    }),
  });
}

export function verifySuccessorProspectiveContract(contract = SUCCESSOR_PROSPECTIVE_CONTRACT) {
  const blockers = [];
  if (contract?.contractVersion !== 'public-forward-liquidity-successor-prospective-cohort-contract-v2') {
    add(blockers, 'SUCCESSOR_CONTRACT_VERSION_INVALID');
  }
  if (contract?.freezeStatus !== 'HUMAN_POLICY_VALUES_FROZEN_REPOSITORY_DRAFT_MATERIALIZATION') {
    add(blockers, 'SUCCESSOR_FREEZE_STATUS_INVALID');
  }
  const policy = contract?.policyCore;
  if (!policy || policy.schemaVersion !== 'public-forward-liquidity-successor-prospective-cohort-policy-v2') {
    add(blockers, 'SUCCESSOR_POLICY_CORE_INVALID');
    return Object.freeze({ valid: false, blockers: Object.freeze(blockers) });
  }

  const computedPolicyDigest = sha256(canonicalJson(policy));
  if (!exactDigest(contract.policyDigest) || contract.policyDigest !== computedPolicyDigest) {
    add(blockers, 'SUCCESSOR_POLICY_DIGEST_MISMATCH');
  }
  const expectedCohortId = `${policy.cohort.identitySeed}:${computedPolicyDigest}`;
  if (contract.cohortId !== expectedCohortId) add(blockers, 'SUCCESSOR_COHORT_ID_MISMATCH');

  const expectedIdentity = expectedCohortIdentityCore({
    ...contract,
    policyDigest: computedPolicyDigest,
    cohortId: expectedCohortId,
  });
  if (canonicalJson(contract.cohortIdentityCore) !== canonicalJson(expectedIdentity)) {
    add(blockers, 'SUCCESSOR_COHORT_IDENTITY_CORE_MISMATCH');
  }
  const computedCohortDigest = sha256(canonicalJson(expectedIdentity));
  if (!exactDigest(contract.cohortDigest) || contract.cohortDigest !== computedCohortDigest) {
    add(blockers, 'SUCCESSOR_COHORT_DIGEST_MISMATCH');
  }

  const authority = policy.authority;
  if (authority?.canonicalHubIssue !== 838
    || authority?.humanApprovalCommentId !== 5500894175
    || authority?.humanApprovalCreatedAt !== '2026-09-01T21:49:01Z'
    || authority?.humanApprovalCreatedAtMs !== 1788299341000
    || authority?.approvalScope !== 'SUCCESSOR_PROSPECTIVE_COHORT_CAPACITY_1024_DESIGN_AND_FREEZE_ONLY'
    || authority?.sourceBaseMainSha !== '4715f33719238d764a3314eab952720663f2d296') {
    add(blockers, 'SUCCESSOR_HUMAN_APPROVAL_REFERENCE_INVALID');
  }
  if (!integer(authority?.humanApprovalCreatedAtMs)
    || authority.humanApprovalCreatedAtMs >= policy.cohort.startInclusiveMs) {
    add(blockers, 'SUCCESSOR_POLICY_NOT_FROZEN_BEFORE_COHORT');
  }
  if (!exactSha(authority?.sourceBaseMainSha)) add(blockers, 'SUCCESSOR_SOURCE_MAIN_SHA_INVALID');

  const capacity = policy.capacityRedesignBinding ?? {};
  if (capacity.designIdentity !== 'PUBLIC_FORWARD_PARTIAL_FILL_PROSPECTIVE_COHORT_CAPACITY_REDESIGN_DESIGN_V1'
    || capacity.designCommentId !== 5500824852
    || capacity.designDigest !== '2957c96c220c31067aa9deb319db6f83ab544f81ff8d41eec84c6de664be4660'
    || capacity.numericFreezeIdentity !== 'PUBLIC_FORWARD_PARTIAL_FILL_PROSPECTIVE_COHORT_CAPACITY_NUMERIC_V1'
    || capacity.numericFreezeCommentId !== 5500894175
    || capacity.numericFreezeDigest !== '45b6e09909347e9d5ed41ed618b7874e2e528190838886eaa656997e22d4e947'
    || capacity.mechanicalFloorTotalSlotN !== 712
    || capacity.finalTotalSlotN !== 1024
    || capacity.finalHeadroomSlotN !== 312
    || capacity.priorTotalSlotN !== 336
    || capacity.priorCohortExtensionSlotN !== 688
    || capacity.trainValidationOosRatio !== '2:1:1'
    || capacity.trainSlotN !== 512
    || capacity.validationSlotN !== 256
    || capacity.oosSlotN !== 256
    || capacity.aiNumericAuthority !== 'NONE') {
    add(blockers, 'SUCCESSOR_CAPACITY_REDESIGN_AUTHORITY_INVALID');
  }

  const supersedes = policy.supersedes ?? {};
  if (supersedes.contractVersion !== 'public-forward-liquidity-successor-prospective-cohort-contract-v1'
    || supersedes.policyDigest !== '451b880a7efff4c3cbb8abe8bcda07bbf54a534f9f01baeb040547c339fa489a'
    || supersedes.cohortDigest !== '7c24f0f752c500bc7ea90df5e7975319a5c4813a23f8f0e375a1ffd0b99672bb'
    || supersedes.retroactiveReclassificationAllowed !== false
    || supersedes.redesignedCreditFromPriorCohort !== 0) {
    add(blockers, 'SUCCESSOR_PREDECESSOR_RECLASSIFICATION_INVALID');
  }

  const cohort = policy.cohort;
  if (cohort.canonicalTimezone !== 'UTC' || cohort.displayTimezone !== 'Asia/Seoul') {
    add(blockers, 'SUCCESSOR_TIMEZONE_INVALID');
  }
  if (cohort.startInclusiveMs !== 1788362220000 || cohort.endExclusiveMs !== 1792048620000) {
    add(blockers, 'SUCCESSOR_COHORT_WINDOW_INVALID');
  }
  if (cohort.slotCadenceMs !== 3_600_000 || cohort.totalSlotN !== 1024 || cohort.cronUtc !== '17 * * * *') {
    add(blockers, 'SUCCESSOR_CADENCE_INVALID');
  }
  if (cohort.endExclusiveMs - cohort.startInclusiveMs !== cohort.slotCadenceMs * cohort.totalSlotN) {
    add(blockers, 'SUCCESSOR_COHORT_DURATION_MISMATCH');
  }
  if (cohort.allowedStartDelayMs !== 1_200_000 || cohort.allowedCompletionDelayMs !== 600_000) {
    add(blockers, 'SUCCESSOR_CAPTURE_WINDOW_INVALID');
  }
  if (cohort.allowedStartDelayMs + cohort.allowedCompletionDelayMs >= cohort.slotCadenceMs) {
    add(blockers, 'SUCCESSOR_CAPTURE_WINDOW_OVERLAPS_NEXT_SLOT');
  }

  if (policy.splits?.mode !== 'CHRONOLOGICAL_IMMUTABLE_SLOT_RANGE') {
    add(blockers, 'SUCCESSOR_SPLIT_MODE_INVALID');
  }
  const expectedSplits = {
    TRAIN: [0, 511, 512, 1788362220000, 1790205420000],
    VALIDATION: [512, 767, 256, 1790205420000, 1791127020000],
    OOS: [768, 1023, 256, 1791127020000, 1792048620000],
  };
  for (const name of SPLIT_NAMES) {
    const split = policy.splits?.[name];
    const expected = expectedSplits[name];
    if (!split
      || split.startIndexInclusive !== expected[0]
      || split.endIndexInclusive !== expected[1]
      || split.expectedSlotN !== expected[2]
      || split.startInclusiveMs !== expected[3]
      || split.endExclusiveMs !== expected[4]
      || split.endIndexInclusive - split.startIndexInclusive + 1 !== split.expectedSlotN) {
      add(blockers, `SUCCESSOR_${name}_SPLIT_INVALID`);
    }
  }

  const credits = policy.creditPolicy ?? {};
  if (credits.prospectiveCreditPerEligiblePresentFirstAttempt !== 1) {
    add(blockers, 'SUCCESSOR_PRESENT_FIRST_ATTEMPT_CREDIT_INVALID');
  }
  for (const key of [
    'oldV3ProspectiveCredit',
    'manualCredit',
    'replayCredit',
    'backfillCredit',
    'operatorSelectedCredit',
    'duplicateOrRerunCredit',
    'missedSlotCredit',
    'syntheticCredit',
  ]) {
    if (credits[key] !== 0) add(blockers, `SUCCESSOR_${key.toUpperCase()}_NONZERO`);
  }

  const integrity = policy.prospectiveIntegrity ?? {};
  if (integrity.chronologicalSplitRequired !== true
    || integrity.randomSplitAllowed !== false
    || integrity.retrospectiveSplitReassignmentAllowed !== false
    || integrity.oldV3IdentityInheritanceAllowed !== false
    || integrity.outcomeInspectionUsedForPolicySelection !== false
    || integrity.successorGenuineRawNAtFreeze !== 0
    || integrity.firstObservationRequiresFrozenDefaultBranchContract !== true
    || integrity.missingOrLateSlotFailsClosed !== true) {
    add(blockers, 'SUCCESSOR_PROSPECTIVE_INTEGRITY_INVALID');
  }

  const technical = policy.technicalIdentity ?? {};
  if (technical.market !== 'CRYPTO_FUTURES'
    || technical.symbol !== 'BTCUSDT'
    || technical.publicDataSource !== 'BITGET_PUBLIC_UTA_V3'
    || technical.observationContract !== 'public-forward-liquidity-calibration-observation/v1'
    || technical.storeContract !== 'research-production-state-root/forward-liquidity-calibration-v1'
    || technical.collectorImplementationBlobSha !== '8044d5cb136eb30a531608392c73a45be601e5ba'
    || technical.runtimeCollectorCodeShaRule !== 'EQUALS_EXACT_MAIN_SHA_AT_RUN') {
    add(blockers, 'SUCCESSOR_TECHNICAL_IDENTITY_INVALID');
  }
  if (sha256(canonicalJson(technical.captureParameterPolicy)) !== technical.captureParameterPolicyDigest) {
    add(blockers, 'SUCCESSOR_CAPTURE_PARAMETER_POLICY_DIGEST_MISMATCH');
  }

  const oosPolicy = policy.oosOutcomePolicy ?? {};
  if (oosPolicy.status !== 'NOT_ASSIGNED_BY_THIS_APPROVAL'
    || oosPolicy.numericOutcomeHorizonMs !== null
    || oosPolicy.separatePreObservationFreezeRequired !== true
    || oosPolicy.outcomeBasedSelectionAllowed !== false) {
    add(blockers, 'SUCCESSOR_OOS_OUTCOME_POLICY_AUTHORITY_ESCALATION');
  }

  const approvals = policy.approvalBoundaries ?? {};
  if (Object.values(approvals).some((value) => value !== false)) {
    add(blockers, 'SUCCESSOR_UNAPPROVED_EXECUTION_BOUNDARY_ESCALATION');
  }
  const safety = policy.safety ?? {};
  if (safety.publicDataOnly !== true
    || safety.executionAuthority !== 'NONE'
    || safety.privateTradingApiAllowed !== false
    || safety.liveTradingAllowed !== false
    || safety.autoTradingAllowed !== false
    || safety.realOrderAllowed !== false
    || safety.financialMutationAllowed !== false
    || safety.replitAgentAllowed !== false
    || safety.fullCostReady !== false
    || safety.evidenceComplete !== 0
    || safety.profitabilityProven !== false
    || safety.currentValidatedChampion !== 'NONE') {
    add(blockers, 'SUCCESSOR_SAFETY_BOUNDARY_INVALID');
  }

  return Object.freeze({
    valid: blockers.length === 0,
    blockers: Object.freeze(blockers),
    policyDigest: computedPolicyDigest,
    cohortDigest: computedCohortDigest,
  });
}
