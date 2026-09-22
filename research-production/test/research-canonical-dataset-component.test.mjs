import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildResearchDatasetSnapshotManifestV1 } from '../src/research-dataset-snapshot-store.mjs';
import {
  buildCanonicalDatasetComponentV1,
  persistCanonicalDatasetComponentV1,
} from '../src/research-canonical-dataset-component.mjs';
import { sha256Canonical as hash } from '../../market-prediction-lab/src/research-cache-provenance.js';

const SHA='a'.repeat(40);
const H=(x)=>x.repeat(64);
const START=Date.UTC(2025,0,1);
const STEP=60*60*1000;
const COUNT=100;
const END=START+COUNT*STEP;
const rows=Array.from({length:COUNT},(_,i)=>({
  timestamp:START+i*STEP,open:100+i,high:102+i,low:99+i,close:101+i,volume:1000+i,
}));
const split={
  TRAIN:rows.slice(0,60).map(row=>row.timestamp),
  VALIDATION:rows.slice(60,80).map(row=>row.timestamp),
  OOS:rows.slice(80).map(row=>row.timestamp),
};

function manifest(){
  return buildResearchDatasetSnapshotManifestV1({
    researchSha:SHA,createdAt:'2026-09-20T00:00:00.000Z',profileId:'CRYPTO_FUTURES:SWING',
    evidence:{
      benchmarkDatasetDigest:H('1'),
      fundingHistoryDigest:H('2'),fundingCoverage:0.95,
      longShortHistoryDigest:H('3'),longShortCoverage:0.96,longShortTrainingParityConfirmed:true,
      openInterestHistoryDigest:H('4'),openInterestCoverage:0.97,openInterestTrainingParityConfirmed:true,
      sentimentHistoryDigest:H('5'),sentimentCoverage:0.93,sentimentTemporalParityConfirmed:true,
    },
    scope:{
      timeframe:'1h',symbols:['BTCUSDT','ETHUSDT'],startTime:START,endTime:END,
      primaryDatasetDigest:H('6'),universeDigest:null,publicDataOnly:true,
    },
  });
}
function metadata(overrides={}){
  return {
    provider:'bitget-public-v2',providerVersion:'v2',sourceType:'PUBLIC_MARKET_DATA',
    adjustmentMode:'not_applicable',corporateActionMode:'not_applicable',timezone:'UTC',
    sourceDigest:hash(rows),loaderVersion:'bitget-candle-collector-v1',
    missingIntervalCount:0,duplicateRowCount:0,dataQualityStatus:'VERIFIED',
    profileSourceDigest:H('6'),...overrides,
  };
}

test('builds ResearchBundle-compatible immutable PIT dataset component bound to exact profile snapshot',()=>{
  const m=manifest();
  const built=buildCanonicalDatasetComponentV1({
    datasetSnapshotManifest:m,datasetId:'dataset:BTCUSDT:1h:v1',symbol:'BTCUSDT',
    rows,splitAssignments:split,metadata:metadata(),observedAtMs:END+1000,
  });
  assert.equal(built.component.identity.market,'CRYPTO_FUTURES');
  assert.equal(built.component.identity.symbol,'BTCUSDT');
  assert.equal(built.component.identity.timeframe,'1h');
  assert.equal(built.component.identity.actualStart,START);
  assert.equal(built.component.identity.actualEnd,END-STEP);
  assert.equal(built.component.identity.missingIntervalCount,0);
  assert.equal(built.component.identity.duplicateRowCount,0);
  assert.equal(built.component.identity.dataQualityStatus,'VERIFIED');
  assert.equal(built.component.immutable,true);
  assert.equal(built.component.pointInTimeSafe,true);
  assert.equal(built.component.leakageStatus,'CLEAR');
  assert.equal(built.component.receipt.payload.datasetDigest,built.component.identity.datasetDigest);
  assert.equal(built.record.datasetSnapshotHash,m.datasetSnapshotHash);
  assert.equal(built.record.profileSourceDigest,m.scope.primaryDatasetDigest);
  assert.equal(built.record.safety.syntheticDataAllowed,false);
  assert.equal(built.record.safety.executionAuthority,'NONE');
});

test('refuses symbol outside snapshot, incomplete range, interval gap, or unverified quality',()=>{
  const m=manifest();
  const base={datasetSnapshotManifest:m,datasetId:'dataset:v1',symbol:'BTCUSDT',rows,splitAssignments:split,metadata:metadata(),observedAtMs:END+1000};
  assert.throws(()=>buildCanonicalDatasetComponentV1({...base,symbol:'SOLUSDT'}),/OUTSIDE_PROFILE/);
  assert.throws(()=>buildCanonicalDatasetComponentV1({...base,rows:rows.slice(0,-1)}),/COVERAGE_INCOMPLETE/);
  const gapped=structuredClone(rows); gapped[20].timestamp+=1;
  assert.throws(()=>buildCanonicalDatasetComponentV1({...base,rows:gapped}),/INTERVAL_OR_RANGE_MISMATCH/);
  assert.throws(()=>buildCanonicalDatasetComponentV1({...base,metadata:metadata({dataQualityStatus:'MISSING_EVIDENCE'})}),/QUALITY_NOT_VERIFIED/);
});

