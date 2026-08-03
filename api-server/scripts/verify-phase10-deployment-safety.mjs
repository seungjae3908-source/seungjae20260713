import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
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
assert(/action:[\s\S]*?default:\s*preflight[\s\S]*?options:[\s\S]*?-\s*preflight[\s\S]*?-\s*deploy/.test(staging),
  'staging workflow must default to a non-mutating preflight and require explicit deploy selection');
assert(/Report every missing or invalid staging setting[\s\S]*?--preflight/.test(staging),
  'staging workflow must run the aggregate preflight verifier');
assert(/deploy-and-verify:[\s\S]*?if:\s*inputs\.action == 'deploy'/.test(staging),
  'staging deployment must not run unless deploy is explicitly selected');
assert(/Run full staging account and browser verification[\s\S]*?if:\s*inputs\.run_full_validation == true/.test(staging),
  'four-account browser validation must be an explicit full-validation step');
assert(/Run explicitly approved staging DB migration and rollback drill[\s\S]*?if:\s*inputs\.run_destructive_recovery_drill == true[\s\S]*?verify-phase8-db\.sh/.test(staging),
  'staging DB rollback drill must run only with explicit destructive approval');
assert(/Run destructive staging-only recovery and log-redaction drills[\s\S]*?if:\s*inputs\.run_destructive_recovery_drill == true[\s\S]*?--remote/.test(staging),
  'staging file deletion and recovery drills must run only with explicit destructive approval');
assert(staging.includes('STAGING_SUPABASE_URL'), 'full staging validation must support a staging-only Supabase URL');
assert(staging.includes('STAGING_SUPABASE_ANON_KEY'), 'full staging validation must support a staging publishable key');
assert(staging.includes('STAGING_SUPABASE_SECRET_KEY'), 'full staging validation must support a server-only Supabase key');
assert(staging.includes('scp -q'), 'staging runtime settings must be transferred through a temporary protected file');
assert(!staging.includes("printf 'TARGET_SHA=%q STAGING_BASE_URL=%q"), 'staging secrets must not be placed in the remote process command line');
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
assert(dispatchBridge.includes("flags.includes('--deploy') ? 'deploy' : 'preflight'"),
  'dispatch bridge must default to preflight and require an explicit deploy flag');
assert(dispatchBridge.includes("flags.includes('--full-validation')"),
  'dispatch bridge must parse explicit full-validation approval');
assert(dispatchBridge.includes("flags.includes('--destructive')"),
  'dispatch bridge must parse explicit destructive approval');
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
assert(dispatchBridge.includes('action: process.env.STAGING_ACTION'), 'dispatch bridge must forward preflight or deploy action');
assert(dispatchBridge.includes('run_full_validation: process.env.RUN_FULL_VALIDATION'),
  'dispatch bridge must forward full-validation approval');
assert(dispatchBridge.includes('run_destructive_recovery_drill: process.env.RUN_DESTRUCTIVE_RECOVERY_DRILL'),
  'dispatch bridge must forward destructive approval');
assert(dispatchBridge.includes('actions.createWorkflowDispatch'), 'dispatch bridge must use the workflow dispatch API');
assert(!dispatchBridge.includes('production-deploy.yml'), 'dispatch bridge must never target the production deployment workflow');
assert(!dispatchBridge.includes('/opt/stock-app'), 'dispatch bridge must never reference the production install path');
assert(!dispatchBridge.includes('PROD_'), 'dispatch bridge must never consume production secrets');
assert(!dispatchBridge.includes('STAGING_SSH_PRIVATE_KEY'), 'dispatch bridge must not read the staging private key');

assert(productionScript.includes('restore_backup'), 'production deploy script must retain automatic rollback');
assert(stagingScript.includes('checksums.sha256'), 'staging deploy script must create backup checksums');
assert(stagingScript.includes('flock --close --nonblock'), 'staging lock must not be inherited by long-lived child processes');
assert(stagingScript.includes('probe_health_url'), 'staging deployment and rollback health checks must retry');
assert(stagingScript.includes('STAGING_FAILPOINT'), 'staging deploy script must support an intentional post-promotion failure drill');
assert(stagingScript.includes('last-rollback-from'), 'staging deploy script must record rollback evidence');
assert(stagingScript.includes('last-rollback-to'), 'staging deploy script must record rollback destination evidence');
assert(stagingScript.includes('APP_ENV=staging'), 'staging deploy script must identify the environment');
assert(stagingScript.includes('DEPLOY_SHA='), 'staging deploy script must expose the deployed revision to the server');
assert(stagingScript.includes('VITE_SUPABASE_URL="$STAGING_SUPABASE_URL"'),
  'staging frontend build must receive the isolated Supabase URL only when configured');
