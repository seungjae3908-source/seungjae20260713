import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { persistOriginalMinutePage, MINUTE_MS } from
  '../src/four-market-minute-archive-intake-v1.mjs';
import { inspectImmutableMinuteDayRollupV1 } from
  '../src/four-market-minute-daily-rollup-v1.mjs';

const DAY_MS=86_400_000;
const DAY=Date.parse('2026-10-10T00:00:00Z');
const RETRIEVED=DAY+2*DAY_MS;
const SHA1='a'.repeat(40),SHA2='b'.repeat(40);
const stock=['KR_STOCK','US_STOCK'];
const baseRow=ts=>({
  timestamp:ts,open:100,high:106,low:97,close:101,
  volume:10,quoteVolume:1010,
});
const task=(market,symbol,start,end)=>({
  market,symbol,windowStartMs:start,windowEndMs:end,
});
const opts=(root,other={})=>({
  root,market:'CRYPTO_SPOT',symbol:'BTC',
  day:'2026-10-10',researchSha:SHA2,
  asOfMs:RETRIEVED,inspectionNowMs:RETRIEVED,
  timeframes:['1m','3m','5m','15m','60m'],
  ...other,
});
async function room(fn){
  const root=await mkdtemp(join(tmpdir(),'minute-day-rollup-'));
  try {return await fn(root);}
  finally {await rm(root,{recursive:true,force:true});}
}
async function store(root,market,symbol,start,end,mutate=null,sha=SHA1){
  const rows=[];
  for(let ts=start;ts<end;ts+=MINUTE_MS){
    const row=baseRow(ts);
    rows.push(mutate?.(row)??row);
  }
  return persistOriginalMinutePage({
    root,task:task(market,symbol,start,end),
    researchSha:sha,rows,
    retrievedAtMs:RETRIEVED,
  });
}

