import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createManualFourMarketWalletRouter } from './manual-four-market-paper-wallets';
import type { StoredPaperJournalRecord } from '../services/paper-journal.types';
import {
  sameManualPaperResearchReceipt,
  manualPaperSequentialOrderId,
  manualPaperSequentialEventId,
  manualPaperSequentialRow,
  sameManualPaperSequentialRow,
  type ManualPaperFourMarketCycleInput,
  type ManualPaperResearchReceiptRow,
  type ManualPaperOrderPathInput,
  type ManualPaperSequentialEvent,
  type ManualPaperSequentialEventRow,
  type ManualPaperSequentialSession,
  type ManualPaperSequentialQuote,
  type ManualPaperSequentialKind,
  MANUAL_PAPER_SEQUENTIAL_LEDGER_VERSION,
} from '../services/manual-four-market-paper-cycle.service';
import { MANUAL_FOUR_MARKET_CONFIRMATION,
  buildManualFourMarketWalletSeeds } from '../services/manual-four-market-paper-wallets.service';
const USER='11111111-1111-1111-1111-111111111111';
const NOW=new Date('2026-10-11T04:00:00Z');
async function server(options:{
  enabled?:boolean; rls?:boolean; tier?:string;
  existing?:StoredPaperJournalRecord[];
  failInsert?:boolean;
  previewEnabled?:boolean;
  previewEvidence?:ManualPaperFourMarketCycleInput;
  orderPreviewEnabled?:boolean;
  orderPathEvidence?:ManualPaperOrderPathInput;
  receiptEnabled?:boolean; receiptRls?:boolean; receiptFail?:boolean;
  seqEnabled?:boolean; seqRls?:boolean; seqAppendFail?:boolean;
  seqMarketReady?:boolean;
  seqIssuer?:(input:{
    owner:{id:string;role:'admin'|'member'};
    action:ManualPaperSequentialKind;orderId:string|null;
    selection:Record<string,unknown>|null;requestKey:string;
    existing:readonly ManualPaperSequentialEvent[];nowMs:number;
  })=>ManualPaperSequentialEvent|null;
}={}){
  const state={
    rows:options.existing??[] as StoredPaperJournalRecord[],writes:0,
    researchWrites:0,receipts:[] as ManualPaperResearchReceiptRow[],
    seqWrites:0,seqRows:[] as ManualPaperSequentialEventRow[],
  };
  const app=express();app.use(express.json());
  app.use('/api',(req:any,_res,next)=>{
    req.member={id:USER,status:'approved',is_active:true,
      membership_level:options.tier??'regular'};
    req.accessToken='unit-test-auth-only';
    next();
  });
  app.use('/api',createManualFourMarketWalletRouter({
    now:()=>NOW,
    bootstrapEnabled:()=>options.enabled===true,
    researchPreviewEnabled:()=>options.previewEnabled===true,
    readResearchCycleEvidence:async()=>options.previewEvidence??null,
    sequentialWriteEnabled:()=>options.seqEnabled===true,
    sequentialRlsReady:async()=>options.seqRls!==false,
    sequentialMarketAdmissionReady:async()=>options.seqMarketReady===true,
    issueSequentialEvent:async input=>options.seqIssuer?.(input)??null,
    listSequentialRows:async(_req,owner,orderId)=>{
      assert.equal(owner,USER);
      return state.seqRows.filter(r=>r.user_id===owner
        &&r.order_id===orderId).sort((a,b)=>a.sequence_number-b.sequence_number)
        .map(r=>structuredClone(r));
    },
    appendSequentialRow:async(_req,row)=>{
      if(options.seqAppendFail)throw new Error('secret DB appender failure');
      assert.equal(row.user_id,USER);
      assert.equal(row.event.executionAuthority,'NONE');
      assert.equal(row.event.actualBrokerFill,false);
      assert.equal(row.event.walletMutation,false);
      const existing=state.seqRows.find(r=>r.order_id===row.order_id&&(
        r.sequence_number===row.sequence_number
        ||r.request_key===row.request_key||r.event_id===row.event_id));
      if(existing){
        if(!sameManualPaperSequentialRow(row,existing as unknown as Record<string,unknown>))
          throw new Error('immutable compare-and-set simulated conflict');
        return 'DUPLICATE' as const;
      }
      state.seqRows.push(structuredClone(row));state.seqWrites++;
      return 'INSERTED' as const;
    },
    orderPathPreviewEnabled:()=>options.orderPreviewEnabled===true,
    readOrderPathEvidence:async()=>options.orderPathEvidence??null,
    researchReceiptWriteEnabled:()=>options.receiptEnabled===true,
    researchReceiptRlsReady:async()=>options.receiptRls!==false,
    appendResearchReceipt:async(_req,receipt)=>{
      if(options.receiptFail)throw new Error('fake db error secret');
      assert.equal(receipt.user_id,USER);
      assert.equal(receipt.receipt.actualPaperLedgerWritten,false);
      assert.equal(receipt.receipt.realOrderSubmitted,false);
      const existing=state.receipts.find(row=>row.cycle_id===receipt.cycle_id);
      if(existing){
        if(!sameManualPaperResearchReceipt(receipt,
          structuredClone(existing) as unknown as Record<string,unknown>))
          throw new Error('simulated duplicate distinct price conflict');
        return 'DUPLICATE' as const;
      }
      state.researchWrites++;
      state.receipts.push(structuredClone(receipt));
      return 'INSERTED' as const;
    },
    listResearchReceipts:async(_req,owner)=>{
      assert.equal(owner,USER);
      return state.receipts.map(row=>({
        cycle_id:row.cycle_id,market:row.market,
        receipt_sha256:row.receipt_sha256,
        receipt:structuredClone(row.receipt) as unknown as Record<string,unknown>,
        created_at:NOW.toISOString(),
      }));
    },
    rlsReady:async()=>options.rls!==false,
    listSeeds:async(_req,owner)=>{
      assert.equal(owner,USER);
      return structuredClone(state.rows);
    },
    insertSeeds:async(_req,owner,role,records)=>{
      assert.equal(owner,USER);assert.equal(records.length,4);
      assert.ok(records.every(r=>r.payload.role===role&&r.payload.mode==='manual'));
      state.writes++;
      if(options.failInsert)throw new Error('fake database error containing secret');
      const result=records.map(r=>({...r,createdAt:NOW.toISOString(),
        serverUpdatedAt:NOW.toISOString()}));
      state.rows.push(...result);
      return result;
    },
  }));
  const instance=app.listen(0,'127.0.0.1');
  await new Promise<void>((resolve,reject)=>{
    instance.once('listening',resolve);instance.once('error',reject);
  });
  return {
    host:`http://127.0.0.1:${(instance.address() as AddressInfo).port}`,
    close:()=>new Promise<void>(resolve=>instance.close(()=>resolve())),
    state,
  };
}
const statusPath='/api/paper-trading/manual-four-market/status';
const createPath='/api/paper-trading/manual-four-market/bootstrap';
const body={confirmation:MANUAL_FOUR_MARKET_CONFIRMATION};
const post=(url:string,payload:unknown)=>fetch(url,{
  method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),
});
test('manual 4-market GET is owner-only read-only and never claims trade readiness',async()=>{
  const s=await server();
  try {
    const get=await fetch(s.host+statusPath);
    assert.equal(get.status,200);
    assert.equal(get.headers.get('cache-control'),'no-store');
    const r=await get.json();
    assert.equal(r.ok,true);
    assert.equal(r.ownerScope,'SELF');
    assert.equal(r.manualExecutionReady,false);
    assert.equal(r.totalInitialKrw,4_000_000);
    assert.equal(r.ready,false);
    assert.equal(r.virtualSeedRowsInserted,0);
    assert.equal(r.orderSubmitted,false);
    assert.equal(s.state.writes,0);
    assert.equal((await fetch(s.host+statusPath+'?userId=other')).status,400);
    assert.equal((await fetch(s.host+statusPath,{method:'HEAD'})).status,405);
  }finally{await s.close()}
});
test('one-time manual seeds require both protected migration, server flag and exact confirmation',async()=>{
  const s=await server();
  try {
    assert.equal((await post(s.host+createPath,body)).status,409);
    assert.equal(s.state.writes,0);
  }finally{await s.close()}
  const guard=await server({enabled:true,rls:false});
  try{
    assert.equal((await post(guard.host+createPath,body)).status,409);
    assert.equal(guard.state.writes,0);
  }finally{await guard.close()}
  const approved=await server({enabled:true,rls:true});
  try{
    for(const payload of [{}, {confirmation:'wrong'}, {...body,userId:'someone_else'}]){
      assert.equal((await post(approved.host+createPath,payload)).status,400);
      assert.equal(approved.state.writes,0);
    }
    const once=await post(approved.host+createPath,body);
    assert.equal(once.status,201);
    const result=await once.json();
    assert.equal(result.ready,true);
    assert.equal(result.manualExecutionReady,false);
    assert.equal(result.virtualSeedRowsInserted,4);
    assert.equal(result.totalInitialKrw,4_000_000);
    assert.equal(result.realOrders,0);
    assert.equal(result.automaticPaperWalletsChanged,0);
    assert.equal(result.liveAccountsChanged,0);
    assert.equal(approved.state.writes,1);
    assert.equal(approved.state.rows.length,4);
    assert.equal((await post(approved.host+createPath,body)).status,409);
    assert.equal(approved.state.writes,1);
    const after=await (await fetch(approved.host+statusPath)).json();
    assert.equal(after.ready,true);
    assert.equal(after.manualExecutionReady,false);
  }finally{await approved.close()}
});
test('manual route enforces approved member capability and cannot silently admit pending members',async()=>{
  const s=await server({enabled:true,tier:'pending'});
  try{
    assert.equal((await fetch(s.host+statusPath)).status,403);
    assert.equal((await post(s.host+createPath,body)).status,403);
    assert.equal(s.state.writes,0);
  }finally{await s.close()}
});
test('server insert errors never leak details or create a fake successful wallet',async()=>{
  const s=await server({enabled:true,failInsert:true});
  try{
    const response=await post(s.host+createPath,body);
    assert.equal(response.status,503);
    const raw=await response.text();
    assert.doesNotMatch(raw,/fake database error|secret|api.?key|service_role/i);
    assert.equal(JSON.parse(raw).ok,false);
  }finally{await s.close()}
});

