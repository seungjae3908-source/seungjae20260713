import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import {inspectLegacyTelegramQuiescence} from '../../ops/telegram-legacy-owner-runtime-proof.mjs';
const sha='a'.repeat(40);
const timestamp = new Date();
const now=timestamp.getTime();
const make=()=>({
 ok:true, service:'api-server', identityMatch:true, identityStatus:'match',
 deploySha:sha, processDeploySha:sha, deployMarkerSha:sha,
 time: timestamp.toISOString(), backgroundWorkersEnabled:true,
 telegramWorkerOwner:'isolated',
 userTelegramDelivery:{enabled:false,lastTickAt:null,tickOk:null,deliveryConfirmed:false},
 telegramIntelligenceWorker:{enabled:false,state:'NOT_STARTED',lastTickAt:null},
 signalTelegramSubscriber:{state:'NOT_STARTED',inFlight:0,lastSourceStatus:null},
 telegramAiWatch:{state:'NOT_STARTED',inFlight:0},
 autoTradingBackground:{enabled:true},
});
test('only actual same-process current three-lane shutdown passes',()=>{
 assert.deepEqual(inspectLegacyTelegramQuiescence(make(),sha,now),
 {ok:true,code:'TELEGRAM_LEGACY_THREE_LANES_QUIESCED'});
 const data=make();data.userTelegramDelivery.enabled=true;
 assert.equal(inspectLegacyTelegramQuiescence(data,sha,now).ok,false);
});
test('old runtime, missing subscriber status, in-flight sends and stale readback veto cutover',()=>{
 for(const mutate of [
  x=>{x.signalTelegramSubscriber=undefined},
  x=>{x.signalTelegramSubscriber.inFlight=1},
  x=>{x.signalTelegramSubscriber.state='STOPPING'},
  x=>{x.telegramWorkerOwner='embedded'},
  x=>{x.telegramAiWatch=undefined},
  x=>{x.telegramAiWatch.inFlight=1},
  x=>{x.telegramAiWatch.state='RUNNING'},
  x=>{x.backgroundWorkersEnabled=false},
  x=>{x.telegramIntelligenceWorker.state='DISABLED'},
  x=>{x.telegramIntelligenceWorker.state='RUNNING'},
  x=>{x.userTelegramDelivery.lastTickAt=timestamp.toISOString()},
  x=>{x.userTelegramDelivery.deliveryConfirmed=true},
  x=>{x.userTelegramDelivery.tickOk=true},
  x=>{x.processDeploySha='b'.repeat(40)},
  x=>{x.deployMarkerSha='b'.repeat(40)},
  x=>{x.identityMatch=false},
  x=>{x.time=new Date(now-30000).toISOString()},
  x=>{x.time=new Date(now+10000).toISOString()},
 ]) {const x=make();mutate(x);
  assert.equal(inspectLegacyTelegramQuiescence(x,sha,now).ok,false);}
});
test('CLI refuses malformed stdout and leaks no private health contents',()=>{
 const script='ops/telegram-legacy-owner-runtime-proof.mjs';
 const p=spawnSync(process.execPath,[script,sha],{
 input:JSON.stringify({...make(),secret:'CANARY_SECRET_DO_NOT_ECHO',
  signalTelegramSubscriber:{state:'RUNNING',inFlight:1}}),encoding:'utf8'});
 assert.equal(p.status,17);
 assert.match(p.stderr,/TELEGRAM_LEGACY_RUNTIME_NOT_QUIESCED/u);
 assert.doesNotMatch(p.stderr+p.stdout,/CANARY_SECRET_DO_NOT_ECHO/u);
 const valid=spawnSync(process.execPath,[script,sha],{input:JSON.stringify(make()),encoding:'utf8'});
 assert.equal(valid.status,0);
 assert.match(valid.stdout,/TELEGRAM_LEGACY_THREE_LANES_QUIESCED/u);
});
test('standalone runner only accepts bounded loopback GET and shared production deployment lock',()=>{
 const source=fs.readFileSync('ops/run-telegram-isolated-worker.sh','utf8');
 assert.match(source,/flock -n 8/u);
 assert.match(source,/\/var\/lock\/stock-app-deploy\.lock/u);
 assert.match(source,/telegram-legacy-owner-runtime-proof\.mjs/u);
 assert.equal((source.match(/legacy_health_inactive/g)??[]).length,3);
 assert.match(source,/127\.0\.0\.1/u);
 assert.match(source,/TELEGRAM_WORKER_OWNER/u);
 assert.doesNotMatch(source,/pm2 (?:restart|reload|stop|delete)/u);
 assert.doesNotMatch(source,/curl[^\n]+(?:-X|--data|--request)\s*(?:POST|PUT|PATCH|DELETE)/iu);
});
