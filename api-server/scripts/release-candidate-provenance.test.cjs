'use strict';

const assert = require('node:assert/strict');
const {
  POST_MERGE_CONTEXT,
  REQUIRED_PRODUCTION_STATUSES,
  evaluatePostMergeStatusProvenance,
  evaluateReleaseCandidateProvenance,
} = require('./release-candidate-provenance.cjs');

const targetSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const treeSha = 'c'.repeat(40);
const runId = 987654321;

function requiredStatuses(id = runId) {
  return REQUIRED_PRODUCTION_STATUSES.map((context, index) => ({
    id: index + 1,
    context,
    state: 'success',
    target_url: `https://github.com/example/repo/actions/runs/${id}`,
    created_at: `2026-09-30T00:00:${String(index).padStart(2, '0')}Z`,
  }));
}

function premergeRun(overrides = {}) {
  return {
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
    ...overrides,
  };
}

function prFixture(overrides = {}) {
  return {
    number: 1500,
    merged_at: '2026-09-30T00:30:00Z',
    base: { ref: 'main' },
    head: { sha: headSha, ref: 'feature/rc' },
    ...overrides,
  };
}

const accepted = evaluateReleaseCandidateProvenance({
  targetSha,
  currentMainSha: targetSha,
  targetTreeSha: treeSha,
  pr: prFixture(),
  headTreeSha: treeSha,
  statuses: requiredStatuses(),
  run: premergeRun(),
});
assert.equal(accepted.ok, true);
assert.equal(accepted.prNumber, 1500);
assert.equal(accepted.runId, runId);

const treeMismatch = evaluateReleaseCandidateProvenance({
  targetSha,
  currentMainSha: targetSha,
  targetTreeSha: treeSha,
  pr: prFixture(),
  headTreeSha: 'd'.repeat(40),
  statuses: requiredStatuses(),
  run: premergeRun(),
});
assert.equal(treeMismatch.ok, false);
assert.equal(treeMismatch.reason, 'merged_tree_differs_from_tested_head');

const lateCi = evaluateReleaseCandidateProvenance({
  targetSha,
  currentMainSha: targetSha,
  targetTreeSha: treeSha,
  pr: prFixture(),
  headTreeSha: treeSha,
  statuses: requiredStatuses(),
  run: premergeRun({ updated_at: '2026-09-30T00:40:00Z' }),
});
assert.equal(lateCi.ok, false);
assert.equal(lateCi.reason, 'application_ci_completed_after_merge');

const wrongBranch = evaluateReleaseCandidateProvenance({
  targetSha,
  currentMainSha: targetSha,
  targetTreeSha: treeSha,
  pr: prFixture(),
  headTreeSha: treeSha,
  statuses: requiredStatuses(),
  run: premergeRun({ head_branch: 'other/branch' }),
});
assert.equal(wrongBranch.ok, false);
assert.equal(wrongBranch.reason, 'application_ci_branch_mismatch');

const postMergeRunId = 111222333;
const postStatuses = [{
  id: 99,
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
const postAccepted = evaluatePostMergeStatusProvenance({
  targetSha,
  currentMainSha: targetSha,
  statuses: postStatuses,
  run: postRun,
});
assert.equal(postAccepted.ok, true);

const postWrongSha = evaluatePostMergeStatusProvenance({
  targetSha,
  currentMainSha: targetSha,
  statuses: postStatuses,
  run: { ...postRun, head_sha: headSha },
});
assert.equal(postWrongSha.ok, false);
assert.equal(postWrongSha.reason, 'post_merge_run_sha_mismatch');

console.log('Release candidate provenance contract verified.');
