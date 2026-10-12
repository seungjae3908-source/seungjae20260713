import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationPath = 'api-server/supabase/migrations/20261012010706_automatic_live_atomic_budget.sql';
const project = 'bawcbkoyovbeajkrnduq';
export function productionBudgetConnection(raw) {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase(); const user = decodeURIComponent(url.username).toLowerCase();
  const direct = host === `db.${project}.supabase.co` && user === 'postgres';
  const pooler = /(^|\.)pooler\.supabase\.com$/iu.test(host) && user === `postgres.${project}`;
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || (!direct && !pooler)
    || !url.password || decodeURIComponent(url.pathname.replace(/^\/+/u, '')) !== 'postgres'
    || (url.port || '5432') !== '5432' || url.searchParams.get('sslmode') === 'disable') {
    throw new Error('PRODUCTION_BUDGET_DATABASE_IDENTITY_INVALID');
  }
  return { host, user, database: 'postgres', password: decodeURIComponent(url.password) };
}
export function productionBudgetMigrationBody(sql) {
  const lines = sql.replace(/^\uFEFF/u, '').split(/\r?\n/u);
  const starts = lines.flatMap((line, index) => /^\s*begin;\s*$/iu.test(line) ? [index] : []);
  const ends = lines.flatMap((line, index) => /^\s*commit;\s*$/iu.test(line) ? [index] : []);
  if (starts.length !== 1 || ends.length !== 1 || starts[0] >= ends[0]) throw new Error('PRODUCTION_BUDGET_MIGRATION_ENVELOPE_INVALID');
  lines.splice(ends[0], 1); lines.splice(starts[0], 1);
  const body = lines.join('\n');
  if (/^\s*(?:begin|commit|rollback);\s*$/imu.test(body)) throw new Error('PRODUCTION_BUDGET_NESTED_TRANSACTION_FORBIDDEN');
  return body;
}
export function assertProductionBudgetReceipt(receipt, sha) {
  if (!/^[a-f0-9]{40}$/u.test(sha ?? '') || receipt?.schemaVersion !== 'production-auto-live-budget-install-v1'
    || receipt?.targetSha !== sha || receipt?.status !== 'PASS' || receipt?.transactional !== true
    || receipt?.guardReady !== true || receipt?.userTradingRowsPreserved !== true || receipt?.reservationRowsPreserved !== true
    || receipt?.productionProjectMatch !== true || !/^[a-f0-9]{64}$/u.test(receipt?.migrationSha256 ?? '')
    || ['orderRequests', 'cancelRequests', 'amendRequests', 'transferRequests', 'withdrawalRequests'].some((key) => receipt[key] !== 0)
    || receipt?.liveTradingAuthorityGranted !== false || receipt?.autoTradingAuthorityGranted !== false) {
    throw new Error('PRODUCTION_BUDGET_INSTALL_RECEIPT_UNSAFE');
  }
  return receipt;
}

