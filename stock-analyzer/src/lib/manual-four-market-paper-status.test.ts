import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MANUAL_FOUR_MARKETS,parseManualFourMarketStatus,
  manualPaperBootstrapAuthorized,parseManualFourMarketResearchHistory,
  parseManualSequentialOrderReadback,parseManualSequentialOrderList,
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


const mockSequentialReadback=(settled=false)=>{
  const orderId='manual-paper-seq-order-v1:'+'b'.repeat(64);
  const entryEvent={
    eventId:'manual-paper-seq-event-v1:'+'c'.repeat(64),
    sequence:1,kind:'OPEN_ORDER',observedAtMs:1791800000000,
  };
  const entryEvent2={
    eventId:'manual-paper-seq-event-v1:'+'d'.repeat(64),
    sequence:2,kind:'ENTRY_MATCH',observedAtMs:1791800000500,
  };
  const requestExit={
    eventId:'manual-paper-seq-event-v1:'+'e'.repeat(64),
    sequence:3,kind:'REQUEST_EXIT',observedAtMs:1791800000750,
  };
  const closeEvent={
    eventId:'manual-paper-seq-event-v1:'+'f'.repeat(64),
    sequence:4,kind:'EXIT_MATCH',observedAtMs:1791800001000,
  };
  return {
    ok:true,mode:'PAPER_SEQUENTIAL_SIMULATION_READ_ONLY',ownerScope:'SELF',
    readOnlyProbe:true,executionAuthority:'NONE',
    actualBrokerFill:false,actualPaperLedgerWritten:false,
    actualWalletMutation:false,financialMutationCount:0,
    realOrders:0,orderSubmitted:false,exchangeRequestSent:false,
    privateProviderRequests:0,profitabilityProven:false,
    projection:{
      schemaVersion:'manual-paper-sequential-events-v1',
      dataProvenance:'SERVER_EVENTS_ONLY',
      status:settled?'CLOSED_PROJECTION':'ENTRY_PENDING',
      blockers:[],orderId,market:'crypto_futures',
      processedEvents:settled?4:1,entryQuantity:settled?1:0,
      exitQuantity:settled?1:0,openQuantity:0,
      entryRemainderCancelled:false,
      hypotheticalNetPnlKrw:settled?12_000:null,
      hypotheticalOperatingCapitalKrw:settled?1_006_000:null,
      hypotheticalLockedReserveKrw:settled?6_000:null,
      hypotheticalHighWaterMarkKrw:settled?1_012_000:null,
      journalProjection:settled?{
        schemaVersion:'manual-paper-sequential-events-v1',
        actualBrokerFill:false,actualPaperLedgerWritten:false,
        executionAuthority:'NONE',netPnlKrw:12_000,
      }:null,
      executionAuthority:'NONE',actualBrokerFill:false,
      actualPaperLedgerWritten:false,actualWalletMutation:false,
      realOrderSubmitted:false,profitabilityProven:false,
    },
    eventHistory:settled?[entryEvent,entryEvent2,requestExit,closeEvent]:[entryEvent],
  };
};

test('manual sequential order readback preserves owner-scoped simulation only, never claims actual fills',()=>{
  for(const settled of [false,true]){
    const raw=mockSequentialReadback(settled);
    const parsed=parseManualSequentialOrderReadback(raw,raw.projection.orderId);
    assert.equal(parsed.ownerScope,'SELF');
    assert.equal(parsed.projection.actualBrokerFill,false);
    assert.equal(parsed.projection.actualPaperLedgerWritten,false);
    assert.equal(parsed.projection.executionAuthority,'NONE');
    assert.equal(parsed.eventHistory.length,settled?4:1);
    assert.equal(parsed.projection.hypotheticalNetPnlKrw,settled?12_000:null);
  }
});
test('manual sequential readback rejects altered owner, order identity, false profit or authority',()=>{
  const raw=mockSequentialReadback(true);
  const orderId=raw.projection.orderId;
  const tamper=[
    {...raw,ownerScope:'OTHER'},
    {...raw,realOrders:1},
    {...raw,privateProviderRequests:1},
    {...raw,actualPaperLedgerWritten:true},
    {...raw,profitabilityProven:true},
    {...raw,executionAuthority:'LIVE'},
    {...raw,projection:{...raw.projection,orderId:'manual-paper-seq-order-v1:'+'e'.repeat(64)}},
    {...raw,projection:{...raw.projection,status:'BLOCKED'}},
    {...raw,projection:{...raw.projection,entryQuantity:0.1}},
    {...raw,projection:{...raw.projection,openQuantity:0.1}},
    {...raw,projection:{...raw.projection,profitabilityProven:true}},
    {...raw,projection:{...raw.projection,actualBrokerFill:true}},
    {...raw,projection:{...raw.projection,journalProjection:null}},
    {...raw,projection:{...raw.projection,hypotheticalNetPnlKrw:Infinity}},
    {...raw,eventHistory:[raw.eventHistory[0],raw.eventHistory[0]]},
    {...raw,eventHistory:[raw.eventHistory[0],{
      ...raw.eventHistory[1],sequence:3,
    }]},
  ];
  for(const attempt of tamper){
    assert.throws(()=>parseManualSequentialOrderReadback(attempt,orderId));
  }
  assert.throws(()=>parseManualSequentialOrderReadback(raw,
    'manual-paper-seq-order-v1:'+'f'.repeat(64)));
  assert.throws(()=>parseManualSequentialOrderReadback(null,orderId));
});
test('unclosed manual order cannot show simulated realized profit or reserve',()=>{
  const pending=mockSequentialReadback(false);
  for(const mutation of [
    {hypotheticalNetPnlKrw:20},
    {hypotheticalOperatingCapitalKrw:1_000_020},
    {hypotheticalLockedReserveKrw:10},
    {journalProjection:{actualPaperLedgerWritten:false}},
  ]){
    const fake={...pending,projection:{...pending.projection,...mutation}};
    assert.throws(()=>parseManualSequentialOrderReadback(fake,pending.projection.orderId),
      /MANUAL_SEQ_ORDER_FALSE_SETTLEMENT/);
  }
});

