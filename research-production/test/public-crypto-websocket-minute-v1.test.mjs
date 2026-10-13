import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeUpbitKrwMinuteRoster,normalizeBitgetUsdtMinuteRoster,
} from '../src/four-market-minute-roster-capacity-v1.mjs';
import {
  PUBLIC_WS_MINUTE_LIMITS,planPublicCryptoMinuteWebsocketV1 as plan,
  normalizePublicCryptoWsMinuteV1 as normalize,
  normalizePublicCryptoWsMinutePacketV1 as packets,
  advancePublicCryptoWsMinuteV1 as advance,
  reconcilePublicCryptoWsRestMinuteV1 as reconcile,
} from '../src/public-crypto-websocket-minute-v1.mjs';

const NOW=Date.parse('2026-10-13T02:00:30.000Z');
const START=Date.parse('2026-10-13T02:00:00.000Z');
const caution={FLAG:false};
const up=(base,warning=false)=>({
  market:'KRW-'+base,market_event:{warning,caution},
});
const fut=base=>({
  symbol:base+'USDT',quoteCoin:'USDT',symbolStatus:'normal',
  symbolType:'perpetual',isRwa:'NO',
});
function rosters(spot=['BTC','ETH'],futures=['BTC','ETH'],at=NOW){
  return {
    upbit:normalizeUpbitKrwMinuteRoster(spot.map((s,i)=>up(s,i===1)),at),
    bitget:normalizeBitgetUsdtMinuteRoster({
      code:'00000',data:futures.map(fut),
    },at),
  };
}
const upbitPacket=(overrides={})=>({
  type:'candle.1m',code:'KRW-BTC',stream_type:'REALTIME',
  candle_date_time_utc:'2026-10-13T02:00:00',
  opening_price:100,high_price:105,low_price:98,trade_price:103,
  candle_acc_trade_volume:2,candle_acc_trade_price:203,
  timestamp:NOW-1_000,...overrides,
});
const bitgetPacket=(overrides={})=>({
  action:'update',
  arg:{instType:'USDT-FUTURES',channel:'candle1m',instId:'BTCUSDT'},
  data:[[String(START),'100','105','98','103','2','203','203']],
  ts:NOW-1_000,...overrides,
});
const spotObservation=(raw=upbitPacket(),receivedAtMs=NOW)=>
  normalize({raw,market:'CRYPTO_SPOT',allowedSymbols:['BTC','ETH'],
    receivedAtMs});

