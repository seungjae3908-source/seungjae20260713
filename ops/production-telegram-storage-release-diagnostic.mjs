import { accessSync, constants as fsConstants, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';

const PRODUCTION_PROJECT_REF = 'bawcbkoyovbeajkrnduq';
const POSTGRES_URI_PATTERN = /^postgres(?:ql)?:\/\//i;
const ARTIFACT_KEYS = new Set([
  'status', 'classification', 'production_sha', 'pm2_online',
  'production_process_sha_match', 'production_project_match',
  'postgres_connection_count', 'postgres_endpoint_type', 'postgres_port',
  'database_secret_source', 'read_only_probe', 'auth_users_exists',
  'required_roles_exist', 'notification_preferences_ready',
  'telegram_existing_schema_compatible', 'public_schema_create',
  'auth_users_references', 'existing_telegram_owned_or_superuser',
  'blocking_relation_lock_detected', 'release_preflight_ready',
  'database_changed', 'server_files_written', 'server_processes_restarted',
  'production_deployment_executed', 'credentials_recorded',
  'raw_user_data_exposed', 'order_submitted', 'private_trading_api_count',
  'live_trading_authority',
]);

function verifyArtifact(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('artifact must be an object');
  for (const key of Object.keys(value)) if (!ARTIFACT_KEYS.has(key)) throw new Error(`unexpected artifact key: ${key}`);
  if (!['passed', 'blocked'].includes(value.status)) throw new Error('status invalid');
  if (!/^[a-z0-9_]+$/.test(String(value.classification ?? ''))) throw new Error('classification invalid');
  if (!/^[0-9a-f]{40}$/.test(String(value.production_sha ?? ''))) throw new Error('production_sha invalid');
  if (![0, 1].includes(value.postgres_connection_count)) throw new Error('postgres_connection_count invalid');
  if (!['direct', 'pooler', 'unresolved'].includes(value.postgres_endpoint_type)) throw new Error('endpoint invalid');
  if (!['5432', 'unresolved'].includes(value.postgres_port)) throw new Error('port invalid');
  if (!['github_protected_secret', 'unresolved'].includes(value.database_secret_source)) throw new Error('secret source invalid');
  for (const key of [
    'pm2_online', 'production_process_sha_match', 'production_project_match', 'read_only_probe',
    'auth_users_exists', 'required_roles_exist', 'notification_preferences_ready',
    'telegram_existing_schema_compatible', 'public_schema_create', 'auth_users_references',
    'existing_telegram_owned_or_superuser', 'blocking_relation_lock_detected',
    'release_preflight_ready', 'database_changed', 'production_deployment_executed',
    'credentials_recorded', 'raw_user_data_exposed', 'order_submitted', 'live_trading_authority',
  ]) if (typeof value[key] !== 'boolean') throw new Error(`${key} must be boolean`);
  if (value.server_files_written !== 0 || value.server_processes_restarted !== 0) throw new Error('server mutation must be zero');
  if (value.database_changed !== false || value.production_deployment_executed !== false) throw new Error('mutation must be false');
  if (value.credentials_recorded !== false || value.raw_user_data_exposed !== false) throw new Error('privacy contract failed');
  if (value.order_submitted !== false || value.private_trading_api_count !== 0 || value.live_trading_authority !== false) throw new Error('trading authority must be zero');
  const text = JSON.stringify(value);
  if (/postgres(?:ql)?:\/\//i.test(text) || /BEGIN (?:RSA|OPENSSH|EC) PRIVATE KEY/i.test(text)) throw new Error('secret-like artifact material');
  return true;
}

if (process.argv[2] === '--verify-artifact') {
  const file = process.argv[3];
  if (!file) throw new Error('artifact path required');
  verifyArtifact(JSON.parse(readFileSync(file, 'utf8')));
  process.stdout.write('production Telegram storage release diagnostic artifact: PASS\n');
  process.exit(0);
}

function isExecutable(path) {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function psqlExistsOutsidePath() {
  const candidates = ['/usr/bin/psql', '/usr/local/bin/psql'];
  try {
    for (const entry of readdirSync('/usr/lib/postgresql', { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[0-9]+(?:\.[0-9]+)?$/.test(entry.name)) continue;
      candidates.push(join('/usr/lib/postgresql', entry.name, 'bin', 'psql'));
    }
  } catch {}
  return candidates.some(isExecutable);
}

const expectedProductionSha = String(process.env.EXPECTED_PRODUCTION_SHA ?? '').trim().toLowerCase();
const transientDatabaseUrl = String(process.env.PROD_DATABASE_URL ?? '').trim();
const base = {
  status: 'blocked', classification: 'unknown', production_sha: expectedProductionSha,
  pm2_online: false, production_process_sha_match: false, production_project_match: false,
  postgres_connection_count: 0, postgres_endpoint_type: 'unresolved', postgres_port: 'unresolved',
  database_secret_source: 'unresolved', read_only_probe: false, auth_users_exists: false,
  required_roles_exist: false, notification_preferences_ready: false,
  telegram_existing_schema_compatible: false, public_schema_create: false,
  auth_users_references: false, existing_telegram_owned_or_superuser: false,
  blocking_relation_lock_detected: false, release_preflight_ready: false,
  database_changed: false, server_files_written: 0, server_processes_restarted: 0,
  production_deployment_executed: false, credentials_recorded: false,
  raw_user_data_exposed: false, order_submitted: false, private_trading_api_count: 0,
  live_trading_authority: false,
};
function emit(overrides = {}) {
  const value = { ...base, ...overrides };
  verifyArtifact(value);
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
function blocked(classification, overrides = {}) {
  emit({ ...overrides, status: 'blocked', classification, release_preflight_ready: false });
  process.exit(0);
}
if (!/^[0-9a-f]{40}$/.test(expectedProductionSha)) blocked('invalid_production_sha');

const pm2 = spawnSync('pm2', ['jlist'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
if (pm2.error || pm2.status !== 0) blocked('pm2_unavailable');
let processes;
try { processes = JSON.parse(pm2.stdout); } catch { blocked('pm2_response_invalid'); }
const runtime = processes.find((item) => item?.name === 'stock-app')?.pm2_env;
if (!runtime || runtime.status !== 'online') blocked('production_process_unavailable');
if (String(runtime.DEPLOY_SHA ?? '').trim().toLowerCase() !== expectedProductionSha) {
  blocked('production_process_sha_mismatch', { pm2_online: true });
}

let projectRef = '';
try {
  const parsed = new URL(String(runtime.SUPABASE_URL ?? '').trim());
  const match = /^([a-z0-9]+)\.supabase\.co$/i.exec(parsed.hostname);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port
    || !['', '/'].includes(parsed.pathname) || parsed.search || parsed.hash
    || match?.[1]?.toLowerCase() !== PRODUCTION_PROJECT_REF) throw new Error('project mismatch');
  projectRef = match[1].toLowerCase();
} catch {
  blocked('production_project_mismatch', { pm2_online: true, production_process_sha_match: true });
}
const identity = { pm2_online: true, production_process_sha_match: true, production_project_match: true };
if (!transientDatabaseUrl) blocked('production_database_secret_missing', identity);
if (!POSTGRES_URI_PATTERN.test(transientDatabaseUrl)) {
  blocked('production_database_secret_invalid', { ...identity, database_secret_source: 'github_protected_secret' });
}

let database;
try {
  const parsed = new URL(transientDatabaseUrl);
  const hostname = parsed.hostname.toLowerCase();
  const username = decodeURIComponent(parsed.username);
  const direct = hostname === `db.${projectRef}.supabase.co` && username.toLowerCase() === 'postgres';
  const pooler = /(^|\.)pooler\.supabase\.com$/i.test(hostname) && username.toLowerCase() === `postgres.${projectRef}`;
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  const port = parsed.port || '5432';
  if ((!direct && !pooler) || !parsed.password || databaseName !== 'postgres' || port !== '5432') throw new Error('bad target');
  database = { hostname, username, password: decodeURIComponent(parsed.password), database: databaseName, port, endpointType: direct ? 'direct' : 'pooler' };
} catch {
  blocked('production_database_project_mismatch', { ...identity, postgres_connection_count: 1, database_secret_source: 'github_protected_secret' });
}
const connected = { ...identity, postgres_connection_count: 1, postgres_endpoint_type: database.endpointType, postgres_port: database.port, database_secret_source: 'github_protected_secret' };

const SQL = String.raw`
\set ON_ERROR_STOP on
begin read only;
set local statement_timeout = '8s';
set local lock_timeout = '1s';
with targets(name) as (values ('telegram_connections'),('telegram_link_tokens'),('user_execution_events'),('notification_deliveries')),
required_columns(table_name, column_name) as (values
  ('telegram_connections','user_id'),('telegram_connections','telegram_chat_id'),('telegram_connections','telegram_user_id'),('telegram_connections','status'),('telegram_connections','connected_at'),('telegram_connections','revoked_at'),('telegram_connections','updated_at'),
  ('telegram_link_tokens','token_hash'),('telegram_link_tokens','user_id'),('telegram_link_tokens','expires_at'),('telegram_link_tokens','consumed_at'),('telegram_link_tokens','created_at'),
  ('user_execution_events','user_id'),('user_execution_events','id'),('user_execution_events','source_event_id'),('user_execution_events','event_type'),('user_execution_events','source'),('user_execution_events','payload'),('user_execution_events','occurred_at'),('user_execution_events','created_at'),
  ('notification_deliveries','user_id'),('notification_deliveries','id'),('notification_deliveries','event_id'),('notification_deliveries','dedupe_key'),('notification_deliveries','state'),('notification_deliveries','attempts'),('notification_deliveries','next_retry_at'),('notification_deliveries','last_error_code'),('notification_deliveries','created_at'),('notification_deliveries','updated_at')
), existing as (
  select t.name, c.oid, pg_get_userbyid(c.relowner) owner_name
  from targets t left join pg_class c on c.relname=t.name and c.relnamespace='public'::regnamespace and c.relkind in ('r','p')
), flags as (
  select
    to_regclass('auth.users') is not null auth_users_exists,
    (select count(*)=3 from pg_roles where rolname in ('anon','authenticated','service_role')) required_roles_exist,
    to_regclass('public.notification_preferences') is not null
      and exists (select 1 from information_schema.columns where table_schema='public' and table_name='notification_preferences' and column_name='member_id')
      and exists (select 1 from information_schema.columns where table_schema='public' and table_name='notification_preferences' and column_name='enabled_types')
      and exists (select 1 from pg_index i join pg_class c on c.oid=i.indrelid join pg_attribute a on a.attrelid=c.oid and a.attname='member_id' where c.relnamespace='public'::regnamespace and c.relname='notification_preferences' and i.indisunique and i.indnatts=1 and a.attnum=any(i.indkey)) notification_preferences_ready,
    not exists (select 1 from required_columns r join existing e on e.name=r.table_name and e.oid is not null where not exists (select 1 from information_schema.columns c where c.table_schema='public' and c.table_name=r.table_name and c.column_name=r.column_name)) telegram_existing_schema_compatible,
    has_schema_privilege(current_user,'public','CREATE') public_schema_create,
    case when to_regclass('auth.users') is null then false else has_table_privilege(current_user,'auth.users','REFERENCES') end auth_users_references,
    coalesce((select rolsuper from pg_roles where rolname=current_user),false) or not exists (select 1 from existing where oid is not null and owner_name<>current_user) existing_telegram_owned_or_superuser,
    exists (select 1 from pg_locks l join existing e on e.oid=l.relation where l.pid<>pg_backend_pid() and l.granted) blocking_relation_lock_detected
)
select row_to_json(flags)::text from flags;
rollback;
`;
const childEnv = { ...process.env };
for (const key of Object.keys(childEnv)) if (key.startsWith('PG')) delete childEnv[key];
delete childEnv.PROD_DATABASE_URL;
const result = spawnSync('psql', ['-X','--no-psqlrc','--quiet','--tuples-only','--no-align','--set=ON_ERROR_STOP=1','--host',database.hostname,'--port',database.port,'--username',database.username,'--dbname',database.database], {
  input: SQL, encoding: 'utf8', env: { ...childEnv, PGPASSWORD: database.password, PGCONNECT_TIMEOUT: '15', PGSSLMODE: 'require' }, stdio: ['pipe','pipe','pipe'], maxBuffer: 4 * 1024 * 1024,
});
if (result.error?.code === 'ENOENT') {
  if (psqlExistsOutsidePath()) blocked('psql_installed_outside_path', connected);
  blocked('psql_not_installed', connected);
}
if (result.error || result.status !== 0) {
  const stderr = String(result.stderr ?? '').toLowerCase();
  let classification = 'production_database_readonly_query_failed';
  if (/password authentication failed|authentication failed/.test(stderr)) classification = 'production_database_auth_failed';
  else if (/could not translate host name|could not connect|connection refused|connection timed out|server closed the connection|network is unreachable/.test(stderr)) classification = 'production_database_connection_failed';
  else if (/permission denied/.test(stderr)) classification = 'production_database_readonly_permission_failed';
  else if (/statement timeout|lock timeout|canceling statement/.test(stderr)) classification = 'production_database_readonly_timeout';
  blocked(classification, connected);
}
let catalog;
try {
  catalog = JSON.parse(String(result.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? '');
} catch {
  blocked('production_database_readonly_artifact_invalid', { ...connected, read_only_probe: true });
}
const evidence = { ...connected, read_only_probe: true,
  auth_users_exists: catalog.auth_users_exists === true,
  required_roles_exist: catalog.required_roles_exist === true,
  notification_preferences_ready: catalog.notification_preferences_ready === true,
  telegram_existing_schema_compatible: catalog.telegram_existing_schema_compatible === true,
  public_schema_create: catalog.public_schema_create === true,
  auth_users_references: catalog.auth_users_references === true,
  existing_telegram_owned_or_superuser: catalog.existing_telegram_owned_or_superuser === true,
  blocking_relation_lock_detected: catalog.blocking_relation_lock_detected === true,
};
if (!evidence.auth_users_exists) blocked('auth_users_missing', evidence);
if (!evidence.required_roles_exist) blocked('required_database_role_missing', evidence);
if (!evidence.notification_preferences_ready) blocked('notification_preferences_incompatible', evidence);
if (!evidence.telegram_existing_schema_compatible) blocked('existing_telegram_schema_incompatible', evidence);
if (!evidence.public_schema_create || !evidence.auth_users_references || !evidence.existing_telegram_owned_or_superuser) blocked('migration_privilege_insufficient', evidence);
if (evidence.blocking_relation_lock_detected) blocked('migration_lock_contention_detected', evidence);
emit({ ...evidence, status: 'passed', classification: 'ready_for_atomic_migration_diagnostic', release_preflight_ready: true });
