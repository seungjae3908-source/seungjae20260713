#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

PM2_NAME="${PM2_NAME:-stock-app}"

node - "$PM2_NAME" <<'NODE'
const { spawnSync } = require('node:child_process');

const pm2Name = process.argv[2] || 'stock-app';
const schemaVersion = 'production-trade-schema-readonly-audit-v1';
const common = {
  schemaVersion,
  readOnlyEnforced: true,
  rawUserDataExposed: false,
  arbitrarySqlAllowed: false,
};

function emit(value, exitCode) {
  process.stdout.write(JSON.stringify({ ...common, ...value }) + '\n');
  process.exit(exitCode);
}

function blocked(code, extra = {}) {
  emit({
    status: 'BLOCKED',
    code,
    missingTables: [],
    missingFunctions: [],
    rlsReady: false,
    adminPolicyTablesReady: false,
    globalControlBrowserPolicyFree: false,
    tossConstraintReady: false,
    ...extra,
  }, 2);
}

const SCHEMA_SQL = [
  "BEGIN READ ONLY;",
  "WITH",
  "required_tables(name) AS (",
  "  VALUES",
  "    ('trade_system_controls'),",
  "    ('trade_automation_profiles'),",
  "    ('trade_exchange_connections'),",
  "    ('trade_order_plans'),",
  "    ('trade_orders'),",
  "    ('trade_order_events'),",
  "    ('trade_order_legs'),",
  "    ('trade_protection_orders')",
  "),",
  "missing_tables AS (",
  "  SELECT name FROM required_tables",
  "  WHERE to_regclass('public.' || name) IS NULL",
  "),",
  "required_functions(name) AS (",
  "  VALUES",
  "    ('transition_trade_plan_atomic'),",
  "    ('create_trade_order_atomic'),",
  "    ('transition_trade_order_atomic'),",
  "    ('claim_trade_order_execution'),",
  "    ('claim_trade_recovery_orders'),",
  "    ('transition_trade_recovery_order_atomic'),",
  "    ('create_trade_split_orders_atomic'),",
  "    ('activate_next_trade_split_child_atomic'),",
  "    ('enforce_trade_plan_risk_envelope'),",
  "    ('cancel_trade_split_children_atomic')",
  "),",
  "missing_functions AS (",
  "  SELECT name FROM required_functions rf",
  "  WHERE NOT EXISTS (",
  "    SELECT 1 FROM pg_catalog.pg_proc p",
  "    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace",
  "    WHERE n.nspname = 'public' AND p.proname = rf.name",
  "  )",
  "),",
  "rls_summary AS (",
  "  SELECT count(*) FILTER (WHERE c.relrowsecurity)::integer AS ready_count",
  "  FROM required_tables rt",
  "  LEFT JOIN pg_catalog.pg_class c ON c.oid = to_regclass('public.' || rt.name)",
  "),",
  "admin_policy_summary AS (",
  "  SELECT count(DISTINCT tablename)::integer AS ready_count",
  "  FROM pg_catalog.pg_policies",
  "  WHERE schemaname = 'public'",
  "    AND tablename IN (",
  "      'trade_automation_profiles','trade_exchange_connections','trade_order_plans',",
  "      'trade_orders','trade_order_events','trade_order_legs','trade_protection_orders'",
  "    )",
  "    AND cmd = 'SELECT'",
  "    AND coalesce(qual, '') ILIKE '%current_membership_level%'",
  "    AND coalesce(qual, '') ILIKE '%admin%'",
  "),",
  "toss_constraint_summary AS (",
  "  SELECT count(DISTINCT c.relname)::integer AS ready_count",
  "  FROM pg_catalog.pg_constraint k",
  "  JOIN pg_catalog.pg_class c ON c.oid = k.conrelid",
  "  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace",
  "  WHERE n.nspname = 'public'",
  "    AND c.relname IN ('trade_exchange_connections','trade_orders')",
  "    AND k.contype = 'c'",
  "    AND pg_catalog.pg_get_constraintdef(k.oid) ILIKE '%toss%'",
  "),",
  "global_control_policy AS (",
  "  SELECT count(*)::integer AS policy_count",
  "  FROM pg_catalog.pg_policies",
  "  WHERE schemaname = 'public' AND tablename = 'trade_system_controls'",
  "),",
  "summary AS (",
  "  SELECT",
  "    coalesce((SELECT json_agg(name ORDER BY name) FROM missing_tables), '[]'::json) AS missing_tables,",
  "    coalesce((SELECT json_agg(name ORDER BY name) FROM missing_functions), '[]'::json) AS missing_functions,",
  "    (SELECT ready_count = 8 FROM rls_summary) AS rls_ready,",
  "    (SELECT ready_count = 7 FROM admin_policy_summary) AS admin_policy_tables_ready,",
  "    (SELECT policy_count = 0 FROM global_control_policy) AS global_control_browser_policy_free,",
  "    (SELECT ready_count = 2 FROM toss_constraint_summary) AS toss_constraint_ready",
  ")",
  "SELECT json_build_object(",
  "  'schemaVersion','production-trade-schema-readonly-audit-v1',",
  "  'status', CASE",
  "    WHEN json_array_length(missing_tables) = 0",
  "      AND json_array_length(missing_functions) = 0",
  "      AND rls_ready AND admin_policy_tables_ready",
  "      AND global_control_browser_policy_free AND toss_constraint_ready",
  "    THEN 'READY' ELSE 'BLOCKED' END,",
  "  'code', CASE",
  "    WHEN json_array_length(missing_tables) > 0 THEN 'TRADE_SCHEMA_TABLES_MISSING'",
  "    WHEN json_array_length(missing_functions) > 0 THEN 'TRADE_SCHEMA_FUNCTIONS_MISSING'",
  "    WHEN NOT rls_ready THEN 'TRADE_SCHEMA_RLS_NOT_READY'",
  "    WHEN NOT admin_policy_tables_ready THEN 'TRADE_SCHEMA_ADMIN_POLICIES_NOT_READY'",
  "    WHEN NOT global_control_browser_policy_free THEN 'TRADE_SCHEMA_GLOBAL_CONTROL_POLICY_EXPOSED'",
  "    WHEN NOT toss_constraint_ready THEN 'TRADE_SCHEMA_TOSS_CONSTRAINT_NOT_READY'",
  "    ELSE null END,",
  "  'missingTables',missing_tables,",
  "  'missingFunctions',missing_functions,",
  "  'rlsReady',rls_ready,",
  "  'adminPolicyTablesReady',admin_policy_tables_ready,",
  "  'globalControlBrowserPolicyFree',global_control_browser_policy_free,",
  "  'tossConstraintReady',toss_constraint_ready,",
  "  'readOnlyEnforced',true,",
  "  'rawUserDataExposed',false,",
  "  'arbitrarySqlAllowed',false",
  ")::text FROM summary;",
  "COMMIT;",
].join('\n');

