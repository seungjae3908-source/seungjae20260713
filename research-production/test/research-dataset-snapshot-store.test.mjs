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

function futuresEvidence(){
  return {
    benchmarkDatasetDigest:H('1'),
    fundingHistoryDigest:H('2'),fundingCoverage:0.95,
    longShortHistoryDigest:H('3'),longShortCoverage:0.96,longShortTrainingParityConfirmed:true,
    openInterestHistoryDigest:H('4'),openInterestCoverage:0.97,openInterestTrainingParityConfirmed:true,
    sentimentHistoryDigest:H('5'),sentimentCoverage:0.93,sentimentTemporalParityConfirmed:true,
  };
}

test('ready Data Factory evidence creates immutable content-addressed manifest',()=>{
  const manifest=buildResearchDatasetSnapshotManifestV1({
    researchSha:SHA,createdAt:AT,market:'CRYPTO_FUTURES',evidence:futuresEvidence(),
  });
  assert.match(manifest.datasetSnapshotHash,/^[0-9a-f]{64}$/);
  assert.match(manifest.manifestDigest,/^[0-9a-f]{64}$/);
  assert.equal(manifest.features.every(row=>['HISTORICAL_READY','DERIVABLE_HISTORICAL'].includes(row.state)),true);
  assert.equal(manifest.safety.immutable,true);
  assert.equal(manifest.safety.executionAuthority,'NONE');
  assertResearchDatasetSnapshotManifestV1(manifest);
});

test('blocked Data Factory evidence cannot create a snapshot manifest',()=>{
  assert.throws(()=>buildResearchDatasetSnapshotManifestV1({
    researchSha:SHA,createdAt:AT,market:'CRYPTO_FUTURES',
    evidence:{benchmarkDatasetDigest:H('1')},
  }),/DATASET_NOT_RESEARCH_READY/);
});

test('first persist creates manifest and exact repeat is idempotent',async()=>{
  const root=await mkdtemp(join(tmpdir(),'research-dataset-store-'));
  const manifest=buildResearchDatasetSnapshotManifestV1({
    researchSha:SHA,createdAt:AT,market:'CRYPTO_FUTURES',evidence:futuresEvidence(),
  });
  const first=await persistResearchDatasetSnapshotManifestV1({stateRoot:root,manifest});
  const second=await persistResearchDatasetSnapshotManifestV1({stateRoot:root,manifest});
  assert.equal(first.status,'created');
  assert.equal(second.status,'already_present');
  assert.equal(first.manifestDigest,second.manifestDigest);
  const disk=JSON.parse(await readFile(join(root,'datasets',manifest.datasetSnapshotHash,'manifest.json'),'utf8'));
  assert.equal(disk.manifestDigest,manifest.manifestDigest);
});

test('tampered persisted manifest is rejected instead of overwritten',async()=>{
  const root=await mkdtemp(join(tmpdir(),'research-dataset-store-'));
  const manifest=buildResearchDatasetSnapshotManifestV1({
    researchSha:SHA,createdAt:AT,market:'CRYPTO_FUTURES',evidence:futuresEvidence(),
  });
  await persistResearchDatasetSnapshotManifestV1({stateRoot:root,manifest});
  const path=join(root,'datasets',manifest.datasetSnapshotHash,'manifest.json');
  await writeFile(path,JSON.stringify({...manifest,market:'CRYPTO_SPOT'}));
  await assert.rejects(
    persistResearchDatasetSnapshotManifestV1({stateRoot:root,manifest}),
    /DIGEST_MISMATCH|invalid dataset snapshot manifest/,
  );
});

test('same evidence with different creation time does not overwrite same content address',async()=>{
  const root=await mkdtemp(join(tmpdir(),'research-dataset-store-'));
  const first=buildResearchDatasetSnapshotManifestV1({
    researchSha:SHA,createdAt:AT,market:'CRYPTO_FUTURES',evidence:futuresEvidence(),
  });
  await persistResearchDatasetSnapshotManifestV1({stateRoot:root,manifest:first});
  const later=buildResearchDatasetSnapshotManifestV1({
    researchSha:SHA,createdAt:'2026-09-20T01:00:00.000Z',market:'CRYPTO_FUTURES',evidence:futuresEvidence(),
  });
  assert.equal(later.datasetSnapshotHash,first.datasetSnapshotHash);
  await assert.rejects(
    persistResearchDatasetSnapshotManifestV1({stateRoot:root,manifest:later}),
    /CONTENT_ADDRESS_CONFLICT/,
  );
});
