import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  inspectDeliveryStateText, readStateFile, observeProductionTelegram,
  safeSha, readHealthOnce, readSignalSourceOnce,
  canonicalPm2Paths, resolveSafeTelegramStatePath,
} from '../../ops/telegram-production-worker-readonly-audit.mjs';
import { EventEmitter } from 'node:events';

const current='a'.repeat(40);
const deployed='b'.repeat(40);
const now=Date.parse('2026-10-11T00:00:00.000Z');
const roomId='-10012345678901';
const marketKey='telegram-intelligence:MORNING:2026-10-11:KR_STOCK_ROOM:'+roomId;
const signalKey='signal-intelligence-v3:PRIVATE_MEMBER_SIGNAL_IDENTIFIER';
const state=(entries)=>JSON.stringify({version:1,delivered:entries});
const rooms={
  TELEGRAM_KR_STOCK_CHAT_ID:'-10012345678901',
  TELEGRAM_US_STOCK_CHAT_ID:'-10012345678902',
  TELEGRAM_CRYPTO_SPOT_CHAT_ID:'-10012345678903',
  TELEGRAM_CRYPTO_FUTURES_CHAT_ID:'-10012345678904',
  TELEGRAM_PERSONAL_HOLDINGS_CHAT_ID:'-10012345678905',
  TELEGRAM_AUTO_TRADING_CHAT_ID:'-10012345678906',
};
const runtime={
  ...rooms,
  TELEGRAM_INTELLIGENCE_WORKER_ENABLED:'true',
  PERSONAL_TELEGRAM_WORKER_ENABLED:'true',
  LIVE_TELEGRAM_ACTIVATION_APPROVED:'true',
  BACKGROUND_WORKERS_ENABLED:'true',
  TELEGRAM_BOT_TOKEN:'NEVER_LOG_PRIVATE_BOT_TOKEN',
};
const observed=()=>({
  runtime,pm2Sha:deployed,markerSha:deployed,online:true,
  canonicalCwd:true,canonicalEntrypoint:true,
});
const health=async()=>({
  nodeSha:deployed,markerSha:deployed,identityMatch:true,
  enabled:true,tickOk:false,lastTickAt:new Date(now-30_000).toISOString(),
  deliveryConfirmed:false,lastConfirmedDeliveryAt:null,
  errorCode:'TELEGRAM_DELIVERY_UNCONFIRMED',
});

test('valid immutable SHAs only',()=>{
  assert.equal(safeSha('a'.repeat(40)), current);
  assert.equal(safeSha('invalid'), null);
  assert.equal(safeSha('A'.repeat(40)), current);
});

test('PM2 canonical root and entrypoint agree with Production deploy; default ledgers use PM2 cwd',()=>{
  const canonical=canonicalPm2Paths({
    pm_cwd:'/opt/stock-app',
    pm_exec_path:'/opt/stock-app/api-server/dist/index.mjs',
  });
  assert.deepEqual(canonical,{canonicalCwd:true,canonicalEntrypoint:true});
  assert.deepEqual(canonicalPm2Paths({
    pm_cwd:'/opt/stock-app/api-server',
    pm_exec_path:'/opt/stock-app/api-server/dist/index.mjs',
  }),{canonicalCwd:false,canonicalEntrypoint:true});
  assert.deepEqual(canonicalPm2Paths({
    pm_cwd:'/opt/stock-app',pm_exec_path:'/tmp/unapproved.js',
  }),{canonicalCwd:true,canonicalEntrypoint:false});
  assert.equal(resolveSafeTelegramStatePath(null,'telegram-intelligence-delivery-state.json'),
    '/opt/stock-app/.runtime/telegram-intelligence-delivery-state.json');
  assert.equal(resolveSafeTelegramStatePath('','signal-intelligence-telegram-state.json'),
    '/opt/stock-app/.runtime/signal-intelligence-telegram-state.json');
  assert.equal(resolveSafeTelegramStatePath('/opt/stock-app-data/telegram-ledger.json','unused.json'),
    '/opt/stock-app-data/telegram-ledger.json');
  assert.equal(resolveSafeTelegramStatePath('/opt/stock-app/api-server/.runtime/old-ledger.json','unused.json'),
    '/opt/stock-app/api-server/.runtime/old-ledger.json');
  assert.equal(resolveSafeTelegramStatePath('/opt/stock-app/.env','unused.json'),null);
  assert.equal(resolveSafeTelegramStatePath('/opt/stock-app/api-server/.env','unused.json'),null);
  assert.equal(resolveSafeTelegramStatePath('/etc/passwd','unused.json'),null);
});

