#!/usr/bin/env bash
set -Eeuo pipefail
export LC_ALL=C
umask 077

: "${EXPECTED_PRODUCTION_SHA:?EXPECTED_PRODUCTION_SHA is required}"

export EXPECTED_PRODUCTION_SHA

node <<'NODE'
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const expectedSha = String(process.env.EXPECTED_PRODUCTION_SHA ?? '');
const pm2Name = String(process.env.PM2_NAME ?? 'stock-app');

const BASE = {
  STATUS: 'blocked',
  DB_CATALOG_AUDIT: 'BLOCKED_UNKNOWN',
  PRODUCTION_SHA: expectedSha,
  EXISTING_SAFE_DB_CONNECTION_AVAILABLE: false,
  TABLE_EXISTS: null,
  ACTUAL_COLUMNS: [],
  ACTUAL_PRIMARY_KEY: [],
  ACTUAL_UNIQUE_CONSTRAINTS: [],
  ACTUAL_UNIQUE_INDEXES: [],
  ACTUAL_EXCLUSION_CONSTRAINTS: [],
  ARBITER_TYPE: null,
  ARBITER_INDEX_NAME: null,
  ARBITER_COLUMNS: [],
  ARBITER_PARTIAL: null,
  ARBITER_DEFERRABLE: null,
  ARBITER_VALID: null,
  ARBITER_READY: null,
  DUPLICATE_GROUP_COUNT: null,
  DUPLICATE_EXTRA_ROW_COUNT: null,
  TOTAL_ROW_COUNT: null,
  RLS_ENABLED: null,
  RLS_FORCE: null,
  WATCHLIST_POLICY_COUNT: null,
  CURRENT_ROLE_HAS_SELECT: null,
  READ_ONLY_ENFORCED: true,
  ARBITRARY_SQL_ALLOWED: false,
  RAW_USER_DATA_EXPOSED: false,
};

function emit(overrides = {}) {
  process.stdout.write(`${JSON.stringify({ ...BASE, ...overrides })}\n`);
}

function blocked(classification, overrides = {}) {
  emit({ DB_CATALOG_AUDIT: classification, ...overrides });
}

if (!/^[0-9a-f]{40}$/.test(expectedSha)) {
  blocked('BLOCKED_INVALID_PRODUCTION_SHA');
  process.exit(0);
}

const stateFile = '/opt/stock-app/.deploy/current-sha';
let markerSha = '';
try {
  markerSha = fs.readFileSync(stateFile, 'utf8').trim();
} catch {
  blocked('BLOCKED_PRODUCTION_IDENTITY_UNAVAILABLE');
  process.exit(0);
}
if (markerSha !== expectedSha) {
  blocked('BLOCKED_PRODUCTION_SHA_MISMATCH');
  process.exit(0);
}

const TABLE_EXISTS_SQL = String.raw`
BEGIN READ ONLY;
SELECT to_regclass('public.watchlist_items') IS NOT NULL;
COMMIT;
`;

