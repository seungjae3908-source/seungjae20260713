import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCHEMA_VERSION = 'production-paper-journal-privileges-v1';
const PRODUCTION_PROJECT_REF = 'bawcbkoyovbeajkrnduq';
const TABLES = Object.freeze([
  'paper_accounts',
  'paper_orders',
  'paper_positions',
  'paper_fills',
  'paper_journal_entries',
  'paper_sync_state',
]);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const approvedTargetSha = String(process.env.APPROVED_TARGET_SHA ?? '').trim().toLowerCase();
const productionDatabaseUrl = String(process.env.PROD_DATABASE_URL ?? '').trim();

function fail(classification) {
  console.error(`[production-paper-journal-privileges] ${classification}`);
  process.exit(1);
}

function databaseTarget(raw) {
  const parsed = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('database_url_invalid');
  const hostname = parsed.hostname.toLowerCase();
  const username = decodeURIComponent(parsed.username);
  const usernameLower = username.toLowerCase();
  const direct = hostname === `db.${PRODUCTION_PROJECT_REF}.supabase.co` && usernameLower === 'postgres';
  const pooler = /(^|\.)pooler\.supabase\.com$/i.test(hostname)
    && usernameLower === `postgres.${PRODUCTION_PROJECT_REF}`;
  if (!direct && !pooler) throw new Error('database_project_mismatch');
  if (!parsed.password) throw new Error('database_password_missing');
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  const port = parsed.port || '5432';
  if (database !== 'postgres') throw new Error('database_name_invalid');
  if (port !== '5432') throw new Error('database_port_invalid');
  return {
    hostname,
    port,
    username,
    password: decodeURIComponent(parsed.password),
    database,
    endpointType: direct ? 'direct' : 'pooler',
  };
}

function stripOuterTransaction(source, relativePath) {
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  const beginIndexes = [];
  const commitIndexes = [];
  lines.forEach((line, index) => {
    if (/^\s*begin;\s*$/i.test(line)) beginIndexes.push(index);
    if (/^\s*commit;\s*$/i.test(line)) commitIndexes.push(index);
  });
  if (beginIndexes.length !== 1 || commitIndexes.length !== 1 || beginIndexes[0] >= commitIndexes[0]) {
    throw new Error(`${relativePath} must contain one outer transaction envelope`);
  }
  lines.splice(commitIndexes[0], 1);
  lines.splice(beginIndexes[0], 1);
  const body = lines.join('\n');
  if (/^\s*(?:begin|commit|rollback);\s*$/im.test(body)) {
    throw new Error(`${relativePath} contains nested transaction control`);
  }
  return body;
}

