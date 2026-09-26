import { createHash } from 'node:crypto';

import {
  SUCCESSOR_PROSPECTIVE_CONTRACT,
  verifySuccessorProspectiveContract,
} from './public-forward-liquidity-successor-prospective-cohort.mjs';
import {
  SUCCESSOR_OOS_HORIZON_CONTRACT,
  verifySuccessorOosOutcomeHorizonContract,
} from './public-forward-liquidity-successor-oos-outcome-horizon.mjs';

export const SUCCESSOR_SCHEDULE_ACTIVATION_AUTHORITY_ID =
  'SUCCESSOR_PROSPECTIVE_SCHEDULE_ACTIVATION';

export const SUCCESSOR_SCHEDULE_ACTIVATION_WORKFLOW = Object.freeze({
  prNumber: 871,
  name: 'Public Forward Liquidity Successor Scheduled Capture',
  path: '.github/workflows/public-forward-liquidity-successor-scheduled-capture.yml',
  cron: '17 * * * *',
});

export const SUCCESSOR_SCHEDULE_AUTHORITY_COMMANDS = Object.freeze({
  authorize:
    '/authorize-successor-prospective-schedule-activation <current-main-sha> <pr871-head-sha> <policy-digest> <cohort-digest>',
  revoke:
    '/revoke-successor-prospective-schedule-activation <current-main-sha> <cohort-digest>',
});

const EXPECTED_TECHNICAL = Object.freeze({
  collectorImplementationBlobSha: '8044d5cb136eb30a531608392c73a45be601e5ba',
  captureParameterPolicyDigest: 'ab4193df073303568dd8b4c55caa5d6c5a2a88547857935d1db13dacb9e8154f',
  outcomeHorizonMs: 5000,
  outcomeSelectionPolicy: 'FIRST_PUBLIC_OBSERVATION_AT_OR_AFTER_HORIZON',
});

function fail(code, detail = '') {
  throw new Error(detail ? `${code}:${detail}` : code);
}

function assertEqual(actual, expected, code) {
  if (actual !== expected) fail(code, `${String(actual)}!=${String(expected)}`);
}

