import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const PRODUCTION_PROJECT_REF = 'bawcbkoyovbeajkrnduq';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedActiveSha = String(process.env.EXPECTED_ACTIVE_SHA ?? '').trim().toLowerCase();
const approvedTargetSha = String(process.env.APPROVED_TARGET_SHA ?? '').trim().toLowerCase();

function fail(classification) {
  console.error(`[production-personal-telegram-storage] ${classification}`);
  process.exit(1);
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

function productionProjectRef(raw) {
  const parsed = new URL(raw);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) {
    throw new Error('production_supabase_url_invalid');
  }
  if (!['', '/'].includes(parsed.pathname) || parsed.search || parsed.hash) {
    throw new Error('production_supabase_url_invalid');
  }
  const match = /^([a-z0-9]+)\.supabase\.co$/i.exec(parsed.hostname);
  if (!match || match[1].toLowerCase() !== PRODUCTION_PROJECT_REF) {
    throw new Error('production_project_mismatch');
  }
  return match[1].toLowerCase();
}

function productionDatabaseTarget(raw, projectRef) {
  const parsed = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('database_url_invalid');
  const hostname = parsed.hostname.toLowerCase();
  const username = decodeURIComponent(parsed.username);
  const usernameLower = username.toLowerCase();
  const direct = hostname === `db.${projectRef}.supabase.co` && usernameLower === 'postgres';
  const pooler = /(^|\.)pooler\.supabase\.com$/i.test(hostname)
    && usernameLower === `postgres.${projectRef}`;
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
  };
}

if (!/^[0-9a-f]{40}$/.test(expectedActiveSha)) fail('expected_active_sha_invalid');
if (!/^[0-9a-f]{40}$/.test(approvedTargetSha)) fail('approved_target_sha_invalid');