test('split contract must exactly cover the rows once',()=>{
  const m=manifest();
  const bad={...split,OOS:split.OOS.slice(1)};
  assert.throws(()=>buildCanonicalDatasetComponentV1({
    datasetSnapshotManifest:m,datasetId:'dataset:v1',symbol:'BTCUSDT',rows,
    splitAssignments:bad,metadata:metadata(),observedAtMs:END+1000,
  }),/SPLIT_CONTRACT_NOT_EXACT/);
});

test('profile source digest binding is mandatory and per-symbol row digest is independently verified',()=>{
  const m=manifest();
  assert.throws(()=>buildCanonicalDatasetComponentV1({
    datasetSnapshotManifest:m,datasetId:'dataset:v1',symbol:'BTCUSDT',rows,
    splitAssignments:split,metadata:metadata({profileSourceDigest:H('f')}),observedAtMs:END+1000,
  }),/PROFILE_SOURCE_DIGEST_MISMATCH/);
  assert.throws(()=>buildCanonicalDatasetComponentV1({
    datasetSnapshotManifest:m,datasetId:'dataset:v1',symbol:'BTCUSDT',rows,
    splitAssignments:split,metadata:metadata({sourceDigest:H('f')}),observedAtMs:END+1000,
  }),/DATASET_SOURCE_DIGEST_ROWS_MISMATCH|datasetDigest does not match canonical rows|sourceDigest/);
});

test('persists dataset component and record write-once',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dataset-component-'));
  const m=manifest();
  const first=await persistCanonicalDatasetComponentV1({
    componentRoot:root,datasetSnapshotManifest:m,datasetId:'dataset:v1',symbol:'BTCUSDT',
    rows,splitAssignments:split,metadata:metadata(),observedAtMs:END+1000,
  });
  assert.equal(first.status,'persisted');
  const dataset=JSON.parse(await readFile(first.paths.dataset,'utf8'));
  assert.equal(dataset.identity.datasetDigest,first.datasetDigest);
  const repeated=await persistCanonicalDatasetComponentV1({
    componentRoot:root,datasetSnapshotManifest:m,datasetId:'dataset:v1',symbol:'BTCUSDT',
    rows,splitAssignments:split,metadata:metadata(),observedAtMs:END+1000,
  });
  assert.equal(repeated.status,'already_present');
  dataset.id='tampered';
  await writeFile(first.paths.dataset,JSON.stringify(dataset));
  await assert.rejects(
    persistCanonicalDatasetComponentV1({
      componentRoot:root,datasetSnapshotManifest:m,datasetId:'dataset:v1',symbol:'BTCUSDT',
      rows,splitAssignments:split,metadata:metadata(),observedAtMs:END+1000,
    }),
    /CONTENT_CONFLICT/,
  );
});


test('split contract requires non-empty chronological TRAIN VALIDATION and OOS partitions',()=>{
  const m=manifest();
  const emptyOos={
    TRAIN:rows.slice(0,80).map(row=>row.timestamp),
    VALIDATION:rows.slice(80).map(row=>row.timestamp),
    OOS:[],
  };
  assert.throws(()=>buildCanonicalDatasetComponentV1({
    datasetSnapshotManifest:m,datasetId:'dataset:v1',symbol:'BTCUSDT',rows,
    splitAssignments:emptyOos,metadata:metadata(),observedAtMs:END+1000,
  }),/SPLIT_CONTRACT_NOT_EXACT/);

  const interleaved={
    TRAIN:[...split.TRAIN.slice(0,-1),split.VALIDATION[0]],
    VALIDATION:[split.TRAIN.at(-1),...split.VALIDATION.slice(1)],
    OOS:[...split.OOS],
  };
  assert.throws(()=>buildCanonicalDatasetComponentV1({
    datasetSnapshotManifest:m,datasetId:'dataset:v1',symbol:'BTCUSDT',rows,
    splitAssignments:interleaved,metadata:metadata(),observedAtMs:END+1000,
  }),/SPLIT_CONTRACT_NOT_EXACT/);
});

test('componentRoot must be absolute and must not traverse a symlink root',async()=>{
  const m=manifest();
  const input={
    datasetSnapshotManifest:m,datasetId:'dataset:v1',symbol:'BTCUSDT',
    rows,splitAssignments:split,metadata:metadata(),observedAtMs:END+1000,
  };
  await assert.rejects(
    persistCanonicalDatasetComponentV1({componentRoot:'relative-component-root',...input}),
    /componentRoot must be absolute/,
  );

  const target=await mkdtemp(join(tmpdir(),'dataset-component-target-'));
  const holder=await mkdtemp(join(tmpdir(),'dataset-component-holder-'));
  const linkRoot=join(holder,'component-link');
  await symlink(target,linkRoot,'dir');
  await assert.rejects(
    persistCanonicalDatasetComponentV1({componentRoot:linkRoot,...input}),
    /componentRoot must not contain symbolic links/,
  );
});
