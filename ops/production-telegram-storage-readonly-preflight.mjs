import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const PRODUCTION_PROJECT_REF = 'bawcbkoyovbeajkrnduq';

const TOP_LEVEL_KEYS = new Set([
  'status',
  'classification',
  'production_sha',
  'pm2_online',
  'production_project_match',
  'postgres_connection_count',
  'postgres_endpoint_type',
  'postgres_port',
  'existing_safe_db_connection_available',
  'read_only_probe',
  'database_changed',
  'notification_preferences',
  'telegram_tables',
  'auth_users_exists',
  'profiles_exists',
  'service_role_exists',
  'is_approved_member_function_exists',
  'release_preflight_ready',
  'credentials_recorded',
  'raw_user_data_exposed',
  'arbitrary_sql_allowed',
  'order_submitted',
  'private_trading_api_count',
  'live_trading_authority',
]);

const NOTIFICATION_KEYS = new Set([
  'table_exists',
  'member_id',
  'enabled_types',
  'app_enabled',
  'push_enabled',
  'updated_at',
  'legacy_user_id',
  'legacy_payload',
  'member_id_unique_arbiter',
]);

const TELEGRAM_KEYS = new Set([
  'telegram_connections_exists',
  'telegram_link_tokens_exists',
  'user_execution_events_exists',
  'notification_deliveries_exists',
  'existing_schema_compatible',
]);