async function main() {
  const sha = String(process.env.APPROVED_TARGET_SHA ?? '').trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error('APPROVED_TARGET_SHA_REQUIRED');
  const db = productionBudgetConnection(String(process.env.PROD_DATABASE_URL ?? '').trim());
  // A read-only check, not activation: never change a claim implementation while
  // the automatic execution worker is running. No runtime flag is written here.
  const response = await fetch('https://lsj119.com/api/health', { signal: AbortSignal.timeout(15000), cache: 'no-store' });
  const health = await response.json();
  if (!response.ok || health?.ok !== true || health?.identityMatch !== true
    || health?.autoTradingBackground?.enabled !== false || health?.autoTradingBackground?.liveEntriesArmed !== false
    || health?.autoTradingBackground?.liveEntryArmPresent !== false) {
    throw new Error('PRODUCTION_BUDGET_AUTO_WORKER_MUST_BE_OFF');
  }
  const source = readFileSync(path.join(root, migrationPath), 'utf8');
  const migrationHash = createHash('sha256').update(source).digest('hex');
  const body = productionBudgetMigrationBody(source);
  const fingerprint = String.raw`select md5(coalesce(string_agg(part,',' order by part),'')) from (
    select 'profile:'||user_id::text||':'||md5(payload::text) part from public.trade_automation_profiles
    union all select 'plan:'||user_id::text||':'||id::text||':'||md5(row_to_json(p)::text) from public.trade_order_plans p
    union all select 'order:'||user_id::text||':'||id::text||':'||md5(row_to_json(o)::text) from public.trade_orders o
    union all select 'event:'||user_id::text||':'||id::text||':'||md5(row_to_json(e)::text) from public.trade_order_events e
  ) rows`;
  const sql = [
    '\\set ON_ERROR_STOP on', 'begin isolation level serializable;',
    "set local lock_timeout='5s';", "set local statement_timeout='60s';",
    "select pg_advisory_xact_lock(hashtextextended('production-auto-live-budget-install-v1',0));",
    `select set_config('app.trading_fingerprint_before',(${fingerprint}),true);`,
    String.raw`do $before$ begin
      if to_regclass('public.trade_live_budget_reservations') is null then
        perform set_config('app.budget_fingerprint_before',md5(''),true);
      else
        perform set_config('app.budget_fingerprint_before',(select md5(coalesce(string_agg(row_to_json(r)::text,',' order by user_id,order_id),''))
          from public.trade_live_budget_reservations r),true);
      end if;
    end $before$;`,
    body,
    String.raw`do $after$ begin
      if (public.read_automatic_live_budget_guard()->>'ready')::boolean is distinct from true then raise exception 'BUDGET_GUARD_NOT_READY'; end if;
      if current_setting('app.trading_fingerprint_before')<>(${fingerprint}) then raise exception 'USER_TRADING_ROWS_MUTATED'; end if;
      if current_setting('app.budget_fingerprint_before')<>(select md5(coalesce(string_agg(row_to_json(r)::text,',' order by user_id,order_id),''))
        from public.trade_live_budget_reservations r) then raise exception 'BUDGET_RESERVATION_ROWS_MUTATED'; end if;
    end $after$;`,
    `select json_build_object('schemaVersion','production-auto-live-budget-install-v1','targetSha','${sha}',
      'migrationSha256','${migrationHash}','status','PASS','transactional',true,'guardReady',true,
      'userTradingRowsPreserved',true,'reservationRowsPreserved',true,'productionProjectMatch',true,
      'orderRequests',0,'cancelRequests',0,'amendRequests',0,'transferRequests',0,'withdrawalRequests',0,
      'liveTradingAuthorityGranted',false,'autoTradingAuthorityGranted',false)::text;`, 'commit;', '',
  ].join('\n');
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('PG') || key === 'PROD_DATABASE_URL') delete env[key];
  const result = spawnSync('psql', ['-X', '--no-psqlrc', '--quiet', '--tuples-only', '--no-align', '--set=ON_ERROR_STOP=1',
    '--host', db.host, '--port', '5432', '--username', db.user, '--dbname', db.database],
  { input: sql, encoding: 'utf8', env: { ...env, PGPASSWORD: db.password, PGSSLMODE: 'require', PGCONNECT_TIMEOUT: '15' },
    timeout: 90000, maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
  // A lost response is not proof of rollback. Never automatically reapply it.
  if (result.error || result.status !== 0) throw new Error('PRODUCTION_BUDGET_INSTALL_FAILED_VERIFY_DATABASE_BEFORE_RETRY');
  let receipt;
  try { receipt = JSON.parse(String(result.stdout ?? '').trim().split(/\r?\n/u).findLast((line) => line.startsWith('{'))); }
  catch { throw new Error('PRODUCTION_BUDGET_INSTALL_RECEIPT_MISSING'); }
  process.stdout.write(JSON.stringify(assertProductionBudgetReceipt(receipt, sha)) + '\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // Never print raw URL, private SQL, connection errors, provider payload or stderr.
    const code = /^[A-Z][A-Z0-9_]{0,120}$/u.test(error?.message ?? '') ? error.message : 'PRODUCTION_BUDGET_INSTALL_SAFE_FAILURE';
    console.error(`[production-auto-live-budget] ${code}`); process.exitCode = 1;
  });
}
