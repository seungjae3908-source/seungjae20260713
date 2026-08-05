import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.basename(process.cwd()) === 'api-server'
  ? path.resolve(process.cwd(), '..')
  : path.resolve(process.cwd());
const read = (relative) => readFile(path.join(root, relative), 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(`[member-permission-audit-contract] ${message}`);
};

const migrationPath = 'api-server/supabase/migrations/2026080502_member_permission_audit_authenticated_privileges.sql';
const downPath = 'api-server/supabase/migrations/2026080502_member_permission_audit_authenticated_privileges.down.sql';
const migration = await read(migrationPath);
const down = await read(downPath);
const app = await read('api-server/src/app.ts');
const smoke = await read('api-server/src/routes/paper-journal-query-identity.smoke.test.ts');
const tests = await read('api-server/test.mjs');
const manifest = await read('api-server/supabase/bootstrap/staging-bootstrap.sql');
const runner = await read('api-server/scripts/apply-staging-supabase-bootstrap.mjs');
const postAssert = await read('api-server/supabase/bootstrap/staging-audit-privilege-assert.sql');
const dbVerifier = await read('api-server/scripts/verify-phase8-db.sh');
const beforeSql = await read('api-server/supabase/test/member_permission_audit_privileges_before_migration.sql');
const integrationSql = await read('api-server/supabase/test/member_permission_audit_privileges_integration.sql');

assert(/^\s*--[\s\S]*?\bbegin;[\s\S]*?\bcommit;\s*$/i.test(migration), 'migration must have one transactional envelope');
const migrationRelations = [...migration.matchAll(/\bpublic\.([a-z_][a-z0-9_]*)\b/gi)]
  .map((match) => match[1].toLowerCase());
assert(
  migrationRelations.length >= 2
    && migrationRelations.every((relation) => relation === 'member_permission_audit'),
  'migration must target only member_permission_audit ACLs',
);
assert(/revoke all privileges on table public\.member_permission_audit\s+from public, anon, authenticated;/i.test(migration), 'migration must reset PUBLIC, anon, and authenticated ACLs');
assert(/grant select, insert on table public\.member_permission_audit\s+to authenticated;/i.test(migration), 'migration must grant only SELECT and INSERT to authenticated');
assert(!/grant[^;]*(?:update|delete|all privileges)/i.test(migration), 'migration must not grant UPDATE, DELETE, or ALL');
assert(!/(?:service_role|sequence|security\s+definer)/i.test(migration), 'migration must not add service-role, sequence, or security-definer access');
assert(!/\b(?:insert\s+into|update\s+public\.|delete\s+from)\b/i.test(migration), 'migration must not change user or audit rows');

assert(/^\s*--[\s\S]*?\bbegin;[\s\S]*?\bcommit;\s*$/i.test(down), 'down migration must have one transactional envelope');
assert(/revoke all privileges on table public\.member_permission_audit\s+from public, anon, authenticated;/i.test(down), 'down migration must revoke every API-role privilege');
assert(!/\b(?:drop table|truncate|delete\s+from)\b/i.test(down), 'down migration must preserve tables and data');

const guardIndex = app.indexOf("app.use('/api/paper-journal'");
const routerIndex = app.indexOf('app.use("/api", router)');
assert(guardIndex >= 0 && routerIndex > guardIndex, 'client identity guard must run before the API router');
assert(app.includes("'userId' in req.query") && app.includes("'user_id' in req.query"), 'both client identity query spellings must be rejected');
assert(app.includes("code: 'CLIENT_USER_ID_FORBIDDEN'"), 'identity rejection must use the stable safe code');
assert(app.includes('orderSubmitted: false') && app.includes('exchangeRequestSent: false'), 'identity rejection must preserve no-order safety fields');
assert(smoke.includes("for (const queryKey of ['userId', 'user_id'])"), 'smoke test must cover both query spellings');
assert(smoke.includes('response.status, 400'), 'smoke test must require fail-closed HTTP 400');
assert(tests.includes('paper-journal-query-identity.smoke.test.ts'), 'smoke test must be registered');

for (const source of [manifest, runner]) {
  assert(source.includes('2026080502_member_permission_audit_authenticated_privileges.sql'), 'bootstrap must include the new migration');
  assert(source.includes('staging-audit-privilege-assert.sql'), 'bootstrap must include the post-migration assertion');
}
assert(runner.includes("const SCHEMA_VERSION = '20260805.1'"), 'bootstrap artifact schema version must advance');
for (const marker of [
  "has_table_privilege('authenticated', 'public.member_permission_audit', 'SELECT')",
  "has_table_privilege('authenticated', 'public.member_permission_audit', 'INSERT')",
  "has_table_privilege('authenticated', 'public.member_permission_audit', 'UPDATE')",
  "has_table_privilege('authenticated', 'public.member_permission_audit', 'DELETE')",
  'acl.grantee = 0',
  'relrowsecurity',
  "policyname = 'member audit admins select'",
  "policyname = 'member audit admins insert'",
  "schema_version = '20260805.1'",
]) {
  assert(postAssert.includes(marker), `staging audit assertion is missing ${marker}`);
}

for (const marker of [
  'member_permission_audit_privileges_before_migration.sql',
  '2026080502_member_permission_audit_authenticated_privileges.sql',
  '2026080502_member_permission_audit_authenticated_privileges.down.sql',
  'member_permission_audit_privileges_integration.sql',
]) {
  assert(dbVerifier.includes(marker), `disposable database verifier is missing ${marker}`);
}
assert(dbVerifier.includes("value.schema_version !== '20260805.1'"), 'live staging evidence must require the new schema version');
const liveExit = dbVerifier.indexOf('exit 0');
const firstDown = dbVerifier.indexOf('2026080502_member_permission_audit_authenticated_privileges.down.sql');
assert(liveExit >= 0 && firstDown > liveExit, 'live staging must exit before any audit down migration or rollback fixture');
assert(beforeSql.includes("has_table_privilege('authenticated'"), 'pre-migration fixture must reproduce missing authenticated ACLs');
assert(integrationSql.includes('set role authenticated'), 'integration fixture must exercise authenticated RLS');
assert(integrationSql.includes('regular member inserted administrator audit row'), 'integration fixture must prove regular insert denial');
assert(integrationSql.includes('admin could not read the audit row allowed by RLS'), 'integration fixture must prove admin access');
assert(integrationSql.trimEnd().endsWith('rollback;'), 'integration fixture must leave no persistent audit row');

console.log('[member-permission-audit-contract] query identity rejection, exact ACLs, RLS, bootstrap, live isolation, rollback and reapply verified');