test('market and signal ledgers emit only fixed labels/counts and never IDs',()=>{
  const market=inspectDeliveryStateText(state({
    [marketKey]:new Date(now-120_000).toISOString(),
    ['telegram-intelligence:WEEKLY:2026-10-07:US_STOCK_ROOM:'+roomId]:new Date(now-4*86400000).toISOString(),
    ['unexpected:'+roomId]:'2026-10-11T00:00:00Z',
  }),'market',now);
  assert.equal(market.status,'PRESENT');
  assert.equal(market.recordCount,2);
  assert.equal(market.recent24hCount,1);
  assert.equal(market.briefKinds.MORNING,1);
  assert.equal(market.briefKinds.WEEKLY,1);
  assert.ok(!JSON.stringify(market).includes(roomId));
  const signal=inspectDeliveryStateText(state({
    [signalKey]:new Date(now-90000).toISOString(),
  }),'signal',now);
  assert.equal(signal.recordCount,1);
  assert.equal(signal.recent24hCount,1);
  assert.ok(!JSON.stringify(signal).includes('PRIVATE_MEMBER_SIGNAL_IDENTIFIER'));
});

test('ledger parser fails closed on empty/malformed/future and bounded entries',()=>{
  assert.equal(inspectDeliveryStateText('{bad','market',now).status,'INVALID');
  assert.equal(inspectDeliveryStateText('{"version":2,"delivered":{}}','market',now).status,'INVALID');
  assert.equal(inspectDeliveryStateText(state({}),'market',now).status,'EMPTY');
  assert.equal(inspectDeliveryStateText(state({
    [marketKey]:new Date(now+10000).toISOString(),
  }),'market',now).status,'NO_VALID_RECEIPTS');
  assert.equal(inspectDeliveryStateText('x'.repeat(1_048_577),'market',now).status,'INVALID');
  assert.equal(readStateFile('/etc/passwd','ignored.json','market',now).status,'UNSAFE_PATH');
});

test('real PM2 flags and recent personal tick are observed without false delivery PASS',async()=>{
  const result=await observeProductionTelegram({
    mainSha:current,deployedSha:deployed,nowMs:now,
    snapshot:observed,health,
    signalSource:async()=>({status:'READY',eventCount:0,safetyValidated:true}),
    state:(_configured,_file,type)=>type==='market'
      ? inspectDeliveryStateText(state({[marketKey]:new Date(now-3000).toISOString()}),'market',now)
      : inspectDeliveryStateText(state({}),'signal',now),
  });
  assert.equal(result.classification,'READ_ONLY_OBSERVATION_COMPLETE');
  assert.equal(result.personal.tickFresh,true);
  assert.equal(result.personal.deliveryConfirmed,false);
  assert.equal(result.personal.tickOk,false);
  assert.equal(result.proofLevel,'PERSISTED_LEDGER_ONLY');
  assert.equal(result.marketBrief.recordCount,1);
  assert.equal(result.signalSource.status,'READY');
  assert.equal(result.telegramSends,0);
  assert.equal(result.pm2Restarts,0);
  assert.equal(result.databaseWrites,0);
  assert.equal(result.financialMutations,0);
  assert.equal(result.secretValuesRecorded,false);
  const json=JSON.stringify(result);
  assert.ok(!json.includes(roomId));
  assert.ok(!json.includes(runtime.TELEGRAM_BOT_TOKEN));
});

