import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = readFileSync(path.join(root, 'ops/production-telegram-storage-readonly-preflight.mjs'), 'utf8');
const workflow = readFileSync(path.join(root, '.github/workflows/production-telegram-storage-readonly-preflight.yml'), 'utf8');

assert.match(script, /begin read only;/i);
assert.match(script, /default_transaction_read_only=on/);
assert.match(script, /database_changed:\s*false/);
assert.match(script, /raw_user_data_exposed:\s*false/);
assert.match(script, /arbitrary_sql_allowed:\s*false/);
assert.match(script, /private_trading_api_count:\s*0/);
assert.match(script, /live_trading_authority:\s*false/);
assert.match(script, /--verify-artifact/);

for (const marker of [
  'PRODUCTION_ENV_ALLOWLIST',
  "'/opt/stock-app/.env'",
  "'/opt/stock-app/.env.production'",
  "'/opt/stock-app/api-server/.env'",
  "'/opt/stock-app/api-server/.env.production'",
  'lstatSync',
  'realpathSync',
  '(stat.mode & 0o022)',
  'readAllowedEnvValues',
  'production_database_env_file_unsafe',
  'production_database_connection_ambiguous',
]) {
  assert(script.includes(marker), `read-only preflight is missing resolver safeguard: ${marker}`);
}
assert(!/\beval\s*\(/.test(script), 'read-only preflight must not eval env files');
assert(!/(^|\n)\s*(?:source|\.)\s+[^\n]+\.env/m.test(script), 'read-only preflight must not source env files');

const sqlMatch = /const SQL = String\.raw`([\s\S]*?)`;/m.exec(script);
assert(sqlMatch, 'fixed read-only SQL block is required');
const sql = sqlMatch[1];
const executableSql = sql.replace(/'(?:''|[^'])*'/g, "''");
for (const forbidden of [
  /\bcreate\b/i,
  /\balter\b/i,
  /\bdrop\b/i,
  /\binsert\b/i,
  /\bupdate\b/i,
  /\bdelete\b/i,
  /\btruncate\b/i,
  /\bgrant\b/i,
  /\brevoke\b/i,
  /\bcopy\b/i,
  /\bvacuum\b/i,
  /\breindex\b/i,
]) {
  assert(!forbidden.test(executableSql), `read-only SQL contains forbidden executable mutation token: ${forbidden}`);
}
assert.match(sql, /^\s*\\set ON_ERROR_STOP on/m);
assert.match(sql, /begin read only;/i);
assert.match(sql, /commit;/i);

for (const marker of [
  'member_watchlist_items',
  'member_watchlist_primary_key',
  'member_watchlist_rls',
  'member_watchlist_policies',
  'primary_key_identity',
  'relrowsecurity',
  'relforcerowsecurity',
  'member_watchlist_select_own',
  'member_watchlist_insert_own',
  'member_watchlist_update_own',
  'member_watchlist_delete_own',
  'member_watchlist_table_missing',
  'member_watchlist_columns_missing',
  'member_watchlist_primary_key_missing',
  'member_watchlist_rls_not_enforced',
  'member_watchlist_policy_contract_missing',
]) {
  assert(script.includes(marker), `member watchlist schema probe is missing contract marker: ${marker}`);
}
for (const column of [
  'user_id',
  'market',
  'symbol',
  'name',
  'currency',
  'target_price',
  'created_at',
  'updated_at',
]) {
  assert(sql.includes(`table_name='member_watchlist_items' and column_name='${column}'`), `member watchlist probe is missing column: ${column}`);
}
assert.match(sql, /array\['user_id', 'market', 'symbol'\]::text\[\]/);
assert(!/\bfrom\s+(?:public\.)?member_watchlist_items\b/i.test(executableSql), 'member watchlist probe must never read member rows');
assert(!/\bjoin\s+(?:public\.)?member_watchlist_items\b/i.test(executableSql), 'member watchlist probe must never join member rows');

assert.match(workflow, /name:\s*Production Telegram Storage Read-only Preflight/);
assert.match(workflow, /issue_comment:/);
assert.match(workflow, /pull_request:/);
assert.match(workflow, /\/run-telegram-storage-preflight /);
assert.match(workflow, /environment:\s*production/);
assert.match(workflow, /contents:\s*read/);
assert.match(workflow, /issues:\s*write/);
assert(!/contents:\s*write/.test(workflow), 'workflow must not have contents write permission');
assert(!/pull-requests:\s*write/.test(workflow), 'workflow must not have pull-request write permission');
assert.match(workflow, /EXPECTED_PRODUCTION_SHA/);
assert.match(workflow, /production-telegram-storage-readonly-preflight\.mjs --verify-artifact/);
assert.match(workflow, /Database changed:\s*`false`/);
assert.match(workflow, /Production deployment executed:\s*`false`/);
assert.match(workflow, /Secret values recorded:\s*`false`/);

process.stdout.write('Production Telegram storage read-only preflight contract: PASS\n');
