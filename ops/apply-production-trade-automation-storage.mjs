import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCHEMA_VERSION = 'production-trade-automation-storage-apply-v1';
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
  console.error(`[production-trade-automation-storage] ${classification}`);
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

function requireFalseFlag(key) {
  const value = runtime[key];
  if (value === undefined || value === null || value === false || value === 'false' || value === 0 || value === '0' || value === '') return;
  fail('trading_authority_must_be_off_' + key.toLowerCase());
}
for (const key of [
  'LIVE_TRADING', 'AUTO_TRADING', 'REAL_ORDER_ENABLED', 'PRIVATE_TRADING_API_ALLOWED',
  'ORDER_EXECUTION_ENABLED', 'LIVE_TRADING_ACTIVATION_APPROVED', 'LIVE_AUTOMATIC_TRADING_ENABLED',
  'BITGET_LIVE_ORDER_ENABLED', 'UPBIT_LIVE_ORDER_ENABLED', 'KIWOOM_LIVE_ORDER_ENABLED', 'TOSS_LIVE_ORDER_ENABLED',
]) requireFalseFlag(key);
if (String(runtime.executionAuthority ?? 'NONE').trim().toUpperCase() !== 'NONE') {
  fail('execution_authority_must_be_none');
}

let projectRef;
try {
  projectRef = productionProjectRef(String(runtime.SUPABASE_URL ?? '').trim());
} catch {
  fail('production_project_mismatch');
}
const database = resolveProductionPostgresConnection(runtime, projectRef);

