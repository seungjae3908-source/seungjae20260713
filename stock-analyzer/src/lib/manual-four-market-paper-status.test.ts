import test from 'node:test';
import assert from 'node:assert/strict';
import {MANUAL_FOUR_MARKETS,parseManualFourMarketStatus} from './manual-four-market-paper-status';
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
