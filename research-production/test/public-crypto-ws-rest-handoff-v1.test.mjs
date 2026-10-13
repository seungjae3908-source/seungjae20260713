import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeUpbitKrwMinuteRoster,normalizeBitgetUsdtMinuteRoster}
  from '../src/four-market-minute-roster-capacity-v1.mjs';
import {planPublicCryptoMinuteWebsocketV1}
  from '../src/public-crypto-websocket-minute-v1.mjs';
import {createPublicCryptoWsSupervisorV1 as create,
  pollPublicCryptoWsSupervisorV1 as poll,
  observePublicCryptoWsSupervisorV1 as observe}
  from '../src/public-crypto-ws-supervisor-v1.mjs';
import {planPendingPublicWsRestAuditsV1 as plan,
  inspectAndAdvancePublicWsRestAuditV1 as inspect}
  from '../src/public-crypto-ws-rest-handoff-v1.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {persistOriginalMinutePage} from
  '../src/four-market-minute-archive-intake-v1.mjs';

const MIN=60_000,START=Date.parse('2026-10-13T00:00:00Z');
const NOW=START+30_000;
const roster={
  upbit:normalizeUpbitKrwMinuteRoster([
    {market:'KRW-BTC',market_event:{warning:false,caution:{FLAG:false}}},
  ],NOW),
  bitget:normalizeBitgetUsdtMinuteRoster({code:'00000',data:[
    {symbol:'BTCUSDT',quoteCoin:'USDT',symbolStatus:'normal',
      symbolType:'perpetual',isRwa:'NO'},
  ]},NOW),
};
function started(){
  const p=planPublicCryptoMinuteWebsocketV1({enabled:true,
    ...roster,nowMs:NOW});
  let s=create({enabled:true,plan:p,nowMs:NOW});
  s=poll({state:s,nowMs:NOW}).state;
  s=observe({state:s,socketId:s.sockets[0].id,kind:'OPEN',
    nowMs:NOW+5}).state;
  s=observe({state:s,socketId:s.sockets[0].id,kind:'SUBSCRIPTION_SENT',
    nowMs:NOW+10}).state;
  return s;
}
function pushed(s,i){
  const at=START+i*MIN+31_000,epoch=START+i*MIN;
  return observe({state:s,socketId:s.sockets[0].id,kind:'CANDLE',
    nowMs:at,raw:{
      type:'candle.1m',code:'KRW-BTC',stream_type:'REALTIME',
      candle_date_time_utc:new Date(epoch).toISOString().slice(0,19),
      timestamp:at-1_000,opening_price:100,high_price:105,
      low_price:98,trade_price:103,candle_acc_trade_volume:2,
      candle_acc_trade_price:203,
    }}).state;
}
test('240 consecutive minute rollovers coalesce into one bounded REST audit',()=>{
  let state=started();
  for(let i=0;i<=240;i++)state=pushed(state,i);
  assert.equal(state.pendingRestAudits.length,1);
  const audit=state.pendingRestAudits[0];
  assert.equal(audit.fromMs,START);
  assert.equal(audit.toExclusiveMs,START+180*MIN);
  assert.equal(audit.requestedEndExclusiveMs,START+240*MIN);
  assert.equal(audit.unverifiedBeyondCap,true);
  assert.equal(audit.sourceVerified,false);
  assert.equal(audit.restBackfillRequired,true);
  const result=plan({state,asOfMs:START+241*MIN,
    pageWindowMinutes:120});
  assert.equal(result.status,'REST_SOURCE_ONLY_AUDITS_PLANNED');
  assert.equal(result.tasks.length,1);
  assert.equal(result.tasks[0].windowStartMs,START);
  assert.equal(result.tasks[0].windowEndMs,START+120*MIN);
  assert.equal(result.tasks[0].outstandingUnverifiedTailEndMs,
    START+240*MIN);
  assert.equal(result.unverifiedTails,1);
  assert.equal(result.independentOosProven,false);
  assert.equal(result.paperAdmissionAllowed,false);
  assert.equal(result.publicProviderGETCount,0);
  assert.equal(result.executionAuthority,'NONE');
  const longer=plan({state,asOfMs:START+241*MIN,
    pageWindowMinutes:180});
  assert.equal(longer.tasks[0].windowEndMs,START+180*MIN);
});
test('WebSocket disconnect retains unknown last candle and tail beyond 180m',()=>{
  let s=started();
  s=pushed(s,0);
  const end=START+310*MIN;
  s=observe({state:s,socketId:s.sockets[0].id,
    kind:'CLOSE',nowMs:end+30_000}).state;
  assert.equal(s.pendingRestAudits.length,1);
  const p=s.pendingRestAudits[0];
  assert.equal(p.fromMs,START);
  assert.equal(p.requestedEndExclusiveMs,end);
  assert.equal(p.toExclusiveMs,START+180*MIN);
  assert.equal(p.unverifiedBeyondCap,true);
  assert.equal(s.sockets[0].phase,'BACKOFF');
  assert.equal(s.executionAuthority,'NONE');
});
test('760 market-scoped audit proposals page at most sixteen without REST calls',()=>{
  const state={
    contract:'research-public-crypto-websocket-supervisor/v1',
    status:'SIMULATION_ONLY',executionAuthority:'NONE',
    generatedFromPlanDigest:'f'.repeat(64),updatedAtMs:NOW,
    pendingRestAudits:[
      ...Array.from({length:294},(_,i)=>({
        market:'CRYPTO_SPOT',symbol:'T'+String(i).padStart(4,'0'),
        fromMs:START,toExclusiveMs:START+MIN,
        requestedEndExclusiveMs:START+MIN,unverifiedBeyondCap:false,
        observedAtMs:NOW,reason:'CLOSED_CANDLE_NEEDS_REST_FINALITY',
        sourceVerified:false,restBackfillRequired:true,
      })),
      ...Array.from({length:466},(_,i)=>({
        market:'CRYPTO_FUTURES',
        symbol:'Q'+String(i).padStart(4,'0')+'USDT',
        fromMs:START,toExclusiveMs:START+MIN,
        requestedEndExclusiveMs:START+MIN,unverifiedBeyondCap:false,
        observedAtMs:NOW,reason:'CLOSED_CANDLE_NEEDS_REST_FINALITY',
        sourceVerified:false,restBackfillRequired:true,
      })),
    ],
  };
  const first=plan({state,asOfMs:START+2*MIN,limit:16});
  assert.equal(first.tasks.length,16);
  assert.equal(first.nextIndex,16);
  assert.equal(first.remainingAuditRecords,744);
  assert.equal(first.tasks[0].sourceProvider,'UPBIT_PUBLIC_1M');
  const second=plan({state,asOfMs:START+2*MIN,limit:16,startIndex:first.nextIndex});
  assert.equal(second.tasks.length,16);
  assert.equal(second.nextIndex,32);
  assert.equal(second.tasks[0].sourceAuditIndex,16);
  assert.equal(second.publicProviderGETCount,0);
  assert.equal(second.restPagesVerified,0);
  assert.equal(second.originalMinuteProven,false);
});
test('REST handoff never accepts forged source settlement or invalid windows',()=>{
  let s=started();s=pushed(s,0);s=pushed(s,1);
  const original=s.pendingRestAudits[0];
  for(const bad of [
    {...original,sourceVerified:true},
    {...original,restBackfillRequired:false},
    {...original,requestedEndExclusiveMs:original.toExclusiveMs-60_000},
    {...original,fromMs:original.fromMs+1},
    {...original,toExclusiveMs:original.fromMs},
  ]){
    assert.throws(()=>plan({state:{...s,pendingRestAudits:[bad]},
      asOfMs:START+5*MIN}),/WS_REST_HANDOFF_AUDIT_INVALID/);
  }
  assert.throws(()=>plan({state:s,asOfMs:START,
    pageWindowMinutes:200}),/WS_REST_HANDOFF_INPUT_INVALID/);
  const p=plan({state:s,asOfMs:START+5*MIN});
  assert.equal(p.tasks[0].queryMustBeOwnerApproved,true);
  assert.equal(p.tasks[0].noTradeIndependentlyProven,false);
});

