import { readFile } from 'node:fs/promises';
import path from 'node:path';

const cwd = process.cwd();
const root = path.basename(cwd) === 'api-server' ? path.resolve(cwd, '..') : path.resolve(cwd);
const read = (relative) => readFile(path.join(root, relative), 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(`[phase10-deployment-safety] ${message}`);
};

const production = await read('.github/workflows/production-deploy.yml');
const staging = await read('.github/workflows/staging-readiness.yml');
const dispatchBridge = await read('.github/workflows/staging-dispatch-bridge.yml');
const productionScript = await read('ops/deploy-production.sh');
const stagingScript = await read('ops/deploy-staging.sh');
const stagingVerifier = await read('api-server/scripts/verify-phase10-staging-readiness.mjs');

assert(/workflow_dispatch:/.test(production), 'production workflow must support explicit workflow dispatch');
assert(!/\n\s*push:\s*\n\s*branches:\s*\n\s*-\s*main\b/.test(production), 'production workflow must not deploy on main push');
assert(/\^\[0-9a-fA-F\]\{40\}\$/.test(production), 'production workflow must require an exact 40-character SHA');
assert(/merge-base --is-ancestor/.test(production), 'production workflow must require the target SHA to be contained in main');
for (const status of [
  'application-ci/verified',
  'browser-ui/verified',
  'database-rls/verified',
  'security-integration/verified',
  'ai-privacy/verified',
  'futures-public-network-smoke/verified',
]) {
  assert(production.includes(status), `production workflow is missing required status ${status}`);
}
assert(production.includes('actions.listWorkflowRunsForRepo'), 'production gate must verify CI workflow-run provenance, not only status contexts');
assert(production.includes("run.name === 'Application CI'"), 'production gate must require the Application CI workflow');
assert(production.includes("run.head_branch === 'main'"), 'production gate must require a main-branch run');
assert(production.includes("run.event === 'push'"), 'production gate must require a main push event');
assert(/environment:\s*production/.test(production), 'production job must use the GitHub production environment');
assert(!/STAGING_/.test(production), 'production workflow must not consume staging secrets');
assert(!/PROD_/.test(staging), 'staging workflow must not consume production secrets');
assert(!staging.includes('/opt/stock-app'), 'staging workflow must not use the production install path');
assert(!staging.includes('PM2_NAME=stock-app'), 'staging workflow must not use the production PM2 process');
assert(!staging.includes('https://lsj119.duckdns.org'), 'staging workflow must not use the production URL');
assert(staging.includes('/srv/seungjae-staging'), 'staging workflow must use the isolated staging path');
assert(staging.includes('STAGING_DATABASE_URL'), 'staging workflow must require a staging database');
assert(staging.includes('STAGING_AI_API_KEY'), 'staging workflow must require a server-side staging AI key');
assert(/run_destructive_recovery_drill:[\s\S]*?default:\s*false/.test(staging), 'staging workflow must default destructive recovery to false');
assert(!staging.includes('Require explicit destructive drill consent'), 'staging workflow must not force the destructive recovery drill');
assert(/Run explicitly approved staging DB migration and rollback drill[\s\S]*?if:\s*inputs\.run_destructive_recovery_drill == true[\s\S]*?verify-phase8-db\.sh/.test(staging), 'staging DB rollback drill must run only with explicit destructive approval');
assert(/Run destructive staging-only recovery and log-redaction drills[\s\S]*?if:\s*inputs\.run_destructive_recovery_drill == true[\s\S]*?--remote/.test(staging), 'staging file deletion and recovery drills must run only with explicit destructive approval');
assert(staging.includes('scp -q'), 'staging secrets must be transferred through a temporary protected file');
assert(!staging.includes("printf 'TARGET_SHA=%q STAGING_BASE_URL=%q STAGING_DATABASE_URL=%q STAGING_AI_API_KEY=%q"), 'staging secrets must not be placed in the remote process command line');
assert(!staging.includes('운영 배포 승인 가능'), 'staging success alone must never grant production approval');
assert(staging.includes('운영 배포 승인 보류'), 'staging workflow must keep production approval on hold pending direct environment verification');

