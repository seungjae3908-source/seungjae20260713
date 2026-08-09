import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.basename(process.cwd()) === 'api-server'
  ? path.resolve(process.cwd(), '..')
  : path.resolve(process.cwd());
const read = (relative) => readFile(path.join(root, relative), 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(`[staging-bootstrap-contract] ${message}`);
};

const manifest = await read('api-server/supabase/bootstrap/staging-bootstrap.sql');
const guard = await read('api-server/supabase/bootstrap/staging-empty-project-guard.sql');
const base = await read('api-server/supabase/bootstrap/staging-allowlist-base.sql');
const assertion = await read('api-server/supabase/bootstrap/staging-bootstrap-assert.sql');
const runner = await read('api-server/scripts/apply-staging-supabase-bootstrap.mjs');
const verdict = await read('api-server/scripts/build-staging-verdict.mjs');
const serverEntry = await read('api-server/src/index.ts');
const playwright = await read('stock-analyzer/playwright.config.ts');
const dbVerifier = await read('api-server/scripts/verify-phase8-db.sh');
const authHarness = await read('api-server/supabase/test/staging_bootstrap_auth_harness.sql');
const triggerTest = await read('api-server/supabase/test/staging_bootstrap_trigger_integration.sql');

assert(!manifest.includes('20260716_full_schema_idempotent.sql'), 'must not import the historical full schema');
assert(!manifest.includes('../schema.sql'), 'must not import the broad legacy schema file');
assert(manifest.includes('staging-allowlist-base.sql'), 'manifest must use the allowlisted base schema');

for (const forbidden of [
  'STAGING_PENDING_EMAIL', 'STAGING_PENDING_PASSWORD',
  'STAGING_ASSOCIATE_EMAIL', 'STAGING_ASSOCIATE_PASSWORD',
  'STAGING_REGULAR_EMAIL', 'STAGING_REGULAR_PASSWORD',
  'STAGING_ADMIN_EMAIL', 'STAGING_ADMIN_PASSWORD',
]) {
  assert(!`${manifest}\n${guard}\n${base}\n${assertion}\n${runner}`.includes(forbidden), `${forbidden} must never return`);
}

for (const requiredTable of [
  'profiles', 'watchlist_items', 'market_cache', 'portfolio_holdings',
  'app_backups', 'notification_preferences', 'push_subscriptions',
  'notification_history', 'price_alerts',
]) {
  assert(base.includes(`public.${requiredTable}`), `allowlist base is missing ${requiredTable}`);
  assert(assertion.includes(`'${requiredTable}'`), `final assertion is missing ${requiredTable}`);
}
for (const requiredProfileColumn of [
  'membership_level', 'status', 'role', 'is_active', 'permissions_updated_at',
]) {
  assert(base.includes(requiredProfileColumn), `profiles is missing ${requiredProfileColumn}`);
}
assert(base.includes('create or replace function public.handle_new_user()'), 'profile trigger function is missing');
assert(base.includes('create trigger on_auth_user_created'), 'auth.users profile trigger is missing');
assert(base.includes('enable row level security'), 'RLS enablement is missing');
assert(base.includes('grant all on public.profiles to service_role'), 'server grant is missing');
assert(base.includes('revoke all on public.watchlist_items from anon, authenticated'), 'server-only watchlist grant is not enforced');
assert(!base.includes('insert into auth.users'), 'bootstrap must not create or copy Auth users');
assert(!base.includes('from auth.users u'), 'bootstrap must not backfill Auth users');
assert(!base.includes('storage.'), 'bootstrap must not touch Storage objects');

assert(guard.includes('bawcbkoyovbeajkrnduq'), 'known production project ref guard is missing');
assert(guard.includes('first staging bootstrap requires an empty auth.users table'), 'first-run empty Auth guard is missing');
assert(guard.includes('staging_bootstrap_state'), 'repeat-run marker guard is missing');

assert(runner.includes("required('STAGING_DATABASE_URL')"), 'runner must require a DDL-capable staging database URL');
assert(runner.includes('STAGING_DATABASE_URL does not resolve to the same Supabase project ref'), 'database/project identity check is missing');
assert(runner.includes('stripOuterTransaction'), 'outer migration envelopes must be removed');
assert(runner.includes('Second application proves idempotency'), 'two-pass idempotency execution is missing');
assert(runner.includes("'begin;'"), 'single outer transaction is missing');
assert(runner.includes("'commit;'"), 'single outer commit is missing');
assert(runner.includes('credentials_recorded: false'), 'artifact credential redaction contract is missing');
assert(playwright.includes('staging-bootstrap-global-setup.ts'), 'staging browser suite must bootstrap before account creation');

for (const requiredArtifactField of [
  'atomic_transaction', 'idempotency_passes', 'auth_users_copied',
  'profile_rows_copied', 'storage_objects_copied', 'credentials_recorded',
]) {
  assert(runner.includes(requiredArtifactField), `bootstrap artifact is missing ${requiredArtifactField}`);
}
for (const marker of [
  'apply-staging-supabase-bootstrap.mjs',
  'STAGING_BOOTSTRAP_ALLOW_DISPOSABLE_CI=true',
  'staging_bootstrap_trigger_integration.sql',
]) {
  assert(dbVerifier.includes(marker), `database CI is missing ${marker}`);
}
assert(authHarness.includes('create table if not exists auth.users'), 'CI harness must create auth.users');
assert(authHarness.includes('raw_user_meta_data jsonb'), 'CI harness must support Auth metadata');
assert(!authHarness.includes('insert into auth.users'), 'empty CI harness must not seed users');
assert(triggerTest.includes('delete from auth.users'), 'trigger integration must test Auth cleanup');
assert(triggerTest.includes('profile remained after Auth user deletion'), 'trigger integration must verify profile cascade');

for (const marker of [
  "readJson('staging-bootstrap-verification.json')",
  'bootstrap.atomic_transaction === true',
  'Number(bootstrap.idempotency_passes) === 2',
  'Number(bootstrap.auth_users_copied) === 0',
  'Number(bootstrap.profile_rows_copied) === 0',
  'Number(bootstrap.storage_objects_copied) === 0',
  'accountsCreated === 4',
  'accountsDeleted === 4',
  'profilesRemaining === 0',
]) {
  assert(verdict.includes(marker), `release verdict is missing ${marker}`);
}
assert(serverEntry.includes('process.env.DEPLOY_SHA'), 'health response must read the immutable deploy SHA');
assert(
  serverEntry.includes('deploySha: identity.processDeploySha,'),
  'health response must expose deploySha from the process-start identity',
);

console.log('[staging-bootstrap-contract] allowlist, atomicity, isolation, health SHA, exact account cleanup, no-user-copy, and no-manual-account-secret contracts verified');
