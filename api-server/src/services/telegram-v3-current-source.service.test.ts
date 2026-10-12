import test from 'node:test';
import { linkedLegacyTelegramWatchlistOwner } from './member-watchlist.service';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {validTelegramV3CurrentSource,boundedTelegramV3Json,verifiedTelegramV3PageCount,verifiedTelegramV3EpisodeKey}
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
     scannedCards:active?1:0,retainedFromBatch:active?1:0,
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
     sourceAsOf:new Date(NOW-5_000).toISOString(),
     quantEligible:true,profitEligible:true,riskReady:true,
     evidence:{source:'CANONICAL_PROFIT_EVIDENCE_READY',expectedNetEdgeR:1.2},
     validationTier:'RESEARCH_CANDIDATE',
     utilityR:1.2,utilityMode:'FULL_EXPECTED_UTILITY',leverage:null,
     provenance:{
       laneId:'US_SWING_60M',cursor:0,sourceCycleId:EPOCH,
       scannerSignalId:'signal-aapl-1',
       sourceExpiresAt:new Date(NOW+60_000).toISOString(),
       edgeSource:'CANONICAL_PROFIT_EVIDENCE_READY',
       profitEvidenceStatus:'READY',backtestQualityStatus:'verified',
       costPolicyId:'runtime-cost-v1',profitBlockers:[] as string[],
       paperIdentity:{signalId:'signal-aapl-1',strategyId:'scanner-swing-v1',
         strategyVersion:'scanner-swing-v1',parameterHash:'params-sha256:one',
         market:'US_STOCK',symbol:'AAPL',timeframe:'60m',direction:'BUY',
         costPolicyVersion:'runtime-cost-v1',researchCodeSha:SHA,
         executionAuthority:'NONE'},
     }}],
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
 assert.equal(verifiedTelegramV3PageCount(shot),1);
 const blocked=fixture();
 blocked.events.length=0;
 blocked.coverage[4].status='BLOCKED_DATA';
 blocked.coverage[4].lastGoodPreserved=true;
 blocked.coverage[4].cursorRotatedBlockedOnly=true;
 blocked.coverage[4].responseDataState='untrusted';
 blocked.coverage[4].universePartial=true;
 assert.equal(validTelegramV3CurrentSource(blocked,NOW),true,
   'the empty snapshot contract is structurally safe');
 assert.equal(verifiedTelegramV3PageCount(blocked),0,
   'structural safety must not be reported as fresh signal-source health');
});
test('mixed rescan/new-candidate and state-change V3 events do not suppress real candidate or send informational events',async()=>{
 const mixed:any=fixture();
 mixed.rows[0].ai={rescanRequested:true};
 const buy=mixed.events[0];
 mixed.events=[{
   type:'RESCAN_REQUESTED',id:buy.id,market:buy.market,symbol:buy.symbol,
   strategy:buy.strategy,timeframe:buy.timeframe,direction:buy.direction,
   state:'CANDIDATE',validationTier:buy.validationTier,
 },buy];
 assert.equal(validTelegramV3CurrentSource(mixed,NOW),true,
   'one V3 source can request a rescan and publish a new candidate together');
 const transition:any=fixture();
 transition.rows[0].reasons=[];
 transition.events=[{
   type:'STATE_CHANGED',id:buy.id,market:buy.market,symbol:buy.symbol,
   strategy:buy.strategy,timeframe:buy.timeframe,direction:buy.direction,
   state:'CANDIDATE',previousState:'NO_TRADE',reasons:[],
   validationTier:buy.validationTier,
 }];
 assert.equal(validTelegramV3CurrentSource(transition,NOW),true);
 const forged:any=structuredClone(mixed);
 forged.rows[0].ai.rescanRequested=false;
 assert.equal(validTelegramV3CurrentSource(forged,NOW),false,
   'a rescan event requires the corresponding V3 row to request a rescan');
 const unexpected:any=structuredClone(mixed);
 unexpected.events[0].type='PRIVILEGED_ORDER';
 assert.equal(validTelegramV3CurrentSource(unexpected,NOW),false);
 const inconsistent:any=structuredClone(transition);
 inconsistent.events[0].previousState='CANDIDATE';
 assert.equal(validTelegramV3CurrentSource(inconsistent,NOW),false);

 const dir=await mkdtemp(path.join(tmpdir(),'telegram-v3-mixed-'));
 const beforeUrl=process.env.SIGNAL_INTELLIGENCE_URL;
 const beforeUs=process.env.TELEGRAM_US_STOCK_CHAT_ID;
 let active=mixed,publicSends=0,personalAttempts=0;
 try{
   process.env.SIGNAL_INTELLIGENCE_URL='http://127.0.0.1:8790/v1/signals';
   process.env.TELEGRAM_US_STOCK_CHAT_ID='-10083004999999';
   const subscriber=new SignalIntelligenceTelegramSubscriber(
     new SignalIntelligenceTelegramDeliveryState(path.join(dir,'safe.json')),
     async()=>{publicSends++;return {ok:true as const,attempts:1};},
     async()=>new Response(JSON.stringify({
       ok:true,serviceSha:SHA,executionAuthority:'NONE',snapshot:active,
     }),{status:200}),
     async()=>{personalAttempts++;return {
       eligible:true,matched:1,attempted:1,delivered:0,queued:1,
       deduped:0,skipped:0,failed:0,reason:'COMPLETE' as const,
     };},
   );
   const result=await subscriber.runOnce(new Date(NOW));
   assert.equal(result.sourceStatus,'READY');
   assert.equal(result.publicDelivered,1);
   assert.equal(result.personalQueued,1);
   assert.equal(publicSends,1);
   assert.equal(personalAttempts,1);
   active=transition;
   const statusOnly=await subscriber.runOnce(new Date(NOW));
   assert.equal(statusOnly.sourceStatus,'READY');
   assert.equal(statusOnly.delivered,0);
   assert.equal(statusOnly.queued,0);
   assert.equal(publicSends,1);
   assert.equal(personalAttempts,1);
 }finally{
   if(beforeUrl===undefined)delete process.env.SIGNAL_INTELLIGENCE_URL;
   else process.env.SIGNAL_INTELLIGENCE_URL=beforeUrl;
   if(beforeUs===undefined)delete process.env.TELEGRAM_US_STOCK_CHAT_ID;
   else process.env.TELEGRAM_US_STOCK_CHAT_ID=beforeUs;
   await rm(dir,{recursive:true,force:true});
 }
});

