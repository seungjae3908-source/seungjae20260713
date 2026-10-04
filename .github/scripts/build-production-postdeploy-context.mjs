import fs from 'node:fs';
import path from 'node:path';

const [output, targetSha, productionDeployRunId, deploymentCompletedAt, qaStartedAt, mode = 'completed'] = process.argv.slice(2);
const repository = String(process.env.GITHUB_REPOSITORY ?? '').trim();
const token = String(process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '').trim();
const productionBaseUrl = String(process.env.PRODUCTION_BASE_URL ?? 'https://lsj119.com').replace(/\/$/, '');
if (!output || !/^[0-9a-f]{40}$/.test(targetSha ?? '') || !/^[1-9][0-9]*$/.test(productionDeployRunId ?? '')) {
  throw new Error('POSTDEPLOY_CONTEXT_ARGUMENT_INVALID');
}
if (!repository || !token) throw new Error('POSTDEPLOY_CONTEXT_GITHUB_AUTH_MISSING');
if (!['inline', 'completed'].includes(mode)) throw new Error('POSTDEPLOY_CONTEXT_MODE_INVALID');

const api = async (path) => {
  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`POSTDEPLOY_CONTEXT_GITHUB_HTTP_${response.status}:${path}`);
  return response.json();
};

const normalizedTarget = targetSha.toLowerCase();
const deployRunId = Number(productionDeployRunId);
const main = await api('/branches/main');
const deployRun = await api(`/actions/runs/${deployRunId}`);
if (deployRun.name !== 'Production Deploy'
  || deployRun.path !== '.github/workflows/production-deploy.yml'
  || deployRun.event !== 'workflow_dispatch'
  || deployRun.head_branch !== 'main'
  || String(deployRun.head_sha ?? '').toLowerCase() !== normalizedTarget) {
  throw new Error('POSTDEPLOY_CONTEXT_DEPLOY_PROVENANCE_INVALID');
}
if (mode === 'inline' && (deployRun.status !== 'in_progress' || deployRun.conclusion !== null
  || String(process.env.GITHUB_RUN_ID ?? '') !== productionDeployRunId)) {
  throw new Error('POSTDEPLOY_CONTEXT_INLINE_DEPLOY_STATE_INVALID');
}
if (mode === 'completed' && (deployRun.status !== 'completed' || deployRun.conclusion !== 'success')) {
  throw new Error('POSTDEPLOY_CONTEXT_COMPLETED_DEPLOY_STATE_INVALID');
}

const healthResponse = await fetch(`${productionBaseUrl}/api/health`, {
  headers: { Accept: 'application/json' },
  signal: AbortSignal.timeout(15_000),
});
if (!healthResponse.ok) throw new Error(`POSTDEPLOY_CONTEXT_PRODUCTION_HEALTH_HTTP_${healthResponse.status}`);
const health = await healthResponse.json();

const gateWorkflows = [
  'production-live-trading-gate.yml',
  'production-futures-live-trading-gate.yml',
  'production-automatic-trading-gate.yml',
];
const conflicts = [];
for (const workflow of gateWorkflows) {
  const value = await api(`/actions/workflows/${workflow}/runs?per_page=100`);
  for (const run of value.workflow_runs ?? []) {
    if (run.status !== 'completed') {
      conflicts.push({ id: run.id, name: run.name, status: run.status, headSha: run.head_sha });
    }
  }
}

let latestSuccessfulDeploy = null;
if (mode === 'completed') {
  const deployRuns = await api('/actions/workflows/production-deploy.yml/runs?event=workflow_dispatch&per_page=100');
  latestSuccessfulDeploy = (deployRuns.workflow_runs ?? [])
    .filter((run) => run.status === 'completed' && run.conclusion === 'success')
    .sort((left, right) => Date.parse(right.created_at ?? '') - Date.parse(left.created_at ?? ''))[0] ?? null;
  if (!latestSuccessfulDeploy || latestSuccessfulDeploy.id !== deployRunId) {
    throw new Error('POSTDEPLOY_CONTEXT_NEWER_SUCCESSFUL_DEPLOY_DETECTED');
  }
}

const value = {
  schemaVersion: 'production-postdeploy-context-v2',
  deploymentVerificationMode: mode === 'inline' ? 'inline-approved-job' : 'completed-successful-run',
  mainSha: String(main?.commit?.sha ?? '').toLowerCase(),
  productionDeploySha: String(health?.deploySha ?? '').toLowerCase(),
  processDeploySha: String(health?.processDeploySha ?? '').toLowerCase(),
  deployMarkerSha: String(health?.deployMarkerSha ?? '').toLowerCase(),
  identityMatch: health?.identityMatch === true && health?.identityStatus === 'match',
  productionDeployRunId: deployRunId,
  productionDeployHeadSha: String(deployRun.head_sha ?? '').toLowerCase(),
  productionDeployStatus: deployRun.status,
  productionDeployConclusion: deployRun.conclusion,
  deploymentStepSucceeded: true,
  deploymentSafetyVerified: true,
  productionDeployCompletedAt: deploymentCompletedAt,
  orchestratorStartedAt: qaStartedAt,
  latestSuccessfulDeploySha: latestSuccessfulDeploy ? String(latestSuccessfulDeploy.head_sha ?? '').toLowerCase() : null,
  latestSuccessfulDeployRunId: latestSuccessfulDeploy?.id ?? null,
  activeConflictingTradingGates: conflicts,
};

for (const key of ['mainSha', 'productionDeploySha', 'processDeploySha', 'deployMarkerSha', 'productionDeployHeadSha']) {
  if (value[key] !== normalizedTarget) throw new Error(`POSTDEPLOY_CONTEXT_${key.toUpperCase()}_MISMATCH`);
}
if (!value.identityMatch || conflicts.length !== 0) throw new Error('POSTDEPLOY_CONTEXT_IDENTITY_OR_GATE_CONFLICT');
const completedMs = Date.parse(String(deploymentCompletedAt ?? ''));
const startedMs = Date.parse(String(qaStartedAt ?? ''));
if (!Number.isFinite(completedMs) || !Number.isFinite(startedMs) || startedMs < completedMs) {
  throw new Error('POSTDEPLOY_CONTEXT_TIMELINE_INVALID');
}

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ ok: true, mode, targetSha: normalizedTarget, activeConflictingTradingGates: 0 }));