assert(stagingScript.includes("'--env-file=.env.staging'"),
  'live PM2 process must load the protected staging runtime environment file');
assert(stagingScript.includes('pm2 startOrReload'),
  'staging PM2 process must be created or reloaded from the isolated config');
assert(!stagingScript.includes('STAGING_DATABASE_URL is required'),
  'minimal deployment must not require a database migration URL');
assert(!stagingScript.includes('STAGING_AI_API_KEY is required'),
  'minimal deployment must not require an external AI key');
assert(!stagingScript.includes('$RELEASE_DIR/api-server/.env.staging'), 'staging releases must not retain copied secret files');

assert(stagingVerifier.includes('staging setting name(s) need attention'),
  'staging preflight must aggregate every missing or invalid setting');
assert(stagingVerifier.includes('minimalDeployRequired'), 'staging verifier must define the minimal deployment requirements');
assert(stagingVerifier.includes('fullValidationRequired'), 'staging verifier must separate full account/browser requirements');
assert(stagingVerifier.includes('destructiveValidationRequired'), 'staging verifier must separate destructive database requirements');
assert(stagingVerifier.includes('AI API key is optional and was not required'),
  'staging verifier must report that an AI key is not required by current readiness checks');
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


const fullValidationNames = [
  'STAGING_SUPABASE_URL',
  'STAGING_SUPABASE_ANON_KEY',
  'STAGING_SUPABASE_SECRET_KEY',
  'STAGING_PENDING_EMAIL',
  'STAGING_PENDING_PASSWORD',
  'STAGING_ASSOCIATE_EMAIL',
  'STAGING_ASSOCIATE_PASSWORD',
  'STAGING_REGULAR_EMAIL',
  'STAGING_REGULAR_PASSWORD',
  'STAGING_ADMIN_EMAIL',
  'STAGING_ADMIN_PASSWORD',
];

const verifierPath = path.join(root, 'api-server/scripts/verify-phase10-staging-readiness.mjs');
const runPreflight = (extraEnv = {}) => spawnSync(process.execPath, [verifierPath, '--preflight'], {
  cwd: root,
  encoding: 'utf8',
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    STAGING_ACTION: 'preflight',
    STAGING_RUN_FULL_VALIDATION: 'false',
    STAGING_RUN_DESTRUCTIVE_RECOVERY_DRILL: 'false',
    ...extraEnv,
  },
});

const emptyPreflight = runPreflight();
assert(emptyPreflight.status !== 0, 'empty staging preflight must fail');
for (const name of ['STAGING_SSH_HOST', 'STAGING_SSH_USER', 'STAGING_SSH_PRIVATE_KEY', 'STAGING_BASE_URL']) {
  assert(emptyPreflight.stderr.includes(`- ${name}:`), `aggregate preflight did not report ${name}`);
}
const emptyReportedNames = emptyPreflight.stderr.split('\n').filter((line) => line.startsWith('- STAGING_'));
assert(emptyReportedNames.length === 4, 'minimal preflight must report all four missing setting names in one run');

const minimalPreflight = runPreflight({
  STAGING_SSH_HOST: '158.247.235.32',
  STAGING_SSH_USER: 'root',
  STAGING_SSH_PRIVATE_KEY: '-----BEGIN OPENSSH PRIVATE KEY-----\nstatic-ci-test-only\n-----END OPENSSH PRIVATE KEY-----',
  STAGING_BASE_URL: 'https://staging.example.invalid',
});
assert(minimalPreflight.status === 0, `minimal preflight should pass: ${minimalPreflight.stderr}`);
assert(minimalPreflight.stdout.includes('AI API key is optional and was not required'),
  'minimal preflight must state that the AI key is optional');

const fullPreflight = runPreflight({
  STAGING_ACTION: 'deploy',
  STAGING_RUN_FULL_VALIDATION: 'true',
  STAGING_SSH_HOST: '158.247.235.32',
  STAGING_SSH_USER: 'root',
  STAGING_SSH_PRIVATE_KEY: '-----BEGIN OPENSSH PRIVATE KEY-----\nstatic-ci-test-only\n-----END OPENSSH PRIVATE KEY-----',
  STAGING_BASE_URL: 'https://staging.example.invalid',
});
assert(fullPreflight.status !== 0, 'full validation preflight without full settings must fail');
for (const name of fullValidationNames) {
  assert(fullPreflight.stderr.includes(`- ${name}:`), `full validation preflight did not report ${name}`);
}

console.log('[phase10-deployment-safety] production remains manual-only; staging defaults to aggregate preflight; deployment, full browser validation, and destructive recovery are separate explicit scopes; minimal deployment does not require DB, AI, or test accounts; PM2 loads the protected staging env file; production approval remains on hold');
