import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const apiRoot = path.basename(process.cwd()) === 'api-server'
  ? process.cwd() : path.join(process.cwd(), 'api-server');
const migration = readFileSync(path.join(
  apiRoot,
  'supabase/migrations/2026101001_member_four_market_paper_wallet_guard.sql',
), 'utf8');

test('member four-market Paper migration is transactional and preserves admin protection', () => {
  assert.match(migration, /^--[\s\S]*\nbegin;/i);
  assert.match(migration, /admin_four_paper_wallet_rls_guard_ready\(\) is true/i);
  assert.match(migration, /commit;\s*$/i);
  assert.doesNotMatch(migration, /security\s+definer/i);
  assert.doesNotMatch(migration, /disable\s+row\s+level\s+security/i);
});

test('every member Paper seed is exactly 1m, 50\/50, immutable and withdrawal-disabled', () => {
  assert.match(migration, /member_four_market_paper_seed_contract/i);
  assert.match(migration, /initialBalance'\)::numeric = 1000000/i);
  assert.match(migration, /equity'\)::numeric = 1000000/i);
  assert.match(migration, /compoundShare'\)::numeric = 0\.5/i);
  assert.match(migration, /reserveShare'\)::numeric = 0\.5/i);
  assert.match(migration, /reserveWithdrawalAutomatic'\)::boolean is false/i);
  for (const market of ['domestic_stock','us_stock','crypto_spot','crypto_futures']) {
    assert.ok(migration.includes(market));
  }
});

test('authenticated browser writes are denied for wallets and canonical automatic Paper evidence', () => {
  for (const operation of ['insert','update','delete']) {
    assert.ok(migration.includes(`member_v2_paper_wallet_${operation}_guard`));
    assert.ok(migration.includes(`member_v2_auto_paper_${operation}_guard`));
  }
  assert.match(migration, /as restrictive for insert to authenticated/i);
  assert.match(migration, /as restrictive for update to authenticated/i);
  assert.match(migration, /as restrictive for delete to authenticated/i);
  assert.match(migration, /automatic-paper-member-v2:%/i);
  assert.match(migration, /four_market_paper_wallet_rls_guard_ready/i);
});
