import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  QUEUE_LIMITS, SCOPE_CONTRACT, validateBackfillScope, createBackfillQueue,
  verifyBackfillQueue, pickBackfillWindow, applyBackfillOutcome,
  readBackfillQueue, writeBackfillQueue, runDurableMinuteBackfillCycle,
} from '../src/four-market-minute-backfill-queue-v1.mjs';
import { MINUTE_MS, persistOriginalMinutePage } from
  '../src/four-market-minute-archive-intake-v1.mjs';

const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const START = Date.parse('2026-10-09T00:00:00.000Z');
const END = START + 240 * MINUTE_MS;
const NOW = END + 600 * MINUTE_MS;
const SPOT = { market:'CRYPTO_SPOT',symbol:'BTC',startMs:START,endMs:END };
const FUTURE = { market:'CRYPTO_FUTURES',symbol:'BTCUSDT',startMs:START,endMs:END };
const manifest = (ranges=[SPOT,FUTURE])=>({schemaVersion:SCOPE_CONTRACT,ranges});
const row=(timestamp=START)=>({timestamp,open:100,high:110,low:90,close:105,volume:2,quoteVolume:1000});
const apiResponse=body=>({ok:true,status:200,headers:{get:()=>null},text:async()=>JSON.stringify(body)});
function fakeFetch(counter) {
  return async urlString=>{
    counter.calls++;
    const u=new URL(urlString);
    if(u.hostname==='api.upbit.com') {
      const t=Date.parse(u.searchParams.get('to'))-MINUTE_MS;
      return apiResponse([{market:'KRW-BTC',
        candle_date_time_utc:new Date(t).toISOString().slice(0,19),
        opening_price:100,high_price:110,low_price:90,trade_price:105,
        candle_acc_trade_volume:2,candle_acc_trade_price:1000}]);
    }
    if(u.hostname==='api.bitget.com') {
      const t=Number(u.searchParams.get('startTime'))+MINUTE_MS;
      return apiResponse({code:'00000',data:[[String(t),'100','110','90','105','2','1000']]});
    }
    throw Error('Unexpected provider host');
  };
}
async function workspace(fn) {
  const base=await mkdtemp(join(tmpdir(),'minute-queue-'));
  const archive=join(base,'archive');
  const queue=join(base,'queue');
  try {
    await mkdir(archive,{mode:0o700});
    await mkdir(queue,{mode:0o700});
    return await fn({base,archive,queue});
  } finally { await rm(base,{recursive:true,force:true}); }
}
test('scope is canonical independent of manifest order; reject forged, overlapping identities',()=>{
  const a=validateBackfillScope(manifest());
  const b=validateBackfillScope(manifest([FUTURE,SPOT]));
  assert.equal(a.scopeDigest,b.scopeDigest);
  assert.deepEqual(a.ranges.map(v=>v.market),['CRYPTO_FUTURES','CRYPTO_SPOT']);
  for(const wrong of [
    manifest([]),manifest([SPOT,SPOT]),
    manifest([{...SPOT,symbol:'../../../tmp'}]),
    manifest([{...SPOT,startMs:START+1}]),
    manifest([{...SPOT,endMs:START}]),
    manifest([{...SPOT,market:'CASH_SHORT'}]),
  ]) assert.throws(()=>validateBackfillScope(wrong),/MINUTE_/);
});
test('progress cursor round-robins markets and refuses forged or completed range',()=>{
  const scope=validateBackfillScope(manifest());
  const first=createBackfillQueue({scope,researchSha:SHA1,atMs:NOW});
  assert.equal(verifyBackfillQueue(first,scope),first);
  const choice=pickBackfillWindow(first,NOW);
  assert.equal(choice.task.windowEndMs,START+120*MINUTE_MS);
  const next=applyBackfillOutcome(first,choice,{market:choice.task.market,
    symbol:choice.task.symbol,status:'ARCHIVED',candleCount:1},NOW,SHA1);
  assert.equal(next.nextIndex,1);
  assert.equal(pickBackfillWindow(next,NOW).index,1);
  assert.throws(()=>applyBackfillOutcome(next,{...choice,task:{...choice.task,
    windowStartMs:START+MINUTE_MS}},
  {market:choice.task.market,symbol:choice.task.symbol,status:'ARCHIVED',candleCount:1},
  NOW,SHA1),/TASK_MISMATCH/);
  assert.throws(()=>verifyBackfillQueue({...next,economicEvidenceCredit:1},scope),/STATE_INVALID/);
  assert.throws(()=>verifyBackfillQueue({...next,stateDigest:'0'.repeat(64)},scope),/STATE_INVALID/);
});

