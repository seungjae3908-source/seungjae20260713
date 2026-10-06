'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  activeRuns,
  githubReadFailureCode,
  retryGithubRead,
  selectReusableExactStagingRun,
  stagingArtifactAccepted,
} = require('./production-release-orchestrator.cjs');

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

test('classifies only bounded read-only GitHub transport and response failures as retryable', () => {
  assert.equal(githubReadFailureCode(new SyntaxError('Unexpected end of JSON input')), 'EMPTY_OR_INVALID_JSON');
  assert.equal(githubReadFailureCode({ status: 503 }), 'HTTP_503');
  assert.equal(githubReadFailureCode({ code: 'ECONNRESET' }), 'ECONNRESET');
  assert.equal(githubReadFailureCode(new Error('permission denied')), null);
});

test('read-only GitHub calls retry bounded transient failures and return the first valid response', async () => {
  let calls = 0;
  const delays = [];
  const value = await retryGithubRead(async () => {
    calls += 1;
    if (calls < 3) throw new SyntaxError('Unexpected end of JSON input');
    return { ok: true };
  }, {
    label: 'list-staging-runs',
    attempts: 3,
    baseDelayMs: 10,
    sleep: async (milliseconds) => { delays.push(milliseconds); },
  });
  assert.deepEqual(value, { ok: true });
  assert.equal(calls, 3);
  assert.deepEqual(delays, [10, 20]);
});

test('read-only GitHub retries fail closed with a sanitized code and never retry permanent failures', async () => {
  let transientCalls = 0;
  await assert.rejects(
    retryGithubRead(async () => {
      transientCalls += 1;
      throw Object.assign(new Error('upstream body omitted'), { status: 502 });
    }, { label: 'current-main', attempts: 2, baseDelayMs: 0, sleep: async () => {} }),
    /GITHUB_READ_RETRY_EXHAUSTED:current-main:HTTP_502/,
  );
  assert.equal(transientCalls, 2);

  let permanentCalls = 0;
  await assert.rejects(
    retryGithubRead(async () => {
      permanentCalls += 1;
      throw Object.assign(new Error('forbidden'), { status: 403 });
    }, { label: 'current-main', attempts: 3, baseDelayMs: 0, sleep: async () => {} }),
    /forbidden/,
  );
  assert.equal(permanentCalls, 1);
});

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
