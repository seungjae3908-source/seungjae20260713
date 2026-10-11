import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessPaperResearchRound,type PaperRoundSnapshot,
} from './paper-research-round-lifecycle.service';
import {
  stageAutomaticPaperV3Epoch,sameAutomaticPaperV3Epoch,
  appendAutomaticPaperV3StagedEpoch,
} from './automatic-paper-v3-epoch.service';
import type {PaperRoundProposalRow} from './paper-research-round-proposal-store.service';

const NOW=Date.parse('2026-10-11T05:00:00.000Z');
const USER='11111111-1111-1111-1111-111111111111';
const HASH='a'.repeat(64);
const snap=(market:PaperRoundSnapshot['market']='crypto_futures',
  changes:Partial<PaperRoundSnapshot>={}):PaperRoundSnapshot=>({
  ownerId:USER,market,mode:'automatic',roundNumber:1,
  currentEpochId:'automatic-paper-member-v2:'+market,
  previousRoundReceiptSha256:null,settlementDigestSha256:HASH,
  ledgerReadbackReady:true,costsAndFxVerified:true,
  positionCount:0,pendingOrderCount:0,unreconciledFillCount:0,
  operatingCapitalKrw:0,reserveKrw:50_000,availableToTradeKrw:0,
  verifiedMinimumEntryKrw:null,minimumEntryObservedAtMs:null,
  nowMs:NOW,alreadyCreatedNextRound:false,
  ...changes,
});
const proposal=(s:PaperRoundSnapshot):PaperRoundProposalRow=>{
  const d=assessPaperResearchRound(s);
  assert.equal(d.status,'EXHAUSTED');
  return {
    proposal_id:d.proposedRoundId!,user_id:s.ownerId,
    owner_role:'member',trading_mode:'automatic',market:s.market,
    current_epoch_id:s.currentEpochId,next_round_number:s.roundNumber+1,
    previous_settlement_digest_sha256:s.settlementDigestSha256,
    proposed_seed_krw:1_000_000,
    ending_cause:d.endingCause!,previous_operating_capital_krw:s.operatingCapitalKrw,
    previous_locked_reserve_krw:s.reserveKrw,
    minimum_entry_krw:s.verifiedMinimumEntryKrw,
    observed_at:new Date(s.nowMs).toISOString(),
    status:'PROPOSAL_ONLY',execution_authority:'NONE',
    financial_mutation_allowed:false,reserve_transfer_allowed:false,
    historical_record_deletion_allowed:false,
  };
};
function run(s:PaperRoundSnapshot,changed:Record<string,unknown>={}){
  const p=proposal(s);
  return stageAutomaticPaperV3Epoch({
    ownerId:USER,role:'member',proposal:p,storedProposal:p,
    protectedSnapshot:s,existingSuccessorCount:0,environmentReady:true,
    ...changed,
  });
}
const fail=(s:PaperRoundSnapshot,changed:Record<string,unknown>,code:string)=>{
  const r=run(s,changed);
  assert.equal(r.status,'BLOCKED',JSON.stringify(r));
  assert.ok(r.blockers.includes(code),JSON.stringify(r.blockers));
  assert.equal(r.newActiveWalletCreated,false);
  assert.equal(r.providerCalls,0);
};
test('four market next automatic Paper epochs are unique, immutable candidate envelopes only',()=>{
  const staged=new Set<string>();
  for(const market of ['domestic_stock','us_stock','crypto_spot','crypto_futures'] as const){
    const next=run(snap(market));
    assert.equal(next.status,'STAGED_IN_MEMORY',JSON.stringify(next.blockers));
    assert.ok(next.candidate);
    assert.equal(next.candidate?.virtual_seed_krw,1_000_000);
    assert.equal(next.candidate?.operating_balance_seed_krw,1_000_000);
    assert.equal(next.candidate?.locked_reserve_seed_krw,0);
    assert.equal(next.candidate?.previous_locked_reserve_krw,50_000);
    assert.equal(next.candidate?.previous_residual_operating_krw,0);
    assert.equal(next.candidate?.activation_state,'STAGED_NOT_ACTIVE');
    assert.equal(next.candidate?.actual_paper_worker_attached,false);
    assert.equal(next.candidate?.real_order_enabled,false);
    assert.equal(next.newActiveWalletCreated,false);
    assert.equal(next.executionAuthority,'NONE');
    assert.equal(next.reserveTransferKrw,0);
    assert.ok(next.candidate?.epoch_id.startsWith('paper-v3-epoch:'));
    staged.add(next.candidate!.epoch_id);
    assert.deepEqual(next,run(snap(market)));
  }
  assert.equal(staged.size,4);
});
test('strict owner role, market, exact proposal digest and existence checks prevent double issue',()=>{
  const s=snap();
  const p=proposal(s);
  fail(s,{ownerId:'another-user'},'AUTO_PAPER_V3_OWNER_MODE_EPOCH_MISMATCH');
  fail(s,{role:'admin'},'AUTO_PAPER_V3_OWNER_MODE_EPOCH_MISMATCH');
  fail(s,{existingSuccessorCount:1},'AUTO_PAPER_V3_EXISTING_OR_UNKNOWN_SUCCESSOR');
  fail(s,{existingSuccessorCount:-1},'AUTO_PAPER_V3_EXISTING_OR_UNKNOWN_SUCCESSOR');
  fail(s,{environmentReady:false},'AUTO_PAPER_V3_STAGING_DISABLED');
  fail(s,{proposal:{...p,previous_settlement_digest_sha256:'b'.repeat(64)}},
    'AUTO_PAPER_V3_CAPITAL_PROOF_MISMATCH');
  fail(s,{storedProposal:{...p,ending_cause:'BELOW_VERIFIED_MINIMUM'}},
    'AUTO_PAPER_V3_STORED_PROPOSAL_MISMATCH');
  fail(s,{proposal:{...p,user_id:'someone-else'}},
    'AUTO_PAPER_V3_OWNER_MODE_EPOCH_MISMATCH');
  fail(s,{proposal:{...p,next_round_number:3}},
    'AUTO_PAPER_V3_OWNER_MODE_EPOCH_MISMATCH');
  fail(s,{proposal:{...p,previous_locked_reserve_krw:0}},
    'AUTO_PAPER_V3_CAPITAL_PROOF_MISMATCH');
});
test('open risk/locked funds/stale settlement/insufficient residual proof never become second funded epoch',()=>{
  const s=snap();
  for(const patch of [
    {positionCount:1},{pendingOrderCount:1},{unreconciledFillCount:1},
    {ledgerReadbackReady:false},{costsAndFxVerified:false},
    {operatingCapitalKrw:50_000,availableToTradeKrw:0},
    {alreadyCreatedNextRound:true},
  ]){
    const current={...s,...patch};
    const p=proposal(s);
    const r=stageAutomaticPaperV3Epoch({
      ownerId:USER,role:'member',proposal:p,storedProposal:p,
      protectedSnapshot:current,existingSuccessorCount:0,environmentReady:true,
    });
    assert.equal(r.status,'BLOCKED',JSON.stringify(patch));
    assert.equal(r.candidate,null);
  }
});
test('terminal residual below minimum is not classified bankrupt or credited from old reserve',()=>{
  const s=snap('us_stock',{
    operatingCapitalKrw:1_000,availableToTradeKrw:1_000,
    verifiedMinimumEntryKrw:5_000,minimumEntryObservedAtMs:NOW-10_000,
  });
  const staged=run(s);
  assert.equal(staged.status,'STAGED_IN_MEMORY');
  assert.equal(staged.candidate?.ending_cause,'BELOW_VERIFIED_MINIMUM');
  assert.equal(staged.candidate?.previous_residual_operating_krw,1_000);
  assert.equal(staged.candidate?.locked_reserve_seed_krw,0);
  assert.equal(staged.reserveTransferKrw,0);
});
test('same epoch check never silently accepts different capital, owner, digest or status',()=>{
  const r=run(snap());const expected=r.candidate!;
  const db={...expected,virtual_seed_krw:'1000000.00',
    previous_locked_reserve_krw:'50000.00'};
  assert.ok(sameAutomaticPaperV3Epoch(expected,db));
  const cases=[
    {previous_residual_operating_krw:null},
    {previous_residual_operating_krw:''},
    {previous_locked_reserve_krw:null},
    {epoch_id:'fake'},{proposal_id:'fake'},{user_id:'other'},
    {owner_role:'admin'},{market:'us_stock'},{mode:'manual'},
    {source_epoch_id:'other'},{next_round_number:3},{virtual_seed_krw:2_000_000},
    {previous_settlement_digest_sha256:'b'.repeat(64)},
    {previous_locked_reserve_krw:0},{previous_residual_operating_krw:500},
    {activation_state:'ACTIVE'},{real_order_enabled:true},
    {actual_paper_worker_attached:true},{execution_authority:'LIVE'},
    {previous_history_preserved:false},{created_from_verified_receipt:false},
  ];
  for(const patch of cases)assert.equal(sameAutomaticPaperV3Epoch(expected,{...db,...patch}),false);
});
test('production epoch writer is OFF by default and cannot insert even a correctly staged request',async()=>{
  const r=run(snap());
  const previous=process.env.AUTOMATIC_PAPER_V3_EPOCH_STAGING_ENABLED;
  delete process.env.AUTOMATIC_PAPER_V3_EPOCH_STAGING_ENABLED;
  try{
    await assert.rejects(()=>appendAutomaticPaperV3StagedEpoch(r.candidate!),
      /AUTO_PAPER_V3_EPOCH_STAGING_OFF/);
  }finally{
    if(previous===undefined)delete process.env.AUTOMATIC_PAPER_V3_EPOCH_STAGING_ENABLED;
    else process.env.AUTOMATIC_PAPER_V3_EPOCH_STAGING_ENABLED=previous;
  }
});