test('legacy 120m scope digest stays stable; opt-in 180m has independent queue',async()=>{
  const legacy=manifest([SPOT]);
  const first=validateBackfillScope(legacy);
  const same=validateBackfillScope({...legacy,pageWindowMinutes:120});
  assert.equal(first.scopeDigest,same.scopeDigest);
  assert.equal(first.pageWindowMinutes,120);
  const pilot=validateBackfillScope({...legacy,pageWindowMinutes:180});
  assert.equal(pilot.pageWindowMinutes,180);
  assert.notEqual(pilot.scopeDigest,first.scopeDigest);
  for(const pageWindowMinutes of [0,121,181,200,-1,'180']) {
    assert.throws(()=>validateBackfillScope({...legacy,pageWindowMinutes}),
      /MINUTE_QUEUE_PAGE_WINDOW_INVALID/);
  }
  await workspace(async({queue})=>{
    const q=createBackfillQueue({scope:first,researchSha:SHA1,atMs:NOW});
    await writeBackfillQueue(queue,first,q);
    await assert.rejects(readBackfillQueue(queue,pilot),/MINUTE_QUEUE_STATE_INVALID/);
    assert.equal((await readBackfillQueue(queue,first)).stateDigest,q.stateDigest);
  });
});
test('180m opt-in queue seals and archives two 180-minute pages without trading',async()=>{
  await workspace(async({queue,archive})=>{
    const m={...manifest([{...SPOT,endMs:START+360*MINUTE_MS}]),
      pageWindowMinutes:180};
    const scope=validateBackfillScope(m);
    const q=createBackfillQueue({scope,researchSha:SHA1,atMs:NOW});
    assert.equal(q.pageWindowMinutes,180);
    assert.equal(verifyBackfillQueue(q,scope),q);
    const first=pickBackfillWindow(q,NOW);
    assert.equal(first.task.windowEndMs,START+180*MINUTE_MS);
    const counter={calls:0};
    const options={enabled:true,queueRoot:queue,archiveRoot:archive,
      manifest:m,researchSha:SHA1,now:()=>NOW,
      fetchImpl:fakeFetch(counter),sleep:async()=>{},
      freeBytes:6*1024**3,maxActions:2};
    const result=await runDurableMinuteBackfillCycle(options);
    assert.equal(result.providerCalls,2);
    assert.equal(result.completeCount,1);
    assert.equal(result.status,'PLANNED_WINDOWS_ARCHIVED_SOURCE_LIMITED');
    assert.equal(result.unverifiedMissingMinuteSlots,358);
    assert.equal(result.executionAuthority,'NONE');
    const stored=await readBackfillQueue(queue,scope);
    assert.equal(stored.ranges[0].completedPages,2);
    assert.equal(stored.ranges[0].cursorMs,START+360*MINUTE_MS);
    assert.equal(stored.pageWindowMinutes,180);
    assert.equal(counter.calls,2);
    await assert.rejects(readBackfillQueue(queue,
      validateBackfillScope(manifest(m.ranges))),/MINUTE_QUEUE_STATE_INVALID/);
  });
});

test('rate-limit pauses with backoff and never marks failed input complete',()=>{
  const scope=validateBackfillScope(manifest([SPOT]));
  let state=createBackfillQueue({scope,researchSha:SHA1,atMs:NOW});
  for(let attempt=1;attempt<=QUEUE_LIMITS.maxAttemptsPerWindow;attempt++) {
    const choice=pickBackfillWindow(state,NOW+attempt*2*60*60_000);
    assert.ok(choice);
    state=applyBackfillOutcome(state,choice,{market:'CRYPTO_SPOT',symbol:'BTC',
      status:'BLOCKED',error:'MINUTE_SOURCE_HTTP_429'},
      NOW+attempt*2*60*60_000,SHA1);
    assert.equal(state.ranges[0].cursorMs,START);
    assert.equal(state.ranges[0].status,
      attempt<QUEUE_LIMITS.maxAttemptsPerWindow?'BACKOFF':'NEEDS_REVIEW');
    if(attempt<QUEUE_LIMITS.maxAttemptsPerWindow) {
      assert.equal(pickBackfillWindow(state,NOW+attempt*2*60*60_000),null);
      assert.ok(state.ranges[0].retryAtMs>NOW+attempt*2*60*60_000);
    }
  }
  assert.equal(pickBackfillWindow(state,NOW+24*60*60_000),null);
});

