import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const workflow = readFileSync(path.join(root, '.github/workflows/telegram-production-release.yml'), 'utf8');
const migrator = readFileSync(path.join(root, 'ops/apply-production-personal-telegram-storage.mjs'), 'utf8');
const cleanup = readFileSync(path.join(root, 'api-server/supabase/migrations/2026081502_personal_telegram_policy_cleanup.sql'), 'utf8');

function fail(message) {
  console.error(`[production-personal-telegram-storage-contract] ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function verifyStatic() {
  for (const marker of [
    'environment: production',
    'Apply and verify Production personal Telegram storage atomically',
    'production-personal-telegram-storage-${{ steps.command.outputs.sha }}',
    'ops/apply-production-personal-telegram-storage.mjs',
    'ops/verify-production-personal-telegram-storage.mjs --artifact',
    'PROD_DATABASE_URL: ${{ secrets.PROD_DATABASE_URL }}',
    'IFS= read -r PROD_DATABASE_URL && export PROD_DATABASE_URL',
    `printf '%s\\n' "$PROD_DATABASE_URL" | ssh`,
  ]) assert(workflow.includes(marker), `workflow is missing ${marker}`);

  const migrationIndex = workflow.indexOf('Apply and verify Production personal Telegram storage atomically');
  const deployIndex = workflow.indexOf('Dispatch existing Production Deploy and require exact-run success');
  assert(migrationIndex >= 0 && deployIndex > migrationIndex, 'storage migration must finish before Production deployment dispatch');
  assert(!/PROD_DATABASE_URL=%q/.test(workflow), 'database secret must not be embedded in the remote command line');
  assert(!/printf\s+'?%q'?\s+"?\$PROD_DATABASE_URL"?/.test(workflow), 'database secret must not be shell-escaped into argv');
  assert(!/echo\s+"?\$PROD_DATABASE_URL"?/.test(workflow), 'database secret must never be echoed');

  for (const marker of [
    "const PRODUCTION_PROJECT_REF = 'bawcbkoyovbeajkrnduq'",
    'PRODUCTION_ENV_ALLOWLIST',
    "'/opt/stock-app/.env'",
    "'/opt/stock-app/.env.production'",
    "'/opt/stock-app/api-server/.env'",
    "'/opt/stock-app/api-server/.env.production'",
    'lstatSync',
    'realpathSync',
    '(stat.mode & 0o022)',
    'readAllowedEnvValues',
    'process.env.PROD_DATABASE_URL',
    'transientProductionDatabaseUrl',
    'delete baseEnv.PROD_DATABASE_URL',
    "runtime.DEPLOY_SHA",
    'postgresUris.length !== 1',
    'stripOuterTransaction',
    "begin;",
    'pg_advisory_xact_lock',
    '2026081501_personal_telegram_storage.sql',
    '2026081502_personal_telegram_policy_cleanup.sql',
    "array['member_id', 'enabled_types']",
    "qual <> 'false'",
    "with_check <> 'false'",
    "privilege.grantee in ('PUBLIC', 'anon', 'authenticated')",
    "has_table_privilege('service_role'",
    "PGSSLMODE: 'require'",
    'credentials_recorded',
    'private_trading_api_count',
    'live_trading_authority',
  ]) assert(migrator.includes(marker), `migrator is missing ${marker}`);

  assert(!/\beval\s*\(/.test(migrator), 'migrator must not eval server env files');
  assert(!/(^|\n)\s*(?:source|\.)\s+[^\n]+\.env/m.test(migrator), 'migrator must not source server env files');
  assert(!migrator.includes('console.log(postgresUris'), 'migrator must not print database URLs');
  assert(!migrator.includes('console.log(database'), 'migrator must not print database connection details');
  assert(cleanup.includes("from pg_policy pol"), 'policy cleanup must enumerate legacy policies');
  assert(cleanup.includes('for all using (false) with check (false)'), 'policy cleanup must recreate only fail-closed policies');
  console.log('[production-personal-telegram-storage-contract] static safeguards verified');
}

function verifyArtifact(file, expectedTargetSha, expectedActiveSha) {
  assert(/^[0-9a-f]{40}$/.test(expectedTargetSha), 'expected target SHA is invalid');
  assert(/^[0-9a-f]{40}$/.test(expectedActiveSha), 'expected active SHA is invalid');
  const value = JSON.parse(readFileSync(path.resolve(file), 'utf8'));
  const valid = value?.status === 'passed'
    && value?.approved_target_sha === expectedTargetSha
    && value?.expected_active_sha === expectedActiveSha
    && value?.production_project_match === true
    && value?.atomic_transaction === true
    && value?.migrations_applied === 2
    && value?.tables_verified === 4
    && value?.canonical_preferences_verified === true
    && value?.api_roles_revoked === true
    && value?.policies_fail_closed === true
    && value?.database_changed === true
    && value?.credentials_recorded === false
    && value?.order_submitted === false
    && value?.private_trading_api_count === 0
    && value?.live_trading_authority === false;
  assert(valid, 'artifact does not satisfy the exact production storage contract');
  const serialized = JSON.stringify(value);
  assert(!/postgres(?:ql)?:\/\//i.test(serialized), 'artifact contains a database URL');
  assert(!/\b(?:password|token|secret|apikey|api_key)\b/i.test(serialized), 'artifact contains a secret-bearing field');
  console.log('[production-personal-telegram-storage-contract] sanitized artifact verified');
}

if (process.argv[2] === '--static') verifyStatic();
else if (process.argv[2] === '--artifact' && process.argv[3] && process.argv[4] && process.argv[5]) {
  verifyArtifact(process.argv[3], process.argv[4].toLowerCase(), process.argv[5].toLowerCase());
} else fail('usage: --static | --artifact <file> <target-sha> <active-sha>');