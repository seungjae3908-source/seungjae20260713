import { readFile } from 'node:fs/promises';
import path from 'node:path';

const cwd = process.cwd();
const root = path.basename(cwd) === 'api-server' ? path.resolve(cwd, '..') : path.resolve(cwd);
const read = (relative) => readFile(path.join(root, relative), 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(`[phase10-staging-dispatch-run-confirmation] ${message}`);
};

const workflow = await read('.github/workflows/staging-dispatch-bridge.yml');
const documentation = await read('docs/staging-dispatch-bridge.md');

assert(workflow.includes("startsWith(github.event.comment.body, '/run-staging ')"),
  'unrelated owner comments must not start the dispatch job');
assert(workflow.includes('Require exact current main SHA'),
  'state-changing staging dispatch must require the exact current main revision');
assert(workflow.includes('MAIN_SHA="$(git rev-parse origin/main^{commit})"'),
  'dispatch bridge must resolve current main immediately before dispatch');
assert(workflow.includes('[[ "$TARGET_SHA" == "$MAIN_SHA" ]]'),
  'dispatch bridge must reject stale or historical main revisions');
assert(workflow.includes('actions.listWorkflowRunsForWorkflow'),
  'dispatch bridge must query the target workflow run list');
assert(workflow.includes("run.event === 'workflow_dispatch' && run.head_sha === process.env.TARGET_SHA"),
  'run confirmation must match the exact workflow event and target SHA');
assert(workflow.includes('existingActiveRun'),
  'dispatch bridge must detect an existing active run before dispatching');
assert(workflow.includes('Staging readiness dispatch was not duplicated.'),
  'existing active runs must be reported instead of duplicated');
assert(workflow.includes('const dispatchStartedAt = Date.now();'),
  'dispatch bridge must establish a run-correlation timestamp');
assert(workflow.includes('actions.createWorkflowDispatch'),
  'dispatch bridge must still use the official workflow dispatch API');
assert(workflow.includes('Date.parse(run.created_at) >= dispatchStartedAt - 5000'),
  'confirmed run must have materialized after the dispatch request');
assert(/for \(let attempt = 1; attempt <= 15; attempt \+= 1\)/.test(workflow),
  'dispatch bridge must poll for delayed workflow-run materialization');
assert(workflow.includes('Staging readiness dispatch failed to materialize a workflow run.'),
  'missing target workflow runs must produce an explicit failure report');
assert(workflow.includes("core.setFailed('Dispatch API returned without error, but no matching Staging Readiness workflow run was created.')"),
  'API acceptance without a materialized run must fail the bridge');
assert(workflow.includes('Staging readiness workflow run created.'),
  'success must be reported only after a real run is found');
assert(!workflow.includes('Staging readiness dispatch accepted.'),
  'the old unverified acceptance message must not remain');
assert(workflow.includes('Run ID:'), 'confirmed target Run ID must be reported');
assert(workflow.includes('Bridge Run ID:'), 'bridge Run ID must be reported for source-log inspection');
assert(workflow.includes('actions.listJobsForWorkflowRun'), 'initial target Job IDs must be queried and reported');
assert(workflow.includes('job ID:'), 'target Job IDs must be included in the control comment');
assert(workflow.includes('Production deployment executed: `false`'),
  'every dispatch result must state that production was not executed');
assert(!workflow.includes('production-deploy.yml'), 'dispatch bridge must not target production');
assert(!workflow.includes('/opt/stock-app'), 'dispatch bridge must not reference the production path');
assert(!workflow.includes('PROD_'), 'dispatch bridge must not access production secrets');
assert(documentation.includes('actual workflow Run ID'),
  'documentation must require actual target-run confirmation');
assert(documentation.includes('API acceptance is not deployment evidence'),
  'documentation must explain that API acceptance alone is insufficient');
assert(documentation.includes('exact current `main` SHA'),
  'documentation must state the immutable current-main requirement');
assert(documentation.includes('does not create a duplicate'),
  'documentation must describe active-run deduplication');

console.log('[phase10-staging-dispatch-run-confirmation] dispatch success requires an actual target Run ID; stale SHA, unverified acceptance, and active-run duplication are rejected');
