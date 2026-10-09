import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { classifyProductionPaperJournalPrivilegeFailure } from './classify-production-paper-journal-privilege-failure.mjs';

const SCHEMA_VERSION = 'production-paper-journal-storage-v2';
const PRODUCTION_PROJECT_REF = 'bawcbkoyovbeajkrnduq';
const TABLES = Object.freeze([
  'paper_accounts',
  'paper_orders',
  'paper_positions',
  'paper_fills',
  'paper_journal_entries',
  'paper_sync_state',
]);
const INDEXES = Object.freeze([
  'paper_accounts_user_updated_idx',
  'paper_orders_user_updated_idx',
  'paper_positions_user_updated_idx',
  'paper_fills_user_updated_idx',
  'paper_journal_entries_user_updated_idx',
  'paper_sync_state_user_type_idx',
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
  const disposableCi = process.env.CI === 'true'
    && process.env.PRODUCTION_PAPER_JOURNAL_ALLOW_DISPOSABLE_CI === 'true'
    && ['127.0.0.1', 'localhost'].includes(hostname);
  const direct = hostname === `db.${PRODUCTION_PROJECT_REF}.supabase.co` && usernameLower === 'postgres';
  const pooler = /(^|\.)pooler\.supabase\.com$/i.test(hostname)
    && usernameLower === `postgres.${PRODUCTION_PROJECT_REF}`;
  if (!disposableCi && !direct && !pooler) throw new Error('database_project_mismatch');
  if (!parsed.password) throw new Error('database_password_missing');
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  const port = parsed.port || '5432';
  if (!database || (!disposableCi && database !== 'postgres')) throw new Error('database_name_invalid');
  if (port !== '5432') throw new Error('database_port_invalid');
  return {
    hostname,
    port,
    username,
    password: decodeURIComponent(parsed.password),
    database,
    endpointType: disposableCi ? 'disposable-ci' : direct ? 'direct' : 'pooler',
    disposableCi,
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

const migrationPaths = Object.freeze({
  tables: 'api-server/supabase/migrations/2026080201_journal_sync_analytics_phase7.sql',
  policies: 'api-server/supabase/migrations/2026080203_phase8_paper_capability_rls.sql',
  privileges: 'api-server/supabase/migrations/2026080501_paper_journal_authenticated_privileges.sql',
});
let migrations;
try {
  migrations = Object.fromEntries(Object.entries(migrationPaths).map(([name, relativePath]) => [
    name,
    stripOuterTransaction(readFileSync(path.join(root, relativePath), 'utf8'), relativePath),
  ]));
} catch {
  fail('migration_source_invalid');
}

const tableValues = TABLES.map((name) => `('${name}')`).join(',');
const tableNames = TABLES.map((name) => `'${name}'`).join(',');
const indexNames = INDEXES.map((name) => `'${name}'`).join(',');
const policyContractFromSql = String.raw`
from pg_catalog.pg_policies p
where p.schemaname = 'public'
  and p.tablename in (${tableNames})
  and p.policyname = p.tablename || case p.cmd
    when 'SELECT' then ' select own'
    when 'INSERT' then ' insert own'
    when 'UPDATE' then ' update own'
    when 'DELETE' then ' delete own'
    else ' invalid'
  end
  and (
    (p.cmd in ('SELECT', 'DELETE')
      and coalesce(p.qual, '') ilike '%auth.uid()%user_id%'
      and coalesce(p.qual, '') ilike '%current_membership_level()%'
      and coalesce(p.qual, '') ilike '%regular%'
      and coalesce(p.qual, '') ilike '%admin%')
    or (p.cmd = 'INSERT'
      and coalesce(p.with_check, '') ilike '%auth.uid()%user_id%'
      and coalesce(p.with_check, '') ilike '%current_membership_level()%'
      and coalesce(p.with_check, '') ilike '%regular%'
      and coalesce(p.with_check, '') ilike '%admin%')
    or (p.cmd = 'UPDATE'
      and coalesce(p.qual, '') ilike '%auth.uid()%user_id%'
      and coalesce(p.qual, '') ilike '%current_membership_level()%'
      and coalesce(p.qual, '') ilike '%regular%'
      and coalesce(p.qual, '') ilike '%admin%'
      and coalesce(p.with_check, '') ilike '%auth.uid()%user_id%'
      and coalesce(p.with_check, '') ilike '%current_membership_level()%'
      and coalesce(p.with_check, '') ilike '%regular%'
      and coalesce(p.with_check, '') ilike '%admin%')
  )`;

const preflightSql = String.raw`
do $paper_journal_storage_preflight$
declare
  item record;
  relation_oid regclass;
  row_count bigint;
  total_rows bigint := 0;
  existing_tables integer := 0;
  policy_count integer := 0;
  safe_policy_count integer := 0;
  grant_count integer := 0;
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated')
    or not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    raise exception 'PAPER_JOURNAL_REQUIRED_ROLE_MISSING';
  end if;
  if to_regclass('auth.users') is null then
    raise exception 'PAPER_JOURNAL_AUTH_USERS_MISSING';
  end if;
  if to_regprocedure('auth.uid()') is null
    or to_regprocedure('public.current_membership_level()') is null then
    raise exception 'PAPER_JOURNAL_REQUIRED_CAPABILITY_MISSING';
  end if;

  for item in select name from (values ${tableValues}) as required(name)
  loop
    relation_oid := to_regclass('public.' || item.name);
    if relation_oid is not null then
      existing_tables := existing_tables + 1;
      execute format('select count(*) from public.%I', item.name) into row_count;
      total_rows := total_rows + row_count;
      if has_table_privilege('authenticated', relation_oid, 'SELECT') then grant_count := grant_count + 1; end if;
      if has_table_privilege('authenticated', relation_oid, 'INSERT') then grant_count := grant_count + 1; end if;
      if has_table_privilege('authenticated', relation_oid, 'UPDATE') then grant_count := grant_count + 1; end if;
      if has_table_privilege('authenticated', relation_oid, 'DELETE') then grant_count := grant_count + 1; end if;
    end if;
  end loop;
  if existing_tables not in (0, 6) then
    raise exception 'PAPER_JOURNAL_PARTIAL_SCHEMA:%', existing_tables;
  end if;
  select count(*)::integer into policy_count
  from pg_catalog.pg_policies
  where schemaname = 'public' and tablename in (${tableNames});
  select count(*)::integer into safe_policy_count
  ${policyContractFromSql};
  perform set_config('app.paper_journal_tables_before', existing_tables::text, true);
  perform set_config('app.paper_journal_rows_before', total_rows::text, true);
  perform set_config('app.paper_journal_policies_before', policy_count::text, true);
  perform set_config('app.paper_journal_safe_policies_before', safe_policy_count::text, true);
  perform set_config('app.paper_journal_grants_before', grant_count::text, true);
end
$paper_journal_storage_preflight$;
`;

const verificationSql = String.raw`
do $paper_journal_storage_verify$
declare
  item record;
  relation_oid regclass;
  row_count bigint;
  total_rows bigint := 0;
  policy_count integer := 0;
  safe_policy_count integer := 0;
  grant_count integer := 0;
  column_count integer;
  primary_key_columns text;
  admin_v2_guard_ready boolean := false;
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

    select count(*)::integer into column_count
    from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = item.name
      and (
        (c.column_name = 'user_id' and c.udt_name = 'uuid' and c.is_nullable = 'NO')
        or (c.column_name = 'id' and c.udt_name = 'text' and c.is_nullable = 'NO')
        or (c.column_name = 'payload' and c.udt_name = 'jsonb' and c.is_nullable = 'NO')
        or (c.column_name = 'version' and c.udt_name = 'int8' and c.is_nullable = 'NO')
        or (c.column_name = 'deleted_at' and c.udt_name = 'timestamptz' and c.is_nullable = 'YES')
        or (c.column_name = 'created_at' and c.udt_name = 'timestamptz' and c.is_nullable = 'NO')
        or (c.column_name = 'updated_at' and c.udt_name = 'timestamptz' and c.is_nullable = 'NO')
      );
    if column_count <> 7 then raise exception 'PAPER_JOURNAL_COLUMN_CONTRACT_INVALID:%', item.name; end if;
    if item.name = 'paper_sync_state' and (
      select count(*) from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = item.name
        and c.column_name in ('state_type', 'status') and c.udt_name = 'text' and c.is_nullable = 'NO'
    ) <> 2 then
      raise exception 'PAPER_JOURNAL_COLUMN_CONTRACT_INVALID:%', item.name;
    end if;

    select string_agg(a.attname, ',' order by key_column.ordinality) into primary_key_columns
    from pg_catalog.pg_constraint constraint_row
    cross join lateral unnest(constraint_row.conkey) with ordinality as key_column(attnum, ordinality)
    join pg_catalog.pg_attribute a on a.attrelid = constraint_row.conrelid and a.attnum = key_column.attnum
    where constraint_row.conrelid = relation_oid and constraint_row.contype = 'p';
    if primary_key_columns is distinct from 'user_id,id' then
      raise exception 'PAPER_JOURNAL_PRIMARY_KEY_INVALID:%', item.name;
    end if;

    execute format('select count(*) from public.%I', item.name) into row_count;
    total_rows := total_rows + row_count;
    grant_count := grant_count + 4;
  end loop;
  if total_rows <> current_setting('app.paper_journal_rows_before')::bigint then
    raise exception 'PAPER_JOURNAL_ROWS_CHANGED';
  end if;
  if (select count(*) from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in (${indexNames}) and c.relkind = 'i') <> 6 then
    raise exception 'PAPER_JOURNAL_INDEX_CONTRACT_INVALID';
  end if;
  select count(*)::integer into policy_count
  from pg_catalog.pg_policies
  where schemaname = 'public' and tablename in (${tableNames});
  select count(*)::integer into safe_policy_count
  ${policyContractFromSql};
  -- The 24 owner-scoped permissive policies must remain intact. A fully
  -- protected administrator V2 rollout adds exactly three RESTRICTIVE wallet
  -- policies; never treat those as corruption and never run the legacy policy
  -- repair (which could otherwise discard the administrator write barriers).
  if policy_count not in (24, 27) or safe_policy_count <> 24 then
    raise exception 'PAPER_JOURNAL_POLICY_CONTRACT_INVALID:%:%', policy_count, safe_policy_count;
  end if;
  if policy_count = 27 then
    if to_regprocedure('public.admin_four_paper_wallet_rls_guard_ready()') is null then
      raise exception 'PAPER_JOURNAL_POLICY_CONTRACT_INVALID:%:%', policy_count, safe_policy_count;
    end if;
    -- Dynamic invocation allows older pre-V2 schemas to keep the original
    -- 24-policy contract without resolving a function they do not possess.
    execute 'select public.admin_four_paper_wallet_rls_guard_ready()'
      into admin_v2_guard_ready;
    if admin_v2_guard_ready is distinct from true then
      raise exception 'PAPER_JOURNAL_POLICY_CONTRACT_INVALID:%:%', policy_count, safe_policy_count;
    end if;
  end if;
  if grant_count <> 24 then raise exception 'PAPER_JOURNAL_GRANT_COUNT_INVALID'; end if;
end
$paper_journal_storage_verify$;

select json_build_object(
  'schemaVersion','${SCHEMA_VERSION}',
  'status','passed',
  'approved_target_sha',current_setting('app.approved_target_sha'),
  'production_project_match',${database.disposableCi ? 'false' : 'true'},
  'database_endpoint_type','${database.endpointType}',
  'disposable_ci',${database.disposableCi ? 'true' : 'false'},
  'atomic_transaction',true,
  'tables_before',current_setting('app.paper_journal_tables_before')::integer,
  'tables_created',6 - current_setting('app.paper_journal_tables_before')::integer,
  'tables_verified',6,
  'table_contract_verified',true,
  'policies_before',current_setting('app.paper_journal_policies_before')::integer,
  'policies_repaired',(current_setting('app.paper_journal_safe_policies_before')::integer <> 24),
  'policy_contract_verified',true,
  'authenticated_crud_grants',24,
  'anonymous_crud_grants',0,
  'public_crud_grants',0,
  'rls_preserved',true,
  'journal_rows_mutated',false,
  'database_changed',(
    current_setting('app.paper_journal_tables_before')::integer <> 6
    or current_setting('app.paper_journal_safe_policies_before')::integer <> 24
    or current_setting('app.paper_journal_grants_before')::integer <> 24
  ),
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
  '\\echo __PAPER_JOURNAL_PHASE__:transaction',
  // The stable snapshot makes all catalog and row invariants internally
  // consistent while still exposing this transaction's own writes.
  'begin isolation level repeatable read;',
  "set local lock_timeout = '5s';",
  "set local statement_timeout = '60s';",
  "select pg_advisory_xact_lock(hashtextextended('production-paper-journal-storage-v2', 0));",
  `select set_config('app.approved_target_sha', '${approvedTargetSha}', true);`,
  '\\echo __PAPER_JOURNAL_PHASE__:preflight',
  preflightSql,
  "select (current_setting('app.paper_journal_tables_before')::integer = 0) as bootstrap_tables \\gset",
  '\\if :bootstrap_tables',
  '\\echo __PAPER_JOURNAL_PHASE__:table_bootstrap',
  migrations.tables,
  '\\endif',
  "select (current_setting('app.paper_journal_tables_before')::integer = 0 or current_setting('app.paper_journal_safe_policies_before')::integer <> 24) as repair_policies \\gset",
  '\\if :repair_policies',
  '\\echo __PAPER_JOURNAL_PHASE__:policy_repair',
  migrations.policies,
  '\\endif',
  '\\echo __PAPER_JOURNAL_PHASE__:privileges',
  migrations.privileges,
  '\\echo __PAPER_JOURNAL_PHASE__:verification',
  verificationSql,
  '\\echo __PAPER_JOURNAL_PHASE__:commit',
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
    PGSSLMODE: database.disposableCi ? 'disable' : 'require',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
  maxBuffer: 4 * 1024 * 1024,
});
if (result.error || result.status !== 0) fail(classifyProductionPaperJournalPrivilegeFailure(result));

const lines = String(result.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
let artifact;
try {
  const artifactLine = lines.findLast((line) => line.startsWith('{') && line.endsWith('}'));
  artifact = JSON.parse(artifactLine ?? '');
} catch {
  fail('verification_artifact_invalid');
}
if (artifact?.schemaVersion !== SCHEMA_VERSION
  || artifact?.status !== 'passed'
  || artifact?.approved_target_sha !== approvedTargetSha
  || artifact?.production_project_match !== !database.disposableCi
  || artifact?.database_endpoint_type !== database.endpointType
  || artifact?.disposable_ci !== database.disposableCi
  || artifact?.atomic_transaction !== true
  || ![0, 6].includes(artifact?.tables_before)
  || artifact?.tables_created !== 6 - artifact?.tables_before
  || artifact?.tables_verified !== 6
  || artifact?.table_contract_verified !== true
  || artifact?.policy_contract_verified !== true
  || artifact?.authenticated_crud_grants !== 24
  || artifact?.anonymous_crud_grants !== 0
  || artifact?.public_crud_grants !== 0
  || artifact?.rls_preserved !== true
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