test('personal Telegram fallback reads only owner-linked, market-consistent legacy watchlists',()=>{
 const owner='12345678-1234-1234-1234-123456789abc';
 const row={member_id:owner,device_id:'DEVICE_ONLY_MUST_NOT_GRANT_ACCESS',
   market:'KR',ticker:'005930',asset_type:'stockKR'};
 assert.equal(linkedLegacyTelegramWatchlistOwner(row,'KR_STOCK','005930'),owner);
 assert.equal(linkedLegacyTelegramWatchlistOwner({...row,member_id:null},'KR_STOCK','005930'),null);
 assert.equal(linkedLegacyTelegramWatchlistOwner({...row,member_id:''},'KR_STOCK','005930'),null);
 assert.equal(linkedLegacyTelegramWatchlistOwner({...row,member_id:'device:1'},'KR_STOCK','005930'),null);
 assert.equal(linkedLegacyTelegramWatchlistOwner({...row,market:'UNKNOWN'},'KR_STOCK','005930'),null,
   'six-digit ticker must not grant market identity when stored market is unknown');
 assert.equal(linkedLegacyTelegramWatchlistOwner({...row,market:'US'},'KR_STOCK','005930'),null);
 assert.equal(linkedLegacyTelegramWatchlistOwner({...row,asset_type:'stockUS'},'KR_STOCK','005930'),null);
 assert.equal(linkedLegacyTelegramWatchlistOwner({...row,ticker:'000660'},'KR_STOCK','005930'),null);
 assert.equal(linkedLegacyTelegramWatchlistOwner({...row,market:'US',asset_type:'stockUS',ticker:'AAPL'},
   'US_STOCK','AAPL'),owner);
 assert.equal(linkedLegacyTelegramWatchlistOwner({...row,market:'SPOT',asset_type:'cryptoSpot',ticker:'KRW-BTC'},
   'CRYPTO_SPOT','KRW-BTC'),owner);
 assert.equal(linkedLegacyTelegramWatchlistOwner({...row,market:'FUTURES',asset_type:'cryptoFutures',ticker:'BTCUSDT'},
   'CRYPTO_FUTURES','BTCUSDT'),owner);
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
 assert.equal(mutate(x=>{x.rows[0].quantEligible=false;}),false);
 assert.equal(mutate(x=>{x.rows[0].profitEligible=false;}),false);
 assert.equal(mutate(x=>{x.rows[0].riskReady=false;}),false);
 assert.equal(mutate(x=>{x.rows[0].provenance.profitEvidenceStatus='TRAIN_ONLY';}),false);
 assert.equal(mutate(x=>{x.rows[0].provenance.backtestQualityStatus='unverified';}),false);
 assert.equal(mutate(x=>{x.rows[0].provenance.edgeSource='INVENTED';}),false);
 assert.equal(mutate(x=>{x.rows[0].evidence.source='INVENTED';}),false);
 assert.equal(mutate(x=>{x.rows[0].evidence.expectedNetEdgeR=0;}),false);
 assert.equal(mutate(x=>{x.rows[0].provenance.profitBlockers.push('OOS_MISSING');}),false);
 assert.equal(mutate(x=>{Object.assign(x.rows[0].provenance,{blockedPageResearchOnly:true});}),false);
 assert.equal(mutate(x=>{Object.assign(x.rows[0].provenance,{publicationEligible:false});}),false);
 assert.equal(mutate(x=>{x.rows[0].provenance.paperIdentity.researchCodeSha='old';}),false);
 assert.equal(mutate(x=>{x.rows[0].provenance.paperIdentity.signalId='forged';}),false);
 assert.equal(mutate(x=>{x.rows[0].provenance.paperIdentity.direction='SHORT';}),false);
 assert.equal(mutate(x=>{x.rows[0].provenance.paperIdentity.costPolicyVersion='other-cost';}),false);
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
test('uncertain V3 public alert is never replayed after process restart or mislabeled delivered', async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'telegram-v3-uncertain-'));
 const ledger=path.join(dir,'signal-dedupe.json');
 const beforeUrl=process.env.SIGNAL_INTELLIGENCE_URL;
 const beforeUs=process.env.TELEGRAM_US_STOCK_CHAT_ID;
 let publicSends=0;
 const mockedFeed=async()=>new Response(JSON.stringify({
   ok:true,serviceSha:SHA,executionAuthority:'NONE',snapshot:fixture(),
 }),{status:200});
 const noMember=async()=>({
   eligible:false,matched:0,attempted:0,delivered:0,queued:0,skipped:0,failed:0,
   reason:'DISABLED' as const,
 });
 try {
   process.env.SIGNAL_INTELLIGENCE_URL='http://127.0.0.1:8790/v1/signals';
   process.env.TELEGRAM_US_STOCK_CHAT_ID='-10083004999999';
   const first=new SignalIntelligenceTelegramSubscriber(
     new SignalIntelligenceTelegramDeliveryState(ledger),
     async()=>{publicSends++;return {ok:false as const,attempts:1,
       skipped:'OUTCOME_UNCONFIRMED' as const,
       errorCode:'TELEGRAM_SEND_OUTCOME_UNCONFIRMED'};},
     mockedFeed,noMember,
   );
   const at=new Date(NOW);
   const attempt=await first.runOnce(at);
   assert.equal(attempt.sourceStatus,'READY');
   assert.equal(attempt.attempted,1);
   assert.equal(attempt.delivered,0);
   assert.equal(attempt.deduped,0);
   assert.equal(attempt.failed,1);
   assert.equal(publicSends,1);
   const stored=JSON.parse(await (await import('node:fs/promises')).readFile(ledger,'utf8'));
   assert.equal(Object.keys(stored.delivered).length,0);
   assert.equal(Object.keys(stored.unconfirmed).length,1);
   const restarted=new SignalIntelligenceTelegramSubscriber(
     new SignalIntelligenceTelegramDeliveryState(ledger),
     async()=>{publicSends++;throw Error('MUST_NOT_RESEND_AMBIGUOUS_POST');},
     mockedFeed,noMember,
   );
   const repeat=await restarted.runOnce(at);
   assert.equal(repeat.sourceStatus,'READY');
   assert.equal(repeat.attempted,0);
   assert.equal(repeat.delivered,0);
   assert.equal(repeat.deduped,0);
   assert.equal(repeat.failed,1);
   assert.equal(publicSends,1);
 }finally{
   if(beforeUrl===undefined)delete process.env.SIGNAL_INTELLIGENCE_URL;
   else process.env.SIGNAL_INTELLIGENCE_URL=beforeUrl;
   if(beforeUs===undefined)delete process.env.TELEGRAM_US_STOCK_CHAT_ID;
   else process.env.TELEGRAM_US_STOCK_CHAT_ID=beforeUs;
   await rm(dir,{recursive:true,force:true});
 }
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

test('Telegram V3 separately rejects expired candidates and fabricated page/card counts',()=>{
 const stale:any=fixture();
 stale.rows[0].provenance.sourceExpiresAt=new Date(NOW-1).toISOString();
 assert.equal(validTelegramV3CurrentSource(stale,NOW),false);
 const missing:any=fixture();
 delete missing.rows[0].provenance.sourceExpiresAt;
 assert.equal(validTelegramV3CurrentSource(missing,NOW),false);
 const clean:any=fixture();
 assert.equal(validTelegramV3CurrentSource(clean,NOW),true);
 assert.equal(validTelegramV3CurrentSource(clean,NOW+60_000),false);
 for(const change of [
   (s:any)=>{s.coverage[4].scannedCards=0;},
   (s:any)=>{s.coverage[4].retainedFromBatch=0;},
   (s:any)=>{s.coverage[4].retainedFromBatch=2;},
   (s:any)=>{s.coverage[4].scannedCards=21;},
 ]){
   const forged:any=fixture();change(forged);
   assert.equal(validTelegramV3CurrentSource(forged,NOW),false);
 }
});

test('stable source-day episode identity is independent of release SHA and duplicate polls',()=>{
 const s:any=fixture();
 const key=verifiedTelegramV3EpisodeKey(s.rows[0],NOW);
 assert.match(key??'',/^signal-intelligence-v3:episode-v2:[0-9a-f]{64}$/u);
 assert.equal(verifiedTelegramV3EpisodeKey(s.rows[0],NOW+1000),key);
 s.serviceSha='b'.repeat(40);
 assert.equal(verifiedTelegramV3EpisodeKey(s.rows[0],NOW),key);
 s.rows[0].sourceAsOf=new Date(NOW+24*60*60_000).toISOString();
 s.rows[0].provenance.sourceExpiresAt=new Date(NOW+24*60*60_000+60_000).toISOString();
 const newKey=verifiedTelegramV3EpisodeKey(s.rows[0],NOW+24*60*60_000);
 assert.notEqual(newKey,key,'a genuinely later source day is not suppressed for 14 days');
 s.rows[0].sourceAsOf='2026-02-30T00:00:00.000Z';
 assert.equal(verifiedTelegramV3EpisodeKey(s.rows[0],NOW+24*60*60_000),null);
 const missing:any=fixture();
 delete missing.rows[0].sourceAsOf;
 assert.equal(validTelegramV3CurrentSource(missing,NOW),false);
});

test('Telegram new daily opportunity is delivered once per source day, even after SHA rotation',async()=>{
 const folder=await mkdtemp(path.join(tmpdir(),'v3-episode-'));
 const originalUrl=process.env.SIGNAL_INTELLIGENCE_URL;
 const originalRoom=process.env.TELEGRAM_US_STOCK_CHAT_ID;
 const day=24*60*60_000;
 let active:any=fixture();
 let sends=0,personals:string[]=[];
 try {
   process.env.SIGNAL_INTELLIGENCE_URL='http://127.0.0.1:8790/v1/signals';
   process.env.TELEGRAM_US_STOCK_CHAT_ID='-10083004999999';
   const subscriber=new SignalIntelligenceTelegramSubscriber(
     new SignalIntelligenceTelegramDeliveryState(path.join(folder,'ledger.json')),
     async()=>{sends++;return {ok:true as const,attempts:1};},
     async()=>new Response(JSON.stringify({ok:true,serviceSha:active.serviceSha,
       executionAuthority:'NONE',snapshot:active}),{status:200}),
     async(event)=>{personals.push(event.occurrenceKey??'');return {
       eligible:true,matched:1,attempted:1,delivered:0,queued:1,
       deduped:0,skipped:0,failed:0,reason:'COMPLETE' as const,
     };},
   );
   let first=await subscriber.runOnce(new Date(NOW));
   assert.equal(first.sourceStatus,'READY');assert.equal(first.publicDelivered,1);
   let replay=await subscriber.runOnce(new Date(NOW+1000));
   assert.equal(replay.publicDelivered,0);assert.equal(replay.deduped,1);
   assert.equal(sends,1);
   active=fixture();active.serviceSha='b'.repeat(40);
   active.generatedAt=new Date(NOW+day-2000).toISOString();
   active.rows[0].sourceAsOf=new Date(NOW+day-5000).toISOString();
   active.rows[0].provenance.sourceExpiresAt=new Date(NOW+day+60_000).toISOString();
   let second=await subscriber.runOnce(new Date(NOW+day));
   assert.equal(second.sourceStatus,'READY');assert.equal(second.publicDelivered,1);
   assert.equal(sends,2);
   await subscriber.runOnce(new Date(NOW+day+1000));
   assert.equal(sends,2);
   assert.equal(personals[0],personals[1],'a retry has the same personal event identity');
   assert.notEqual(personals[1],personals[2],'a later source-day alert gets a new personal identity');
 } finally {
   if(originalUrl===undefined) delete process.env.SIGNAL_INTELLIGENCE_URL;
   else process.env.SIGNAL_INTELLIGENCE_URL=originalUrl;
   if(originalRoom===undefined) delete process.env.TELEGRAM_US_STOCK_CHAT_ID;
   else process.env.TELEGRAM_US_STOCK_CHAT_ID=originalRoom;
   await rm(folder,{recursive:true,force:true});
 }
});

test('legacy sent V3 candidate is not replayed across code-release dedupe migration',async()=>{
 const folder=await mkdtemp(path.join(tmpdir(),'v3-legacy-rollout-'));
 const oldUrl=process.env.SIGNAL_INTELLIGENCE_URL;
 let publicSends=0,personalSends=0;
 try{
   process.env.SIGNAL_INTELLIGENCE_URL='http://127.0.0.1:8790/v1/signals';
   const state=new SignalIntelligenceTelegramDeliveryState(path.join(folder,'ledger.json'));
   const oldKey='signal-intelligence-v3:'+'a'.repeat(40)
      +':NEW_CANDIDATE:'+ID+'::CANDIDATE';
   await state.mark(oldKey,new Date(NOW-1_000));
   const s:any=fixture();s.serviceSha='b'.repeat(40);
   const subscriber=new SignalIntelligenceTelegramSubscriber(state,
     async()=>{publicSends++;return {ok:true as const,attempts:1};},
     async()=>new Response(JSON.stringify({ok:true,serviceSha:s.serviceSha,
       executionAuthority:'NONE',snapshot:s}),{status:200}),
     async()=>{personalSends++;return {eligible:true,matched:1,attempted:1,
       delivered:0,queued:1,deduped:0,skipped:0,failed:0,reason:'COMPLETE' as const};});
   const r=await subscriber.runOnce(new Date(NOW));
   assert.equal(r.sourceStatus,'READY');
   assert.equal(r.deduped,1);
   assert.equal(publicSends,0);assert.equal(personalSends,0);
 } finally {
   if(oldUrl===undefined)delete process.env.SIGNAL_INTELLIGENCE_URL;
   else process.env.SIGNAL_INTELLIGENCE_URL=oldUrl;
   await rm(folder,{recursive:true,force:true});
 }
});

test('Telegram subscriber writes crash-safe reservation before a mocked public send',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'v3-before-post-'));
 const ledger=path.join(dir,'ledger.json');
 const beforeUrl=process.env.SIGNAL_INTELLIGENCE_URL;
 const beforeRoom=process.env.TELEGRAM_US_STOCK_CHAT_ID;
 const source:any=fixture();
 let sends=0,configured=false;
 try{
   process.env.SIGNAL_INTELLIGENCE_URL='http://127.0.0.1:8790/v1/signals';
   process.env.TELEGRAM_US_STOCK_CHAT_ID='-10083004999999';
   const subscriber=new SignalIntelligenceTelegramSubscriber(
     new SignalIntelligenceTelegramDeliveryState(ledger),
     async alert=>{
       if(!configured)return {ok:false as const,attempts:0,skipped:'NOT_CONFIGURED' as const};
       const onDisk=JSON.parse(await readFile(ledger,'utf8'));
       const dedupeKey=alert.dedupeKey;
       if(!dedupeKey)throw Error('V3_TEST_DEDUPE_KEY_REQUIRED');
       assert.ok(onDisk.unconfirmed[dedupeKey],
         'unknown outcome must be DURABLE before any Bot API POST');
       sends+=1;
       return {ok:true as const,attempts:1};
     },
     async()=>new Response(JSON.stringify({ok:true,serviceSha:source.serviceSha,
       executionAuthority:'NONE',snapshot:source}),{status:200}),
     async()=>({eligible:false,matched:0,attempted:0,delivered:0,queued:0,
       deduped:0,skipped:0,failed:0,reason:'DISABLED' as const}),
   );
   const noSend=await subscriber.runOnce(new Date(NOW));
   assert.equal(noSend.skipped,1);
   assert.equal(sends,0);
   const unreserved=JSON.parse(await readFile(ledger,'utf8'));
   assert.equal(Object.keys(unreserved.unconfirmed).length,0,
     'a definitive locally skipped request is safe to retry');
   configured=true;
   const first=await subscriber.runOnce(new Date(NOW));
   assert.equal(first.publicDelivered,1);assert.equal(sends,1);
   const confirmed=JSON.parse(await readFile(ledger,'utf8'));
   assert.equal(Object.keys(confirmed.delivered).length,1);
   assert.equal(Object.keys(confirmed.unconfirmed).length,0);
   const repeat=await subscriber.runOnce(new Date(NOW+1000));
   assert.equal(repeat.deduped,1);assert.equal(sends,1);
 }finally{
   if(beforeUrl===undefined)delete process.env.SIGNAL_INTELLIGENCE_URL;
   else process.env.SIGNAL_INTELLIGENCE_URL=beforeUrl;
   if(beforeRoom===undefined)delete process.env.TELEGRAM_US_STOCK_CHAT_ID;
   else process.env.TELEGRAM_US_STOCK_CHAT_ID=beforeRoom;
   await rm(dir,{recursive:true,force:true});
 }
});

