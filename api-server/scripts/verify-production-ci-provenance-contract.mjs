import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  REQUIRED_PRODUCTION_STATUSES,
  evaluateProductionCiProvenance,
  inspectRequiredStatusEvidence,
} = require('./production-ci-provenance.cjs');
const {
  POST_MERGE_CONTEXT,
  evaluatePostMergeStatusProvenance,
  evaluateReleaseCandidateProvenance,
} = require('./release-candidate-provenance.cjs');

const cwd = process.cwd();
const root = path.basename(cwd) === 'api-server' ? path.resolve(cwd, '..') : path.resolve(cwd);
const readWorkflow = (name) => readFile(path.join(root, '.github/workflows', name), 'utf8');

const [
  applicationWorkflow,
  fallbackWorkflow,
  postMergeWorkflow,
  stagingDispatchWorkflow,
  stagingReadinessWorkflow,
  productionWorkflow,
  approvalWorkflow,
  appReleaseWorkflow,
] = await Promise.all([
  readWorkflow('futures-public-network-smoke.yml'),
  readWorkflow('application-ci-main-fallback.yml'),
  readWorkflow('post-merge-release-provenance.yml'),
  readWorkflow('staging-dispatch-bridge.yml'),
  readWorkflow('staging-readiness.yml'),
  readWorkflow('production-deploy.yml'),
  readWorkflow('production-one-time-approval.yml'),
  readWorkflow('production-app-release-control.yml'),
]);

const targetSha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
const headSha = 'c'.repeat(40);
const treeSha = 'd'.repeat(40);
const runId = 123456789;

function statusesFor(id = runId, state = 'success', sha = targetSha) {
  return REQUIRED_PRODUCTION_STATUSES.map((context, index) => ({
    id: index + 1,
    context,
    state,
    sha,
    target_url: `https://github.com/example/repo/actions/runs/${id}`,
    created_at: `2026-09-30T00:00:${String(index).padStart(2, '0')}Z`,
  }));
}

function legacyRun(overrides = {}) {
  return {
    id: runId,
    name: 'Application CI',
    path: '.github/workflows/futures-public-network-smoke.yml',
    head_sha: targetSha,
    head_branch: 'main',
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    ...overrides,
  };
}

const manualRecovery = evaluateProductionCiProvenance({
  targetSha,
  currentMainSha: targetSha,
  statuses: statusesFor(),
  run: legacyRun(),
});
assert.equal(manualRecovery.ok, true, 'manual exact-main full CI recovery must remain valid');

const requiredInspection = inspectRequiredStatusEvidence(statusesFor());
assert.equal(requiredInspection.ok, true);
assert.equal(requiredInspection.runId, runId);

const premergeRun = {
  id: runId,
  name: 'Application CI',
  path: '.github/workflows/futures-public-network-smoke.yml',
  head_sha: headSha,
  head_branch: 'feature/rc',
  event: 'workflow_dispatch',
  status: 'completed',
  conclusion: 'success',
  created_at: '2026-09-30T00:00:00Z',
  updated_at: '2026-09-30T00:20:00Z',
};
const mergedPr = {
  number: 1500,
  merged_at: '2026-09-30T00:30:00Z',
  base: { ref: 'main' },
  head: { sha: headSha, ref: 'feature/rc' },
};
const premergeStatuses = statusesFor(runId, 'success', headSha);
const releaseCandidate = evaluateReleaseCandidateProvenance({
  targetSha,
  currentMainSha: targetSha,
  targetTreeSha: treeSha,
  pr: mergedPr,
  headTreeSha: treeSha,
  statuses: premergeStatuses,
  run: premergeRun,
});
assert.equal(releaseCandidate.ok, true, 'pre-merge 6/6 with identical merged tree must pass');

const changedTree = evaluateReleaseCandidateProvenance({
  targetSha,
  currentMainSha: targetSha,
  targetTreeSha: treeSha,
  pr: mergedPr,
  headTreeSha: 'e'.repeat(40),
  statuses: premergeStatuses,
  run: premergeRun,
});
assert.equal(changedTree.ok, false);
assert.equal(changedTree.reason, 'merged_tree_differs_from_tested_head');

