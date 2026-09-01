import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  SUCCESSOR_SCHEDULE_ACTIVATION_AUTHORITY_ID,
  SUCCESSOR_SCHEDULE_ACTIVATION_WORKFLOW,
  SUCCESSOR_SCHEDULE_AUTHORITY_COMMANDS,
  assertReleaseControlCommandSurfaceRegistered,
  buildSuccessorScheduleAuthorityEvidence,
  loadFrozenSuccessorAuthorityContract,
  parseSuccessorScheduleAuthorityCommand,
} from '../src/public-forward-liquidity-successor-schedule-activation-authority-v1.mjs';

const MAIN_SHA = '4715f33719238d764a3314eab952720663f2d296';
const CANDIDATE_SHA = '6c6ae7065dd401619e2d09e69a5b3b90d39ccab0';
const WORKFLOW_BLOB_SHA = '1234567890abcdef1234567890abcdef12345678';
const FROZEN = loadFrozenSuccessorAuthorityContract();
const POLICY_DIGEST = FROZEN.policyDigest;
const COHORT_DIGEST = FROZEN.cohortDigest;

function authorizeCommand(overrides = {}) {
  return {
    action: 'AUTHORIZE',
    currentMainSha: MAIN_SHA,
    workflowCandidateHeadSha: CANDIDATE_SHA,
    policyDigest: POLICY_DIGEST,
    cohortDigest: COHORT_DIGEST,
    rawCommand: `/authorize-successor-prospective-schedule-activation ${MAIN_SHA} ${CANDIDATE_SHA} ${POLICY_DIGEST} ${COHORT_DIGEST}`,
    ...overrides,
  };
}

function evidenceInput(overrides = {}) {
  return {
    command: authorizeCommand(),
    frozenContract: FROZEN,
    currentMainSha: MAIN_SHA,
    workflowCandidateHeadSha: CANDIDATE_SHA,
    workflowBlobSha: WORKFLOW_BLOB_SHA,
    issueNumber: 23,
    issueTitle: 'Staging Readiness Control',
    commentId: 5500000001,
    commentUrl:
      'https://github.com/seungjae3908-source/seungjae20260713/issues/23#issuecomment-5500000001',
    commandCreatedAt: '2026-09-02T00:00:00Z',
    approvedBy: 'seungjae3908-source',
    authorAssociation: 'OWNER',
    releaseControlCommandRegistered: true,
    requiredMainCiRunId: 33561984470,
    requiredCandidateCiRunId: 33560355348,
    ...overrides,
  };
}

test('A01 authority consumes the active verified Successor cohort plus exact 5000ms OOS policy', () => {
  assert.equal(FROZEN.authorityIdentity, SUCCESSOR_SCHEDULE_ACTIVATION_AUTHORITY_ID);
  assert.match(FROZEN.policyDigest, /^[0-9a-f]{64}$/);
  assert.match(FROZEN.cohortDigest, /^[0-9a-f]{64}$/);
  assert.equal(FROZEN.cron, '17 * * * *');
  assert.ok(FROZEN.totalSlotN > 0);
  assert.equal(FROZEN.splits.TRAIN[0], 0);
  assert.equal(FROZEN.splits.TRAIN[1] + 1, FROZEN.splits.VALIDATION[0]);
  assert.equal(FROZEN.splits.VALIDATION[1] + 1, FROZEN.splits.OOS[0]);
  assert.equal(FROZEN.splits.OOS[1], FROZEN.totalSlotN - 1);
  assert.equal(
    FROZEN.splits.TRAIN[2] + FROZEN.splits.VALIDATION[2] + FROZEN.splits.OOS[2],
    FROZEN.totalSlotN,
  );
  assert.equal(FROZEN.allowedStartDelayMs, 1_200_000);
  assert.equal(FROZEN.allowedCompletionDelayMs, 600_000);
  assert.equal(FROZEN.outcomeHorizonMs, 5_000);
  assert.equal(FROZEN.outcomeSelectionPolicy, 'FIRST_PUBLIC_OBSERVATION_AT_OR_AFTER_HORIZON');
  assert.equal(FROZEN.oldV3OutcomeHorizonAuthorityInherited, false);
});

