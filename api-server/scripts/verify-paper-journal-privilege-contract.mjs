import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.basename(process.cwd()) === 'api-server'
  ? path.resolve(process.cwd(), '..')
  : path.resolve(process.cwd());
const read = (relative) => readFile(path.join(root, relative), 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(`[paper-journal-privilege-contract] ${message}`);
};

const paths = {
  migration: 'api-server/supabase/migrations/2026080501_paper_journal_authenticated_privileges.sql',
  down: 'api-server/supabase/migrations/2026080501_paper_journal_authenticated_privileges.down.sql',
  manifest: 'api-server/supabase/bootstrap/staging-bootstrap.sql',
  runner: 'api-server/scripts/apply-staging-supabase-bootstrap.mjs',
  assertion: 'api-server/supabase/bootstrap/staging-bootstrap-assert.sql',
  dbRunner: 'api-server/scripts/verify-phase8-db.sh',
  ownership: 'api-server/supabase/test/phase8_rls_integration.sql',
  tiers: 'api-server/supabase/test/phase8_tier_rls_integration.sql',
  before: 'api-server/supabase/test/paper_journal_privileges_before_migration.sql',
  after: 'api-server/supabase/test/paper_journal_privileges_integration.sql',
};
const entries = await Promise.all(Object.entries(paths).map(async ([key, relative]) => [key, await read(relative)]));
const source = Object.fromEntries(entries);
const migrationName = path.basename(paths.migration);
const paperTables = [
  'paper_accounts',
  'paper_orders',
  'paper_positions',
  'paper_fills',
  'paper_journal_entries',
  'paper_sync_state',
];

assert(/^\s*begin;[\s\S]*commit;\s*$/im.test(source.migration), 'migration needs one explicit transaction envelope');
assert(/grant\s+select\s*,\s*insert\s*,\s*update\s*,\s*delete\s+on\s+table/i.test(source.migration), 'authenticated CRUD grant is incomplete');
assert(/to\s+authenticated\s*;/i.test(source.migration), 'authenticated must be the only grant target');
assert(/revoke\s+all\s+privileges\s+on\s+table/i.test(source.migration), 'anon and PUBLIC revoke is missing');
assert(/from\s+public\s*,\s*anon\s*;/i.test(source.migration), 'migration must revoke paper access from PUBLIC and anon');
for (const table of paperTables) {
  assert(source.migration.includes(`public.${table}`), `migration is missing public.${table}`);
  assert(source.down.includes(`public.${table}`), `down migration is missing public.${table}`);
  assert(source.assertion.includes(`'${table}'`), `bootstrap assertion is missing ${table}`);
  assert(source.before.includes(`'${table}'`), `pre-migration reproduction is missing ${table}`);
  assert(source.after.includes(`'${table}'`), `post-migration verification is missing ${table}`);
}

for (const forbidden of [
  /grant[\s\S]*\bto\s+(?:public|anon|service_role)\b/i,
  /grant\s+(?:usage|select)[\s\S]*sequence/i,
  /security\s+definer/i,
  /disable\s+row\s+level\s+security/i,
  /^\s*insert\s+into\s+/im,
  /^\s*update\s+public\./im,
  /^\s*delete\s+from\s+/im,
]) {
  assert(!forbidden.test(source.migration), `migration contains forbidden pattern ${forbidden}`);
}
assert(!/create\s+(?:sequence|function|policy|table)/i.test(source.migration), 'migration must only change table privileges');
assert(/from\s+public\s*,\s*anon\s*,\s*authenticated\s*;/i.test(source.down), 'down migration must restore the pre-fix role privilege state');

assert(source.manifest.includes(migrationName), 'bootstrap manifest does not include the privilege migration');
assert(source.runner.includes(paths.migration), 'atomic bootstrap runner does not include the privilege migration');
assert(source.runner.includes('Second application proves idempotency'), 'bootstrap two-pass idempotency contract was removed');
for (const operation of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
  assert(source.assertion.includes(`'${operation}'`), `bootstrap assertion is missing ${operation}`);
  assert(source.before.includes(`'${operation}'`), `pre-migration reproduction is missing ${operation}`);
  assert(source.after.includes(`'${operation}'`), `post-migration verification is missing ${operation}`);
}
assert(source.assertion.includes("has_table_privilege('authenticated'"), 'bootstrap does not verify authenticated privileges');
assert(source.assertion.includes("has_table_privilege('anon'"), 'bootstrap does not verify anon denial');
assert(source.assertion.includes('relrowsecurity'), 'bootstrap RLS assertion was removed');
assert(source.assertion.includes('pg_policies'), 'bootstrap policy assertion was removed');

const broadGrant = /grant\s+select\s*,\s*insert\s*,\s*update\s*,\s*delete\s+on\s+all\s+tables\s+in\s+schema\s+public/i;
assert(!broadGrant.test(source.ownership), 'ownership RLS test still masks migration grants');
assert(!broadGrant.test(source.tiers), 'membership-tier RLS test still masks migration grants');
assert(source.dbRunner.includes(paths.down), 'disposable DB verification does not reproduce the pre-fix privilege state');
assert(source.dbRunner.includes(paths.before), 'disposable DB verification does not assert the pre-fix failure');
assert((source.dbRunner.match(new RegExp(migrationName.replaceAll('.', '\\.'), 'g')) ?? []).length >= 3, 'DB verification must double-apply and reapply the migration');
assert(source.dbRunner.includes(paths.after), 'DB verification does not assert the post-migration contract');
assert(!/(?:production|prod)[_-]?(?:database|supabase)[_-]?url/i.test(source.dbRunner), 'disposable DB verifier references a production database variable');

console.log('[paper-journal-privilege-contract] six paper tables, authenticated CRUD, anon/PUBLIC denial, RLS preservation, pre-fix reproduction, two-pass bootstrap, rollback and reapply verified');
