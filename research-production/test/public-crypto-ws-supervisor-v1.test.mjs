import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeUpbitKrwMinuteRoster,normalizeBitgetUsdtMinuteRoster,
} from '../src/four-market-minute-roster-capacity-v1.mjs';
import {planPublicCryptoMinuteWebsocketV1} from
  '../src/public-crypto-websocket-minute-v1.mjs';
import {
  PUBLIC_WS_SUPERVISOR_LIMITS as limits,
  createPublicCryptoWsSupervisorV1 as create,
  pollPublicCryptoWsSupervisorV1 as poll,
  observePublicCryptoWsSupervisorV1 as see,
  publicCryptoWsSupervisorStatusV1 as status,
} from '../src/public-crypto-ws-supervisor-v1.mjs';

const START=Date.parse('2026-10-13T04:00:00Z');
const NOW=START+30_000;
const event={warning:false,caution:{WARN:false}};
const roster=(spot=['BTC'],futures=['BTC'])=>({
  upbit:normalizeUpbitKrwMinuteRoster(spot.map(s=>({
    market:'KRW-'+s,market_event:event,
  })),NOW),
  bitget:normalizeBitgetUsdtMinuteRoster({code:'00000',
    data:futures.map(s=>({
      symbol:s+'USDT',quoteCoin:'USDT',symbolStatus:'normal',
      symbolType:'perpetual',isRwa:'NO',
    })),
  },NOW),
});
const prepare=(spot=['BTC'],futures=['BTC'])=>
  planPublicCryptoMinuteWebsocketV1({enabled:true,
    ...roster(spot,futures),nowMs:NOW});