test('shared-provider 429 holds sibling symbols across cycles while other venue can progress',async()=>{
  await workspace(async({queue,archive})=>{
    const m=manifest([SPOT,{...SPOT,symbol:'ETH'},FUTURE]);
    let upbitCalls=0,bitgetCalls=0;
    const fetchImpl=async requestUrl=>{
      const url=new URL(requestUrl);
      if(url.hostname==='api.upbit.com'){
        upbitCalls++;
        return {ok:false,status:429,headers:{get:()=>null}};
      }
      if(url.hostname==='api.bitget.com'){
        bitgetCalls++;
        const t=Number(url.searchParams.get('startTime'))+MINUTE_MS;
        return apiResponse({code:'00000',
          data:[[String(t),'100','110','90','105','2','1000']]});
      }
      throw Error('Unexpected provider host');
    };
    const opts={enabled:true,queueRoot:queue,archiveRoot:archive,
      manifest:m,researchSha:SHA1,now:()=>NOW,
      maxActions:6,fetchImpl,sleep:async()=>{},freeBytes:6*1024**3};
    const first=await runDurableMinuteBackfillCycle(opts);
    assert.equal(first.status,'HOLD_PROVIDER_RATE_LIMIT');
    assert.deepEqual(first.providerRateLimitedMarkets,['CRYPTO_SPOT']);
    assert.equal(upbitCalls,1);
    assert.equal(bitgetCalls,2);
    const next=await runDurableMinuteBackfillCycle({
      ...opts,now:()=>NOW+5*MINUTE_MS,
    });
    assert.equal(next.status,'HOLD_PROVIDER_RATE_LIMIT');
    assert.equal(next.providerCalls,0);
    assert.equal(upbitCalls,1);
    const state=await readBackfillQueue(queue,validateBackfillScope(m));
    const resumed=pickBackfillWindow(state,NOW+QUEUE_LIMITS.retryRateLimitMs);
    assert.equal(resumed.task.market,'CRYPTO_SPOT');
  });
});
test('fifth provider 429 blocks other symbols of that venue until manual review',()=>{
  const scope=validateBackfillScope(manifest([SPOT,{...SPOT,symbol:'ETH'},FUTURE]));
  let state=createBackfillQueue({scope,researchSha:SHA1,atMs:NOW});
  const index=state.ranges.findIndex(r=>r.market==='CRYPTO_SPOT'&&r.symbol==='BTC');
  const choice={index,task:{market:'CRYPTO_SPOT',symbol:'BTC',
    windowStartMs:START,windowEndMs:START+120*MINUTE_MS}};
  for(let i=0;i<QUEUE_LIMITS.maxAttemptsPerWindow;i++){
    state=applyBackfillOutcome(state,choice,{market:'CRYPTO_SPOT',
      symbol:'BTC',status:'BLOCKED',error:'MINUTE_SOURCE_HTTP_429'},
    NOW+i*2*60*60_000,SHA1);
  }
  assert.equal(state.ranges[index].status,'NEEDS_REVIEW');
  assert.equal(pickBackfillWindow(state,NOW+48*60*60_000).task.market,
    'CRYPTO_FUTURES');
});

