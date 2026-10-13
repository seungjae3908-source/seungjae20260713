import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { persistOriginalMinutePage, readOriginalMinutePage, MINUTE_MS } from
  '../src/four-market-minute-archive-intake-v1.mjs';
import { inspectImmutableMinuteDayRollupV1 } from
  '../src/four-market-minute-daily-rollup-v1.mjs';
import {
  readImmutableMinuteRecheckEvidenceV1,reconcileMissingOriginalMinuteWindowV1,
  MINUTE_RECHECK_LIMITS,
} from '../src/four-market-minute-gap-recheck-v1.mjs';

const START=Date.parse('2026-10-10T00:00:00Z'),DAY=86_400_000;
const RETRIEVED=START+2*DAY,SHA1='a'.repeat(40),SHA2='b'.repeat(40);
const task={market:'CRYPTO_SPOT',symbol:'BTC',
  windowStartMs:START,windowEndMs:START+5*MINUTE_MS};
const originalRow=(t=START)=>({
  timestamp:t,open:100,high:110,low:90,close:105,volume:2,quoteVolume:210,
});
const providerRow=(t=START,change={})=>({
  market:'KRW-BTC',candle_date_time_utc:new Date(t).toISOString().slice(0,19),
  opening_price:100,high_price:110,low_price:90,trade_price:105,
  candle_acc_trade_volume:2,candle_acc_trade_price:210,...change,
});
function response(rows){return {
  ok:true,status:200,headers:{get:()=>null},
  text:async()=>JSON.stringify(rows),
};}
async function sandbox(fn) {
  const root=await mkdtemp(join(tmpdir(),'minute-gap-recheck-'));
  try{return await fn(root);}
  finally{await rm(root,{recursive:true,force:true});}
}
async function original(root,taskArg=task,rows=[originalRow()],sha=SHA1){
  return persistOriginalMinutePage({
    root,task:taskArg,researchSha:sha,rows,retrievedAtMs:RETRIEVED,
  });
}
function request(root,rows,more={}) {
  let calls=0;
  return {
    options:{
      enabled:true,persist:true,root,task,researchSha:SHA2,
      now:()=>RETRIEVED+60_000,freeBytes:6*1024**3,
      fetchImpl:async(url,init)=>{
        calls++;
        assert.equal(new URL(url).host,'api.upbit.com');
        assert.equal(init.method,'GET');
        assert.equal(init.redirect,'error');
        return response(rows);
      },...more,
    },
    get calls(){return calls;},
  };
}
test('default-OFF recheck does not touch provider or archive',async()=>{
  let calls=0;
  const result=await reconcileMissingOriginalMinuteWindowV1({
    root:'/does-not-exist',fetchImpl:async()=>{calls++;return response([]);},
  });
  assert.equal(result.status,'DISABLED');
  assert.equal(result.providerGETCount,0);
  assert.equal(result.filesWritten,0);
  assert.equal(result.executionAuthority,'NONE');
  assert.equal(calls,0);
});
test('without original immutable page, recheck never creates substitute history',async()=>{
  await sandbox(async root=>{
    const req=request(root,[providerRow()]);
    const res=await reconcileMissingOriginalMinuteWindowV1(req.options);
    assert.equal(res.status,'BLOCKED_BASE_ORIGINAL_MISSING');
    assert.equal(res.providerGETCount,0);
    assert.equal(req.calls,0);
  });
});
test('persist=true fails disk gate before provider calls or new source evidence',async()=>{
  await sandbox(async root=>{
    await original(root);
    const req=request(root,[providerRow(),providerRow(START+MINUTE_MS)],{freeBytes:100});
    const result=await reconcileMissingOriginalMinuteWindowV1(req.options);
    assert.equal(result.status,'HOLD_DISK');
    assert.equal(result.providerGETCount,0);
    assert.equal(req.calls,0);
    assert.ok(MINUTE_RECHECK_LIMITS.minDiskFreeBytes>=5*1024**3);
  });
});
test('first recheck archives only genuinely new candles as immutable supplemental receipt',async()=>{
  await sandbox(async root=>{
    await original(root);
    const initial=await readOriginalMinutePage(root,task,SHA2);
    const baseDigest=initial.contentDigest;
    const req=request(root,[
      providerRow(START),providerRow(START+MINUTE_MS),
      providerRow(START+2*MINUTE_MS),providerRow(START+4*MINUTE_MS),
    ]);
    const rec=await reconcileMissingOriginalMinuteWindowV1(req.options);
    assert.equal(rec.status,'IMMUTABLE_SUPPLEMENT_ARCHIVED');
    assert.equal(rec.providerGETCount,1);
    assert.equal(rec.filesWritten,1);
    assert.equal(rec.addedCandleCount,3);
    assert.equal(rec.unverifiedMissingMinuteSlots,1);
    const base=await readOriginalMinutePage(root,task,SHA2);
    assert.equal(base.contentDigest,baseDigest);
    assert.equal(base.researchSha,SHA1);
    assert.equal(base.candleCount,1);
    const evid=await readImmutableMinuteRecheckEvidenceV1({
      root,task,researchSha:SHA2,nowMs:RETRIEVED+60_000,
    });
    assert.equal(evid.receipts.length,1);
    assert.equal(evid.supplementalUniqueMinutes,3);
    assert.equal(evid.availableRows.length,4);
    assert.equal(evid.unverifiedMissingMinuteSlots,1);
    assert.equal(evid.availableRows[1].availableAtMs,RETRIEVED+60_000);
    assert.equal(evid.availableRows[0].availableAtMs,RETRIEVED);
    assert.equal(evid.allAbsencesClassified,false);
    assert.equal(evid.providerGETCount,0);
    assert.equal(req.calls,1);
    const repeat=await reconcileMissingOriginalMinuteWindowV1(req.options);
    assert.equal(repeat.status,'NO_NEW_CANDLES_OBSERVED');
    assert.equal(repeat.filesWritten,0);
    assert.equal((await readImmutableMinuteRecheckEvidenceV1({
      root,task,researchSha:SHA1,nowMs:RETRIEVED+60_000,
    })).receipts.length,1);
  });
});
test('two progressive public rechecks add source rows without overwriting first receipt',async()=>{
  await sandbox(async root=>{
    await original(root);
    const first=request(root,[providerRow(START),providerRow(START+MINUTE_MS)]);
    const r1=await reconcileMissingOriginalMinuteWindowV1(first.options);
    assert.equal(r1.addedCandleCount,1);
    const second=request(root,[
      providerRow(START),providerRow(START+MINUTE_MS),
      providerRow(START+2*MINUTE_MS),providerRow(START+3*MINUTE_MS),
      providerRow(START+4*MINUTE_MS),
    ],{now:()=>RETRIEVED+120_000});
    const r2=await reconcileMissingOriginalMinuteWindowV1(second.options);
    assert.equal(r2.addedCandleCount,3);
    assert.equal(r2.unverifiedMissingMinuteSlots,0);
    const merged=await readImmutableMinuteRecheckEvidenceV1({
      root,task,researchSha:SHA2,nowMs:RETRIEVED+120_000,
    });
    assert.equal(merged.receipts.length,2);
    assert.equal(merged.availableRows.length,5);
    assert.equal(merged.unverifiedMissingMinuteSlots,0);
    assert.equal(merged.allAbsencesClassified,false);
    assert.equal(merged.availableRows[1].availableAtMs,RETRIEVED+60_000);
    assert.equal(merged.availableRows[4].availableAtMs,RETRIEVED+120_000);
    assert.equal((await readOriginalMinutePage(root,task,SHA1)).candleCount,1);
  });
});
test('source price/quote volume revision is blocked, not silently used as gap correction',async()=>{
  await sandbox(async root=>{
    await original(root);
    const wrong=request(root,[
      providerRow(START,{trade_price:104}),providerRow(START+MINUTE_MS),
    ]);
    await assert.rejects(reconcileMissingOriginalMinuteWindowV1(wrong.options),
      /MINUTE_RECHECK_CONFLICTING_SOURCE_REVISION/);
    assert.equal((await readdir(root)).includes('minute-rechecks-v1'),false);
    assert.equal((await readOriginalMinutePage(root,task,SHA1)).candleCount,1);
  });
});
test('a provider returning no additional candle cannot certify Upbit no-trade intervals',async()=>{
  await sandbox(async root=>{
    await original(root);
    const req=request(root,[providerRow(START)]);
    const res=await reconcileMissingOriginalMinuteWindowV1(req.options);
    assert.equal(res.status,'NO_NEW_CANDLES_OBSERVED');
    assert.equal(res.unverifiedMissingMinuteSlots,4);
    assert.equal(res.noTradeIndependentlyCertified,false);
    assert.equal(res.filesWritten,0);
    assert.equal((await readdir(root)).includes('minute-rechecks-v1'),false);
  });
});
test('readback rejects a tampered immutable supplement and cannot alter existing original',async()=>{
  await sandbox(async root=>{
    await original(root);
    const req=request(root,[providerRow(START),providerRow(START+MINUTE_MS)]);
    await reconcileMissingOriginalMinuteWindowV1(req.options);
    const path=join(root,'minute-rechecks-v1','CRYPTO_SPOT','BTC','2026-10-10');
    const names=await readdir(path);
    assert.equal(names.length,1);
    const originalData=await readFile(join(path,names[0]),'utf8');
    const row=JSON.parse(originalData);
    row.candles[0].close=999;
    await writeFile(join(path,names[0]),JSON.stringify(row),{mode:0o600});
    await assert.rejects(readImmutableMinuteRecheckEvidenceV1({
      root,task,researchSha:SHA1,nowMs:RETRIEVED+120_000,
    }),/MINUTE_RECHECK_RECEIPT_INVALID/);
    assert.equal((await readOriginalMinutePage(root,task,SHA1)).candleCount,1);
  });
});
test('symlink in supplement directory is rejected without following attacker target',async()=>{
  await sandbox(async root=>{
    await original(root);
    const rechecks=join(root,'minute-rechecks-v1');
    await symlink(root,rechecks);
    await assert.rejects(readImmutableMinuteRecheckEvidenceV1({
      root,task,researchSha:SHA1,nowMs:RETRIEVED+120_000,
    }),/MINUTE_RECHECK_DIRECTORY_UNSAFE/);
  });
});
test('read-only recheck observes possible additional source without writing new pages',async()=>{
  await sandbox(async root=>{
    await original(root);
    const req=request(root,[providerRow(START),providerRow(START+MINUTE_MS)],{
      persist:false,freeBytes:null,
    });
    const r=await reconcileMissingOriginalMinuteWindowV1(req.options);
    assert.equal(r.status,'NEW_CANDLES_OBSERVED_NOT_SAVED');
    assert.equal(r.addedCandleCount,1);
    assert.equal(r.filesWritten,0);
    assert.equal((await readdir(root)).includes('minute-rechecks-v1'),false);
  });
});
test('repaired source participates in timeframes only after actual later retrieval time',async()=>{
  await sandbox(async root=>{
    const oneHour={
      market:'CRYPTO_SPOT',symbol:'BTC',
      windowStartMs:START,windowEndMs:START+60*MINUTE_MS,
    };
    await original(root,oneHour,[originalRow(START)]);
    const provider=Array.from({length:60},(_,i)=>providerRow(START+i*MINUTE_MS));
    const req=request(root,provider,{task:oneHour});
    const repaired=await reconcileMissingOriginalMinuteWindowV1(req.options);
    assert.equal(repaired.addedCandleCount,59);
    const historic=await inspectImmutableMinuteDayRollupV1({
      root,market:'CRYPTO_SPOT',symbol:'BTC',day:'2026-10-10',
      researchSha:SHA2,
      asOfMs:START+60*MINUTE_MS,inspectionNowMs:RETRIEVED+60_000,
      timeframes:['1m','5m','60m'],
    });
    assert.equal(historic.sourceMinuteRows,60);
    assert.equal(historic.supplementalReceiptCount,1);
    assert.equal(historic.supplementalUniqueMinuteObservations,59);
    assert.equal(historic.derivedReport.intervalData['5m'].completeBarCount,0);
    assert.equal(historic.genuineScannerTimeAvailabilityProven,false);
    const retrospective=await inspectImmutableMinuteDayRollupV1({
      root,market:'CRYPTO_SPOT',symbol:'BTC',day:'2026-10-10',
      researchSha:SHA1,
      asOfMs:RETRIEVED+60_000,inspectionNowMs:RETRIEVED+60_000,
      timeframes:['1m','5m','60m'],
    });
    assert.equal(retrospective.sourceMinuteRows,60);
    assert.equal(retrospective.derivedReport.intervalData['5m'].completeBarCount,12);
    assert.equal(retrospective.derivedReport.intervalData['60m'].completeBarCount,1);
    assert.equal(retrospective.derivedReport.intervalData['5m'].bars[0].availableAtMs,
      RETRIEVED+60_000);
    assert.equal(retrospective.missingOneMinuteSlots,1380);
    assert.equal(retrospective.profitabilityProven,false);
  });
});
