import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ADAPTIVE_MULTI_MARKET_PROFILES_V1,
} from '../../market-prediction-lab/src/adaptive-multi-market-tournament-orchestrator-v1.js';
import {
  buildResearchDatasetSnapshotManifestV1,
} from '../src/research-dataset-snapshot-store.mjs';
import {
  buildAdaptiveEvidenceCatalogFromDataFactoryV1,
  createAdaptiveEvidenceReceiptV1,
} from '../src/research-adaptive-evidence-catalog.mjs';

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

function futuresManifest(profileId='CRYPTO_FUTURES:SWING'){
  const profile=ADAPTIVE_MULTI_MARKET_PROFILES_V1.find(row=>row.profileId===profileId);
  return buildResearchDatasetSnapshotManifestV1({
    researchSha:SHA,
    createdAt:AT,
    profileId,
    evidence:futuresEvidence(),
    scope:{
      timeframe:profile.timeframe,
      symbols:['BTCUSDT','ETHUSDT'],
      startTime:START,
      endTime:END,
      primaryDatasetDigest:H(profile.horizon==='SHORT'?'6':profile.horizon==='SWING'?'7':'8'),
      universeDigest:null,
      publicDataOnly:true,
    },
  });
}

function receipt(profileId,requirement,hash){
  return createAdaptiveEvidenceReceiptV1({
    profileId,
    requirement,
    evidenceId:`canonical:${profileId}:${requirement}`,
    observedAt:AT,
    datasetSnapshotHash:hash,
    sourceDigest:H('9'),
  });
}

test('Dataset Snapshot owns identity/public-source only for its exact profile',()=>{
  const swing=futuresManifest('CRYPTO_FUTURES:SWING');
  const result=buildAdaptiveEvidenceCatalogFromDataFactoryV1({
    datasetManifestsByProfile:{'CRYPTO_FUTURES:SWING':swing},
  });
  const swingRow=result.readiness.profiles.find(p=>p.profileId==='CRYPTO_FUTURES:SWING');
  const shortRow=result.readiness.profiles.find(p=>p.profileId==='CRYPTO_FUTURES:SHORT');
  assert.equal(swingRow.evidence.find(x=>x.requirement==='IMMUTABLE_DATASET_IDENTITY').status,'PRESENT');
  assert.equal(swingRow.evidence.find(x=>x.requirement==='PUBLIC_ONLY_SOURCE').status,'PRESENT');
  assert.equal(swingRow.evidence.find(x=>x.requirement==='MARK_PRICE').status,'MISSING');
  assert.equal(shortRow.evidence.find(x=>x.requirement==='IMMUTABLE_DATASET_IDENTITY').status,'MISSING');
  assert.equal(result.datasetBindings['CRYPTO_FUTURES:SWING'].timeframe,'1h');
  assert.equal(result.safety.profileScopedDatasetRequired,true);
  assert.equal(result.safety.crossProfileEvidenceAllowed,false);
});

test('profile becomes READY only when every non-Factory receipt binds the exact profile snapshot',()=>{
  const manifest=futuresManifest();
  const profile=ADAPTIVE_MULTI_MARKET_PROFILES_V1.find(p=>p.profileId==='CRYPTO_FUTURES:SWING');
  const receipts=profile.requiredEvidence
    .filter(req=>!['IMMUTABLE_DATASET_IDENTITY','PUBLIC_ONLY_SOURCE'].includes(req))
    .map(req=>receipt(profile.profileId,req,manifest.datasetSnapshotHash));
  const result=buildAdaptiveEvidenceCatalogFromDataFactoryV1({
    datasetManifestsByProfile:{[profile.profileId]:manifest},
    receipts,
  });
  const row=result.readiness.profiles.find(p=>p.profileId===profile.profileId);
  assert.equal(row.status,'READY');
  assert.equal(row.missingRequirements.length,0);
  assert.equal(result.readiness.readyProfileCount,1);
});

