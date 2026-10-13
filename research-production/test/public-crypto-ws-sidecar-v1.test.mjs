import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,chmod,readdir,writeFile,readFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {normalizePublicCryptoWsMinuteV1 as normalize} from
  '../src/public-crypto-websocket-minute-v1.mjs';
import {
  preparePublicWsProvisionalBatchV1 as prepare,
  persistPublicWsProvisionalBatchV1 as persist,
  readPublicWsProvisionalBatchV1 as read,
} from '../src/public-crypto-ws-sidecar-v1.mjs';

const START=Date.parse('2026-10-13T00:00:00Z');
const END=START+5*60_000;
const NOW=END+10_000;
const PRODUCER='a'.repeat(40);
const SHARD='b'.repeat(64);
const opts={market:'CRYPTO_SPOT',socketDigest:SHARD,producerSha:PRODUCER,
  startMs:START,endMs:END};
function packet({stamp=START,receivedAtMs=START+31_000,close=103,
  volume=2,high=105,low=97,quoteVolume=201}={}){
  return normalize({
    market:'CRYPTO_SPOT',allowedSymbols:['BTC'],
    receivedAtMs,
    raw:{
      type:'candle.1m',code:'KRW-BTC',stream_type:'REALTIME',
      candle_date_time_utc:new Date(stamp).toISOString().slice(0,19),
      timestamp:receivedAtMs-1_000,
      opening_price:100,high_price:high,low_price:low,
      trade_price:close,candle_acc_trade_volume:volume,
      candle_acc_trade_price:quoteVolume,
    },
  });
}
const batch=(observations=[packet()])=>prepare({
  enabled:true,...opts,observations,nowMs:NOW,
});
async function room(fn){
  const root=await mkdtemp(join(tmpdir(),'ws-research-sidecar-'));
  try{return await fn(root);}
  finally{await rm(root,{recursive:true,force:true});}
}
const file=root=>join(root,'CRYPTO_SPOT',SHARD,'2026-10-13',
  String(START)+'-'+String(END)+'.ws.json.gz');
