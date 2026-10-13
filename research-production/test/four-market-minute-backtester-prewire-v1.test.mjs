import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  persistOriginalMinutePage, MINUTE_MS,
} from '../src/four-market-minute-archive-intake-v1.mjs';
import {
  BACKTEST_SOURCE_CONTRACT, BACKTEST_SOURCE_LIMITS,
  prepareSealedMinuteBacktesterInputV1,
  inspectSealedMinuteBacktesterPeriodV1,
} from '../src/four-market-minute-backtester-prewire-v1.mjs';
import {
  deriveResearchTimeframesFromMinuteSourceV1,
} from '../src/research-minute-to-multiframe-reuse-v1.mjs';

const FIRST=Date.parse('2026-10-09T00:00:00.000Z');
const DAY=86_400_000;
const RETRIEVED=FIRST+3*DAY;
const SHA='a'.repeat(40);
const symbol='BTC';
async function room(fn) {
  const root=await mkdtemp(join(tmpdir(),'minute-backtest-source-prewire-'));
  try { return await fn(root); }
  finally { await rm(root,{recursive:true,force:true}); }
}
async function fillOneDay(root,start=FIRST,amount=12) {
  for(let page=0;page<amount;page++){
    const begin=start+page*120*MINUTE_MS;
    const candles=Array.from({length:120},(_,i)=>({
      timestamp:begin+i*MINUTE_MS,
      open:100,high:110,low:90,close:105,volume:2,quoteVolume:500,
    }));
    const r=await persistOriginalMinutePage({
      root,task:{market:'CRYPTO_SPOT',symbol,
        windowStartMs:begin,windowEndMs:begin+120*MINUTE_MS},
      researchSha:SHA,rows:candles,retrievedAtMs:RETRIEVED,
    });
    assert.equal(r.status,'ARCHIVED');
  }
}
const params=root=>({
  enabled:true,root,market:'CRYPTO_SPOT',symbol,
  day:'2026-10-09',researchSha:SHA,
  asOfMs:RETRIEVED,inspectionNowMs:RETRIEVED,
});