function assertHex(value, length, code) {
  if (!new RegExp(`^[0-9a-f]{${length}}$`).test(String(value ?? ''))) fail(code);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function parseSuccessorScheduleAuthorityCommand(input) {
  const body = String(input ?? '').trim();
  let match = /^\/authorize-successor-prospective-schedule-activation ([0-9a-fA-F]{40}) ([0-9a-fA-F]{40}) ([0-9a-fA-F]{64}) ([0-9a-fA-F]{64})$/.exec(body);
  if (match) {
    return Object.freeze({
      action: 'AUTHORIZE',
      currentMainSha: match[1].toLowerCase(),
      workflowCandidateHeadSha: match[2].toLowerCase(),
      policyDigest: match[3].toLowerCase(),
      cohortDigest: match[4].toLowerCase(),
      rawCommand: body,
    });
  }

  match = /^\/revoke-successor-prospective-schedule-activation ([0-9a-fA-F]{40}) ([0-9a-fA-F]{64})$/.exec(body);
  if (match) {
    return Object.freeze({
      action: 'REVOKE',
      currentMainSha: match[1].toLowerCase(),
      cohortDigest: match[2].toLowerCase(),
      rawCommand: body,
    });
  }

  fail('INVALID_SUCCESSOR_SCHEDULE_AUTHORITY_COMMAND');
}

export function assertReleaseControlCommandSurfaceRegistered(issueBody) {
  const body = String(issueBody ?? '');
  if (!body.includes(SUCCESSOR_SCHEDULE_AUTHORITY_COMMANDS.authorize)) {
    fail('SUCCESSOR_AUTHORIZE_COMMAND_NOT_REGISTERED_ON_RELEASE_CONTROL');
  }
  if (!body.includes(SUCCESSOR_SCHEDULE_AUTHORITY_COMMANDS.revoke)) {
    fail('SUCCESSOR_REVOKE_COMMAND_NOT_REGISTERED_ON_RELEASE_CONTROL');
  }
  return true;
}

export function validateFrozenSuccessorAuthorityInputs({
  cohortContract = SUCCESSOR_PROSPECTIVE_CONTRACT,
  oosContract = SUCCESSOR_OOS_HORIZON_CONTRACT,
} = {}) {
  if (!cohortContract?.policyCore || !oosContract?.policyCore) {
    fail('SUCCESSOR_FROZEN_CONTRACT_MISSING');
  }

  const cohortVerdict = verifySuccessorProspectiveContract(cohortContract);
  if (!cohortVerdict.valid) {
    fail('SUCCESSOR_ACTIVE_COHORT_CONTRACT_INVALID', cohortVerdict.blockers.join(','));
  }
  const oosVerdict = verifySuccessorOosOutcomeHorizonContract(oosContract, cohortContract);
  if (!oosVerdict.valid) {
    fail('SUCCESSOR_ACTIVE_OOS_CONTRACT_INVALID', oosVerdict.blockers.join(','));
  }

  const policy = cohortContract.policyCore;
  const cohort = policy.cohort;
  const splits = policy.splits;
  const technical = policy.technicalIdentity;
  const outcome = oosContract.policyCore.outcomePolicy;
  const integrity = oosContract.policyCore.prospectiveIntegrity;

  assertHex(cohortContract.policyDigest, 64, 'SUCCESSOR_ACTIVE_POLICY_DIGEST_INVALID');
  assertHex(cohortContract.cohortDigest, 64, 'SUCCESSOR_ACTIVE_COHORT_DIGEST_INVALID');
  if (!String(cohortContract.cohortId ?? '').trim()) fail('SUCCESSOR_ACTIVE_COHORT_ID_MISSING');
  assertEqual(cohort.cronUtc, SUCCESSOR_SCHEDULE_ACTIVATION_WORKFLOW.cron, 'SUCCESSOR_CRON_DRIFT');
  if (!Number.isSafeInteger(cohort.startInclusiveMs)
    || !Number.isSafeInteger(cohort.endExclusiveMs)
    || cohort.endExclusiveMs <= cohort.startInclusiveMs) {
    fail('SUCCESSOR_COHORT_WINDOW_INVALID');
  }
  if (!Number.isSafeInteger(cohort.totalSlotN) || cohort.totalSlotN <= 0) {
    fail('SUCCESSOR_SLOT_COUNT_INVALID');
  }
  assertEqual(cohort.allowedStartDelayMs, 1_200_000, 'SUCCESSOR_START_DELAY_DRIFT');
  assertEqual(cohort.allowedCompletionDelayMs, 600_000, 'SUCCESSOR_COMPLETION_DELAY_DRIFT');

  for (const name of ['TRAIN', 'VALIDATION', 'OOS']) {
    const split = splits?.[name];
    if (!Number.isSafeInteger(split?.startIndexInclusive)
      || !Number.isSafeInteger(split?.endIndexInclusive)
      || !Number.isSafeInteger(split?.expectedSlotN)
      || split.endIndexInclusive < split.startIndexInclusive
      || split.expectedSlotN !== split.endIndexInclusive - split.startIndexInclusive + 1) {
      fail(`SUCCESSOR_${name}_SPLIT_INVALID`);
    }
  }
  if (splits.TRAIN.startIndexInclusive !== 0
    || splits.TRAIN.endIndexInclusive + 1 !== splits.VALIDATION.startIndexInclusive
    || splits.VALIDATION.endIndexInclusive + 1 !== splits.OOS.startIndexInclusive
    || splits.OOS.endIndexInclusive !== cohort.totalSlotN - 1
    || splits.TRAIN.expectedSlotN + splits.VALIDATION.expectedSlotN + splits.OOS.expectedSlotN !== cohort.totalSlotN) {
    fail('SUCCESSOR_SPLIT_COVERAGE_INVALID');
  }

  assertEqual(
    technical.collectorImplementationBlobSha,
    EXPECTED_TECHNICAL.collectorImplementationBlobSha,
    'SUCCESSOR_COLLECTOR_BLOB_DRIFT',
  );
  assertEqual(
    technical.captureParameterPolicyDigest,
    EXPECTED_TECHNICAL.captureParameterPolicyDigest,
    'SUCCESSOR_CAPTURE_PARAMETER_DIGEST_DRIFT',
  );
  for (const field of ['manualCredit', 'replayCredit', 'backfillCredit', 'syntheticCredit']) {
    assertEqual(policy.creditPolicy?.[field], 0, `SUCCESSOR_${field.toUpperCase()}_NOT_ZERO`);
  }

  assertEqual(
    oosContract.policyCore.successorCohortBinding.cohortDigest,
    cohortContract.cohortDigest,
    'SUCCESSOR_OOS_COHORT_DIGEST_DRIFT',
  );
  assertEqual(outcome.outcomeHorizonMs, EXPECTED_TECHNICAL.outcomeHorizonMs, 'SUCCESSOR_OOS_HORIZON_DRIFT');
  assertEqual(
    outcome.outcomeSelectionPolicy,
    EXPECTED_TECHNICAL.outcomeSelectionPolicy,
    'SUCCESSOR_OOS_SELECTION_DRIFT',
  );
  assertEqual(
    integrity.oldV3OutcomeHorizonAuthorityInherited,
    false,
    'SUCCESSOR_OLD_V3_OOS_INHERITANCE_NOT_FALSE',
  );

  return Object.freeze({
    authorityIdentity: SUCCESSOR_SCHEDULE_ACTIVATION_AUTHORITY_ID,
    activeCohortContractVersion: cohortContract.contractVersion,
    activeOosContractVersion: oosContract.contractVersion,
    cohortId: cohortContract.cohortId,
    policyDigest: cohortContract.policyDigest,
    cohortDigest: cohortContract.cohortDigest,
    firstEligibleMs: cohort.startInclusiveMs,
    endExclusiveMs: cohort.endExclusiveMs,
    cron: cohort.cronUtc,
    totalSlotN: cohort.totalSlotN,
    splits: Object.freeze({
      TRAIN: Object.freeze([
        splits.TRAIN.startIndexInclusive,
        splits.TRAIN.endIndexInclusive,
        splits.TRAIN.expectedSlotN,
      ]),
      VALIDATION: Object.freeze([
        splits.VALIDATION.startIndexInclusive,
        splits.VALIDATION.endIndexInclusive,
        splits.VALIDATION.expectedSlotN,
      ]),
      OOS: Object.freeze([
        splits.OOS.startIndexInclusive,
        splits.OOS.endIndexInclusive,
        splits.OOS.expectedSlotN,
      ]),
    }),
    allowedStartDelayMs: cohort.allowedStartDelayMs,
    allowedCompletionDelayMs: cohort.allowedCompletionDelayMs,
    collectorImplementationBlobSha: technical.collectorImplementationBlobSha,
    captureParameterPolicyDigest: technical.captureParameterPolicyDigest,
    outcomeHorizonMs: outcome.outcomeHorizonMs,
    outcomeSelectionPolicy: outcome.outcomeSelectionPolicy,
    oldV3OutcomeHorizonAuthorityInherited: false,
  });
}

export function loadFrozenSuccessorAuthorityContract() {
  return validateFrozenSuccessorAuthorityInputs();
}

export function buildSuccessorScheduleAuthorityEvidence({
  command,
  frozenContract = loadFrozenSuccessorAuthorityContract(),
  currentMainSha,
  workflowCandidateHeadSha = null,
  workflowBlobSha = null,
  issueNumber,
  issueTitle,
  commentId,
  commentUrl,
  commandCreatedAt,
  approvedBy,
  authorAssociation,
  releaseControlCommandRegistered,
  requiredMainCiRunId,
  requiredCandidateCiRunId = null,
}) {
  if (issueNumber !== 23 || issueTitle !== 'Staging Readiness Control') {
    fail('SUCCESSOR_AUTHORITY_WRONG_RELEASE_CONTROL_ISSUE');
  }
  if (approvedBy !== 'seungjae3908-source' || authorAssociation !== 'OWNER') {
    fail('SUCCESSOR_AUTHORITY_OWNER_REQUIRED');
  }
  if (releaseControlCommandRegistered !== true) {
    fail('SUCCESSOR_AUTHORITY_COMMAND_SURFACE_NOT_REGISTERED');
  }
  assertHex(currentMainSha, 40, 'SUCCESSOR_AUTHORITY_MAIN_SHA_INVALID');
  assertEqual(command.currentMainSha, currentMainSha, 'SUCCESSOR_AUTHORITY_MAIN_SHA_MISMATCH');
  assertEqual(command.cohortDigest, frozenContract.cohortDigest, 'SUCCESSOR_AUTHORITY_COHORT_DIGEST_MISMATCH');

  if (!Number.isSafeInteger(Number(commentId)) || Number(commentId) <= 0) {
    fail('SUCCESSOR_AUTHORITY_COMMENT_ID_INVALID');
  }
  if (!String(commentUrl ?? '').includes('/issues/23#issuecomment-')) {
    fail('SUCCESSOR_AUTHORITY_COMMENT_URL_INVALID');
  }
  if (!Number.isFinite(Date.parse(String(commandCreatedAt ?? '')))) {
    fail('SUCCESSOR_AUTHORITY_TIMESTAMP_INVALID');
  }
  if (!Number.isSafeInteger(Number(requiredMainCiRunId)) || Number(requiredMainCiRunId) <= 0) {
    fail('SUCCESSOR_AUTHORITY_MAIN_CI_RUN_INVALID');
  }

  const common = {
    schemaVersion: 'public-forward-liquidity-successor-schedule-activation-authority-evidence-v1',
    authorityIdentity: SUCCESSOR_SCHEDULE_ACTIVATION_AUTHORITY_ID,
    action: command.action,
    authorityStatus: command.action === 'AUTHORIZE' ? 'HUMAN_AUTHORITY_FROZEN' : 'HUMAN_AUTHORITY_REVOKED',
    repository: 'seungjae3908-source/seungjae20260713',
    releaseControlIssue: 23,
    releaseControlIssueTitle: 'Staging Readiness Control',
    canonicalHubIssue: 838,
    approvalCommentId: Number(commentId),
    approvalCommentUrl: commentUrl,
    approvalCreatedAt: commandCreatedAt,
    approvedBy,
    authorAssociation,
    authorizedBaselineMainSha: currentMainSha,
    exactMainRequiredCiRunId: Number(requiredMainCiRunId),
    activeCohortContractVersion: frozenContract.activeCohortContractVersion,
    activeOosContractVersion: frozenContract.activeOosContractVersion,
    cohortId: frozenContract.cohortId,
    cohortPolicyDigest: frozenContract.policyDigest,
    cohortDigest: frozenContract.cohortDigest,
    firstEligibleMs: frozenContract.firstEligibleMs,
    endExclusiveMs: frozenContract.endExclusiveMs,
    cron: frozenContract.cron,
    totalSlotN: frozenContract.totalSlotN,
    splits: frozenContract.splits,
    allowedStartDelayMs: frozenContract.allowedStartDelayMs,
    allowedCompletionDelayMs: frozenContract.allowedCompletionDelayMs,
    collectorImplementationBlobSha: frozenContract.collectorImplementationBlobSha,
    captureParameterPolicyDigest: frozenContract.captureParameterPolicyDigest,
    outcomeHorizonMs: frozenContract.outcomeHorizonMs,
    outcomeSelectionPolicy: frozenContract.outcomeSelectionPolicy,
    oldV3OutcomeHorizonAuthorityInherited: false,
    noHindsight: true,
    manualCredit: 0,
    replayCredit: 0,
    backfillCredit: 0,
    syntheticCredit: 0,
    mergeAuthorized: false,
    scheduleMutationApplied: false,
    scheduleActivated: false,
    capturePerformed: false,
    prospectiveSlotCredit: 0,
    productionDeployAuthorized: false,
    stagingDeployAuthorized: false,
    dbSecretEnvServerMutationAuthorized: false,
    privateTradingApiAllowed: false,
    liveTradingAllowed: false,
    autoTradingAllowed: false,
    realOrderAllowed: false,
    executionAuthority: 'NONE',
    previousCreditedSamplesImmutable: true,
    creditOutsideCohort: 0,
    replayBackfillAfterRevocation: 0,
    finalPreActivationAuditRequired: true,
  };

  if (command.action === 'AUTHORIZE') {
    assertEqual(command.policyDigest, frozenContract.policyDigest, 'SUCCESSOR_AUTHORITY_POLICY_DIGEST_MISMATCH');
    assertHex(workflowCandidateHeadSha, 40, 'SUCCESSOR_AUTHORITY_CANDIDATE_HEAD_INVALID');
    assertHex(workflowBlobSha, 40, 'SUCCESSOR_AUTHORITY_WORKFLOW_BLOB_INVALID');
    assertEqual(
      command.workflowCandidateHeadSha,
      workflowCandidateHeadSha,
      'SUCCESSOR_AUTHORITY_CANDIDATE_HEAD_MISMATCH',
    );
    if (!Number.isSafeInteger(Number(requiredCandidateCiRunId)) || Number(requiredCandidateCiRunId) <= 0) {
      fail('SUCCESSOR_AUTHORITY_CANDIDATE_CI_RUN_INVALID');
    }
    Object.assign(common, {
      authorizedWorkflowPrNumber: SUCCESSOR_SCHEDULE_ACTIVATION_WORKFLOW.prNumber,
      authorizedWorkflowName: SUCCESSOR_SCHEDULE_ACTIVATION_WORKFLOW.name,
      authorizedWorkflowPath: SUCCESSOR_SCHEDULE_ACTIVATION_WORKFLOW.path,
      authorizedWorkflowCandidateHeadSha: workflowCandidateHeadSha,
      authorizedWorkflowBlobSha: workflowBlobSha,
      exactCandidateRequiredCiRunId: Number(requiredCandidateCiRunId),
      authorizedTransition: Object.freeze({
        type: 'MERGE_EXACT_PR_871_CANDIDATE_ONTO_EXACT_BASE_MAIN_ONLY',
        prNumber: SUCCESSOR_SCHEDULE_ACTIVATION_WORKFLOW.prNumber,
        baseMainSha: currentMainSha,
        candidateHeadSha: workflowCandidateHeadSha,
      }),
      currentMainMustRemainExactUntilAuthorizedMerge: true,
      authorityStaleOnUnexpectedMainMoveBeforeMerge: true,
      authorityConsumedByExactAuthorizedMerge: true,
      technicalActivationAuthorizedByReceipt: false,
      actualMergeApprovalStillRequired: true,
      downstreamCompatibilityStillSeparatelyRequired: true,
    });
  } else if (command.action === 'REVOKE') {
    Object.assign(common, {
      technicalActivationAuthorizedByReceipt: false,
      authorityRevoked: true,
      emergencyTechnicalStopApplied: false,
      emergencyTechnicalStopRequiresSeparateMutation: true,
      newProspectiveCreditAfterRevocation: 0,
    });
  } else {
    fail('SUCCESSOR_AUTHORITY_ACTION_INVALID');
  }

  const evidenceDigest = sha256(stableJson(common));
  return Object.freeze({ ...common, evidenceDigest });
}
