import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {normalizePublicCryptoWsMinuteV1 as normalize}
  from '../src/public-crypto-websocket-minute-v1.mjs';
import {preparePublicWsProvisionalBatchV1 as seal,
  persistPublicWsProvisionalBatchV1 as persist}
  from '../src/public-crypto-ws-sidecar-v1.mjs';
import {planPublicWsRestartRecoveryV1 as recover}
  from '../src/public-crypto-ws-restart-recovery-v1.mjs';

const MIN=60_000,START=Date.parse('2026-10-13T00:00:00Z');
const END=START+5*MIN,NOW=END+10_000;
const META={market:'CRYPTO_SPOT',socketDigest:'a'.repeat(64),
  producerSha:'b'.repeat(40),startMs:START,endMs:END};
const raw=(symbol,timestamp,receivedAtMs)=>({
  type:'candle.1m',code:'KRW-'+symbol,stream_type:'REALTIME',
  candle_date_time_utc:new Date(timestamp).toISOString().slice(0,19),
  timestamp:receivedAtMs-1000,
  opening_price:100,high_price:106,low_price:97,trade_price:103,
  candle_acc_trade_volume:2,candle_acc_trade_price:206,
});
const obs=(symbol,timestamp,receivedAtMs)=>
  normalize({market:'CRYPTO_SPOT',allowedSymbols:['BTC','ETH'],
    raw:raw(symbol,timestamp,receivedAtMs),receivedAtMs});
async function room(fn){
  const root=await mkdtemp(join(tmpdir(),'public-ws-recovery-'));
  try{return await fn(root);}
  finally{await rm(root,{recursive:true,force:true});}
}
async function fixture(root){
  const payload=seal({enabled:true,...META,
    nowMs:NOW,
    observations:[
      obs('BTC',START+3*MIN,START+3*MIN+20_000),
      obs('BTC',START+3*MIN,START+3*MIN+30_000),
    ]});
  const stored=await persist({enabled:true,operatorApproved:true,
    root,prepared:payload,freeBytes:6*1024**3});
  assert.equal(stored.status,'SEALED_PROVISIONAL_ONLY');
}
test('default restart recovery is disabled and cannot read source root',async()=>{
  const x=await recover();
  assert.equal(x.status,'DISABLED');
  assert.equal(x.sourceAudits.length,0);
  assert.equal(x.websocketConnectionsOpened,0);
  assert.equal(x.publicProviderGETCount,0);
  assert.equal(x.executionAuthority,'NONE');
});
test('restart cannot erase the start of a shard even if its last candle was observed',async()=>{
  await room(async root=>{
    await fixture(root);
    const resumed=START+20*MIN+10_000;
    const x=await recover({enabled:true,root,...META,
      expectedSymbols:['BTC','ETH'],resumeAtMs:resumed});
    assert.equal(x.status,'RESTART_REST_SOURCE_AUDITS_REQUIRED');
    assert.equal(x.sourceAudits.length,2);
    assert.equal(x.symbolsWithProvisionalObservations,1);
    assert.equal(x.sourceAudits[0].symbol,'BTC');
    assert.equal(x.sourceAudits[0].fromMs,START);
    assert.equal(x.sourceAudits[0].entireSidecarShardRestUnverified,true);
    assert.equal(x.sourceAudits[0].requestedEndExclusiveMs,START+20*MIN);
    assert.equal(x.sourceAudits[0].missingFromSidecar,false);
    assert.equal(x.sourceAudits[1].symbol,'ETH');
    assert.equal(x.sourceAudits[1].fromMs,START);
    assert.equal(x.sourceAudits[1].missingFromSidecar,true);
    assert.ok(x.sourceAudits.every(r=>r.sourceVerified===false));
    assert.ok(x.sourceAudits.every(r=>r.noTradeIndependentlyCertified===false));
    assert.equal(x.syntheticCandlesCreated,0);
    assert.equal(x.originalMinuteProof,false);
    assert.equal(x.paperAdmissionAllowed,false);
    assert.equal(x.executionAuthority,'NONE');
  });
});
test('offline longer than 180 minutes preserves exact unresolved tail timestamp',async()=>{
  await room(async root=>{
    await fixture(root);
    const resumeAtMs=START+500*MIN+10_000;
    const x=await recover({enabled:true,root,...META,
      expectedSymbols:['BTC','ETH'],resumeAtMs,maxRestWindowMinutes:180});
    assert.equal(x.sourceAudits.length,2);
    const btc=x.sourceAudits[0];
    assert.equal(btc.fromMs,START);
    assert.equal(btc.toExclusiveMs,START+180*MIN);
    assert.equal(btc.requestedEndExclusiveMs,START+500*MIN);
    assert.equal(btc.unverifiedBeyondCap,true);
    assert.equal(btc.lastWebsocketMinuteMs,START+3*MIN);
    assert.equal(x.sourceAudits[1].toExclusiveMs,START+180*MIN);
    assert.equal(x.sourceAudits[1].requestedEndExclusiveMs,START+500*MIN);
    assert.equal(x.sourceAudits[1].unverifiedBeyondCap,true);
    assert.equal(x.publicProviderGETCount,0);
  });
});
test('missing recent sidecar is a hard manual-REST hold, not a false empty market',async()=>{
  await room(async root=>{
    const x=await recover({enabled:true,root,...META,
      expectedSymbols:['BTC'],resumeAtMs:NOW});
    assert.equal(x.status,'HOLD_SIDECAR_NOT_FOUND');
    assert.equal(x.sourceAudits.length,0);
    assert.equal(x.possibleOutageFromMs,START);
    assert.equal(x.possibleOutageToMs,NOW);
    assert.equal(x.sourceDataUnproven,true);
    assert.equal(x.executionAuthority,'NONE');
  });
});
test('restart rejects unbounded symbols and invalid time before file access',async()=>{
  for(const expectedSymbols of [['BTC','BTC'],['../TRADE'],[],
    Array.from({length:41},(_,i)=>'T'+i)]){
    await assert.rejects(()=>recover({enabled:true,root:'/private/not-opened',
      ...META,expectedSymbols,resumeAtMs:NOW}),
    /WS_RESTART_(?:INPUT|SYMBOLS)_INVALID/);
  }
  await assert.rejects(()=>recover({enabled:true,root:'/private/not-opened',
    ...META,expectedSymbols:['BTC'],resumeAtMs:END}),
  /WS_RESTART_INPUT_INVALID/);
});