test('no installed archive is BLOCKED, not zero opportunities or a trading signal',async()=>{
  await room(async root=>{
    const r=await inspectImmutableMinuteDayRollupV1(opts(root));
    assert.equal(r.status,'BLOCKED_DATA');
    assert.equal(r.reason,'NO_ORIGINAL_MINUTE_PAGES');
    assert.equal(r.missingOneMinuteSlots,1440);
    assert.equal(r.derivedReport,null);
    assert.equal(r.profitabilityProven,false);
    assert.equal(r.executionAuthority,'NONE');
  });
});
test('12 original UTC 120m pages produce 1/3/5/15/60m bars with exact closed source',async()=>{
  await room(async root=>{
    for(let i=0;i<12;i++) {
      const a=DAY+i*120*MINUTE_MS;
      const receipt=await store(root,'CRYPTO_SPOT','BTC',a,a+120*MINUTE_MS);
      assert.equal(receipt.status,'ARCHIVED');
    }
    const report=await inspectImmutableMinuteDayRollupV1(opts(root));
    assert.equal(report.status,'SOURCE_ONLY_COMPLETE_DAY_MINUTES');
    assert.equal(report.sourceMinuteRows,1440);
    assert.equal(report.sourceMinutePages,12);
    assert.equal(report.missingOneMinuteSlots,0);
    assert.equal(report.completeOriginalMinuteSlots,true);
    assert.equal(report.sourceArchiveDigestVerified,true);
    assert.equal(report.derivedReport.intervalData['1m'].completeBarCount,1440);
    assert.equal(report.derivedReport.intervalData['3m'].completeBarCount,480);
    assert.equal(report.derivedReport.intervalData['5m'].completeBarCount,288);
    assert.equal(report.derivedReport.intervalData['15m'].completeBarCount,96);
    assert.equal(report.derivedReport.intervalData['60m'].completeBarCount,24);
    const first=report.derivedReport.intervalData['5m'].bars[0];
    assert.equal(first.open,100);
    assert.equal(first.high,106);
    assert.equal(first.low,97);
    assert.equal(first.close,101);
    assert.equal(first.volume,50);
    assert.equal(first.startMs,DAY);
    assert.equal(first.endMs,DAY+5*MINUTE_MS);
    assert.equal(first.availableAtMs,RETRIEVED);
    assert.equal(report.originalProducerShas.length,1);
    assert.equal(report.originalProducerShas[0],SHA1);
    assert.equal(report.independentlyAuthenticatedPIT,false);
    assert.equal(report.genuineScannerTimeAvailabilityProven,false);
    assert.equal(report.providerGETCount,0);
    assert.equal(report.archiveFilesWritten,0);
    assert.equal(report.profitabilityProven,false);
    assert.equal(report.paperAdmissionAllowed,false);
  });
});
// Use a separate sparse test: source writer skips a missing observed minute,
// leaving a valid, sealed original source page with explicit sparse rows.
test('sparse Upbit minutes retain missing-source blockers and unaffected completed buckets',async()=>{
  await room(async root=>{
    const rows=Array.from({length:120},(_,i)=>baseRow(DAY+i*MINUTE_MS))
      .filter(row=>row.timestamp!==DAY+4*MINUTE_MS);
    const persisted=await persistOriginalMinutePage({
      root,task:task('CRYPTO_SPOT','BTC',DAY,DAY+120*MINUTE_MS),
      researchSha:SHA1,rows,retrievedAtMs:RETRIEVED,
    });
    assert.equal(persisted.status,'ARCHIVED');
    const r=await inspectImmutableMinuteDayRollupV1(opts(root));
    assert.equal(r.status,'SOURCE_ONLY_PARTIAL_DAY_MINUTES');
    assert.equal(r.sourceMinuteRows,119);
    assert.equal(r.missingOneMinuteSlots,1321);
    assert.equal(r.derivedReport.intervalData['5m'].completeBarCount,23);
    assert.equal(r.derivedReport.intervalData['5m'].missingUnverifiedSourceBuckets,265);
    assert.equal(r.derivedReport.intervalData['5m'].bars[0].startMs,DAY+5*MINUTE_MS);
    assert.equal(r.missingOneMinutePreview[0],new Date(DAY+4*MINUTE_MS).toISOString());
    assert.equal(r.profitabilityProven,false);
  });
});
test('UTC midnight split source pages are counted for the correct day, not dropped',async()=>{
  await room(async root=>{
    await store(root,'CRYPTO_FUTURES','BTCUSDT',
      DAY-60*MINUTE_MS,DAY+60*MINUTE_MS);
    const r=await inspectImmutableMinuteDayRollupV1(opts(root,{
      market:'CRYPTO_FUTURES',symbol:'BTCUSDT',
    }));
    assert.equal(r.sourceMinuteRows,60);
    assert.equal(r.sourceMinutePages,1);
    assert.equal(r.missingOneMinuteSlots,1380);
    assert.equal(r.derivedReport.intervalData['60m'].completeBarCount,1);
    assert.equal(r.derivedReport.intervalData['60m'].bars[0].startMs,DAY);
  });
});
test('original minute time availability is actual retrospective retrieval, not historic bar closure',async()=>{
  await room(async root=>{
    await store(root,'CRYPTO_SPOT','BTC',DAY,DAY+120*MINUTE_MS);
    const at=DAY+3*60*MINUTE_MS;
    const r=await inspectImmutableMinuteDayRollupV1(opts(root,{asOfMs:at}));
    assert.equal(r.status,'SOURCE_ONLY_PARTIAL_DAY_MINUTES');
    assert.equal(r.derivedReport.intervalData['5m'].completeBarCount,0);
    assert.ok(r.derivedReport.intervalData['5m'].barDataUnavailableAtCutoffBuckets>0);
    assert.equal(r.derivedReport.sourceMinuteIntegrityVerified,true);
    assert.equal(r.genuineScannerTimeAvailabilityProven,false);
  });
});
test('conflicting overlapping sealed minute observations reject rollup instead of picking the latest',async()=>{
  await room(async root=>{
    await store(root,'CRYPTO_SPOT','BTC',DAY,DAY+120*MINUTE_MS);
    await store(root,'CRYPTO_SPOT','BTC',DAY+60*MINUTE_MS,DAY+180*MINUTE_MS,
      row=>row.timestamp===DAY+60*MINUTE_MS?{...row,close:103}:row);
    await assert.rejects(inspectImmutableMinuteDayRollupV1(opts(root)),
      /MINUTE_ROLLUP_OVERLAPPING_SOURCE_CONFLICT/);
  });
});
test('identical repeated minute windows deduplicate but cannot inflate source count',async()=>{
  await room(async root=>{
    await store(root,'CRYPTO_SPOT','BTC',DAY,DAY+120*MINUTE_MS);
    await store(root,'CRYPTO_SPOT','BTC',DAY+60*MINUTE_MS,DAY+180*MINUTE_MS);
    const r=await inspectImmutableMinuteDayRollupV1(opts(root));
    assert.equal(r.sourceMinuteRows,180);
    assert.equal(r.duplicateOverlappingSourceRows,60);
    assert.equal(r.missingOneMinuteSlots,1260);
    assert.equal(r.profitabilityProven,false);
  });
});
test('unsafe symlinks and unsealed temporary archive records block without file mutation',async()=>{
  await room(async root=>{
    await store(root,'CRYPTO_SPOT','BTC',DAY,DAY+120*MINUTE_MS);
    const daydir=join(root,'CRYPTO_SPOT','BTC','2026-10-10');
    const extra=join(daydir,'.minute-tmp-unfinished');
    await writeFile(extra,'broken',{mode:0o600});
    await assert.rejects(inspectImmutableMinuteDayRollupV1(opts(root)),
      /MINUTE_ROLLUP_UNEXPECTED_ARCHIVE_ENTRY/);
    await rm(extra);
    const entries=await readdir(daydir);
    const dest=join(daydir,entries[0]);
    await rm(dest);
    await symlink(join(root,'something-else'),dest);
    await assert.rejects(inspectImmutableMinuteDayRollupV1(opts(root)),
      /MINUTE_ROLLUP_UNEXPECTED_ARCHIVE_ENTRY/);
  });
});
test('stocks do not receive synthetic UTC trading sessions from crypto-only material',async()=>{
  for(const market of stock){
    const r=await inspectImmutableMinuteDayRollupV1({
      market,symbol:market==='KR_STOCK'?'005930':'AAPL',
      day:'2026-10-10',inspectionNowMs:RETRIEVED,asOfMs:RETRIEVED,
    });
    assert.equal(r.status,'BLOCKED_DATA');
    assert.equal(r.reason,'STOCK_EXCHANGE_SESSION_SOURCE_NOT_CONNECTED');
    assert.equal(r.derivedReport,null);
  }
});
test('invalid day/future inspection/intervals reject without reading the archive',async()=>{
  await room(async root=>{
    for(const override of [
      {day:'2026-02-30'},
      {day:'2026-13-01'},
      {asOfMs:RETRIEVED+100_000},
      {timeframes:['__proto__']},
      {timeframes:['1m','1m']},
    ])await assert.rejects(inspectImmutableMinuteDayRollupV1(opts(root,override)),
      /MINUTE_ROLLUP_/);
  });
});
test('CLI requires explicit read-only owner approval; dry-run makes no provider or file calls',()=>{
  const cli=new URL('../bin/four-market-minute-rollup-status.mjs',import.meta.url).pathname;
  const dry=spawnSync(process.execPath,[cli,'--dry-run'],{
    encoding:'utf8',timeout:8_000,env:{PATH:process.env.PATH},
  });
  assert.equal(dry.status,0,dry.stderr);
  assert.equal(JSON.parse(dry.stdout).status,'DISABLED');
  const blocked=spawnSync(process.execPath,[
    cli,'--inspect','--market=CRYPTO_SPOT','--symbol=BTC','--day=2026-10-10',
  ],{encoding:'utf8',timeout:8_000,env:{PATH:process.env.PATH}});
  assert.equal(blocked.status,2);
  assert.equal(JSON.parse(blocked.stdout).reason,
    'MINUTE_ROLLUP_OWNER_READONLY_APPROVAL_REQUIRED');
});
