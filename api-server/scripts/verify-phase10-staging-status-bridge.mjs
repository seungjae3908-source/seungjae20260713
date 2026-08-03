import { readFile } from 'node:fs/promises';
import path from 'node:path';

const cwd = process.cwd();
const root = path.basename(cwd) === 'api-server' ? path.resolve(cwd, '..') : path.resolve(cwd);
const read = (relative) => readFile(path.join(root, relative), 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(`[phase10-staging-status-bridge] ${message}`);
};

const workflow = await read('.github/workflows/staging-status-bridge.yml');
const documentation = await read('docs/staging-status-bridge.md');

assert(/issue_comment:\s*\n\s*types:\s*\[created\]/.test(workflow), 'newly created issue comments must be the only command event');
assert(!workflow.includes('pull_request_target'), 'privileged pull_request_target execution is forbidden');
assert(workflow.includes("github.event.issue.number == 23"), 'control issue must be exactly #23');
assert(workflow.includes("github.event.issue.pull_request == null"), 'pull request comments must be rejected');
assert(workflow.includes("github.event.issue.state == 'open'"), 'control issue must remain open');
assert(workflow.includes("github.event.issue.title == 'Staging Readiness Control'"), 'control issue title must be exact');
assert(workflow.includes("github.event.comment.user.login == 'seungjae3908-source'"), 'repository owner login must be exact');
assert(workflow.includes("github.event.comment.author_association == 'OWNER'"), 'GitHub OWNER association must be required');
assert(workflow.includes("startsWith(github.event.comment.body, '/status-staging ')"), 'unrelated owner comments must not start the status job');
assert(workflow.includes('/status-staging ([0-9a-fA-F]{40})'), 'status command must require an exact 40-character SHA');
assert(workflow.includes('git cat-file -e "$TARGET_SHA^{commit}"'), 'status query must resolve an immutable commit');
assert(workflow.includes('git merge-base --is-ancestor "$TARGET_SHA" origin/main'), 'status query SHA must be contained in current main');
assert(!workflow.includes('[[ "$TARGET_SHA" == "$MAIN_SHA" ]]'), 'status query must not require equality with current main because enabling the bridge changes main');
assert(workflow.includes("workflowId = 'staging-readiness.yml'"), 'only Staging Readiness may be queried');
assert(workflow.includes('actions.listWorkflowRunsForWorkflow'), 'workflow run list must be read through GitHub Actions API');
assert(workflow.includes('actions.listJobsForWorkflowRun'), 'job results must be read through GitHub Actions API');
assert(workflow.includes("run.event === 'workflow_dispatch'"), 'only workflow_dispatch runs may match');
assert(workflow.includes('run.head_sha === targetSha'), 'matching run must use the requested main-contained SHA');
assert(workflow.includes('job ID:'), 'job IDs must be reported for direct log inspection');
assert(workflow.includes('actions: read'), 'status job must use read-only Actions permission');
assert(workflow.includes('issues: write'), 'status job needs only issue-comment write permission');
assert(!workflow.includes('actions: write'), 'status bridge must never have Actions write permission');
assert(!workflow.includes('createWorkflowDispatch'), 'status bridge must never dispatch a workflow');
assert(!/github\.rest\.actions\.(?:reRun|rerun|cancel|approve)/i.test(workflow), 'status bridge must never rerun, cancel, or approve a workflow');
assert(!workflow.includes('cancelWorkflowRun'), 'status bridge must never cancel a workflow');
assert(!workflow.includes('production-deploy.yml'), 'production workflow must be unreachable');
assert(!workflow.includes('/opt/stock-app'), 'production install path must be unreachable');
assert(!workflow.includes('PROD_'), 'production secrets must be unreachable');
assert(!workflow.includes('STAGING_SSH_'), 'staging SSH secrets must be unreachable');
assert(!workflow.includes('STAGING_DATABASE_URL'), 'staging database secret must be unreachable');
assert(documentation.includes('/status-staging <exact-40-character-main-contained-sha>'), 'documentation must show the exact command');
assert(documentation.includes('read-only'), 'documentation must state the read-only boundary');
assert(documentation.includes('does not dispatch'), 'documentation must state that no workflow is dispatched');
assert(documentation.includes('contained in current `main`'), 'documentation must explain the historical main SHA safety rule');

console.log('[phase10-staging-status-bridge] owner-only main-contained status lookup is read-only; staging and production cannot be modified');
