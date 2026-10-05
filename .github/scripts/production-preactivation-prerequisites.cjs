'use strict';

const {
  evaluatePostMergeStatusProvenance,
  inspectPostMergeStatusEvidence,
} = require('../../api-server/scripts/release-candidate-provenance.cjs');

const REQUIRED_CI_CONTEXTS = Object.freeze([
  'application-ci/verified',
  'browser-ui/verified',
  'database-rls/verified',
  'security-integration/verified',
  'ai-privacy/verified',
  'futures-public-network-smoke/verified',
]);

const REQUIRED_ARTIFACT_NAMES = Object.freeze({
  comprehensive: (sha, runId) => `production-comprehensive-readonly-${runId}`,
  account: (sha) => `production-account-readonly-live-${sha}`,
  credential: (sha) => `production-live-credential-reuse-${sha}`,
  activationReady: (sha) => `production-postdeploy-activation-ready-${sha}`,
});

function latestStatusesByContext(statuses) {
  const latest = new Map();
  const ordered = [...statuses].sort((a, b) => Number(b?.id ?? 0) - Number(a?.id ?? 0));
  for (const status of ordered) {
    const context = String(status?.context ?? '');
    if (context && !latest.has(context)) latest.set(context, status);
  }
  return latest;
}

function workflowRunIdFromStatus(status) {
  const match = /\/actions\/runs\/(\d+)/u.exec(String(status?.target_url ?? ''));
  return match ? Number(match[1]) : null;
}

async function inspectProductionPreactivationPrerequisites({ github, context, targetSha }) {
  const target = String(targetSha ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(target)) throw new Error('PREACTIVATION_TARGET_SHA_INVALID');
  const repo = { owner: context.repo.owner, repo: context.repo.repo };
  const main = (await github.rest.repos.getBranch({ ...repo, branch: 'main' })).data.commit.sha;
  if (main !== target) throw new Error(`PREACTIVATION_MAIN_SHA_MISMATCH:target=${target}:main=${main}`);

  const statuses = await github.paginate(github.rest.repos.listCommitStatusesForRef, {
    ...repo, ref: target, per_page: 100,
  });

  const latest = latestStatusesByContext(statuses);
  const missingRequired = REQUIRED_CI_CONTEXTS.filter((name) => latest.get(name)?.state !== 'success');
  if (missingRequired.length > 0) {
    throw new Error(`PREACTIVATION_REQUIRED_CI_NOT_6_OF_6:${missingRequired.join(',')}`);
  }

  const requiredRunIds = new Set(REQUIRED_CI_CONTEXTS.map((name) =>
    workflowRunIdFromStatus(latest.get(name))));
  if (requiredRunIds.size !== 1 || requiredRunIds.has(null)) {
    throw new Error('PREACTIVATION_REQUIRED_CI_NOT_COHERENT');
  }
  const requiredCiRunId = [...requiredRunIds][0];
  const requiredCiRun = (await github.rest.actions.getWorkflowRun({
    ...repo, run_id: requiredCiRunId,
  })).data;
  if (requiredCiRun.name !== 'Application CI'
    || requiredCiRun.path !== '.github/workflows/futures-public-network-smoke.yml'
    || requiredCiRun.head_sha !== target
    || requiredCiRun.head_branch !== 'main'
    || !['push', 'workflow_dispatch'].includes(requiredCiRun.event)
    || requiredCiRun.status !== 'completed'
    || requiredCiRun.conclusion !== 'success') {
    throw new Error(`PREACTIVATION_REQUIRED_CI_PROVENANCE_REJECTED:${requiredCiRunId}`);
  }

  const provenanceEvidence = inspectPostMergeStatusEvidence(statuses);
  if (!provenanceEvidence.ok) {
    throw new Error(`PREACTIVATION_POSTMERGE_PROVENANCE_UNAVAILABLE:${provenanceEvidence.reason}`);
  }
  const provenanceRun = (await github.rest.actions.getWorkflowRun({
    ...repo, run_id: provenanceEvidence.runId,
  })).data;
  const provenance = evaluatePostMergeStatusProvenance({
    targetSha: target,
    currentMainSha: main,
    statuses,
    run: provenanceRun,
  });
  if (!provenance.ok) {
    throw new Error(`PREACTIVATION_POSTMERGE_PROVENANCE_REJECTED:${provenance.reason}`);
  }

  const deployRuns = await github.paginate(github.rest.actions.listWorkflowRuns, {
    ...repo,
    workflow_id: 'production-deploy.yml',
    branch: 'main',
    event: 'workflow_dispatch',
    status: 'completed',
    per_page: 100,
  });
  const productionDeploys = deployRuns
    .filter((run) => run.name === 'Production Deploy'
      && run.path === '.github/workflows/production-deploy.yml'
      && run.event === 'workflow_dispatch'
      && run.head_branch === 'main'
      && run.status === 'completed'
      && run.conclusion === 'success')
    .sort((a, b) => Date.parse(b.updated_at || b.created_at || 0)
      - Date.parse(a.updated_at || a.created_at || 0));
  const latestSuccessfulDeploy = productionDeploys[0];
  if (!latestSuccessfulDeploy || latestSuccessfulDeploy.head_sha !== target) {
    throw new Error(`PREACTIVATION_LATEST_PRODUCTION_DEPLOY_NOT_EXACT:${target}`);
  }

  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    ...repo, run_id: latestSuccessfulDeploy.id, per_page: 100,
  });
  const boundarySteps = jobs.flatMap((job) => (job.steps ?? []).filter((step) =>
    step.name === 'Record successful deployment boundary' && step.conclusion === 'success'));
  if (boundarySteps.length !== 1) throw new Error('PREACTIVATION_DEPLOYMENT_BOUNDARY_AMBIGUOUS');
  const deploymentCompletedAt = Date.parse(String(boundarySteps[0].completed_at ?? ''));
  if (!Number.isFinite(deploymentCompletedAt)) throw new Error('PREACTIVATION_DEPLOYMENT_BOUNDARY_INVALID');

  const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, {
    ...repo, run_id: latestSuccessfulDeploy.id, per_page: 100,
  });
  const artifactNames = Object.fromEntries(Object.entries(REQUIRED_ARTIFACT_NAMES).map(([key, makeName]) => [
    key,
    makeName(target, latestSuccessfulDeploy.id),
  ]));
  for (const [key, name] of Object.entries(artifactNames)) {
    const matches = artifacts.filter((artifact) =>
      artifact.name === name && !artifact.expired && artifact.size_in_bytes > 0);
    if (matches.length !== 1) throw new Error(`PREACTIVATION_${key.toUpperCase()}_ARTIFACT_REQUIRED:${name}`);
    const createdAt = Date.parse(String(matches[0].created_at ?? ''));
    if (!Number.isFinite(createdAt) || createdAt < deploymentCompletedAt) {
      throw new Error(`PREACTIVATION_${key.toUpperCase()}_ARTIFACT_PREDATES_DEPLOYMENT`);
    }
  }

  return {
    targetSha: target,
    requiredCiRunId,
    postMergeProvenanceRunId: provenance.runId,
    productionDeployRunId: latestSuccessfulDeploy.id,
    productionDeployCompletedAt: new Date(deploymentCompletedAt).toISOString(),
    artifactNames,
  };
}

module.exports = {
  REQUIRED_ARTIFACT_NAMES,
  REQUIRED_CI_CONTEXTS,
  inspectProductionPreactivationPrerequisites,
};