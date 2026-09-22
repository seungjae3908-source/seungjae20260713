import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createStockSessionCalendarEvidenceV1,
} from '../src/stock-session-calendar-evidence-v1.js';

const H='a'.repeat(64);
const OBSERVED='2026-09-20T00:00:00.000Z';

function localTimestamp(date,hour,minute,timeZone){
  // Fixed fixtures only: Jan 2025 Seoul=UTC+9, New York=UTC-5.
  const offset=timeZone==='Asia/Seoul'?9:-5;
  const [y,m,d]=date.split('-').map(Number);
  return Date.UTC(y,m-1,d,hour-offset,minute);
}
function evidence(market='US_STOCK'){
  const timeZone=market==='US_STOCK'?'America/New_York':'Asia/Seoul';
  const dates=['2025-01-06','2025-01-07','2025-01-08','2025-01-09','2025-01-10','2025-01-11','2025-01-12'];
  const days=dates.map(date=>{
    const dow=new Date(`${date}T00:00:00Z`).getUTCDay();
    if(dow===0||dow===6) return {date,status:'WEEKEND',openTime:null,closeTime:null,sourceId:'official-calendar:v1'};
    const [oh,om,ch,cm]=market==='US_STOCK'?[9,30,16,0]:[9,0,15,30];
    return {
      date,status:'OPEN',
      openTime:localTimestamp(date,oh,om,timeZone),
      closeTime:localTimestamp(date,ch,cm,timeZone),
      sourceId:'official-calendar:v1',
    };
  });
  const start=localTimestamp('2025-01-06',0,0,timeZone);
  const end=localTimestamp('2025-01-12',23,59,timeZone)+59*1000;
  return {
    market,timeZone,
    sourceKind:'OFFICIAL_EXCHANGE_CALENDAR',
    sourceId:'official-calendar:v1',
    sourceDigest:H,
    observedAt:OBSERVED,
    coverageStartTime:start,
    coverageEndTime:end,
    coverageStartDate:'2025-01-06',
    coverageEndDate:'2025-01-12',
    complete:true,
    days,
  };
}

test('US and KR official calendar evidence is complete, contiguous and execution-free',()=>{
  for(const market of ['US_STOCK','KR_STOCK']){
    const result=createStockSessionCalendarEvidenceV1(evidence(market));
    assert.equal(result.market,market);
    assert.equal(result.days.length,7);
    assert.equal(result.complete,true);
    assert.match(result.evidenceDigest,/^[0-9a-f]{64}$/);
    assert.equal(result.safeguards.syntheticCalendarAllowed,false);
    assert.equal(result.safeguards.executionAuthority,'NONE');
  }
});

test('missing date, fake weekend/open state and incomplete source fail closed',()=>{
  const missing=evidence();
  missing.days=missing.days.filter(row=>row.date!=='2025-01-08');
  assert.throws(()=>createStockSessionCalendarEvidenceV1(missing),/DAY_COVERAGE_INCOMPLETE/);

  const weekend=evidence();
  weekend.days=weekend.days.map(row=>row.date==='2025-01-11'
    ? {...row,status:'OPEN',openTime:Date.UTC(2025,0,11,14,30),closeTime:Date.UTC(2025,0,11,21,0)}
    : row);
  assert.throws(()=>createStockSessionCalendarEvidenceV1(weekend),/WEEKEND_STATUS_INVALID/);

  assert.throws(()=>createStockSessionCalendarEvidenceV1({...evidence(),complete:false}),/COMPLETENESS_REQUIRED/);
});

test('closed days cannot carry fabricated open/close timestamps',()=>{
  const bad=evidence();
  bad.days=bad.days.map(row=>row.date==='2025-01-11'?{...row,openTime:1,closeTime:2}:row);
  assert.throws(()=>createStockSessionCalendarEvidenceV1(bad),/CLOSED_DAY_MUST_HAVE_NULL_TIMES/);
});


test('invalid calendar dates and future coverage fail closed',()=>{
  const invalidDate=evidence();
  invalidDate.coverageStartDate='2025-02-30';
  assert.throws(()=>createStockSessionCalendarEvidenceV1(invalidDate),/COVERAGE_START_DATE_INVALID/);

  const futureCoverage=evidence();
  futureCoverage.observedAt='2025-01-08T00:00:00.000Z';
  assert.throws(
    ()=>createStockSessionCalendarEvidenceV1(futureCoverage),
    /SESSION_CALENDAR_FUTURE_COVERAGE_FORBIDDEN/,
  );
});


test('canonical observedAt accepts whole-second UTC while rejecting impossible dates',()=>{
  const wholeSecond=evidence();
  wholeSecond.observedAt='2026-09-20T00:00:00Z';
  const accepted=createStockSessionCalendarEvidenceV1(wholeSecond);
  assert.equal(accepted.observedAt,'2026-09-20T00:00:00.000Z');

  const impossible=evidence();
  impossible.observedAt='2026-02-30T00:00:00Z';
  assert.throws(()=>createStockSessionCalendarEvidenceV1(impossible),/OBSERVED_AT_INVALID/);
});