test('prewire stays disabled without explicit owner-side flag and no file is needed',async()=>{
  const r=await prepareSealedMinuteBacktesterInputV1({
    root:'/no-source',market:'CRYPTO_SPOT',symbol,day:'2026-10-09',
  });
  assert.equal(r.status,'BLOCKED_DATA');
  assert.equal(r.reason,'EXPLICIT_MODEL_SOURCE_PREWIRE_DISABLED');
  assert.equal(r.modelInput,null);
  assert.equal(r.providerGETCount,0);
  assert.equal(r.executionAuthority,'NONE');
});
test('all 12 immutable minute pages form exactly the canonical offline model source',async()=>{
  await room(async root=>{
    await fillOneDay(root);
    const r=await prepareSealedMinuteBacktesterInputV1(params(root));
    assert.equal(r.contract,BACKTEST_SOURCE_CONTRACT);
    assert.equal(r.status,'RETROSPECTIVE_RESEARCH_MODEL_INPUT_ONLY');
    assert.equal(r.sourceMinuteRows,1440);
    assert.equal(r.metadata.sourceMinutePages,12);
    assert.equal(r.modelInput.session.kind,'UTC_24H');
    assert.equal(r.modelInput.session.calendarSourceId,'CRYPTO_UTC_DAY_SOURCE_ONLY');
    assert.deepEqual(Object.keys(r.modelInput).sort(),[
      'asOfMs','market','minuteBars','session',
      'sourceId','sourceMinuteRowsSha256','symbol','venue',
    ].sort());
    assert.equal(r.modelInput.minuteBars[0].availableAtMs,RETRIEVED);
    assert.equal(r.modelInput.minuteBars.at(-1).availableAtMs,RETRIEVED);
    assert.equal(r.sourceMinuteDigest,createHash('sha256')
      .update(JSON.stringify(r.modelInput.minuteBars)).digest('hex'));
    const backtestCheck=deriveResearchTimeframesFromMinuteSourceV1({
      ...r.modelInput,timeframes:['5m','15m','1h'],
    });
    assert.equal(backtestCheck.sourceMinuteIntegrityVerified,true);
    assert.equal(backtestCheck.intervalData['5m'].completeBarCount,288);
    assert.equal(backtestCheck.intervalData['15m'].completeBarCount,96);
    assert.equal(backtestCheck.intervalData['1h'].completeBarCount,24);
    assert.equal(r.providerGETCount,0);
    assert.equal(r.archiveFilesWritten,0);
    assert.equal(r.historicalPITProven,false);
    assert.equal(r.independentOosProven,false);
    assert.equal(r.paperAdmissionAllowed,false);
    assert.equal(r.actualFillsProven,false);
    assert.equal(r.profitabilityProven,false);
    assert.equal(r.executionAuthority,'NONE');
  });
});
test('one original page short never becomes a candidate source to a backtester',async()=>{
  await room(async root=>{
    await fillOneDay(root,FIRST,11);
    const x=await prepareSealedMinuteBacktesterInputV1(params(root));
    assert.equal(x.status,'BLOCKED_DATA');
    assert.equal(x.modelInput,null);
    assert.equal(x.metadata.missingOneMinuteSlots,120);
    assert.equal(x.metadata.archiveStatus,'SOURCE_ONLY_PARTIAL_DAY_MINUTES');
    assert.equal(x.paperAdmissionAllowed,false);
  });
});
test('retrospective 1m bars are unavailable at the original historical signal time',async()=>{
  await room(async root=>{
    await fillOneDay(root,FIRST,12);
    const x=await prepareSealedMinuteBacktesterInputV1({
      ...params(root),
      asOfMs:FIRST+DAY,
    });
    assert.equal(x.status,'BLOCKED_DATA');
    assert.equal(x.modelInput,null);
    assert.equal(x.metadata.missingOneMinuteSlots,0);
    assert.equal(x.paperAdmissionAllowed,false);
  });
});
test('KR/US stock sessions cannot use the crypto UTC source as an authorized input',async()=>{
  for(const [market,code] of [['KR_STOCK','005930'],['US_STOCK','AAPL']]){
    const v=await prepareSealedMinuteBacktesterInputV1({
      enabled:true,market,symbol:code,day:'2026-10-09',
      asOfMs:RETRIEVED,inspectionNowMs:RETRIEVED,
    });
    assert.equal(v.status,'BLOCKED_DATA');
    assert.equal(v.reason,'STOCK_EXCHANGE_SESSION_SOURCE_NOT_CONNECTED');
    assert.equal(v.modelInput,null);
  }
});
test('period reader returns bounded read-only page and continuation, no source bars',async()=>{
  await room(async root=>{
    await fillOneDay(root);
    const report=await inspectSealedMinuteBacktesterPeriodV1({
      enabled:true,root,market:'CRYPTO_SPOT',symbol,
      startDate:'2026-10-09',endDate:'2026-10-12',researchSha:SHA,
      asOfMs:RETRIEVED,inspectionNowMs:RETRIEVED,daysPerRead:2,
    });
    assert.equal(report.status,'SOURCE_LIMITED_PERIOD_PAGE');
    assert.equal(report.inspectedDayCount,2);
    assert.equal(report.originalMinuteDayModelInputs,1);
    assert.equal(report.blockedSourceDays,1);
    assert.equal(report.nextCursorDate,'2026-10-11');
    assert.equal(report.reports[0].sourceMinuteRows,1440);
    assert.equal(report.reports[1].sourceStatus,'BLOCKED_DATA');
    assert.equal(report.reports[1].reason,'NO_ORIGINAL_MINUTE_PAGES');
    assert.equal(Object.hasOwn(report.reports[0],'minuteBars'),false);
    assert.equal(Object.hasOwn(report.reports[0],'modelInput'),false);
    assert.equal(report.providerGETCount,0);
    assert.equal(report.executionAuthority,'NONE');
    const next=await inspectSealedMinuteBacktesterPeriodV1({
      enabled:true,root,market:'CRYPTO_SPOT',symbol,
      startDate:'2026-10-09',endDate:'2026-10-12',researchSha:SHA,
      asOfMs:RETRIEVED,inspectionNowMs:RETRIEVED,daysPerRead:2,
      cursorDate:report.nextCursorDate,
    });
    assert.equal(next.inspectedFirstDate,'2026-10-11');
    assert.equal(next.nextCursorDate,null);
    assert.equal(next.inspectedDayCount,2);
    assert.equal(next.originalMinuteDayModelInputs,0);
  });
});
test('long period selection is paged, never materializes 10 years all at once',async()=>{
  await room(async root=>{
    const report=await inspectSealedMinuteBacktesterPeriodV1({
      enabled:true,root,market:'CRYPTO_FUTURES',symbol:'BTCUSDT',
      startDate:'2017-01-01',endDate:'2026-10-09',
      researchSha:SHA,asOfMs:RETRIEVED,inspectionNowMs:RETRIEVED,
      daysPerRead:BACKTEST_SOURCE_LIMITS.maxDaysPerRead,
    });
    assert.equal(report.inspectedDayCount,7);
    assert.equal(report.blockedSourceDays,7);
    assert.equal(report.nextCursorDate,'2017-01-08');
    assert.equal(report.providerGETCount,0);
  });
});
test('future cutoff / invalid ISO days / untrusted cursor fail before archive inspection',async()=>{
  await room(async root=>{
    for(const changes of [
      {startDate:'2026-02-30',endDate:'2026-10-09'},
      {startDate:'2026-10-10',endDate:'2026-10-09'},
      {startDate:'2026-10-09',endDate:'2026-10-09',cursorDate:'2026-10-10'},
      {startDate:'2026-10-09',endDate:'2026-10-09',daysPerRead:10},
      {startDate:'2026-10-09',endDate:'2026-10-09',
        asOfMs:RETRIEVED+50000},
    ]){
      await assert.rejects(inspectSealedMinuteBacktesterPeriodV1({
        enabled:true,root,market:'CRYPTO_SPOT',symbol,
        startDate:'2026-10-09',endDate:'2026-10-09',
        researchSha:SHA,asOfMs:RETRIEVED,inspectionNowMs:RETRIEVED,
        ...changes,
      }),/BACKTEST_SOURCE_|MINUTE_ROLLUP_/);
    }
  });
});