const migrationPaths = [
  'api-server/supabase/migrations/2026092801_trade_membership_compatibility.sql',
  'api-server/supabase/migrations/2026080301_trade_automation_integration.sql',
  'api-server/supabase/migrations/2026080502_trade_automation_safety_hardening.sql',
  'api-server/supabase/migrations/2026080503_trade_recovery_worker_leases.sql',
  'api-server/supabase/migrations/2026080504_trade_pre_submission_fence.sql',
  'api-server/supabase/migrations/2026080505_trade_split_child_orders.sql',
  'api-server/supabase/migrations/2026080506_trade_order_atomicity_admin_rls.sql',
  'api-server/supabase/migrations/2026080801_trade_risk_envelope_kill_switch.sql',
  'api-server/supabase/migrations/2026092502_trade_live_execution_toss_provider.sql',
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

const preflightSql = String.raw`
do $trade_storage_preflight$
declare present_count integer;
begin
  if to_regclass('public.profiles') is null then raise exception 'TRADE_STORAGE_PROFILES_REQUIRED'; end if;
  select count(*) into present_count
  from (values
    ('trade_system_controls'),('trade_automation_profiles'),('trade_exchange_connections'),
    ('trade_order_plans'),('trade_orders'),('trade_order_events'),('trade_order_legs'),('trade_protection_orders')
  ) as required(name)
  where to_regclass('public.' || name) is not null;
  if present_count <> 0 then raise exception 'TRADE_STORAGE_PREEXISTING_OR_PARTIAL:%', present_count; end if;
end
$trade_storage_preflight$;
`;

const verificationSql = String.raw`
do $trade_storage_verify$
declare row_record record; ready_count integer; function_count integer; policy_table_count integer; global_policy_count integer; user_row_count bigint;
begin
  if to_regprocedure('public.current_membership_level()') is null then raise exception 'current_membership_level missing'; end if;
  for row_record in
    select required.name, c.relrowsecurity
    from (values
      ('trade_system_controls'),('trade_automation_profiles'),('trade_exchange_connections'),
      ('trade_order_plans'),('trade_orders'),('trade_order_events'),('trade_order_legs'),('trade_protection_orders')
    ) as required(name)
    left join pg_catalog.pg_class c on c.oid = to_regclass('public.' || required.name)
  loop
    if row_record.relrowsecurity is distinct from true then raise exception 'RLS not ready for %', row_record.name; end if;
  end loop;
  select count(distinct tablename) into policy_table_count
  from pg_catalog.pg_policies
  where schemaname='public'
    and tablename in ('trade_automation_profiles','trade_exchange_connections','trade_order_plans','trade_orders','trade_order_events','trade_order_legs','trade_protection_orders')
    and cmd='SELECT' and coalesce(qual,'') ilike '%current_membership_level%' and coalesce(qual,'') ilike '%admin%';
  if policy_table_count <> 7 then raise exception 'admin policies not ready'; end if;
  select count(*) into global_policy_count from pg_catalog.pg_policies where schemaname='public' and tablename='trade_system_controls';
  if global_policy_count <> 0 then raise exception 'global controls policy exposed'; end if;
  select count(*) into function_count
  from (values
    ('transition_trade_plan_atomic'),('create_trade_order_atomic'),('transition_trade_order_atomic'),('claim_trade_order_execution'),
    ('claim_trade_recovery_orders'),('transition_trade_recovery_order_atomic'),('create_trade_split_orders_atomic'),
    ('activate_next_trade_split_child_atomic'),('enforce_trade_plan_risk_envelope'),('cancel_trade_split_children_atomic')
  ) as required(name)
  where exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=required.name);
  if function_count <> 10 then raise exception 'trade functions incomplete'; end if;
  select count(distinct c.relname) into ready_count
  from pg_catalog.pg_constraint k join pg_catalog.pg_class c on c.oid=k.conrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relname in ('trade_exchange_connections','trade_orders') and k.contype='c'
    and pg_catalog.pg_get_constraintdef(k.oid) ilike '%toss%';
  if ready_count <> 2 then raise exception 'Toss constraints not ready'; end if;
  if has_column_privilege('authenticated','public.trade_exchange_connections','encrypted_credentials','SELECT') then raise exception 'encrypted trading credentials exposed'; end if;
  if has_table_privilege('anon','public.trade_exchange_connections','SELECT') then raise exception 'anonymous trading connection access exposed'; end if;
  select
    (select count(*) from public.trade_automation_profiles) + (select count(*) from public.trade_exchange_connections)
    + (select count(*) from public.trade_order_plans) + (select count(*) from public.trade_orders)
    + (select count(*) from public.trade_order_events) + (select count(*) from public.trade_order_legs)
    + (select count(*) from public.trade_protection_orders) into user_row_count;
  if user_row_count <> 0 then raise exception 'unexpected trade user rows created'; end if;
  if (select count(*) from public.trade_system_controls where control_key='global' and emergency_stopped=false) <> 1 then raise exception 'global control initialization invalid'; end if;
end
$trade_storage_verify$;

select json_build_object(
  'schemaVersion','production-trade-automation-storage-apply-v1','status','passed',
  'expected_active_sha',current_setting('app.expected_active_sha'),'approved_target_sha',current_setting('app.approved_target_sha'),
  'production_project_match',true,'atomic_transaction',true,'migrations_applied',9,
  'trade_tables_verified',8,'trade_functions_verified',10,'rls_ready',true,'admin_policy_tables_ready',true,
  'global_control_policy_free',true,'toss_constraint_ready',true,'trade_user_rows_created',0,
  'credentials_recorded',false,'raw_credentials_exposed',false,'order_submitted',false,'cancel_submitted',false,
  'amend_submitted',false,'transfer_submitted',false,'withdrawal_submitted',false,'private_trading_api_count',0,
  'live_trading',false,'auto_trading',false,'real_order_enabled',false,'private_trading_api_allowed',false,'execution_authority','NONE'
)::text;
`;

const sql = [
  '\\set ON_ERROR_STOP on',
  'begin;',
  "set local lock_timeout = '5s';",
  "set local statement_timeout = '60s';",
  "select pg_advisory_xact_lock(hashtextextended('production-trade-automation-storage-v1', 0));",
  `select set_config('app.expected_active_sha', '${expectedActiveSha}', true);`,
  `select set_config('app.approved_target_sha', '${approvedTargetSha}', true);`,
  preflightSql,
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
if (artifact?.schemaVersion !== SCHEMA_VERSION
  || artifact?.status !== 'passed'
  || artifact?.expected_active_sha !== expectedActiveSha
  || artifact?.approved_target_sha !== approvedTargetSha
  || artifact?.production_project_match !== true
  || artifact?.atomic_transaction !== true
  || artifact?.migrations_applied !== 9
  || artifact?.trade_tables_verified !== 8
  || artifact?.trade_functions_verified !== 10
  || artifact?.rls_ready !== true
  || artifact?.admin_policy_tables_ready !== true
  || artifact?.global_control_policy_free !== true
  || artifact?.toss_constraint_ready !== true
  || artifact?.trade_user_rows_created !== 0
  || artifact?.credentials_recorded !== false
  || artifact?.raw_credentials_exposed !== false
  || artifact?.order_submitted !== false
  || artifact?.cancel_submitted !== false
  || artifact?.amend_submitted !== false
  || artifact?.transfer_submitted !== false
  || artifact?.withdrawal_submitted !== false
  || artifact?.private_trading_api_count !== 0
  || artifact?.live_trading !== false
  || artifact?.auto_trading !== false
  || artifact?.real_order_enabled !== false
  || artifact?.private_trading_api_allowed !== false
  || artifact?.execution_authority !== 'NONE') {
  fail('verification_contract_failed');
}

process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