test('source-only sidecar disabled by default without any filesystem root',async()=>{
  const p=prepare();
  assert.equal(p.status,'DISABLED');
  assert.equal(p.archiveFilesWritten,0);
  const result=await persist();
  assert.equal(result.status,'DISABLED');
  assert.equal(result.archiveFilesWritten,0);
  assert.equal(result.executionAuthority,'NONE');
});
test('same-minute cumulative revisions compact without inventing 1m completion',()=>{
  const a=packet(),b=packet({
    receivedAtMs:START+35_000,close:104,volume:3,
    high:106,low:96,quoteVolume:305,
  });
  const p=batch([a,b]);
  assert.equal(p.status,'SEALED_PROVISIONAL_BATCH');
  assert.equal(p.compactedMinutes,1);
  assert.equal(p.rawUpdatesSeen,2);
  assert.equal(p.payload.header.restClosedMinuteVerified,false);
  assert.equal(p.payload.observations[0].firstObservedAtMs,a.receivedAtMs);
  assert.equal(p.payload.observations[0].lastObservedAtMs,b.receivedAtMs);
  assert.equal(p.payload.observations[0].high,106);
  assert.equal(p.executionAuthority,'NONE');
  assert.equal(p.archiveFilesWritten,0);
});
test('out-of-order, forged OHLC, duplicates and future rows fail closed',()=>{
  const a=packet();
  assert.throws(()=>batch([packet({receivedAtMs:START+45_000}),
    packet({receivedAtMs:START+32_000})]),/WS_SIDECAR_EVENT_OUT_OF_ORDER/);
  const b=packet({receivedAtMs:a.receivedAtMs,close:102});
  assert.throws(()=>batch([a,b]),/WS_SIDECAR_DUPLICATE_EVENT_CONFLICT/);
  assert.throws(()=>batch([{...a,sourceId:'PRIVATE_ORDER_FEED'}]),
    /WS_SIDECAR_OBSERVATION_INVALID/);
  assert.throws(()=>batch([{...a,row:{...a.row,high:99}}]),
    /WS_SIDECAR_ROW_INVALID/);
  assert.throws(()=>batch([{...a,row:{...a.row,timestamp:END}}]),
    /WS_SIDECAR_ROW_INVALID/);
  assert.throws(()=>prepare({enabled:true,...opts,startMs:START+1,
    observations:[a],nowMs:NOW}),/WS_SIDECAR_BATCH_IDENTITY_INVALID/);
});
test('private 0700 root persists gzip immutable batch with readback and idempotency',async()=>{
  await room(async root=>{
    const p=batch([packet(),packet({
      receivedAtMs:START+35_000,close:104,volume:3,
      high:106,low:96,quoteVolume:305,
    })]);
    const options={enabled:true,operatorApproved:true,root,
      prepared:p,freeBytes:6*1024**3};
    const first=await persist(options);
    assert.equal(first.status,'SEALED_PROVISIONAL_ONLY');
    assert.equal(first.archiveFilesWritten,1);
    assert.equal(first.profitabilityProven,false);
    const next=await persist(options);
    assert.equal(next.status,'REUSED_IDENTICAL');
    assert.equal(next.archiveFilesWritten,0);
    const stored=await read({root,...opts});
    assert.equal(stored.status,'PROVISIONAL_READBACK_ONLY');
    assert.equal(stored.observations.length,1);
    assert.equal(stored.observations[0].close,104);
    assert.equal(stored.immutableOriginalMinuteProven,false);
    assert.equal(stored.paperAdmissionAllowed,false);
    assert.equal(stored.executionAuthority,'NONE');
  });
});
test('same-range incompatible batches cannot overwrite an immutable provisional receipt',async()=>{
  await room(async root=>{
    const auth={enabled:true,operatorApproved:true,root,
      freeBytes:6*1024**3};
    await persist({...auth,prepared:batch()});
    await assert.rejects(()=>persist({...auth,prepared:batch([
      packet({close:104,high:106,volume:3,quoteVolume:310}),
    ])}),/WS_SIDECAR_IMMUTABLE_CONFLICT/);
    const stored=await read({root,...opts});
    assert.equal(stored.observations[0].close,103);
  });
});
test('low disk and missing operator approval touch no storage',async()=>{
  await room(async root=>{
    const p=batch();
    const blocked=await persist({enabled:true,root,prepared:p,
      freeBytes:6*1024**3});
    assert.equal(blocked.status,'HOLD_OPERATOR_APPROVAL');
    const disk=await persist({enabled:true,operatorApproved:true,
      root,prepared:p,freeBytes:1});
    assert.equal(disk.status,'HOLD_DISK');
    assert.deepEqual(await readdir(root),[]);
  });
});
test('unsafe filesystem permissions, symlinks and readback tampering are rejected',async()=>{
  await room(async root=>{
    const p=batch();
    const base={enabled:true,operatorApproved:true,
      prepared:p,freeBytes:6*1024**3};
    const alias=root+'-alias';
    try{
      await symlink(root,alias);
      await assert.rejects(()=>persist({...base,root:alias}),
        /WS_SIDECAR_SYMLINK_ANCESTOR/);
    }finally{await rm(alias,{force:true});}
    await chmod(root,0o755);
    await assert.rejects(()=>persist({...base,root}),
      /WS_SIDECAR_ROOT_NOT_PRIVATE/);
    await chmod(root,0o700);
    await persist({...base,root});
    await writeFile(file(root),'not-gzip',{mode:0o600});
    await assert.rejects(()=>read({root,...opts}),
      /WS_SIDECAR_COMPRESSED_INVALID/);
  });
});
test('retrospective source remains distinct from self-claimed historical credit',async()=>{
  await room(async root=>{
    const p=batch();
    assert.equal(p.payload.header.status,'PROVISIONAL_ONLY');
    assert.equal(p.payload.header.genuineAsOfResearchCredit,false);
    const mut={...p,payload:{...p.payload,
      header:{...p.payload.header,producerSha:'c'.repeat(40)}}};
    await assert.rejects(()=>persist({enabled:true,operatorApproved:true,
      root,prepared:mut,freeBytes:6*1024**3}),
      /WS_SIDECAR_BATCH_MUTATED/);
    assert.deepEqual(await readdir(root),[]);
  });
});
