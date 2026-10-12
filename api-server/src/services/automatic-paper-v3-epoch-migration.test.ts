import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
const apiRoot=path.basename(process.cwd())==='api-server'
  ?process.cwd():path.join(process.cwd(),'api-server');
const sql=readFileSync(path.join(apiRoot,
  'supabase/migrations/2026101104_paper_research_round_wallet_epochs.sql'),'utf8');

test('Draft automatic V3 epochs are 4-market, append-only virtual seed STAGED not active',()=>{
  assert.match(sql,/^begin;/m);
  assert.match(sql,/^commit;/m);
  for(const part of [
    'domestic_stock','us_stock','crypto_spot','crypto_futures',
    'paper_research_round_wallet_epochs','paper_research_round_proposals',
    'STAGED_NOT_ACTIVE','execution_authority','NONE',
    'actual_paper_worker_attached','created_from_verified_receipt',
    'real_order_enabled','previous_history_preserved',
    'virtual_seed_krw=1000000','locked_reserve_seed_krw=0',
  ])assert.ok(sql.includes(part),part);
  // Every successor must be bound to the exact historical epoch AND
  // operating/reserve amounts. Matching only owner+market+digest is unsafe.
  assert.match(sql,/foreign key\(proposal_id,user_id,owner_role,mode,market,\s*source_epoch_id,next_round_number,/i);
  assert.match(sql,/previous_settlement_digest_sha256,ending_cause,\s*previous_residual_operating_krw,previous_locked_reserve_krw\)/i);
  assert.match(sql,/references public\.paper_research_round_proposals\(\s*proposal_id,user_id,owner_role,trading_mode,market,\s*current_epoch_id,next_round_number,/i);
  assert.match(sql,/previous_settlement_digest_sha256,ending_cause,\s*previous_operating_capital_krw,previous_locked_reserve_krw\s*\)/i);
  assert.match(sql,/unique \(user_id,owner_role,mode,market,source_epoch_id\)/i);
  assert.match(sql,/unique \(user_id,owner_role,mode,market,next_round_number\)/i);
  assert.doesNotMatch(sql,/update\s+public\.paper_accounts/i);
  assert.doesNotMatch(sql,/insert\s+into\s+public\.paper_accounts/i);
});
test('V3 epoch table forbids client writes and keeps staged history immutable across service role',()=>{
  assert.match(sql,/enable row level security/i);
  assert.match(sql,/grant select on table public\.paper_research_round_wallet_epochs to authenticated/i);
  assert.match(sql,/grant select,insert on table public\.paper_research_round_wallet_epochs to service_role/i);
  assert.match(sql,/using \(user_id=\(select auth\.uid\(\)\)\)/i);
  assert.match(sql,/before update or delete on public\.paper_research_round_wallet_epochs/i);
  assert.match(sql,/revoke truncate,references,trigger/i);
  assert.doesNotMatch(sql,/security definer/i);
  assert.doesNotMatch(sql,/grant (insert|update|delete) on table public\.paper_research_round_wallet_epochs to authenticated/i);
  assert.doesNotMatch(sql,/activation_state='ACTIVE'/i);
  assert.doesNotMatch(sql,/account_balance.*\+1000000/i);
});