test('cross-dataset and cross-profile receipts are rejected rather than credited',()=>{
  const swing=futuresManifest('CRYPTO_FUTURES:SWING');
  const short=futuresManifest('CRYPTO_FUTURES:SHORT');
  assert.throws(()=>buildAdaptiveEvidenceCatalogFromDataFactoryV1({
    datasetManifestsByProfile:{'CRYPTO_FUTURES:SWING':swing},
    receipts:[receipt('CRYPTO_FUTURES:SWING','MARK_PRICE',H('f'))],
  }),/DATASET_BINDING_MISMATCH/);
  assert.throws(()=>buildAdaptiveEvidenceCatalogFromDataFactoryV1({
    datasetManifestsByProfile:{'CRYPTO_FUTURES:SWING':swing},
    receipts:[receipt('CRYPTO_FUTURES:SHORT','MARK_PRICE',short.datasetSnapshotHash)],
  }),/DATASET_BINDING_MISMATCH/);
});

test('manifest map key must equal the immutable manifest profile',()=>{
  const swing=futuresManifest('CRYPTO_FUTURES:SWING');
  assert.throws(()=>buildAdaptiveEvidenceCatalogFromDataFactoryV1({
    datasetManifestsByProfile:{'CRYPTO_FUTURES:SHORT':swing},
  }),/PROFILE_MISMATCH/);
});

test('Factory-owned identity and public-source receipts cannot be overridden',()=>{
  const manifest=futuresManifest();
  assert.throws(()=>buildAdaptiveEvidenceCatalogFromDataFactoryV1({
    datasetManifestsByProfile:{'CRYPTO_FUTURES:SWING':manifest},
    receipts:[receipt('CRYPTO_FUTURES:SWING','IMMUTABLE_DATASET_IDENTITY',manifest.datasetSnapshotHash)],
  }),/FACTORY_OWNED/);
});

test('duplicate and unknown canonical receipts fail closed',()=>{
  const manifest=futuresManifest();
  const row=receipt('CRYPTO_FUTURES:SWING','MARK_PRICE',manifest.datasetSnapshotHash);
  assert.throws(()=>buildAdaptiveEvidenceCatalogFromDataFactoryV1({
    datasetManifestsByProfile:{'CRYPTO_FUTURES:SWING':manifest},
    receipts:[row,row],
  }),/DUPLICATE_RECEIPT/);
  assert.throws(()=>createAdaptiveEvidenceReceiptV1({
    profileId:'CRYPTO_FUTURES:SWING',
    requirement:'MADE_UP_REQUIREMENT',
    evidenceId:'canonical:made-up',
    observedAt:AT,
    datasetSnapshotHash:manifest.datasetSnapshotHash,
    sourceDigest:H('9'),
  }),/REQUIREMENT_UNKNOWN/);
});

test('receipt tampering is rejected before readiness credit',()=>{
  const manifest=futuresManifest();
  const row=receipt('CRYPTO_FUTURES:SWING','MARK_PRICE',manifest.datasetSnapshotHash);
  assert.throws(()=>buildAdaptiveEvidenceCatalogFromDataFactoryV1({
    datasetManifestsByProfile:{'CRYPTO_FUTURES:SWING':manifest},
    receipts:[{...row,evidenceId:'canonical:tampered'}],
  }),/RECEIPT_DIGEST_MISMATCH/);
});


test('invalid calendar timestamps cannot receive adaptive evidence credit',()=>{
  const manifest=futuresManifest();
  assert.throws(()=>createAdaptiveEvidenceReceiptV1({
    profileId:'CRYPTO_FUTURES:SWING',
    requirement:'MARK_PRICE',
    evidenceId:'canonical:bad-calendar-time',
    observedAt:'2026-02-30T00:00:00Z',
    datasetSnapshotHash:manifest.datasetSnapshotHash,
    sourceDigest:H('9'),
  }),/observedAt invalid/);
});
