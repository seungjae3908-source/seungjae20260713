import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
const apiRoot=path.basename(process.cwd())==='api-server'
  ? process.cwd():path.join(process.cwd(),'api-server');
const migration=readFileSync(path.join(apiRoot,
  'supabase/migrations/2026101101_manual_four_market_paper_wallet_guard.sql'),'utf8');

test('manual 4-market Paper migration is transactional, follows V2 guards and has immutable 1m seeds',()=>{
  assert.match(migration,/^begin;/m);
  assert.match(migration,/^commit;/m);
  assert.match(migration,/four_market_paper_wallet_rls_guard_ready\(\) is true/i);
  for(const name of [
    'domestic_stock','us_stock','crypto_spot','crypto_futures',
    'manual-paper-%','manual-four-market-paper-v1',
  ])assert.ok(migration.includes(name),name);
  for(const field of ['initialBalance','equity','cashBalance','availableMargin',
    'usedMargin','reserveKrw','compoundedProfitKrw','compoundShare',
    'reserveShare','reserveWithdrawalAutomatic']){
    assert.ok(migration.includes(field),field);
  }
  assert.match(migration,/manual_four_market_paper_seed_contract check/i);
  assert.match(migration,/before update or delete on public\.paper_accounts/i);
  assert.match(migration,/manual_four_market_paper_wallet_rls_guard_ready/i);
  assert.match(migration,/revoke truncate,references,trigger/i);
  // No forged role/market/future-version can be created or removed through
  // authenticated Paper Journal sync or an unreviewed privileged mutation.
  assert.match(migration,/case when id like 'manual-paper-%' then/i);
  assert.match(migration,/using \(id not like 'manual-paper-%'\)/i);
  assert.match(migration,/with check \(id not like 'manual-paper-%'\)/i);
  assert.match(migration,/if old\.id like 'manual-paper-%'/i);
  assert.match(migration,/or new\.id like 'manual-paper-%'/i);
});
test('manual Paper never grants client direct mutation or a broader privileged RPC',()=>{
  for(const op of ['insert','update','delete']){
    assert.ok(migration.includes(`manual_v1_paper_wallet_${op}_guard`),op);
  }
  assert.match(migration,/as restrictive for insert to authenticated/i);
  assert.match(migration,/as restrictive for update to authenticated/i);
  assert.match(migration,/as restrictive for delete to authenticated/i);
  assert.match(migration,/revoke all on function public\.manual_four_market_paper_wallet_rls_guard_ready\(\)/i);
  assert.doesNotMatch(migration,/grant\s+(?:insert|update|delete)\s+on\s+public\.paper_accounts\s+to\s+authenticated/i);
  assert.doesNotMatch(migration,/security definer/i);
  assert.doesNotMatch(migration,/update\s+public\.paper_accounts\s+set\s+equity/i);
});
