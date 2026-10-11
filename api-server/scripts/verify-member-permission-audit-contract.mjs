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
const memberSecurityHardening = await read('api-server/supabase/migrations/2026100801_member_security_definer_lockdown.sql');
const build = await read('api-server/build.mjs');
const runtimeEntry = await read('api-server/src/index.ts');
const identityGuard = await read('api-server/src/middleware/paper-journal-query-identity.ts');
const adminRoute = await read('api-server/src/routes/admin.ts');
const memberAuthAdmin = await read('api-server/src/services/member-auth-admin.service.ts');
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

assert(build.includes("entryPoints: [path.resolve(rootDir, 'src/index.ts')]"), 'contract must inspect the deployed API build entrypoint');
const guardIndex = runtimeEntry.indexOf("app.use('/api/paper-journal'");
const routerIndex = runtimeEntry.indexOf("app.use('/api', apiRouter)");
assert(guardIndex >= 0 && routerIndex > guardIndex, 'client identity guard must run before the deployed API router');
assert(identityGuard.includes("'userId' in request.query") && identityGuard.includes("'user_id' in request.query"), 'both client identity query spellings must be rejected');
assert(identityGuard.includes("code: 'CLIENT_USER_ID_FORBIDDEN'"), 'identity rejection must use the stable safe code');
assert(identityGuard.includes('orderSubmitted: false') && identityGuard.includes('exchangeRequestSent: false'), 'identity rejection must preserve no-order safety fields');
assert(smoke.includes("for (const queryKey of ['userId', 'user_id'])"), 'smoke test must cover both query spellings');
assert(smoke.includes('response.status, 400'), 'smoke test must require fail-closed HTTP 400');
assert(tests.includes('paper-journal-query-identity.smoke.test.ts'), 'smoke test must be registered');

assert(adminRoute.includes("import { getUserSupabase } from '../lib/supabase';"), 'admin routes must import only the authenticated user-scoped Supabase database client');
assert(adminRoute.includes('return getUserSupabase(req.accessToken!);'), 'admin database access must preserve the caller token for RLS');
assert(!/\bgetSupabase\(\)/u.test(adminRoute), 'admin route module must never instantiate the service-role client');
assert(!/\bhasSupabaseServerKey\(\)/u.test(adminRoute), 'admin route module must not read the server key directly');

const passwordResetStart = adminRoute.indexOf("router.post('/members/:id/password-reset'");
const passwordResetEnd = adminRoute.indexOf("router.get('/audit-logs'", passwordResetStart);
assert(passwordResetStart >= 0 && passwordResetEnd > passwordResetStart, 'password reset route must be explicitly bounded');
const passwordResetRoute = adminRoute.slice(passwordResetStart, passwordResetEnd);
assert(passwordResetRoute.includes('memberPasswordResetAvailable()'), 'password reset must fail closed through the bounded Auth-admin service');
assert(passwordResetRoute.includes("record_member_password_reset_authorization"), 'password reset audit must use the narrow validated RPC');
assert(passwordResetRoute.includes("action !== 'member.password.reset'"), 'password reset must verify the dedicated audit action returned by the RPC');
assert(passwordResetRoute.includes('auditData.resetAuthorized !== true'), 'password reset must verify RPC authorization evidence');
assert(passwordResetRoute.includes('auditData.credentialStored !== false'), 'password reset audit must verify that credentials are not stored');
assert(passwordResetRoute.indexOf("record_member_password_reset_authorization") < passwordResetRoute.indexOf('resetMemberPasswordCredential('), 'password reset audit authorization must succeed before the Auth mutation');
assert(!passwordResetRoute.includes("from('member_permission_audit').insert"), 'password reset route must not have direct audit-table INSERT authority');
assert(passwordResetRoute.includes("res.setHeader('Cache-Control', 'no-store, max-age=0')"), 'password reset response must be non-cacheable');

assert(memberAuthAdmin.includes("import { getSupabase, hasSupabaseServerKey } from '../lib/supabase';"), 'bounded Auth-admin service must own the server-key dependency');
assert(memberAuthAdmin.includes('return hasSupabaseServerKey();'), 'bounded Auth-admin service must expose a fail-closed availability check');
assert(memberAuthAdmin.includes('getSupabase().auth.admin.updateUserById'), 'bounded Auth-admin service must contain the only password mutation');
assert(memberAuthAdmin.includes("throw new Error('PASSWORD_RESET_UNAVAILABLE')"), 'bounded Auth-admin service must fail closed without server authority');
assert(!memberAuthAdmin.includes('member_permission_audit'), 'bounded Auth-admin service must not bypass caller-scoped audit RLS');

assert(memberAuthAdmin.includes('hasSupabaseServerKey()'), 'isolated Auth reset helper must fail closed without a server key');
assert(memberAuthAdmin.includes('getSupabase().auth.admin.updateUserById'), 'isolated Auth reset helper may perform only the privileged Auth credential mutation');
assert(!memberAuthAdmin.includes("from('member_permission_audit')"), 'isolated Auth reset helper must not bypass audit-table RLS');
assert(!/\.(?:from|rpc)\(/u.test(memberAuthAdmin), 'isolated Auth reset helper must not perform database table or RPC operations');

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
  "has_table_privilege('authenticated', 'public.member_permission_audit', 'TRUNCATE')",
  'acl.grantee = 0',
  'relrowsecurity',
  "policyname = 'member audit admins select'",
  "record_member_password_reset_authorization",
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

assert(memberSecurityHardening.includes('drop policy if exists "member audit admins insert"'), 'final member security hardening must remove direct audit INSERT policy');
assert(memberSecurityHardening.includes('grant select on table public.member_permission_audit to authenticated'), 'final member security hardening must keep audit SELECT only');
assert(memberSecurityHardening.includes('record_member_password_reset_authorization'), 'final member security hardening must provide password-reset audit RPC');
assert(memberSecurityHardening.includes('MEMBER_AUDIT_TABLE_PRIVILEGE_INVALID'), 'final member security hardening must verify immutable audit ACLs');
assert(memberSecurityHardening.includes('MEMBER_PASSWORD_RESET_AUDIT_RPC_PRIVILEGE_INVALID'), 'final member security hardening must verify reset audit RPC ACLs');

console.log('[member-permission-audit-contract] deployed query identity rejection, user-scoped admin RLS, exact ACLs, bootstrap, live isolation, rollback and reapply verified');