test('private atomic state survives restart and does not silently reset on manifest change',async()=>{
  await workspace(async({queue})=>{
    const scope=validateBackfillScope(manifest());
    const state=createBackfillQueue({scope,researchSha:SHA1,atMs:NOW});
    const first=await writeBackfillQueue(queue,scope,state);
    const reread=await readBackfillQueue(queue,scope);
    assert.equal(first.stateDigest,reread.stateDigest);
    assert.equal((await lstat(join(queue,'backfill-state-v1.json'))).mode&0o077,0);
    await assert.rejects(writeBackfillQueue(queue,scope,state,null),/CONCURRENT_MODIFICATION/);
    const changed=validateBackfillScope(manifest([SPOT]));
    await assert.rejects(readBackfillQueue(queue,changed),/STATE_INVALID/);
    const fake=JSON.parse(await readFile(join(queue,'backfill-state-v1.json'),'utf8'));
    fake.ranges[0].cursorMs=END;
    await writeFile(join(queue,'backfill-state-v1.json'),JSON.stringify(fake));
    await assert.rejects(readBackfillQueue(queue,scope),/STATE_INVALID/);
  });
});
test('state root and file symlinks and hardlinks are rejected, not overwritten',async()=>{
  await workspace(async({base,queue})=>{
    const scope=validateBackfillScope(manifest([SPOT]));
    const target=join(base,'target');
    await writeFile(target,'secret',{mode:0o600});
    await symlink(target,join(queue,'backfill-state-v1.json'));
    await assert.rejects(readBackfillQueue(queue,scope),/FILE_UNSAFE/);
    await rm(join(queue,'backfill-state-v1.json'));
    await link(target,join(queue,'backfill-state-v1.json'));
    await assert.rejects(readBackfillQueue(queue,scope),/FILE_UNSAFE/);
    const alias=join(base,'alias');
    await symlink(queue,alias);
    await assert.rejects(readBackfillQueue(alias,scope),/ROOT_SYMLINK/);
  });
});
test('default OFF cycle cannot even read roots, perform provider GET or mutate state',async()=>{
  let calls=0;
  const x=await runDurableMinuteBackfillCycle({
    manifest:manifest(),fetchImpl:async()=>{calls++;throw Error('forbidden');},
  });
  assert.equal(x.status,'DISABLED');
  assert.equal(x.providerCalls,0);
  assert.equal(calls,0);
});
test('all chosen windows are retained incrementally; restart consumes durable cursors',async()=>{
  await workspace(async({queue,archive})=>{
    const counter={calls:0};
    const options={
      enabled:true,queueRoot:queue,archiveRoot:archive,
      manifest:manifest(),researchSha:SHA1,now:()=>NOW,
      fetchImpl:fakeFetch(counter),sleep:async()=>{},
      freeBytes:6*1024**3,
    };
    const phase1=await runDurableMinuteBackfillCycle({...options,maxActions:2});
    assert.equal(phase1.attempts,2);
    assert.equal(phase1.providerCalls,2);
    assert.equal(phase1.filesWritten,2);
    assert.equal(phase1.completeCount,0);
    const phase2=await runDurableMinuteBackfillCycle({
      ...options,researchSha:SHA2,maxActions:2,
    });
    assert.equal(phase2.status,'PLANNED_WINDOWS_ARCHIVED_SOURCE_LIMITED');
    assert.equal(phase2.gapAffectedPageCount,4);
    assert.equal(phase2.unverifiedMissingMinuteSlots,476);
    assert.equal(phase2.sourceSlotEvidenceStatus,'UNVERIFIED_GAPS_PRESENT');
    assert.equal(phase2.completeCount,2);
    assert.equal(phase2.providerCalls,2);
    const phase3=await runDurableMinuteBackfillCycle({
      ...options,researchSha:SHA2,maxActions:4,
    });
    assert.equal(phase3.providerCalls,0);
    assert.equal(phase3.attempts,0);
    assert.equal(counter.calls,4);
    const s=await readBackfillQueue(queue,validateBackfillScope(manifest()));
    assert.equal(s.lastUpdatedBySha,SHA2);
    assert.equal(s.ranges.every(r=>r.cursorMs===END),true);
    assert.equal(s.fullUniverseProven,false);
  });
});
test('crash between archive fsync and cursor commit reuses original without refetch',async()=>{
  await workspace(async({queue,archive})=>{
    const m=manifest([SPOT]);
    const scope=validateBackfillScope(m);
    const first=createBackfillQueue({scope,researchSha:SHA1,atMs:NOW});
    await writeBackfillQueue(queue,scope,first);
    const task=pickBackfillWindow(first,NOW).task;
    await persistOriginalMinutePage({
      root:archive,task,researchSha:SHA1,rows:[row(START)],retrievedAtMs:NOW,
    });
    const counter={calls:0};
    const completed=await runDurableMinuteBackfillCycle({
      enabled:true,queueRoot:queue,archiveRoot:archive,
      manifest:m,researchSha:SHA2,now:()=>NOW,maxActions:1,
      fetchImpl:fakeFetch(counter),sleep:async()=>{},
      freeBytes:6*1024**3,
    });
    assert.equal(completed.providerCalls,0);
    assert.equal(completed.attempts,1);
    assert.equal(completed.outcomes[0].status,'REUSED_IDENTICAL');
    assert.equal(counter.calls,0);
  });
});
test('unapproved KR/US sources block only their rows, not already admitted public crypto',async()=>{
  await workspace(async({queue,archive})=>{
    const m=manifest([{market:'KR_STOCK',symbol:'005930',startMs:START,endMs:START+MINUTE_MS},
      {...SPOT,endMs:START+MINUTE_MS}]);
    const counter={calls:0};
    const r=await runDurableMinuteBackfillCycle({
      enabled:true,queueRoot:queue,archiveRoot:archive,manifest:m,
      researchSha:SHA1,now:()=>NOW,maxActions:3,
      fetchImpl:fakeFetch(counter),sleep:async()=>{},
      freeBytes:6*1024**3,
    });
    assert.equal(r.status,'NEEDS_REVIEW');
    assert.equal(r.reviewCount,1);
    assert.equal(r.completeCount,1);
    assert.equal(r.providerCalls,1);
    assert.equal(counter.calls,1);
    assert.equal(r.fullUniverseProven,false);
    assert.equal(r.independentOosProven,false);
  });
});
test('low disk holds queue without any external request',async()=>{
  await workspace(async({queue,archive})=>{
    const counter={calls:0};
    const r=await runDurableMinuteBackfillCycle({
      enabled:true,queueRoot:queue,archiveRoot:archive,
      manifest:manifest([SPOT]),researchSha:SHA1,now:()=>NOW,
      fetchImpl:fakeFetch(counter),sleep:async()=>{},
      freeBytes:QUEUE_LIMITS.maxStateBytes,
    });
    assert.equal(r.status,'HOLD_DISK');
    assert.equal(r.providerCalls,0);
    assert.equal(counter.calls,0);
  });
});
test('incomplete/future windows are held until entirely closed',()=>{
  const late={...SPOT,startMs:NOW-MINUTE_MS,endMs:NOW+MINUTE_MS};
  const scope=validateBackfillScope(manifest([late]));
  const state=createBackfillQueue({scope,researchSha:SHA1,atMs:NOW});
  assert.equal(pickBackfillWindow(state,NOW),null);
});


