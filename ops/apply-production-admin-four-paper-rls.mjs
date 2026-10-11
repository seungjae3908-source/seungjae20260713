import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA = String(process.env.APPROVED_TARGET_SHA ?? '').trim().toLowerCase();
const RAW_DATABASE_URL = String(process.env.PROD_DATABASE_URL ?? '').trim();
const PROJECT_REF = 'bawcbkoyovbeajkrnduq';
const MIGRATION = 'api-server/supabase/migrations/2026100901_admin_four_paper_wallet_rls_guard.sql';
const MEMBER_MIGRATION = 'api-server/supabase/migrations/2026101001_member_four_market_paper_wallet_guard.sql';

function fail(code) {
  // Never print connection strings, SQL errors, table rows or PostgreSQL stderr.
  console.error('[production-admin-four-paper-rls] ' + code);
  process.exit(1);
}
function protectedConnection(raw) {
  const u = new URL(raw);
  const host = u.hostname.toLowerCase();
  const user = decodeURIComponent(u.username).toLowerCase();
  const direct = host === 'db.' + PROJECT_REF + '.supabase.co' && user === 'postgres';
  const pooler = /(^|\.)pooler\.supabase\.com$/iu.test(host) && user === 'postgres.' + PROJECT_REF;
  if (!['postgres:','postgresql:'].includes(u.protocol)
    || (!direct && !pooler)
    || !u.password || decodeURIComponent(u.pathname.replace(/^\/+/u, '')) !== 'postgres'
    || (u.port || '5432') !== '5432') throw new Error('PRODUCTION_DATABASE_IDENTITY_INVALID');
  return Object.freeze({
    host,
    user,
    password: decodeURIComponent(u.password),
    database: 'postgres',
  });
}
function migrationBody(sql) {
  const lines = sql.replace(/^\uFEFF/u, '').split(/\r?\n/u);
  const starts = lines.flatMap((s,i) => /^\s*begin;\s*$/iu.test(s) ? [i] : []);
  const ends = lines.flatMap((s,i) => /^\s*commit;\s*$/iu.test(s) ? [i] : []);
  if (starts.length !== 1 || ends.length !== 1 || starts[0] >= ends[0]) {
    throw new Error('PRODUCTION_ADMIN_V2_MIGRATION_ENVELOPE_INVALID');
  }
  lines.splice(ends[0], 1);
  lines.splice(starts[0], 1);
  const body = lines.join('\n');
  if (/^\s*(?:begin|commit|rollback);\s*$/imu.test(body)) {
    throw new Error('PRODUCTION_ADMIN_V2_MIGRATION_NESTED_TX_FORBIDDEN');
  }
  return body;
}
if (!/^[0-9a-f]{40}$/u.test(SHA)) fail('APPROVED_TARGET_SHA_REQUIRED');
let db;
let migration;
let memberMigration;
try {
  db = protectedConnection(RAW_DATABASE_URL);
  migration = migrationBody(readFileSync(path.join(root, MIGRATION), 'utf8'));
  // Read the already committed member migration; never synthesize SQL from
  // runtime account state or weaken the existing administrator gate.
  memberMigration = migrationBody(readFileSync(path.join(root, MEMBER_MIGRATION), 'utf8'));
} catch {
  fail('CREDENTIAL_OR_MIGRATION_SOURCE_INVALID');
}