if (!/^[0-9a-f]{40}$/.test(approvedTargetSha)) fail('approved_target_sha_invalid');
if (!/^postgres(?:ql)?:\/\//i.test(productionDatabaseUrl)) fail('production_database_connection_missing');

let database;
try {
  database = databaseTarget(productionDatabaseUrl);
} catch {
  fail('production_database_project_mismatch');
}

const migrationPath = 'api-server/supabase/migrations/2026080501_paper_journal_authenticated_privileges.sql';
let migrationBody;
try {
  migrationBody = stripOuterTransaction(readFileSync(path.join(root, migrationPath), 'utf8'), migrationPath);
} catch {
  fail('migration_source_invalid');
}

const tableValues = TABLES.map((name) => `('${name}')`).join(',');
const preflightSql = String.raw`
do $paper_journal_privilege_preflight$
declare
  item record;
  relation_oid regclass;
  row_count bigint;
  total_rows bigint := 0;
  policy_count integer;
  grant_count integer := 0;
begin
  for item in select name from (values ${tableValues}) as required(name)
  loop
    relation_oid := to_regclass('public.' || item.name);
    if relation_oid is null then raise exception 'PAPER_JOURNAL_TABLE_MISSING:%', item.name; end if;
    if not (select relrowsecurity from pg_catalog.pg_class where oid = relation_oid) then
      raise exception 'PAPER_JOURNAL_RLS_DISABLED:%', item.name;
    end if;
    execute format('select count(*) from public.%I', item.name) into row_count;
    total_rows := total_rows + row_count;
    if has_table_privilege('authenticated', relation_oid, 'SELECT') then grant_count := grant_count + 1; end if;
    if has_table_privilege('authenticated', relation_oid, 'INSERT') then grant_count := grant_count + 1; end if;
    if has_table_privilege('authenticated', relation_oid, 'UPDATE') then grant_count := grant_count + 1; end if;
    if has_table_privilege('authenticated', relation_oid, 'DELETE') then grant_count := grant_count + 1; end if;
  end loop;
  select count(*) into policy_count
  from pg_catalog.pg_policies
  where schemaname = 'public' and tablename in (${TABLES.map((name) => `'${name}'`).join(',')});
  perform set_config('app.paper_journal_rows_before', total_rows::text, true);
  perform set_config('app.paper_journal_policies_before', policy_count::text, true);
  perform set_config('app.paper_journal_grants_before', grant_count::text, true);
end
$paper_journal_privilege_preflight$;
`;

const verificationSql = String.raw`
do $paper_journal_privilege_verify$
declare
  item record;
  relation_oid regclass;
  row_count bigint;
  total_rows bigint := 0;
  policy_count integer;
  grant_count integer := 0;
begin
  for item in select name from (values ${tableValues}) as required(name)
  loop
    relation_oid := to_regclass('public.' || item.name);
    if relation_oid is null then raise exception 'PAPER_JOURNAL_TABLE_MISSING:%', item.name; end if;
    if not (select relrowsecurity from pg_catalog.pg_class where oid = relation_oid) then
      raise exception 'PAPER_JOURNAL_RLS_DISABLED:%', item.name;
    end if;
    if not has_table_privilege('authenticated', relation_oid, 'SELECT')
      or not has_table_privilege('authenticated', relation_oid, 'INSERT')
      or not has_table_privilege('authenticated', relation_oid, 'UPDATE')
      or not has_table_privilege('authenticated', relation_oid, 'DELETE') then
      raise exception 'PAPER_JOURNAL_AUTHENTICATED_CRUD_MISSING:%', item.name;
    end if;
    if has_table_privilege('anon', relation_oid, 'SELECT')
      or has_table_privilege('anon', relation_oid, 'INSERT')
      or has_table_privilege('anon', relation_oid, 'UPDATE')
      or has_table_privilege('anon', relation_oid, 'DELETE') then
      raise exception 'PAPER_JOURNAL_ANON_PRIVILEGE_EXPOSED:%', item.name;
    end if;
    if exists (
      select 1
      from pg_catalog.pg_class candidate
      cross join lateral aclexplode(coalesce(candidate.relacl, acldefault('r', candidate.relowner))) privilege
      where candidate.oid = relation_oid
        and privilege.grantee = 0
        and privilege.privilege_type in ('SELECT','INSERT','UPDATE','DELETE')
    ) then
      raise exception 'PAPER_JOURNAL_PUBLIC_PRIVILEGE_EXPOSED:%', item.name;
    end if;
    execute format('select count(*) from public.%I', item.name) into row_count;
    total_rows := total_rows + row_count;
    grant_count := grant_count + 4;
  end loop;
  if total_rows <> current_setting('app.paper_journal_rows_before')::bigint then
    raise exception 'PAPER_JOURNAL_ROWS_CHANGED';
  end if;
  select count(*) into policy_count
  from pg_catalog.pg_policies
  where schemaname = 'public' and tablename in (${TABLES.map((name) => `'${name}'`).join(',')});
  if policy_count <> current_setting('app.paper_journal_policies_before')::integer then
    raise exception 'PAPER_JOURNAL_POLICIES_CHANGED';
  end if;
  if grant_count <> 24 then raise exception 'PAPER_JOURNAL_GRANT_COUNT_INVALID'; end if;
end
$paper_journal_privilege_verify$;

select json_build_object(
  'schemaVersion','production-paper-journal-privileges-v1',
  'status','passed',
  'approved_target_sha',current_setting('app.approved_target_sha'),
  'production_project_match',true,
  'database_endpoint_type','${database.endpointType}',
  'atomic_transaction',true,
  'migration_applied',1,
  'tables_verified',6,
  'authenticated_crud_grants',24,
  'anonymous_crud_grants',0,
  'public_crud_grants',0,
  'rls_preserved',true,
  'policies_mutated',false,
  'journal_rows_mutated',false,
  'database_changed',(current_setting('app.paper_journal_grants_before')::integer <> 24),
  'credentials_read',false,
  'raw_credentials_exposed',false,
  'order_submitted',false,
  'cancel_submitted',false,
  'amend_submitted',false,
  'transfer_submitted',false,
  'withdrawal_submitted',false,
  'private_trading_api_count',0,
  'live_trading_authority_granted',false,
  'auto_trading_authority_granted',false
)::text;
`;

const sql = [
  '\\set ON_ERROR_STOP on',
  'begin;',
  "set local lock_timeout = '5s';",
  "set local statement_timeout = '60s';",
  "select pg_advisory_xact_lock(hashtextextended('production-paper-journal-privileges-v1', 0));",
  `select set_config('app.approved_target_sha', '${approvedTargetSha}', true);`,
  preflightSql,
  migrationBody,
  verificationSql,
  'commit;',
  '',
].join('\n');

const childEnv = { ...process.env };
for (const key of Object.keys(childEnv)) if (key.startsWith('PG')) delete childEnv[key];
delete childEnv.PROD_DATABASE_URL;
const result = spawnSync('psql', [
  '-X',
  '--no-psqlrc',
  '--quiet',
  '--tuples-only',
  '--no-align',
  '--set=ON_ERROR_STOP=1',
  '--host', database.hostname,
  '--port', database.port,
  '--username', database.username,
  '--dbname', database.database,
], {
  input: sql,
  encoding: 'utf8',
  env: {
    ...childEnv,
    PGPASSWORD: database.password,
    PGCONNECT_TIMEOUT: '15',
    PGSSLMODE: 'require',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
  maxBuffer: 2 * 1024 * 1024,
});
if (result.error || result.status !== 0) fail('atomic_privilege_migration_failed');

const lines = String(result.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
let artifact;
try {
  artifact = JSON.parse(lines.at(-1) ?? '');
} catch {
  fail('verification_artifact_invalid');
}
if (artifact?.schemaVersion !== SCHEMA_VERSION
  || artifact?.status !== 'passed'
  || artifact?.approved_target_sha !== approvedTargetSha
  || artifact?.production_project_match !== true
  || !['direct', 'pooler'].includes(artifact?.database_endpoint_type)
  || artifact?.atomic_transaction !== true
  || artifact?.migration_applied !== 1
  || artifact?.tables_verified !== 6
  || artifact?.authenticated_crud_grants !== 24
  || artifact?.anonymous_crud_grants !== 0
  || artifact?.public_crud_grants !== 0
  || artifact?.rls_preserved !== true
  || artifact?.policies_mutated !== false
  || artifact?.journal_rows_mutated !== false
  || typeof artifact?.database_changed !== 'boolean'
  || artifact?.credentials_read !== false
  || artifact?.raw_credentials_exposed !== false
  || artifact?.order_submitted !== false
  || artifact?.cancel_submitted !== false
  || artifact?.amend_submitted !== false
  || artifact?.transfer_submitted !== false
  || artifact?.withdrawal_submitted !== false
  || artifact?.private_trading_api_count !== 0
  || artifact?.live_trading_authority_granted !== false
  || artifact?.auto_trading_authority_granted !== false) {
  fail('verification_contract_failed');
}

process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
