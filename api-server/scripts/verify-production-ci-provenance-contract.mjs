import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  REQUIRED_PRODUCTION_STATUSES,
  evaluateProductionCiProvenance,
  inspectRequiredStatusEvidence,
} = require('./production-ci-provenance.cjs');

const cwd = process.cwd();
const root = path.basename(cwd) === 'api-server' ? path.resolve(cwd, '..') : path.resolve(cwd);
const applicationWorkflow = await readFile(path.join(root, '.github/workflows/futures-public-network-smoke.yml'), 'utf8');
const fallbackWorkflow = await readFile(path.join(root, '.github/workflows/application-ci-main-fallback.yml'), 'utf8');
const productionWorkflow = await readFile(path.join(root, '.github/workflows/production-deploy.yml'), 'utf8');
const approvalWorkflow = await readFile(path.join(root, '.github/workflows/production-one-time-approval.yml'), 'utf8');

const targetSha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
const runId = 123456789;

function statusesFor(id = runId, state = 'success') {
  return REQUIRED_PRODUCTION_STATUSES.map((context, index) => ({
    id: index + 1,
    context,
    state,
    target_url: `https://github.com/example/repo/actions/runs/${id}`,
    created_at: `2026-08-08T00:00:${String(index).padStart(2, '0')}Z`,
  }));
}

function runFixture(overrides = {}) {
  return {
    id: runId,
    name: 'Application CI',
    path: '.github/workflows/futures-public-network-smoke.yml',
    head_sha: targetSha,
    head_branch: 'main',
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    ...overrides,
  };
}

function expectFailure(label, input, reason) {
  const result = evaluateProductionCiProvenance(input);
  assert.equal(result.ok, false, `${label} must fail`);
  assert.equal(result.reason, reason, `${label} failure reason`);
}

for (const event of ['push', 'workflow_dispatch']) {
  const result = evaluateProductionCiProvenance({
    targetSha,
    currentMainSha: targetSha,
    statuses: statusesFor(),
    run: runFixture({ event }),
  });
  assert.equal(result.ok, true, `exact current main ${event} evidence must pass`);
  assert.equal(result.runId, runId);
}

expectFailure('other SHA success', {
  targetSha,
  currentMainSha: targetSha,
  statuses: statusesFor(),
  run: runFixture({ head_sha: otherSha }),
}, 'application_ci_sha_mismatch');

expectFailure('stale target SHA', {
  targetSha,
  currentMainSha: otherSha,
  statuses: statusesFor(),
  run: runFixture(),
}, 'target_is_not_current_main');

expectFailure('PR synthetic merge run', {
  targetSha,
  currentMainSha: targetSha,
  statuses: statusesFor(),
  run: runFixture({ event: 'pull_request', head_branch: 'feature/example' }),
}, 'application_ci_branch_mismatch');

expectFailure('required status 5/6', {
  targetSha,
  currentMainSha: targetSha,
  statuses: statusesFor().slice(0, 5),
  run: runFixture(),
}, 'required_status_missing');

expectFailure('cancelled run', {
  targetSha,
  currentMainSha: targetSha,
  statuses: statusesFor(),
  run: runFixture({ conclusion: 'cancelled' }),
}, 'application_ci_not_successful');

expectFailure('failed run', {
  targetSha,
  currentMainSha: targetSha,
  statuses: statusesFor(),
  run: runFixture({ conclusion: 'failure' }),
}, 'application_ci_not_successful');

expectFailure('pending run', {
  targetSha,
  currentMainSha: targetSha,
  statuses: statusesFor(),
  run: runFixture({ status: 'in_progress', conclusion: null }),
}, 'application_ci_not_completed');

expectFailure('run SHA mismatch', {
  targetSha,
  currentMainSha: targetSha,
  statuses: statusesFor(),
  run: runFixture({ head_sha: otherSha }),
}, 'application_ci_sha_mismatch');

expectFailure('non-main branch', {
  targetSha,
  currentMainSha: targetSha,
  statuses: statusesFor(),
  run: runFixture({ head_branch: 'feature/example' }),
}, 'application_ci_branch_mismatch');

expectFailure('branch name instead of SHA', {
  targetSha: 'main',
  currentMainSha: targetSha,
  statuses: statusesFor(),
  run: runFixture(),
}, 'invalid_target_sha');

expectFailure('latest instead of SHA', {
  targetSha: 'latest',
  currentMainSha: targetSha,
  statuses: statusesFor(),
  run: runFixture(),
}, 'invalid_target_sha');

