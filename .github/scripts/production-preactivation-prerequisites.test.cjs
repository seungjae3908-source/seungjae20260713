'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { POST_MERGE_CONTEXT } = require('../../api-server/scripts/release-candidate-provenance.cjs');
const {
  REQUIRED_ARTIFACT_NAMES,
  REQUIRED_CI_CONTEXTS,
  inspectProductionPreactivationPrerequisites,
} = require('./production-preactivation-prerequisites.cjs');

const SHA = 'a'.repeat(40);
const PROVENANCE_RUN_ID = 101;
const PRODUCTION_RUN_ID = 202;
const REQUIRED_CI_RUN_ID = 303;
const BOUNDARY = '2026-10-05T00:01:00.000Z';

function fixture(overrides = {}) {
  const qaScope = overrides.qaScope ?? 'full';
  const listCommitStatusesForRef = () => undefined;
  const listWorkflowRuns = () => undefined;
  const listJobsForWorkflowRun = () => undefined;
  const listWorkflowRunArtifacts = () => undefined;
  const deploy = {
    id: PRODUCTION_RUN_ID,
    name: 'Production Deploy',
    path: '.github/workflows/production-deploy.yml',
    head_sha: SHA,
    head_branch: 'main',
    event: 'workflow_dispatch',
    conclusion: 'success',
    status: 'completed',
    created_at: '2026-10-05T00:00:00.000Z',
    updated_at: '2026-10-05T00:01:00.000Z',
  };
  const artifactKeys = qaScope === 'trading_core'
    ? ['tradingCore', 'account', 'credential', 'activationReady']
    : ['comprehensive', 'account', 'credential', 'activationReady'];
  const artifacts = artifactKeys.map((key, index) => ({
    id: index + 1,
    name: REQUIRED_ARTIFACT_NAMES[key](SHA, PRODUCTION_RUN_ID),
    expired: false,
    size_in_bytes: 100,
    created_at: '2026-10-05T00:02:00.000Z',
    key,
  }));
  const statuses = [
    {
      id: 1000,
      context: POST_MERGE_CONTEXT,
      state: 'success',
      target_url: `https://github.com/example/repo/actions/runs/${PROVENANCE_RUN_ID}`,
    },
    ...REQUIRED_CI_CONTEXTS.map((context, index) => ({
      id: 900 - index,
      context,
      state: 'success',
      target_url: `https://github.com/example/repo/actions/runs/${REQUIRED_CI_RUN_ID}`,
    })),
  ];
  const state = {
    deploys: [deploy],
    artifacts,
    statuses,
    ...overrides,
  };
  delete state.qaScope;
  if (overrides.deploy) state.deploys = [overrides.deploy];

  const github = {
    rest: {
      repos: {
        getBranch: async () => ({ data: { commit: { sha: SHA } } }),
        listCommitStatusesForRef,
      },
      actions: {
        getWorkflowRun: async ({ run_id }) => {
          if (run_id === REQUIRED_CI_RUN_ID) {
            return { data: {
              id: run_id,
              name: 'Application CI',
              path: '.github/workflows/futures-public-network-smoke.yml',
              head_sha: SHA,
              head_branch: 'main',
              event: 'workflow_dispatch',
              status: 'completed',
              conclusion: 'success',
            } };
          }
          return { data: {
            id: run_id,
            name: 'Post-Merge Release Provenance',
            path: '.github/workflows/post-merge-release-provenance.yml',
            head_sha: SHA,
            head_branch: 'main',
            event: 'push',
            status: 'completed',
            conclusion: 'success',
          } };
        },
        listWorkflowRuns,
        listJobsForWorkflowRun,
        listWorkflowRunArtifacts,
      },
    },
    paginate: async (fn) => {
      if (fn === listCommitStatusesForRef) return state.statuses;
      if (fn === listWorkflowRuns) return state.deploys;
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

test('accepts exact-main Required CI 6/6, post-merge provenance, and fresh Production artifacts', async () => {
  const input = fixture();
  const result = await inspectProductionPreactivationPrerequisites({ ...input, targetSha: SHA });
  assert.equal(result.requiredCiRunId, REQUIRED_CI_RUN_ID);
  assert.equal(result.postMergeProvenanceRunId, PROVENANCE_RUN_ID);
  assert.equal(result.productionDeployRunId, PRODUCTION_RUN_ID);
  assert.equal(result.productionDeployCompletedAt, BOUNDARY);
  assert.equal(result.qaScope, 'full');
});

test('accepts focused Trading Core artifact set without Comprehensive artifact', async () => {
  const input = fixture({ qaScope: 'trading_core' });
  const result = await inspectProductionPreactivationPrerequisites({ ...input, targetSha: SHA });
  assert.equal(result.qaScope, 'trading_core');
  assert.equal(result.productionDeployRunId, PRODUCTION_RUN_ID);
  assert.equal(result.artifactNames.tradingCore, `production-trading-core-${SHA}`);
});

test('ignores a newer pull-request validation run and selects the real workflow_dispatch Production deploy', async () => {
  const input = fixture({ deploys: [
    {
      id: 999,
      name: 'Production Deploy',
      path: '.github/workflows/production-deploy.yml',
      head_sha: SHA,
      head_branch: 'main',
      event: 'pull_request',
      conclusion: 'success',
      status: 'completed',
      created_at: '2026-10-05T00:05:00.000Z',
      updated_at: '2026-10-05T00:06:00.000Z',
    },
    {
      id: PRODUCTION_RUN_ID,
      name: 'Production Deploy',
      path: '.github/workflows/production-deploy.yml',
      head_sha: SHA,
      head_branch: 'main',
      event: 'workflow_dispatch',
      conclusion: 'success',
      status: 'completed',
      created_at: '2026-10-05T00:00:00.000Z',
      updated_at: '2026-10-05T00:01:00.000Z',
    },
  ] });
  const result = await inspectProductionPreactivationPrerequisites({ ...input, targetSha: SHA });
  assert.equal(result.productionDeployRunId, PRODUCTION_RUN_ID);
});

test('rejects when the latest real Production deploy is not the target SHA', async () => {
  const input = fixture({ deploy: {
    id: PRODUCTION_RUN_ID,
    name: 'Production Deploy',
    path: '.github/workflows/production-deploy.yml',
    head_sha: 'b'.repeat(40),
    head_branch: 'main',
    event: 'workflow_dispatch',
    conclusion: 'success',
    status: 'completed',
    created_at: '2026-10-05T00:00:00.000Z',
    updated_at: '2026-10-05T00:01:00.000Z',
  } });
  await assert.rejects(
    inspectProductionPreactivationPrerequisites({ ...input, targetSha: SHA }),
    /LATEST_PRODUCTION_DEPLOY_NOT_EXACT/,
  );
});

test('rejects when any Required CI context is not successful', async () => {
  const input = fixture();
  input.github.paginate = async (fn, args) => {
    if (fn === input.github.rest.repos.listCommitStatusesForRef) {
      return input.github ? [
        {
          id: 1000,
          context: POST_MERGE_CONTEXT,
          state: 'success',
          target_url: `https://github.com/example/repo/actions/runs/${PROVENANCE_RUN_ID}`,
        },
        ...REQUIRED_CI_CONTEXTS.map((context, index) => ({
          id: 900 - index,
          context,
          state: context === 'security-integration/verified' ? 'failure' : 'success',
          target_url: `https://github.com/example/repo/actions/runs/${REQUIRED_CI_RUN_ID}`,
        })),
      ] : [];
    }
    if (fn === input.github.rest.actions.listWorkflowRuns) return [];
    throw new Error('UNEXPECTED_PAGINATION_CALL');
  };
  await assert.rejects(
    inspectProductionPreactivationPrerequisites({ ...input, targetSha: SHA }),
    /PREACTIVATION_REQUIRED_CI_NOT_6_OF_6:security-integration\/verified/,
  );
});

test('rejects incoherent Required CI provenance runs', async () => {
  const input = fixture();
  const originalPaginate = input.github.paginate;
  input.github.paginate = async (fn, args) => {
    const rows = await originalPaginate(fn, args);
    if (fn === input.github.rest.repos.listCommitStatusesForRef) {
      return rows.map((status) => status.context === 'browser-ui/verified'
        ? { ...status, target_url: 'https://github.com/example/repo/actions/runs/404' }
        : status);
    }
    return rows;
  };
  await assert.rejects(
    inspectProductionPreactivationPrerequisites({ ...input, targetSha: SHA }),
    /PREACTIVATION_REQUIRED_CI_NOT_COHERENT/,
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