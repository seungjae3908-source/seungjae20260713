import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildResearchDatasetSnapshotManifestV1,
} from '../src/research-dataset-snapshot-store.mjs';
import {
  buildStockSessionCalendarAdaptiveReceiptV1,
} from '../src/research-stock-session-calendar-receipt.mjs';

const H=(x)=>x.repeat(64);
const SHA='a'.repeat(40);
const AT='2026-09-20T00:00:00.000Z';

function localTimestamp(date,hour,minute){
  const [y,m,d]=date.split('-').map(Number);
  return Date.UTC(y,m-1,d,hour+5,minute); // New York January UTC-5.
}
function calendar(){
  const dates=['2025-01-06','2025-01-07','2025-01-08','2025-01-09','2025-01-10','2025-01-11','2025-01-12'];
  return {
    market:'US_STOCK',
    sourceKind:'OFFICIAL_EXCHANGE_CALENDAR',
    sourceId:'official-calendar:v1',
    sourceDigest:H('9'),
    observedAt:AT,
    coverageStartTime:localTimestamp('2025-01-06',0,0),
    coverageEndTime:localTimestamp('2025-01-12',23,59)+59000,
    coverageStartDate:'2025-01-06',
    coverageEndDate:'2025-01-12',
    complete:true,
    days:dates.map(date=>{
      const dow=new Date(`${date}T00:00:00Z`).getUTCDay();
      return dow===0||dow===6
        ? {date,status:'WEEKEND',openTime:null,closeTime:null,sourceId:'official-calendar:v1'}
        : {date,status:'OPEN',openTime:localTimestamp(date,9,30),closeTime:localTimestamp(date,16,0),sourceId:'official-calendar:v1'};
    }),
  };
}
function manifest(){
  const cal=calendar();
  return buildResearchDatasetSnapshotManifestV1({
    researchSha:SHA,createdAt:AT,profileId:'US_STOCK:POSITION',
    evidence:{
      benchmarkDatasetDigest:H('1'),
      foreignFlowHistoryDigest:H('2'),foreignFlowCoverage:0.95,foreignFlowTemporalParityConfirmed:true,
      institutionFlowHistoryDigest:H('3'),institutionFlowCoverage:0.95,institutionFlowTemporalParityConfirmed:true,
      sentimentHistoryDigest:H('4'),sentimentCoverage:0.95,sentimentTemporalParityConfirmed:true,
    },
    scope:{
      timeframe:'1d',symbols:['AAPL'],
      startTime:localTimestamp('2025-01-06',9,30),
      endTime:localTimestamp('2025-01-10',16,0),
      primaryDatasetDigest:H('5'),universeDigest:H('6'),publicDataOnly:true,
    },
  });
}

test('calendar receipt binds exact stock profile snapshot without granting execution authority',()=>{
  const dataset=manifest();
  const result=buildStockSessionCalendarAdaptiveReceiptV1({
    datasetManifest:dataset,
    calendarEvidence:calendar(),
  });
  assert.equal(result.profileId,'US_STOCK:POSITION');
  assert.equal(result.receipt.requirement,'SESSION_CALENDAR');
  assert.equal(result.receipt.datasetSnapshotHash,dataset.datasetSnapshotHash);
  assert.match(result.calendarEvidenceDigest,/^[0-9a-f]{64}$/);
  assert.equal(result.executionAuthority,'NONE');
});

test('calendar that does not cover the full snapshot range is rejected',()=>{
  const dataset=manifest();
  const short=calendar();
  short.coverageEndTime=localTimestamp('2025-01-09',23,59)+59000;
  short.coverageEndDate='2025-01-09';
  short.days=short.days.filter(row=>row.date<='2025-01-09');
  assert.throws(()=>buildStockSessionCalendarAdaptiveReceiptV1({
    datasetManifest:dataset,calendarEvidence:short,
  }),/SNAPSHOT_COVERAGE_INCOMPLETE/);
});
