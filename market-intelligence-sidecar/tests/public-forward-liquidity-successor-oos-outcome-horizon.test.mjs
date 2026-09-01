import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { SUCCESSOR_PROSPECTIVE_CONTRACT } from '../src/public-forward-liquidity-successor-prospective-cohort.mjs';
import {
  SUCCESSOR_OOS_HORIZON_CONTRACT,
  targetSuccessorOosTimestampMs,
  verifySuccessorOosOutcomeHorizonContract,
} from '../src/public-forward-liquidity-successor-oos-outcome-horizon.mjs';

test('5000ms successor OOS horizon contract is immutable and internally consistent', () => {
  const verdict = verifySuccessorOosOutcomeHorizonContract();
  assert.deepEqual(verdict.blockers, []);
  assert.equal(verdict.valid, true);
  assert.equal(
    verdict.policyDigest,
    'd082e51e37ac7847178b37ad332e4cd7283316686b1f24e1349a7bcae00da286',
  );
  assert.equal(
    verdict.contractDigest,
    '7dd8b27843a12a427a45cdd47d71c412643611d2566f9e5feaccc149e668a1a5',
  );
  assert.equal(
    verdict.contractId,
    'PUBLIC_FORWARD_LIQUIDITY_SUCCESSOR_OOS_HORIZON_V1_5000MS:d082e51e37ac7847178b37ad332e4cd7283316686b1f24e1349a7bcae00da286',
  );
});

test('human 5000ms freeze predates both successor cohort start and first OOS slot', () => {
  const { authority, successorCohortBinding } = SUCCESSOR_OOS_HORIZON_CONTRACT.policyCore;
  assert.equal(authority.canonicalHubIssue, 838);
  assert.equal(authority.humanApprovalCommentId, 5490310342);
  assert.equal(authority.humanApprovalCreatedAt, '2026-09-01T07:15:31Z');
  assert.equal(authority.humanApprovalCreatedAtMs, 1788246931000);
  assert.ok(authority.humanApprovalCreatedAtMs < successorCohortBinding.firstEligibleSlotMs);
  assert.ok(authority.humanApprovalCreatedAtMs < successorCohortBinding.firstOosSlotMs);
});

test('separate OOS policy binds exactly to the frozen successor cohort without changing its identity', () => {
  const binding = SUCCESSOR_OOS_HORIZON_CONTRACT.policyCore.successorCohortBinding;
  assert.equal(binding.cohortId, SUCCESSOR_PROSPECTIVE_CONTRACT.cohortId);
  assert.equal(binding.policyDigest, SUCCESSOR_PROSPECTIVE_CONTRACT.policyDigest);
  assert.equal(binding.cohortDigest, SUCCESSOR_PROSPECTIVE_CONTRACT.cohortDigest);
  assert.equal(binding.firstEligibleSlotMs, SUCCESSOR_PROSPECTIVE_CONTRACT.policyCore.cohort.startInclusiveMs);
  assert.equal(binding.firstOosSlotIndex, 252);
  assert.equal(binding.firstOosSlotMs, SUCCESSOR_PROSPECTIVE_CONTRACT.policyCore.splits.OOS.startInclusiveMs);
  assert.equal(binding.oosExpectedSlotN, 84);

  const baseOos = SUCCESSOR_PROSPECTIVE_CONTRACT.policyCore.oosOutcomePolicy;
  assert.equal(baseOos.status, 'NOT_ASSIGNED_BY_THIS_APPROVAL');
  assert.equal(baseOos.numericOutcomeHorizonMs, null);
  assert.equal(baseOos.separatePreObservationFreezeRequired, true);
});

test('5000ms is measured from assignment eventTimestampMs and uses existing first-at-or-after semantics', () => {
  const outcome = SUCCESSOR_OOS_HORIZON_CONTRACT.policyCore.outcomePolicy;
  assert.equal(outcome.outcomeHorizonMs, 5_000);
  assert.equal(outcome.referenceTimestampField, 'eventTimestampMs');
  assert.equal(outcome.referenceSemantics, 'OOS_ASSIGNMENT_EVENT_TIMESTAMP_MS');
  assert.equal(outcome.targetTimestampFormula, 'eventTimestampMs + outcomeHorizonMs');
  assert.equal(outcome.outcomeSelectionPolicy, 'FIRST_PUBLIC_OBSERVATION_AT_OR_AFTER_HORIZON');
  assert.equal(outcome.uniqueEarliestCandidateRequired, true);
  assert.equal(targetSuccessorOosTimestampMs(1_000_000), 1_005_000);
});

