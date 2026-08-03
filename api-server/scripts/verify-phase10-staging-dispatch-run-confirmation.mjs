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
  'dispatch bridge must inspect existing target workflow runs');
assert(workflow.includes('existingActiveRun'),
  'dispatch bridge must detect an existing active run before dispatching');
assert(workflow.includes('Staging readiness dispatch was not duplicated.'),
  'existing active runs must be reported instead of duplicated');
assert(workflow.includes("const apiVersion = '2026-03-10';"),
  'dispatch bridge must pin the current GitHub Actions REST API version');
assert(workflow.includes('actions.createWorkflowDispatch'),
  'dispatch bridge must use the official workflow dispatch endpoint');
assert(workflow.includes('return_run_details: true'),
  'dispatch request must require the API to return workflow run details');
assert(workflow.includes("'X-GitHub-Api-Version': apiVersion"),
  'dispatch request must send the pinned GitHub API version header');
assert(workflow.includes("accept: 'application/vnd.github+json'"),
  'dispatch request must send the recommended GitHub JSON media type');
assert(workflow.includes('dispatchResponse.status !== 200'),
  'dispatch bridge must reject a response without the run-details status');
assert(workflow.includes('dispatchResponse.data?.workflow_run_id'),
  'dispatch bridge must read the exact Run ID from the API response');
assert(workflow.includes('Number.isSafeInteger(returnedRunId)'),
  'returned Run ID must be validated before use');
assert(workflow.includes('Staging readiness dispatch did not return workflow run details.'),
  'missing response details must produce an explicit failure report');
assert(workflow.includes('actions.getWorkflowRun'),
  'returned Run ID must be fetched and independently verified');
assert(workflow.includes("dispatchedRun.event === 'workflow_dispatch'"),
  'returned run must use the workflow_dispatch event');
assert(workflow.includes("dispatchedRun.head_branch === 'main'"),
  'returned run must use main');
assert(workflow.includes('dispatchedRun.head_sha === process.env.TARGET_SHA'),
  'returned run must match the exact requested current main SHA');
assert(workflow.includes('Staging readiness dispatch returned a mismatched workflow run.'),
  'mismatched returned run details must fail explicitly');
assert(workflow.includes('Staging readiness workflow run created.'),
  'success must be reported only after the returned Run ID is verified');
assert(!workflow.includes('Staging readiness dispatch accepted.'),
  'the old unverified acceptance message must not remain');
assert(!workflow.includes('const dispatchStartedAt = Date.now();'),
  'timestamp polling must not replace the direct Run ID response');
assert(!/for \(let attempt = 1; attempt <= 15; attempt \+= 1\)/.test(workflow),
  'the old polling-only correlation must be removed');
assert(workflow.includes('Run ID:'), 'confirmed target Run ID must be reported');
assert(workflow.includes('Bridge Run ID:'), 'bridge Run ID must be reported for source-log inspection');
assert(workflow.includes('actions.listJobsForWorkflowRun'), 'initial target Job IDs must be queried and reported');
assert(workflow.includes('job ID:'), 'target Job IDs must be included in the control comment');
assert(workflow.includes('Production deployment executed: `false`'),
  'every dispatch result must state that production was not executed');
assert(!workflow.includes('production-deploy.yml'), 'dispatch bridge must not target production');
assert(!workflow.includes('/opt/stock-app'), 'dispatch bridge must not reference the production path');
assert(!workflow.includes('PROD_'), 'dispatch bridge must not access production secrets');
assert(documentation.includes('`return_run_details: true`'),
  'documentation must explain direct Run ID response mode');
assert(documentation.includes('API version `2026-03-10`'),
  'documentation must record the pinned API version');
assert(documentation.includes('actual workflow Run ID'),
  'documentation must require actual target-run confirmation');
assert(documentation.includes('API acceptance is not deployment evidence'),
  'documentation must explain that API acceptance alone is insufficient');
assert(documentation.includes('exact current `main` SHA'),
  'documentation must state the immutable current-main requirement');
assert(documentation.includes('does not create a duplicate'),
  'documentation must describe active-run deduplication');

console.log('[phase10-staging-dispatch-run-confirmation] current Actions API must return the exact Run ID; stale SHA, unverified acceptance, polling-only correlation, and active-run duplication are rejected');
