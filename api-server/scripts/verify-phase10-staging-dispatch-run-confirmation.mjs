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

assert(workflow.includes("startsWith(github.event.comment.body, '/run-staging ')"), 'unrelated owner comments must not start the dispatch job');
assert(workflow.includes('Require exact current main SHA'), 'state-changing staging dispatch must require the exact current main revision');
assert(workflow.includes('MAIN_SHA="$(git rev-parse origin/main^{commit})"'), 'dispatch bridge must resolve current main immediately before dispatch');
assert(workflow.includes('[[ "$TARGET_SHA" == "$MAIN_SHA" ]]'), 'dispatch bridge must reject stale main revisions');
assert(workflow.includes("flags.includes('--full-validation')"), 'dispatch bridge must parse full validation');
assert(workflow.includes("action === 'deploy' && !full"), 'every deploy command must require full validation');
assert(workflow.includes('Every deploy candidate requires --full-validation.'), 'missing full validation must fail explicitly');
assert(workflow.includes('actions.listWorkflowRunsForRepo'), 'active-run lookup must use repository workflow runs');
assert(workflow.includes('existingActiveRun'), 'dispatch bridge must detect an existing active run');
assert(workflow.includes('Staging readiness dispatch was not duplicated.'), 'existing active runs must not be duplicated');
assert(workflow.includes("const apiVersion = '2026-03-10';"), 'dispatch bridge must pin the Actions API version');
assert(workflow.includes('actions.createWorkflowDispatch'), 'dispatch bridge must use workflow dispatch');
assert(workflow.includes('return_run_details: true'), 'dispatch must require direct Run details');
assert(workflow.includes("'X-GitHub-Api-Version': apiVersion"), 'dispatch must send the pinned API version');
assert(workflow.includes("accept: 'application/vnd.github+json'"), 'dispatch must send the recommended media type');
assert(workflow.includes('dispatchResponse.data?.workflow_run_id'), 'dispatch must read the exact Run ID');
assert(workflow.includes('Number.isSafeInteger(runId)'), 'returned Run ID must be validated');
assert(workflow.includes('actions.getWorkflowRun'), 'returned Run ID must be independently verified');
assert(workflow.includes("run.event === 'workflow_dispatch'"), 'returned run must use workflow_dispatch');
assert(workflow.includes("run.head_branch === 'main'"), 'returned run must use main');
assert(workflow.includes('run.head_sha === process.env.TARGET_SHA'), 'returned run must match the exact SHA');
assert(workflow.includes("run.path === '.github/workflows/staging-readiness.yml'"), 'returned run must be the official staging workflow');
assert(workflow.includes('Staging readiness workflow run created.'), 'success must be reported only after Run verification');
assert(workflow.includes('Full account/browser validation:'), 'control comment must report full validation');
assert(workflow.includes('Production deployment executed: `false`'), 'dispatch results must state production was not executed');
assert(!workflow.includes('production-deploy.yml'), 'dispatch bridge must not target production');
assert(!workflow.includes('/opt/stock-app'), 'dispatch bridge must not reference the production path');
assert(!workflow.includes('PROD_'), 'dispatch bridge must not access production secrets');
assert(documentation.includes('--deploy --full-validation'), 'documentation must require full validation for deployment');
assert(documentation.includes('A deployment command without `--full-validation` is rejected'), 'documentation must explain the mandatory release gate');
assert(documentation.includes('API version `2026-03-10`'), 'documentation must record the pinned API version');
assert(documentation.includes('actual workflow Run ID'), 'documentation must require direct target-run confirmation');
assert(documentation.includes('API acceptance is not deployment evidence'), 'documentation must reject API acceptance as deployment evidence');
assert(documentation.includes('exact current `main` SHA'), 'documentation must state the immutable current-main requirement');
assert(documentation.includes('does not create a duplicate'), 'documentation must describe active-run deduplication');

console.log('[phase10-staging-dispatch-run-confirmation] deploy commands require full validation; exact current main, direct Run ID confirmation, and active-run deduplication are enforced');
