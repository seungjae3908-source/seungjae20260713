'use strict';

const {
  evaluatePostMergeStatusProvenance,
  inspectPostMergeStatusEvidence,
} = require('../../api-server/scripts/release-candidate-provenance.cjs');

const REQUIRED_ARTIFACT_NAMES = Object.freeze({
  comprehensive: (sha, runId) => `production-comprehensive-readonly-${runId}`,
  account: (sha) => `production-account-readonly-live-${sha}`,
  credential: (sha) => `production-live-credential-reuse-${sha}`,
  activationReady: (sha) => `production-postdeploy-activation-ready-${sha}`,
});

async function inspectProductionPreactivationPrerequisites({ github, context, targetSha }) {
  const target = String(targetSha ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(target)) throw new Error('PREACTIVATION_TARGET_SHA_INVALID');
  const repo = { owner: context.repo.owner, repo: context.repo.repo };
  const main = (await github.rest.repos.getBranch({ ...repo, branch: 'main' })).data.commit.sha;
  if (main !== target) throw new Error(`PREACTIVATION_MAIN_SHA_MISMATCH:target=${target}:main=${main}`);

  const statuses = await github.paginate(github.rest.repos.listCommitStatusesForRef, {
    ...repo, ref: target, per_page: 100,
  });
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
    status: 'completed',
    per_page: 100,
  });
  const latestSuccessfulDeploy = deployRuns.find((run) => run.conclusion === 'success');
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
    const matches = artifacts.filter((artifact) => artifact.name === name && !artifact.expired && artifact.size_in_bytes > 0);
    if (matches.length !== 1) throw new Error(`PREACTIVATION_${key.toUpperCase()}_ARTIFACT_REQUIRED:${name}`);
    const createdAt = Date.parse(String(matches[0].created_at ?? ''));
    if (!Number.isFinite(createdAt) || createdAt < deploymentCompletedAt) {
      throw new Error(`PREACTIVATION_${key.toUpperCase()}_ARTIFACT_PREDATES_DEPLOYMENT`);
    }
  }

  return {
    targetSha: target,
    postMergeProvenanceRunId: provenance.runId,
    productionDeployRunId: latestSuccessfulDeploy.id,
    productionDeployCompletedAt: new Date(deploymentCompletedAt).toISOString(),
    artifactNames,
  };
}

module.exports = {
  REQUIRED_ARTIFACT_NAMES,
  inspectProductionPreactivationPrerequisites,
};
