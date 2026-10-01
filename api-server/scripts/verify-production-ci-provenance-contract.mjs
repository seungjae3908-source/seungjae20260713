import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  REQUIRED_PRODUCTION_STATUSES,
  evaluateProductionCiProvenance,
} = require('./production-ci-provenance.cjs');
const {
  POST_MERGE_CONTEXT,
  evaluatePostMergeStatusProvenance,
  evaluateReleaseCandidateProvenance,
} = require('./release-candidate-provenance.cjs');

const cwd = process.cwd();
const root = path.basename(cwd) === 'api-server' ? path.resolve(cwd, '..') : path.resolve(cwd);
const read = (file) => readFile(path.join(root, file), 'utf8');

const [
  applicationWorkflow,
  fastWorkflow,
  dispatcherWorkflow,
  fallbackWorkflow,
  postMergeWorkflow,
  stagingBridge,
  stagingReadiness,
  productionWorkflow,
  approvalWorkflow,
  appReleaseWorkflow,
] = await Promise.all([
  read('.github/workflows/futures-public-network-smoke.yml'),
  read('.github/workflows/application-fast-ci.yml'),
  read('.github/workflows/application-full-ci-ready-dispatch.yml'),
  read('.github/workflows/application-ci-main-fallback.yml'),
  read('.github/workflows/post-merge-release-provenance.yml'),
  read('.github/workflows/staging-dispatch-bridge.yml'),
  read('.github/workflows/staging-readiness.yml'),
  read('.github/workflows/production-deploy.yml'),
  read('.github/workflows/production-one-time-approval.yml'),
  read('.github/workflows/production-app-release-control.yml'),
]);

const targetSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const treeSha = 'c'.repeat(40);
const ciRunId = 123456789;
const provenanceRunId = 987654321;

function requiredStatuses(runId = ciRunId) {
  return REQUIRED_PRODUCTION_STATUSES.map((context, index) => ({
    id: index + 1,
    context,
    state: 'success',
    target_url: `https://github.com/example/repo/actions/runs/${runId}`,
    created_at: `2026-09-30T00:00:${String(index).padStart(2, '0')}Z`,
  }));
}

const manualMain = evaluateProductionCiProvenance({
  targetSha,
  currentMainSha: targetSha,
  statuses: requiredStatuses(),
  run: {
    id: ciRunId,
    name: 'Application CI',
    path: '.github/workflows/futures-public-network-smoke.yml',
    head_sha: targetSha,
    head_branch: 'main',
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
  },
});
assert.equal(manualMain.ok, true, 'manual exact-main recovery CI must remain valid');

const releaseCandidate = evaluateReleaseCandidateProvenance({
  targetSha,
  currentMainSha: targetSha,
  targetTreeSha: treeSha,
  pr: {
    number: 1600,
    merged_at: '2026-09-30T00:30:00Z',
    base: { ref: 'main' },
    head: { sha: headSha, ref: 'feature/rc' },
  },
  headTreeSha: treeSha,
  statuses: requiredStatuses(),
  run: {
    id: ciRunId,
    name: 'Application CI',
    path: '.github/workflows/futures-public-network-smoke.yml',
    head_sha: headSha,
    head_branch: 'feature/rc',
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    created_at: '2026-09-30T00:00:00Z',
    updated_at: '2026-09-30T00:20:00Z',
  },
});
assert.equal(releaseCandidate.ok, true, 'pre-merge 6/6 plus exact merged tree must be accepted');

const postMergeStatuses = [{
  id: 1,
  context: POST_MERGE_CONTEXT,
  state: 'success',
  target_url: `https://github.com/example/repo/actions/runs/${provenanceRunId}`,
  created_at: '2026-09-30T00:31:00Z',
}];
const postMerge = evaluatePostMergeStatusProvenance({
  targetSha,
  currentMainSha: targetSha,
  statuses: postMergeStatuses,
  run: {
    id: provenanceRunId,
    name: 'Post-Merge Release Provenance',
    path: '.github/workflows/post-merge-release-provenance.yml',
    head_sha: targetSha,
    head_branch: 'main',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
  },
});
assert.equal(postMerge.ok, true, 'official post-merge provenance status must be accepted');