const cyclePath='/api/paper-trading/manual-four-market/research-cycle-preview';
const selection={
  market:'crypto_futures',symbol:'BTCUSDT',strategyId:'user-strategy',
  candidateId:'validated-01',side:'LONG',leverage:7,
  requestedNotionalKrw:200_000,
};
const cycleEvidence:ManualPaperFourMarketCycleInput={
  selected:{
    ...selection,ownerId:USER,role:'member',mode:'manual',
    accountId:'manual-paper-member-v1:crypto_futures',
    signalObservedAtMs:NOW.getTime()-45_000,
  } as ManualPaperFourMarketCycleInput['selected'],
  verifiedOwner:{
    ownerId:USER,accountId:'manual-paper-member-v1:crypto_futures',
    market:'crypto_futures',strategyId:'user-strategy',strategyCandidateId:'validated-01',
    strategyValidatedAtMs:NOW.getTime()-120_000,
    strategySourceId:'verified-research-snapshot-1',
    walletReadbackReady:true,ownerRlsReady:true,
    initialCapitalKrw:1_000_000,currentRoundNumber:1,
    currentEpochId:'manual-owner-epoch-1',
    operatingCapitalKrw:1_000_000,lockedReserveKrw:0,
    highWaterMarkKrw:1_000_000,
    fullyReconciledFlatPosition:true,priorCloseEventIds:[],
  },
  entryQuote:{
    sourceId:'server-public-ask-1',market:'crypto_futures',
    symbol:'BTCUSDT',currency:'USDT',observedAtMs:NOW.getTime()-40_000,
    bid:99,ask:100,provenance:'SERVER_PUBLIC_MARKET_READBACK',
    closedCandleConfirmed:true,
  },
  exitQuote:{
    sourceId:'server-public-bid-2',market:'crypto_futures',
    symbol:'BTCUSDT',currency:'USDT',observedAtMs:NOW.getTime()-20_000,
    bid:108,ask:109,provenance:'SERVER_PUBLIC_MARKET_READBACK',
    closedCandleConfirmed:true,
  },
  costs:{
    sourceId:'server-cost-1',status:'SERVER_COST_EVIDENCE_READY',
    observedAtMs:NOW.getTime()-15_000,
    entryCommissionRate:0.001,exitCommissionRate:0.001,
    spreadAndSlippageKrw:100,taxKrw:0,signedFundingKrw:0,
    entryFxKrwPerQuote:1400,exitFxKrwPerQuote:1400,
    entryFxSourceId:'server-fx-entry-1',
    entryFxObservedAtMs:NOW.getTime()-40_000,
    exitFxSourceId:'server-fx-exit-2',
    exitFxObservedAtMs:NOW.getTime()-20_000,
  },nowMs:NOW.getTime(),
};
test('manual research cycle preview defaults off and cannot mint Paper even with crafted client economics',async()=>{
  const s=await server({previewEvidence:cycleEvidence});
  try{
    assert.equal((await post(s.host+cyclePath,selection)).status,409);
    assert.equal(s.state.writes,0);
  }finally{await s.close()}
  const noProvider=await server({previewEnabled:true});
  try{
    const r=await post(noProvider.host+cyclePath,selection);
    assert.equal(r.status,409);
    const value=await r.json();
    assert.equal(value.code,'MANUAL_PAPER_CERTIFIED_RESEARCH_DATA_REQUIRED');
    assert.equal(value.exchangeRequestSent,false);
    assert.equal(noProvider.state.writes,0);
  }finally{await noProvider.close()}
});
test('manual research preview disallows client-submitted FX, simulated quotes, identities and wrong sides',async()=>{
  const s=await server({previewEnabled:true,previewEvidence:cycleEvidence});
  try{
    for(const corrupt of [
      {...selection,userId:'another'},
      {...selection,accountMode:'live'},
      {...selection,quote:{bid:1,ask:2}},
      {...selection,fullCostsVerified:true},
      {...selection,side:'BUY'},
      {...selection,leverage:126},
      {...selection,requestedNotionalKrw:0},
    ])assert.equal((await post(s.host+cyclePath,corrupt)).status,400);
    assert.equal((await post(s.host+cyclePath+'?ownerId=another',selection)).status,400);
    const good=await post(s.host+cyclePath,selection);
    assert.equal(good.status,200);
    const result=await good.json();
    assert.equal(result.ok,true);
    assert.equal(result.ownerScope,'SELF');
    assert.equal(result.previewOnly,true);
    assert.equal(result.realPaperOrderCreated,false);
    assert.equal(result.result.status,'RESEARCH_SIMULATED_CLOSED');
    assert.equal(result.result.actualPaperLedgerWritten,false);
    assert.equal(result.result.executionAuthority,'NONE');
    assert.equal(result.exchangeRequestSent,false);
    assert.equal(s.state.writes,0);
  }finally{await s.close()}
});
test('manual research preview rejects different authenticated evidence owner and stale/tampered market data',async()=>{
  const alien=await server({previewEnabled:true,previewEvidence:{
    ...cycleEvidence,selected:{...cycleEvidence.selected,
      ownerId:'22222222-2222-2222-2222-222222222222'},
  }});
  try{
    const r=await post(alien.host+cyclePath,selection);
    assert.equal(r.status,409);
    assert.equal((await r.json()).code,'MANUAL_PAPER_EVIDENCE_OWNER_OR_SELECTION_MISMATCH');
  }finally{await alien.close()}
  const invalid=await server({previewEnabled:true,previewEvidence:{
    ...cycleEvidence,entryQuote:{...cycleEvidence.entryQuote,
      observedAtMs:NOW.getTime()-1_000_000},
  }});
  try{
    const r=await post(invalid.host+cyclePath,selection);
    assert.equal(r.status,409);
    assert.equal((await r.json()).code,'MANUAL_PAPER_EVIDENCE_BLOCKED');
  }finally{await invalid.close()}
  const junior=await server({previewEnabled:true,previewEvidence:cycleEvidence,tier:'associate'});
  try{
    // Associate users have canAccessPaperTrading. Do not leak/require the
    // separate live-futures permission for purely simulated Paper preview.
    const r=await post(junior.host+cyclePath,selection);
    assert.equal(r.status,200);
    const result=await r.json();
    assert.equal(result.previewOnly,true);
    assert.equal(result.exchangeRequestSent,false);
    assert.equal(junior.state.writes,0);
  }finally{await junior.close()}
  const pending=await server({previewEnabled:true,previewEvidence:cycleEvidence,tier:'pending'});
  try{
    assert.equal((await post(pending.host+cyclePath,selection)).status,403);
  }finally{await pending.close()}
});


