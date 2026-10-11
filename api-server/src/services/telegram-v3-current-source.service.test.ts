import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {validTelegramV3CurrentSource,boundedTelegramV3Json}
 from './telegram-v3-current-source.service';
import {
 SignalIntelligenceTelegramSubscriber,SignalIntelligenceTelegramDeliveryState,
} from './signal-intelligence-telegram-subscriber.service';
const SHA='a'.repeat(40),EPOCH='d0b3f7c2-9be7-4a1f-bd93-2d8e9b8e1d6a';
const NOW=Date.parse('2026-10-11T06:00:00.000Z');
const LANE_IDS=['KR','US','SPOT','FUTURES'].flatMap(m=>
 ['SCALPING_15M','SWING_60M','MID_LONG_1D'].map(t=>m+'_'+t));
const ID='US_STOCK|AAPL|SWING|60m|BUY';
function fixture(){
 const coverage=LANE_IDS.map(laneId=>{
   const active=laneId==='US_SWING_60M',market=laneId.startsWith('US_')
     ?'US_STOCK':laneId.startsWith('KR_')?'KR_STOCK':
       laneId.startsWith('SPOT_')?'CRYPTO_SPOT':'CRYPTO_FUTURES';
   return {
     laneId,sourceCycleId:EPOCH,market,
     strategy:laneId.split('_').slice(1,-1).join('_'),
     timeframe:laneId.endsWith('15M')?'15m':laneId.endsWith('60M')?'60m':'1D',
     universeSource:market==='US_STOCK'?'nasdaq-trader-public-directory'
       :market==='KR_STOCK'?'krx-symbol-master':
         market==='CRYPTO_SPOT'?'upbit-public':'bitget-public',
     status:active?'CANDIDATES_AVAILABLE':'BLOCKED_DATA',
     lastGoodPreserved:!active,cursorRotatedBlockedOnly:!active,
     responseDataState:active?'complete':'untrusted',
     universePartial:!active,universeStale:false,
     cursorBefore:0,cursorAfter:20,totalUniverse:100,
     providerErrors:0,timeouts:0,universeProviderErrors:0,
     publicExecutionDiagnostic:{
       state:'PAGE_EXECUTION_COMPLETE',requested:20,started:20,
       completed:20,partial:false,timedOut:false,
       providerErrors:0,timeouts:0,failuresObserved:0,
     },
   };
 });
 return {
   generatedAt:new Date(NOW-2000).toISOString(),serviceSha:SHA,
   publicDataOnly:true,
   safety:{executionAuthority:'NONE',privateTradingApiAllowed:false,
     realOrderAllowed:false},
   coverage,
   rows:[{id:ID,market:'US_STOCK',symbol:'AAPL',
     strategy:'SWING',timeframe:'60m',direction:'BUY',
     state:'CANDIDATE',dataStatus:'READY',
     validationTier:'RESEARCH_CANDIDATE',
     utilityR:1.2,utilityMode:'FULL_EXPECTED_UTILITY',leverage:null,
     provenance:{laneId:'US_SWING_60M',cursor:0,sourceCycleId:EPOCH}}],
   events:[{id:ID,type:'NEW_CANDIDATE',market:'US_STOCK',
     symbol:'AAPL',strategy:'SWING',timeframe:'60m',
     direction:'BUY',state:'CANDIDATE',validationTier:'RESEARCH_CANDIDATE',
     utilityR:1.2,utilityMode:'FULL_EXPECTED_UTILITY',leverage:null}],
 };
}
test('current 12-lane V3 current-page proof permits only a valid market candidate',()=>{
 const shot=fixture();
 assert.equal(validTelegramV3CurrentSource(shot,NOW),true);
 assert.equal(validTelegramV3CurrentSource({...shot,events:[]},NOW),true);
});
test('stale/future, cross-cycle, wrong-market, blocked/replayed or failed V3 proof cannot send',()=>{
 const mutate=(change:(x:ReturnType<typeof fixture>)=>void)=>{
   const x=fixture();change(x);return validTelegramV3CurrentSource(x,NOW);
 };
 assert.equal(mutate(x=>{x.rows[0].provenance.sourceCycleId='old';}),false);
 assert.equal(mutate(x=>{x.coverage[3].sourceCycleId='old';}),false);
 assert.equal(mutate(x=>{x.coverage.splice(0,1);}),false);
 assert.equal(mutate(x=>{x.coverage[4].status='BLOCKED_DATA';}),false);
 assert.equal(mutate(x=>{x.rows[0].provenance.cursor=5;}),false);
 assert.equal(mutate(x=>{x.events[0].direction='SHORT';}),false);
 assert.equal(mutate(x=>{
   x.events[0].id='FAKE_CANONICAL_ID';
   x.rows[0].id='FAKE_CANONICAL_ID';
 }),false);
 assert.equal(mutate(x=>{
   x.coverage[4].laneId='US_MID_LONG_1D';
   x.coverage[4].strategy='MID_LONG';
   x.coverage[5].laneId='US_SWING_60M';
   x.coverage[5].strategy='SWING';
   x.rows[0].provenance.laneId='US_MID_LONG_1D';
 }),false);
 assert.equal(mutate(x=>{x.events[0].type='STATE_CHANGED';}),false);
 assert.equal(mutate(x=>{x.events[0].validationTier='CHAMPION';}),false);
 assert.equal(mutate(x=>{x.events[0].utilityR=999;}),false);
 assert.equal(mutate(x=>{x.events[0].utilityMode='FAKE_PASS';}),false);
 assert.equal(mutate(x=>{(x.events[0] as {leverage:unknown}).leverage={status:'INDICATIVE_ONLY',hardMaximum:125};}),false);
 assert.equal(mutate(x=>{x.rows[0].dataStatus='BLOCKED';}),false);
 assert.equal(mutate(x=>{x.coverage[4].publicExecutionDiagnostic.completed=19;}),false);
 assert.equal(mutate(x=>{x.events.push({...x.events[0]});}),false);
 assert.equal(mutate(x=>{x.safety.executionAuthority='LIVE';}),false);
 assert.equal(validTelegramV3CurrentSource(fixture(),NOW+16*60_000),false);
 assert.equal(validTelegramV3CurrentSource(fixture(),NOW-60_000),false);
});
test('bounded source reader rejects oversized or malformed source JSON',async()=>{
 const valid=await boundedTelegramV3Json(
   new Response(JSON.stringify(fixture()),{status:200}));
 assert.equal(validTelegramV3CurrentSource(valid,NOW),true);
 await assert.rejects(boundedTelegramV3Json(
   new Response('X'.repeat(3000)),1024),/BODY_LIMIT/);
 await assert.rejects(boundedTelegramV3Json(
   new Response('{wrong}')),/JSON_INVALID/);
 await assert.rejects(boundedTelegramV3Json(new Response('{}',{
   headers:{'content-length':'10000000'}})),/BODY_LIMIT/);
});
test('public room and member watchlist receive only current verified V3 candidate, never stale replay',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'telegram-v3-current-'));
 const beforeUrl=process.env.SIGNAL_INTELLIGENCE_URL;
 const beforeUs=process.env.TELEGRAM_US_STOCK_CHAT_ID;
 let candidate=fixture(),publicSends=0,personalAttempts=0,requests=0;
 try{
   process.env.SIGNAL_INTELLIGENCE_URL='http://127.0.0.1:8790/v1/signals';
   process.env.TELEGRAM_US_STOCK_CHAT_ID='-10083004999999';
   const subscriber=new SignalIntelligenceTelegramSubscriber(
     new SignalIntelligenceTelegramDeliveryState(path.join(dir,'safe.json')),
     async()=>{publicSends++;return {ok:true as const,attempts:1};},
     async (_url,options)=>{
       requests++;assert.equal(options?.method,'GET');
       assert.equal(options?.redirect,'error');
       return new Response(JSON.stringify({
         ok:true,serviceSha:SHA,executionAuthority:'NONE',snapshot:candidate,
       }),{status:200});
     },
     async()=>{personalAttempts++;return {
       eligible:true,matched:1,attempted:1,delivered:0,queued:1,
       deduped:0,skipped:0,failed:0,reason:'COMPLETE' as const,
     };},
   );
   const at=new Date(NOW);
   let result=await subscriber.runOnce(at);
   assert.equal(result.sourceStatus,'READY');
   assert.equal(result.delivered,1);
   assert.equal(result.publicDelivered,1);
   assert.equal(result.personalDelivered,0);
   assert.equal(result.personalQueued,1);
   assert.equal(result.queued,1,'durable personal queue is NOT Bot API delivery');
   assert.equal(publicSends,1);assert.equal(personalAttempts,1);
   result=await subscriber.runOnce(at);
   assert.equal(result.sourceStatus,'READY');
   assert.equal(result.deduped,1);
   assert.equal(result.publicDelivered,0);
   assert.equal(result.personalQueued,1,
     'persistent member queue retry remains a separate idempotent operation');
   assert.equal(publicSends,1);
   candidate=fixture();candidate.generatedAt=new Date(NOW-20*60_000).toISOString();
   result=await subscriber.runOnce(at);
   assert.equal(result.sourceStatus,'INVALID_RESPONSE');
   assert.equal(result.queued,0);
   assert.equal(result.publicDelivered,0);
   assert.equal(publicSends,1);assert.equal(personalAttempts,2);
   assert.equal(requests,3);
 }finally{
   if(beforeUrl===undefined)delete process.env.SIGNAL_INTELLIGENCE_URL;
   else process.env.SIGNAL_INTELLIGENCE_URL=beforeUrl;
   if(beforeUs===undefined)delete process.env.TELEGRAM_US_STOCK_CHAT_ID;
   else process.env.TELEGRAM_US_STOCK_CHAT_ID=beforeUs;
   await rm(dir,{recursive:true,force:true});
 }
});
