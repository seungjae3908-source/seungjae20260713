import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildResearchDatasetSnapshotManifestV1,
} from '../src/research-dataset-snapshot-store.mjs';
import {
  buildStockCorporateActionsAdaptiveReceiptV1,
} from '../src/research-stock-corporate-actions-receipt.mjs';

const SHA='a'.repeat(40);
const H=(x)=>x.repeat(64);
const START=Date.UTC(2025,0,1);
const END=Date.UTC(2025,11,31);

function manifest(symbols=['AAPL','MSFT']){
  return buildResearchDatasetSnapshotManifestV1({
    researchSha:SHA,
    createdAt:'2026-09-20T00:00:00.000Z',
    profileId:'US_STOCK:POSITION',
    evidence:{
      benchmarkDatasetDigest:H('1'),
      foreignFlowHistoryDigest:H('2'),foreignFlowCoverage:0.95,foreignFlowTemporalParityConfirmed:true,
      institutionFlowHistoryDigest:H('3'),institutionFlowCoverage:0.96,institutionFlowTemporalParityConfirmed:true,
      sentimentHistoryDigest:H('4'),sentimentCoverage:0.94,sentimentTemporalParityConfirmed:true,
    },
    scope:{
      timeframe:'1d',
      symbols,
      startTime:START,
      endTime:END,
      primaryDatasetDigest:H('5'),
      universeDigest:H('6'),
      publicDataOnly:true,
    },
  });
}

function evidence(symbols=['AAPL','MSFT'],overrides={}){
  return {
    sourceKind:'OFFICIAL_CORPORATE_ACTION_HISTORY',
    sourceId:'official:exchange-actions',
    sourceDigest:H('7'),
    observedAt:'2026-09-20T00:10:00.000Z',
    coverageStartTime:START,
    coverageEndTime:END,
    complete:true,
    pointInTimeMode:'EVENT_TIME_ONLY',
    symbols:symbols.map((symbol,index)=>({
      symbol,
      sourceId:'official:exchange-actions',
      complete:true,
      coverageStartTime:START,
      coverageEndTime:END,
      events:index===0?[{
        actionId:`${symbol}:event:1`,
        symbol,
        actionType:'CASH_DIVIDEND',
        knownAt:Date.UTC(2025,2,1),
        effectiveTime:Date.UTC(2025,3,1),
        eventDigest:H('8'),
        sourceId:'official:exchange-actions',
      }]:[],
    })),
    ...overrides,
  };
}

test('verified full-scope corporate actions produce exact-profile adaptive receipt',()=>{
  const dataset=manifest();
  const result=buildStockCorporateActionsAdaptiveReceiptV1({
    datasetManifest:dataset,
    corporateActionsEvidence:evidence(),
  });
  assert.equal(result.profileId,'US_STOCK:POSITION');
  assert.equal(result.market,'US_STOCK');
  assert.equal(result.symbolCount,2);
  assert.equal(result.eventCount,1);
  assert.equal(result.receipt.requirement,'CORPORATE_ACTIONS');
  assert.equal(result.receipt.datasetSnapshotHash,dataset.datasetSnapshotHash);
  assert.equal(result.receipt.executionAuthority,'NONE');
  assert.match(result.corporateActionsEvidenceDigest,/^[0-9a-f]{64}$/);
});

test('missing, extra, or differently ordered symbols cannot satisfy snapshot coverage',()=>{
  const dataset=manifest();
  assert.throws(()=>buildStockCorporateActionsAdaptiveReceiptV1({
    datasetManifest:dataset,
    corporateActionsEvidence:evidence(['AAPL']),
  }),/SYMBOL_COVERAGE_MISMATCH/);
  assert.throws(()=>buildStockCorporateActionsAdaptiveReceiptV1({
    datasetManifest:dataset,
    corporateActionsEvidence:evidence(['AAPL','MSFT','NVDA']),
  }),/SYMBOL_COVERAGE_MISMATCH/);
  assert.throws(()=>buildStockCorporateActionsAdaptiveReceiptV1({
    datasetManifest:dataset,
    corporateActionsEvidence:evidence(['MSFT','AAPL']),
  }),/SYMBOL_ORDER_INVALID|SYMBOL_COVERAGE_MISMATCH/);
});

test('evidence range must fully cover the immutable snapshot range',()=>{
  const dataset=manifest();
  assert.throws(()=>buildStockCorporateActionsAdaptiveReceiptV1({
    datasetManifest:dataset,
    corporateActionsEvidence:evidence(undefined,{coverageStartTime:START+86400000}),
  }),/SNAPSHOT_COVERAGE_INCOMPLETE|SYMBOL_COVERAGE_MISMATCH/);
  assert.throws(()=>buildStockCorporateActionsAdaptiveReceiptV1({
    datasetManifest:dataset,
    corporateActionsEvidence:evidence(undefined,{coverageEndTime:END-86400000}),
  }),/SNAPSHOT_COVERAGE_INCOMPLETE|SYMBOL_COVERAGE_MISMATCH/);
});

test('corporate-action receipt is stock-only and cannot be reused for another profile market',()=>{
  const stock=manifest();
  const altered={...stock,market:'KR_STOCK'};
  assert.throws(()=>buildStockCorporateActionsAdaptiveReceiptV1({
    datasetManifest:altered,
    corporateActionsEvidence:evidence(),
  }),/invalid dataset snapshot manifest|PROFILE_MARKET_MISMATCH|PROFILE_INVALID/);
});
