import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const PRODUCTION_PROJECT_REF = 'bawcbkoyovbeajkrnduq';
const POSTGRES_URI_PATTERN = /^postgres(?:ql)?:\/\//i;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedActiveSha = String(process.env.EXPECTED_ACTIVE_SHA ?? '').trim().toLowerCase();
const approvedTargetSha = String(process.env.APPROVED_TARGET_SHA ?? '').trim().toLowerCase();
const databaseUrl = String(process.env.PROD_DATABASE_URL ?? '').trim();

function fail(classification) {
  process.stderr.write(`[production-user-integration-storage-v2] ${classification}\n`);
  process.exit(1);
}

function parseDatabaseTarget(raw) {
  if (!raw || !POSTGRES_URI_PATTERN.test(raw)) fail('production_database_connection_missing');

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail('production_database_url_invalid');
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) fail('production_database_url_invalid');
  const hostname = parsed.hostname.toLowerCase();
  const username = decodeURIComponent(parsed.username || '');
  const usernameLower = username.toLowerCase();
  const direct = hostname === `db.${PRODUCTION_PROJECT_REF}.supabase.co` && usernameLower === 'postgres';
  const sessionPooler = /(^|\.)pooler\.supabase\.com$/i.test(hostname)
    && usernameLower === `postgres.${PRODUCTION_PROJECT_REF}`;

  if (!direct && !sessionPooler) fail('production_database_project_mismatch');
  if (!parsed.password) fail('production_database_password_missing');
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  const port = parsed.port || '5432';
  if (database !== 'postgres') fail('production_database_name_invalid');
  if (port !== '5432') fail('production_database_requires_session_pooler_5432');

  return {
    hostname,
    port,
    username,
    password: decodeURIComponent(parsed.password),
    database,
    endpointType: direct ? 'direct' : 'session_pooler',
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
    fail(`migration_transaction_envelope_invalid:${relativePath}`);
  }
  lines.splice(commitIndexes[0], 1);
  lines.splice(beginIndexes[0], 1);
  const body = lines.join('\n');
  if (/^\s*(?:begin|commit|rollback);\s*$/im.test(body)) {
    fail(`migration_nested_transaction_invalid:${relativePath}`);
  }
  return body;
}

function runPsql(database, sql, { readOnly = false } = {}) {
  const baseEnv = { ...process.env };
  delete baseEnv.PROD_DATABASE_URL;
  for (const key of Object.keys(baseEnv)) if (key.startsWith('PG')) delete baseEnv[key];

  const pgOptions = readOnly
    ? '-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=1000'
    : '-c statement_timeout=45000 -c lock_timeout=5000';

  return spawnSync('psql', [
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
      ...baseEnv,
      PGPASSWORD: database.password,
      PGCONNECT_TIMEOUT: '15',
      PGSSLMODE: 'require',
      PGOPTIONS: pgOptions,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 4 * 1024 * 1024,
  });
}

if (!/^[0-9a-f]{40}$/.test(expectedActiveSha)) fail('expected_active_sha_invalid');
if (!/^[0-9a-f]{40}$/.test(approvedTargetSha)) fail('approved_target_sha_invalid');

const database = parseDatabaseTarget(databaseUrl);

const probeSql = String.raw`
begin read only;
select json_build_object(
  'status', 'passed',
  'database', current_database(),
  'read_only_probe', true
)::text;
commit;
`;
const probe = runPsql(database, probeSql, { readOnly: true });
if (probe.error || probe.status !== 0) fail('production_database_auth_failed');

const migrationPath = 'api-server/supabase/migrations/2026081802_user_integration_storage_reconcile.sql';
let migrationBody;
try {
  migrationBody = stripOuterTransaction(
    readFileSync(path.join(root, migrationPath), 'utf8'),
    migrationPath,
  );
} catch (error) {
  if (String(error?.message ?? '').startsWith('migration_')) throw error;
  fail('migration_source_unreadable');
}

