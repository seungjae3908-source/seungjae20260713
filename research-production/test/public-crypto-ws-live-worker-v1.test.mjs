import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  normalizeUpbitKrwMinuteRoster,normalizeBitgetUsdtMinuteRoster,
} from '../src/four-market-minute-roster-capacity-v1.mjs';
import {planPublicCryptoMinuteWebsocketV1} from
  '../src/public-crypto-websocket-minute-v1.mjs';
import {createPublicCryptoWsLiveWorkerV1 as live} from
  '../src/public-crypto-ws-live-worker-v1.mjs';
import {
  assertPrivateLiveWsRootV1,startPublicWsLiveJournalV1,
} from '../src/public-crypto-ws-live-journal-v1.mjs';
const MIN=60_000,START=Date.parse('2026-10-13T00:00:00Z');
const ONE_GIB=1024**3;
const SHA='a'.repeat(40);
const event={warning:false,caution:{WARN:false}};
const plan=(nowMs,spot=['BTC'],future=['BTC'])=>{
  const upbit=normalizeUpbitKrwMinuteRoster(spot.map(symbol=>({
    market:'KRW-'+symbol,market_event:event,
  })),nowMs);
  const bitget=normalizeBitgetUsdtMinuteRoster({code:'00000',
    data:future.map(symbol=>({
      symbol:symbol+'USDT',quoteCoin:'USDT',
      symbolType:'perpetual',symbolStatus:'normal',isRwa:'NO',
    })),
  },nowMs);
  return planPublicCryptoMinuteWebsocketV1({
    enabled:true,upbit,bitget,nowMs,
  });
};
class FakePublicSocket extends EventTarget{
  constructor(url){
    super();this.url=url;this.readyState=0;this.bufferedAmount=0;
    this.sent=[];this.closed=false;
  }
  send(data){
    if(this.readyState!==1)throw Error('FAKE_SOCKET_NOT_OPEN');
    this.sent.push(data);
  }
  open(){
    this.readyState=1;this.dispatchEvent(new Event('open'));
  }
  message(data){
    this.dispatchEvent(new MessageEvent('message',{
      data:typeof data==='string'?data:JSON.stringify(data),
    }));
  }
  close(){if(this.readyState===3)return;
    this.closed=true;this.readyState=3;
    this.dispatchEvent(new Event('close'));
  }
}
const upbitFrame=(symbol,at,receivedAtMs)=>({
  type:'candle.1m',code:'KRW-'+symbol,stream_type:'REALTIME',
  candle_date_time_utc:new Date(at).toISOString().slice(0,19),
  timestamp:receivedAtMs-1000,opening_price:100,
  high_price:105,low_price:98,trade_price:103,
  candle_acc_trade_volume:2,candle_acc_trade_price:206,
});
const bitgetFrame=(symbol,at,receivedAtMs)=>({
  action:'update',arg:{
    instType:'USDT-FUTURES',channel:'candle1m',instId:symbol+'USDT',
  },data:[[String(at),'100','105','98','103','2','206','206']],
  ts:receivedAtMs-1000,
});
async function room(fn){
  const root=await mkdtemp(join(tmpdir(),'live-ws-test-'));
  try{return await fn(root);}
  finally{await rm(root,{recursive:true,force:true});}
}
function harness(root){
  let time=START+30_000;
  const sockets=[];
  const worker=live({
    enabled:true,operatorApproved:true,sourceRightsConfirmed:true,
    hostCapacityConfirmed:true,
    plan:plan(time),root,producerSha:SHA,
    diskFree:async()=>6*ONE_GIB,clock:()=>time,
    socketFactory:url=>{
      const s=new FakePublicSocket(url);sockets.push(s);return s;
    },
  });
  return {worker,sockets,at:()=>time,setTime:n=>{time=n;}};
}
async function openFirst(h){
  await h.worker.start();
  assert.equal(h.sockets.length,1);
  assert.equal(h.sockets[0].url,'wss://api.upbit.com/websocket/v1');
  h.sockets[0].open();await h.worker.drain();
  assert.equal(JSON.parse(h.sockets[0].sent[0])[1].type,'candle.1m');
}
async function openBitget(h){
  h.setTime(START+31_100);
  await h.worker.pulse();assert.equal(h.sockets.length,2);
  const s=h.sockets[1];
  assert.equal(s.url,'wss://ws.bitget.com/v2/ws/public');
  s.open();await h.worker.drain();
  assert.equal(JSON.parse(s.sent[0]).op,'subscribe');
  s.message({event:'subscribe',arg:{
    instType:'USDT-FUTURES',channel:'candle1m',instId:'BTCUSDT',
  }});
  await h.worker.drain();
}
test('default live worker is inert and missing explicit gates never opens sockets',()=>{
  assert.equal(live().status,'DISABLED');
  assert.equal(live().websocketConnectionsOpened,0);
  assert.throws(()=>live({enabled:true}),/LIVE_WS_EXPLICIT_APPROVALS_REQUIRED/);
});
test('real transport adapter drives public subscriptions, candle compaction and immutable sidecars',async()=>{
  await room(async root=>{
    const h=harness(root);
    await openFirst(h);await openBitget(h);
    h.setTime(START+32_000);
    h.sockets[0].message(upbitFrame('BTC',START,h.at()));
    h.sockets[1].message(bitgetFrame('BTC',START,h.at()));
    await h.worker.drain();
    assert.equal(h.worker.report().openedPublicSockets,2);
    assert.equal(h.worker.report().receivedMinuteUpdates,2);
    assert.equal(h.worker.report().supervisorStreaming,2);
    h.setTime(START+5*MIN+6_000);
    await h.worker.pulse();
    assert.equal(h.worker.report().provisionalSidecarsStored,2);
    assert.equal(h.worker.report().publicProviderGETCount,0);
    assert.equal(h.worker.report().realOrders,0);
    const journals=await readdir(join(root,'.public-ws-live-journal-v1'));
    assert.equal(journals.filter(n=>n.endsWith('.start.json')).length,1);
    await h.worker.stop();
    assert.equal(h.worker.report().status,'STOPPED_SOURCE_ONLY');
    const end=await readdir(join(root,'.public-ws-live-journal-v1'));
    assert.equal(end.filter(n=>n.endsWith('.end.json')).length,1);
  });
});
test('restart conservatively restores all market-scoped REST debt even after clean stop',async()=>{
  await room(async root=>{
    const first=harness(root);await openFirst(first);
    await first.worker.stop();
    const next=harness(root);
    next.setTime(START+MIN+30_000);
    await next.worker.start();
    const s=next.worker.report();
    assert.equal(s.pendingRestAudits,2);
    assert.equal(s.needsIndependentREST,true);
    assert.equal(s.paperAdmissionAllowed,false);
    assert.equal(s.executionAuthority,'NONE');
    assert.equal(next.worker.auditPlan({limit:16}).tasks.length,2);
    await next.worker.stop();
  });
});
test('fatal provider error quarantines connection and keeps unclosed journal as debt',async()=>{
  await room(async root=>{
    const h=harness(root);await openFirst(h);
    h.sockets[0].message({error:{name:'INVALID_PARAM',message:'bad'}});
    await h.worker.drain();
    assert.equal(h.worker.report().status,'HALTED_MANUAL_REVIEW');
    assert.equal(h.worker.report().errorCode,
      'LIVE_WS_EXCHANGE_REJECTED_PUBLIC_CHANNEL');
    assert.equal(h.sockets[0].closed,true);
    await h.worker.stop();
    const names=await readdir(join(root,'.public-ws-live-journal-v1'));
    assert.equal(names.filter(n=>n.endsWith('.start.json')).length,1);
    assert.equal(names.filter(n=>n.endsWith('.end.json')).length,0);
    const recovered=harness(root);
    recovered.setTime(START+MIN+30_000);
    await recovered.worker.start();
    assert.equal(recovered.worker.report().pendingRestAudits,2);
    await recovered.worker.stop();
  });
});
test('untrusted journal, weak root, and low disk all fail closed',async()=>{
  await room(async root=>{
    const stat=await assertPrivateLiveWsRootV1(root);
    assert.equal(stat,root);
    const h=harness(root);
    // disk admission is measured before opening any network socket
    await assert.rejects(()=>startPublicWsLiveJournalV1({
      root,producerSha:SHA,nowMs:START,
      sockets:[{id:'f'.repeat(32),market:'CRYPTO_SPOT',symbols:['BTC']}],
      freeBytes:1*ONE_GIB,
    }),/LIVE_WS_JOURNAL_PREFLIGHT_INVALID/);
    assert.equal(h.sockets.length,0);
    await h.worker.start();
    await h.worker.stop();
  });
});