function runPsql(sql, pgEnv) {
  const baseEnv = { ...process.env };
  for (const key of Object.keys(baseEnv)) {
    if (key.startsWith('PG')) delete baseEnv[key];
  }
  return spawnSync(
    'psql',
    ['-X', '--no-psqlrc', '--set=ON_ERROR_STOP=1', '--quiet', '--tuples-only', '--no-align'],
    {
      env: {
        ...baseEnv,
        ...pgEnv,
        PGCONNECT_TIMEOUT: '5',
        PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000',
      },
      input: sql,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    },
  );
}

const pm2 = spawnSync('pm2', ['jlist'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
if (pm2.status !== 0) blocked('TRADE_SCHEMA_PM2_UNAVAILABLE');

let rows;
try {
  rows = JSON.parse(pm2.stdout);
} catch {
  blocked('TRADE_SCHEMA_PM2_INVALID');
}
if (!Array.isArray(rows)) blocked('TRADE_SCHEMA_PM2_INVALID');

const matches = rows.filter((row) => String(row?.name ?? '') === pm2Name);
if (matches.length !== 1 || String(matches[0]?.pm2_env?.status ?? '') !== 'online') {
  blocked('TRADE_SCHEMA_PRODUCTION_PROCESS_UNAVAILABLE');
}

const env = matches[0].pm2_env;
if (!env || typeof env !== 'object' || Array.isArray(env)) {
  blocked('TRADE_SCHEMA_PRODUCTION_ENV_UNAVAILABLE');
}

const uriPattern = /^postgres(?:ql)?:\/\//i;
const uriValues = Object.values(env)
  .filter((value) => typeof value === 'string')
  .map((value) => value.trim())
  .filter((value) => uriPattern.test(value));
const uniqueUris = [...new Set(uriValues)];

if (uniqueUris.length === 0) blocked('TRADE_SCHEMA_SAFE_POSTGRES_CONNECTION_MISSING');
if (uniqueUris.length !== 1) blocked('TRADE_SCHEMA_SAFE_POSTGRES_CONNECTION_AMBIGUOUS');

let parsed;
try {
  parsed = new URL(uniqueUris[0]);
} catch {
  blocked('TRADE_SCHEMA_SAFE_POSTGRES_CONNECTION_INVALID');
}

const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
if (!parsed.hostname || !database) blocked('TRADE_SCHEMA_SAFE_POSTGRES_CONNECTION_INCOMPLETE');

const pgEnv = {
  PGHOST: parsed.hostname,
  PGPORT: parsed.port || '5432',
  PGUSER: decodeURIComponent(parsed.username || ''),
  PGPASSWORD: decodeURIComponent(parsed.password || ''),
  PGDATABASE: database,
};
const sslmode = parsed.searchParams.get('sslmode');
if (sslmode) pgEnv.PGSSLMODE = sslmode;

const result = runPsql(SCHEMA_SQL, pgEnv);
if (result.status !== 0) blocked('TRADE_SCHEMA_READONLY_CATALOG_PROBE_FAILED');

const line = String(result.stdout ?? '')
  .split(/\r?\n/u)
  .map((value) => value.trim())
  .find((value) => value.startsWith('{') && value.endsWith('}'));

let evidence;
try {
  evidence = JSON.parse(line || '');
} catch {
  blocked('TRADE_SCHEMA_READONLY_RESULT_INVALID');
}

const normalized = { ...common, ...evidence };
process.stdout.write(JSON.stringify(normalized) + '\n');
process.exit(normalized.status === 'READY' ? 0 : 3);
NODE
