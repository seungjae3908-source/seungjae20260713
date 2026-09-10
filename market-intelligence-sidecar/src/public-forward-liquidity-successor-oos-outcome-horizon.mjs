import { readFileSync } from 'node:fs';

import { canonicalJson, sha256 } from './public-forward-liquidity-calibration.mjs';
import {
  SUCCESSOR_PROSPECTIVE_CONTRACT,
  verifySuccessorProspectiveContract,
} from './public-forward-liquidity-successor-prospective-cohort.mjs';

export const SUCCESSOR_OOS_HORIZON_CONTRACT_PATH = new URL(
  '../config/public-forward-liquidity-successor-oos-outcome-horizon-v2.json',
  import.meta.url,
);

export const SUCCESSOR_OOS_HORIZON_CONTRACT = Object.freeze(
  JSON.parse(readFileSync(SUCCESSOR_OOS_HORIZON_CONTRACT_PATH, 'utf8')),
);

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

function sameArray(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function expectedIdentityCore(contract, computedPolicyDigest, expectedContractId) {
  const outcome = contract.policyCore.outcomePolicy;
  return {
    schemaVersion: 'public-forward-liquidity-successor-oos-outcome-horizon-identity-v2',
    contractId: expectedContractId,
    policyDigest: computedPolicyDigest,
    successorCohortDigest: contract.policyCore.successorCohortBinding.cohortDigest,
    outcomeHorizonIdentity: outcome.outcomeHorizonIdentity,
    outcomeHorizonMs: outcome.outcomeHorizonMs,
    outcomeSelectionPolicy: outcome.outcomeSelectionPolicy,
    referenceTimestampField: outcome.referenceTimestampField,
  };
}

export function targetSuccessorOosTimestampMs(
  eventTimestampMs,
  contract = SUCCESSOR_OOS_HORIZON_CONTRACT,
) {
  if (!integer(eventTimestampMs) || eventTimestampMs <= 0) {
    throw new Error('SUCCESSOR_OOS_EVENT_TIMESTAMP_INVALID');
  }
  return eventTimestampMs + contract.policyCore.outcomePolicy.outcomeHorizonMs;
}

export function verifySuccessorOosOutcomeHorizonContract(
  contract = SUCCESSOR_OOS_HORIZON_CONTRACT,
  successorContract = SUCCESSOR_PROSPECTIVE_CONTRACT,
) {
  const blockers = [];

  if (contract?.contractVersion !== 'public-forward-liquidity-successor-oos-outcome-horizon-contract-v2') {
    add(blockers, 'SUCCESSOR_OOS_HORIZON_CONTRACT_VERSION_INVALID');
  }
  if (contract?.freezeStatus !== 'HUMAN_POLICY_VALUES_FROZEN_REPOSITORY_DRAFT_MATERIALIZATION') {
    add(blockers, 'SUCCESSOR_OOS_HORIZON_FREEZE_STATUS_INVALID');
  }

  const policy = contract?.policyCore;
  if (!policy || policy.schemaVersion !== 'public-forward-liquidity-successor-oos-outcome-horizon-policy-v2') {
    add(blockers, 'SUCCESSOR_OOS_HORIZON_POLICY_CORE_INVALID');
    return Object.freeze({ valid: false, blockers: Object.freeze(blockers) });
  }

  const computedPolicyDigest = sha256(canonicalJson(policy));
  if (!exactDigest(contract.policyDigest) || contract.policyDigest !== computedPolicyDigest) {
    add(blockers, 'SUCCESSOR_OOS_HORIZON_POLICY_DIGEST_MISMATCH');
  }
  const expectedContractId =
    `PUBLIC_FORWARD_LIQUIDITY_SUCCESSOR_OOS_HORIZON_BINDING_V2_5000MS:${computedPolicyDigest}`;
  if (contract.contractId !== expectedContractId) {
    add(blockers, 'SUCCESSOR_OOS_HORIZON_CONTRACT_ID_MISMATCH');
  }

  const expectedIdentity = expectedIdentityCore(contract, computedPolicyDigest, expectedContractId);
  if (canonicalJson(contract.contractIdentityCore) !== canonicalJson(expectedIdentity)) {
    add(blockers, 'SUCCESSOR_OOS_HORIZON_IDENTITY_CORE_MISMATCH');
  }
  const computedContractDigest = sha256(canonicalJson(expectedIdentity));
  if (!exactDigest(contract.contractDigest) || contract.contractDigest !== computedContractDigest) {
    add(blockers, 'SUCCESSOR_OOS_HORIZON_CONTRACT_DIGEST_MISMATCH');
  }

  const successorVerdict = verifySuccessorProspectiveContract(successorContract);
  if (!successorVerdict.valid) {
    add(blockers, 'SUCCESSOR_OOS_HORIZON_BASE_COHORT_CONTRACT_INVALID');
  }

  const authority = policy.authority ?? {};
  if (authority.canonicalHubIssue !== 838
    || authority.humanApprovalCommentId !== 5490310342
    || authority.humanApprovalCreatedAt !== '2026-09-01T07:15:31Z'
    || authority.humanApprovalCreatedAtMs !== 1788246931000
    || authority.approvalScope !== 'SUCCESSOR_OOS_OUTCOME_HORIZON_5000MS_DESIGN_AND_FREEZE_ONLY'
    || !exactSha(authority.sourceBaseMainSha)
    || authority.sourceBaseMainSha !== '7442fbfd859db01ce5f018ddeb027ccd3282be4e') {
    add(blockers, 'SUCCESSOR_OOS_HORIZON_HUMAN_AUTHORITY_INVALID');
  }

  const rebinding = policy.capacityRebindingAuthority ?? {};
  if (rebinding.canonicalHubIssue !== 838
    || rebinding.capacityNumericFreezeCommentId !== 5500894175
    || rebinding.capacityNumericFreezeCreatedAt !== '2026-09-01T21:49:01Z'
    || rebinding.capacityNumericFreezeCreatedAtMs !== 1788299341000
    || rebinding.capacityNumericFreezeDigest
      !== '45b6e09909347e9d5ed41ed618b7874e2e528190838886eaa656997e22d4e947'
    || rebinding.rebindingScope
      !== 'COHORT_CAPACITY_BINDING_REMATERIALIZATION_ONLY_NO_HORIZON_RETUNE'
    || rebinding.outcomeHorizonRetuned !== false) {
    add(blockers, 'SUCCESSOR_OOS_HORIZON_CAPACITY_REBIND_AUTHORITY_INVALID');
  }

  const binding = policy.successorCohortBinding ?? {};
  const basePolicy = successorContract?.policyCore;
  const baseOos = basePolicy?.splits?.OOS;
  if (binding.contractVersion !== successorContract?.contractVersion
    || binding.cohortId !== successorContract?.cohortId
    || binding.policyDigest !== successorContract?.policyDigest
    || binding.cohortDigest !== successorContract?.cohortDigest
    || binding.firstEligibleSlotMs !== basePolicy?.cohort?.startInclusiveMs
    || binding.firstEligibleSlotUtc !== basePolicy?.cohort?.startInclusiveUtc
    || binding.firstEligibleSlotKst !== basePolicy?.cohort?.startInclusiveKst
    || binding.firstOosSlotIndex !== baseOos?.startIndexInclusive
    || binding.firstOosSlotMs !== baseOos?.startInclusiveMs
    || binding.oosExpectedSlotN !== baseOos?.expectedSlotN) {
    add(blockers, 'SUCCESSOR_OOS_HORIZON_COHORT_BINDING_MISMATCH');
  }

  if (!integer(authority.humanApprovalCreatedAtMs)
    || authority.humanApprovalCreatedAtMs >= binding.firstEligibleSlotMs
    || authority.humanApprovalCreatedAtMs >= binding.firstOosSlotMs) {
    add(blockers, 'SUCCESSOR_OOS_HORIZON_NOT_FROZEN_PROSPECTIVELY');
  }
  if (!integer(rebinding.capacityNumericFreezeCreatedAtMs)
    || rebinding.capacityNumericFreezeCreatedAtMs >= binding.firstEligibleSlotMs
    || rebinding.capacityNumericFreezeCreatedAtMs >= binding.firstOosSlotMs) {
    add(blockers, 'SUCCESSOR_OOS_HORIZON_CAPACITY_REBIND_NOT_PROSPECTIVE');
  }

  const baseSeparatePolicy = basePolicy?.oosOutcomePolicy ?? {};
  if (baseSeparatePolicy.status !== 'NOT_ASSIGNED_BY_THIS_APPROVAL'
    || baseSeparatePolicy.numericOutcomeHorizonMs !== null
    || baseSeparatePolicy.separatePreObservationFreezeRequired !== true
    || baseSeparatePolicy.outcomeBasedSelectionAllowed !== false) {
    add(blockers, 'SUCCESSOR_OOS_HORIZON_BASE_CONTRACT_AUTHORITY_CHANGED');
  }

  const outcome = policy.outcomePolicy ?? {};
  if (outcome.outcomeHorizonIdentity !== 'PUBLIC_FORWARD_LIQUIDITY_SUCCESSOR_OOS_HORIZON_V1_5000MS'
    || outcome.outcomeHorizonMs !== 5_000
    || outcome.referenceTimestampField !== 'eventTimestampMs'
    || outcome.referenceSemantics !== 'OOS_ASSIGNMENT_EVENT_TIMESTAMP_MS'
    || outcome.targetTimestampFormula !== 'eventTimestampMs + outcomeHorizonMs'
    || outcome.outcomeSelectionPolicy !== 'FIRST_PUBLIC_OBSERVATION_AT_OR_AFTER_HORIZON'
    || outcome.uniqueEarliestCandidateRequired !== true
    || outcome.genuinePublicForwardOnly !== true
    || outcome.calibrationSourceOnlyRequired !== true
    || outcome.outcomeExecutionCostEligible !== false
    || outcome.causalMarketImpactClaimAllowed !== false
    || outcome.captureFrameAuthoritySemantics
      !== 'CAPTURE_FRAME_IS_NOT_OOS_BY_ITSELF_AND_IS_ELIGIBLE_ONLY_IF_ALL_OOS_LINEAGE_AND_SELECTION_GATES_PASS'
    || !sameArray(outcome.existingCapturePostObservationDelaysMs, [1_000, 5_000])) {
    add(blockers, 'SUCCESSOR_OOS_HORIZON_POLICY_INVALID');
  }

  const captureDelays = basePolicy?.technicalIdentity?.captureParameterPolicy?.postObservationDelaysMs;
  if (!sameArray(captureDelays, [1_000, 5_000])
    || !sameArray(outcome.existingCapturePostObservationDelaysMs, captureDelays)) {
    add(blockers, 'SUCCESSOR_OOS_HORIZON_CAPTURE_BINDING_MISMATCH');
  }

  const integrity = policy.prospectiveIntegrity ?? {};
  if (integrity.humanFreezePredatesCohortFirstEligible !== true
    || integrity.humanFreezePredatesFirstOosSlot !== true
    || integrity.capacityRebindingPredatesCohortFirstEligible !== true
    || integrity.capacityRebindingPredatesFirstOosSlot !== true
    || integrity.outcomeInspectionUsedForPolicySelection !== false
    || integrity.oldV3OutcomeHorizonMs !== 60_000
    || integrity.oldV3OutcomeHorizonAuthorityInherited !== false
    || integrity.outcomeBasedRetuningAllowed !== false
    || integrity.horizonSwitchingAllowed !== false
    || integrity.retrospectiveReassignmentAllowed !== false
    || integrity.manualCredit !== 0
    || integrity.replayCredit !== 0
    || integrity.backfillCredit !== 0
    || integrity.syntheticCredit !== 0) {
    add(blockers, 'SUCCESSOR_OOS_HORIZON_PROSPECTIVE_INTEGRITY_INVALID');
  }

  const approvals = policy.approvalBoundaries ?? {};
  if (Object.values(approvals).some((value) => value !== false)) {
    add(blockers, 'SUCCESSOR_OOS_HORIZON_UNAPPROVED_AUTHORITY_ESCALATION');
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
    add(blockers, 'SUCCESSOR_OOS_HORIZON_SAFETY_BOUNDARY_INVALID');
  }

  return Object.freeze({
    valid: blockers.length === 0,
    blockers: Object.freeze(blockers),
    policyDigest: computedPolicyDigest,
    contractDigest: computedContractDigest,
    contractId: expectedContractId,
  });
}
