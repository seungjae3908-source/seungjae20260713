import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertResearchDatasetSnapshotManifestV1,
  buildResearchDatasetSnapshotManifestV1,
  persistResearchDatasetSnapshotManifestV1,
} from '../src/research-dataset-snapshot-store.mjs';

const SHA='a'.repeat(40);
const H=(x)=>x.repeat(64);
const AT='2026-09-20T00:00:00.000Z';
const START=Date.UTC(2025,0,1);
const END=Date.UTC(2025,11,31);

function futuresEvidence(){
  return {
    benchmarkDatasetDigest:H('1'),
    fundingHistoryDigest:H('2'),fundingCoverage:0.95,
    longShortHistoryDigest:H('3'),longShortCoverage:0.96,longShortTrainingParityConfirmed:true,
    openInterestHistoryDigest:H('4'),openInterestCoverage:0.97,openInterestTrainingParityConfirmed:true,
    sentimentHistoryDigest:H('5'),sentimentCoverage:0.93,sentimentTemporalParityConfirmed:true,
  };
}

function scope(overrides={}){
  return {
    timeframe:'1h',
    symbols:['BTCUSDT','ETHUSDT'],
    startTime:START,
    endTime:END,
    primaryDatasetDigest:H('6'),
    universeDigest:null,
    publicDataOnly:true,
    ...overrides,
  };
}

function build(overrides={}){
  return buildResearchDatasetSnapshotManifestV1({
    researchSha:SHA,
    createdAt:AT,
    profileId:'CRYPTO_FUTURES:SWING',
    evidence:futuresEvidence(),
    scope:scope(),
    ...overrides,
  });
}

test('ready Data Factory evidence creates immutable profile-scoped content-addressed manifest',()=>{
  const manifest=build();
  assert.equal(manifest.market,'CRYPTO_FUTURES');
  assert.equal(manifest.profileId,'CRYPTO_FUTURES:SWING');
  assert.equal(manifest.scope.timeframe,'1h');
  assert.deepEqual(manifest.scope.symbols,['BTCUSDT','ETHUSDT']);
  assert.match(manifest.datasetSnapshotHash,/^[0-9a-f]{64}$/);
  assert.match(manifest.manifestDigest,/^[0-9a-f]{64}$/);
  assert.equal(manifest.features.every(row=>['HISTORICAL_READY','DERIVABLE_HISTORICAL'].includes(row.state)),true);
  assert.equal(manifest.safety.profileScoped,true);
  assert.equal(manifest.safety.executionAuthority,'NONE');
  assertResearchDatasetSnapshotManifestV1(manifest);
});

test('blocked Data Factory evidence cannot create a snapshot manifest',()=>{
  assert.throws(()=>buildResearchDatasetSnapshotManifestV1({
    researchSha:SHA,
    createdAt:AT,
    profileId:'CRYPTO_FUTURES:SWING',
    evidence:{benchmarkDatasetDigest:H('1')},
    scope:scope(),
  }),/DATASET_NOT_RESEARCH_READY/);
});

test('profile timeframe and canonical symbol scope are enforced',()=>{
  assert.throws(()=>build({scope:scope({timeframe:'15m'})}),/TIMEFRAME_MISMATCH/);
  assert.throws(()=>build({scope:scope({symbols:['ETHUSDT','BTCUSDT']})}),/unique canonical symbols/);
  assert.throws(()=>build({scope:scope({symbols:['BTCUSDT','BTCUSDT']})}),/unique canonical symbols/);
});

test('profile, symbol set and time range are part of immutable dataset identity',()=>{
  const swing=build();
  const short=buildResearchDatasetSnapshotManifestV1({
    researchSha:SHA,
    createdAt:AT,
    profileId:'CRYPTO_FUTURES:SHORT',
    evidence:futuresEvidence(),
    scope:scope({timeframe:'15m'}),
  });
  const oneSymbol=build({scope:scope({symbols:['BTCUSDT']})});
  const shorter=build({scope:scope({endTime:END-86400000})});
  assert.notEqual(swing.datasetSnapshotHash,short.datasetSnapshotHash);
  assert.notEqual(swing.datasetSnapshotHash,oneSymbol.datasetSnapshotHash);
  assert.notEqual(swing.datasetSnapshotHash,shorter.datasetSnapshotHash);
});

test('first persist creates manifest and exact repeat is idempotent',async()=>{
  const root=await mkdtemp(join(tmpdir(),'research-dataset-store-'));
  const manifest=build();
  const first=await persistResearchDatasetSnapshotManifestV1({stateRoot:root,manifest});
  const second=await persistResearchDatasetSnapshotManifestV1({stateRoot:root,manifest});
  assert.equal(first.status,'created');
  assert.equal(second.status,'already_present');
  assert.equal(first.manifestDigest,second.manifestDigest);
  assert.equal(second.profileId,'CRYPTO_FUTURES:SWING');
  const disk=JSON.parse(await readFile(join(root,'datasets',manifest.datasetSnapshotHash,'manifest.json'),'utf8'));
  assert.equal(disk.manifestDigest,manifest.manifestDigest);
});

test('tampered persisted manifest is rejected instead of overwritten',async()=>{
  const root=await mkdtemp(join(tmpdir(),'research-dataset-store-'));
  const manifest=build();
  await persistResearchDatasetSnapshotManifestV1({stateRoot:root,manifest});
  const path=join(root,'datasets',manifest.datasetSnapshotHash,'manifest.json');
  await writeFile(path,JSON.stringify({...manifest,profileId:'CRYPTO_FUTURES:SHORT'}));
  await assert.rejects(
    persistResearchDatasetSnapshotManifestV1({stateRoot:root,manifest}),
    /PROFILE_MARKET_MISMATCH|TIMEFRAME_MISMATCH|HASH_MISMATCH|DIGEST_MISMATCH|invalid dataset snapshot manifest/,
  );
});

test('same exact data scope with later observation time reuses existing immutable snapshot',async()=>{
  const root=await mkdtemp(join(tmpdir(),'research-dataset-store-'));
  const first=build();
  const created=await persistResearchDatasetSnapshotManifestV1({stateRoot:root,manifest:first});
  const later=build({createdAt:'2026-09-20T01:00:00.000Z'});
  assert.equal(later.datasetSnapshotHash,first.datasetSnapshotHash);
  const reused=await persistResearchDatasetSnapshotManifestV1({stateRoot:root,manifest:later});
  assert.equal(created.status,'created');
  assert.equal(reused.status,'already_present');
  assert.equal(reused.manifestDigest,first.manifestDigest);
  assert.equal(reused.createdAt,AT);
});
