import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MANUAL_FOUR_MARKETS,parseManualFourMarketStatus,
  manualPaperBootstrapAuthorized,parseManualFourMarketResearchHistory,
} from './manual-four-market-paper-status';
const fixture=()=>({
  ok:true,mode:'MANUAL_PAPER_FOUR_MARKET_SEED_ONLY',
  ownerScope:'SELF',readOnlyProbe:true,role:'member',
  ready:false,rlsGuardReady:false,canCreate:false,manualExecutionReady:false,
  perMarketInitialKrw:1000000,totalInitialKrw:4000000,
  orderSubmitted:false,exchangeRequestSent:false,
  privateProviderRequests:0,realOrders:0,virtualSeedRowsInserted:0,
  blockers:['MANUAL_PAPER_WALLET_MISSING'],
  creationBlockers:['MANUAL_FOUR_MARKET_DATABASE_GUARD_REQUIRED'],
  markets:Object.fromEntries(MANUAL_FOUR_MARKETS.map(({key})=>[key,{
    id:`manual-paper-member-v1:${key}`,market:key,
    seedExists:false,validated:false,initialCapitalKrw:1000000,
    blockers:['MANUAL_PAPER_WALLET_MISSING'],
  }])),
});
test('unknown manual account seed is never rendered as financial equity',()=>{
  const read=parseManualFourMarketStatus(fixture());
  assert.equal(read.ready,false);
  assert.equal(read.totalInitialKrw,4_000_000);
  assert.equal(read.manualExecutionReady,false);
  assert.equal(read.rlsGuardReady,false);
});
test('four complete owner-scoped manual market seeds remain execution-disabled',()=>{
  const ready=fixture();
  ready.ready=true;ready.rlsGuardReady=true;
  for(const {key} of MANUAL_FOUR_MARKETS){
    ready.markets[key]={id:`manual-paper-member-v1:${key}`,market:key,
      seedExists:true,validated:true,initialCapitalKrw:1000000,blockers:[]};
  }
  assert.equal(parseManualFourMarketStatus(ready).ready,true);
  assert.equal(parseManualFourMarketStatus(ready).manualExecutionReady,false);
});
test('cross-account RLS, false-ready market and invented capital are rejected',()=>{
  for(const patch of [
    {ownerScope:'OTHER'},{orderSubmitted:true},{realOrders:1},{manualExecutionReady:true},
    {ready:true},{canCreate:true},{totalInitialKrw:2_000_000},
    {privateProviderRequests:1},{virtualSeedRowsInserted:4},
  ])assert.throws(()=>parseManualFourMarketStatus({...fixture(),...patch}));
  const changed=fixture();
  changed.markets.us_stock={...changed.markets.us_stock,
    id:'manual-paper-admin-v1:us_stock'};
  assert.throws(()=>parseManualFourMarketStatus(changed));
});

test('manual four-market bootstrap confirmation expires at owner switch and cannot cross fund',()=>{
  const ownerA='11111111-1111-1111-1111-111111111111';
  const ownerB='22222222-2222-2222-2222-222222222222';
  const ready=fixture();
  ready.rlsGuardReady=true;
  ready.canCreate=true;
  ready.creationBlockers=[];
  const checked=parseManualFourMarketStatus(ready);
  assert.equal(manualPaperBootstrapAuthorized(ownerA,ownerA,checked),true);
  assert.equal(manualPaperBootstrapAuthorized(ownerB,ownerA,checked),false);
  assert.equal(manualPaperBootstrapAuthorized(ownerA,ownerB,checked),false);
  assert.equal(manualPaperBootstrapAuthorized(ownerA,null,checked),false);
  assert.equal(manualPaperBootstrapAuthorized('',ownerA,checked),false);
  assert.equal(manualPaperBootstrapAuthorized(ownerA,ownerA,null),false);
  const noRls={...checked,rlsGuardReady:false};
  assert.equal(manualPaperBootstrapAuthorized(ownerA,ownerA,noRls),false);
  const existing={...checked,ready:true,canCreate:false};
  assert.equal(manualPaperBootstrapAuthorized(ownerA,ownerA,existing),false);
});


test('manual research history remains hypothetical, never real trades or current account equity',()=>{
  const good={
    ok:true,mode:'MANUAL_PAPER_RESEARCH_RECEIPT_READ_ONLY',
    ownerScope:'SELF',readOnlyProbe:true,
    financialMutationCount:0,privateProviderRequests:0,realOrders:0,
    orderSubmitted:false,exchangeRequestSent:false,executionAuthority:'NONE',
    actualPaperLedgerWritten:false,profitabilityProven:false,
    hasMoreThan100:false,receipts:[{
      cycleId:'paper-manual-cycle-v1:'+'a'.repeat(64),
      market:'crypto_futures',receiptSha256:'b'.repeat(64),
      recordedAt:'2026-10-12T00:00:00.000Z',
      status:'RESEARCH_SIMULATED_CLOSED',hypotheticalNetPnlKrw:-15000,
      actualPaperLedgerWritten:false,profitabilityProven:false,
    }],
  };
  const read=parseManualFourMarketResearchHistory(good);
  assert.equal(read.receipts.length,1);
  assert.equal(read.receipts[0].hypotheticalNetPnlKrw,-15000);
  assert.equal(read.receipts[0].actualPaperLedgerWritten,false);
  assert.equal(read.receipts[0].profitabilityProven,false);
  assert.equal(read.ownerScope,'SELF');
  for(const change of [
    {ownerScope:'OTHER'},{financialMutationCount:1},{profitabilityProven:true},
    {executionAuthority:'LIVE'},{orderSubmitted:true},{realOrders:1},
    {actualPaperLedgerWritten:true},
  ])assert.throws(()=>parseManualFourMarketResearchHistory({...good,...change}));
  for(const rowChange of [
    {market:'invalid'},{hypotheticalNetPnlKrw:Infinity},
    {status:'FILLED'},{actualPaperLedgerWritten:true},
    {profitabilityProven:true},{cycleId:'arbitrary'},{receiptSha256:'oops'},
  ])assert.throws(()=>parseManualFourMarketResearchHistory({
    ...good,receipts:[{...good.receipts[0],...rowChange}],
  }));
  assert.throws(()=>parseManualFourMarketResearchHistory({
    ...good,receipts:[good.receipts[0],good.receipts[0]],
  }));
});
test('failed/uninstalled manual research archive is not displayed as a zero-PnL ledger',()=>{
  for(const v of [null,{},{
    ok:false,mode:'MANUAL_PAPER_RESEARCH_RECEIPT_READ_ONLY',receipts:[],
  }])assert.throws(()=>parseManualFourMarketResearchHistory(v));
});