const spotPacket=(startMs=START,receivedAtMs=NOW,extra={})=>({
  type:'candle.1m',code:'KRW-BTC',stream_type:'REALTIME',
  candle_date_time_utc:new Date(startMs).toISOString().slice(0,19),
  opening_price:100,high_price:105,low_price:97,trade_price:103,
  candle_acc_trade_volume:2,candle_acc_trade_price:201,
  timestamp:receivedAtMs-1_000,...extra,
});
const futuresPacket=(symbol='BTCUSDT',startMs=START,atMs=NOW)=>({
  action:'update',arg:{instType:'USDT-FUTURES',channel:'candle1m',instId:symbol},
  data:[[String(startMs),'100','105','97','103','2','201','201']],
  ts:atMs-1_000,
});
const state0=()=>create({enabled:true,plan:prepare(),nowMs:NOW});
const singlePlan=which=>{
  const p=prepare(),one=p.plans[which];
  return {...p,plans:[one],plannedConnections:1,
    plannedPublicChannels:one.symbols.length,symbolCount:one.symbols.length};
};
const oneSpot=()=>create({enabled:true,plan:singlePlan(0),nowMs:NOW});
const oneFuture=()=>create({enabled:true,plan:singlePlan(1),nowMs:NOW});
const doPoll=(state,nowMs)=>poll({state,nowMs});
const doSee=(state,index,kind,nowMs,raw)=>see({
  state,socketId:state.sockets[index].id,kind,nowMs,raw,
});
function started(index=0){
  let s=oneSpot();
  let r=doPoll(s,NOW);
  assert.equal(r.intent.action,'CONNECT_PUBLIC_ONLY_INTENT');
  s=r.state;
  r=doSee(s,index,'OPEN',NOW+10);
  assert.equal(r.intent.action,'SEND_PUBLIC_SUBSCRIPTION');
  s=r.state;
  r=doSee(s,index,'SUBSCRIPTION_SENT',NOW+20);
  return r.state;
}
test('default supervisor is inert, and fake/private socket plans are rejected',()=>{
  const disabled=create();
  assert.equal(disabled.status,'DISABLED');
  assert.equal(disabled.socketsOpened,0);
  assert.equal(disabled.archiveFilesWritten,0);
  assert.equal(disabled.executionAuthority,'NONE');
  const plan=prepare();
  assert.throws(()=>create({enabled:true,plan:{
    ...plan,plans:plan.plans.map((x,i)=>i?x:{...x,
      endpoint:'wss://ws.bitget.com/v2/ws/private'}),
  },nowMs:NOW}),/WS_SUPERVISOR_SOURCE_PLAN_INVALID/);
  assert.throws(()=>create({enabled:true,plan,nowMs:0}),
    /WS_SUPERVISOR_CLOCK_INVALID/);
  const state=create({enabled:true,plan,nowMs:NOW});
  assert.equal(state.status,'SIMULATION_ONLY');
  assert.equal(state.socketsOpened,0);
  assert.equal(status(state).allSymbolsContinuouslyObserved,false);
});
test('global connection-intent throttle avoids 20-socket reconnect storms',()=>{
  const spot=Array.from({length:294},(_,i)=>'T'+String(i).padStart(4,'0'));
  const future=Array.from({length:466},(_,i)=>'Q'+String(i).padStart(4,'0'));
  const state=create({enabled:true,plan:prepare(spot,future),nowMs:NOW});
  let s=state;
  const seen=new Set();
  for(let i=0;i<20;i++){
    const t=NOW+i*limits.minConnectSpacingMs;
    const r=doPoll(s,t);
    assert.equal(r.intent.action,'CONNECT_PUBLIC_ONLY_INTENT');
    assert.ok(!seen.has(r.intent.socketId));
    seen.add(r.intent.socketId);
    assert.equal(r.intent.neverExecuted,true);
    s=r.state;
  }
  assert.equal(seen.size,20);
  const none=doPoll(s,NOW+20*limits.minConnectSpacingMs);
  assert.equal(none.intent.action,'NONE');
  assert.equal(none.state.sockets.filter(x=>x.phase==='CONNECTING').length,20);
  assert.equal(none.state.socketsOpened,0);
});
test('Upbit idle no-trade never counts as disconnect; transport ping/pong does',()=>{
  let s=started(0);
  const noop=doPoll(s,NOW+15_000);
  assert.equal(noop.intent.action,'NONE');
  const ping=doPoll(noop.state,NOW+30_020);
  assert.equal(ping.intent.action,'SEND_WEBSOCKET_PING_FRAME');
  assert.equal(ping.intent.payload,null);
  assert.equal(ping.intent.neverExecuted,true);
  s=ping.state;
  const pong=doSee(s,0,'PONG',NOW+30_030,'PONG_FRAME');
  assert.equal(pong.intent.action,'PONG_RECEIVED');
  s=pong.state;
  assert.equal(status(s).streaming,1);
  assert.equal(status(s).pendingRestAudits,0);
  const good=doPoll(s,NOW+45_000);
  assert.equal(good.intent.action,'NONE');
  assert.throws(()=>doSee(s,0,'PONG',NOW+45_000,'PONG_FRAME'),
    /WS_SUPERVISOR_UNEXPECTED_PONG/);
});
test('Bitget requires per-symbol subscribe ACK and exact string pong',()=>{
  let s=oneFuture();
  const first=doPoll(s,NOW);s=first.state;
  let r=doSee(s,0,'OPEN',NOW+10);s=r.state;
  r=doSee(s,0,'SUBSCRIPTION_SENT',NOW+20);s=r.state;
  assert.equal(status(s).awaitingAcknowledgements,1);
  assert.throws(()=>doSee(s,0,'CANDLE',NOW+30,
    futuresPacket('BTCUSDT',START,NOW+30)),
  /WS_SUPERVISOR_NOT_SUBSCRIBED/);
  r=doSee(s,0,'ACK',NOW+30,{event:'subscribe',
    arg:{instType:'USDT-FUTURES',channel:'candle1m',instId:'BTCUSDT'}});
  s=r.state;
  assert.equal(status(s).streaming,1);
  const ping=doPoll(s,NOW+30_020);
  assert.equal(ping.intent.action,'SEND_TEXT_PING');
  assert.equal(ping.intent.payload,'ping');
  assert.throws(()=>doSee(ping.state,0,'PONG',NOW+30_031,'wrong'),
    /WS_SUPERVISOR_UNEXPECTED_PONG/);
  const pong=doSee(ping.state,0,'PONG',NOW+30_031,'pong');
  assert.equal(pong.intent.action,'PONG_RECEIVED');
  assert.equal(pong.state.socketsOpened,0);
});