function verifyAllowedObject(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unexpected key: ${key}`);
  }
}

function verifyArtifact(value) {
  verifyAllowedObject(value, TOP_LEVEL_KEYS, 'artifact');
  verifyAllowedObject(value.notification_preferences, NOTIFICATION_KEYS, 'notification_preferences');
  verifyAllowedObject(value.telegram_tables, TELEGRAM_KEYS, 'telegram_tables');

  if (!['passed', 'blocked'].includes(value.status)) throw new Error('status invalid');
  if (typeof value.classification !== 'string' || !/^[a-z0-9_]+$/.test(value.classification)) {
    throw new Error('classification invalid');
  }
  if (!/^[0-9a-f]{40}$/.test(String(value.production_sha ?? ''))) {
    throw new Error('production_sha invalid');
  }
  if (![0, 1, 2].includes(value.postgres_connection_count)) {
    throw new Error('postgres_connection_count must be 0, 1, or 2 (2 means multiple)');
  }
  if (!['direct', 'pooler', 'unresolved'].includes(value.postgres_endpoint_type)) {
    throw new Error('postgres_endpoint_type invalid');
  }
  if (!['5432', 'unresolved'].includes(value.postgres_port)) throw new Error('postgres_port invalid');
  for (const key of [
    'pm2_online',
    'production_project_match',
    'existing_safe_db_connection_available',
    'read_only_probe',
    'database_changed',
    'auth_users_exists',
    'profiles_exists',
    'service_role_exists',
    'is_approved_member_function_exists',
    'release_preflight_ready',
    'credentials_recorded',
    'raw_user_data_exposed',
    'arbitrary_sql_allowed',
    'order_submitted',
    'live_trading_authority',
  ]) {
    if (typeof value[key] !== 'boolean') throw new Error(`${key} must be boolean`);
  }
  if (value.private_trading_api_count !== 0) throw new Error('private_trading_api_count must be zero');
  if (value.database_changed !== false) throw new Error('read-only preflight cannot change database');
  if (value.credentials_recorded !== false) throw new Error('credentials_recorded must be false');
  if (value.raw_user_data_exposed !== false) throw new Error('raw_user_data_exposed must be false');
  if (value.arbitrary_sql_allowed !== false) throw new Error('arbitrary_sql_allowed must be false');
  if (value.order_submitted !== false || value.live_trading_authority !== false) {
    throw new Error('trading authority must remain disabled');
  }
  for (const [label, nested] of [
    ['notification_preferences', value.notification_preferences],
    ['telegram_tables', value.telegram_tables],
  ]) {
    for (const [key, item] of Object.entries(nested)) {
      if (typeof item !== 'boolean') throw new Error(`${label}.${key} must be boolean`);
    }
  }

  const serialized = JSON.stringify(value);
  const forbidden = [
    /postgres(?:ql)?:\/\//i,
    /eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/,
    /BEGIN (?:RSA|OPENSSH|EC) PRIVATE KEY/i,
    /(?:password|secret|private_key|service_role_key)\s*[:=]/i,
  ];
  if (forbidden.some((pattern) => pattern.test(serialized))) {
    throw new Error('artifact contains forbidden secret-like material');
  }
  return true;
}

if (process.argv[2] === '--verify-artifact') {
  const file = process.argv[3];
  if (!file) throw new Error('artifact path is required');
  const value = JSON.parse(readFileSync(file, 'utf8'));
  verifyArtifact(value);
  process.stdout.write('production Telegram storage preflight artifact: PASS\n');
  process.exit(0);
}

const expectedProductionSha = String(process.env.EXPECTED_PRODUCTION_SHA ?? '').trim().toLowerCase();

const base = {
  status: 'blocked',
  classification: 'unknown',
  production_sha: expectedProductionSha,
  pm2_online: false,
  production_project_match: false,
  postgres_connection_count: 0,
  postgres_endpoint_type: 'unresolved',
  postgres_port: 'unresolved',
  existing_safe_db_connection_available: false,
  read_only_probe: false,
  database_changed: false,
  notification_preferences: {
    table_exists: false,
    member_id: false,
    enabled_types: false,
    app_enabled: false,
    push_enabled: false,
    updated_at: false,
    legacy_user_id: false,
    legacy_payload: false,
    member_id_unique_arbiter: false,
  },
  telegram_tables: {
    telegram_connections_exists: false,
    telegram_link_tokens_exists: false,
    user_execution_events_exists: false,
    notification_deliveries_exists: false,
    existing_schema_compatible: true,
  },
  auth_users_exists: false,
  profiles_exists: false,
  service_role_exists: false,
  is_approved_member_function_exists: false,
  release_preflight_ready: false,
  credentials_recorded: false,
  raw_user_data_exposed: false,
  arbitrary_sql_allowed: false,
  order_submitted: false,
  private_trading_api_count: 0,
  live_trading_authority: false,
};

function emit(overrides = {}) {
  const value = {
    ...base,
    ...overrides,
    notification_preferences: {
      ...base.notification_preferences,
      ...(overrides.notification_preferences ?? {}),
    },
    telegram_tables: {
      ...base.telegram_tables,
      ...(overrides.telegram_tables ?? {}),
    },
  };
  verifyArtifact(value);
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function blocked(classification, overrides = {}) {
  emit({ ...overrides, status: 'blocked', classification, release_preflight_ready: false });
  process.exit(0);
}

if (!/^[0-9a-f]{40}$/.test(expectedProductionSha)) {
  blocked('invalid_production_sha');
}

const pm2 = spawnSync('pm2', ['jlist'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
if (pm2.status !== 0) blocked('pm2_unavailable');

let processes;
try {
  processes = JSON.parse(pm2.stdout);
} catch {
  blocked('pm2_response_invalid');
}

const selected = processes.find((item) => item?.name === 'stock-app');
const runtime = selected?.pm2_env;
if (!runtime || runtime.status !== 'online') blocked('production_process_unavailable');
if (String(runtime.DEPLOY_SHA ?? '').trim().toLowerCase() !== expectedProductionSha) {
  blocked('production_process_sha_mismatch', { pm2_online: true });
}

let projectRef = '';
try {
  const parsed = new URL(String(runtime.SUPABASE_URL ?? '').trim());
  const match = /^([a-z0-9]+)\.supabase\.co$/i.exec(parsed.hostname);
  const valid = parsed.protocol === 'https:'
    && !parsed.username
    && !parsed.password
    && !parsed.port
    && ['', '/'].includes(parsed.pathname)
    && !parsed.search
    && !parsed.hash
    && match?.[1]?.toLowerCase() === PRODUCTION_PROJECT_REF;
  if (!valid) throw new Error('project mismatch');
  projectRef = match[1].toLowerCase();
} catch {
  blocked('production_project_mismatch', { pm2_online: true });
}

const postgresUris = [...new Set(
  Object.values(runtime)
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => /^postgres(?:ql)?:\/\//i.test(value)),
)];

if (postgresUris.length === 0) {
  blocked('production_database_connection_missing', {
    pm2_online: true,
    production_project_match: true,
    postgres_connection_count: 0,
  });
}
if (postgresUris.length !== 1) {
  blocked('production_database_connection_ambiguous', {
    pm2_online: true,
    production_project_match: true,
    postgres_connection_count: 2,
  });
}

let database;
try {
  const parsed = new URL(postgresUris[0]);
  const hostname = parsed.hostname.toLowerCase();
  const username = decodeURIComponent(parsed.username);
  const usernameLower = username.toLowerCase();
  const direct = hostname === `db.${projectRef}.supabase.co` && usernameLower === 'postgres';
  const pooler = /(^|\.)pooler\.supabase\.com$/i.test(hostname)
    && usernameLower === `postgres.${projectRef}`;
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  const port = parsed.port || '5432';
  if ((!direct && !pooler) || !parsed.password || databaseName !== 'postgres' || port !== '5432') {
    throw new Error('invalid database target');
  }
  database = {
    hostname,
    port,
    username,
    password: decodeURIComponent(parsed.password),
    database: databaseName,
    endpointType: direct ? 'direct' : 'pooler',
  };
} catch {
  blocked('production_database_project_mismatch', {
    pm2_online: true,
    production_project_match: true,
    postgres_connection_count: 1,
  });
}

const SQL = String.raw`
\set ON_ERROR_STOP on
begin read only;
set local statement_timeout = '8s';
set local lock_timeout = '1s';

with required_telegram_columns(table_name, column_name) as (
  values
    ('telegram_connections', 'user_id'),
    ('telegram_connections', 'telegram_chat_id'),
    ('telegram_connections', 'telegram_user_id'),
    ('telegram_connections', 'status'),
    ('telegram_connections', 'connected_at'),
    ('telegram_connections', 'revoked_at'),
    ('telegram_connections', 'updated_at'),
    ('telegram_link_tokens', 'token_hash'),
    ('telegram_link_tokens', 'user_id'),
    ('telegram_link_tokens', 'expires_at'),
    ('telegram_link_tokens', 'consumed_at'),
    ('telegram_link_tokens', 'created_at'),
    ('user_execution_events', 'user_id'),
    ('user_execution_events', 'id'),
    ('user_execution_events', 'source_event_id'),
    ('user_execution_events', 'event_type'),
    ('user_execution_events', 'source'),
    ('user_execution_events', 'payload'),
    ('user_execution_events', 'occurred_at'),
    ('user_execution_events', 'created_at'),
    ('notification_deliveries', 'user_id'),
    ('notification_deliveries', 'id'),
    ('notification_deliveries', 'event_id'),
    ('notification_deliveries', 'dedupe_key'),
    ('notification_deliveries', 'state'),
    ('notification_deliveries', 'attempts'),
    ('notification_deliveries', 'next_retry_at'),
    ('notification_deliveries', 'last_error_code'),
    ('notification_deliveries', 'created_at'),
    ('notification_deliveries', 'updated_at')
),
existing_telegram_incompatible as (
  select exists (
    select 1
    from required_telegram_columns required
    where to_regclass(format('public.%I', required.table_name)) is not null
      and not exists (
        select 1
        from information_schema.columns candidate
        where candidate.table_schema = 'public'
          and candidate.table_name = required.table_name
          and candidate.column_name = required.column_name
      )
  ) as value
),
notification_arbiter as (
  select exists (
    select 1
    from pg_catalog.pg_index idx
    join pg_catalog.pg_class rel on rel.oid = idx.indrelid
    join pg_catalog.pg_namespace ns on ns.oid = rel.relnamespace
    cross join lateral unnest(idx.indkey) with ordinality as key(attnum, ord)
    join pg_catalog.pg_attribute att on att.attrelid = rel.oid and att.attnum = key.attnum
    where ns.nspname = 'public'
      and rel.relname = 'notification_preferences'
      and idx.indisunique
      and idx.indisvalid
      and idx.indisready
      and idx.indimmediate
      and idx.indpred is null
      and idx.indnkeyatts = 1
      and key.ord = 1
      and att.attname = 'member_id'
  ) as value
)
select json_build_object(
  'auth_users_exists', to_regclass('auth.users') is not null,
  'profiles_exists', to_regclass('public.profiles') is not null,
  'service_role_exists', exists(select 1 from pg_catalog.pg_roles where rolname = 'service_role'),
  'is_approved_member_function_exists', to_regprocedure('public.is_approved_member()') is not null,
  'notification_preferences', json_build_object(
    'table_exists', to_regclass('public.notification_preferences') is not null,
    'member_id', exists(
      select 1 from information_schema.columns
      where table_schema='public' and table_name='notification_preferences' and column_name='member_id'
    ),
    'enabled_types', exists(
      select 1 from information_schema.columns
      where table_schema='public' and table_name='notification_preferences' and column_name='enabled_types'
    ),
    'app_enabled', exists(
      select 1 from information_schema.columns
      where table_schema='public' and table_name='notification_preferences' and column_name='app_enabled'
    ),
    'push_enabled', exists(
      select 1 from information_schema.columns
      where table_schema='public' and table_name='notification_preferences' and column_name='push_enabled'
    ),
    'updated_at', exists(
      select 1 from information_schema.columns
      where table_schema='public' and table_name='notification_preferences' and column_name='updated_at'
    ),
    'legacy_user_id', exists(
      select 1 from information_schema.columns
      where table_schema='public' and table_name='notification_preferences' and column_name='user_id'
    ),
    'legacy_payload', exists(
      select 1 from information_schema.columns
      where table_schema='public' and table_name='notification_preferences' and column_name='payload'
    ),
    'member_id_unique_arbiter', (select value from notification_arbiter)
  ),
  'telegram_tables', json_build_object(
    'telegram_connections_exists', to_regclass('public.telegram_connections') is not null,
    'telegram_link_tokens_exists', to_regclass('public.telegram_link_tokens') is not null,
    'user_execution_events_exists', to_regclass('public.user_execution_events') is not null,
    'notification_deliveries_exists', to_regclass('public.notification_deliveries') is not null,
    'existing_schema_compatible', not (select value from existing_telegram_incompatible)
  )
)::text;

commit;
`;

const baseEnv = { ...process.env };
for (const key of Object.keys(baseEnv)) if (key.startsWith('PG')) delete baseEnv[key];

const probe = spawnSync('psql', [
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
  input: SQL,
  encoding: 'utf8',
  env: {
    ...baseEnv,
    PGPASSWORD: database.password,
    PGCONNECT_TIMEOUT: '10',
    PGSSLMODE: 'require',
    PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=8000 -c lock_timeout=1000',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
  maxBuffer: 2 * 1024 * 1024,
});

const connectionEvidence = {
  pm2_online: true,
  production_project_match: true,
  postgres_connection_count: 1,
  postgres_endpoint_type: database.endpointType,
  postgres_port: database.port,
  existing_safe_db_connection_available: true,
};

if (probe.error || probe.status !== 0) {
  blocked('production_database_readonly_probe_failed', connectionEvidence);
}

const lines = String(probe.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
let catalog;
try {
  catalog = JSON.parse(lines.at(-1) ?? '');
} catch {
  blocked('production_database_readonly_result_invalid', {
    ...connectionEvidence,
    read_only_probe: true,
  });
}

const notification = catalog.notification_preferences ?? {};
const telegram = catalog.telegram_tables ?? {};
const canonicalColumnsReady = [
  notification.member_id,
  notification.enabled_types,
  notification.app_enabled,
  notification.push_enabled,
  notification.updated_at,
].every((value) => value === true);

let classification = 'ready_for_atomic_storage_apply';
if (catalog.auth_users_exists !== true) classification = 'auth_users_missing';
else if (catalog.profiles_exists !== true) classification = 'profiles_missing';
else if (catalog.service_role_exists !== true) classification = 'service_role_missing';
else if (catalog.is_approved_member_function_exists !== true) classification = 'is_approved_member_function_missing';
else if (notification.table_exists !== true) classification = 'canonical_notification_preferences_missing';
else if (!canonicalColumnsReady) classification = 'canonical_notification_preferences_columns_missing';
else if (notification.member_id_unique_arbiter !== true) classification = 'canonical_notification_preferences_arbiter_missing';
else if (telegram.existing_schema_compatible !== true) classification = 'existing_telegram_storage_schema_incompatible';

emit({
  status: classification === 'ready_for_atomic_storage_apply' ? 'passed' : 'blocked',
  classification,
  ...connectionEvidence,
  read_only_probe: true,
  notification_preferences: {
    table_exists: notification.table_exists === true,
    member_id: notification.member_id === true,
    enabled_types: notification.enabled_types === true,
    app_enabled: notification.app_enabled === true,
    push_enabled: notification.push_enabled === true,
    updated_at: notification.updated_at === true,
    legacy_user_id: notification.legacy_user_id === true,
    legacy_payload: notification.legacy_payload === true,
    member_id_unique_arbiter: notification.member_id_unique_arbiter === true,
  },
  telegram_tables: {
    telegram_connections_exists: telegram.telegram_connections_exists === true,
    telegram_link_tokens_exists: telegram.telegram_link_tokens_exists === true,
    user_execution_events_exists: telegram.user_execution_events_exists === true,
    notification_deliveries_exists: telegram.notification_deliveries_exists === true,
    existing_schema_compatible: telegram.existing_schema_compatible === true,
  },
  auth_users_exists: catalog.auth_users_exists === true,
  profiles_exists: catalog.profiles_exists === true,
  service_role_exists: catalog.service_role_exists === true,
  is_approved_member_function_exists: catalog.is_approved_member_function_exists === true,
  release_preflight_ready: classification === 'ready_for_atomic_storage_apply',
});
