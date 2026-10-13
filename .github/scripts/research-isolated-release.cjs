'use strict';

// Reuse the same six-check + identical-tree proof used by the canonical release.
// This module cannot grant broker, shared-application or economic authority.
const {
  evaluatePostMergeStatusProvenance, evaluateReleaseCandidateProvenance,
  inspectPostMergeStatusEvidence, REQUIRED_PRODUCTION_STATUSES,
} = require('../../api-server/scripts/release-candidate-provenance.cjs');
const { inspectRequiredStatusEvidence } = require('../../api-server/scripts/production-ci-provenance.cjs');

const REPOSITORY = 'seungjae3908-source/seungjae20260713';
const OWNER = 'seungjae3908-source';
const WORKFLOW = '.github/workflows/research-isolated-release.yml';
const SHA_RE = /^[a-f0-9]{40}$/u;
const MUTATIONS = new Set([
  'production-deploy.yml', 'production-live-trading-gate.yml',
  'production-futures-live-trading-gate.yml', 'production-automatic-trading-gate.yml',
  'production-automatic-paper-only-gate.yml', 'telegram-production-code-only-deploy.yml',
  'research-production-activation.yml', 'research-ai-production-activation.yml',
  'research-market-watch-activation.yml', 'research-dashboard-activation.yml',
  'research-isolated-release.yml',
].map(name => '.github/workflows/' + name));
const BASE_CHECKS = Object.freeze([
  'CORE_CUTOVER_DEPENDENTS_INACTIVE', 'CORE_NODE_WEBSOCKET_RUNTIME',
  'NODE_ENV_PARSER', 'TOOL_GIT', 'TOOL_SYSTEMCTL', 'TOOL_SYSTEMD_ANALYZE', 'TOOL_RUNUSER',
  'APP_DEPLOY_SHA', 'CORE_DISK_AND_INODES', 'WATCH_RESOURCE_BUDGET',
  'RESEARCH_STATE_DIRECTORY', 'RESEARCH_STATE_OWNER', 'WATCH_INSTALLED_UNIT_COMPATIBLE',
  'RESEARCH_SAFE_ENV', 'CORE_CURRENT_RELEASE', 'PROVIDER_ONLY_ENV_SCOPE',
  'PROVIDER_YOUTUBE', 'PROVIDER_GEMINI', 'PROVIDER_GROQ', 'FREE_AI_POLICY', 'VIDEO_POLICY',
  'AI_POLICY_CONFIGURATION', 'VIDEO_POLICY_CONFIGURATION', 'SHARED_APP_AI_CONSENT_IDENTITY',
  'DASHBOARD_PYTHON_RUNTIME', 'DASHBOARD_CURRENT_RELEASE', 'APP_RESEARCH_BUNDLE_STORE_CONFIGURATION',
  'RESEARCH_ADAPTIVE_POLICY_RECORD_PATH', 'RESEARCH_DATA_FACTORY_EVIDENCE_PATH',
  'RESEARCH_ADAPTIVE_EVIDENCE_CATALOG_PATH', 'RESEARCH_ADAPTIVE_DEVELOPMENT_DIAGNOSTICS_PATH',
  'RESEARCH_ADAPTIVE_RUNTIME_BINDINGS_PATH', 'PAPER_FORWARD_SUPPLEMENTAL_COST_EVIDENCE_PATH',
  'STOCK_INPUT_KR_STOCK', 'STOCK_INPUT_US_STOCK', 'CURRENT_CYCLE_FORWARD',
  'CURRENT_CYCLE_FAST_HISTORICAL', 'CURRENT_CYCLE_LONG_HISTORY', 'FACTORY_FUNCTIONAL_EVIDENCE',
  'AI_REVIEW_FUNCTIONAL_EVIDENCE', 'VIDEO_DISCOVERY_FUNCTIONAL_EVIDENCE', 'PAPER_LOOP_FUNCTIONAL_EVIDENCE',
  ...['FAST_HISTORICAL_TIMER', 'LONG_HISTORY_TIMER', 'FORWARD_TIMER', 'TEMPORAL_EVIDENCE_TIMER',
    'FACTORY_STATUS_TIMER', 'MAINTENANCE_TIMER', 'AI_REVIEW_TIMER', 'VIDEO_DISCOVERY_TIMER',
    'APPROVED_JOB_INTAKE_TIMER', 'WORKSPACE_WORKER_SERVICE', 'MARKET_WATCH_SERVICE'].map(x => 'UNIT_' + x),
]);
const PREREQUISITE_CHECKS = new Set(BASE_CHECKS.filter(id =>
  /^(CORE_CUTOVER_|CORE_NODE_|NODE_ENV_PARSER|TOOL_|APP_DEPLOY_SHA|CORE_DISK_AND_INODES|WATCH_RESOURCE_BUDGET|RESEARCH_STATE_|WATCH_INSTALLED_UNIT_COMPATIBLE|RESEARCH_SAFE_ENV|PROVIDER_|AI_POLICY_CONFIGURATION|VIDEO_POLICY_CONFIGURATION|DASHBOARD_PYTHON_RUNTIME)/u.test(id)));