test('Bitget multi-row packets enter provisional cache without dropping candle intervals',()=>{
  let s=oneFuture();
  s=doPoll(s,NOW).state;
  s=doSee(s,0,'OPEN',NOW+10).state;
  s=doSee(s,0,'SUBSCRIPTION_SENT',NOW+20).state;
  s=doSee(s,0,'ACK',NOW+30,{
    event:'subscribe',
    arg:{instType:'USDT-FUTURES',channel:'candle1m',instId:'BTCUSDT'},
  }).state;
  const nowMs=START+100_000;
  const raw={...futuresPacket('BTCUSDT',START,nowMs),
    data:[
      [String(START+60_000),'100','106','97','104','3','307','307'],
      [String(START),'100','105','97','103','2','201','201'],
    ],
    ts:nowMs-1_000};
  const r=doSee(s,0,'CANDLE',nowMs,raw);
  assert.equal(r.intent.action,'PROVISIONAL_MINUTE_OBSERVED');
  assert.equal(r.intent.observationsInPacket,2);
  assert.equal(r.intent.status,'ROLLOVER_REST_CHECK_REQUIRED');
  assert.equal(r.state.pendingRestAudits.length,1);
  assert.equal(r.state.pendingRestAudits[0].sourceVerified,false);
  assert.equal(status(r.state).allSymbolsContinuouslyObserved,false);
  assert.equal(status(r.state).executionAuthority,'NONE');
});

test('missing pong quarantines socket and exponential reconnect intent is bounded',()=>{
  let s=started();
  const heartbeat=doPoll(s,NOW+31_000);s=heartbeat.state;
  const timeout=doPoll(s,NOW+47_000);
  assert.equal(timeout.intent.action,'CLOSE_AND_RETRY_PUBLIC_SOCKET');
  assert.equal(timeout.state.sockets[0].phase,'BACKOFF');
  assert.equal(timeout.state.sockets[0].reconnectFailures,1);
  assert.equal(timeout.state.sockets[0].nextConnectAtMs,NOW+52_000);
  const noEarly=doPoll(timeout.state,NOW+51_000);
  assert.equal(noEarly.intent.action,'NONE');
  const retried=doPoll(noEarly.state,NOW+52_000);
  assert.equal(retried.intent.action,'CONNECT_PUBLIC_ONLY_INTENT');
  assert.equal(retried.state.socketsOpened,0);
});
test('out-of-order and missing 1m produce REST audit, not invented bar or Paper credit',()=>{
  let s=started();
  let r=doSee(s,0,'CANDLE',NOW+100,spotPacket(START,NOW+100));s=r.state;
  assert.equal(r.intent.action,'PROVISIONAL_MINUTE_OBSERVED');
  assert.equal(r.intent.status,'PROVISIONAL_OPEN');
  assert.equal(status(s).pendingRestAudits,0);
  const later=START+2*60_000+10_000;
  r=doSee(s,0,'CANDLE',later,spotPacket(START+2*60_000,later));
  s=r.state;
  assert.equal(r.intent.status,'UNVERIFIED_GAPS');
  assert.equal(status(s).pendingRestAudits,1);
  assert.equal(s.pendingRestAudits[0].reason,'MISSING_MINUTE_SLOTS_UNVERIFIED');
  assert.equal(s.pendingRestAudits[0].sourceVerified,false);
  assert.equal(s.pendingRestAudits[0].restBackfillRequired,true);
  assert.equal(status(s).paperAdmissionAllowed,false);
  assert.equal(status(s).profitabilityProven,false);
  assert.throws(()=>doSee(s,0,'CANDLE',later+1_000,
    spotPacket(START,later+1_000)),/WS_MINUTE_OUT_OF_ORDER/);
  // A true connection close causes a separate unknown outage audit;
  // it must not magically fill the missing one-minute slot.
  r=doSee(s,0,'CLOSE',later+2_000);
  assert.equal(r.intent.action,'RECONNECT_BACKOFF_ONLY');
  assert.equal(r.state.sockets[0].phase,'BACKOFF');
  assert.ok(r.state.pendingRestAudits.length>=1);
});
test('socket connection timeout is not masked by unrelated quiet candle stream',()=>{
  const r=doPoll(state0(),NOW);
  const timeout=doPoll(r.state,NOW+31_000);
  assert.equal(timeout.intent.action,'CLOSE_AND_RETRY_PUBLIC_SOCKET');
  assert.equal(timeout.state.sockets[0].lastFailure,'CONNECT_TIMEOUT');
  assert.equal(timeout.state.socketsOpened,0);
});
test('ACK spoofing, unknown symbols and stale clocks are blocked',()=>{
  const s=started();
  assert.throws(()=>doSee(s,0,'ACK',NOW+200,{event:'subscribe'}),
    /WS_SUPERVISOR_ACK_INVALID/);
  assert.throws(()=>doSee(s,0,'CANDLE',NOW+200,
    spotPacket(START,NOW+200,{code:'KRW-FAKE'})),
  /WS_MINUTE_SOURCE_TIME_OR_SYMBOL_INVALID/);
  assert.throws(()=>doPoll(s,NOW),/WS_SUPERVISOR_STATE_INVALID/);
  assert.equal(status(s).archiveFilesWritten,0);
});

