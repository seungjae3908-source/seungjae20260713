import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {
 sanitizePm2Snapshot,classifyTelegramHandoff,observeTelegramHandoff,
} from '../../ops/telegram-cutover-readonly.mjs';
const SHA='a'.repeat(40);
const pm2Row=(owner='embedded')=>[{
 name:'stock-app',pid:8210,pm2_env:{
  status:'online',pm_cwd:'/opt/stock-app',
  pm_exec_path:'/opt/stock-app/api-server/dist/index.mjs',
  DEPLOY_SHA:SHA,pm_uptime:100000,restart_time:0,
  TELEGRAM_WORKER_OWNER:owner,LIVE_TRADING:'true',
  FUTURES_LIVE_EXECUTION_AUTHORITY:'ISOLATED',
  TELEGRAM_BOT_TOKEN:'PRIVATE_TOKEN_NEVER_LOG',
  TELEGRAM_KR_STOCK_CHAT_ID:'PRIVATE_ROOM_NEVER_LOG',
 }
}];
const health=(now=Date.now())=>({
 ok:true,service:'api-server',route:'/api/health',
 identityMatch:true,identityStatus:'match',deploySha:SHA,
 processDeploySha:SHA,deployMarkerSha:SHA,
 backgroundWorkersEnabled:true,telegramWorkerOwner:'isolated',
 time:new Date(now).toISOString(),
 userTelegramDelivery:{enabled:false,lastTickAt:null,tickOk:null,deliveryConfirmed:false},
 telegramIntelligenceWorker:{enabled:false,state:'NOT_STARTED',lastTickAt:null},
 signalTelegramSubscriber:{state:'NOT_STARTED',inFlight:0,lastSourceStatus:null},
 telegramAiWatch:{state:'NOT_STARTED',inFlight:0},
});
test('historical embedded Telegram app is always NO-GO without shutting trading off',()=>{
 const now=Date.now(),p=sanitizePm2Snapshot(pm2Row(),'a'.repeat(40)+'\n');
 const r=classifyTelegramHandoff({mainSha:SHA,first:p,second:p,
  firstHealth:health(now),secondHealth:health(now),nowMs:now});
 assert.equal(r.classification,'LEGACY_EMBEDDED_SENDER_ACTIVE');
 assert.equal(r.manualFinancialAuthorityObserved,true);
 assert.equal(r.fourLanesQuiesced,false);
 assert.equal(r.activationReady,false);
 assert.equal(r.telegramSends,0);
 assert.equal(r.pm2Restarts,0);
 assert.ok(!JSON.stringify(r).includes('PRIVATE_TOKEN_NEVER_LOG'));
 assert.ok(!JSON.stringify(r).includes('PRIVATE_ROOM_NEVER_LOG'));
});
test('only same-process two-pass all four lanes stopped yields quiescence proof, not activation',()=>{
 const now=Date.now(),p=sanitizePm2Snapshot(pm2Row('isolated'),SHA+'\n');
 const r=classifyTelegramHandoff({mainSha:SHA,first:p,second:{...p},firstHealth:health(now),
  secondHealth:health(now),nowMs:now});
 assert.equal(r.classification,'FOUR_LANES_QUIESCED_ONLY');
 assert.equal(r.fourLanesQuiesced,true);
 assert.equal(r.stableProcess,true);
 assert.equal(r.activationReady,false);
 assert.equal(r.manualFinancialAuthorityObserved,true);
});
test('missing health fields, in-flight work and unexpected owner must fail closed',()=>{
 const now=Date.now(),p=sanitizePm2Snapshot(pm2Row('isolated'),SHA+'\n');
 const edits=[
  h=>{h.telegramWorkerOwner=undefined;},
  h=>{h.backgroundWorkersEnabled=false;},
  h=>{h.signalTelegramSubscriber.inFlight=1;},
  h=>{h.telegramAiWatch.inFlight=1;},
  h=>{h.telegramIntelligenceWorker.state='RUNNING';},
  h=>{h.userTelegramDelivery.enabled=true;},
  h=>{h.userTelegramDelivery.tickOk=true;},
  h=>{h.processDeploySha='b'.repeat(40);},
  h=>{h.time=new Date(now-35000).toISOString();},
 ];
 for(const edit of edits){
  const h=health(now);edit(h);
  const r=classifyTelegramHandoff({mainSha:SHA,first:p,second:p,
    firstHealth:h,secondHealth:health(now),nowMs:now});
  assert.equal(r.activationReady,false);
  assert.equal(r.fourLanesQuiesced,false);
  assert.notEqual(r.classification,'FOUR_LANES_QUIESCED_ONLY');
 }
});
test('PM2 restart, stale marker, duplicate, stopped, wrong entry point veto',()=>{
 const now=Date.now(),p=sanitizePm2Snapshot(pm2Row('isolated'),SHA+'\n');
 const changed={...p,pid:p.pid+1};
 assert.equal(classifyTelegramHandoff({mainSha:SHA,first:p,second:changed,
  firstHealth:health(now),secondHealth:health(now),nowMs:now}).classification,
   'PM2_PROCESS_CHANGED');
 for(const rows of [
  [...pm2Row('isolated'),...pm2Row('isolated')],
  pm2Row('isolated').map(x=>({...x,pm2_env:{...x.pm2_env,status:'stopped'}})),
  pm2Row('isolated').map(x=>({...x,pm2_env:{...x.pm2_env,pm_cwd:'/tmp/bad'}})),
 ])assert.equal(sanitizePm2Snapshot(rows,SHA+'\n').valid,false);
 assert.equal(sanitizePm2Snapshot(pm2Row('isolated'),'b'.repeat(40)).valid,false);
});
test('two distinct real observations are required, no operation is emitted',async()=>{
 const now=Date.now();
 let pm=0,ht=0,delays=0;
 const p=sanitizePm2Snapshot(pm2Row('isolated'),SHA);
 const out=await observeTelegramHandoff({mainSha:SHA,
  readPm2Impl:async()=>{pm++;return p;},
  readHealthImpl:async()=>{ht++;return health(now);},
  delayImpl:async ms=>{assert.equal(ms,1100);delays++;},
  nowImpl:()=>now,
 });
 assert.equal(out.classification,'FOUR_LANES_QUIESCED_ONLY');
 assert.deepEqual([pm,ht,delays],[2,2,1]);
 assert.equal(out.databaseWrites,0);
 assert.equal(out.financialMutations,0);
 assert.equal(out.privateValuesRecorded,false);
});
test('new observer contains zero Telegram Bot API, PM2 mutations and private outflow',()=>{
 const src=fs.readFileSync('ops/telegram-cutover-readonly.mjs','utf8');
 for(const banned of ['api.telegram.org','sendMessage(', 'pm2 restart','pm2 stop',
  'pm2 reload','pm2 delete','psql ','pg_dump',
  'LIVE_TRADING=false','AUTO_TRADING=false','fetch('])
   assert.equal(src.includes(banned),false,banned);
});
