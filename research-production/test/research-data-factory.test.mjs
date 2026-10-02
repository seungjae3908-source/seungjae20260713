import test from 'node:test';
import assert from 'node:assert/strict';
import { buildResearchDataFactoryOverviewV1, buildResearchDataReadinessV1 } from '../src/research-data-factory.mjs';

const H=(x)=>x.repeat(64);

test('crypto futures distinguishes historical funding from forward-accumulating OI and long-short evidence',()=>{
  const result=buildResearchDataReadinessV1({
    market:'CRYPTO_FUTURES',
    evidence:{
      benchmarkDatasetDigest:H('1'),
      fundingHistoryDigest:H('2'),fundingCoverage:0.97,
      longShortHistoryDigest:H('3'),longShortCoverage:0.2,longShortTrainingParityConfirmed:false,
      openInterestHistoryDigest:H('4'),openInterestCoverage:0.2,openInterestTrainingParityConfirmed:false,
      sentimentHistoryDigest:H('5'),sentimentCoverage:0.1,sentimentTemporalParityConfirmed:false,
    },
  });
  assert.equal(result.ready,false);
  assert.equal(result.features.find(x=>x.feature==='fundingRate').state,'HISTORICAL_READY');
  assert.equal(result.features.find(x=>x.feature==='benchmarkReturn').state,'DERIVABLE_HISTORICAL');
  assert.equal(result.features.find(x=>x.feature==='openInterestChange').state,'FORWARD_ACCUMULATING');
  assert.equal(result.features.find(x=>x.feature==='longShortBias').state,'FORWARD_ACCUMULATING');
  assert.equal(result.datasetSnapshotHash,null);
});

test('crypto futures becomes research-ready only with time-aligned 90%+ evidence and explicit parity',()=>{
  const result=buildResearchDataReadinessV1({
    market:'CRYPTO_FUTURES',
    evidence:{
      benchmarkDatasetDigest:H('1'),
      fundingHistoryDigest:H('2'),fundingCoverage:0.95,
      longShortHistoryDigest:H('3'),longShortCoverage:0.96,longShortTrainingParityConfirmed:true,
      openInterestHistoryDigest:H('4'),openInterestCoverage:0.97,openInterestTrainingParityConfirmed:true,
      sentimentHistoryDigest:H('5'),sentimentCoverage:0.93,sentimentTemporalParityConfirmed:true,
    },
  });
  assert.equal(result.ready,true);
  assert.match(result.datasetSnapshotHash,/^[0-9a-f]{64}$/);
  assert.equal(result.blockers.length,0);
});

test('stocks remain blocked until canonical point-in-time flow and sentiment histories exist',()=>{
  const result=buildResearchDataReadinessV1({
    market:'KR_STOCK',
    evidence:{benchmarkDatasetDigest:H('1')},
  });
  assert.equal(result.ready,false);
  assert.equal(result.features.find(x=>x.feature==='foreignNetRatio').state,'SOURCE_REQUIRED');
  assert.equal(result.features.find(x=>x.feature==='institutionNetRatio').state,'SOURCE_REQUIRED');
  assert.equal(result.features.find(x=>x.feature==='sentimentScore').state,'FORWARD_ACCUMULATING');
  assert.equal(result.safety.currentValueHistoricalBackfill,false);
});

test('no zero/synthetic/backfill shortcut can make evidence ready',()=>{
  const result=buildResearchDataReadinessV1({
    market:'CRYPTO_SPOT',
    evidence:{benchmarkDatasetDigest:H('1'),sentimentCoverage:1,sentimentTemporalParityConfirmed:true},
  });
  assert.equal(result.ready,false);
  assert.equal(result.features.find(x=>x.feature==='sentimentScore').state,'FORWARD_ACCUMULATING');
  assert.equal(result.safety.syntheticImputation,false);
  assert.equal(result.safety.zeroImputation,false);
});

test('factory overview covers all four markets with explicit blocker counts',()=>{
  const result=buildResearchDataFactoryOverviewV1({evidenceByMarket:{}});
  assert.deepEqual(Object.keys(result.markets).sort(),['CRYPTO_FUTURES','CRYPTO_SPOT','KR_STOCK','US_STOCK']);
  assert.equal(result.readyMarketCount,0);
  assert.equal(result.blockedMarketCount,4);
  assert.equal(result.executionAuthority,'NONE');
});