const ZERO_FIELDS = Object.freeze(['serverFilesWritten', 'processRestarts', 'databaseMutations',
  'policyMutations', 'providerCalls', 'providerPrivateRequests', 'orders']);
const fail = code => { throw new Error('RESEARCH_ISOLATED_' + code); };
const assert = (condition, code) => { if (!condition) fail(code); };
const positive = value => Number.isSafeInteger(Number(value)) && /^[1-9][0-9]*$/u.test(String(value));

function parseCommand(body) {
  const match = /^\/run-research-isolated ([a-f0-9]{40}) --audit$/u.exec(String(body ?? '').trim());
  assert(match, 'EXACT_READONLY_COMMAND_REQUIRED');
  return { targetSha: match[1], mode: 'audit' };
}

function assertOwnerContext(context, targetSha) {
  assert(`${context.repo?.owner}/${context.repo?.repo}` === REPOSITORY, 'REPOSITORY_REQUIRED');
  assert(context.eventName === 'issue_comment' && context.payload?.action === 'created'
    && context.payload?.issue?.number === 1102 && context.payload.issue.state === 'open'
    && !context.payload.issue.pull_request && context.payload.comment?.author_association === 'OWNER'
    && context.payload.comment.user?.login === OWNER && context.actor === OWNER,
  'OWNER_HUB_REQUIRED');
  assert(context.ref === 'refs/heads/main' && context.sha === targetSha, 'WORKFLOW_MAIN_REQUIRED');
}

function assertStatusOrigin(status, runId) {
  assert(positive(runId) && status?.target_url === `https://github.com/${REPOSITORY}/actions/runs/${runId}`,
    'STATUS_ORIGIN_INVALID');
}

function verifyReleaseProof(value) {
  const { targetSha, currentMainSha, targetTreeSha, pr, headTreeSha, statuses,
    run, postMergeStatuses, postMergeRun, newerRuns = [] } = value;
  const post = evaluatePostMergeStatusProvenance({ targetSha, currentMainSha,
    statuses: postMergeStatuses, run: postMergeRun });
  assert(post.ok, 'POSTMERGE_' + post.reason);
  assertStatusOrigin(inspectPostMergeStatusEvidence(postMergeStatuses).latest, post.runId);
  assert(pr?.merge_commit_sha === targetSha && pr?.base?.repo?.full_name === REPOSITORY
    && pr?.head?.repo?.full_name === REPOSITORY, 'MERGED_PR_BINDING_INVALID');
  const checked = evaluateReleaseCandidateProvenance({ targetSha, currentMainSha, targetTreeSha,
    pr, headTreeSha, statuses, run });
  assert(checked.ok, 'PREMERGE_' + checked.reason);
  const latest = inspectRequiredStatusEvidence(statuses).latest;
  for (const name of REQUIRED_PRODUCTION_STATUSES) assertStatusOrigin(latest.get(name), checked.runId);
  assert(!newerRuns.some(candidate => candidate.path === '.github/workflows/futures-public-network-smoke.yml'
    && candidate.head_sha === checked.headSha && Number(candidate.id) > checked.runId), 'NEWER_CI_REVALIDATION_REQUIRED');
  return { schemaVersion: 'research-isolated-code-provenance-v1', targetSha,
    targetTreeSha, testedHeadSha: checked.headSha, requiredCiRunId: checked.runId,
    postMergeRunId: post.runId, sourcePullRequest: checked.prNumber,
    proofMode: 'CANONICAL_PREMERGE_SIX_AND_IDENTICAL_MERGED_TREE', executionAuthority: 'NONE' };
}