const CATALOG_SQL = String.raw`
BEGIN READ ONLY;

WITH target AS (
  SELECT c.oid AS relid, c.relrowsecurity, c.relforcerowsecurity
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'watchlist_items'
    AND c.relkind IN ('r', 'p')
),
columns_meta AS (
  SELECT
    column_name,
    data_type,
    is_nullable,
    column_default
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'watchlist_items'
  ORDER BY ordinal_position
),
constraints_meta AS (
  SELECT
    con.conname,
    con.contype,
    con.condeferrable,
    con.condeferred,
    con.convalidated,
    pg_catalog.pg_get_constraintdef(con.oid, true) AS definition
  FROM pg_catalog.pg_constraint con
  JOIN target t ON t.relid = con.conrelid
  ORDER BY con.contype, con.conname
),
index_meta AS (
  SELECT
    idx.relname AS index_name,
    i.indisunique,
    i.indisprimary,
    i.indisvalid,
    i.indisready,
    i.indimmediate,
    array_remove(array_agg(att.attname ORDER BY key.ord), NULL) AS key_columns,
    bool_or(key.attnum <= 0) AS has_expression_key,
    pg_catalog.pg_get_expr(i.indpred, i.indrelid) AS predicate,
    pg_catalog.pg_get_indexdef(i.indexrelid) AS definition
  FROM pg_catalog.pg_index i
  JOIN target t ON t.relid = i.indrelid
  JOIN pg_catalog.pg_class idx ON idx.oid = i.indexrelid
  CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS key(attnum, ord)
  LEFT JOIN pg_catalog.pg_attribute att
    ON att.attrelid = i.indrelid
   AND att.attnum = key.attnum
  WHERE key.ord <= i.indnkeyatts
  GROUP BY
    idx.relname,
    i.indisunique,
    i.indisprimary,
    i.indisvalid,
    i.indisready,
    i.indimmediate,
    i.indpred,
    i.indrelid,
    i.indexrelid
),
exact_unique AS (
  SELECT *
  FROM index_meta
  WHERE indisunique
    AND NOT has_expression_key
    AND cardinality(key_columns) = 2
    AND (
      SELECT array_agg(value ORDER BY value)
      FROM unnest(key_columns) AS value
    ) = ARRAY['device_id', 'ticker']::text[]
),
valid_arbiter AS (
  SELECT *
  FROM exact_unique
  WHERE predicate IS NULL
    AND indisvalid
    AND indisready
    AND indimmediate
  ORDER BY indisprimary DESC, index_name
  LIMIT 1
),
invalid_arbiter AS (
  SELECT *
  FROM exact_unique
  WHERE predicate IS NULL
    AND (NOT indisvalid OR NOT indisready)
  ORDER BY index_name
  LIMIT 1
),
deferrable_arbiter AS (
  SELECT *
  FROM exact_unique
  WHERE predicate IS NULL
    AND indisvalid
    AND indisready
    AND NOT indimmediate
  ORDER BY index_name
  LIMIT 1
),
partial_arbiter AS (
  SELECT *
  FROM exact_unique
  WHERE predicate IS NOT NULL
  ORDER BY index_name
  LIMIT 1
),
chosen_arbiter AS (
  SELECT 'ARBITER_VALID'::text AS arbiter_type, * FROM valid_arbiter
  UNION ALL
  SELECT 'ARBITER_INVALID'::text AS arbiter_type, * FROM invalid_arbiter
  WHERE NOT EXISTS (SELECT 1 FROM valid_arbiter)
  UNION ALL
  SELECT 'ARBITER_DEFERRABLE'::text AS arbiter_type, * FROM deferrable_arbiter
  WHERE NOT EXISTS (SELECT 1 FROM valid_arbiter)
    AND NOT EXISTS (SELECT 1 FROM invalid_arbiter)
  UNION ALL
  SELECT 'ARBITER_PARTIAL'::text AS arbiter_type, * FROM partial_arbiter
  WHERE NOT EXISTS (SELECT 1 FROM valid_arbiter)
    AND NOT EXISTS (SELECT 1 FROM invalid_arbiter)
    AND NOT EXISTS (SELECT 1 FROM deferrable_arbiter)
  LIMIT 1
),
duplicate_groups AS (
  SELECT count(*)::bigint AS cnt
  FROM public.watchlist_items
  GROUP BY device_id, ticker
  HAVING count(*) > 1
),
duplicate_summary AS (
  SELECT
    count(*)::bigint AS duplicate_group_count,
    coalesce(sum(cnt - 1), 0)::bigint AS duplicate_extra_row_count
  FROM duplicate_groups
),
row_summary AS (
  SELECT count(*)::bigint AS total_row_count
  FROM public.watchlist_items
),
policy_summary AS (
  SELECT count(*)::bigint AS policy_count
  FROM pg_catalog.pg_policy p
  JOIN target t ON t.relid = p.polrelid
)
SELECT json_build_object(
  'TABLE_EXISTS', true,
  'ACTUAL_COLUMNS', coalesce((
    SELECT json_agg(json_build_object(
      'column_name', column_name,
      'data_type', data_type,
      'is_nullable', is_nullable,
      'column_default', column_default
    ) ORDER BY column_name)
    FROM columns_meta
  ), '[]'::json),
  'ACTUAL_PRIMARY_KEY', coalesce((
    SELECT json_agg(json_build_object(
      'conname', conname,
      'contype', contype,
      'condeferrable', condeferrable,
      'condeferred', condeferred,
      'convalidated', convalidated,
      'definition', definition
    ) ORDER BY conname)
    FROM constraints_meta
    WHERE contype = 'p'
  ), '[]'::json),
  'ACTUAL_UNIQUE_CONSTRAINTS', coalesce((
    SELECT json_agg(json_build_object(
      'conname', conname,
      'contype', contype,
      'condeferrable', condeferrable,
      'condeferred', condeferred,
      'convalidated', convalidated,
      'definition', definition
    ) ORDER BY conname)
    FROM constraints_meta
    WHERE contype = 'u'
  ), '[]'::json),
  'ACTUAL_UNIQUE_INDEXES', coalesce((
    SELECT json_agg(json_build_object(
      'index_name', index_name,
      'indisunique', indisunique,
      'indisprimary', indisprimary,
      'indisvalid', indisvalid,
      'indisready', indisready,
      'indimmediate', indimmediate,
      'key_columns', key_columns,
      'predicate', predicate,
      'definition', definition
    ) ORDER BY index_name)
    FROM index_meta
    WHERE indisunique
  ), '[]'::json),
  'ACTUAL_EXCLUSION_CONSTRAINTS', coalesce((
    SELECT json_agg(json_build_object(
      'conname', conname,
      'contype', contype,
      'condeferrable', condeferrable,
      'condeferred', condeferred,
      'convalidated', convalidated,
      'definition', definition
    ) ORDER BY conname)
    FROM constraints_meta
    WHERE contype = 'x'
  ), '[]'::json),
  'ARBITER_TYPE', coalesce((SELECT arbiter_type FROM chosen_arbiter), 'ARBITER_MISSING'),
  'ARBITER_INDEX_NAME', (SELECT index_name FROM chosen_arbiter),
  'ARBITER_COLUMNS', coalesce((SELECT to_json(key_columns) FROM chosen_arbiter), '[]'::json),
  'ARBITER_PARTIAL', coalesce((SELECT predicate IS NOT NULL FROM chosen_arbiter), false),
  'ARBITER_DEFERRABLE', coalesce((SELECT NOT indimmediate FROM chosen_arbiter), false),
  'ARBITER_VALID', coalesce((SELECT indisvalid AND indisready AND indimmediate AND predicate IS NULL FROM chosen_arbiter), false),
  'ARBITER_READY', coalesce((SELECT indisready FROM chosen_arbiter), false),
  'DUPLICATE_GROUP_COUNT', (SELECT duplicate_group_count FROM duplicate_summary),
  'DUPLICATE_EXTRA_ROW_COUNT', (SELECT duplicate_extra_row_count FROM duplicate_summary),
  'TOTAL_ROW_COUNT', (SELECT total_row_count FROM row_summary),
  'RLS_ENABLED', (SELECT relrowsecurity FROM target),
  'RLS_FORCE', (SELECT relforcerowsecurity FROM target),
  'WATCHLIST_POLICY_COUNT', (SELECT policy_count FROM policy_summary),
  'CURRENT_ROLE_HAS_SELECT', pg_catalog.has_table_privilege(current_user, 'public.watchlist_items', 'SELECT')
)::text;

COMMIT;
`;

