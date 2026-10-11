import test from 'node:test';
import assert from 'node:assert/strict';
import type {PaperRoundSnapshot} from './paper-research-round-lifecycle.service';
import {
  MANUAL_RESEARCH_ROUND_OWNER_CONFIRMATION,
  recordPaperResearchRoundProposal,
  type PaperRoundProposalRow,
} from './paper-research-round-proposal-store.service';

const NOW=Date.parse('2026-10-11T04:30:00Z');
const USER='11111111-1111-1111-1111-111111111111';
const HASH='a'.repeat(64);
const fixture=(changed:Partial<PaperRoundSnapshot>={}):PaperRoundSnapshot=>({
  ownerId:USER,market:'crypto_futures',mode:'automatic',
  roundNumber:1,currentEpochId:'automatic-paper-member-v2:crypto_futures',
  previousRoundReceiptSha256:null,settlementDigestSha256:HASH,
  ledgerReadbackReady:true,costsAndFxVerified:true,
  positionCount:0,pendingOrderCount:0,unreconciledFillCount:0,
  operatingCapitalKrw:0,reserveKrw:80_000,availableToTradeKrw:0,
  verifiedMinimumEntryKrw:null,minimumEntryObservedAtMs:null,
  nowMs:NOW,alreadyCreatedNextRound:false,
  ...changed,
});

test('disabled research proposal writer does not query a database or mint capital',async()=>{
  let reads=0,writes=0;
  const result=await recordPaperResearchRoundProposal({
    ownerId:USER,ownerRole:'member',market:'crypto_futures',mode:'automatic',
  },{
    enabled:()=>false,
    readProtectedSnapshot:async()=>{reads++;return fixture()},
    appendProposal:async()=>{writes++;return 'INSERTED';},
  });
  assert.equal(result.status,'DISABLED');
  assert.equal(reads,0);assert.equal(writes,0);
  assert.equal(result.newWalletCreated,false);
  assert.equal(result.executionAuthority,'NONE');
});
test('exhausted automatic Paper market appends one proposal without altering reserve or creating wallet',async()=>{
  const records=new Map<string,PaperRoundProposalRow>();
  const input={ownerId:USER,ownerRole:'member' as const,market:'crypto_futures' as const,mode:'automatic' as const};
  const dependencies={
    enabled:()=>true,
    readProtectedSnapshot:async()=>fixture(),
    appendProposal:async(row:PaperRoundProposalRow)=>{
      if(records.has(row.proposal_id))return 'DUPLICATE' as const;
      records.set(row.proposal_id,row);return 'INSERTED' as const;
    },
  };
  const first=await recordPaperResearchRoundProposal(input,dependencies);
  const again=await recordPaperResearchRoundProposal(input,dependencies);
  assert.equal(first.status,'PROPOSAL_RECORDED');
  assert.equal(again.status,'ALREADY_PROPOSED');
  assert.equal(first.proposalId,again.proposalId);
  assert.equal(records.size,1);
  const row=[...records.values()][0];
  assert.equal(row.previous_operating_capital_krw,0);
  assert.equal(row.previous_locked_reserve_krw,80_000);
  assert.equal(row.proposed_seed_krw,1_000_000);
  assert.equal(row.execution_authority,'NONE');
  assert.equal(row.financial_mutation_allowed,false);
  assert.equal(row.reserve_transfer_allowed,false);
  assert.equal(row.historical_record_deletion_allowed,false);
  assert.equal(first.realOrders,0);
  assert.equal(first.simulatedFills,0);
  assert.equal(first.newWalletCreated,false);
  assert.equal(first.nextRoundTradingEnabled,false);
});
test('automatic vs manual owner action is mode-isolated',async()=>{
  let writes=0;
  const deps={
    enabled:()=>true,
    readProtectedSnapshot:async(input:{mode:string})=>fixture({mode:input.mode as 'manual'|'automatic'}),
    appendProposal:async()=>{writes++;return 'INSERTED' as const;},
  };
  const input={ownerId:USER,ownerRole:'member' as const,market:'crypto_futures' as const,mode:'manual' as const};
  const blocked=await recordPaperResearchRoundProposal(input,deps);
  assert.equal(blocked.status,'BLOCKED');
  assert.ok(blocked.blockers.includes('MANUAL_PAPER_RESEARCH_OWNER_CONFIRMATION_REQUIRED'));
  assert.equal(writes,0);
  const approved=await recordPaperResearchRoundProposal({
    ...input,confirmation:MANUAL_RESEARCH_ROUND_OWNER_CONFIRMATION,
  },deps);
  assert.equal(approved.status,'PROPOSAL_RECORDED');
  assert.equal(writes,1);
});
test('open exposure, untrusted full costs, wrong owner or locked capital prevent a proposal write',async()=>{
  const cases=[
    fixture({positionCount:1}),
    fixture({pendingOrderCount:1}),
    fixture({unreconciledFillCount:1}),
    fixture({ledgerReadbackReady:false}),
    fixture({costsAndFxVerified:false}),
    fixture({operatingCapitalKrw:100_000,availableToTradeKrw:0}),
    fixture({alreadyCreatedNextRound:true}),
  ];
  for(const record of cases){
    let written=0;
    const r=await recordPaperResearchRoundProposal({
      ownerId:USER,ownerRole:'member',market:'crypto_futures',mode:'automatic',
    },{enabled:()=>true,readProtectedSnapshot:async()=>record,
      appendProposal:async()=>{written++;return 'INSERTED'}});
    assert.equal(r.status,'BLOCKED');
    assert.equal(written,0);
  }
  let written=0;
  const alien=await recordPaperResearchRoundProposal({
    ownerId:USER,ownerRole:'member',market:'crypto_futures',mode:'automatic',
  },{enabled:()=>true,readProtectedSnapshot:async()=>fixture({
    ownerId:'22222222-2222-2222-2222-222222222222',
  }),appendProposal:async()=>{written++;return 'INSERTED'}});
  assert.equal(alien.status,'BLOCKED');
  assert.equal(written,0);
});
test('lost proposal insert returns a blocker instead of fake success or seed credit',async()=>{
  const r=await recordPaperResearchRoundProposal({
    ownerId:USER,ownerRole:'member',market:'crypto_futures',mode:'automatic',
  },{enabled:()=>true,readProtectedSnapshot:async()=>fixture(),
    appendProposal:async()=>{throw new Error('secret internal DB error');}});
  assert.equal(r.status,'BLOCKED');
  assert.deepEqual(r.blockers,['PAPER_ROUND_APPEND_NOT_VERIFIED']);
  assert.equal(r.newWalletCreated,false);
});