test('default off never reads vendor roster, credentials or opens a WebSocket',()=>{
  const r=plan();
  assert.equal(r.status,'DISABLED');
  assert.equal(r.plans.length,0);
  assert.equal(r.socketConnectionsOpened,0);
  assert.equal(r.executionAuthority,'NONE');
});
test('public Upbit and Bitget subscription requests are bounded and credential free',()=>{
  const r=plan({enabled:true,...rosters(),nowMs:NOW});
  assert.equal(r.status,'OPERATOR_REVIEW_REQUIRED');
  assert.equal(r.plannedConnections,2);
  assert.equal(r.plannedPublicChannels,4);
  assert.equal(r.publicCredentialNeeded,false);
  assert.equal(r.sourceRightsAndRetentionVerified,false);
  assert.equal(r.readyToConnect,false);
  assert.equal(r.plans[0].endpoint,'wss://api.upbit.com/websocket/v1');
  assert.equal(r.plans[0].subscription[1].type,'candle.1m');
  assert.equal(r.plans[0].subscription[1].is_only_realtime,true);
  assert.deepEqual(r.plans[0].subscription[1].codes,['KRW-BTC','KRW-ETH']);
  assert.deepEqual(r.plans[0].restrictedSymbols,['ETH']);
  assert.equal(r.plans[1].endpoint,'wss://ws.bitget.com/v2/ws/public');
  assert.equal(r.plans[1].subscription.op,'subscribe');
  assert.deepEqual(r.plans[1].subscription.args.map(x=>x.instId),[
    'BTCUSDT','ETHUSDT',
  ]);
  assert.ok(r.plans[1].subscription.args.every(x=>
    x.channel==='candle1m'&&x.instType==='USDT-FUTURES'));
  assert.equal(r.socketConnectionsOpened,0);
  assert.equal(r.publicProviderGETCount,0);
});
test('760 symbols need twenty venue-isolated 40-channel socket plans, not nineteen',()=>{
  const spot=Array.from({length:294},(_,i)=>
    'T'+String(i).padStart(4,'0'));
  const futures=Array.from({length:466},(_,i)=>
    'Q'+String(i).padStart(4,'0'));
  const r=plan({enabled:true,...rosters(spot,futures),nowMs:NOW});
  assert.equal(r.plannedConnections,20);
  assert.equal(r.plans.filter(x=>x.market==='CRYPTO_SPOT').length,8);
  assert.equal(r.plans.filter(x=>x.market==='CRYPTO_FUTURES').length,12);
  assert.equal(r.plannedPublicChannels,760);
  assert.ok(r.plans.every(p=>
    p.symbols.length<=PUBLIC_WS_MINUTE_LIMITS.maxSymbolsPerSocket));
  assert.ok(r.plans.every(p=>p.endpoint.startsWith('wss://')));
  assert.equal(r.streamObserved,false);
  assert.equal(r.readyToConnect,false);
  assert.equal(r.socketConnectionsOpened,0);
});
test('stale, inverted and tampered current rosters refuse new subscriptions',()=>{
  assert.throws(()=>plan({enabled:true,...rosters(),nowMs:NOW+16*60_000}),
    /WS_MINUTE_ROSTER_STALE/);
  assert.throws(()=>plan({enabled:true,
    ...rosters(['BTC'],['BTC'],NOW+10_000),nowMs:NOW}),
  /WS_MINUTE_ROSTER_STALE/);
  const r=rosters();
  assert.throws(()=>plan({enabled:true,upbit:{...r.upbit,
    symbols:['XRP']},bitget:r.bitget,nowMs:NOW}),
  /MINUTE_ROSTER_/);
});
test('Upbit realtime uses UTC minute start, not last-tick timestamp',()=>{
  const r=spotObservation();
  assert.equal(r.status,'WEBSOCKET_PROVISIONAL_MINUTE');
  assert.equal(r.row.timestamp,START);
  assert.equal(r.availableAtMs,NOW);
  assert.equal(r.sourceEventAtMs,NOW-1000);
  assert.equal(r.sourceId,'UPBIT_PUBLIC_WS_1M');
  assert.equal(r.needsRestFinalityCheck,true);
  assert.equal(r.profitabilityProven,false);
  assert.equal(r.archiveFilesWritten,0);
  const ignored=spotObservation(upbitPacket({stream_type:'SNAPSHOT'}));
  assert.equal(ignored.status,'IGNORED_SNAPSHOT');
});
test('Bitget public futures update normalizes correctly; snapshot is not credited',()=>{
  const r=normalize({market:'CRYPTO_FUTURES',raw:JSON.stringify(bitgetPacket()),
    allowedSymbols:['BTCUSDT'],receivedAtMs:NOW});
  assert.equal(r.status,'WEBSOCKET_PROVISIONAL_MINUTE');
  assert.equal(r.symbol,'BTCUSDT');
  assert.equal(r.row.volume,2);
  assert.equal(r.sourceId,'BITGET_PUBLIC_V2_WS_FUTURES_1M');
  const snapshot=normalize({market:'CRYPTO_FUTURES',
    raw:bitgetPacket({action:'snapshot'}),allowedSymbols:['BTCUSDT'],
    receivedAtMs:NOW});
  assert.equal(snapshot.status,'IGNORED_SNAPSHOT');
  assert.equal(snapshot.archiveFilesWritten,0);
});

test('Bitget batched provisional rows preserve all minutes in sorted order',()=>{
  const at=START+91_000;
  const v=bitgetPacket({
    ts:START+90_000,
    data:[
      [String(START+60_000),'100','106','98','104','3','301','301'],
      [String(START),'100','105','98','103','2','203','203'],
    ],
  });
  const got=packets({market:'CRYPTO_FUTURES',
    allowedSymbols:['BTCUSDT'],
    receivedAtMs:at,raw:Buffer.from(JSON.stringify(v))});
  assert.equal(got.length,2);
  assert.deepEqual(got.map(x=>x.row.timestamp),[START,START+60_000]);
  assert.ok(got.every(x=>x.needsRestFinalityCheck));
  assert.ok(got.every(x=>x.executionAuthority==='NONE'));
  assert.equal(got[0].archiveFilesWritten,0);
});
test('bitget duplicate, oversized array and oversize raw object are rejected',()=>{
  const at=START+90_000;
  const frame=bitgetPacket({ts:at-1000});
  assert.throws(()=>packets({market:'CRYPTO_FUTURES',
    allowedSymbols:['BTCUSDT'],receivedAtMs:at,
    raw:{...frame,data:[frame.data[0],frame.data[0]]}}),
  /WS_MINUTE_BITGET_BATCH_DUPLICATE/);
  assert.throws(()=>packets({market:'CRYPTO_FUTURES',
    allowedSymbols:['BTCUSDT'],receivedAtMs:at,
    raw:{...frame,data:Array.from({length:33},()=>frame.data[0])}}),
  /WS_MINUTE_BITGET_BATCH_INVALID/);
  assert.throws(()=>packets({market:'CRYPTO_SPOT',
    allowedSymbols:['BTC'],receivedAtMs:at,
    raw:{...upbitPacket(),filler:'x'.repeat(256*1024)}}),
  /WS_MINUTE_PACKET_OVERSIZE/);
});