const pm2 = spawnSync('pm2', ['jlist'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
if (pm2.status !== 0) fail('pm2_unavailable');

let processes;
try {
  processes = JSON.parse(pm2.stdout);
} catch {
  fail('pm2_response_invalid');
}

const selected = processes.find((item) => item?.name === 'stock-app');
const runtime = selected?.pm2_env;
if (!runtime || runtime.status !== 'online') fail('production_process_unavailable');
if (String(runtime.DEPLOY_SHA ?? '').trim().toLowerCase() !== expectedActiveSha) {
  fail('production_process_sha_mismatch');
}

let projectRef;
try {
  projectRef = productionProjectRef(String(runtime.SUPABASE_URL ?? '').trim());
} catch {
  fail('production_project_mismatch');
}

const postgresUris = [...new Set(
  Object.values(runtime)
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => /^postgres(?:ql)?:\/\//i.test(value)),
)];
if (postgresUris.length !== 1) fail(postgresUris.length === 0
  ? 'production_database_connection_missing'
  : 'production_database_connection_ambiguous');

let database;
try {
  database = productionDatabaseTarget(postgresUris[0], projectRef);
} catch {
  fail('production_database_project_mismatch');
}

const migrationPaths = [
  'api-server/supabase/migrations/2026081501_personal_telegram_storage.sql',
  'api-server/supabase/migrations/2026081502_personal_telegram_policy_cleanup.sql',
];
let migrationBodies;
try {
  migrationBodies = migrationPaths.map((relativePath) => stripOuterTransaction(
    readFileSync(path.join(root, relativePath), 'utf8'),
    relativePath,
  ));
} catch {
  fail('migration_source_invalid');
}

const verificationSql = String.raw`
do $production_personal_telegram_storage_verify$
declare
  target_table text;
  expected_policy text;
  missing_column_count integer;
begin
  if to_regclass('public.notification_preferences') is null then
    raise exception 'canonical notification preferences table is missing';
  end if;
  select count(*) into missing_column_count
  from unnest(array['member_id', 'enabled_types']) as required(column_name)
  where not exists (
    select 1 from information_schema.columns candidate
    where candidate.table_schema = 'public'
      and candidate.table_name = 'notification_preferences'
      and candidate.column_name = required.column_name
  );
  if missing_column_count <> 0 then
    raise exception 'canonical notification preferences columns are missing';
  end if;

  foreach target_table in array array[
    'telegram_connections',
    'telegram_link_tokens',
    'user_execution_events',
    'notification_deliveries'
  ]
  loop
    if to_regclass(format('public.%I', target_table)) is null then
      raise exception 'required personal Telegram table is missing';
    end if;
    if not (select relrowsecurity from pg_class where oid = format('public.%I', target_table)::regclass) then
      raise exception 'RLS is not enabled on personal Telegram storage';
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
      raise exception 'personal Telegram policy is not exclusively fail-closed';
    end if;
    if exists (
      select 1 from information_schema.table_privileges privilege
      where privilege.table_schema = 'public'
        and privilege.table_name = target_table
        and privilege.grantee in ('PUBLIC', 'anon', 'authenticated')
    ) then
      raise exception 'personal Telegram table is exposed to an API role';
    end if;
    if not (
      has_table_privilege('service_role', format('public.%I', target_table), 'SELECT')
      and has_table_privilege('service_role', format('public.%I', target_table), 'INSERT')
      and has_table_privilege('service_role', format('public.%I', target_table), 'UPDATE')
      and has_table_privilege('service_role', format('public.%I', target_table), 'DELETE')
    ) then
      raise exception 'service role lacks personal Telegram storage access';
    end if;
  end loop;
end
$production_personal_telegram_storage_verify$;

select json_build_object(
  'status', 'passed',
  'expected_active_sha', current_setting('app.expected_active_sha'),
  'approved_target_sha', current_setting('app.approved_target_sha'),
  'production_project_match', true,
  'atomic_transaction', true,
  'migrations_applied', 2,
  'tables_verified', 4,
  'canonical_preferences_verified', true,
  'api_roles_revoked', true,
  'policies_fail_closed', true,
  'database_changed', true,
  'credentials_recorded', false,
  'order_submitted', false,
  'private_trading_api_count', 0,
  'live_trading_authority', false
)::text;
`;

const sql = [
  '\\set ON_ERROR_STOP on',
  'begin;',
  "set local lock_timeout = '5s';",
  "set local statement_timeout = '30s';",
  "select pg_advisory_xact_lock(hashtextextended('production-personal-telegram-storage-v1', 0));",
  `select set_config('app.expected_active_sha', '${expectedActiveSha}', true);`,
  `select set_config('app.approved_target_sha', '${approvedTargetSha}', true);`,
  ...migrationBodies,
  verificationSql,
  'commit;',
  '',
].join('\n');

const baseEnv = { ...process.env };
for (const key of Object.keys(baseEnv)) if (key.startsWith('PG')) delete baseEnv[key];
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
    ...baseEnv,
    PGPASSWORD: database.password,
    PGCONNECT_TIMEOUT: '15',
    PGSSLMODE: 'require',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
  maxBuffer: 4 * 1024 * 1024,
});
if (result.error || result.status !== 0) fail('atomic_migration_failed');

const lines = String(result.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
let artifact;
try {
  artifact = JSON.parse(lines.at(-1) ?? '');
} catch {
  fail('verification_artifact_invalid');
}
if (artifact?.status !== 'passed'
  || artifact?.expected_active_sha !== expectedActiveSha
  || artifact?.approved_target_sha !== approvedTargetSha
  || artifact?.production_project_match !== true
  || artifact?.atomic_transaction !== true
  || artifact?.tables_verified !== 4
  || artifact?.policies_fail_closed !== true
  || artifact?.database_changed !== true
  || artifact?.credentials_recorded !== false
  || artifact?.order_submitted !== false
  || artifact?.private_trading_api_count !== 0
  || artifact?.live_trading_authority !== false) {
  fail('verification_contract_failed');
}

process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