test('A02 exact authorize command is strict and normalized', () => {
  const parsed = parseSuccessorScheduleAuthorityCommand(
    `/authorize-successor-prospective-schedule-activation ${MAIN_SHA.toUpperCase()} ${CANDIDATE_SHA.toUpperCase()} ${POLICY_DIGEST.toUpperCase()} ${COHORT_DIGEST.toUpperCase()}`,
  );
  assert.equal(parsed.action, 'AUTHORIZE');
  assert.equal(parsed.currentMainSha, MAIN_SHA);
  assert.equal(parsed.workflowCandidateHeadSha, CANDIDATE_SHA);
  assert.equal(parsed.policyDigest, POLICY_DIGEST);
  assert.equal(parsed.cohortDigest, COHORT_DIGEST);
});

test('A03 exact revoke command is strict and normalized', () => {
  const parsed = parseSuccessorScheduleAuthorityCommand(
    `/revoke-successor-prospective-schedule-activation ${MAIN_SHA.toUpperCase()} ${COHORT_DIGEST.toUpperCase()}`,
  );
  assert.equal(parsed.action, 'REVOKE');
  assert.equal(parsed.currentMainSha, MAIN_SHA);
  assert.equal(parsed.cohortDigest, COHORT_DIGEST);
});

test('A04 malformed, appended, or policy-free authorize commands fail closed', () => {
  assert.throws(
    () => parseSuccessorScheduleAuthorityCommand('/authorize-successor-prospective-schedule-activation'),
    /INVALID_SUCCESSOR_SCHEDULE_AUTHORITY_COMMAND/,
  );
  assert.throws(
    () =>
      parseSuccessorScheduleAuthorityCommand(
        `/authorize-successor-prospective-schedule-activation ${MAIN_SHA} ${CANDIDATE_SHA} ${POLICY_DIGEST} ${COHORT_DIGEST} extra`,
      ),
    /INVALID_SUCCESSOR_SCHEDULE_AUTHORITY_COMMAND/,
  );
});

test('A05 #23 body registration is a mandatory precondition', () => {
  const body = [SUCCESSOR_SCHEDULE_AUTHORITY_COMMANDS.authorize, SUCCESSOR_SCHEDULE_AUTHORITY_COMMANDS.revoke].join(
    '\n',
  );
  assert.equal(assertReleaseControlCommandSurfaceRegistered(body), true);
  assert.throws(
    () => assertReleaseControlCommandSurfaceRegistered(SUCCESSOR_SCHEDULE_AUTHORITY_COMMANDS.authorize),
    /SUCCESSOR_REVOKE_COMMAND_NOT_REGISTERED_ON_RELEASE_CONTROL/,
  );
  assert.throws(
    () => assertReleaseControlCommandSurfaceRegistered(''),
    /SUCCESSOR_AUTHORIZE_COMMAND_NOT_REGISTERED_ON_RELEASE_CONTROL/,
  );
});

test('A06 authorization evidence freezes human authority but never merges, activates, captures, or grants credit', () => {
  const evidence = buildSuccessorScheduleAuthorityEvidence(evidenceInput());
  assert.equal(evidence.action, 'AUTHORIZE');
  assert.equal(evidence.authorityStatus, 'HUMAN_AUTHORITY_FROZEN');
  assert.equal(evidence.authorizedBaselineMainSha, MAIN_SHA);
  assert.equal(evidence.authorizedWorkflowPrNumber, 871);
  assert.equal(evidence.authorizedWorkflowName, SUCCESSOR_SCHEDULE_ACTIVATION_WORKFLOW.name);
  assert.equal(evidence.authorizedWorkflowPath, SUCCESSOR_SCHEDULE_ACTIVATION_WORKFLOW.path);
  assert.equal(evidence.authorizedWorkflowCandidateHeadSha, CANDIDATE_SHA);
  assert.equal(evidence.authorizedWorkflowBlobSha, WORKFLOW_BLOB_SHA);
  assert.equal(evidence.activeCohortContractVersion, FROZEN.activeCohortContractVersion);
  assert.equal(evidence.activeOosContractVersion, FROZEN.activeOosContractVersion);
  assert.equal(evidence.cohortPolicyDigest, POLICY_DIGEST);
  assert.equal(evidence.cohortDigest, COHORT_DIGEST);
  assert.equal(evidence.totalSlotN, FROZEN.totalSlotN);
  assert.equal(evidence.mergeAuthorized, false);
  assert.equal(evidence.scheduleMutationApplied, false);
  assert.equal(evidence.scheduleActivated, false);
  assert.equal(evidence.capturePerformed, false);
  assert.equal(evidence.prospectiveSlotCredit, 0);
  assert.equal(evidence.technicalActivationAuthorizedByReceipt, false);
  assert.equal(evidence.executionAuthority, 'NONE');
  assert.equal(evidence.currentMainMustRemainExactForActivationEligibility, true);
  assert.equal(evidence.authorityBecomesStaleOnMainMove, true);
  assert.match(evidence.evidenceDigest, /^[0-9a-f]{64}$/);
});

