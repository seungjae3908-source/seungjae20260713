import nodeAssert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  parseStagingPostgresAuthCommand,
  requireRepositoryOwner,
} from './staging-postgres-auth-command.mjs';

const root = path.basename(process.cwd()) === 'api-server'
  ? path.resolve(process.cwd(), '..')
  : path.resolve(process.cwd());
const read = (relative) => readFile(path.join(root, relative), 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(`[staging-postgres-auth-contract] ${message}`);
};

const workflow = await read('.github/workflows/staging-postgres-auth-gate.yml');
const stagingReadiness = await read('.github/workflows/staging-readiness.yml');
const paperCertification = await read('.github/workflows/paper-forward-schedule-no-deploy-activation.yml');
const commandParser = await read('api-server/scripts/staging-postgres-auth-command.mjs');
const probe = await read('api-server/scripts/verify-staging-postgres-auth.mjs');

const validSha = 'a'.repeat(40);
nodeAssert.deepEqual(
  parseStagingPostgresAuthCommand(`/run-staging-auth-only ${validSha.toUpperCase()}`),
  { mode: 'auth-only', sha: validSha },
  'TEST A: auth-only command must select auth-only mode and normalize the exact SHA',
);
nodeAssert.deepEqual(
  parseStagingPostgresAuthCommand(`/run-staging-auth ${validSha}`),
  { mode: 'staging', sha: validSha },
  'TEST B: existing staging command must preserve staging mode',
);
requireRepositoryOwner('seungjae3908-source', 'OWNER');
nodeAssert.throws(
  () => requireRepositoryOwner('not-the-owner', 'COLLABORATOR'),
  /Only the repository owner/,
  'TEST E: non-owner command must fail closed',
);
for (const malformed of [
  '/run-staging-auth-only',
  '/run-staging-auth-only invalid-sha',
  `/run-staging-auth-only ${validSha} extra`,
  `/run-staging-auth-only  ${validSha}`,
]) {
  nodeAssert.throws(
    () => parseStagingPostgresAuthCommand(malformed),
    /Exact command required/,
    `TEST H: malformed command must fail closed: ${malformed}`,
  );
}

for (const marker of [
  "startsWith(github.event.comment.body, '/run-staging-auth ')",
  "startsWith(github.event.comment.body, '/run-staging-auth-only ')",
  'Run one read-only PostgreSQL authentication probe',
  'STAGING_AUTH_MODE: ${{ steps.command.outputs.mode }}',
  "process.env.COMMAND_MODE !== 'auth-only'",
  'Auth-only Required CI 6/6 does not share one coherent provenance run.',
  'Auth-only Required CI provenance is not an exact successful target run.',
  'Paper-only PostgreSQL authentication succeeded without Staging dispatch.',
  '- Full Staging validation dispatched: `false`',
  '- Paper activation executed: `false`',
  "if: always() && steps.auth.outcome != 'skipped'",
  "if: always() && steps.command.outcome == 'success' && steps.auth.outcome != 'skipped'",
  "workflow_id: 'staging-readiness.yml'",
  "action: 'deploy'",
  "run_full_validation: 'true'",
  "run_destructive_recovery_drill: 'false'",
  'Staging deployment dispatched: `false`',
  'Production deployment executed: `false`',
]) {
  assert(workflow.includes(marker), `workflow is missing ${marker}`);
}

for (const marker of [
  '/run-staging-auth <40-character-current-main-sha>',
  '/run-staging-auth-only <40-character-current-main-sha>',
  "mode: match[1] === '-only' ? 'auth-only' : 'staging'",
  'mode=${command.mode}',
]) {
  assert(commandParser.includes(marker), `command parser is missing ${marker}`);
}

const authIndex = workflow.indexOf('Run one read-only PostgreSQL authentication probe');
const commandIndex = workflow.indexOf('Parse exact owner command');
const exactShaIndex = workflow.indexOf('Require exact current main SHA');
const requiredCiIndex = workflow.indexOf('Require successful verified main CI');
const dispatchIndex = workflow.indexOf("workflow_id: 'staging-readiness.yml'");
assert(commandIndex >= 0 && commandIndex < exactShaIndex, 'owner and exact-command validation must execute first');
assert(exactShaIndex < requiredCiIndex, 'TEST C: stale SHA must stop before Required CI and the PostgreSQL probe');
assert(requiredCiIndex < authIndex, 'TEST D: incomplete Required CI must stop before the PostgreSQL probe');
assert(authIndex >= 0 && dispatchIndex > authIndex, 'staging dispatch must occur only after the authentication probe');
const authOnlySuccessIndex = workflow.indexOf('if (authOnly) {');
const authOnlyReturnIndex = workflow.indexOf('              return;', authOnlySuccessIndex);
assert(authOnlySuccessIndex > authIndex, 'auth-only success branch must follow the authentication proof');
assert(authOnlyReturnIndex > authOnlySuccessIndex && authOnlyReturnIndex < dispatchIndex, 'TEST G: auth-only success must return before Staging dispatch');
assert((workflow.match(/workflow_id: 'staging-readiness\.yml'/g) ?? []).length === 1, 'existing Staging dispatch must remain singular');
assert(workflow.includes("process.env.AUTH_OUTCOME !== 'success' || !verified"), 'TEST F: authentication failure must fail before either success branch');
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
  'transaction_rolled_back: true',
  'transaction_rolled_back: false',
  'database_changed: false',
  'credentials_recorded: false',
  "mode: 'auth-only'",
  'stagingDeploymentDispatched: false',
  'fullStagingValidationDispatched: false',
  'productionDeploymentExecuted: false',
  'databaseChanged: false',
  'secretChanged: false',
  'environmentChanged: false',
  'paperActivationExecuted: false',
  'production_project_rejected',
]) {
  assert(probe.includes(marker), `probe is missing ${marker}`);
}
assert(!probe.includes('console.log(target.password)'), 'probe must not print the database password');
assert(!probe.includes('console.log(env.STAGING_DATABASE_URL)'), 'probe must not print the database URL');

for (const marker of [
  "run.name !== 'Staging PostgreSQL Auth Gate'",
  "run.path !== '.github/workflows/staging-postgres-auth-gate.yml'",
  "run.conclusion !== 'success'",
  'staging-postgres-auth-${target}',
  'item.workflow_run?.head_sha === target',
]) {
  assert(paperCertification.includes(marker), `Paper certification consumer is missing ${marker}`);
}

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
