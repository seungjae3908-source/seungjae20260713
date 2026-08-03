import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const read = (relative) => readFile(path.join(root, relative), 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(`[staging-bootstrap-contract] ${message}`);
};

const manifest = await read('api-server/supabase/bootstrap/staging-bootstrap.sql');
const guard = await read('api-server/supabase/bootstrap/staging-empty-project-guard.sql');
const assertion = await read('api-server/supabase/bootstrap/staging-bootstrap-assert.sql');
const runner = await read('api-server/scripts/bootstrap-staging-supabase.mjs');
const remoteVerifier = await read('api-server/scripts/verify-staging-supabase-schema.mjs');
const workflow = await read('.github/workflows/staging-supabase-bootstrap.yml');
const dbVerifier = await read('api-server/scripts/verify-phase8-db.sh');
const authHarness = await read('api-server/supabase/test/staging_bootstrap_auth_harness.sql');

const orderedIncludes = [
  'staging-empty-project-guard.sql',
  '20260716_full_schema_idempotent.sql',
  '../schema.sql',
  '20260717_fix_profiles_rls_recursion.sql',
  '2026080201_journal_sync_analytics_phase7.sql',
  '2026080202_release_candidate_permissions_phase8.sql',
  '2026080203_phase8_paper_capability_rls.sql',
  '2026080301_trade_automation_integration.sql',
  'staging-bootstrap-assert.sql',
];
let lastIndex = -1;
for (const item of orderedIncludes) {
  const index = manifest.indexOf(item);
  assert(index > lastIndex, `bootstrap manifest order is missing or unsafe at ${item}`);
  lastIndex = index;
}
assert(manifest.includes('\\set ON_ERROR_STOP on'), 'bootstrap manifest must stop on the first SQL error');

assert(guard.includes("to_regclass('auth.users')"), 'empty-project guard must require auth.users');
assert(guard.includes('auth_user_count <> 0'), 'empty-project guard must reject existing Auth users');
assert(guard.includes('profile_count <> 0'), 'empty-project guard must reject existing profile rows');
assert(guard.includes("'(prod|production)'" ) || guard.includes('(prod|production)'), 'empty-project guard must reject production-looking database names');

for (const marker of [
  "'profiles'",
  "'paper_journal_entries'",
  "'member_permission_audit'",
  "'trade_order_plans'",
  "public.handle_new_user()",
  "public.current_membership_level()",
  'on_auth_user_created',
  'profiles_membership_level_check',
  'relrowsecurity',
  'auth_user_count <> 0 or profile_count <> 0',
]) {
  assert(assertion.includes(marker), `bootstrap assertion is missing ${marker}`);
}

for (const marker of [
  'bawcbkoyovbeajkrnduq',
  'STAGING_DATABASE_URL does not match STAGING_SUPABASE_URL project ref',
  'STAGING_DATABASE_URL is required for one-time remote staging bootstrap',
  "spawnSync('psql'",
  "replaceAll(databaseUrl, '[REDACTED]')",
]) {
  assert(runner.includes(marker), `bootstrap runner is missing ${marker}`);
}
assert(!runner.includes('console.log(databaseUrl)'), 'bootstrap runner must not log the database URL');

for (const marker of [
  'workflow_dispatch:',
  'environment: staging',
  'confirm_empty_isolated_project',
  'STAGING_SUPABASE_URL',
  'STAGING_SUPABASE_ANON_KEY',
  'STAGING_SUPABASE_SECRET_KEY',
  'STAGING_DATABASE_URL',
  'bootstrap-staging-supabase.mjs',
  'verify-staging-supabase-schema.mjs',
  'Production Supabase used: `false`',
  'Staging application deployed: `false`',
]) {
  assert(workflow.includes(marker), `bootstrap workflow is missing ${marker}`);
}
for (const forbidden of ['production-deploy.yml', '/srv/', 'pm2 ', 'ssh ', 'scp ', 'STAGING_SSH_']) {
  assert(!workflow.includes(forbidden), `bootstrap workflow must not contain ${forbidden}`);
}

for (const marker of [
  'staging_bootstrap_auth_harness.sql',
  'bootstrap-staging-supabase.mjs',
  'STAGING_BOOTSTRAP_CI=true',
]) {
  assert(dbVerifier.includes(marker), `disposable database verifier is missing ${marker}`);
}
assert(authHarness.includes("create table if not exists auth.users"), 'bootstrap Auth harness must create auth.users');
assert(authHarness.includes("raw_user_meta_data jsonb"), 'bootstrap Auth harness must support profile trigger metadata');
assert(!authHarness.includes('insert into auth.users'), 'empty bootstrap Auth harness must not seed users');

for (const marker of [
  'bawcbkoyovbeajkrnduq',
  '/rest/v1/profiles?',
  '/rest/v1/paper_journal_entries?',
  '/rest/v1/trade_order_plans?',
  '/rest/v1/trade_system_controls?',
]) {
  assert(remoteVerifier.includes(marker), `remote schema verifier is missing ${marker}`);
}

console.log('[staging-bootstrap-contract] empty-project guard, schema order, RLS assertions, CI idempotency, credential redaction, and staging-only workflow verified');