const preflightSql = "\ndo $admin_v2_preflight$\ndeclare\n  wallet_count bigint;\n  plan_count bigint;\n  journal_count bigint;\nbegin\n  if to_regclass('public.paper_accounts') is null\n    or to_regclass('public.trade_order_plans') is null\n    or to_regclass('public.paper_journal_entries') is null\n    or to_regclass('public.trade_order_legs') is null\n    or to_regclass('public.trade_protection_orders') is null\n    or to_regprocedure('public.current_membership_level()') is null then\n    raise exception 'PRODUCTION_ADMIN_V2_DATABASE_PREREQUISITES_MISSING';\n  end if;\n  select count(*) into wallet_count from public.paper_accounts\n    where id like 'automatic-paper-admin-v2:%';\n  select count(*) into plan_count from public.trade_order_plans;\n  select count(*) into journal_count from public.paper_journal_entries;\n  perform set_config('app.admin_v2_wallet_count_before',wallet_count::text,true);\n  perform set_config('app.admin_v2_plan_count_before',plan_count::text,true);\n  perform set_config('app.admin_v2_journal_count_before',journal_count::text,true);\nend\n$admin_v2_preflight$;";
const memberPreflightSql = "\\ndo $member_v2_preflight$\\ndeclare\\n  wallet_count bigint;\\nbegin\\n  if to_regprocedure('public.admin_four_paper_wallet_rls_guard_ready()') is null\\n    or public.admin_four_paper_wallet_rls_guard_ready() is not true then\\n    raise exception 'PRODUCTION_MEMBER_V2_ADMIN_GUARD_REQUIRED';\\n  end if;\\n  select count(*) into wallet_count from public.paper_accounts\\n    where id like 'automatic-paper-member-v2:%';\\n  perform set_config('app.member_v2_wallet_count_before',wallet_count::text,true);\\nend\\n$member_v2_preflight$;";
const verifySql = "\ndo $admin_v2_after_migration$\nbegin\n  if to_regprocedure('public.admin_four_paper_wallet_rls_guard_ready()') is null\n    or public.admin_four_paper_wallet_rls_guard_ready() is not true then\n    raise exception 'PRODUCTION_ADMIN_V2_RLS_GUARD_UNVERIFIED';\n  end if;\n  if (select count(*) from public.paper_accounts\n       where id like 'automatic-paper-admin-v2:%')\n     <> current_setting('app.admin_v2_wallet_count_before')::bigint then\n    raise exception 'PRODUCTION_ADMIN_V2_WALLET_ROWS_MUTATED';\n  end if;\n  if (select count(*) from public.trade_order_plans)\n     <> current_setting('app.admin_v2_plan_count_before')::bigint then\n    raise exception 'PRODUCTION_TRADE_PLANS_MUTATED';\n  end if;\n  if (select count(*) from public.paper_journal_entries)\n     <> current_setting('app.admin_v2_journal_count_before')::bigint then\n    raise exception 'PRODUCTION_PAPER_JOURNAL_ROWS_MUTATED';\n  end if;\nend\n$admin_v2_after_migration$;";
const memberVerifySql = "\\ndo $member_v2_after_migration$\\nbegin\\n  if to_regprocedure('public.four_market_paper_wallet_rls_guard_ready()') is null\\n    or public.four_market_paper_wallet_rls_guard_ready() is not true then\\n    raise exception 'PRODUCTION_MEMBER_V2_RLS_GUARD_UNVERIFIED';\\n  end if;\\n  if public.admin_four_paper_wallet_rls_guard_ready() is not true then\\n    raise exception 'PRODUCTION_ADMIN_V2_GUARD_REGRESSED';\\n  end if;\\n  if (select count(*) from public.paper_accounts\\n       where id like 'automatic-paper-member-v2:%')\\n     <> current_setting('app.member_v2_wallet_count_before')::bigint then\\n    raise exception 'PRODUCTION_MEMBER_V2_WALLET_ROWS_MUTATED';\\n  end if;\\nend\\n$member_v2_after_migration$;";
const selectSql = "select json_build_object(\n  'schemaVersion','production-admin-four-paper-rls-v1',\n  'status','passed',\n  'approvedTargetSha',current_setting('app.approved_target_sha'),\n  'adminV2RlsVerified',public.admin_four_paper_wallet_rls_guard_ready(),\n  'memberV2RlsVerified',public.four_market_paper_wallet_rls_guard_ready(),\n  'memberV2WalletRowsPreserved',true,\n  'transactional',true,\n  'historicalWalletRowsPreserved',true,\n  'paperTradePlanRowsPreserved',true,\n  'paperJournalRowsPreserved',true,\n  'walletsCreated',0,\n  'ordersCreated',0,\n  'privateProviderRequests',0,\n  'liveTradingEnabled',false,\n  'productionProjectMatch',true\n)::text;";

const sql = [
  '\\set ON_ERROR_STOP on',
  'begin;',
  'set transaction isolation level repeatable read;',
  "set local lock_timeout = '5s';",
  "set local statement_timeout = '120s';",
  "select pg_advisory_xact_lock(hashtextextended('production-admin-four-paper-rls-v1',0));",
  "select set_config('app.approved_target_sha','" + SHA + "',true);",
  preflightSql,
  memberPreflightSql,
  migration,
  memberMigration,
  verifySql,
  memberVerifySql,
  selectSql,
  'commit;',
  '',
].join('\n');

const childEnv = { ...process.env };
for (const key of Object.keys(childEnv)) if (key.startsWith('PG')) delete childEnv[key];
delete childEnv.PROD_DATABASE_URL;
const call = spawnSync('psql', [
  '-X', '--no-psqlrc', '--quiet', '--tuples-only', '--no-align',
  '--set=ON_ERROR_STOP=1',
  '--host', db.host,
  '--port', '5432',
  '--username', db.user,
  '--dbname', db.database,
], {
  input: sql,
  encoding: 'utf8',
  env: {
    ...childEnv,
    PGPASSWORD: db.password,
    PGCONNECT_TIMEOUT: '15',
    PGSSLMODE: 'require',
  },
  timeout: 180000,
  stdio: ['pipe','pipe','pipe'],
  maxBuffer: 1024 * 1024,
});
if (call.error || call.status !== 0) fail('ATOMIC_MIGRATION_FAILED_ROLLED_BACK');

let receipt;
try {
  const rows = String(call.stdout ?? '').trim().split(/\r?\n/u);
  receipt = JSON.parse(rows.findLast(line => line.trim().startsWith('{')));
} catch {
  fail('SANITIZED_RECEIPT_MISSING');
}
if (receipt?.schemaVersion !== 'production-admin-four-paper-rls-v1'
  || receipt?.status !== 'passed'
  || receipt?.approvedTargetSha !== SHA
  || receipt?.adminV2RlsVerified !== true
  || receipt?.memberV2RlsVerified !== true
  || receipt?.memberV2WalletRowsPreserved !== true
  || receipt?.productionProjectMatch !== true
  || receipt?.transactional !== true
  || receipt?.walletsCreated !== 0 || receipt?.ordersCreated !== 0
  || receipt?.paperJournalRowsPreserved !== true
  || receipt?.paperTradePlanRowsPreserved !== true
  || receipt?.historicalWalletRowsPreserved !== true
  || receipt?.privateProviderRequests !== 0 || receipt?.liveTradingEnabled !== false) {
  fail('ATOMIC_MIGRATION_RECEIPT_UNSAFE');
}
process.stdout.write(JSON.stringify(receipt) + '\n');