const recordPath='/api/paper-trading/manual-four-market/research-cycle-record';
const historyPath='/api/paper-trading/manual-four-market/research-cycle-history';
const seededWallets=()=>buildManualFourMarketWalletSeeds('member',NOW).map(row=>({
  ...row,createdAt:NOW.toISOString(),serverUpdatedAt:NOW.toISOString(),
})) as StoredPaperJournalRecord[];
const confirmedResearch=()=>({
  confirmation:'RECORD_MANUAL_PAPER_RESEARCH_ONLY_PRESERVE_LOSSES',
  selection:{...selection},
});

test('manual research receipt is off by default and cannot record without protected seed/RLS',async()=>{
  for(const options of [
    {previewEnabled:true,receiptEnabled:false,existing:seededWallets()},
    {previewEnabled:true,receiptEnabled:true,receiptRls:false,existing:seededWallets()},
    {previewEnabled:true,receiptEnabled:true,existing:[] as StoredPaperJournalRecord[]},
    {previewEnabled:true,receiptEnabled:true,rls:false,existing:seededWallets()},
  ]){
    const s=await server({...options,previewEvidence:cycleEvidence});
    try{
      const response=await post(s.host+recordPath,confirmedResearch());
      assert.equal(response.status,409);
      assert.equal(s.state.researchWrites,0);
      assert.equal(s.state.writes,0);
      assert.equal(s.state.receipts.length,0);
    }finally{await s.close()}
  }
});
test('validated manual four-market research receipt records once, reads own history, never credits a wallet',async()=>{
  const options={
    previewEnabled:true,receiptEnabled:true,existing:seededWallets(),
    previewEvidence:cycleEvidence,
  };
  const s=await server(options);
  try{
    const first=await post(s.host+recordPath,confirmedResearch());
    assert.equal(first.status,201);
    const receipt=await first.json();
    assert.equal(receipt.researchReceiptRecorded,true);
    assert.equal(receipt.researchReceiptInsertionsByThisRequest,1);
    assert.equal(receipt.actualPaperLedgerWritten,false);
    assert.equal(receipt.realPaperOrderCreated,false);
    assert.equal(receipt.financialMutationCount,0);
    assert.equal(receipt.exchangeRequestSent,false);
    assert.equal(receipt.executionAuthority,'NONE');
    assert.match(receipt.cycleId,/^paper-manual-cycle-v1:[a-f0-9]{64}$/);
    assert.match(receipt.receiptSha256,/^[a-f0-9]{64}$/);
    const same=await post(s.host+recordPath,confirmedResearch());
    assert.equal(same.status,200);
    const second=await same.json();
    assert.equal(second.duplicateResearchReceipt,true);
    assert.equal(second.researchReceiptInsertionsByThisRequest,0);
    assert.equal(second.cycleId,receipt.cycleId);
    assert.equal(s.state.researchWrites,1);
    assert.equal(s.state.writes,0);
    assert.equal(s.state.rows.length,4,'immutable virtual seed remains untouched');
    const history=await fetch(s.host+historyPath);
    assert.equal(history.status,200);
    const body=await history.json();
    assert.equal(body.readOnlyProbe,true);
    assert.equal(body.receipts.length,1);
    assert.equal(body.receipts[0].market,'crypto_futures');
    assert.equal(body.receipts[0].status,'RESEARCH_SIMULATED_CLOSED');
    assert.equal(body.receipts[0].actualPaperLedgerWritten,false);
    assert.equal(body.profitabilityProven,false);
    assert.equal(body.financialMutationCount,0);
    assert.equal((await fetch(s.host+historyPath+'?userId=someone')).status,400);
  }finally{await s.close()}
});
test('manual research receipt cannot trust client economics or cross-owner/stale server evidence',async()=>{
  const base={previewEnabled:true,receiptEnabled:true,existing:seededWallets()};
  const s=await server({...base,previewEvidence:cycleEvidence});
  try{
    for(const malicious of [
      {...confirmedResearch(),userId:'someone'},
      {...confirmedResearch(),financialMutationCount:1},
      {confirmation:confirmedResearch().confirmation,
        selection:{...selection,entryFxKrwPerQuote:0.1}},
      {confirmation:confirmedResearch().confirmation,
        selection:{...selection,side:'BUY'}},
      {confirmation:'WRONG',selection},
    ]){
      const response=await post(s.host+recordPath,malicious);
      assert.equal(response.status,400);
    }
    assert.equal((await post(s.host+recordPath+'?ownerId=another',
      confirmedResearch())).status,400);
    assert.equal(s.state.researchWrites,0);
  }finally{await s.close()}
  const foreign=await server({...base,previewEvidence:{
    ...cycleEvidence,selected:{...cycleEvidence.selected,
      ownerId:'22222222-2222-2222-2222-222222222222'},
  }});
  try{
    assert.equal((await post(foreign.host+recordPath,confirmedResearch())).status,409);
    assert.equal(foreign.state.researchWrites,0);
  }finally{await foreign.close()}
  const stale=await server({...base,previewEvidence:{
    ...cycleEvidence,entryQuote:{...cycleEvidence.entryQuote,
      observedAtMs:NOW.getTime()-1_000_000},
  }});
  try{
    assert.equal((await post(stale.host+recordPath,confirmedResearch())).status,409);
    assert.equal(stale.state.researchWrites,0);
  }finally{await stale.close()}
});
test('same deterministic cycle with changed server price is a conflict, not a second profit',async()=>{
  const options={
    previewEnabled:true,receiptEnabled:true,existing:seededWallets(),
    previewEvidence:cycleEvidence,
  };
  const s=await server(options);
  try{
    assert.equal((await post(s.host+recordPath,confirmedResearch())).status,201);
    options.previewEvidence={...cycleEvidence,exitQuote:{
      ...cycleEvidence.exitQuote,bid:109,ask:110,sourceId:'public-revised-2',
    }};
    const conflict=await post(s.host+recordPath,confirmedResearch());
    assert.equal(conflict.status,409);
    assert.equal((await conflict.json()).code,'MANUAL_PAPER_RESEARCH_RECEIPT_NOT_RECORDED');
    assert.equal(s.state.researchWrites,1);
    assert.equal(s.state.receipts.length,1);
  }finally{await s.close()}
});
test('manual research receipt errors do not expose database failures or mint account credit',async()=>{
  const s=await server({
    previewEnabled:true,receiptEnabled:true,existing:seededWallets(),
    previewEvidence:cycleEvidence,receiptFail:true,
  });
  try{
    const response=await post(s.host+recordPath,confirmedResearch());
    assert.equal(response.status,409);
    const raw=await response.text();
    assert.doesNotMatch(raw,/fake db error|secret|service_role|api[_-]?key/i);
    assert.equal(s.state.researchWrites,0);
    assert.equal(s.state.writes,0);
  }finally{await s.close()}
});