test('disabled market, duplicated room, stale production SHA and missing health fail closed',async()=>{
  const testCase=async changes=>observeProductionTelegram({
    mainSha:current,deployedSha:deployed,nowMs:now,
    snapshot:()=>({...observed(),...changes}),
    health,
    signalSource:async()=>({status:'READY',eventCount:0,safetyValidated:true}),
    state:()=>inspectDeliveryStateText(state({}),'market',now),
  });
  assert.equal((await testCase({pm2Sha:current})).classification,'PRODUCTION_SHA_MISMATCH');
  assert.equal((await testCase({online:false})).classification,'PM2_NOT_ONLINE');
  assert.equal((await testCase({canonicalCwd:false})).classification,'PM2_CWD_MISMATCH');
  assert.equal((await testCase({canonicalEntrypoint:false})).classification,'PM2_ENTRYPOINT_MISMATCH');
  const duplicates={...runtime, TELEGRAM_US_STOCK_CHAT_ID:runtime.TELEGRAM_KR_STOCK_CHAT_ID};
  assert.equal((await testCase({runtime:duplicates})).classification,'TELEGRAM_CONFIGURATION_BLOCKED');
  assert.equal((await testCase({runtime:{...runtime,BACKGROUND_WORKERS_ENABLED:'false'}})).classification,'TELEGRAM_CONFIGURATION_BLOCKED');
  assert.equal((await observeProductionTelegram({
    mainSha:current,deployedSha:deployed,nowMs:now,
    snapshot:observed,health:async()=>null,
  })).classification,'HEALTH_UNAVAILABLE');
});

test('loopback health response is restricted to trusted booleans/codes; extra sensitive data dropped',async()=>{
  const getImpl=(url,options,respond)=>{
    assert.equal(url,'http://127.0.0.1:8080/api/health');
    assert.equal(options.timeout,5000);
    const req=new EventEmitter();
    req.destroy=()=>{};
    queueMicrotask(()=>{
      const response=new EventEmitter();
      response.statusCode=200;
      respond(response);
      response.emit('data', Buffer.from(JSON.stringify({
        ok:true,service:'api-server',route:'/api/health',
        processDeploySha:deployed,deployMarkerSha:deployed,identityMatch:true,
        privateUserData:'NEVER_PUBLISH_PRIVATE_USER_DATA',
        userTelegramDelivery:{
          enabled:true,tickOk:false,deliveryConfirmed:false,
          lastTickAt:new Date(now).toISOString(),
          lastConfirmedDeliveryAt:'PRIVATE_SECRET_IN_TIME_FIELD',errorCode:'TELEGRAM_DELIVERY_UNCONFIRMED',
          chatId:'DO_NOT_LOG_CHAT_ID',
        },
      })));
      response.emit('end');
    });
    return req;
  };
  const r=await readHealthOnce({getImpl});
  assert.equal(r.nodeSha,deployed);
  assert.equal(r.deliveryConfirmed,false);
  assert.equal(r.lastConfirmedDeliveryAt,null);
  const printed=JSON.stringify(r);
  assert.ok(!printed.includes('PRIVATE_USER_DATA'));
  assert.ok(!printed.includes('DO_NOT_LOG_CHAT_ID'));
  assert.ok(!printed.includes('PRIVATE_SECRET_IN_TIME_FIELD'));
});

test('production receipt rejects non-ISO personal time and preserves only valid UTC evidence',async()=>{
  const bad=await observeProductionTelegram({
    mainSha:current,deployedSha:deployed,nowMs:now,
    snapshot:observed,
    health:async()=>({...await health(),deliveryConfirmed:true,
      lastConfirmedDeliveryAt:'PRIVATE_SECRET_MASQUERADING_AS_DATE'}),
    signalSource:async()=>({status:'NOT_CHECKED',eventCount:0,safetyValidated:false}),
    state:()=>inspectDeliveryStateText(state({}),'market',now),
  });
  assert.equal(bad.personal.deliveryConfirmed,false);
  assert.equal(bad.personal.lastConfirmedDeliveryAt,null);
  assert.ok(!JSON.stringify(bad).includes('PRIVATE_SECRET_MASQUERADING_AS_DATE'));
  const validTimestamp=new Date(now-60_000).toISOString();
  const good=await observeProductionTelegram({
    mainSha:current,deployedSha:deployed,nowMs:now,
    snapshot:observed,
    health:async()=>({...await health(),deliveryConfirmed:true,
      lastConfirmedDeliveryAt:validTimestamp}),
    signalSource:async()=>({status:'NOT_CHECKED',eventCount:0,safetyValidated:false}),
    state:()=>inspectDeliveryStateText(state({}),'market',now),
  });
  assert.equal(good.personal.deliveryConfirmed,true);
  assert.equal(good.personal.lastConfirmedDeliveryAt,validTimestamp);
});


