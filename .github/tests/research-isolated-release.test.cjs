'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  REPOSITORY, OWNER, WORKFLOW, BASE_CHECKS, ZERO_FIELDS, parseCommand, assertOwnerContext,
  verifyReleaseProof, authorize, assertNoMutationConflict, verifyAudit, buildAuditEnvelope,
} = require('../scripts/research-isolated-release.cjs');
const { REQUIRED_PRODUCTION_STATUSES } = require('../../api-server/scripts/production-ci-provenance.cjs');
const root = path.resolve(__dirname, '../..');
const sha = 'a'.repeat(40), head = 'b'.repeat(40), tree = 'c'.repeat(40), app = 'd'.repeat(40);
const now = Date.parse('2026-10-13T03:00:00Z');
const url = id => `https://github.com/${REPOSITORY}/actions/runs/${id}`;
const context = () => ({ repo: { owner: OWNER, repo: 'seungjae20260713' }, actor: OWNER,
  eventName: 'issue_comment', ref: 'refs/heads/main', sha, runId: 30,
  payload: { action: 'created', issue: { number: 1102, state: 'open' },
    comment: { author_association: 'OWNER', user: { login: OWNER } } } });
function proof() {
  return { targetSha: sha, currentMainSha: sha, targetTreeSha: tree, headTreeSha: tree,
    pr: { number: 1900, merge_commit_sha: sha, merged_at: '2026-10-13T02:00:00Z',
      base: { ref: 'main', repo: { full_name: REPOSITORY } },
      head: { sha: head, ref: 'drift/research', repo: { full_name: REPOSITORY } } },
    statuses: REQUIRED_PRODUCTION_STATUSES.map((context, i) => ({ id: i + 1, context,
      state: 'success', target_url: url(10), created_at: '2026-10-13T01:50:00Z' })),
    run: { id: 10, name: 'Application CI', path: '.github/workflows/futures-public-network-smoke.yml',
      head_sha: head, head_branch: 'drift/research', event: 'workflow_dispatch',
      status: 'completed', conclusion: 'success', updated_at: '2026-10-13T01:59:00Z' },
    postMergeStatuses: [{ id: 11, context: 'post-merge-provenance/verified', state: 'success', target_url: url(20) }],
    postMergeRun: { id: 20, name: 'Post-Merge Release Provenance',
      path: '.github/workflows/post-merge-release-provenance.yml', head_sha: sha,
      head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success' } };
}
function audit() {
  const prerequisites = /^(CORE_CUTOVER_|CORE_NODE_|NODE_ENV_PARSER|TOOL_|APP_DEPLOY_SHA|CORE_DISK_AND_INODES|WATCH_RESOURCE_BUDGET|RESEARCH_STATE_|WATCH_INSTALLED_UNIT_COMPATIBLE|RESEARCH_SAFE_ENV|PROVIDER_|AI_POLICY_CONFIGURATION|VIDEO_POLICY_CONFIGURATION|DASHBOARD_PYTHON_RUNTIME)/u;
  return { schemaVersion: 'research-activation-preflight-v1', researchSha: sha, appSha: app,
    observedAt: new Date(now).toISOString(), checks: BASE_CHECKS.map(id => ({ id,
      phase: prerequisites.test(id) ? 'prerequisite' : 'functionality', status: 'PASS' })),
    prerequisiteBlockers: [], remainingChecks: [], prerequisitesReady: true,
    fullyFunctional: false, closedLoopProven: false, profitabilityProven: false,
    credentialsExposed: false, executionAuthority: 'NONE', ...Object.fromEntries(ZERO_FIELDS.map(x => [x, 0])) };
}
const auditOptions = () => ({ targetSha: sha, appSha: app, nowMs: now });

test('exact Hub command grants read-only audit only, never activation consent', () => {
  assert.deepEqual(parseCommand(`/run-research-isolated ${sha} --audit`), {targetSha:sha,mode:'audit'});
  assert.throws(()=>parseCommand(`/run-research-isolated ${sha} --activate-core --audit-run=25 --staging-run=26`));
});
for (const suffix of ['--activate-core', '--audit --deploy', '--audit\nrm -rf /', '--audit --audit',
  '--activate-core --audit-run=0 --staging-run=1', '--activate-core --audit-run=9007199254740993 --staging-run=1',
  '--activate-core --staging-run=1 --audit-run=2']) {
  test('reject ambiguous command: ' + JSON.stringify(suffix), () =>
    assert.throws(() => parseCommand(`/run-research-isolated ${sha} ${suffix}`)));
}
test('reject missing target and foreign command', () => {
  assert.throws(() => parseCommand('/run-production-app ' + sha));
  assert.throws(() => parseCommand('/run-research-isolated main --audit'));
});
test('require actual owner on exact Hub, current workflow SHA and main ref', () => {
  assertOwnerContext(context(), sha);
  for (const mutate of [x => { x.actor = 'github-actions[bot]'; },
    x => { x.payload.issue.number = 1555; }, x => { x.payload.issue.pull_request = {}; },
    x => { x.payload.comment.author_association = 'CONTRIBUTOR'; },
    x => { x.ref = 'refs/heads/untrusted'; }, x => { x.sha = head; },
    x => { x.repo.owner = 'foreign'; }]) {
    const c = context(); mutate(c); assert.throws(() => assertOwnerContext(c, sha));
  }
});
test('reuse premerge Required6 and identical merged tree; no new main Full CI needed', () => {
  const p = verifyReleaseProof(proof());
  assert.equal(p.requiredCiRunId, 10); assert.equal(p.postMergeRunId, 20);
  assert.equal(p.targetSha, sha); assert.equal(p.testedHeadSha, head);
  assert.equal(p.executionAuthority, 'NONE');
});
for (const [label, mutate] of [
  ['stale current main', x => { x.currentMainSha = app; }],
  ['different merged tree', x => { x.headTreeSha = app; }],
  ['unmerged PR', x => { x.pr.merged_at = null; }],
  ['foreign PR repository', x => { x.pr.head.repo.full_name = 'foreign/repo'; }],
  ['unbound merge commit', x => { x.pr.merge_commit_sha = head; }],
  ['CI after merge', x => { x.run.updated_at = '2026-10-13T02:01:00Z'; }],
  ['missing required context', x => { x.statuses.pop(); }],
  ['mixed CI receipts', x => { x.statuses[0].target_url = url(11); }],
  ['failed required status', x => { x.statuses[0].state = 'failure'; }],
  ['foreign origin with same numeric run ID', x => { x.statuses[0].target_url = 'https://evil.test/actions/runs/10'; }],
  ['postmerge pending', x => { x.postMergeRun.status = 'in_progress'; }],
  ['postmerge failed', x => { x.postMergeRun.conclusion = 'failure'; }],
  ['postmerge wrong event', x => { x.postMergeRun.event = 'workflow_dispatch'; }],
  ['postmerge foreign status origin', x => { x.postMergeStatuses[0].target_url = 'https://evil.test/actions/runs/20'; }],
  ['newer CI not terminal', x => { x.newerRuns = [{ ...x.run, id: 12, status: 'queued' }]; }],
]) test('release proof rejects ' + label, () => { const p = proof(); mutate(p); assert.throws(() => verifyReleaseProof(p)); });

test('all active protected mutation runs conflict, but PR static jobs do not', () => {
  assertNoMutationConflict([{ id: 31, path: '.github/workflows/production-deploy.yml', event: 'pull_request', status: 'in_progress' }], 30);
  for (const status of ['waiting', 'queued', 'in_progress']) assert.throws(() => assertNoMutationConflict([
    { id: 31, path: '.github/workflows/production-deploy.yml', event: 'workflow_dispatch', status }], 30));
  assertNoMutationConflict([{ id: 30, path: WORKFLOW, event: 'issue_comment', status: 'in_progress' }], 30);
});
test('blocked audit completes honestly; it cannot authorize activation', () => {
  const a = audit(); a.checks[0].status = 'BLOCKED'; a.prerequisiteBlockers = [a.checks[0].id]; a.prerequisitesReady = false;
  const result = verifyAudit(a, auditOptions()); assert.equal(result.prerequisitesReady, false);
  const envelope = buildAuditEnvelope({ audit: a, proof: verifyReleaseProof(proof()), runId: 25, nowMs: now });
  assert.equal(envelope.coreUpdatePrerequisitesObserved, false); assert.equal(envelope.fullyFunctional, false);
  assert.throws(() => verifyAudit(a, { ...auditOptions(), requireReady: true }));
});
for (const [label, mutate] of [
  ['missing full check coverage', a => { a.checks.pop(); }],
  ['duplicate check', a => { a.checks.push(a.checks[0]); }],
  ['unknown status', a => { a.checks[0].status = 'SKIPPED'; }],
  ['prerequisite relabeled functionality', a => { a.checks[0].phase = 'functionality'; }],
  ['stale timestamp', a => { a.observedAt = new Date(now - 31 * 60000).toISOString(); }],
  ['future timestamp', a => { a.observedAt = new Date(now + 6000).toISOString(); }],
  ['wrong app SHA', a => { a.appSha = head; }],
  ['masked missing evidence', a => { a.checks[0].status = 'MISSING'; }],
  ['financial mutation', a => { a.orders = 1; }],
  ['forged profitability', a => { a.profitabilityProven = true; }],
  ['claimed complete operation', a => { a.fullyFunctional = true; }],
]) test('audit rejects ' + label, () => { const a = audit(); mutate(a); assert.throws(() => verifyAudit(a, auditOptions())); });


function apiMock({ moveMain = false, failRead = false } = {}) {
  const p = proof(); let mainReads = 0;
  const endpoints = { getBranch: 'branch', getCommit: 'commit', statuses: 'statuses', prs: 'prs',
    pull: 'pull', run: 'run', runs: 'runs', artifacts: 'artifacts' };
  const github = { rest: { repos: { getBranch: async () => ({ data: { commit: { sha: moveMain && ++mainReads > 1 ? app : sha } } }),
      getCommit: async ({ ref }) => ({ data: { sha: ref, commit: { tree: { sha: tree } } } }),
      listCommitStatusesForRef: endpoints.statuses, listPullRequestsAssociatedWithCommit: endpoints.prs },
    pulls: { get: async () => ({ data: p.pr }) },
    actions: { getWorkflowRun: async ({ run_id }) => ({ data: run_id === 20 ? p.postMergeRun : p.run }),
      listWorkflowRunsForRepo: endpoints.runs, listWorkflowRunArtifacts: endpoints.artifacts } },
    paginate: async (endpoint, args) => {
      if (failRead) throw Error('NETWORK_READ_FAILED');
      if (endpoint === endpoints.statuses) return args.ref === sha ? p.postMergeStatuses : p.statuses;
      if (endpoint === endpoints.prs) return [{ number: p.pr.number }];
      if (endpoint === endpoints.runs) return [];
      throw Error('UNEXPECTED_ENDPOINT');
    } };
  return github;
}
test('actual resolver consumes existing canonical proof without any write API', async () => {
  const value = await authorize({ github: apiMock(), context: context(), targetSha: sha });
  assert.equal(value.requiredCiRunId, 10);
});
test('resolver rejects a main change during authorization', async () =>
  assert.rejects(authorize({ github: apiMock({ moveMain: true }), context: context(), targetSha: sha })));
test('resolver never retries or converts failed evidence reads into PASS', async () =>
  assert.rejects(authorize({ github: apiMock({ failRead: true }), context: context(), targetSha: sha })));

test('workflow contains the read-only source, human gate and post-approval revalidation', () => {
  const workflow=fs.readFileSync(path.join(root,'.github/workflows/research-isolated-release.yml'),'utf8');
  for(const marker of ['environment: production','persist-credentials: false',
    'authorize({ github, context','ops/research-activation-preflight.mjs','StrictHostKeyChecking=yes'])
    assert.ok(workflow.includes(marker),marker);
  for(const forbidden of ['ops/deploy-production.sh','activate-server.sh','activate-ai-research.sh',
    'research-isolated-core-host.sh','continue-on-error: true','LIVE_TRADING: true','--activate-core'])
    assert.ok(!workflow.includes(forbidden),forbidden);
});