const orderPath='/api/paper-trading/manual-four-market/order-cycle-preview';
const simulationMatches=():ManualPaperOrderPathInput=>{
  const qty=cycleEvidence.selected.requestedNotionalKrw/
    (cycleEvidence.entryQuote.ask*cycleEvidence.costs.entryFxKrwPerQuote);
  return {
    cycle:cycleEvidence,entryRemainderCanceled:false,
    events:[
      {eventId:'sim-entry-1',phase:'ENTRY',action:'BUY',
        quoteSourceId:cycleEvidence.entryQuote.sourceId,
        observedAtMs:cycleEvidence.entryQuote.observedAtMs,
        quantity:qty*0.6,provenance:'SERVER_PUBLIC_QUOTE_SIMULATION'},
      {eventId:'sim-entry-2',phase:'ENTRY',action:'BUY',
        quoteSourceId:cycleEvidence.entryQuote.sourceId,
        observedAtMs:cycleEvidence.entryQuote.observedAtMs,
        quantity:qty*0.4,provenance:'SERVER_PUBLIC_QUOTE_SIMULATION'},
      {eventId:'sim-exit-1',phase:'EXIT',action:'SELL',
        quoteSourceId:cycleEvidence.exitQuote.sourceId,
        observedAtMs:cycleEvidence.exitQuote.observedAtMs,
        quantity:qty,provenance:'SERVER_PUBLIC_QUOTE_SIMULATION'},
    ],
  };
};
test('manual four-market simulated order lifecycle is OFF and requires protected owner wallet and source',async()=>{
  const source=simulationMatches();
  const cases=[
    {orderPreviewEnabled:false,existing:seededWallets(),orderPathEvidence:source},
    {orderPreviewEnabled:true,existing:[] as StoredPaperJournalRecord[],orderPathEvidence:source},
    {orderPreviewEnabled:true,rls:false,existing:seededWallets(),orderPathEvidence:source},
    {orderPreviewEnabled:true,existing:seededWallets()},
  ];
  for(const options of cases){
    const fixture=await server(options);
    try{
      const response=await post(fixture.host+orderPath,selection);
      assert.equal(response.status,409);
      const body=await response.json();
      assert.equal(body.ok,false);
      assert.equal(body.orderSubmitted,false);
      assert.equal(body.exchangeRequestSent,false);
      assert.equal(body.executionAuthority,'NONE');
      assert.equal(fixture.state.writes,0);
      assert.equal(fixture.state.researchWrites,0);
    }finally{await fixture.close()}
  }
});
test('protected simulated entry->partial match->reducing close is preview only and leaves both ledgers unmodified',async()=>{
  const fixture=await server({
    orderPreviewEnabled:true,existing:seededWallets(),
    orderPathEvidence:simulationMatches(),
  });
  try{
    const r=await post(fixture.host+orderPath,selection);
    assert.equal(r.status,200);
    const body=await r.json();
    assert.equal(body.ok,true);
    assert.equal(body.previewOnly,true);
    assert.equal(body.ownerScope,'SELF');
    assert.equal(body.executionAuthority,'NONE');
    assert.equal(body.actualPaperOrderCreated,false);
    assert.equal(body.actualPaperFillsRecorded,false);
    assert.equal(body.actualPaperLedgerWritten,false);
    assert.equal(body.realPaperOrderCreated,false);
    assert.equal(body.financialMutationCount,0);
    assert.equal(body.profitabilityProven,false);
    assert.equal(body.simulatedOrderPath.status,'SIMULATED_CLOSED');
    assert.equal(body.simulatedOrderPath.entryMatchCount,2);
    assert.equal(body.simulatedOrderPath.exitMatchCount,1);
    assert.ok(body.simulatedOrderPath.hypotheticalNetPnlKrw>0);
    assert.equal(fixture.state.rows.length,4);
    assert.equal(fixture.state.writes,0);
    assert.equal(fixture.state.researchWrites,0);
    assert.equal(fixture.state.receipts.length,0);
  }finally{await fixture.close()}
});
test('client may select market and strategy but cannot inject price, quantity, cost, owner or real order rights',async()=>{
  const fixture=await server({
    orderPreviewEnabled:true,existing:seededWallets(),
    orderPathEvidence:simulationMatches(),
  });
  try{
    for(const forged of [
      {...selection,ownerId:'other'},
      {...selection,entryMatches:[{quantity:100000}]},
      {...selection,quote:{bid:1,ask:1}},
      {...selection,taxKrw:0},
      {...selection,executionAuthority:'LIVE'},
      {...selection,accountMode:'live'},
      {...selection,leverage:126},
      {...selection,side:'BUY'},
    ]){
      const r=await post(fixture.host+orderPath,forged);
      assert.equal(r.status,400,JSON.stringify(forged));
    }
    assert.equal((await post(fixture.host+orderPath+'?userId=other',selection)).status,400);
    assert.equal(fixture.state.writes,0);
  }finally{await fixture.close()}
});
test('foreign owner, stale source and over-closing must not emit hypothetical profit',async()=>{
  const baseline={
    orderPreviewEnabled:true,existing:seededWallets(),
  };
  for(const source of [
    {...simulationMatches(),cycle:{
      ...cycleEvidence,selected:{
        ...cycleEvidence.selected,ownerId:'22222222-2222-2222-2222-222222222222',
      },
    }},
    {...simulationMatches(),events:simulationMatches().events.map(event=>
      event.phase==='EXIT'?{...event,quantity:event.quantity*10}:event)},
    {...simulationMatches(),events:simulationMatches().events.map(event=>
      event.phase==='ENTRY'?{...event,quoteSourceId:'client-forged'}:event)},
  ]){
    const fixture=await server({...baseline,orderPathEvidence:source as ManualPaperOrderPathInput});
    try{
      const res=await post(fixture.host+orderPath,selection);
      assert.equal(res.status,409);
      assert.equal((await res.json()).ok,false);
      assert.equal(fixture.state.writes,0);
      assert.equal(fixture.state.researchWrites,0);
    }finally{await fixture.close()}
  }
});
test('open simulated exposure returns no cash, reserve or profit credit',async()=>{
  const order=simulationMatches();
  const fixture=await server({
    orderPreviewEnabled:true,existing:seededWallets(),
    orderPathEvidence:{...order,events:order.events.slice(0,1)},
  });
  try{
    const r=await post(fixture.host+orderPath,selection);
    assert.equal(r.status,200);
    const data=await r.json();
    assert.equal(data.simulatedOrderPath.status,'OPEN_UNSETTLED');
    assert.equal(data.simulatedOrderPath.hypotheticalNetPnlKrw,null);
    assert.equal(data.simulatedOrderPath.hypotheticalNewReserveKrw,null);
    assert.equal(data.simulatedOrderPath.actualPaperLedgerWritten,false);
    assert.equal(fixture.state.writes,0);
  }finally{await fixture.close()}
});