test('unknown symbols, malformed OHLC, future events and fake channels fail closed',()=>{
  assert.throws(()=>spotObservation(upbitPacket({code:'KRW-FAKE'})),
    /WS_MINUTE_SOURCE_TIME_OR_SYMBOL_INVALID/);
  assert.throws(()=>spotObservation(upbitPacket({high_price:90})),
    /WS_MINUTE_OHLCV_INVALID/);
  assert.throws(()=>spotObservation(upbitPacket({timestamp:NOW+10_000})),
    /WS_MINUTE_SOURCE_TIME_OR_SYMBOL_INVALID/);
  assert.throws(()=>spotObservation(upbitPacket({candle_date_time_utc:
    '2026-10-13T02:00:10'})),/WS_MINUTE_UPBIT_START_INVALID/);
  assert.throws(()=>normalize({market:'CRYPTO_FUTURES',
    raw:bitgetPacket({arg:{instType:'SPOT',channel:'candle1m',instId:'BTCUSDT'}}),
    allowedSymbols:['BTCUSDT'],receivedAtMs:NOW}),/WS_MINUTE_BITGET_MESSAGE_INVALID/);
  assert.throws(()=>normalize({market:'CRYPTO_SPOT',
    raw:'{malformed',allowedSymbols:['BTC'],receivedAtMs:NOW}),
  /WS_MINUTE_PACKET_JSON_INVALID/);
  assert.throws(()=>normalize({market:'CRYPTO_SPOT',
    raw:'X'.repeat(256*1024+1),allowedSymbols:['BTC'],receivedAtMs:NOW}),
  /WS_MINUTE_PACKET_OVERSIZE/);
});
test('duplicate realtime updates are idempotent; newer cumulative OHLCV is monotone',()=>{
  const first=spotObservation();
  const initial=advance({observation:first});
  const dup=advance({previous:initial,observation:first});
  assert.equal(dup.status,'DUPLICATE_IGNORED');
  assert.equal(dup.current.row.volume,2);
  const next=spotObservation(upbitPacket({
    high_price:106,low_price:97,trade_price:104,
    candle_acc_trade_volume:3,candle_acc_trade_price:307,
    timestamp:NOW+1_000,
  }),NOW+2_000);
  const updated=advance({previous:dup,observation:next});
  assert.equal(updated.status,'PROVISIONAL_UPDATED');
  assert.equal(updated.current.row.high,106);
  assert.equal(updated.current.row.volume,3);
  assert.throws(()=>advance({previous:updated,
    observation:spotObservation(upbitPacket({timestamp:NOW+2_000,
      candle_acc_trade_volume:1}),NOW+3_000)}),
  /WS_MINUTE_CUMULATIVE_REVISION_INVALID/);
});
test('rollover and missing minutes require REST inspection; never fabricate candles',()=>{
  const initial=advance({observation:spotObservation()});
  const another=spotObservation(upbitPacket({
    candle_date_time_utc:'2026-10-13T02:02:00',
    timestamp:START+2*60_000+7_000,
  }),START+2*60_000+8_000);
  const state=advance({previous:initial,observation:another});
  assert.equal(state.status,'UNVERIFIED_GAPS');
  assert.equal(state.unverifiedGapSlots,1);
  assert.equal(state.previousClosedCandidate.row.timestamp,START);
  assert.equal(state.paperAdmissionAllowed,false);
  assert.equal(state.needsRestFinalityCheck,true);
  assert.throws(()=>advance({previous:state,
    observation:spotObservation()}),/WS_MINUTE_OUT_OF_ORDER/);
});
test('REST equality is source-only; mismatch, unclosed and missing records block credit',()=>{
  const ws=spotObservation();
  const rest={...ws.row};
  const at=START+90_000;
  const same=reconcile({observation:ws,restRow:rest,restRetrievedAtMs:at});
  assert.equal(same.status,'REST_AND_WEBSOCKET_MATCH_SOURCE_ONLY');
  assert.equal(same.sourceVerified,true);
  assert.equal(same.immutableArchiveAdmission,false);
  assert.equal(same.profitabilityProven,false);
  const mismatch=reconcile({observation:ws,
    restRow:{...rest,close:102},restRetrievedAtMs:at});
  assert.equal(mismatch.status,'BLOCKED_REST_WEBSOCKET_CONFLICT');
  assert.equal(mismatch.restBackfillRequired,true);
  const missing=reconcile({observation:ws,restRow:null,restRetrievedAtMs:at});
  assert.equal(missing.status,'REST_MINUTE_NOT_AVAILABLE');
  assert.throws(()=>reconcile({observation:ws,restRow:rest,
    restRetrievedAtMs:START+62_000}),/WS_MINUTE_REST_COMPARISON_INVALID/);
});
