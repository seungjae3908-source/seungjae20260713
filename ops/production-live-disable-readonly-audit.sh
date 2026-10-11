#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

PM2_NAME="${PM2_NAME:-stock-app}"
TARGET_SHA="${TARGET_SHA:-}"

node - "$PM2_NAME" "$TARGET_SHA" <<'NODE'
const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');

const pm2Name = process.argv[2] || 'stock-app';
const targetSha = String(process.argv[3] || '').trim().toLowerCase();
const schemaVersion = 'production-live-disable-readonly-audit-v1';
const transientProductionDatabaseUrl = String(process.env.PROD_DATABASE_URL ?? '').trim();
const common = {
  schemaVersion,
  targetSha,
  readOnlyEnforced: true,
  rawSecretValuesExposed: false,
  rawAccountValuesExposed: false,
  mutationRequests: { orders: 0, cancels: 0, amends: 0, transfers: 0, withdrawals: 0 },
};

function emit(value, exitCode) {
  process.stdout.write(JSON.stringify({ ...common, ...value }) + '\n');
  process.exit(exitCode);
}

function blocked(code, extra = {}) {
  emit({
    status: 'BLOCKED',
    code,
    productionProcessCount: 0,
    duplicateWorkers: 0,
    workerExecutingCount: 0,
    activeLocalOrderCount: 0,
    staleSubmittedOrderCount: 0,
    staleApprovalPlanCount: 0,
    duplicateClientOrderIdCount: 0,
    activeExecutionClaimCount: 0,
    activeRecoveryLeaseCount: 0,
    sanitizedBlockers: [],
    runtimeFlags: null,
    ...extra,
  }, 2);
}

function bool(env, key) {
  const value = env[key];
  if (value === undefined || value === false || value === 'false') return false;
  if (value === true || value === 'true') return true;
  blocked('BLOCKED_LIVE_STATE_NOT_TERMINAL', {
    sanitizedBlockers: [{ provider: 'runtime', symbol: 'REDACTED', state: `MALFORMED_${key}` }],
  });
}

function sanitizeToken(value, fallback, pattern) {
  const normalized = String(value ?? '').trim().toUpperCase();
  return pattern.test(normalized) ? normalized : fallback;
}

function sanitizeBlocker(row) {
  return {
    provider: sanitizeToken(row?.provider, 'UNKNOWN', /^[A-Z0-9_-]{1,16}$/u).toLowerCase(),
    symbol: sanitizeToken(row?.symbol, 'REDACTED', /^[A-Z0-9._/-]{1,32}$/u),
    state: sanitizeToken(row?.state, 'UNKNOWN', /^[A-Z0-9_/-]{1,64}$/u),
  };
}

if (!/^[0-9a-f]{40}$/u.test(targetSha)) blocked('LIVE_DISABLE_TARGET_SHA_INVALID');
const markerPath = '/opt/stock-app/.deploy/current-sha';
if (!existsSync(markerPath) || readFileSync(markerPath, 'utf8').trim() !== targetSha) {
  blocked('LIVE_DISABLE_DEPLOYED_SHA_MISMATCH');
}