test('rolling current-minute collection is always bounded to closed candles and resumes later',()=>{
  const rolling={market:'CRYPTO_SPOT',symbol:'BTC',mode:'CONTINUOUS',
    startMs:NOW-2*MINUTE_MS};
  const m=manifest([SPOT,rolling]);
  const scope=validateBackfillScope(m);
  assert.equal(scope.ranges.length,2); // same symbol, different intent
  const initial=createBackfillQueue({scope,researchSha:SHA1,atMs:NOW});
  const idx=initial.ranges.findIndex(r=>r.mode==='CONTINUOUS');
  const choice=pickBackfillWindow({
    ...initial,nextIndex:idx,
  },NOW);
  assert.equal(choice.index,idx);
  assert.equal(choice.task.windowStartMs,NOW-2*MINUTE_MS);
  assert.equal(choice.task.windowEndMs,NOW-MINUTE_MS);
  const next=applyBackfillOutcome(initial,choice,{market:'CRYPTO_SPOT',
    symbol:'BTC',status:'ARCHIVED',candleCount:1},NOW,SHA1);
  assert.equal(next.ranges[idx].status,'PENDING');
  assert.equal(next.ranges[idx].cursorMs,NOW-MINUTE_MS);
  assert.equal(verifyBackfillQueue(next,scope),next);
  const later=pickBackfillWindow({...next,nextIndex:idx},NOW+4*MINUTE_MS);
  assert.equal(later.task.windowStartMs,NOW-MINUTE_MS);
  assert.equal(later.task.windowEndMs,NOW+3*MINUTE_MS);
  assert.throws(()=>validateBackfillScope(manifest([
    {...rolling,endMs:END},
  ])),/MINUTE_QUEUE_RANGE_INVALID/);
});
test('continuous one-minute receipts can be collected across timer invocations',async()=>{
  await workspace(async({queue,archive})=>{
    const m=manifest([{market:'CRYPTO_SPOT',symbol:'BTC',
      mode:'CONTINUOUS',startMs:NOW-2*MINUTE_MS}]);
    const counter={calls:0};
    const opts={enabled:true,queueRoot:queue,archiveRoot:archive,
      manifest:m,researchSha:SHA1,fetchImpl:fakeFetch(counter),
      sleep:async()=>{},freeBytes:6*1024**3};
    const first=await runDurableMinuteBackfillCycle({
      ...opts,now:()=>NOW,maxActions:2,
    });
    assert.equal(first.rollingCount,1);
    assert.equal(first.completeCount,0);
    assert.equal(first.attempts,1);
    assert.equal(first.status,'PROGRESS_RECORDED');
    const second=await runDurableMinuteBackfillCycle({
      ...opts,researchSha:SHA2,now:()=>NOW+5*MINUTE_MS,maxActions:2,
    });
    assert.equal(second.attempts,1);
    assert.equal(second.providerCalls,1);
    assert.equal(second.completeCount,0);
    assert.equal(counter.calls,2);
    const state=await readBackfillQueue(queue,validateBackfillScope(m));
    assert.equal(state.ranges[0].cursorMs,NOW+4*MINUTE_MS);
    assert.equal(state.ranges[0].status,'PENDING');
  });
});


