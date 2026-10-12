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


test('manual research receipt schema is owner-scoped, append-only, immutable and does not mint 50/50 capital',()=>{
  for(const name of [
    'paper_manual_four_market_research_receipts',
    'paper_manual_research_receipt_wallet_fk',
    'paper_manual_research_receipt_identity',
    'paper_manual_research_receipt_claims',
    'paper-manual-cycle-v1:',
    'receipt_sha256',
    'RESEARCH_SIMULATED_CLOSED',
    'paper_manual_research_receipt_owner_read_v1',
    'paper_manual_research_receipt_no_update_delete',
    'manual_four_market_paper_receipt_rls_guard_ready',
    "receipt->>'actualPaperLedgerWritten' = 'false'",
    "receipt->>'realOrderSubmitted' = 'false'",
    "receipt->>'profitabilityProven' = 'false'",
    "receipt->>'financialMutationCount' = '0'",
  ])assert.ok(migration.includes(name),name);
  assert.match(migration,/primary key \(user_id, cycle_id\)/iu);
  assert.match(migration,/foreign key \(user_id, wallet_id\)[\s\S]*references public\.paper_accounts\(user_id, id\)/iu);
  assert.match(migration,/enable row level security;[\s\S]*force row level security;/iu);
  assert.match(migration,/for select to authenticated[\s\S]*using \(\(select auth\.uid\(\)\) = user_id\)/iu);
  assert.match(migration,/grant insert on public\.paper_manual_four_market_research_receipts[\s\S]*to service_role;/iu);
  assert.match(migration,/revoke truncate,update,delete on table[\s\S]*from public,anon,authenticated,service_role;/iu);
  assert.match(migration,/before update or delete on public\.paper_manual_four_market_research_receipts/iu);
  assert.match(migration,/if public\.manual_four_market_paper_receipt_rls_guard_ready\(\) is not true/iu);
  assert.doesNotMatch(migration,/grant\s+insert\s+on\s+public\.paper_manual_four_market_research_receipts\s+to\s+authenticated/iu);
  assert.doesNotMatch(migration,/security\s+definer/iu);
  assert.doesNotMatch(migration,/update\s+public\.paper_accounts\s+set\s+(?:cashBalance|equity)/iu);
});
