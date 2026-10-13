import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileTelegramIntelligenceStateStore, MemoryTelegramIntelligenceStateStore }
  from './telegram-intelligence-worker.service';
import { aiWatchDurableKey, sendAiWatchWithDurableReceipt } from './telegram-ai-watch-delivery.service';

const identity = { signalId:'KR_STOCK|005930|s|15m|BUY',
  eventType:'NEW_CANDIDATE',sourceDay:'2026-10-13',
  catalyst:'POSITIVE',technicalChange:'BREAKOUT',contradiction:false };
const key=aiWatchDurableKey(identity);
const at=new Date('2026-10-13T03:00:00.000Z');
const alert={type:'intelligence_report' as const,market:'KR_STOCK',symbol:'005930'};
test('AI watch idempotency does not depend on deployment SHA and excludes secrets',()=>{
 assert.match(key,/^telegram-intelligence:ai-watch-v1:[0-9a-f]{64}$/);
 assert.equal(aiWatchDurableKey({...identity}),key);
 assert.notEqual(aiWatchDurableKey({...identity,sourceDay:'2026-10-14'}),key);
 assert.notEqual(aiWatchDurableKey({...identity,contradiction:true}),key);
 assert.throws(()=>aiWatchDurableKey({...identity,sourceDay:'wrong'}),/IDENTITY_INVALID/);
});
test('successful send is durably reserved before transport and never replayed',async()=>{
 const store=new MemoryTelegramIntelligenceStateStore();
 let tries=0;
 const send=async()=>{tries++;assert.equal(await store.hasUnconfirmed(key),true);
  return {ok:true as const,attempts:1};};
 assert.equal(await sendAiWatchWithDurableReceipt(store,key,alert,at,send),'ACCEPTED');
 assert.equal(await store.has(key),true);
 assert.equal(await store.hasUnconfirmed(key),false);
 assert.equal(await sendAiWatchWithDurableReceipt(store,key,alert,at,send),'ALREADY_RESERVED');
 assert.equal(tries,1);
});
test('ambiguous timeout, duplicate or thrown send retains permanent no-replay tombstone',async()=>{
 for(const result of [
  async()=>({ok:false as const,attempts:1,skipped:'OUTCOME_UNCONFIRMED' as const}),
  async()=>({ok:false as const,attempts:0,skipped:'DUPLICATE' as const}),
  async():Promise<never>=>{throw Error('NETWORK_LOST_AFTER_POST');},
 ]){
  const store=new MemoryTelegramIntelligenceStateStore();
  assert.equal(await sendAiWatchWithDurableReceipt(store,key,alert,at,result),'UNCONFIRMED');
  assert.equal(await store.hasUnconfirmed(key),true);
  let invoked=false;
  assert.equal(await sendAiWatchWithDurableReceipt(store,key,alert,at,async()=>{
   invoked=true;return {ok:true as const,attempts:1};
  }),'ALREADY_RESERVED');
  assert.equal(invoked,false);
 }
});
test('explicit no-send may be retried, storage failures stop before Bot transport',async()=>{
 const store=new MemoryTelegramIntelligenceStateStore();
 assert.equal(await sendAiWatchWithDurableReceipt(store,key,alert,at,async()=>({
  ok:false as const,attempts:0,skipped:'NOT_CONFIGURED' as const,
 })),'KNOWN_NO_SEND');
 assert.equal(await store.hasUnconfirmed(key),false);
 const refusing = {
  has: async()=>false, hasUnconfirmed: async()=>false,
  markUnconfirmed: async()=>{ throw Error('LEDGER_UNREADABLE'); },
  markDelivered: async()=>{}, releaseExplicitNoSend: async()=>{},
 };
 let sent=false;
 await assert.rejects(sendAiWatchWithDurableReceipt(refusing,key,alert,at,async()=>{
  sent=true;return {ok:true as const,attempts:1};
 }),/LEDGER_UNREADABLE/);
 assert.equal(sent,false);
});

test('actual fsynced ledger retains uncertain Bot outcome across a new process instance',async()=>{
 const root=mkdtempSync(path.join(tmpdir(),'telegram-ai-watch-ledger-'));
 try{
  const filename=path.join(root,'ai-watch-ledger.json');
  const first=new FileTelegramIntelligenceStateStore(filename);
  assert.equal(await sendAiWatchWithDurableReceipt(first,key,alert,at,async()=>({
   ok:false as const,attempts:1,skipped:'OUTCOME_UNCONFIRMED' as const,
  })),'UNCONFIRMED');
  assert.equal(statSync(filename).mode&0o777,0o600);
  const afterRestart=new FileTelegramIntelligenceStateStore(filename);
  let called=0;
  assert.equal(await sendAiWatchWithDurableReceipt(afterRestart,key,alert,at,async()=>{
   called++;return {ok:true as const,attempts:1};
  }),'ALREADY_RESERVED');
  assert.equal(called,0);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('an explicit Bot 403 rejection is never classified as accepted delivery',async()=>{
 const store=new MemoryTelegramIntelligenceStateStore();
 const result=await sendAiWatchWithDurableReceipt(store,key,alert,at,async()=>({
  ok:false as const,attempts:1,skipped:'DELIVERY_FAILED' as const,
  errorCode:'TELEGRAM_HTTP_403',
 }));
 assert.equal(result,'KNOWN_NO_SEND');
 assert.equal(await store.has(key),false);
 assert.equal(await store.hasUnconfirmed(key),false);
});
