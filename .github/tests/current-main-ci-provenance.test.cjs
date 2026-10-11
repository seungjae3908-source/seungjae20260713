'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  REQUIRED,
  inspectCurrentMainCiProvenance,
} = require('../scripts/current-main-ci-provenance.cjs');

const SHA = 'a'.repeat(40);
const context = { repo: { owner: 'owner', repo: 'repo' } };

function githubFor(statuses, runs) {
  return {
    paginate: async () => statuses,
    rest: {
      repos: {
        getBranch: async () => ({ data: { commit: { sha: SHA } } }),
        listCommitStatusesForRef: async () => ({ data: statuses }),
      },
      actions: {
        getWorkflowRun: async ({ run_id: id }) => ({ data: runs[id] }),
      },
    },
  };
}

test('accepts a coherent direct exact-main Required CI 6/6 run', async () => {
  const statuses = REQUIRED.map((name, index) => ({
    id: 100 + index,
    context: name,
    state: 'success',
    target_url: 'https://github.com/owner/repo/actions/runs/41',
  }));
  const result = await inspectCurrentMainCiProvenance({
    github: githubFor(statuses, {
      41: { id: 41, head_sha: SHA, status: 'completed', conclusion: 'success' },
    }),
    context,
    targetSha: SHA,
  });
  assert.deepEqual({ mode: result.mode, runId: result.runId }, {
    mode: 'DIRECT_6_OF_6', runId: 41,
  });
});

test('accepts verified post-merge provenance when merge commit intentionally has no duplicated 6/6 statuses', async () => {
  const statuses = [{
    id: 201,
    context: 'post-merge-provenance/verified',
    state: 'success',
    created_at: '2026-10-10T00:00:00Z',
    target_url: 'https://github.com/owner/repo/actions/runs/51',
  }];
  const result = await inspectCurrentMainCiProvenance({
    github: githubFor(statuses, {
      51: {
        id: 51,
        name: 'Post-Merge Release Provenance',
        path: '.github/workflows/post-merge-release-provenance.yml',
        head_sha: SHA,
        head_branch: 'main',
        event: 'push',
        status: 'completed',
        conclusion: 'success',
      },
    }),
    context,
    targetSha: SHA,
  });
  assert.deepEqual({ mode: result.mode, runId: result.runId }, {
    mode: 'POST_MERGE_PROVENANCE', runId: 51,
  });
});
