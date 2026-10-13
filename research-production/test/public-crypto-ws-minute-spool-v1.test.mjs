import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {normalizeUpbitKrwMinuteRoster,normalizeBitgetUsdtMinuteRoster}
  from '../src/four-market-minute-roster-capacity-v1.mjs';
import {planPublicCryptoMinuteWebsocketV1}
  from '../src/public-crypto-websocket-minute-v1.mjs';
import {assessPublicWsSpoolPressureV1 as assess,
  createPublicWsMinuteSpoolV1 as create,
  ingestPublicWsMinuteSpoolPacketV1 as ingest,
  preparePublicWsMinuteSpoolSidecarV1 as prepare}
  from '../src/public-crypto-ws-minute-spool-v1.mjs';
import {persistPublicWsProvisionalBatchV1 as persist,
  readPublicWsProvisionalBatchV1 as read}
  from '../src/public-crypto-ws-sidecar-v1.mjs';

const MIN=60_000,START=Date.parse('2026-10-13T00:00:00Z');
const END=START+5*MIN,NOW=START+30_000,SHA='a'.repeat(40);
const event={warning:false,caution:{FLAG:false}};
function plans(spot=['BTC','ETH'],futures=['BTC']){
  const upbit=normalizeUpbitKrwMinuteRoster(spot.map(s=>({
    market:'KRW-'+s,market_event:event,
  })),NOW);
  const bitget=normalizeBitgetUsdtMinuteRoster({code:'00000',
    data:futures.map(s=>({
      symbol:s+'USDT',quoteCoin:'USDT',symbolStatus:'normal',
      symbolType:'perpetual',isRwa:'NO',
    })),
  },NOW);
  return planPublicCryptoMinuteWebsocketV1({
    enabled:true,upbit,bitget,nowMs:NOW,
  });
}
const up=(symbol,receivedAtMs,fields={})=>({
  type:'candle.1m',code:'KRW-'+symbol,stream_type:'REALTIME',
  candle_date_time_utc:new Date(START).toISOString().slice(0,19),
  timestamp:receivedAtMs-500,
  opening_price:100,high_price:105,low_price:95,trade_price:103,
  candle_acc_trade_volume:2,candle_acc_trade_price:203,...fields,
});
function spool(spot=['BTC','ETH'],futures=['BTC'],i=0){
  return create({enabled:true,plan:plans(spot,futures).plans[i],
    windowStartMs:START});
}
test('sidecar raw-frame admission would overflow at dense 40 symbols; minute spool fits snapshot count',()=>{
  const p=assess({symbolsPerSocket:40,windowMinutes:5,
    updatesPerSecondPerSymbol:1});
  assert.equal(p.theoreticalRawUpdates,12_000);
  assert.equal(p.theoreticalMinuteSnapshots,200);
  assert.equal(p.rawSidecarLimit,2048);
  assert.equal(p.naiveRawBatchWouldOverflow,true);
  assert.equal(p.snapshotBatchFitsCountOnly,true);
  assert.equal(p.hostStorageBenchmarked,false);
  assert.equal(p.publicProviderGETCount,0);
  assert.equal(p.executionAuthority,'NONE');
});
test('spool stays disabled by default and validates only fixed public market plan',()=>{
  const x=create();
  assert.equal(x.status,'DISABLED');
  assert.equal(x.archiveFilesWritten,0);
  const p=plans().plans[0];
  assert.throws(()=>create({enabled:true,
    plan:{...p,endpoint:'wss://api.upbit.com/websocket/v1/private'},
    windowStartMs:START}),/WS_SPOOL_PUBLIC_PLAN_INVALID/);
  assert.throws(()=>create({enabled:true,plan:p,
    windowStartMs:START+500}),/WS_SPOOL_WINDOW_INVALID/);
});
test('same-minute cumulative updates collapse to last source-only snapshot without losing observed counts',()=>{
  let state=spool();
  const first=ingest({state,receivedAtMs:START+1_000,
    raw:up('BTC',START+1_000)});
  state=first.state;
  const duplicate=ingest({state,receivedAtMs:START+2_000,
    raw:up('BTC',START+1_000)});
  state=duplicate.state;
  assert.equal(state.duplicateUpdates,1);
  const newest=ingest({state,receivedAtMs:START+3_000,
    raw:up('BTC',START+3_000,{
      high_price:106,low_price:94,trade_price:104,
      candle_acc_trade_volume:3,candle_acc_trade_price:307,
    })});
  state=newest.state;
  assert.equal(state.rawUpdatesReceived,3);
  assert.equal(newest.latestSnapshots,1);
  const p=prepare({state,producerSha:SHA,nowMs:END+10_000});
  assert.equal(p.status,'SEALED_SPOOL_SOURCE_ONLY');
  assert.equal(p.minuteSnapshots,1);
  assert.equal(p.rawUpdatesReceived,3);
  assert.equal(p.prepared.payload.header.rawUpdatesSeen,3);
  assert.equal(p.prepared.compactedMinutes,1);
  assert.equal(p.prepared.payload.observations[0].close,104);
  assert.equal(p.prepared.payload.observations[0].firstObservedAtMs,
    START+3_000);
  assert.equal(p.prepared.payload.header.genuineAsOfResearchCredit,false);
  assert.equal(p.profitabilityProven,false);
  assert.equal(p.archiveFilesWritten,0);
});
test('Bitget multi-candle packet inside a fixed 5m shard preserves both provisional minutes',()=>{
  let state=spool(['BTC'],['BTC'],1);
  const receivedAtMs=START+2*MIN+10_000;
  const packet={
    action:'update',
    arg:{instType:'USDT-FUTURES',channel:'candle1m',instId:'BTCUSDT'},
    data:[
      [String(START+MIN),'100','106','94','104','3','310','310'],
      [String(START),'100','105','95','103','2','205','205'],
    ],
    ts:receivedAtMs-500,
  };
  state=ingest({state,raw:packet,receivedAtMs}).state;
  const p=prepare({state,producerSha:SHA,nowMs:END+10_000});
  assert.equal(p.minuteSnapshots,2);
  assert.deepEqual(p.prepared.payload.observations.map(x=>x.timestamp),
    [START,START+MIN]);
  assert.equal(p.prepared.payload.header.executionAuthority,'NONE');
  assert.equal(p.prepared.payload.header.restClosedMinuteVerified,false);
});
test('forty 1m symbols with sixty updates each fit sealed source-only batch after compacting',async()=>{
  const symbols=Array.from({length:40},(_,i)=>'T'+String(i).padStart(4,'0'));
  let state=spool(symbols,['BTC']);
  for(let second=0;second<60;second++){
    for(const symbol of symbols){
      const nowMs=START+second*1_000+1_000;
      const raw=up(symbol,nowMs,{
        candle_acc_trade_volume:second+1,
        candle_acc_trade_price:(second+1)*100,
      });
      const step=ingest({state,raw,receivedAtMs:nowMs});
      state=step.state;
    }
  }
  assert.equal(state.rawUpdatesReceived,40*60);
  const p=prepare({state,producerSha:SHA,nowMs:END+10_000});
  assert.equal(p.rawUpdatesReceived,2400);
  assert.equal(p.minuteSnapshots,40);
  assert.equal(p.prepared.payload.header.rawUpdatesSeen,2400);
  assert.equal(p.prepared.payload.header.observedRows,40);
  assert.equal(p.prepared.payload.header.restClosedMinuteVerified,false);
  const root=await mkdtemp(join(tmpdir(),'ws-spool-pressure-'));
  try{
    const first=await persist({enabled:true,operatorApproved:true,
      root,prepared:p.prepared,freeBytes:6*1024**3});
    assert.equal(first.status,'SEALED_PROVISIONAL_ONLY');
    const second=await persist({enabled:true,operatorApproved:true,
      root,prepared:p.prepared,freeBytes:6*1024**3});
    assert.equal(second.status,'REUSED_IDENTICAL');
    assert.equal(second.archiveFilesWritten,0);
    const b=await read({root,market:'CRYPTO_SPOT',
      socketDigest:state.socketDigest,producerSha:SHA,
      startMs:START,endMs:END});
    assert.equal(b.status,'PROVISIONAL_READBACK_ONLY');
    assert.equal(b.observations.length,40);
    assert.equal(b.immutableOriginalMinuteProven,false);
    assert.equal(b.executionAuthority,'NONE');
  }finally{await rm(root,{recursive:true,force:true});}
});
test('out-of-shard, unclosed and conflicting input does not mutate previously buffered minutes',()=>{
  let state=spool();
  state=ingest({state,raw:up('BTC',START+1_000),
    receivedAtMs:START+1_000}).state;
  assert.throws(()=>ingest({state,receivedAtMs:END+1_000,
    raw:up('BTC',END+1_000,{
      candle_date_time_utc:new Date(END).toISOString().slice(0,19),
    })}),/WS_SPOOL_SOURCE_WINDOW_INVALID/);
  assert.throws(()=>ingest({state,receivedAtMs:START+2_000,
    raw:up('BTC',START+2_000,{candle_acc_trade_volume:1})}),
  /WS_MINUTE_CUMULATIVE_REVISION_INVALID/);
  assert.throws(()=>prepare({state,producerSha:SHA,nowMs:END+4_000}),
    /WS_SPOOL_FINALIZE_TIME_OR_SHA_INVALID/);
  assert.equal(state.rawUpdatesReceived,1);
  assert.equal(Object.keys(state.latestBySymbolMinute).length,1);
  assert.equal(state.archiveFilesWritten,0);
});
