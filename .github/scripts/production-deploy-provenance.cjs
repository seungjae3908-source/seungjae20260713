'use strict';

const CANONICAL_PRODUCTION_ACCOUNT_PROVIDERS = Object.freeze(['bitget', 'kiwoom', 'toss', 'upbit']);
const OFFICIAL_PRODUCTION_DEPLOY = Object.freeze({
  name: 'Production Deploy',
  path: '.github/workflows/production-deploy.yml',
  event: 'workflow_dispatch',
  headBranch: 'main',
});

function normalizedSha(value) {
  const sha = String(value ?? '').trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

function normalizedRunId(value) {
  const id = String(value ?? '').trim();
  return /^[1-9][0-9]*$/.test(id) ? id : null;
}

function canonicalizeProductionAccountProviders(value) {
  const providers = String(value ?? '').split(',').filter(Boolean);
  if (providers.length === 0
    || new Set(providers).size !== providers.length
    || providers.some((provider) => !CANONICAL_PRODUCTION_ACCOUNT_PROVIDERS.includes(provider))) {
    return null;
  }
  return [...providers].sort();
}

function isOfficialSuccessfulProductionDeploy(run) {
  return run?.name === OFFICIAL_PRODUCTION_DEPLOY.name
    && run?.path === OFFICIAL_PRODUCTION_DEPLOY.path
    && run?.event === OFFICIAL_PRODUCTION_DEPLOY.event
    && run?.head_branch === OFFICIAL_PRODUCTION_DEPLOY.headBranch
    && run?.status === 'completed'
    && run?.conclusion === 'success';
}

function selectLatestSuccessfulProductionDeploy(runs) {
  return [...(Array.isArray(runs) ? runs : [])]
    .filter(isOfficialSuccessfulProductionDeploy)
    .sort((left, right) => Date.parse(right.created_at ?? '') - Date.parse(left.created_at ?? ''))[0] ?? null;
}

function assertProductionDeployProvenance(run, { targetSha, productionDeployRunId }) {
  const expectedSha = normalizedSha(targetSha);
  const expectedRunId = normalizedRunId(productionDeployRunId);
  if (!expectedSha) throw new Error('PRODUCTION_DEPLOY_PROVENANCE_TARGET_SHA_INVALID');
  if (!expectedRunId) throw new Error('PRODUCTION_DEPLOY_PROVENANCE_RUN_ID_INVALID');
  if (!run || String(run.id) !== expectedRunId) throw new Error('PRODUCTION_DEPLOY_PROVENANCE_RUN_ID_MISMATCH');
  if (run.name !== OFFICIAL_PRODUCTION_DEPLOY.name) throw new Error('PRODUCTION_DEPLOY_PROVENANCE_WORKFLOW_NAME_MISMATCH');
  if (run.path !== OFFICIAL_PRODUCTION_DEPLOY.path) throw new Error('PRODUCTION_DEPLOY_PROVENANCE_WORKFLOW_PATH_MISMATCH');
  if (run.event !== OFFICIAL_PRODUCTION_DEPLOY.event) throw new Error('PRODUCTION_DEPLOY_PROVENANCE_EVENT_MISMATCH');
  if (run.head_branch !== OFFICIAL_PRODUCTION_DEPLOY.headBranch) throw new Error('PRODUCTION_DEPLOY_PROVENANCE_HEAD_BRANCH_MISMATCH');
  if (normalizedSha(run.head_sha) !== expectedSha) throw new Error('PRODUCTION_DEPLOY_PROVENANCE_HEAD_SHA_MISMATCH');
  if (run.status !== 'completed') throw new Error('PRODUCTION_DEPLOY_PROVENANCE_STATUS_MISMATCH');
  if (run.conclusion !== 'success') throw new Error('PRODUCTION_DEPLOY_PROVENANCE_CONCLUSION_MISMATCH');
}

function assertProductionRuntimeIdentity(health, targetSha) {
  const expectedSha = normalizedSha(targetSha);
  if (!expectedSha
    || health?.ok !== true
    || normalizedSha(health?.deploySha) !== expectedSha
    || normalizedSha(health?.processDeploySha) !== expectedSha
    || normalizedSha(health?.deployMarkerSha) !== expectedSha
    || health?.identityMatch !== true
    || health?.identityStatus !== 'match') {
    throw new Error('PRODUCTION_ACCOUNT_QA_IDENTITY_MISMATCH');
  }
}

module.exports = {
  CANONICAL_PRODUCTION_ACCOUNT_PROVIDERS,
  assertProductionDeployProvenance,
  assertProductionRuntimeIdentity,
  canonicalizeProductionAccountProviders,
  isOfficialSuccessfulProductionDeploy,
  selectLatestSuccessfulProductionDeploy,
};
