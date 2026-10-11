import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createManualFourMarketWalletRouter } from './manual-four-market-paper-wallets';
import type { StoredPaperJournalRecord } from '../services/paper-journal.types';
import type { ManualPaperFourMarketCycleInput } from '../services/manual-four-market-paper-cycle.service';
import { MANUAL_FOUR_MARKET_CONFIRMATION } from '../services/manual-four-market-paper-wallets.service';
const USER='11111111-1111-1111-1111-111111111111';
const NOW=new Date('2026-10-11T04:00:00Z');
async function server(options:{
  enabled?:boolean; rls?:boolean; tier?:string;
  existing?:StoredPaperJournalRecord[];
  failInsert?:boolean;
  previewEnabled?:boolean;
  previewEvidence?:ManualPaperFourMarketCycleInput;
}={}){
  const state={ rows:options.existing??[] as StoredPaperJournalRecord[],writes:0 };
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
    market:'crypto_futures',strategyCandidateId:'validated-01',
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
    fxSourceId:'server-fx-1',fxObservedAtMs:NOW.getTime()-15_000,
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
    const r=await post(junior.host+cyclePath,selection);
    assert.equal(r.status,403);
    assert.equal((await r.json()).code,'MANUAL_PAPER_FUTURES_CAPABILITY_REQUIRED');
  }finally{await junior.close()}
});