const pm2 = spawnSync('pm2', ['jlist'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
if (pm2.status !== 0) blocked('LIVE_DISABLE_PM2_UNAVAILABLE');
let rows;
try { rows = JSON.parse(pm2.stdout); } catch { blocked('LIVE_DISABLE_PM2_INVALID'); }
if (!Array.isArray(rows)) blocked('LIVE_DISABLE_PM2_INVALID');
const matches = rows.filter((row) => String(row?.name ?? '') === pm2Name);
if (matches.length !== 1) {
  blocked('BLOCKED_LIVE_STATE_NOT_TERMINAL', {
    productionProcessCount: matches.length,
    duplicateWorkers: Math.max(0, matches.length - 1),
    sanitizedBlockers: [{ provider: 'worker', symbol: 'REDACTED', state: 'DUPLICATE_OR_MISSING_PROCESS' }],
  });
}
const runtime = matches[0]?.pm2_env;
if (!runtime || runtime.status !== 'online' || String(runtime.DEPLOY_SHA ?? '') !== targetSha) {
  blocked('LIVE_DISABLE_RUNTIME_IDENTITY_INVALID', { productionProcessCount: 1 });
}

const runtimeFlags = {
  liveTrading: bool(runtime, 'LIVE_TRADING'),
  autoTrading: bool(runtime, 'AUTO_TRADING'),
  realOrderEnabled: bool(runtime, 'REAL_ORDER_ENABLED'),
  privateTradingApiAllowed: bool(runtime, 'PRIVATE_TRADING_API_ALLOWED'),
  orderExecutionEnabled: bool(runtime, 'ORDER_EXECUTION_ENABLED'),
  liveActivationApproved: bool(runtime, 'LIVE_TRADING_ACTIVATION_APPROVED'),
  spotActivationApproved: bool(runtime, 'SPOT_LIVE_LIMITED_ACTIVATION_APPROVED'),
  futuresActivationApproved: bool(runtime, 'FUTURES_LIVE_LIMITED_ACTIVATION_APPROVED'),
  liveAutomaticTradingEnabled: bool(runtime, 'LIVE_AUTOMATIC_TRADING_ENABLED'),
  memberBackgroundEnabled: bool(runtime, 'MEMBER_AUTO_TRADING_BACKGROUND_ENABLED'),
  memberLiveBackgroundEnabled: bool(runtime, 'MEMBER_AUTO_TRADING_LIVE_BACKGROUND_ENABLED'),
  legacyCryptoAutoEnabled: bool(runtime, 'CRYPTO_AUTO_LEGACY_EXECUTION_ENABLED'),
  cryptoAutoTradeEnabled: bool(runtime, 'CRYPTO_AUTO_TRADE_ENABLED'),
  bitgetAutoTradeEnabled: bool(runtime, 'BITGET_AUTO_TRADE_ENABLED'),
  bitgetLiveOrderEnabled: bool(runtime, 'BITGET_LIVE_ORDER_ENABLED'),
  bitgetFuturesLiveOrderEnabled: bool(runtime, 'BITGET_FUTURES_LIVE_ORDER_ENABLED'),
  upbitLiveOrderEnabled: bool(runtime, 'UPBIT_LIVE_ORDER_ENABLED'),
  kiwoomLiveOrderEnabled: bool(runtime, 'KIWOOM_LIVE_ORDER_ENABLED'),
  tossLiveOrderEnabled: bool(runtime, 'TOSS_LIVE_ORDER_ENABLED'),
  executionAuthority: sanitizeToken(runtime.executionAuthority ?? 'NONE', 'UNKNOWN', /^[A-Z_]{1,40}$/u),
  futuresExecutionAuthority: sanitizeToken(runtime.FUTURES_LIVE_EXECUTION_AUTHORITY ?? 'NONE', 'UNKNOWN', /^[A-Z_]{1,40}$/u),
  futuresMaxLeverage: sanitizeToken(runtime.FUTURES_LIVE_MAX_LEVERAGE ?? '', 'UNSET', /^(?:[2-7]|)$/u),
  futuresMarginMode: sanitizeToken(runtime.FUTURES_LIVE_MARGIN_MODE ?? '', 'UNSET', /^(?:ISOLATED|)$/u),
};

if (runtimeFlags.memberBackgroundEnabled || runtimeFlags.memberLiveBackgroundEnabled) {
  blocked('BLOCKED_LIVE_STATE_NOT_TERMINAL', {
    productionProcessCount: 1,
    workerExecutingCount: 1,
    runtimeFlags,
    sanitizedBlockers: [{ provider: 'worker', symbol: 'REDACTED', state: 'BACKGROUND_EXECUTION_ENABLED' }],
  });
}

const SQL = [
  'BEGIN READ ONLY;',
  'WITH',
  'live_plans AS (',
  "  SELECT user_id,id,state,payload,approval_expires_at,updated_at FROM public.trade_order_plans WHERE lower(coalesce(payload->>'accountMode','')) = 'live'",
  '),',
  'live_orders AS (',
  '  SELECT o.*,p.payload AS plan_payload FROM public.trade_orders o JOIN live_plans p ON p.user_id=o.user_id AND p.id=o.plan_id',
  '),',
  'active_orders AS (',
  "  SELECT * FROM live_orders WHERE state NOT IN ('FILLED','CANCELED','REJECTED','EXPIRED')",
  '),',
  'stale_submitted AS (',
  "  SELECT * FROM live_orders WHERE state='SUBMITTED' AND updated_at < clock_timestamp() - interval '15 minutes'",
  '),',
  'stale_approval AS (',
  "  SELECT * FROM live_plans WHERE state='APPROVAL_PENDING'",
  '),',
  'duplicate_clients AS (',
  "  SELECT exchange,client_order_id,min(coalesce(plan_payload->>'symbol','REDACTED')) AS symbol,count(*)::integer AS duplicate_count FROM live_orders GROUP BY exchange,client_order_id HAVING count(*) > 1",
  '),',
  'active_claims AS (',
  "  SELECT * FROM live_orders WHERE execution_claim_id IS NOT NULL AND execution_claimed_at >= clock_timestamp() - interval '30 seconds'",
  '),',
  'active_recovery_leases AS (',
  '  SELECT * FROM live_orders WHERE recovery_lease_owner IS NOT NULL AND recovery_lease_until > clock_timestamp()',
  '),',
  'blocker_rows AS (',
  "  SELECT exchange AS provider,coalesce(plan_payload->>'symbol','REDACTED') AS symbol,'ORDER_' || state AS state FROM active_orders",
  '  UNION ALL',
  "  SELECT coalesce(payload->>'exchange','internal'),coalesce(payload->>'symbol','REDACTED'),'PLAN_APPROVAL_PENDING_UNRESOLVED' FROM stale_approval",
  '  UNION ALL',
  "  SELECT exchange,coalesce(plan_payload->>'symbol','REDACTED'),'WORKER_EXECUTION_CLAIM_ACTIVE' FROM active_claims",
  '  UNION ALL',
  "  SELECT exchange,coalesce(plan_payload->>'symbol','REDACTED'),'RECOVERY_LEASE_ACTIVE' FROM active_recovery_leases",
  '  UNION ALL',
  "  SELECT exchange,symbol,'DUPLICATE_CLIENT_ORDER_ID' FROM duplicate_clients",
  '),',
  'summary AS (',
  ' SELECT',
  '  (SELECT count(*)::integer FROM active_orders) AS active_local_order_count,',
  '  (SELECT count(*)::integer FROM stale_submitted) AS stale_submitted_order_count,',
  '  (SELECT count(*)::integer FROM stale_approval) AS stale_approval_plan_count,',
  '  (SELECT count(*)::integer FROM duplicate_clients) AS duplicate_client_order_id_count,',
  '  (SELECT count(*)::integer FROM active_claims) AS active_execution_claim_count,',
  '  (SELECT count(*)::integer FROM active_recovery_leases) AS active_recovery_lease_count,',
  "  coalesce((SELECT json_agg(json_build_object('provider',provider,'symbol',symbol,'state',state) ORDER BY provider,symbol,state) FROM (SELECT * FROM blocker_rows LIMIT 50) b),'[]'::json) AS blockers",
  ')',
  "SELECT json_build_object('activeLocalOrderCount',active_local_order_count,'staleSubmittedOrderCount',stale_submitted_order_count,'staleApprovalPlanCount',stale_approval_plan_count,'duplicateClientOrderIdCount',duplicate_client_order_id_count,'activeExecutionClaimCount',active_execution_claim_count,'activeRecoveryLeaseCount',active_recovery_lease_count,'sanitizedBlockers',blockers)::text FROM summary;",
  'COMMIT;',
].join('\n');

function runPsql(sql, pgEnv) {
  const baseEnv = { ...process.env };
  for (const key of Object.keys(baseEnv)) if (key.startsWith('PG')) delete baseEnv[key];
  delete baseEnv.PROD_DATABASE_URL;
  return spawnSync('psql', ['-X', '--no-psqlrc', '--set=ON_ERROR_STOP=1', '--quiet', '--tuples-only', '--no-align'], {
    env: {
      ...baseEnv,
      ...pgEnv,
      PGCONNECT_TIMEOUT: '5',
      PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000',
    },
    input: sql,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
}

const uriPattern = /^postgres(?:ql)?:\/\//iu;
const uriValues = [transientProductionDatabaseUrl, ...Object.values(runtime)]
  .filter((value) => typeof value === 'string')
  .map((value) => value.trim())
  .filter((value) => uriPattern.test(value));
const uniqueUris = [...new Set(uriValues)];
if (uniqueUris.length !== 1) blocked('LIVE_DISABLE_SAFE_POSTGRES_CONNECTION_AMBIGUOUS', { productionProcessCount: 1, runtimeFlags });

let parsed;
try { parsed = new URL(uniqueUris[0]); } catch { blocked('LIVE_DISABLE_SAFE_POSTGRES_CONNECTION_INVALID', { productionProcessCount: 1, runtimeFlags }); }
const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
if (!parsed.hostname || !database) blocked('LIVE_DISABLE_SAFE_POSTGRES_CONNECTION_INCOMPLETE', { productionProcessCount: 1, runtimeFlags });
const pgEnv = {
  PGHOST: parsed.hostname,
  PGPORT: parsed.port || '5432',
  PGUSER: decodeURIComponent(parsed.username || ''),
  PGPASSWORD: decodeURIComponent(parsed.password || ''),
  PGDATABASE: database,
};
const sslmode = parsed.searchParams.get('sslmode');
if (sslmode) pgEnv.PGSSLMODE = sslmode;

const result = runPsql(SQL, pgEnv);
if (result.status !== 0) blocked('LIVE_DISABLE_READONLY_DATABASE_AUDIT_FAILED', { productionProcessCount: 1, runtimeFlags });
const line = String(result.stdout ?? '').split(/\r?\n/u).map((value) => value.trim()).find((value) => value.startsWith('{') && value.endsWith('}'));
let evidence;
try { evidence = JSON.parse(line || ''); } catch { blocked('LIVE_DISABLE_READONLY_DATABASE_RESULT_INVALID', { productionProcessCount: 1, runtimeFlags }); }
const counts = [
  'activeLocalOrderCount', 'staleSubmittedOrderCount', 'staleApprovalPlanCount',
  'duplicateClientOrderIdCount', 'activeExecutionClaimCount', 'activeRecoveryLeaseCount',
];
if (counts.some((key) => !Number.isInteger(evidence[key]) || evidence[key] < 0)) {
  blocked('LIVE_DISABLE_READONLY_DATABASE_RESULT_INVALID', { productionProcessCount: 1, runtimeFlags });
}
const sanitizedBlockers = Array.isArray(evidence.sanitizedBlockers)
  ? evidence.sanitizedBlockers.slice(0, 50).map(sanitizeBlocker)
  : [];
const workerExecutingCount = evidence.activeExecutionClaimCount + evidence.activeRecoveryLeaseCount;
const safe = counts.every((key) => evidence[key] === 0) && workerExecutingCount === 0 && sanitizedBlockers.length === 0;
emit({
  status: safe ? 'SAFE' : 'BLOCKED',
  code: safe ? null : 'BLOCKED_LIVE_STATE_NOT_TERMINAL',
  productionProcessCount: 1,
  duplicateWorkers: 0,
  workerExecutingCount,
  ...Object.fromEntries(counts.map((key) => [key, evidence[key]])),
  sanitizedBlockers,
  runtimeFlags,
}, safe ? 0 : 3);
NODE