const applicationTriggers = applicationWorkflow.slice(0, applicationWorkflow.indexOf('\npermissions:'));
assert.match(applicationTriggers, /workflow_dispatch:/u);
assert.doesNotMatch(applicationTriggers, /pull_request:/u, 'full CI must not rerun on Ready transition');
assert.doesNotMatch(applicationTriggers, /^\s+push:/mu, 'full CI must not rerun automatically after merge');

assert.match(dispatcherWorkflow, /workflow_run:/u);
assert.match(dispatcherWorkflow, /Application Fast CI/u);
assert.match(dispatcherWorkflow, /github\.event\.workflow_run\.conclusion == 'success'/u);
assert.doesNotMatch(dispatcherWorkflow, /if \(pr\.draft\)/u, 'Draft must no longer defer canonical full CI');
assert.match(dispatcherWorkflow, /dispatching pre-merge full CI/u);
assert.match(dispatcherWorkflow, /target_sha: targetSha/u);

const fallbackTriggers = fallbackWorkflow.slice(0, fallbackWorkflow.indexOf('\npermissions:'));
assert.match(fallbackTriggers, /issue_comment:/u);
assert.doesNotMatch(fallbackTriggers, /^\s+push:/mu, 'exact-main fallback must be manual, not every push');
assert.match(fallbackWorkflow, /\/run-application-ci-main/u);
assert.match(fallbackWorkflow, /createWorkflowDispatch/u);

assert.match(postMergeWorkflow, /^name: Post-Merge Release Provenance$/mu);
assert.match(postMergeWorkflow, /^\s+push:/mu);
assert.match(postMergeWorkflow, /^\s+- main$/mu);
assert.match(postMergeWorkflow, /evaluateReleaseCandidateProvenance/u);
assert.match(postMergeWorkflow, /targetTreeSha/u);
assert.match(postMergeWorkflow, /headTreeSha/u);
assert.match(postMergeWorkflow, /post-merge-provenance\/verified/u);
assert.doesNotMatch(postMergeWorkflow, /environment:\s*production/u);
assert.doesNotMatch(postMergeWorkflow, /REAL_ORDER_ENABLED\s*:\s*true|AUTO_TRADING\s*:\s*true/u);

for (const [label, document] of [
  ['staging bridge', stagingBridge],
  ['staging readiness', stagingReadiness],
  ['production deploy', productionWorkflow],
  ['one-time approval', approvalWorkflow],
  ['app release bridge', appReleaseWorkflow],
]) {
  assert.match(document, /release-candidate-provenance\.cjs/u, `${label} must use shared release provenance`);
  assert.match(document, /evaluatePostMergeStatusProvenance/u, `${label} must validate official post-merge status provenance`);
}

assert.doesNotMatch(stagingBridge, /Require successful verified main CI/u);
assert.doesNotMatch(productionWorkflow, /Require verified statuses and exact Application CI provenance/u);
assert.doesNotMatch(approvalWorkflow, /Require exact Application CI 6\/6 provenance/u);
assert.doesNotMatch(appReleaseWorkflow, /Require exact-main Required CI 6\/6/u);

assert.match(fastWorkflow, /canonical pre-merge Application CI 6\/6/u);
assert.match(fastWorkflow, /Staging\/Production require verified post-merge tree provenance/u);
assert.match(productionWorkflow, /pre-merge Required CI 6\/6 \+ exact merged-tree identity/u);

console.log('Production release provenance contract verified.');
console.log('- Full Required CI runs on the exact PR head before Ready/Merge.');
console.log('- Ready transition and main push do not automatically rerun Full CI.');
console.log('- Post-merge gate proves current-main Git tree equals the fully tested PR head.');
console.log('- Staging and Production accept only the official exact-main post-merge provenance run.');
console.log('- Exact-main Full CI remains available as an explicit owner recovery command.');