test('unexpected Telegram POST interruption leaves a restart-proof no-replay tombstone',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'v3-post-interrupt-'));
 const ledger=path.join(dir,'ledger.json');
 const oldUrl=process.env.SIGNAL_INTELLIGENCE_URL;
 const oldRoom=process.env.TELEGRAM_US_STOCK_CHAT_ID;
 const source:any=fixture();
 let sends=0;
 try{
   process.env.SIGNAL_INTELLIGENCE_URL='http://127.0.0.1:8790/v1/signals';
   process.env.TELEGRAM_US_STOCK_CHAT_ID='-10083004999999';
   const feed=async()=>new Response(JSON.stringify({ok:true,serviceSha:source.serviceSha,
     executionAuthority:'NONE',snapshot:source}),{status:200});
   const noMember=async()=>({eligible:false,matched:0,attempted:0,delivered:0,
     queued:0,deduped:0,skipped:0,failed:0,reason:'DISABLED' as const});
   const first=new SignalIntelligenceTelegramSubscriber(
     new SignalIntelligenceTelegramDeliveryState(ledger),
     async()=>{sends++;throw Error('simulated interruption after POST');},
     feed,noMember);
   const failure=await first.runOnce(new Date(NOW));
   assert.equal(failure.sourceStatus,'PROCESSING_FAILED');
   assert.equal(sends,1);
   assert.equal(Object.keys(JSON.parse(await readFile(ledger,'utf8')).unconfirmed).length,1);
   const restarted=new SignalIntelligenceTelegramSubscriber(
     new SignalIntelligenceTelegramDeliveryState(ledger),
     async()=>{sends++;return {ok:true as const,attempts:1};},
     feed,noMember);
   const replay=await restarted.runOnce(new Date(NOW+1000));
   assert.equal(replay.sourceStatus,'READY');
   assert.equal(replay.failed,1);
   assert.equal(sends,1,'restart cannot send again after interrupted POST');
 }finally{
   if(oldUrl===undefined)delete process.env.SIGNAL_INTELLIGENCE_URL;
   else process.env.SIGNAL_INTELLIGENCE_URL=oldUrl;
   if(oldRoom===undefined)delete process.env.TELEGRAM_US_STOCK_CHAT_ID;
   else process.env.TELEGRAM_US_STOCK_CHAT_ID=oldRoom;
   await rm(dir,{recursive:true,force:true});
 }
});

