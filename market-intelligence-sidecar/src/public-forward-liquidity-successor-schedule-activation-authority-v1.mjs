import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

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

const EXPECTED = Object.freeze({
  cohortId:
    'PUBLIC_FORWARD_LIQUIDITY_SUCCESSOR_PROSPECTIVE_COHORT_V1_20260903:451b880a7efff4c3cbb8abe8bcda07bbf54a534f9f01baeb040547c339fa489a',
  policyDigest: '451b880a7efff4c3cbb8abe8bcda07bbf54a534f9f01baeb040547c339fa489a',
  cohortDigest: '7c24f0f752c500bc7ea90df5e7975319a5c4813a23f8f0e375a1ffd0b99672bb',
  startInclusiveMs: 1788362220000,
  endExclusiveMs: 1789571820000,
  totalSlotN: 336,
  allowedStartDelayMs: 1200000,
  allowedCompletionDelayMs: 600000,
  train: [0, 167, 168],
  validation: [168, 251, 84],
  oos: [252, 335, 84],
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

export function validateFrozenSuccessorAuthorityInputs({ cohortContract, oosContract }) {
  const cohort = cohortContract;
  const oos = oosContract;
  if (!cohort?.policyCore || !oos?.policyCore) fail('SUCCESSOR_FROZEN_CONTRACT_MISSING');

  assertEqual(cohort.cohortId, EXPECTED.cohortId, 'SUCCESSOR_COHORT_ID_DRIFT');
  assertEqual(cohort.policyDigest, EXPECTED.policyDigest, 'SUCCESSOR_POLICY_DIGEST_DRIFT');
  assertEqual(cohort.cohortDigest, EXPECTED.cohortDigest, 'SUCCESSOR_COHORT_DIGEST_DRIFT');
  assertEqual(cohort.policyCore.cohort.cronUtc, SUCCESSOR_SCHEDULE_ACTIVATION_WORKFLOW.cron, 'SUCCESSOR_CRON_DRIFT');
  assertEqual(cohort.policyCore.cohort.startInclusiveMs, EXPECTED.startInclusiveMs, 'SUCCESSOR_START_DRIFT');
  assertEqual(cohort.policyCore.cohort.endExclusiveMs, EXPECTED.endExclusiveMs, 'SUCCESSOR_END_DRIFT');
  assertEqual(cohort.policyCore.cohort.totalSlotN, EXPECTED.totalSlotN, 'SUCCESSOR_SLOT_COUNT_DRIFT');
  assertEqual(
    cohort.policyCore.cohort.allowedStartDelayMs,
    EXPECTED.allowedStartDelayMs,
    'SUCCESSOR_START_DELAY_DRIFT',
  );
  assertEqual(
    cohort.policyCore.cohort.allowedCompletionDelayMs,
    EXPECTED.allowedCompletionDelayMs,
    'SUCCESSOR_COMPLETION_DELAY_DRIFT',
  );

  for (const [name, expected] of [
    ['TRAIN', EXPECTED.train],
    ['VALIDATION', EXPECTED.validation],
    ['OOS', EXPECTED.oos],
  ]) {
    const split = cohort.policyCore.splits[name];
    assertEqual(split?.startIndexInclusive, expected[0], `SUCCESSOR_${name}_START_DRIFT`);
    assertEqual(split?.endIndexInclusive, expected[1], `SUCCESSOR_${name}_END_DRIFT`);
    assertEqual(split?.expectedSlotN, expected[2], `SUCCESSOR_${name}_COUNT_DRIFT`);
  }

  assertEqual(
    cohort.policyCore.technicalIdentity.collectorImplementationBlobSha,
    EXPECTED.collectorImplementationBlobSha,
    'SUCCESSOR_COLLECTOR_BLOB_DRIFT',
  );
  assertEqual(
    cohort.policyCore.technicalIdentity.captureParameterPolicyDigest,
    EXPECTED.captureParameterPolicyDigest,
    'SUCCESSOR_CAPTURE_PARAMETER_DIGEST_DRIFT',
  );
  assertEqual(
    cohort.policyCore.creditPolicy.manualCredit,
    0,
    'SUCCESSOR_MANUAL_CREDIT_NOT_ZERO',
  );
  assertEqual(
    cohort.policyCore.creditPolicy.replayCredit,
    0,
    'SUCCESSOR_REPLAY_CREDIT_NOT_ZERO',
  );
  assertEqual(
    cohort.policyCore.creditPolicy.backfillCredit,
    0,
    'SUCCESSOR_BACKFILL_CREDIT_NOT_ZERO',
  );
  assertEqual(
    cohort.policyCore.creditPolicy.syntheticCredit,
    0,
    'SUCCESSOR_SYNTHETIC_CREDIT_NOT_ZERO',
  );

  assertEqual(
    oos.policyCore.successorCohortBinding.cohortDigest,
    EXPECTED.cohortDigest,
    'SUCCESSOR_OOS_COHORT_DIGEST_DRIFT',
  );
  assertEqual(
    oos.policyCore.outcomePolicy.outcomeHorizonMs,
    EXPECTED.outcomeHorizonMs,
    'SUCCESSOR_OOS_HORIZON_DRIFT',
  );
  assertEqual(
    oos.policyCore.outcomePolicy.outcomeSelectionPolicy,
    EXPECTED.outcomeSelectionPolicy,
    'SUCCESSOR_OOS_SELECTION_DRIFT',
  );
  assertEqual(
    oos.policyCore.prospectiveIntegrity.oldV3OutcomeHorizonAuthorityInherited,
    false,
    'SUCCESSOR_OLD_V3_OOS_INHERITANCE_NOT_FALSE',
  );

  return Object.freeze({
    authorityIdentity: SUCCESSOR_SCHEDULE_ACTIVATION_AUTHORITY_ID,
    cohortId: EXPECTED.cohortId,
    policyDigest: EXPECTED.policyDigest,
    cohortDigest: EXPECTED.cohortDigest,
    firstEligibleMs: EXPECTED.startInclusiveMs,
    endExclusiveMs: EXPECTED.endExclusiveMs,
    cron: SUCCESSOR_SCHEDULE_ACTIVATION_WORKFLOW.cron,
    totalSlotN: EXPECTED.totalSlotN,
    splits: Object.freeze({ TRAIN: EXPECTED.train, VALIDATION: EXPECTED.validation, OOS: EXPECTED.oos }),
    allowedStartDelayMs: EXPECTED.allowedStartDelayMs,
    allowedCompletionDelayMs: EXPECTED.allowedCompletionDelayMs,
    collectorImplementationBlobSha: EXPECTED.collectorImplementationBlobSha,
    captureParameterPolicyDigest: EXPECTED.captureParameterPolicyDigest,
    outcomeHorizonMs: EXPECTED.outcomeHorizonMs,
    outcomeSelectionPolicy: EXPECTED.outcomeSelectionPolicy,
    oldV3OutcomeHorizonAuthorityInherited: false,
  });
}

export function loadFrozenSuccessorAuthorityContract() {
  const cohortContract = JSON.parse(
    readFileSync(
      new URL('../config/public-forward-liquidity-successor-prospective-cohort-v1.json', import.meta.url),
      'utf8',
    ),
  );
  const oosContract = JSON.parse(
    readFileSync(
      new URL('../config/public-forward-liquidity-successor-oos-outcome-horizon-v1.json', import.meta.url),
      'utf8',
    ),
  );
  return validateFrozenSuccessorAuthorityInputs({ cohortContract, oosContract });
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
  if (!String(commandCreatedAt ?? '').trim()) fail('SUCCESSOR_AUTHORITY_TIMESTAMP_MISSING');
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
    currentMainMustRemainExactForActivationEligibility: true,
    authorityBecomesStaleOnMainMove: true,
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