test('bridged REST debt intervals coalesce ALL matching records without dropping tails',()=>{
  let s=started();
  s=doSee(s,0,'CANDLE',NOW+100,spotPacket(START,NOW+100)).state;
  s=structuredClone(s);
  const debt=(fromMs,toExclusiveMs,reason)=>({
    market:'CRYPTO_SPOT',symbol:'BTC',fromMs,toExclusiveMs,
    requestedEndExclusiveMs:toExclusiveMs,unverifiedBeyondCap:false,
    reason,observedAtMs:NOW,lastObservedAtMs:NOW,
    sourceVerified:false,restBackfillRequired:true,
  });
  s.pendingRestAudits=[
    debt(START,START+60_000,'FIRST_UNKNOWN'),
    debt(START+3*60_000,START+4*60_000,'SECOND_UNKNOWN'),
  ];
  const at=START+4*60_000+31_000;
  s=doSee(s,0,'CANDLE',at,
    spotPacket(START+4*60_000,at)).state;
  assert.equal(s.pendingRestAudits.length,1);
  assert.equal(s.pendingRestAudits[0].fromMs,START);
  assert.equal(s.pendingRestAudits[0].requestedEndExclusiveMs,
    START+4*60_000);
  assert.equal(s.pendingRestAudits[0].reason,'MIXED_WS_REST_AUDIT_REQUIRED');
  assert.equal(s.pendingRestAudits[0].sourceVerified,false);
});
test('quiet subscribed socket CLOSE and heartbeat failure create REST debt',()=>{
  let s=started();
  const closeAt=START+4*60_000+10_000;
  s=doSee(s,0,'CLOSE',closeAt).state;
  assert.equal(s.pendingRestAudits.length,1);
  assert.equal(s.pendingRestAudits[0].fromMs,START);
  assert.equal(s.pendingRestAudits[0].requestedEndExclusiveMs,
    START+4*60_000);
  assert.equal(s.pendingRestAudits[0].restBackfillRequired,true);
  let quiet=started();
  quiet=doPoll(quiet,NOW+31_000).state;
  quiet=doPoll(quiet,NOW+47_000).state;
  assert.equal(quiet.sockets[0].lastFailure,'PONG_TIMEOUT');
  assert.equal(quiet.pendingRestAudits.length,1);
  assert.equal(quiet.pendingRestAudits[0].sourceVerified,false);
});
test('reconnect retains the unknown offline interval for quiet symbols',()=>{
  let s=started();
  s=doSee(s,0,'CLOSE',START+2*60_000+10_000).state;
  s=doPoll(s,START+6*60_000).state;
  s=doSee(s,0,'OPEN',START+6*60_000+10).state;
  s=doSee(s,0,'SUBSCRIPTION_SENT',START+6*60_000+20).state;
  assert.equal(s.pendingRestAudits.length,1);
  assert.equal(s.pendingRestAudits[0].fromMs,START);
  assert.equal(s.pendingRestAudits[0].requestedEndExclusiveMs,
    START+6*60_000);
  assert.equal(s.pendingRestAudits[0].sourceVerified,false);
});
test('missing Bitget subscribe ACK times out rather than hanging indefinitely',()=>{
  let s=oneFuture();
  s=doPoll(s,NOW).state;
  s=doSee(s,0,'OPEN',NOW+10).state;
  s=doSee(s,0,'SUBSCRIPTION_SENT',NOW+20).state;
  const r=doPoll(s,NOW+31_000);
  assert.equal(r.intent.action,'CLOSE_AND_RETRY_PUBLIC_SOCKET');
  assert.equal(r.state.sockets[0].lastFailure,'SUBSCRIPTION_TIMEOUT');
  assert.equal(r.state.sockets[0].phase,'BACKOFF');
  assert.equal(r.state.executionAuthority,'NONE');
});