const postMergeRunId = 987654321;
const postStatuses = [{
  id: 999,
  context: POST_MERGE_CONTEXT,
  state: 'success',
  target_url: `https://github.com/example/repo/actions/runs/${postMergeRunId}`,
  created_at: '2026-09-30T00:31:00Z',
}];
const postRun = {
  id: postMergeRunId,
  name: 'Post-Merge Release Provenance',
  path: '.github/workflows/post-merge-release-provenance.yml',
  head_sha: targetSha,
  head_branch: 'main',
  event: 'push',
  status: 'completed',
  conclusion: 'success',
};
const postVerified = evaluatePostMergeStatusProvenance({
  targetSha,
  currentMainSha: targetSha,
  statuses: postStatuses,
  run: postRun,
});
assert.equal(postVerified.ok, true, 'current-main post-merge provenance must pass');

const stalePost = evaluatePostMergeStatusProvenance({
  targetSha,
  currentMainSha: otherSha,
  statuses: postStatuses,
  run: postRun,
});
assert.equal(stalePost.ok, false);
assert.equal(stalePost.reason, 'target_is_not_current_main');

assert(
  applicationWorkflow.includes("APPLICATION_CHECKOUT_REF: ${{ github.event_name == 'workflow_dispatch' && (github.event.inputs.target_sha || github.sha) || github.event.pull_request.head.sha || github.sha }}"),
  'workflow_dispatch must bind checkout to target_sha or exact dispatch SHA',
);
const applicationTrigger = applicationWorkflow.slice(0, applicationWorkflow.indexOf('\npermissions:'));
assert.match(applicationTrigger, /workflow_dispatch:/u);
assert.doesNotMatch(applicationTrigger, /pull_request:/u, 'Ready transition must not duplicate full CI');
assert.doesNotMatch(applicationTrigger, /push:/u, 'main push must not duplicate full CI');

const fallbackTrigger = fallbackWorkflow.slice(0, fallbackWorkflow.indexOf('\npermissions:'));
assert.match(fallbackTrigger, /issue_comment:/u);
assert.doesNotMatch(fallbackTrigger, /push:/u, 'exact-main full CI is manual recovery only');
assert.match(fallbackWorkflow, /\/run-application-ci-main/u);
assert.match(fallbackWorkflow, /evaluateProductionCiProvenance/u);

assert.match(postMergeWorkflow, /^name: Post-Merge Release Provenance$/mu);
assert.match(postMergeWorkflow, /push:\s*\n\s+branches:\s*\n\s+- main/mu);
assert.match(postMergeWorkflow, /post-merge-provenance\/verified/u);
assert.match(postMergeWorkflow, /evaluateReleaseCandidateProvenance/u);
assert.match(postMergeWorkflow, /targetTreeSha/u);
assert.match(postMergeWorkflow, /headTreeSha/u);
assert.match(postMergeWorkflow, /inspectRequiredStatusEvidence/u);
assert.doesNotMatch(postMergeWorkflow, /secrets\./u);
assert.doesNotMatch(postMergeWorkflow, /environment:\s*(?:staging|production)/u);
assert.doesNotMatch(postMergeWorkflow, /REAL_ORDER_ENABLED\s*:\s*true|AUTO_TRADING\s*:\s*true|LIVE_TRADING\s*:\s*true/u);

for (const [name, workflow] of [
  ['staging dispatch', stagingDispatchWorkflow],
  ['staging readiness', stagingReadinessWorkflow],
  ['production deploy', productionWorkflow],
  ['production approval', approvalWorkflow],
  ['production app release', appReleaseWorkflow],
]) {
  assert.match(workflow, /release-candidate-provenance\.cjs/u, `${name} must use the shared release provenance evaluator`);
  assert.match(workflow, /evaluatePostMergeStatusProvenance/u, `${name} must validate post-merge provenance`);
}

assert.match(productionWorkflow, /\[\[ "\$TARGET_SHA" == "\$MAIN_SHA" \]\]/u, 'production target must equal exact current main');
assert.match(stagingDispatchWorkflow, /Staging dispatch requires the exact current main SHA/u);
assert.match(stagingReadinessWorkflow, /Staging requires exact current main/u);
assert.doesNotMatch(appReleaseWorkflow, /Require exact-main Required CI 6\/6/u);
assert.doesNotMatch(productionWorkflow, /Require verified statuses and exact Application CI provenance/u);
assert.doesNotMatch(approvalWorkflow, /Require exact Application CI 6\/6 provenance/u);

console.log('Release provenance contract verified.');
console.log('- Full Required CI runs on the exact PR head before Ready/Merge.');
console.log('- main push does not repeat Full CI; it verifies pre-merge 6/6 plus identical Git tree.');
console.log('- Staging and Production trust only exact-current-main post-merge provenance.');
console.log('- Exact-main Full CI remains available as owner-triggered recovery, not the normal release path.');
console.log('- No deployment or trading authority is added by the provenance gate.');