function runPsql(sql, pgEnv) {
  const baseEnv = { ...process.env };
  for (const key of Object.keys(baseEnv)) {
    if (key.startsWith('PG')) delete baseEnv[key];
  }
  const env = {
    ...baseEnv,
    ...pgEnv,
    PGCONNECT_TIMEOUT: '5',
    PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000',
  };
  return spawnSync(
    'psql',
    ['-X', '--no-psqlrc', '--set=ON_ERROR_STOP=1', '--quiet', '--tuples-only', '--no-align'],
    {
      env,
      input: sql,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    },
  );
}

try {
  const pm2 = spawnSync('pm2', ['jlist'], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (pm2.status !== 0) {
    blocked('BLOCKED_PM2_ENV_UNAVAILABLE');
    process.exit(0);
  }

  let rows;
  try {
    rows = JSON.parse(pm2.stdout);
  } catch {
    blocked('BLOCKED_PM2_ENV_UNAVAILABLE');
    process.exit(0);
  }

  const processRow = rows.find((row) => String(row?.name ?? '') === pm2Name);
  if (!processRow?.pm2_env || String(processRow.pm2_env.status ?? '') !== 'online') {
    blocked('BLOCKED_PRODUCTION_PROCESS_UNAVAILABLE');
    process.exit(0);
  }
  if (String(processRow.pm2_env.DEPLOY_SHA ?? '') !== expectedSha) {
    blocked('BLOCKED_PRODUCTION_PROCESS_SHA_MISMATCH');
    process.exit(0);
  }

  const POSTGRES_URI_PATTERN = /^postgres(?:ql)?:\/\//i;
  const uriValues = Object.values(processRow.pm2_env)
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => POSTGRES_URI_PATTERN.test(value));
  const uniqueUris = [...new Set(uriValues)];

  if (uniqueUris.length === 0) {
    blocked('BLOCKED_NO_EXISTING_SAFE_POSTGRES_CONNECTION');
    process.exit(0);
  }
  if (uniqueUris.length !== 1) {
    blocked('BLOCKED_AMBIGUOUS_EXISTING_POSTGRES_CONNECTION');
    process.exit(0);
  }

  let parsed;
  try {
    parsed = new URL(uniqueUris[0]);
  } catch {
    blocked('BLOCKED_EXISTING_POSTGRES_CONNECTION_UNPARSEABLE');
    process.exit(0);
  }
  if (!POSTGRES_URI_PATTERN.test(parsed.protocol + '//')) {
    blocked('BLOCKED_EXISTING_POSTGRES_CONNECTION_UNPARSEABLE');
    process.exit(0);
  }

  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  if (!parsed.hostname || !database) {
    blocked('BLOCKED_EXISTING_POSTGRES_CONNECTION_INCOMPLETE');
    process.exit(0);
  }

  const pgEnv = {
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || '5432',
    PGUSER: decodeURIComponent(parsed.username || ''),
    PGPASSWORD: decodeURIComponent(parsed.password || ''),
    PGDATABASE: database,
  };
  const sslmode = parsed.searchParams.get('sslmode');
  if (sslmode) pgEnv.PGSSLMODE = sslmode;

  const existsResult = runPsql(TABLE_EXISTS_SQL, pgEnv);
  if (existsResult.status !== 0) {
    blocked('BLOCKED_POSTGRES_READONLY_PROBE_FAILED', {
      EXISTING_SAFE_DB_CONNECTION_AVAILABLE: true,
    });
    process.exit(0);
  }

  const existsText = String(existsResult.stdout ?? '').trim().split(/\s+/).at(-1);
  if (existsText !== 't') {
    blocked('BLOCKED_WATCHLIST_TABLE_MISSING', {
      EXISTING_SAFE_DB_CONNECTION_AVAILABLE: true,
      TABLE_EXISTS: false,
    });
    process.exit(0);
  }

  const catalogResult = runPsql(CATALOG_SQL, pgEnv);
  if (catalogResult.status !== 0) {
    blocked('BLOCKED_POSTGRES_CATALOG_QUERY_FAILED', {
      EXISTING_SAFE_DB_CONNECTION_AVAILABLE: true,
      TABLE_EXISTS: true,
    });
    process.exit(0);
  }

  const text = String(catalogResult.stdout ?? '').trim();
  let evidence;
  try {
    evidence = JSON.parse(text);
  } catch {
    blocked('BLOCKED_POSTGRES_CATALOG_RESULT_INVALID', {
      EXISTING_SAFE_DB_CONNECTION_AVAILABLE: true,
      TABLE_EXISTS: true,
    });
    process.exit(0);
  }

  emit({
    ...evidence,
    STATUS: 'passed',
    DB_CATALOG_AUDIT: 'PASSED',
    PRODUCTION_SHA: expectedSha,
    EXISTING_SAFE_DB_CONNECTION_AVAILABLE: true,
    READ_ONLY_ENFORCED: true,
    ARBITRARY_SQL_ALLOWED: false,
    RAW_USER_DATA_EXPOSED: false,
  });
} catch {
  blocked('BLOCKED_UNEXPECTED_AUDIT_FAILURE');
}
NODE
