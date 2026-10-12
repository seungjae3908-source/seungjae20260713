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


test('sequential manual PAPER event table has per-owner RLS, atomic sequence/request CAS and no mutation grants',()=>{
  for(const fragment of [
    'paper_manual_four_market_order_events',
    'paper_manual_order_event_pkey',
    'paper_manual_order_event_unique_id',
    'paper_manual_order_event_unique_request',
    'paper_manual_order_event_wallet_fk',
    'paper_manual_order_event_identity',
    'paper_manual_order_event_server_only_claims',
    'paper_manual_order_event_owner_index',
    'paper_manual_order_events_owner_select_v1',
    'paper_manual_order_event_no_change',
    'paper_manual_order_event_immutable_v1',
    'manual_four_market_paper_sequential_guard_ready',
    "event->>'executionAuthority'='NONE'",
    "event->>'walletMutation'='false'",
    "event->>'actualPaperLedgerWritten'='false'",
    "event->>'actualBrokerFill'='false'",
    "event->>'source'='SERVER_ISSUED_PAPER_EVENT'",
  ])assert.ok(migration.includes(fragment),fragment);
  assert.match(migration,/primary key \(user_id,order_id,sequence_number\)/u);
  assert.match(migration,/unique \(user_id,order_id,event_id\)/u);
  assert.match(migration,/unique \(user_id,order_id,request_key\)/u);
  assert.match(migration,/paper_manual_order_event_global_request_unique[\s\S]*unique \(user_id,request_key\)/u);
  // The protected DB guard must verify the new global idempotency invariant.
  assert.match(migration,/conname in \([\s\S]*'paper_manual_order_event_global_request_unique'[\s\S]*\)\s*\)=7/u);
  assert.match(migration,/foreign key \(user_id,wallet_id\) references public\.paper_accounts\(user_id,id\)/u);
  assert.match(migration,/paper_manual_four_market_order_events\s+enable row level security;[\s\S]*force row level security;/u);
  assert.match(migration,/for select to authenticated\s+using \(\(select auth\.uid\(\)\)=user_id\)/u);
  assert.match(migration,/grant insert on public\.paper_manual_four_market_order_events\s+to service_role;/u);
  assert.match(migration,/revoke update,delete,truncate,references,trigger[\s\S]*from public,anon,authenticated,service_role;/u);
  assert.match(migration,/before update or delete on public\.paper_manual_four_market_order_events/u);
  assert.match(migration,/if public\.manual_four_market_paper_sequential_guard_ready\(\) is not true/u);
  assert.doesNotMatch(migration,/grant insert on public\.paper_manual_four_market_order_events\s+to authenticated/u);
  assert.doesNotMatch(migration,/security definer/u);
  assert.doesNotMatch(migration,/update public\.paper_accounts\s+set/u);
});


test('every required JSONB claim fails closed for SQL UNKNOWN, never accepts a sparse receipt',()=>{
  // PostgreSQL CHECK accepts NULL (UNKNOWN) as well as TRUE. Without
  // COALESCE, a receipt/event JSONB object containing no mandatory
  // attributes would evade the equality assertions as NULL.
  assert.match(migration,
    /constraint paper_manual_research_receipt_claims check \(coalesce\(\([\s\S]*?receipt->>'financialMutationCount' = '0'\s*\),false\)\)/iu);
  assert.match(migration,
    /constraint paper_manual_order_event_server_only_claims check \(coalesce\(\([\s\S]*?event->>'actualPaperLedgerWritten'='false'[\s\S]*?\),false\)\)/iu);
  for(const required of [
    "receipt->>'schemaVersion'",
    "receipt->>'cycleId'",
    "receipt->>'ownerId'",
    "receipt->>'executionAuthority'",
    "event->>'schemaVersion'",
    "event->>'orderId'",
    "event->>'ownerId'",
    "event->>'source'",
    "event->>'executionAuthority'",
    "event->>'actualBrokerFill'",
  ])assert.ok(migration.includes(required),required);
});