test('manual sequential readback rejects false CLOSE without actual sequence-level order stages',()=>{
  const good=mockSequentialReadback(true);
  const {orderId}=good.projection;
  const noEntry=[good.eventHistory[0],{
    ...good.eventHistory[1],kind:'EXIT_MATCH',
  },good.eventHistory[2],good.eventHistory[3]];
  const noExitRequest=[good.eventHistory[0],good.eventHistory[1],{
    ...good.eventHistory[2],kind:'EXIT_MATCH',
  },good.eventHistory[3]];
  for(const events of [noEntry,noExitRequest]){
    assert.throws(()=>parseManualSequentialOrderReadback({
      ...good,eventHistory:events,
    },orderId),/MANUAL_SEQ_ORDER_EVENT_TRANSITION_INVALID/);
  }
});


const manualSeqOrderListFixture=()=>({
  ok:true,mode:'PAPER_SEQUENTIAL_SIMULATION_ORDER_LIST',ownerScope:'SELF',
  readOnlyProbe:true,executionAuthority:'NONE',
  realOrders:0,orderSubmitted:false,exchangeRequestSent:false,
  privateProviderRequests:0,actualBrokerFill:false,
  actualPaperLedgerWritten:false,actualWalletMutation:false,
  financialMutationCount:0,profitabilityProven:false,
  hasMoreThan25:false,orders:[{
    orderId:'manual-paper-seq-order-v1:'+'b'.repeat(64),
    market:'crypto_futures',symbol:'BTCUSDT',side:'LONG',leverage:7,
    createdAtMs:1791800000000,
    currentOrderStatus:'SELECT_ORDER_TO_VERIFY',
    actualBrokerFill:false,actualPaperLedgerWritten:false,
  }],
});
test('manual sequential order discovery returns only list identities, never a filled position or realized PnL',()=>{
  const r=parseManualSequentialOrderList(manualSeqOrderListFixture());
  assert.equal(r.ownerScope,'SELF');
  assert.equal(r.orders.length,1);
  assert.equal(r.orders[0].market,'crypto_futures');
  assert.equal(r.orders[0].currentOrderStatus,'SELECT_ORDER_TO_VERIFY');
  assert.equal(r.orders[0].actualBrokerFill,false);
  assert.equal(r.orders[0].actualPaperLedgerWritten,false);
  assert.equal(parseManualSequentialOrderList({
    ...manualSeqOrderListFixture(),orders:[],
  }).orders.length,0);
});
test('order list rejects unknown authority, injected financial amount and duplicate order IDs',()=>{
  const base=manualSeqOrderListFixture();
  for(const patch of [
    {ownerScope:'OTHER'},{executionAuthority:'LIVE'},{realOrders:1},
    {actualBrokerFill:true},{actualPaperLedgerWritten:true},
    {profitabilityProven:true},{financialMutationCount:1},
  ])assert.throws(()=>parseManualSequentialOrderList({...base,...patch}));
  for(const corrupt of [
    {orderId:'not-an-order'},
    {market:'missing'},
    {symbol:'../../secrets'},
    {side:'SHORT',market:'us_stock',leverage:1},
    {side:'BUY',market:'crypto_futures',leverage:1},
    {leverage:12500},
    {createdAtMs:Infinity},
    {currentOrderStatus:'CLOSED_PROJECTION'},
    {actualBrokerFill:true},
    {actualPaperLedgerWritten:true},
    {actualNetProfitKrw:12345},
  ])assert.throws(()=>parseManualSequentialOrderList({
    ...base,orders:[{...base.orders[0],...corrupt}],
  }));
  assert.throws(()=>parseManualSequentialOrderList({
    ...base,orders:[base.orders[0],base.orders[0]],
  }));
  assert.throws(()=>parseManualSequentialOrderList({
    ...base,orders:Array.from({length:26},()=>base.orders[0]),
  }));
});
test('server-unavailable owner order list must not become false zero-history success',()=>{
  for(const value of [null,{},{
    ok:false,mode:'PAPER_SEQUENTIAL_SIMULATION_ORDER_LIST',
    ownerScope:'SELF',orders:[],
  }])assert.throws(()=>parseManualSequentialOrderList(value));
});