const mixedRunStatuses = statusesFor();
mixedRunStatuses[5] = { ...mixedRunStatuses[5], target_url: 'https://github.com/example/repo/actions/runs/987654321' };
expectFailure('mixed CI run status provenance', {
  targetSha,
  currentMainSha: targetSha,
  statuses: mixedRunStatuses,
  run: runFixture(),
}, 'required_statuses_do_not_share_one_run');

const staleEvidence = statusesFor();
staleEvidence.push({
  ...staleEvidence[0],
  id: 100,
  state: 'pending',
  target_url: 'https://github.com/example/repo/actions/runs/987654321',
  created_at: '2026-08-08T01:00:00Z',
});
const staleInspection = inspectRequiredStatusEvidence(staleEvidence);
assert.equal(staleInspection.ok, false, 'newer pending evidence must supersede old success');
assert.equal(staleInspection.reason, 'required_status_not_success');

const failedStatusEvidence = statusesFor();
failedStatusEvidence.push({
  ...failedStatusEvidence[1],
  id: 101,
  state: 'failure',
  created_at: '2026-08-08T01:00:01Z',
});
const failedInspection = inspectRequiredStatusEvidence(failedStatusEvidence);
assert.equal(failedInspection.ok, false);
assert.equal(failedInspection.reason, 'required_status_failed');

assert(
  applicationWorkflow.includes("APPLICATION_CHECKOUT_REF: ${{ github.event_name == 'workflow_dispatch' && (github.event.inputs.target_sha || github.sha) || github.ref }}"),
  'workflow_dispatch must bind checkout to target_sha or exact dispatch SHA',
);
assert(!applicationWorkflow.includes('APPLICATION_CHECKOUT_REF: ${{ github.event.inputs.checkout_ref || github.ref }}'), 'dispatch checkout must not be independently user-selectable');

assert(fallbackWorkflow.includes('latestRequiredStatuses'), 'fallback must derive exact CI ownership from statuses written on the target SHA');
assert(fallbackWorkflow.includes('listStatusBoundRuns'), 'fallback must bind candidate runs to exact target-SHA status URLs');
assert(fallbackWorkflow.includes('getWorkflowRun'), 'fallback must resolve status-owned run IDs before trusting workflow metadata');
assert(fallbackWorkflow.includes('inspectRequiredStatusEvidence'), 'fallback must require all six latest statuses from one run');
assert(fallbackWorkflow.includes('evaluateProductionCiProvenance'), 'fallback must reuse exact production CI provenance validation');
assert(fallbackWorkflow.includes('inputs: { target_sha: sha, checkout_ref: sha }'), 'fallback dispatch must bind target and checkout to the exact main SHA');
assert(fallbackWorkflow.includes('listActiveExactShaPushRuns'), 'fallback must discover an exact-SHA push run before creating a duplicate dispatch');
assert(fallbackWorkflow.includes('github.rest.actions.listWorkflowRuns'), 'fallback must query the official workflow directly for an active push run');
assert(fallbackWorkflow.includes("event: 'push'"), 'direct workflow discovery must be restricted to push events');
assert(fallbackWorkflow.includes("run.event === 'push'"), 'direct run filtering must reject workflow_dispatch head-SHA matches');
assert(fallbackWorkflow.includes('run.head_sha === sha'), 'direct push discovery must bind to the exact current main SHA');
assert(!fallbackWorkflow.includes('listWorkflowRunsForRepo'), 'fallback must not infer workflow_dispatch target ownership from repository-wide head_sha matching');

for (const workflow of [productionWorkflow, approvalWorkflow]) {
  assert(workflow.includes('production-ci-provenance.cjs'), 'production gates must use the shared provenance evaluator');
  assert(workflow.includes('inspectRequiredStatusEvidence'), 'production gates must bind six statuses to one CI run');
  assert(workflow.includes('evaluateProductionCiProvenance'), 'production gates must validate the exact Application CI run');
}
assert(productionWorkflow.includes('[[ "$TARGET_SHA" == "$MAIN_SHA" ]]'), 'production target must equal exact current main');
assert(!productionWorkflow.includes("event: 'push'\n              status: 'completed'"), 'production provenance lookup must not hard-code push-only evidence');

console.log('Production CI provenance contract verified.');
console.log('- Exact current main + same-run 6/6 + official push/workflow_dispatch success: accepted');
console.log('- Other/stale/PR/missing/pending/cancelled/failed/mismatched evidence: rejected');
console.log('- workflow_dispatch checkout is cryptographically bound to the status target SHA');
console.log('- main fallback waits for an active exact-SHA push run before dispatching a fallback CI');
console.log('- direct active-run discovery remains push-only; workflow_dispatch provenance still requires status ownership');