assert(/issue_comment:\s*\n\s*types:\s*\[created\]/.test(dispatchBridge), 'dispatch bridge must accept newly created issue comments only');
assert(!dispatchBridge.includes('pull_request_target'), 'dispatch bridge must never execute privileged code through pull_request_target');
assert(dispatchBridge.includes("github.event.issue.number == 23"), 'dispatch bridge must be restricted to control issue #23');
assert(dispatchBridge.includes("github.event.issue.pull_request == null"), 'dispatch bridge must reject pull request comments');
assert(dispatchBridge.includes("github.event.issue.state == 'open'"), 'dispatch bridge must require the control issue to remain open');
assert(dispatchBridge.includes("github.event.issue.title == 'Staging Readiness Control'"), 'dispatch bridge must require the exact control issue title');
assert(dispatchBridge.includes("github.event.comment.user.login == 'seungjae3908-source'"), 'dispatch bridge must require the repository owner login');
assert(dispatchBridge.includes("github.event.comment.author_association == 'OWNER'"), 'dispatch bridge must require OWNER author association');
assert(dispatchBridge.includes('/run-staging ([0-9a-fA-F]{40})( --destructive)?'), 'dispatch bridge must default to non-destructive staging and accept only the explicit destructive flag');
assert(dispatchBridge.includes("destructive=${match[2] ? 'true' : 'false'}"), 'dispatch bridge must derive destructive approval only from the explicit flag');
assert(dispatchBridge.includes('git merge-base --is-ancestor'), 'dispatch bridge must require a SHA contained in main');
assert(dispatchBridge.includes('actions: write'), 'dispatch job must explicitly request Actions write permission');
assert(dispatchBridge.includes('issues: write'), 'dispatch job must explicitly request issue comment permission');
assert(dispatchBridge.includes('statuses: read'), 'dispatch bridge must read verified status contexts');
assert(dispatchBridge.includes('actions.listWorkflowRunsForRepo'), 'dispatch bridge must verify CI workflow-run provenance');
for (const status of [
  'application-ci/verified',
  'browser-ui/verified',
  'database-rls/verified',
  'security-integration/verified',
  'ai-privacy/verified',
  'futures-public-network-smoke/verified',
]) {
  assert(dispatchBridge.includes(status), `dispatch bridge is missing required status ${status}`);
}
assert(dispatchBridge.includes("workflowId = 'staging-readiness.yml'"), 'dispatch bridge must target only the staging readiness workflow');
assert(dispatchBridge.includes("ref: 'main'"), 'dispatch bridge must dispatch the workflow from main');
assert(dispatchBridge.includes('run_destructive_recovery_drill: process.env.RUN_DESTRUCTIVE_RECOVERY_DRILL'), 'dispatch bridge must forward the parsed destructive approval state');
assert(!dispatchBridge.includes("run_destructive_recovery_drill: 'true'"), 'dispatch bridge must not force the destructive staging drill');
assert(dispatchBridge.includes('actions.createWorkflowDispatch'), 'dispatch bridge must use the workflow dispatch API');
assert(!dispatchBridge.includes('production-deploy.yml'), 'dispatch bridge must never target the production deployment workflow');
assert(!dispatchBridge.includes('/opt/stock-app'), 'dispatch bridge must never reference the production install path');
assert(!dispatchBridge.includes('PROD_'), 'dispatch bridge must never consume production secrets');
assert(!dispatchBridge.includes('STAGING_'), 'dispatch bridge must not read staging secrets; the target staging workflow owns them');

assert(productionScript.includes('restore_backup'), 'production deploy script must retain automatic rollback');
assert(stagingScript.includes('checksums.sha256'), 'staging deploy script must create backup checksums');
assert(stagingScript.includes('flock --close --nonblock'), 'staging lock must not be inherited by long-lived child processes');
assert(stagingScript.includes('probe_health_url'), 'staging deployment and rollback health checks must retry');
assert(stagingScript.includes('STAGING_FAILPOINT'), 'staging deploy script must support an intentional post-promotion failure drill');
assert(stagingScript.includes('last-rollback-from'), 'staging deploy script must record rollback evidence');
assert(stagingScript.includes('last-rollback-to'), 'staging deploy script must record rollback destination evidence');
assert(stagingScript.includes('APP_ENV=staging'), 'staging deploy script must identify the environment');
assert(stagingScript.includes('DEPLOY_SHA='), 'staging deploy script must expose the deployed revision to the server');
assert(!stagingScript.includes('$RELEASE_DIR/api-server/.env.staging'), 'staging releases must not retain copied secret files');
assert(!/TRADING_REVIEW_API_KEY[^\n]*(?:echo|summary)/i.test(stagingScript), 'staging AI secret must not be printed');
for (const marker of [
  'damaged_backup_rejected=true',
  'delete_restore=true',
  'failed_deploy_rollback=true',
  'previous_sha_recovery=true',
  'same_sha_redeploy=true',
  'logs_scanned=',
]) {
  assert(stagingVerifier.includes(marker), `staging verifier is missing required evidence marker ${marker}`);
}
assert(stagingVerifier.includes('no staging log files were available for inspection'), 'missing logs must fail rather than count as a clean scan');
assert(stagingVerifier.includes('configured staging secret or personal value found in logs'), 'known staging secrets and personal values must be checked in logs');

console.log('[phase10-deployment-safety] production is manual-only; staging dispatch is owner-only through control issue #23; verified main-push CI provenance is required; staging secrets remain isolated; destructive recovery is explicit opt-in and defaults to skipped; production approval remains on hold');