test('sealed 120m REST original verifies and advances supervisor source-only audit',async()=>{
  let state=started();
  for(let i=0;i<=120;i++)state=pushed(state,i);
  assert.equal(state.pendingRestAudits.length,1);
  assert.equal(state.pendingRestAudits[0].toExclusiveMs,START+120*MIN);
  const root=await mkdtemp(join(tmpdir(),'source-rest-audit-'));
  try{
    const task={market:'CRYPTO_SPOT',symbol:'BTC',
      windowStartMs:START,windowEndMs:START+120*MIN};
    const data=Array.from({length:120},(_,i)=>({
      timestamp:START+i*MIN,open:100,high:110,low:90,
      close:105,volume:5,quoteVolume:525,
    }));
    const sha='a'.repeat(40),retrievedAtMs=START+121*MIN;
    const missing=await inspect({state,root,researchSha:sha,
      asOfMs:retrievedAtMs+5_000,pageWindowMinutes:120});
    assert.equal(missing.status,'HOLD_SEALED_REST_ORIGINAL_MISSING');
    assert.equal(missing.updatedState,null);
    await persistOriginalMinutePage({root,task,researchSha:sha,
      rows:data,retrievedAtMs});
    const result=await inspect({state,root,researchSha:sha,
      asOfMs:retrievedAtMs+5_000,pageWindowMinutes:120});
    assert.equal(result.status,'LOCAL_REST_MINUTE_WINDOW_CONFIRMED_SOURCE_ONLY');
    assert.equal(result.restPagesVerified,1);
    assert.equal(result.completedAudit,true);
    assert.equal(result.actualRestRetrievalAtMs,retrievedAtMs);
    assert.equal(result.updatedState.pendingRestAudits.length,0);
    assert.equal(result.genuineScannerAsOfAvailabilityProven,false);
    assert.equal(result.independentOosProven,false);
    assert.equal(result.profitabilityProven,false);
    assert.equal(result.executionAuthority,'NONE');
    // The original caller's previous state is never silently modified.
    assert.equal(state.pendingRestAudits.length,1);
    assert.equal(result.publicProviderGETCount,0);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('partial immutable REST page keeps unverified Upbit no-trade/transport gap',async()=>{
  let state=started();
  for(let i=0;i<=120;i++)state=pushed(state,i);
  const root=await mkdtemp(join(tmpdir(),'source-rest-gap-'));
  try {
    const task={market:'CRYPTO_SPOT',symbol:'BTC',
      windowStartMs:START,windowEndMs:START+120*MIN};
    const rows=Array.from({length:119},(_,i)=>({
      timestamp:START+i*MIN,open:100,high:110,low:90,
      close:105,volume:5,quoteVolume:525,
    }));
    const sha='a'.repeat(40),retrievedAtMs=START+121*MIN;
    await persistOriginalMinutePage({root,task,researchSha:sha,
      rows,retrievedAtMs});
    const report=await inspect({state,root,researchSha:sha,
      asOfMs:retrievedAtMs+5_000});
    assert.equal(report.status,'HOLD_UNVERIFIED_ORIGINAL_MINUTE_GAPS');
    assert.equal(report.unverifiedMissingMinuteSlots,1);
    assert.equal(report.restPagesVerified,0);
    assert.equal(report.updatedState,null);
    assert.equal(report.profitabilityProven,false);
  }finally{await rm(root,{recursive:true,force:true});}
});