test('signal source probe accepts only loopback safe GET and emits counts, never event payloads', async()=>{
  const getImpl=(url, options, callback)=>{
    assert.equal(url.hostname,'127.0.0.1');
    assert.equal(url.pathname,'/v1/signals');
    assert.equal(options.method,'GET');
    const req=new EventEmitter();
    req.destroy=()=>{};
    queueMicrotask(()=>{
      const response=new EventEmitter();
      response.statusCode=200;
      callback(response);
      const payload={
        ok:true,executionAuthority:'NONE',serviceSha:deployed,
        snapshot:{
          serviceSha:deployed,
          safety:{executionAuthority:'NONE',privateTradingApiAllowed:false,realOrderAllowed:false},
          events:[{id:'NEVER_LOG_SIGNAL_ID',symbol:'NEVER_LOG_SYMBOL',market:'US_STOCK'}],
        }
      };
      response.emit('data',Buffer.from(JSON.stringify(payload)));
      response.emit('end');
    });
    return req;
  };
  const result=await readSignalSourceOnce({
    sourceUrl:'http://127.0.0.1:8790/v1/signals',getImpl,
  });
  assert.deepEqual(result,{status:'READY',eventCount:1,safetyValidated:true});
  assert.ok(!JSON.stringify(result).includes('NEVER_LOG_SIGNAL_ID'));
  assert.ok(!JSON.stringify(result).includes('NEVER_LOG_SYMBOL'));
  assert.equal((await readSignalSourceOnce({
    sourceUrl:'http://evil.example/v1/signals',
    getImpl:()=>{ throw new Error('MUST_NOT_SEND_EXTERNAL_REQUEST'); },
  })).status,'UNSAFE_ENDPOINT');
  assert.equal((await readSignalSourceOnce({
    sourceUrl:'http://127.0.0.1:8790/v1/signals?private=true',
    getImpl:()=>{ throw new Error('MUST_NOT_SEND_QUERY_REQUEST'); },
  })).status,'UNSAFE_ENDPOINT');
});

test('HTTP 503 from loopback V3 is not misreported as a network outage',async()=>{
  const fake=(code)=> (target, opts, done) => {
    assert.equal(target.pathname,'/v1/signals');
    assert.equal(opts.method,'GET');
    const req=new EventEmitter();
    req.destroy=()=>{};
    queueMicrotask(()=>{
      const res=new EventEmitter();
      res.statusCode=code;
      res.resume=()=>{};
      done(res);
    });
    return req;
  };
  const missing=await readSignalSourceOnce({
    sourceUrl:'http://127.0.0.1:8790/v1/signals',getImpl:fake(503)
  });
  assert.deepEqual(missing,{status:'HTTP_503',eventCount:0,safetyValidated:false});
  const badHttp=await readSignalSourceOnce({
    sourceUrl:'http://127.0.0.1:8790/v1/signals',getImpl:fake(502)
  });
  assert.equal(badHttp.status,'HTTP_ERROR');
  const refused=await readSignalSourceOnce({
    sourceUrl:'http://127.0.0.1:8790/v1/signals',
    getImpl:()=>{throw new Error('ECONNREFUSED');}
  });
  assert.equal(refused.status,'UNREACHABLE');
});

test('protected workflow is owner-only and never sends, deploys or restarts',()=>{
  const w=fs.readFileSync('.github/workflows/telegram-production-worker-readonly-audit.yml','utf8');
  const src=fs.readFileSync('ops/telegram-production-worker-readonly-audit.mjs','utf8');
  for(const key of [
    "github.event.issue.number == 1555",
    "github.event.comment.author_association == 'OWNER'",
    "github.event.comment.user.login == 'seungjae3908-source'",
    "startsWith(github.event.comment.body, '/run-telegram-worker-readonly ')",
    'environment: production',
    'StrictHostKeyChecking=yes',
    'TELEGRAM_AUDIT_EXECUTE=true',
    'READ_ONLY_OBSERVATION_COMPLETE',
  ]) assert.ok(w.includes(key),key);
  for(const banned of [
    'sendMessage', 'setWebhook', 'pm2 restart', 'pm2 reload',
    'ops/deploy-production.sh','LIVE_TRADING=true',
    'AUTO_TRADING=true','Replit',
  ]) assert.ok(!w.includes(banned),banned);
  for(const forbidden of ['sendTelegramAlert','writeFileSync','writeFile(','unlinkSync(','spawnSync(','fetch(']){
    assert.ok(!src.includes(forbidden),forbidden);
  }
});