function assertNoMutationConflict(runs, currentRunId) {
  assert(Array.isArray(runs) && runs.length <= 5000, 'CONFLICT_LOOKUP_INCOMPLETE');
  const conflicts = runs.filter(run => run.status !== 'completed' && run.event !== 'pull_request'
    && Number(run.id) !== Number(currentRunId) && MUTATIONS.has(run.path));
  assert(conflicts.length === 0, 'ACTIVE_MUTATION_CONFLICT');
}

async function authorize({ github, context, targetSha }) {
  assertOwnerContext(context, targetSha);
  const params = { owner: OWNER, repo: 'seungjae20260713' };
  const main = (await github.rest.repos.getBranch({ ...params, branch: 'main' })).data;
  assert(main.commit.sha === targetSha, 'CURRENT_MAIN_MOVED');
  const statuses = await github.paginate(github.rest.repos.listCommitStatusesForRef,
    { ...params, ref: targetSha, per_page: 100 });
  const post = inspectPostMergeStatusEvidence(statuses);
  assert(post.ok, 'POSTMERGE_' + post.reason);
  assertStatusOrigin(post.latest, post.runId);
  const postMergeRun = (await github.rest.actions.getWorkflowRun({ ...params, run_id: post.runId })).data;
  const target = (await github.rest.repos.getCommit({ ...params, ref: targetSha })).data;
  const related = await github.paginate(github.rest.repos.listPullRequestsAssociatedWithCommit,
    { ...params, commit_sha: targetSha, per_page: 100 });
  assert(related.length > 0 && related.length <= 50, 'MERGED_PR_LOOKUP_INVALID');
  const matching = [];
  for (const row of related) {
    const pr = (await github.rest.pulls.get({ ...params, pull_number: row.number })).data;
    if (pr.merged_at && pr.merge_commit_sha === targetSha && pr.base?.ref === 'main') matching.push(pr);
  }
  assert(matching.length === 1, 'MERGED_PR_AMBIGUOUS');
  const pr = matching[0];
  const head = (await github.rest.repos.getCommit({ ...params, ref: pr.head.sha })).data;
  const headStatuses = await github.paginate(github.rest.repos.listCommitStatusesForRef,
    { ...params, ref: pr.head.sha, per_page: 100 });
  const ci = inspectRequiredStatusEvidence(headStatuses);
  assert(ci.ok, 'SIX_CHECKS_' + ci.reason);
  const run = (await github.rest.actions.getWorkflowRun({ ...params, run_id: ci.runId })).data;
  const newerRuns = await github.paginate(github.rest.actions.listWorkflowRunsForRepo,
    { ...params, head_sha: pr.head.sha, per_page: 100 });
  const proof = verifyReleaseProof({ targetSha, currentMainSha: main.commit.sha,
    targetTreeSha: target.commit.tree.sha, pr, headTreeSha: head.commit.tree.sha,
    statuses: headStatuses, run, postMergeStatuses: statuses, postMergeRun, newerRuns });
  const active = [];
  for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
    const rows = await github.paginate(github.rest.actions.listWorkflowRunsForRepo,
      { ...params, status, per_page: 100 });
    assert(rows.length <= 1000, 'CONFLICT_LOOKUP_INCOMPLETE');
    active.push(...rows);
  }
  assertNoMutationConflict(active, context.runId);
  const after = (await github.rest.repos.getBranch({ ...params, branch: 'main' })).data;
  assert(after.commit.sha === targetSha, 'CURRENT_MAIN_MOVED');
  return proof;
}

