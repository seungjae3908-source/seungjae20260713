import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
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


test('relative and symlink state roots are rejected',async()=>{
  await assert.rejects(
    buildAndPersistAdaptiveEvidenceCatalogV1({
      stateRoot:'relative-state-root',
      manifestPathsByProfile:{},
      receiptPaths:[],
      generatedAt:AT,
    }),
    /stateRoot must be absolute/,
  );

  const target=await mkdtemp(join(tmpdir(),'adaptive-catalog-target-'));
  const holder=await mkdtemp(join(tmpdir(),'adaptive-catalog-holder-'));
  const link=join(holder,'state-link');
  await symlink(target,link,'dir');
  await assert.rejects(
    buildAndPersistAdaptiveEvidenceCatalogV1({
      stateRoot:link,
      manifestPathsByProfile:{},
      receiptPaths:[],
      generatedAt:AT,
    }),
    /stateRoot must not contain symbolic links/,
  );
});

test('manifest symlink inputs are rejected before evidence catalog build',async()=>{
  const root=await mkdtemp(join(tmpdir(),'adaptive-catalog-store-'));
  const outside=await mkdtemp(join(tmpdir(),'adaptive-catalog-outside-'));
  const outsideManifest=join(outside,'manifest.json');
  await writeFile(outsideManifest,JSON.stringify(manifest()));
  const inputs=join(root,'inputs');
  await import('node:fs/promises').then(({mkdir})=>mkdir(inputs,{recursive:true}));
  const link=join(inputs,'manifest-link.json');
  await symlink(outsideManifest,link);
  await assert.rejects(
    buildAndPersistAdaptiveEvidenceCatalogV1({
      stateRoot:root,
      manifestPathsByProfile:{'CRYPTO_FUTURES:SWING':link},
      receiptPaths:[],
      generatedAt:AT,
    }),
    /regular non-symlink file|real path must remain below stateRoot/,
  );
});


test('latest output and persisted readback symlinks are rejected',async()=>{
  const m=manifest();
  const root=await mkdtemp(join(tmpdir(),'adaptive-catalog-output-safe-'));
  const inputs=join(root,'inputs');
  await import('node:fs/promises').then(({mkdir})=>mkdir(inputs,{recursive:true}));
  const manifestPath=join(inputs,'manifest.json');
  await writeFile(manifestPath,JSON.stringify(m));

  const outside=await mkdtemp(join(tmpdir(),'adaptive-catalog-output-outside-'));
  await symlink(outside,join(root,'latest'),'dir');
  await assert.rejects(
    buildAndPersistAdaptiveEvidenceCatalogV1({
      stateRoot:root,
      manifestPathsByProfile:{[m.profileId]:manifestPath},
      receiptPaths:[],
      generatedAt:AT,
    }),
    /latest output directory must be a regular non-symlink directory|real path must remain below stateRoot/,
  );

  const root2=await mkdtemp(join(tmpdir(),'adaptive-catalog-readback-safe-'));
  const inputs2=join(root2,'inputs');
  await import('node:fs/promises').then(({mkdir})=>mkdir(inputs2,{recursive:true}));
  const manifestPath2=join(inputs2,'manifest.json');
  await writeFile(manifestPath2,JSON.stringify(m));
  await buildAndPersistAdaptiveEvidenceCatalogV1({
    stateRoot:root2,
    manifestPathsByProfile:{[m.profileId]:manifestPath2},
    receiptPaths:[],
    generatedAt:AT,
  });
  const rawPath=join(root2,'latest','adaptive-evidence-catalog.json');
  const outsideRaw=join(await mkdtemp(join(tmpdir(),'adaptive-catalog-readback-outside-')),'raw.json');
  await writeFile(outsideRaw,JSON.stringify({}));
  await unlink(rawPath);
  await symlink(outsideRaw,rawPath);
  await assert.rejects(
    loadPersistedAdaptiveEvidenceCatalogV1({stateRoot:root2}),
    /persisted raw catalog must be a regular non-symlink file|real path must remain below stateRoot/,
  );
});
