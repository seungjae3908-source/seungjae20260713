'use strict';

const normalizeSha = (value) => String(value ?? '').trim().toLowerCase();

function activeRuns(runs) {
  return (Array.isArray(runs) ? runs : [])
    .filter((run) => run && run.status !== 'completed')
    .sort((left, right) => Number(left.id) - Number(right.id));
}

function selectReusableExactStagingRun(runs, targetSha) {
  const target = normalizeSha(targetSha);
  if (!/^[0-9a-f]{40}$/u.test(target)) throw new Error('STAGING_RELEASE_TARGET_SHA_INVALID');
  return (Array.isArray(runs) ? runs : [])
    .filter((run) => run
      && run.event === 'workflow_dispatch'
      && run.head_branch === 'main'
      && normalizeSha(run.head_sha) === target
      && (run.status !== 'completed' || run.conclusion === 'success'))
    .sort((left, right) => Number(right.id) - Number(left.id))[0] ?? null;
}

function stagingArtifactAccepted(artifacts, { targetSha, runId }) {
  const target = normalizeSha(targetSha);
  const expectedName = `staging-verdict-${target}`;
  return (Array.isArray(artifacts) ? artifacts : []).some((artifact) => artifact
    && artifact.name === expectedName
    && artifact.expired !== true
    && Number(artifact.workflow_run?.id ?? runId) === Number(runId)
    && normalizeSha(artifact.workflow_run?.head_sha ?? target) === target);
}

module.exports = {
  activeRuns,
  selectReusableExactStagingRun,
  stagingArtifactAccepted,
};
