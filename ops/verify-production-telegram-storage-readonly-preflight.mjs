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

const sqlMatch = /const SQL = String\.raw`([\s\S]*?)`;/m.exec(script);
assert(sqlMatch, 'fixed read-only SQL block is required');
const sql = sqlMatch[1];
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
  assert(!forbidden.test(sql), `read-only SQL contains forbidden mutation token: ${forbidden}`);
}
assert.match(sql, /^\s*\\set ON_ERROR_STOP on/m);
assert.match(sql, /begin read only;/i);
assert.match(sql, /commit;/i);

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
