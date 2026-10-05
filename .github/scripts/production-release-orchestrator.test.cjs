'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  activeRuns,
  selectReusableExactStagingRun,
  stagingArtifactAccepted,
} = require('./production-release-orchestrator.cjs');

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

test('active release runs are deterministic and completed runs are excluded', () => {
  assert.deepEqual(activeRuns([
    { id: 8, status: 'waiting' },
    { id: 3, status: 'in_progress' },
    { id: 2, status: 'completed', conclusion: 'failure' },
  ]).map((run) => run.id), [3, 8]);
});

test('latest exact-main successful or active staging run is reusable', () => {
  const selected = selectReusableExactStagingRun([
    { id: 15, event: 'workflow_dispatch', head_branch: 'main', head_sha: OTHER_SHA, status: 'completed', conclusion: 'success' },
    { id: 14, event: 'workflow_dispatch', head_branch: 'main', head_sha: SHA, status: 'completed', conclusion: 'failure' },
    { id: 13, event: 'workflow_dispatch', head_branch: 'main', head_sha: SHA, status: 'completed', conclusion: 'success' },
    { id: 12, event: 'workflow_dispatch', head_branch: 'main', head_sha: SHA, status: 'completed', conclusion: 'success' },
  ], SHA);
  assert.equal(selected.id, 13);

  const active = selectReusableExactStagingRun([
    { id: 16, event: 'workflow_dispatch', head_branch: 'main', head_sha: SHA, status: 'in_progress', conclusion: null },
    selected,
  ], SHA);
  assert.equal(active.id, 16);
});

test('pull request, wrong branch, wrong SHA, and failed staging are never reusable', () => {
  assert.equal(selectReusableExactStagingRun([
    { id: 4, event: 'pull_request', head_branch: 'main', head_sha: SHA, status: 'completed', conclusion: 'success' },
    { id: 3, event: 'workflow_dispatch', head_branch: 'feature', head_sha: SHA, status: 'completed', conclusion: 'success' },
    { id: 2, event: 'workflow_dispatch', head_branch: 'main', head_sha: OTHER_SHA, status: 'completed', conclusion: 'success' },
    { id: 1, event: 'workflow_dispatch', head_branch: 'main', head_sha: SHA, status: 'completed', conclusion: 'failure' },
  ], SHA), null);
});

test('staging artifact must be exact-SHA, exact-run, and unexpired', () => {
  const accepted = {
    name: `staging-verdict-${SHA}`,
    expired: false,
    workflow_run: { id: 91, head_sha: SHA },
  };
  assert.equal(stagingArtifactAccepted([accepted], { targetSha: SHA, runId: 91 }), true);
  assert.equal(stagingArtifactAccepted([{ ...accepted, expired: true }], { targetSha: SHA, runId: 91 }), false);
  assert.equal(stagingArtifactAccepted([accepted], { targetSha: SHA, runId: 92 }), false);
  assert.equal(stagingArtifactAccepted([accepted], { targetSha: OTHER_SHA, runId: 91 }), false);
});