test('unsustainable all-crypto 24h minute roster is held before any network or storage changes',async()=>{
  const ranges=Array.from({length:400},(_,i)=>({
    market:'CRYPTO_FUTURES',symbol:'S'+String(i).padStart(4,'0')+'USDT',
    mode:'CONTINUOUS',startMs:START,
  }));
  let requested=0;
  const result=await runDurableMinuteBackfillCycle({
    enabled:true,
    queueRoot:'/unlikely-unconfigured-minute-queue-for-capacity',
    archiveRoot:'/unlikely-unconfigured-minute-archive-for-capacity',
    manifest:manifest(ranges),researchSha:SHA1,now:()=>NOW,
    maxActions:16,fetchImpl:async()=>{requested++; throw Error('forbidden');},
  });
  assert.equal(result.status,'HOLD_CAPACITY');
  assert.equal(result.capacity.status,'CAPACITY_MODEL_INSUFFICIENT');
  assert.equal(result.capacity.dailyRequired,4800);
  assert.equal(result.capacity.dailyAvailable,4608);
  assert.equal(result.providerCalls,0);
  assert.equal(result.filesWritten,0);
  assert.equal(requested,0);
  assert.equal(result.profitabilityProven,false);
  assert.equal(result.executionAuthority,'NONE');
});
test('stock continuous collection is not promoted without a stock calendar capacity owner',async()=>{
  const r=await runDurableMinuteBackfillCycle({
    enabled:true,
    queueRoot:'/unlikely-unconfigured-minute-queue-for-stock',
    archiveRoot:'/unlikely-unconfigured-minute-archive-for-stock',
    manifest:manifest([{market:'US_STOCK',symbol:'AAPL',
      mode:'CONTINUOUS',startMs:START}]),
    researchSha:SHA1,now:()=>NOW,
  });
  assert.equal(r.status,'HOLD_CAPACITY');
  assert.equal(r.capacity.status,'STOCK_SESSION_NOT_MODELLED');
  assert.equal(r.providerCalls,0);
});


