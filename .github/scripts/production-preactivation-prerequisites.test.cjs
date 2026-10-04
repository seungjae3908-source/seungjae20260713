'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { POST_MERGE_CONTEXT } = require('../../api-server/scripts/release-candidate-provenance.cjs');
const {
  REQUIRED_ARTIFACT_NAMES,
  inspectProductionPreactivationPrerequisites,
} = require('./production-preactivation-prerequisites.cjs');

const SHA = 'a'.repeat(40);
const PROVENANCE_RUN_ID = 101;
const PRODUCTION_RUN_ID = 202;
const BOUNDARY = '2026-10-05T00:01:00.000Z';

function fixture(overrides = {}) {
  const listCommitStatusesForRef = () => undefined;
  const listWorkflowRuns = () => undefined;
  const listJobsForWorkflowRun = () => undefined;
  const listWorkflowRunArtifacts = () => undefined;
  const deploy = {
    id: PRODUCTION_RUN_ID,
    head_sha: SHA,
    conclusion: 'success',
    status: 'completed',
  };
  const artifacts = Object.entries(REQUIRED_ARTIFACT_NAMES).map(([key, name], index) => ({
    id: index + 1,
    name: name(SHA, PRODUCTION_RUN_ID),
    expired: false,
    size_in_bytes: 100,
    created_at: '2026-10-05T00:02:00.000Z',
    key,
  }));
  const state = {
    deploy,
    artifacts,
    ...overrides,
  };
  const github = {
    rest: {
      repos: {
        getBranch: async () => ({ data: { commit: { sha: SHA } } }),
        listCommitStatusesForRef,
      },
      actions: {
        getWorkflowRun: async ({ run_id }) => ({ data: {
          id: run_id,
          name: 'Post-Merge Release Provenance',
          path: '.github/workflows/post-merge-release-provenance.yml',
          head_sha: SHA,
          head_branch: 'main',
          event: 'push',
          status: 'completed',
          conclusion: 'success',
        } }),
        listWorkflowRuns,
        listJobsForWorkflowRun,
        listWorkflowRunArtifacts,
      },
    },
    paginate: async (fn) => {
      if (fn === listCommitStatusesForRef) return [{
        id: 1,
        context: POST_MERGE_CONTEXT,
        state: 'success',
        target_url: `https://github.com/example/repo/actions/runs/${PROVENANCE_RUN_ID}`,
      }];
      if (fn === listWorkflowRuns) return [state.deploy];
      if (fn === listJobsForWorkflowRun) return [{ steps: [{
        name: 'Record successful deployment boundary',
        conclusion: 'success',
        completed_at: BOUNDARY,
      }] }];
      if (fn === listWorkflowRunArtifacts) return state.artifacts;
      throw new Error('UNEXPECTED_PAGINATION_CALL');
    },
  };
  return { github, context: { repo: { owner: 'example', repo: 'repo' } } };
}

test('accepts only exact-main post-merge provenance and four fresh inline Production artifacts', async () => {
  const input = fixture();
  const result = await inspectProductionPreactivationPrerequisites({ ...input, targetSha: SHA });
  assert.equal(result.postMergeProvenanceRunId, PROVENANCE_RUN_ID);
  assert.equal(result.productionDeployRunId, PRODUCTION_RUN_ID);
  assert.equal(result.productionDeployCompletedAt, BOUNDARY);
});

test('rejects when the latest successful Production deploy is not the target SHA', async () => {
  const input = fixture({ deploy: {
    id: PRODUCTION_RUN_ID,
    head_sha: 'b'.repeat(40),
    conclusion: 'success',
    status: 'completed',
  } });
  await assert.rejects(
    inspectProductionPreactivationPrerequisites({ ...input, targetSha: SHA }),
    /LATEST_PRODUCTION_DEPLOY_NOT_EXACT/,
  );
});

test('rejects an artifact created before the successful deployment boundary', async () => {
  const input = fixture();
  const originalPaginate = input.github.paginate;
  input.github.paginate = async (fn, args) => {
    const rows = await originalPaginate(fn, args);
    if (fn === input.github.rest.actions.listWorkflowRunArtifacts) {
      return rows.map((artifact, index) => index === 0
        ? { ...artifact, created_at: '2026-10-05T00:00:59.000Z' }
        : artifact);
    }
    return rows;
  };
  await assert.rejects(
    inspectProductionPreactivationPrerequisites({ ...input, targetSha: SHA }),
    /ARTIFACT_PREDATES_DEPLOYMENT/,
  );
});
