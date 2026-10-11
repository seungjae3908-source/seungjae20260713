import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
const root=path.basename(process.cwd())==='api-server'?process.cwd()
  :path.join(process.cwd(),'api-server');
const sql=readFileSync(path.join(root,
  'supabase/migrations/2026101103_paper_research_round_proposals.sql'),'utf8');

test('round table records audit-only proposed epochs without wallet writes or profit minting',()=>{
  assert.match(sql,/^begin;/m);
  assert.match(sql,/^commit;/m);
  assert.match(sql,/paper_research_round_proposals/i);
  assert.match(sql,/status = 'PROPOSAL_ONLY'/);
  assert.match(sql,/financial_mutation_allowed is false/);
  assert.match(sql,/reserve_transfer_allowed is false/);
  assert.match(sql,/historical_record_deletion_allowed is false/);
  assert.match(sql,/proposed_seed_krw = 1000000/);
  assert.match(sql,/paper_round_close_evidence_consistent/);
  assert.match(sql,/ending_cause = 'ZERO_EQUITY'/);
  assert.match(sql,/ending_cause = 'BELOW_VERIFIED_MINIMUM'/);
  assert.doesNotMatch(sql,/\b(?:insert|update)\s+(?:into\s+)?public\.paper_accounts/i);
  for(const market of ['domestic_stock','us_stock','crypto_spot','crypto_futures'])
    assert.ok(sql.includes(market));
  for(const mode of ['automatic','manual'])
    assert.ok(sql.includes(mode));
});
test('round proposal events have owner-only SELECT and immutable service-role append',()=>{
  assert.match(sql,/enable row level security/i);
  assert.match(sql,/using \(user_id = \(select auth\.uid\(\)\)\)/i);
  assert.match(sql,/revoke all on table public\.paper_research_round_proposals/i);
  assert.match(sql,/grant select on table public\.paper_research_round_proposals to authenticated/i);
  assert.match(sql,/grant select, insert on table public\.paper_research_round_proposals to service_role/i);
  assert.match(sql,/before update or delete on public\.paper_research_round_proposals/i);
  assert.match(sql,/unique \(user_id,owner_role,trading_mode,market,current_epoch_id\)/i);
  assert.doesNotMatch(sql,/security definer/i);
  assert.doesNotMatch(sql,/grant (insert|update|delete) on table public\.paper_research_round_proposals to authenticated/i);
});