test('a persisted archive page is not proof of all original minute slots',async()=>{
  await workspace(async({queue,archive})=>{
    const only={...SPOT,endMs:START+120*MINUTE_MS};
    const counter={calls:0};
    const params={
      enabled:true,queueRoot:queue,archiveRoot:archive,
      manifest:manifest([only]),researchSha:SHA1,
      now:()=>NOW,fetchImpl:fakeFetch(counter),sleep:async()=>{},
      freeBytes:6*1024**3,
    };
    const report=await runDurableMinuteBackfillCycle({...params,maxActions:1});
    assert.equal(report.status,'PLANNED_WINDOWS_ARCHIVED_SOURCE_LIMITED');
    assert.equal(report.completeCount,1); // scoped request-window cursor, NOT market coverage
    assert.equal(report.unverifiedMissingMinuteSlots,119);
    assert.equal(report.gapAffectedPageCount,1);
    assert.equal(report.sourceSlotEvidenceStatus,'UNVERIFIED_GAPS_PRESENT');
    const saved=await readBackfillQueue(queue,validateBackfillScope(manifest([only])));
    assert.equal(saved.ranges[0].cursorMs,only.endMs);
    assert.equal(saved.ranges[0].unverifiedMissingMinuteSlots,119);
    assert.equal(saved.ranges[0].sourceGapPages,1);
    assert.equal(saved.ranges[0].historicalMissingBeforeAudit,false);
    const resumed=await runDurableMinuteBackfillCycle({...params,maxActions:1});
    assert.equal(resumed.providerCalls,0);
    assert.equal(resumed.gapAffectedPageCount,1);
    assert.equal(counter.calls,1);
    assert.equal(resumed.status,'PLANNED_WINDOWS_ARCHIVED_SOURCE_LIMITED');
  });
});
test('forged completed-page slot audit blocks cursor change',()=>{
  const scope=validateBackfillScope(manifest([{...SPOT,endMs:START+120*MINUTE_MS}]));
  const current=createBackfillQueue({scope,researchSha:SHA1,atMs:NOW});
  const selection=pickBackfillWindow(current,NOW);
  assert.throws(()=>applyBackfillOutcome(current,selection,{
    market:'CRYPTO_SPOT',symbol:'BTC',status:'ARCHIVED',
    candleCount:1,minuteSlotAudit:{
      contract:'research-minute-source-window-slot-audit/v1',
      sourceWindowMinuteSlots:120,observedOneMinuteSlots:1,
      unverifiedMissingMinuteSlots:0,allAbsencesClassified:false,
      sourceTimelineIndependentlyAttested:false,
    },
  },NOW,SHA1),/MINUTE_QUEUE_SLOT_AUDIT_CONFLICT/);
  const clean=applyBackfillOutcome(current,selection,{
    market:'CRYPTO_SPOT',symbol:'BTC',status:'ARCHIVED',
    candleCount:120,minuteSlotAudit:{
      contract:'research-minute-source-window-slot-audit/v1',
      sourceWindowMinuteSlots:120,observedOneMinuteSlots:120,
      unverifiedMissingMinuteSlots:0,allAbsencesClassified:false,
      sourceTimelineIndependentlyAttested:false,
    },
  },NOW,SHA1);
  assert.equal(clean.ranges[0].unverifiedMissingMinuteSlots,0);
  assert.equal(clean.ranges[0].sourceGapPages,0);
  assert.equal(clean.ranges[0].status,'COMPLETE');
});
test('legacy queue cursor cannot fake having previously audited gaps',()=>{
  const scope=validateBackfillScope(manifest([SPOT]));
  const q=createBackfillQueue({scope,researchSha:SHA1,atMs:NOW});
  const selection=pickBackfillWindow(q,NOW);
  const q1=applyBackfillOutcome(q,selection,{
    market:'CRYPTO_SPOT',symbol:'BTC',status:'ARCHIVED',candleCount:1,
  },NOW,SHA1);
  const legacy={...q1.ranges[0]};
  delete legacy.sourceGapAuditVersion;
  delete legacy.sourceGapPages;
  delete legacy.unverifiedMissingMinuteSlots;
  delete legacy.historicalMissingBeforeAudit;
  const unsealed={...q1,ranges:[legacy]};
  // A non-tampered historical v1 queue really can lack modern gap fields.
  // Its previously recorded windows must remain marked UNKNOWN, never
  // silently migrated to an audited-0 counter.
  const {stateDigest:discarded,...unsigned}=unsealed;
  // Keep SHA-256 sealing identical to the repository v1 cursor contract.
  const oldFormat={...unsigned,stateDigest:createHash('sha256')
    .update(JSON.stringify(unsigned)).digest('hex')};
  assert.equal(verifyBackfillQueue(oldFormat,scope),oldFormat);
  const choice=pickBackfillWindow(oldFormat,NOW);
  const resumed=applyBackfillOutcome(oldFormat,choice,{
    market:'CRYPTO_SPOT',symbol:'BTC',status:'ARCHIVED',candleCount:120,
  },NOW,SHA2);
  assert.equal(resumed.ranges[0].historicalMissingBeforeAudit,true);
});
