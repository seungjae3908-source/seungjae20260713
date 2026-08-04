import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.basename(process.cwd()) === 'api-server'
  ? path.resolve(process.cwd(), '..')
  : path.resolve(process.cwd());
const read = (relative) => readFile(path.join(root, relative), 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(`[staging-postgres-auth-contract] ${message}`);
};

const workflow = await read('.github/workflows/staging-postgres-auth-gate.yml');
const stagingReadiness = await read('.github/workflows/staging-readiness.yml');
const probe = await read('api-server/scripts/verify-staging-postgres-auth.mjs');

for (const marker of [
  "startsWith(github.event.comment.body, '/run-staging-auth ')",
  '/run-staging-auth <40-character-current-main-sha>',
  'Run one read-only PostgreSQL authentication probe',
  "workflow_id: 'staging-readiness.yml'",
  "action: 'deploy'",
  "run_full_validation: 'true'",
  "run_destructive_recovery_drill: 'false'",
  'Staging deployment dispatched: `false`',
  'Production deployment executed: `false`',
]) {
  assert(workflow.includes(marker), `workflow is missing ${marker}`);
}

const authIndex = workflow.indexOf('Run one read-only PostgreSQL authentication probe');
const dispatchIndex = workflow.indexOf("workflow_id: 'staging-readiness.yml'");
assert(authIndex >= 0 && dispatchIndex > authIndex, 'staging dispatch must occur only after the authentication probe');
assert(!workflow.includes('production-deploy.yml'), 'authentication gate must not dispatch production');

for (const marker of [
  'begin read only;',
  'rollback;',
  "PGSSLMODE: 'require'",
  "return 'password_rejected'",
  "return 'username_format'",
  "return 'pooler_dns'",
  "return 'pooler_timeout'",
  "return 'pooler_connection'",
  "return 'pooler_tls'",
  'database_changed: false',
  'credentials_recorded: false',
  'production_project_rejected',
]) {
  assert(probe.includes(marker), `probe is missing ${marker}`);
}
assert(!probe.includes('console.log(target.password)'), 'probe must not print the database password');
assert(!probe.includes('console.log(env.STAGING_DATABASE_URL)'), 'probe must not print the database URL');

const deployJobStart = stagingReadiness.indexOf('  deploy-and-verify:');
assert(deployJobStart >= 0, 'staging readiness deploy job is missing');
const deployJob = stagingReadiness.slice(deployJobStart);
assert(deployJob.includes('node-version: "22"'), 'staging account lifecycle must run on Node.js 22');
assert(
  deployJob.includes('Require Node 22+ for Supabase ephemeral account lifecycle'),
  'staging readiness must fail closed when the account lifecycle runtime is older than Node.js 22',
);
assert(
  deployJob.indexOf('Require Node 22+ for Supabase ephemeral account lifecycle')
    < deployJob.indexOf('Run complete anonymous and four-account browser validation'),
  'Node.js runtime guard must execute before the staging account and browser lifecycle',
);

console.log('[staging-postgres-auth-contract] exact-SHA owner gate, read-only authentication, Node 22 account lifecycle, redacted diagnostics, success-only staging dispatch, and production isolation verified');
