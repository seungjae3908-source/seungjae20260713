import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildResearchDatasetSnapshotManifestV1,
} from '../src/research-dataset-snapshot-store.mjs';
import {
  createAdaptiveEvidenceReceiptV1,
} from '../src/research-adaptive-evidence-catalog.mjs';
import {
  buildAndPersistAdaptiveEvidenceCatalogV1,
  loadPersistedAdaptiveEvidenceCatalogV1,
} from '../src/research-adaptive-evidence-catalog-store.mjs';

const SHA='a'.repeat(40);
const H=(x)=>x.repeat(64);
const AT='2026-09-20T00:00:00.000Z';
const START=Date.UTC(2025,0,1);
const END=START+100*60*60*1000;

function manifest(){
  return buildResearchDatasetSnapshotManifestV1({
    researchSha:SHA,createdAt:AT,profileId:'CRYPTO_FUTURES:SWING',
    evidence:{
      benchmarkDatasetDigest:H('1'),
      fundingHistoryDigest:H('2'),fundingCoverage:0.95,
      longShortHistoryDigest:H('3'),longShortCoverage:0.96,longShortTrainingParityConfirmed:true,
      openInterestHistoryDigest:H('4'),openInterestCoverage:0.97,openInterestTrainingParityConfirmed:true,
      sentimentHistoryDigest:H('5'),sentimentCoverage:0.93,sentimentTemporalParityConfirmed:true,
    },
    scope:{
      timeframe:'1h',symbols:['BTCUSDT'],startTime:START,endTime:END,
      primaryDatasetDigest:H('6'),universeDigest:null,publicDataOnly:true,
    },
  });
}

test('writer builds canonical raw catalog and digest-bound store record atomically',async()=>{
  const root=await mkdtemp(join(tmpdir(),'adaptive-catalog-store-'));
  const m=manifest();
  const manifestPath=join(root,'inputs','swing-manifest.json');
  const receiptPath=join(root,'inputs','mark-receipt.json');
  await import('node:fs/promises').then(({mkdir})=>mkdir(join(root,'inputs'),{recursive:true}));
  await writeFile(manifestPath,JSON.stringify(m));
  const receipt=createAdaptiveEvidenceReceiptV1({
    profileId:m.profileId,requirement:'MARK_PRICE',
    evidenceId:'canonical:mark',observedAt:AT,
    datasetSnapshotHash:m.datasetSnapshotHash,sourceDigest:H('9'),
  });
  await writeFile(receiptPath,JSON.stringify(receipt));

  const result=await buildAndPersistAdaptiveEvidenceCatalogV1({
    stateRoot:root,
    manifestPathsByProfile:{[m.profileId]:manifestPath},
    receiptPaths:[receiptPath],
    generatedAt:AT,
  });
  assert.equal(result.persisted.status,'persisted');
  assert.equal(result.catalog.evidenceCatalog[m.profileId].IMMUTABLE_DATASET_IDENTITY.status,'PRESENT');
  assert.equal(result.catalog.evidenceCatalog[m.profileId].MARK_PRICE.status,'PRESENT');
  assert.equal(result.catalog.evidenceCatalog[m.profileId].INDEX_PRICE.status,'MISSING');

  const loaded=await loadPersistedAdaptiveEvidenceCatalogV1({stateRoot:root});
  assert.equal(loaded.record.evidenceCatalogDigest,result.persisted.evidenceCatalogDigest);
  assert.equal(loaded.rawCatalog[m.profileId].MARK_PRICE.status,'PRESENT');
});

test('writer accepts producer envelopes and flattens only their receipt arrays',async()=>{
  const root=await mkdtemp(join(tmpdir(),'adaptive-catalog-store-'));
  const m=manifest();
  const inputs=join(root,'inputs');
  await import('node:fs/promises').then(({mkdir})=>mkdir(inputs,{recursive:true}));
  const manifestPath=join(inputs,'manifest.json');
  const receiptPath=join(inputs,'receipts.json');
  await writeFile(manifestPath,JSON.stringify(m));
  const receipts=['MARK_PRICE','INDEX_PRICE','BASIS'].map(requirement=>createAdaptiveEvidenceReceiptV1({
    profileId:m.profileId,requirement,evidenceId:`canonical:${requirement}`,
    observedAt:AT,datasetSnapshotHash:m.datasetSnapshotHash,sourceDigest:H('8'),
  }));
  await writeFile(receiptPath,JSON.stringify({receipts,diagnostic:'not forwarded'}));
  const result=await buildAndPersistAdaptiveEvidenceCatalogV1({
    stateRoot:root,
    manifestPathsByProfile:{[m.profileId]:manifestPath},
    receiptPaths:[receiptPath],
    generatedAt:AT,
  });
  assert.equal(result.catalog.evidenceCatalog[m.profileId].MARK_PRICE.status,'PRESENT');
  assert.equal(result.catalog.evidenceCatalog[m.profileId].INDEX_PRICE.status,'PRESENT');
  assert.equal(result.catalog.evidenceCatalog[m.profileId].BASIS.status,'PRESENT');
});

test('input paths outside Research state root are rejected',async()=>{
  const root=await mkdtemp(join(tmpdir(),'adaptive-catalog-store-'));
  await assert.rejects(
    buildAndPersistAdaptiveEvidenceCatalogV1({
      stateRoot:root,
      manifestPathsByProfile:{'CRYPTO_FUTURES:SWING':'/tmp/outside.json'},
      receiptPaths:[],
      generatedAt:AT,
    }),
    /below stateRoot/,
  );
});

test('tampered raw catalog is detected against persisted record digest',async()=>{
  const root=await mkdtemp(join(tmpdir(),'adaptive-catalog-store-'));
  const m=manifest();
  const inputs=join(root,'inputs');
  await import('node:fs/promises').then(({mkdir})=>mkdir(inputs,{recursive:true}));
  const manifestPath=join(inputs,'manifest.json');
  await writeFile(manifestPath,JSON.stringify(m));
  await buildAndPersistAdaptiveEvidenceCatalogV1({
    stateRoot:root,
    manifestPathsByProfile:{[m.profileId]:manifestPath},
    receiptPaths:[],
    generatedAt:AT,
  });
  const rawPath=join(root,'latest','adaptive-evidence-catalog.json');
  const raw=JSON.parse(await readFile(rawPath,'utf8'));
  raw[m.profileId].IMMUTABLE_DATASET_IDENTITY={status:'MISSING',evidenceId:null,observedAt:null};
  await writeFile(rawPath,JSON.stringify(raw));
  await assert.rejects(
    loadPersistedAdaptiveEvidenceCatalogV1({stateRoot:root}),
    /RAW_DIGEST_MISMATCH/,
  );
});