test('new independent day after confirmed legacy v1 send is not silenced by SHA migration',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'v3-legacy-next-day-'));
 const oldUrl=process.env.SIGNAL_INTELLIGENCE_URL;
 const oldRoom=process.env.TELEGRAM_US_STOCK_CHAT_ID;
 const source:any=fixture(),day=24*60*60_000;
 let sends=0;
 try{
   process.env.SIGNAL_INTELLIGENCE_URL='http://127.0.0.1:8790/v1/signals';
   process.env.TELEGRAM_US_STOCK_CHAT_ID='-10083004999999';
   const state=new SignalIntelligenceTelegramDeliveryState(path.join(dir,'ledger.json'));
   const legacy='signal-intelligence-v3:'+'a'.repeat(40)
      +':NEW_CANDIDATE:'+ID+'::CANDIDATE';
   await state.mark(legacy,new Date(NOW-1000));
   source.serviceSha='b'.repeat(40);
   source.generatedAt=new Date(NOW+day-2000).toISOString();
   source.rows[0].sourceAsOf=new Date(NOW+day-5000).toISOString();
   source.rows[0].provenance.sourceExpiresAt=new Date(NOW+day+60_000).toISOString();
   const subscriber=new SignalIntelligenceTelegramSubscriber(
     state,
     async()=>{sends++;return {ok:true as const,attempts:1};},
     async()=>new Response(JSON.stringify({ok:true,serviceSha:source.serviceSha,
       executionAuthority:'NONE',snapshot:source}),{status:200}),
     async()=>({eligible:false,matched:0,attempted:0,delivered:0,queued:0,
       deduped:0,skipped:0,failed:0,reason:'DISABLED' as const}));
   const result=await subscriber.runOnce(new Date(NOW+day));
   assert.equal(result.publicDelivered,1);
   assert.equal(sends,1);
 }finally{
   if(oldUrl===undefined)delete process.env.SIGNAL_INTELLIGENCE_URL;
   else process.env.SIGNAL_INTELLIGENCE_URL=oldUrl;
   if(oldRoom===undefined)delete process.env.TELEGRAM_US_STOCK_CHAT_ID;
   else process.env.TELEGRAM_US_STOCK_CHAT_ID=oldRoom;
   await rm(dir,{recursive:true,force:true});
 }
});