test('A07 wrong owner, main, cohort, policy, candidate or command registration fails closed', () => {
  assert.throws(
    () => buildSuccessorScheduleAuthorityEvidence(evidenceInput({ approvedBy: 'someone-else' })),
    /SUCCESSOR_AUTHORITY_OWNER_REQUIRED/,
  );
  assert.throws(
    () => buildSuccessorScheduleAuthorityEvidence(evidenceInput({ currentMainSha: '0'.repeat(40) })),
    /SUCCESSOR_AUTHORITY_MAIN_SHA_MISMATCH/,
  );
  assert.throws(
    () =>
      buildSuccessorScheduleAuthorityEvidence(
        evidenceInput({ command: authorizeCommand({ cohortDigest: '0'.repeat(64) }) }),
      ),
    /SUCCESSOR_AUTHORITY_COHORT_DIGEST_MISMATCH/,
  );
  assert.throws(
    () =>
      buildSuccessorScheduleAuthorityEvidence(
        evidenceInput({ command: authorizeCommand({ policyDigest: '0'.repeat(64) }) }),
      ),
    /SUCCESSOR_AUTHORITY_POLICY_DIGEST_MISMATCH/,
  );
  assert.throws(
    () => buildSuccessorScheduleAuthorityEvidence(evidenceInput({ workflowCandidateHeadSha: '0'.repeat(40) })),
    /SUCCESSOR_AUTHORITY_CANDIDATE_HEAD_MISMATCH/,
  );
  assert.throws(
    () => buildSuccessorScheduleAuthorityEvidence(evidenceInput({ releaseControlCommandRegistered: false })),
    /SUCCESSOR_AUTHORITY_COMMAND_SURFACE_NOT_REGISTERED/,
  );
});

test('A08 revocation evidence is append-only authority revocation semantics, not a technical stop mutation', () => {
  const command = parseSuccessorScheduleAuthorityCommand(
    `/revoke-successor-prospective-schedule-activation ${MAIN_SHA} ${COHORT_DIGEST}`,
  );
  const evidence = buildSuccessorScheduleAuthorityEvidence(
    evidenceInput({
      command,
      workflowCandidateHeadSha: null,
      workflowBlobSha: null,
      requiredCandidateCiRunId: null,
    }),
  );
  assert.equal(evidence.authorityStatus, 'HUMAN_AUTHORITY_REVOKED');
  assert.equal(evidence.authorityRevoked, true);
  assert.equal(evidence.emergencyTechnicalStopApplied, false);
  assert.equal(evidence.emergencyTechnicalStopRequiresSeparateMutation, true);
  assert.equal(evidence.newProspectiveCreditAfterRevocation, 0);
  assert.equal(evidence.replayBackfillAfterRevocation, 0);
  assert.equal(evidence.executionAuthority, 'NONE');
});

test('A09 authority workflow is issue-comment evidence only and tracks active Successor contract files', () => {
  const workflow = readFileSync(
    new URL('../../.github/workflows/public-forward-liquidity-successor-schedule-activation-authority.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /issue_comment:\s*\n\s*types: \[created\]/);
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /public-forward-liquidity-successor-prospective-cohort\.mjs/);
  assert.match(workflow, /public-forward-liquidity-successor-oos-outcome-horizon\.mjs/);
  assert.doesNotMatch(workflow, /^\s*schedule:/m);
  assert.doesNotMatch(workflow, /^\s*workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^\s*repository_dispatch:/m);
  assert.doesNotMatch(workflow, /contents:\s*write/);
  assert.doesNotMatch(workflow, /actions:\s*write/);
  assert.doesNotMatch(workflow, /pull-requests:\s*write/);
  assert.doesNotMatch(workflow, /deployments:\s*write/);
  assert.doesNotMatch(workflow, /id-token:\s*write/);
  assert.doesNotMatch(
    workflow,
    /^\s*(?:pm2\s+(?:start|restart|reload)|systemctl\s+(?:enable|start|restart)|ssh\s+)/im,
  );
  assert.match(workflow, /SUCCESSOR_AUTHORIZE_COMMAND_NOT_REGISTERED_ON_RELEASE_CONTROL/);
  assert.match(workflow, /authorityBecomesStaleOnMainMove/);
});
