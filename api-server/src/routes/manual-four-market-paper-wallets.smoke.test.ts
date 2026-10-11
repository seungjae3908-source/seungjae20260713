import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createManualFourMarketWalletRouter } from './manual-four-market-paper-wallets';
import type { StoredPaperJournalRecord } from '../services/paper-journal.types';
import { MANUAL_FOUR_MARKET_CONFIRMATION } from '../services/manual-four-market-paper-wallets.service';
const USER='11111111-1111-1111-1111-111111111111';
const NOW=new Date('2026-10-11T04:00:00Z');
async function server(options:{
  enabled?:boolean; rls?:boolean; tier?:string;
  existing?:StoredPaperJournalRecord[];
  failInsert?:boolean;
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
