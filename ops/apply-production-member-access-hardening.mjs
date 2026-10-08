import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCHEMA_VERSION = 'production-member-access-hardening-v1';
const PRODUCTION_PROJECT_REF = 'bawcbkoyovbeajkrnduq';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const approvedTargetSha = String(process.env.APPROVED_TARGET_SHA ?? '').trim().toLowerCase();
const productionDatabaseUrl = String(process.env.PROD_DATABASE_URL ?? '').trim();

function fail(classification) {
  console.error('[production-member-access-hardening] ' + classification);
  process.exit(1);
}

function databaseTarget(raw) {
  const parsed = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('database_url_invalid');
  const hostname = parsed.hostname.toLowerCase();
  const username = decodeURIComponent(parsed.username);
  const usernameLower = username.toLowerCase();
  const direct = hostname === 'db.' + PRODUCTION_PROJECT_REF + '.supabase.co' && usernameLower === 'postgres';
  const pooler = /(^|\.)pooler\.supabase\.com$/i.test(hostname)
    && usernameLower === 'postgres.' + PRODUCTION_PROJECT_REF;
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
    throw new Error(relativePath + ' must contain one outer transaction envelope');
  }
  lines.splice(commitIndexes[0], 1);
  lines.splice(beginIndexes[0], 1);
  const body = lines.join('\n');
  if (/^\s*(?:begin|commit|rollback);\s*$/im.test(body)) {
    throw new Error(relativePath + ' contains nested transaction control');
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

const migrationPaths = [
  'api-server/supabase/migrations/2026100601_member_access_s_ai_hardening.sql',
  'api-server/supabase/migrations/2026100801_member_security_definer_lockdown.sql',
];
let migrationBody;
try {
  migrationBody = migrationPaths
    .map((migrationPath) => stripOuterTransaction(
      readFileSync(path.join(root, migrationPath), 'utf8'),
      migrationPath,
    ))
    .join('\n');
} catch {
  fail('migration_source_invalid');
}

const preflightSql = String.raw`
do $member_access_hardening_preflight$
declare
  profile_count bigint;
  journal_count bigint;
  audit_count bigint := 0;
  preserved_status_counts jsonb;
begin
  if to_regclass('public.profiles') is null then raise exception 'MEMBER_PROFILES_TABLE_MISSING'; end if;
  if to_regclass('public.paper_journal_entries') is null then raise exception 'MEMBER_JOURNAL_TABLE_MISSING'; end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'id'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'role'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'status'
  ) then raise exception 'MEMBER_LEGACY_PROFILE_COLUMNS_MISSING'; end if;

  select count(*) into profile_count from public.profiles;
  select count(*) into journal_count from public.paper_journal_entries;
  if to_regclass('public.member_permission_audit') is not null then
    execute 'select count(*) from public.member_permission_audit' into audit_count;
  end if;

  select coalesce(jsonb_object_agg(status_text, count_value), '{}'::jsonb)
  into preserved_status_counts
  from (
    select status::text as status_text, count(*)::bigint as count_value
    from public.profiles
    where status::text in ('rejected','suspended','revoked','withdrawn','disabled','inactive')
    group by status::text
  ) snapshot;

  perform set_config('app.member_profiles_before', profile_count::text, true);
  perform set_config('app.member_journal_before', journal_count::text, true);
  perform set_config('app.member_audit_before', audit_count::text, true);
  perform set_config('app.member_preserved_statuses_before', preserved_status_counts::text, true);
end
$member_access_hardening_preflight$;
`;

const verificationSql = String.raw`
do $member_access_hardening_verify$
declare
  current_level_definition text;
  approved_definition text;
  admin_definition text;
  policy_qual text;
  action_constraint text;
  preserved_status_counts jsonb;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'membership_expires_at'
      and data_type = 'timestamp with time zone'
  ) then raise exception 'MEMBER_EXPIRY_COLUMN_MISSING'; end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'membership_level'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'is_active'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'permissions_updated_at'
  ) then raise exception 'MEMBER_CANONICAL_COLUMNS_MISSING'; end if;

  if to_regclass('public.profiles_membership_expiry_idx') is null then
    raise exception 'MEMBER_EXPIRY_INDEX_MISSING';
  end if;
  if to_regclass('public.member_permission_audit') is null then
    raise exception 'MEMBER_AUDIT_TABLE_MISSING';
  end if;

  select pg_get_functiondef('public.current_membership_level()'::regprocedure)
  into current_level_definition;
  if current_level_definition not ilike '%membership_expires_at%'
     or current_level_definition not ilike '%now()%' then
    raise exception 'MEMBER_LEVEL_EXPIRY_GUARD_MISSING';
  end if;

  select pg_get_functiondef('public.is_approved_member()'::regprocedure)
  into approved_definition;
  if approved_definition not ilike '%membership_expires_at%'
     or approved_definition not ilike '%now()%' then
    raise exception 'MEMBER_APPROVAL_EXPIRY_GUARD_MISSING';
  end if;

  select pg_get_functiondef('public.is_admin()'::regprocedure)
  into admin_definition;
  if admin_definition not ilike '%current_membership_level%' then
    raise exception 'MEMBER_ADMIN_CANONICAL_GUARD_MISSING';
  end if;

  if to_regprocedure('public.apply_member_permission_change(uuid,text,boolean,timestamptz,text,timestamptz)') is null then
    raise exception 'MEMBER_PERMISSION_CHANGE_SIGNATURE_MISSING';
  end if;

  select qual into policy_qual
  from pg_catalog.pg_policies
  where schemaname = 'public'
    and tablename = 'paper_journal_entries'
    and policyname = 'paper_journal_entries select own';
  if policy_qual is null
     or policy_qual not ilike '%associate%'
     or policy_qual not ilike '%auth.uid()%'
     or policy_qual not ilike '%user_id%' then
    raise exception 'MEMBER_ASSOCIATE_JOURNAL_POLICY_INVALID';
  end if;

  select pg_get_constraintdef(oid) into action_constraint
  from pg_catalog.pg_constraint
  where conrelid = 'public.member_permission_audit'::regclass
    and conname = 'member_permission_audit_action_check';
  if action_constraint is null
     or action_constraint not ilike '%member.password.reset%'
     or action_constraint not ilike '%member.membership.expiry.change%' then
    raise exception 'MEMBER_AUDIT_ACTION_CONTRACT_INVALID';
  end if;

  if exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'profiles'
      and policyname = 'admins update profiles'
  ) then raise exception 'MEMBER_LEGACY_DIRECT_ADMIN_UPDATE_POLICY_PRESENT'; end if;

  if has_table_privilege('authenticated', 'public.profiles', 'UPDATE')
     or not has_table_privilege('authenticated', 'public.member_permission_audit', 'SELECT')
     or not has_table_privilege('authenticated', 'public.member_permission_audit', 'INSERT')
     or has_table_privilege('authenticated', 'public.member_permission_audit', 'UPDATE')
     or has_table_privilege('authenticated', 'public.member_permission_audit', 'DELETE') then
    raise exception 'MEMBER_DIRECT_MUTATION_PRIVILEGE_INVALID';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename = 'member_permission_audit'
      and policyname = 'member audit admins insert'
      and cmd = 'INSERT'
      and with_check ilike '%current_membership_level%'
      and with_check ilike '%auth.uid()%'
      and with_check ilike '%actor_id%'
  ) then raise exception 'MEMBER_ADMIN_AUDIT_INSERT_POLICY_INVALID'; end if;

  if exists (
    select 1 from information_schema.table_privileges
    where table_schema = 'public'
      and table_name = 'profiles'
      and grantee in ('PUBLIC','anon')
  ) then raise exception 'MEMBER_PROFILE_PUBLIC_OR_ANON_PRIVILEGE_PRESENT'; end if;

  if exists (
    select 1 from information_schema.table_privileges
    where table_schema = 'public'
      and table_name = 'profiles'
      and grantee = 'authenticated'
      and privilege_type <> 'SELECT'
  ) or not exists (
    select 1 from information_schema.table_privileges
    where table_schema = 'public'
      and table_name = 'profiles'
      and grantee = 'authenticated'
      and privilege_type = 'SELECT'
  ) then raise exception 'MEMBER_PROFILE_AUTHENTICATED_PRIVILEGE_INVALID'; end if;

  if exists (
    select 1 from information_schema.routine_privileges
    where specific_schema = 'public'
      and routine_name in ('handle_new_user','log_profile_change','rls_auto_enable')
      and grantee in ('PUBLIC','anon','authenticated')
      and privilege_type = 'EXECUTE'
  ) then raise exception 'MEMBER_TRIGGER_SECURITY_DEFINER_DIRECT_EXECUTE_PRESENT'; end if;

  if exists (
    select 1 from information_schema.routine_privileges
    where specific_schema = 'public'
      and routine_name in ('current_membership_level','is_approved_member','is_admin','is_full_member')
      and grantee = 'PUBLIC'
      and privilege_type = 'EXECUTE'
  ) then raise exception 'MEMBER_RLS_HELPER_PUBLIC_EXECUTE_PRESENT'; end if;

  if (select count(*) from public.profiles) <> current_setting('app.member_profiles_before')::bigint then
    raise exception 'MEMBER_PROFILE_ROWS_CHANGED';
  end if;
  if (select count(*) from public.paper_journal_entries) <> current_setting('app.member_journal_before')::bigint then
    raise exception 'MEMBER_JOURNAL_ROWS_CHANGED';
  end if;
  if (select count(*) from public.member_permission_audit) <> current_setting('app.member_audit_before')::bigint then
    raise exception 'MEMBER_AUDIT_ROWS_CHANGED';
  end if;

  select coalesce(jsonb_object_agg(status_text, count_value), '{}'::jsonb)
  into preserved_status_counts
  from (
    select status::text as status_text, count(*)::bigint as count_value
    from public.profiles
    where status::text in ('rejected','suspended','revoked','withdrawn','disabled','inactive')
    group by status::text
  ) snapshot;
  if preserved_status_counts <> current_setting('app.member_preserved_statuses_before')::jsonb then
    raise exception 'MEMBER_HISTORICAL_STATUS_COUNTS_CHANGED';
  end if;

  if exists (
    select 1
    from public.profiles
    where membership_level = 'pending'
      and (
        is_active is true
        or membership_expires_at is not null
        or status::text = 'approved'
        or approved_at is not null
        or approved_by is not null
      )
  ) then raise exception 'MEMBER_PENDING_STATE_NOT_NORMALIZED'; end if;
end
$member_access_hardening_verify$;
`;

const sql = [
  '\\set ON_ERROR_STOP on',
  'begin;',
  "set local lock_timeout = '5s';",
  "set local statement_timeout = '60s';",
  "select pg_advisory_xact_lock(hashtextextended('production-member-access-hardening-v1', 0));",
  "select set_config('app.approved_target_sha', '" + approvedTargetSha + "', true);",
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
if (result.error || result.status !== 0) fail('atomic_member_access_migration_failed');

const artifact = {
  schemaVersion: SCHEMA_VERSION,
  status: 'passed',
  approved_target_sha: approvedTargetSha,
  production_project_match: true,
  database_endpoint_type: database.endpointType,
  atomic_transaction: true,
  migration_applied: 2,
  security_definer_privileges_locked: true,
  profile_api_privileges_least_access: true,
  membership_expiry_ready: true,
  associate_s_ai_policy_ready: true,
  associate_journal_read_only: true,
  historical_statuses_preserved: true,
  profile_row_count_preserved: true,
  journal_row_count_preserved: true,
  audit_row_count_preserved: true,
  credentials_read: false,
  raw_credentials_exposed: false,
  order_submitted: false,
  cancel_submitted: false,
  amend_submitted: false,
  transfer_submitted: false,
  withdrawal_submitted: false,
  private_trading_api_count: 0,
  live_trading_authority_granted: false,
  auto_trading_authority_granted: false,
};

process.stdout.write(JSON.stringify(artifact, null, 2) + '\n');