function verifyAudit(audit, { targetSha, appSha, nowMs = Date.now(), requireReady = false } = {}) {
  assert(SHA_RE.test(targetSha ?? '') && SHA_RE.test(appSha ?? ''), 'AUDIT_IDENTITY_INVALID');
  assert(audit?.schemaVersion === 'research-activation-preflight-v1'
    && audit.researchSha === targetSha && audit.appSha === appSha, 'AUDIT_IDENTITY_MISMATCH');
  const observed = Date.parse(audit.observedAt);
  assert(Number.isFinite(nowMs) && Number.isFinite(observed) && observed <= nowMs + 5000
    && nowMs - observed <= 30 * 60_000, 'AUDIT_STALE');
  assert(Array.isArray(audit.checks) && audit.checks.length <= 128, 'AUDIT_CHECKS_INVALID');
  const ids = new Set(audit.checks.map(row => row.id));
  assert(ids.size === audit.checks.length && BASE_CHECKS.every(id => ids.has(id)), 'AUDIT_COVERAGE_MISSING');
  assert(audit.checks.every(row => /^[A-Z][A-Z0-9_]{1,100}$/u.test(row.id)
    && ['prerequisite', 'postactivation', 'functionality'].includes(row.phase)
    && ['PASS', 'BLOCKED', 'MISSING', 'INVALID', 'PENDING', 'UNKNOWN'].includes(row.status)), 'AUDIT_CHECK_INVALID');
  assert(audit.checks.every(row => !BASE_CHECKS.includes(row.id)
    || (row.phase === 'prerequisite') === PREREQUISITE_CHECKS.has(row.id)), 'AUDIT_PHASE_TAMPERED');
  assert(audit.executionAuthority === 'NONE' && audit.credentialsExposed === false
    && audit.fullyFunctional === false && audit.closedLoopProven === false && audit.profitabilityProven === false
    && ZERO_FIELDS.every(field => audit[field] === 0), 'AUDIT_AUTHORITY_INVALID');
  const blockers = audit.checks.filter(row => row.phase === 'prerequisite' && row.status !== 'PASS').map(row => row.id);
  const remaining = audit.checks.filter(row => row.phase !== 'prerequisite' && row.status !== 'PASS').map(row => row.id);
  assert(JSON.stringify(blockers) === JSON.stringify(audit.prerequisiteBlockers)
    && JSON.stringify(remaining) === JSON.stringify(audit.remainingChecks)
    && audit.prerequisitesReady === (blockers.length === 0), 'AUDIT_FALSE_PASS');
  if (requireReady) assert(blockers.length === 0, 'AUDIT_PREREQUISITES_BLOCKED');
  return { blockers, remaining, prerequisitesReady: blockers.length === 0,
    fullyFunctional: false, executionAuthority: 'NONE' };
}

function buildAuditEnvelope({ audit, proof, runId, nowMs = Date.now() }) {
  assert(positive(runId) && proof?.targetSha === audit?.researchSha, 'ENVELOPE_IDENTITY_INVALID');
  const result = verifyAudit(audit, { targetSha: proof.targetSha, appSha: audit.appSha, nowMs });
  return { schemaVersion: 'research-isolated-audit-envelope-v1', runId: Number(runId),
    targetSha: proof.targetSha, appSha: audit.appSha, proof, audit,
    prerequisiteBlockers: result.blockers, remainingChecks: result.remaining,
    coreUpdatePrerequisitesObserved: result.prerequisitesReady, fullyFunctional: false,
    appUiDeployed: false, sharedAppMutation: false, manualLivePolicyChanged: false,
    executionAuthority: 'NONE', realOrders: 0 };
}

module.exports = { REPOSITORY, OWNER, WORKFLOW, BASE_CHECKS, ZERO_FIELDS, parseCommand,
  assertOwnerContext, verifyReleaseProof, authorize, assertNoMutationConflict,
  verifyAudit, buildAuditEnvelope };