test('the existing +5s capture frame has no OOS authority by itself', () => {
  const outcome = SUCCESSOR_OOS_HORIZON_CONTRACT.policyCore.outcomePolicy;
  assert.deepEqual(outcome.existingCapturePostObservationDelaysMs, [1_000, 5_000]);
  assert.deepEqual(
    outcome.existingCapturePostObservationDelaysMs,
    SUCCESSOR_PROSPECTIVE_CONTRACT.policyCore.technicalIdentity.captureParameterPolicy.postObservationDelaysMs,
  );
  assert.equal(
    outcome.captureFrameAuthoritySemantics,
    'CAPTURE_FRAME_IS_NOT_OOS_BY_ITSELF_AND_IS_ELIGIBLE_ONLY_IF_ALL_OOS_LINEAGE_AND_SELECTION_GATES_PASS',
  );
  assert.equal(outcome.genuinePublicForwardOnly, true);
  assert.equal(outcome.calibrationSourceOnlyRequired, true);
  assert.equal(outcome.outcomeExecutionCostEligible, false);
});

test('old V3 60000ms and all hindsight credit paths remain non-authoritative', () => {
  const integrity = SUCCESSOR_OOS_HORIZON_CONTRACT.policyCore.prospectiveIntegrity;
  assert.equal(integrity.oldV3OutcomeHorizonMs, 60_000);
  assert.equal(integrity.oldV3OutcomeHorizonAuthorityInherited, false);
  assert.equal(integrity.outcomeInspectionUsedForPolicySelection, false);
  assert.equal(integrity.outcomeBasedRetuningAllowed, false);
  assert.equal(integrity.horizonSwitchingAllowed, false);
  assert.equal(integrity.retrospectiveReassignmentAllowed, false);
  assert.equal(integrity.manualCredit, 0);
  assert.equal(integrity.replayCredit, 0);
  assert.equal(integrity.backfillCredit, 0);
  assert.equal(integrity.syntheticCredit, 0);
});

test('tampering 5000ms to V3 60000ms fails closed', () => {
  const tampered = structuredClone(SUCCESSOR_OOS_HORIZON_CONTRACT);
  tampered.policyCore.outcomePolicy.outcomeHorizonMs = 60_000;
  const verdict = verifySuccessorOosOutcomeHorizonContract(tampered);
  assert.equal(verdict.valid, false);
  assert.ok(verdict.blockers.includes('SUCCESSOR_OOS_HORIZON_POLICY_DIGEST_MISMATCH'));
  assert.ok(verdict.blockers.includes('SUCCESSOR_OOS_HORIZON_POLICY_INVALID'));
});

test('post-observation freeze or authority escalation fails closed', () => {
  const late = structuredClone(SUCCESSOR_OOS_HORIZON_CONTRACT);
  late.policyCore.authority.humanApprovalCreatedAtMs =
    late.policyCore.successorCohortBinding.firstEligibleSlotMs;
  const lateVerdict = verifySuccessorOosOutcomeHorizonContract(late);
  assert.equal(lateVerdict.valid, false);
  assert.ok(lateVerdict.blockers.includes('SUCCESSOR_OOS_HORIZON_NOT_FROZEN_PROSPECTIVELY'));

  const escalated = structuredClone(SUCCESSOR_OOS_HORIZON_CONTRACT);
  escalated.policyCore.approvalBoundaries.scheduleActivationApproved = true;
  const escalatedVerdict = verifySuccessorOosOutcomeHorizonContract(escalated);
  assert.equal(escalatedVerdict.valid, false);
  assert.ok(escalatedVerdict.blockers.includes('SUCCESSOR_OOS_HORIZON_UNAPPROVED_AUTHORITY_ESCALATION'));
});

test('contract grants no merge, schedule, deploy, trading, or financial mutation authority', () => {
  const approvals = SUCCESSOR_OOS_HORIZON_CONTRACT.policyCore.approvalBoundaries;
  assert.ok(Object.values(approvals).every((value) => value === false));
  const safety = SUCCESSOR_OOS_HORIZON_CONTRACT.policyCore.safety;
  assert.equal(safety.executionAuthority, 'NONE');
  assert.equal(safety.privateTradingApiAllowed, false);
  assert.equal(safety.liveTradingAllowed, false);
  assert.equal(safety.autoTradingAllowed, false);
  assert.equal(safety.realOrderAllowed, false);
  assert.equal(safety.financialMutationAllowed, false);
  assert.equal(safety.replitAgentAllowed, false);
  assert.equal(safety.fullCostReady, false);
  assert.equal(safety.evidenceComplete, 0);
  assert.equal(safety.profitabilityProven, false);
  assert.equal(safety.currentValidatedChampion, 'NONE');
});

test('focused validation workflow contains no schedule or dispatch authority', async () => {
  const workflow = await readFile(
    new URL(
      '../../.github/workflows/public-forward-liquidity-successor-oos-outcome-horizon-contract.yml',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(workflow, /pull_request:/u);
  assert.doesNotMatch(workflow, /^\s*schedule:/mu);
  assert.doesNotMatch(workflow, /^\s*workflow_dispatch:/mu);
  assert.doesNotMatch(workflow, /^\s*cron:/mu);
  assert.doesNotMatch(workflow, /^\s*uses:\s*actions\/upload-artifact(?:@|$)/mu);
});
