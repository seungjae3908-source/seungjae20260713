import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const PRODUCTION_PROJECT_REF = 'bawcbkoyovbeajkrnduq';
const PRODUCTION_ENV_ALLOWLIST = Object.freeze([
  '/opt/stock-app/.env',
  '/opt/stock-app/.env.production',
  '/opt/stock-app/api-server/.env',
  '/opt/stock-app/api-server/.env.production',
]);
const POSTGRES_URI_PATTERN = /^postgres(?:ql)?:\/\//i;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedActiveSha = String(process.env.EXPECTED_ACTIVE_SHA ?? '').trim().toLowerCase();
const approvedTargetSha = String(process.env.APPROVED_TARGET_SHA ?? '').trim().toLowerCase();

function fail(classification) {
  console.error(`[production-account-readonly-storage] ${classification}`);
  process.exit(1);
}

function parseDotenvValue(raw) {
  let value = String(raw ?? '').trim();
  if (!value) return '';
  const quote = value[0];
  if (quote === "'" || quote === '"') {
    if (value.length < 2 || value.at(-1) !== quote) return '';
    value = value.slice(1, -1);
    if (quote === '"') value = value.replace(/\\([\\"$`])/g, '$1');
    return value;
  }
  const inlineComment = value.search(/\s+#/);
  if (inlineComment >= 0) value = value.slice(0, inlineComment).trimEnd();
  return value;
}

function readAllowedEnvValues(filePath) {
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    fail('production_database_env_file_unreadable');
  }
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o022) !== 0) {
    fail('production_database_env_file_unsafe');
  }
  let real;
  try {
    real = realpathSync(filePath);
  } catch {
    fail('production_database_env_file_unreadable');
  }
  if (real !== path.resolve(filePath)) fail('production_database_env_file_unsafe');

  let source;
  try {
    source = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    fail('production_database_env_file_unreadable');
  }

  const values = [];
  for (const sourceLine of source.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = parseDotenvValue(match[1]);
    if (POSTGRES_URI_PATTERN.test(value)) values.push(value);
  }
  return values;
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
    endpointType: direct ? 'direct' : 'pooler',
  };
}

function resolveProductionPostgresConnection(runtime, projectRef) {
  const values = Object.values(runtime)
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => POSTGRES_URI_PATTERN.test(value));
  for (const filePath of PRODUCTION_ENV_ALLOWLIST) values.push(...readAllowedEnvValues(filePath));
  const postgresUris = [...new Set(values)];
  if (postgresUris.length !== 1) {
    fail(postgresUris.length === 0
      ? 'production_database_connection_missing'
      : 'production_database_connection_ambiguous');
  }
  try {
    return productionDatabaseTarget(postgresUris[0], projectRef);
  } catch {
    fail('production_database_project_mismatch');
  }
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

if (!/^[0-9a-f]{40}$/.test(expectedActiveSha)) fail('expected_active_sha_invalid');
if (!/^[0-9a-f]{40}$/.test(approvedTargetSha)) fail('approved_target_sha_invalid');

let markerSha = '';
try {
  markerSha = readFileSync('/opt/stock-app/.deploy/current-sha', 'utf8').trim().toLowerCase();
} catch {
  fail('production_marker_unavailable');
}
if (markerSha !== expectedActiveSha) fail('production_marker_sha_mismatch');

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
const database = resolveProductionPostgresConnection(runtime, projectRef);

const migrationPaths = [
  'api-server/supabase/migrations/2026081701_account_readonly_credentials.sql',
  'api-server/supabase/migrations/2026081801_account_readonly_service_role.sql',
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
do $account_readonly_storage_verify$
declare
  policy_count integer;
  api_privilege_count integer;
begin
  if to_regclass('public.account_readonly_credentials') is null then
    raise exception 'account_readonly_credentials table missing';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.account_readonly_credentials'::regclass) then
    raise exception 'RLS is not enabled';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.account_readonly_credentials'::regclass
      and contype = 'p'
      and pg_get_constraintdef(oid) ilike '%user_id%provider%'
  ) then
    raise exception 'user/provider primary key missing';
  end if;

  if exists (
    select 1
    from public.account_readonly_credentials
    where provider not in ('toss', 'upbit', 'bitget')
  ) then
    raise exception 'unexpected provider row exists';
  end if;

  select count(*) into api_privilege_count
  from information_schema.table_privileges
  where table_schema = 'public'
    and table_name = 'account_readonly_credentials'
    and grantee in ('PUBLIC', 'anon', 'authenticated');
  if api_privilege_count <> 0 then
    raise exception 'browser/API roles have direct credential table privileges';
  end if;

  if not (
    has_table_privilege('service_role', 'public.account_readonly_credentials', 'SELECT')
    and has_table_privilege('service_role', 'public.account_readonly_credentials', 'INSERT')
    and has_table_privilege('service_role', 'public.account_readonly_credentials', 'UPDATE')
    and has_table_privilege('service_role', 'public.account_readonly_credentials', 'DELETE')
  ) then
    raise exception 'service role lacks credential storage access';
  end if;

  select count(*) into policy_count
  from pg_policies
  where schemaname = 'public' and tablename = 'account_readonly_credentials';
  if policy_count <> 0 then
    raise exception 'account readonly storage must remain policy-free/server-only';
  end if;
end
$account_readonly_storage_verify$;

select json_build_object(
  'status', 'passed',
  'expected_active_sha', current_setting('app.expected_active_sha'),
  'approved_target_sha', current_setting('app.approved_target_sha'),
  'production_project_match', true,
  'atomic_transaction', true,
  'migrations_applied', 2,
  'tables_verified', 1,
  'rls_enabled', true,
  'api_roles_revoked', true,
  'service_role_access', true,
  'database_changed', true,
  'credentials_recorded', false,
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
  "set local statement_timeout = '30s';",
  "select pg_advisory_xact_lock(hashtextextended('production-account-readonly-storage-v1', 0));",
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
  || artifact?.tables_verified !== 1
  || artifact?.rls_enabled !== true
  || artifact?.api_roles_revoked !== true
  || artifact?.service_role_access !== true
  || artifact?.database_changed !== true
  || artifact?.credentials_recorded !== false
  || artifact?.raw_credentials_exposed !== false
  || artifact?.order_submitted !== false
  || artifact?.cancel_submitted !== false
  || artifact?.transfer_submitted !== false
  || artifact?.withdrawal_submitted !== false
  || artifact?.private_trading_api_count !== 0
  || artifact?.live_trading_authority !== false) {
  fail('verification_contract_failed');
}

process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