// Trusted server source fixture: the HTTP caller cannot set quote, fill qty,
// settlement costs, owner, margin, timestamp, provenance or true authority.
const seqUrl='/api/paper-trading/manual-four-market/sequential-order';
function verifiedSeqSource(input:{
  owner:{id:string;role:'admin'|'member'};action:ManualPaperSequentialKind;
  orderId:string|null;selection:Record<string,unknown>|null;
  requestKey:string;existing:readonly ManualPaperSequentialEvent[];nowMs:number;
}):ManualPaperSequentialEvent|null {
  const current=NOW.getTime();
  const selected=input.selection;
  const oldSession=input.existing[0]?.session;
  const s:ManualPaperSequentialSession=oldSession??{
    ownerId:input.owner.id,role:input.owner.role,
    market:selected?.market as ManualPaperSequentialSession['market']??'crypto_futures',
    walletId:'manual-paper-member-v1:crypto_futures',
    epochId:'manual-server-order-epoch-one',roundNumber:1,
    symbol:String(selected?.symbol??'BTCUSDT'),
    candidateId:String(selected?.candidateId??'validated-01'),
    strategyId:String(selected?.strategyId??'user-strategy'),
    strategyReceiptSha256:'a'.repeat(64),
    strategyValidatedAtMs:current-90_000,signalObservedAtMs:current-5_000,
    side:'LONG',leverage:7,requestedNotionalKrw:200_000,
    operatingCapitalKrw:1_000_000,lockedReserveKrw:0,
    highWaterMarkKrw:1_000_000,initialWalletReadbackVerified:true,
    independentStrategyEvidenceVerified:true,
  };
  const sequence=input.existing.length+1;
  const times={OPEN_ORDER:-4_500,ENTRY_MATCH:-3_000,
    CANCEL_ENTRY:-2_700,REQUEST_EXIT:-2_000,
    EXIT_MATCH:-1_000,CANCEL_EXIT:-500};
  const kind=input.action, observedAtMs=current+times[kind];
  const fx=1400,qty=s.requestedNotionalKrw/(100*fx);
  const entryQuote:ManualPaperSequentialQuote={
    provenance:'SERVER_PUBLIC_QUOTE_SIMULATION',
    quoteSourceId:'server-public-entry-quote',observedAtMs:current-3_500,
    currency:'USDT',bid:99,ask:100,fxKrwPerUnit:fx,
    fxSourceId:'server-entry-fx',fxObservedAtMs:current-3_700,
    feeKrw:10,taxKrw:0,slippageKrw:10,signedFundingKrw:0,
    fundingCoverageVerified:true,
  };
  const exitQuote:ManualPaperSequentialQuote={
    ...entryQuote,quoteSourceId:'server-public-exit-quote',
    observedAtMs:current-1_200,bid:108,ask:109,
    fxSourceId:'server-exit-fx',fxObservedAtMs:current-1_400,
  };
  const addition=kind==='OPEN_ORDER'?{session:s}
    :kind==='ENTRY_MATCH'?{quantity:qty,quote:entryQuote}
    :kind==='REQUEST_EXIT'?{quantity:qty}
    :kind==='EXIT_MATCH'?{quantity:qty,quote:exitQuote}:{};
  const withoutId={
    schemaVersion:MANUAL_PAPER_SEQUENTIAL_LEDGER_VERSION,
    orderId:manualPaperSequentialOrderId(s),
    requestKey:input.requestKey,sequence,
    ownerId:s.ownerId,walletId:s.walletId,role:s.role,market:s.market,
    kind,observedAtMs,source:'SERVER_ISSUED_PAPER_EVENT' as const,
    executionAuthority:'NONE' as const,actualBrokerFill:false as const,
    walletMutation:false as const,actualPaperLedgerWritten:false as const,
    ...addition,
  };
  return {...withoutId,eventId:manualPaperSequentialEventId(withoutId)};
}
const seqOpening={
  action:'OPEN_ORDER',requestKey:'seq-open-1',selection:{...selection},
};
const seqNext=(action:ManualPaperSequentialKind,orderId:string,requestKey:string)=>({
  action,orderId,requestKey,
});
test('server Paper events are OFF by default and require protected owner wallet and actual evidence provider',async()=>{
  const cases=[
    {seqEnabled:false,seqIssuer:verifiedSeqSource,existing:seededWallets()},
    {seqEnabled:true,seqRls:false,seqIssuer:verifiedSeqSource,existing:seededWallets()},
    {seqEnabled:true,seqIssuer:verifiedSeqSource,existing:[] as StoredPaperJournalRecord[]},
    {seqEnabled:true,existing:seededWallets()},
    {seqEnabled:true,seqIssuer:verifiedSeqSource,existing:seededWallets(),
      seqMarketReady:false},
  ];
  for(const options of cases){
    const fixture=await server(options);
    try{
      const response=await post(fixture.host+seqUrl+'/step',seqOpening);
      assert.equal(response.status,409);
      const body=await response.json();
      assert.equal(body.orderSubmitted,false);
      assert.equal(body.exchangeRequestSent,false);
      assert.equal(body.executionAuthority,'NONE');
      assert.equal(fixture.state.seqWrites,0);
      assert.equal(fixture.state.writes,0);
    }finally{await fixture.close()}
  }
});
test('actual durable PAPER-simulation events append atomically in sequence; no real broker or financial wallet write',async()=>{
  const fixture=await server({
    seqEnabled:true,seqIssuer:verifiedSeqSource,existing:seededWallets(),
    seqMarketReady:true,
  });
  try{
    const opened=await post(fixture.host+seqUrl+'/step',seqOpening);
    assert.equal(opened.status,201);
    const start=await opened.json();
    assert.equal(start.ok,true);
    assert.equal(start.duplicate,false);
    assert.equal(start.projection.status,'ENTRY_PENDING');
    assert.equal(start.actualBrokerFill,false);
    assert.equal(start.actualPaperLedgerWritten,false);
    const orderId=start.orderId;
    assert.match(orderId,/^manual-paper-seq-order-v1:[a-f0-9]{64}$/);
    const repeatOpen=await post(fixture.host+seqUrl+'/step',seqOpening);
    assert.equal(repeatOpen.status,200);
    assert.equal((await repeatOpen.json()).duplicate,true);
    assert.equal(fixture.state.seqWrites,1);
    const entry=await post(fixture.host+seqUrl+'/step',
      seqNext('ENTRY_MATCH',orderId,'seq-entry-1'));
    assert.equal(entry.status,201);
    assert.equal((await entry.json()).projection.status,'OPEN');
    const reopenEntry=await post(fixture.host+seqUrl+'/step',
      seqNext('ENTRY_MATCH',orderId,'seq-entry-1'));
    assert.equal(reopenEntry.status,200);
    assert.equal((await reopenEntry.json()).duplicate,true);
    const requestExit=await post(fixture.host+seqUrl+'/step',
      seqNext('REQUEST_EXIT',orderId,'seq-reduce-1'));
    assert.equal(requestExit.status,201);
    assert.equal((await requestExit.json()).projection.status,'EXIT_PENDING');
    const close=await post(fixture.host+seqUrl+'/step',
      seqNext('EXIT_MATCH',orderId,'seq-close-1'));
    assert.equal(close.status,201);
    const result=await close.json();
    assert.equal(result.projection.status,'CLOSED_PROJECTION');
    assert.ok(result.projection.hypotheticalNetPnlKrw>0);
    assert.equal(result.projection.actualPaperLedgerWritten,false);
    assert.equal(result.projection.actualBrokerFill,false);
    assert.equal(result.financialMutationCount,0);
    assert.equal(result.profitabilityProven,false);
    assert.equal(result.exchangeRequestSent,false);
    assert.equal(fixture.state.seqWrites,4);
    assert.equal(fixture.state.rows.length,4);
    assert.equal(fixture.state.writes,0);
    assert.equal(fixture.state.researchWrites,0);
    const read=await fetch(fixture.host+seqUrl+'/'+orderId);
    assert.equal(read.status,200);
    const history=await read.json();
    assert.equal(history.readOnlyProbe,true);
    assert.equal(history.projection.status,'CLOSED_PROJECTION');
    assert.deepEqual(history.eventHistory.map((r:any)=>r.kind),
      ['OPEN_ORDER','ENTRY_MATCH','REQUEST_EXIT','EXIT_MATCH']);
    assert.equal(history.actualBrokerFill,false);
    assert.equal(history.actualPaperLedgerWritten,false);
    assert.equal(history.eventHistory.length,4);
  }finally{await fixture.close()}
});
test('client quotes, funding, fill quantity, owner, LIVE rights and unrelated session fields are forbidden',async()=>{
  const fixture=await server({
    seqEnabled:true,seqIssuer:verifiedSeqSource,existing:seededWallets(),
    seqMarketReady:true,
  });
  try{
    for(const bad of [
      {...seqOpening,userId:'other'},
      {...seqOpening,selection:{...selection,quote:{bid:1,ask:1}}},
      {...seqOpening,selection:{...selection,requestedNotionalKrw:NaN}},
      {...seqOpening,quote:{bid:1,ask:1}},
      {...seqOpening,fundingKrw:0},
      {...seqOpening,executionAuthority:'LIVE'},
      {...seqOpening,accountMode:'live'},
      {...seqOpening,selection:{...selection,leverage:126}},
    ]){
      assert.equal((await post(fixture.host+seqUrl+'/step',bad)).status,400);
    }
    assert.equal((await post(fixture.host+seqUrl+'/step?userId=other',
      seqOpening)).status,400);
    assert.equal(fixture.state.seqWrites,0);
    const missing=await fetch(fixture.host+seqUrl+'/'+'0'.repeat(64));
    assert.equal(missing.status,400);
  }finally{await fixture.close()}
});
test('sequential request reuse and wrong server owner reject without append or sensitive error leakage',async()=>{
  const fixture=await server({
    seqEnabled:true,existing:seededWallets(),
    seqMarketReady:true,
    seqIssuer:(input)=>{
      const event=verifiedSeqSource(input);
      return event?{...event,ownerId:'different-user'}:null;
    },
  });
  try{
    const response=await post(fixture.host+seqUrl+'/step',seqOpening);
    assert.equal(response.status,409);
    assert.equal(fixture.state.seqWrites,0);
  }finally{await fixture.close()}
  const failure=await server({
    seqEnabled:true,seqIssuer:verifiedSeqSource,
    existing:seededWallets(),seqAppendFail:true,seqMarketReady:true,
  });
  try{
    const r=await post(failure.host+seqUrl+'/step',seqOpening);
    assert.equal(r.status,409);
    const body=await r.text();
    assert.doesNotMatch(body,/secret DB|service_role|api[_-]?key/i);
    assert.equal(failure.state.seqWrites,0);
  }finally{await failure.close()}
});
test('sequential Paper cannot append any event after a fully simulated close',async()=>{
  const fixture=await server({
    seqEnabled:true,seqIssuer:verifiedSeqSource,existing:seededWallets(),
    seqMarketReady:true,
  });
  try{
    const first=await (await post(fixture.host+seqUrl+'/step',seqOpening)).json();
    const id=first.orderId;
    for(const [action,key] of [
      ['ENTRY_MATCH','seq-entry-a'],
      ['REQUEST_EXIT','seq-request-a'],
      ['EXIT_MATCH','seq-exit-a'],
    ] as const)assert.equal((await post(fixture.host+seqUrl+'/step',
      seqNext(action,id,key))).status,201);
    const replay=await post(fixture.host+seqUrl+'/step',
      seqNext('ENTRY_MATCH',id,'reopen-exposure-forbidden'));
    assert.equal(replay.status,409);
    assert.equal((await replay.json()).code,'MANUAL_PAPER_SEQ_PROJECTION_BLOCKED');
    assert.equal(fixture.state.seqWrites,4);
  }finally{await fixture.close()}
});