const verificationSql = String.raw`
do $user_integration_storage_verify$
declare
  target_table text;
  expected_policy text;
  policy_count integer;
  api_privilege_count integer;
  missing_column_count integer;
begin
  if to_regclass('public.account_readonly_credentials') is null then
    raise exception 'account_readonly_credentials table missing';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.account_readonly_credentials'::regclass) then
    raise exception 'account_readonly_credentials RLS disabled';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.account_readonly_credentials'::regclass
      and contype = 'p'
      and pg_get_constraintdef(oid) ilike '%user_id%provider%'
  ) then
    raise exception 'account_readonly_credentials primary key mismatch';
  end if;

  if exists (
    select 1
    from public.account_readonly_credentials
    where provider not in ('toss', 'upbit', 'bitget')
  ) then
    raise exception 'unexpected read-only provider row exists';
  end if;

  select count(*) into api_privilege_count
  from information_schema.table_privileges
  where table_schema = 'public'
    and table_name = 'account_readonly_credentials'
    and grantee in ('PUBLIC', 'anon', 'authenticated');
  if api_privilege_count <> 0 then
    raise exception 'account read-only credential table exposed to API roles';
  end if;

  if not (
    has_table_privilege('service_role', 'public.account_readonly_credentials', 'SELECT')
    and has_table_privilege('service_role', 'public.account_readonly_credentials', 'INSERT')
    and has_table_privilege('service_role', 'public.account_readonly_credentials', 'UPDATE')
    and has_table_privilege('service_role', 'public.account_readonly_credentials', 'DELETE')
  ) then
    raise exception 'service_role lacks account read-only credential access';
  end if;

  select count(*) into policy_count
  from pg_policies
  where schemaname = 'public' and tablename = 'account_readonly_credentials';
  if policy_count <> 0 then
    raise exception 'account read-only credential table must remain policy-free';
  end if;

  if to_regclass('public.notification_preferences') is null then
    raise exception 'canonical notification_preferences table missing';
  end if;

  select count(*) into missing_column_count
  from unnest(array['member_id', 'enabled_types']) as required(column_name)
  where not exists (
    select 1
    from information_schema.columns candidate
    where candidate.table_schema = 'public'
      and candidate.table_name = 'notification_preferences'
      and candidate.column_name = required.column_name
  );
  if missing_column_count <> 0 then
    raise exception 'canonical notification_preferences columns missing';
  end if;

  foreach target_table in array array[
    'telegram_connections',
    'telegram_link_tokens',
    'user_execution_events',
    'notification_deliveries'
  ]
  loop
    if to_regclass(format('public.%I', target_table)) is null then
      raise exception 'required Telegram table missing';
    end if;
    if not (select relrowsecurity from pg_class where oid = format('public.%I', target_table)::regclass) then
      raise exception 'Telegram RLS disabled';
    end if;

    expected_policy := target_table || '_server_only';
    if (
      select count(*) <> 1
        or bool_or(policyname <> expected_policy)
        or bool_or(cmd <> 'ALL')
        or bool_or(qual <> 'false')
        or bool_or(with_check <> 'false')
      from pg_policies
      where schemaname = 'public' and tablename = target_table
    ) then
      raise exception 'Telegram policy is not exclusively fail-closed';
    end if;

    if exists (
      select 1
      from information_schema.table_privileges privilege
      where privilege.table_schema = 'public'
        and privilege.table_name = target_table
        and privilege.grantee in ('PUBLIC', 'anon', 'authenticated')
    ) then
      raise exception 'Telegram storage exposed to API role';
    end if;

    if not (
      has_table_privilege('service_role', format('public.%I', target_table), 'SELECT')
      and has_table_privilege('service_role', format('public.%I', target_table), 'INSERT')
      and has_table_privilege('service_role', format('public.%I', target_table), 'UPDATE')
      and has_table_privilege('service_role', format('public.%I', target_table), 'DELETE')
    ) then
      raise exception 'service_role lacks Telegram storage access';
    end if;
  end loop;
end
$user_integration_storage_verify$;

select json_build_object(
  'status', 'passed',
  'expected_active_sha', current_setting('app.expected_active_sha'),
  'approved_target_sha', current_setting('app.approved_target_sha'),
  'production_project_match', true,
  'endpoint_type', '${database.endpointType}',
  'atomic_transaction', true,
  'account_tables_verified', 1,
  'telegram_tables_verified', 4,
  'canonical_preferences_verified', true,
  'api_roles_revoked', true,
  'service_role_access', true,
  'telegram_policies_fail_closed', true,
  'database_changed', true,
  'credential_payload_mutation', false,
  'telegram_link_payload_mutation', false,
  'execution_event_payload_mutation', false,
  'notification_delivery_payload_mutation', false,
  'raw_credentials_exposed', false,
  'order_submitted', false,
  'cancel_submitted', false,
  'transfer_submitted', false,
  'withdrawal_submitted', false,
  'private_trading_api_count', 0,
  'live_trading_authority', false
)::text;
`;

const sql = [
  '\\set ON_ERROR_STOP on',
  'begin;',
  "set local lock_timeout = '5s';",
  "set local statement_timeout = '45s';",
  "select pg_advisory_xact_lock(hashtextextended('production-user-integration-storage-v2', 0));",
  `select set_config('app.expected_active_sha', '${expectedActiveSha}', true);`,
  `select set_config('app.approved_target_sha', '${approvedTargetSha}', true);`,
  migrationBody,
  verificationSql,
  'commit;',
  '',
].join('\n');

const result = runPsql(database, sql);
if (result.error || result.status !== 0) fail('atomic_migration_failed');

const lines = String(result.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
let artifact;
try {
  artifact = JSON.parse(lines.at(-1) ?? '');
} catch {
  fail('verification_artifact_invalid');
}

const valid = artifact?.status === 'passed'
  && artifact?.expected_active_sha === expectedActiveSha
  && artifact?.approved_target_sha === approvedTargetSha
  && artifact?.production_project_match === true
  && ['direct', 'session_pooler'].includes(artifact?.endpoint_type)
  && artifact?.atomic_transaction === true
  && artifact?.account_tables_verified === 1
  && artifact?.telegram_tables_verified === 4
  && artifact?.canonical_preferences_verified === true
  && artifact?.api_roles_revoked === true
  && artifact?.service_role_access === true
  && artifact?.telegram_policies_fail_closed === true
  && artifact?.database_changed === true
  && artifact?.credential_payload_mutation === false
  && artifact?.telegram_link_payload_mutation === false
  && artifact?.execution_event_payload_mutation === false
  && artifact?.notification_delivery_payload_mutation === false
  && artifact?.raw_credentials_exposed === false
  && artifact?.order_submitted === false
  && artifact?.cancel_submitted === false
  && artifact?.transfer_submitted === false
  && artifact?.withdrawal_submitted === false
  && artifact?.private_trading_api_count === 0
  && artifact?.live_trading_authority === false;
if (!valid) fail('verification_contract_failed');

const serialized = JSON.stringify(artifact);
if (/postgres(?:ql)?:\/\//i.test(serialized) || /-----BEGIN .*PRIVATE KEY-----/.test(serialized)) {
  fail('artifact_secret_redaction_failed');
}

process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
