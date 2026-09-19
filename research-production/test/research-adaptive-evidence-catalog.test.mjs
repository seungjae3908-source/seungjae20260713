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
} from '../src/research-adaptive-evidence-catalog.mjs';

const SHA='a'.repeat(40);
const H=(x)=>x.repeat(64);
const AT='2026-09-20T00:00:00.000Z';

function futuresManifest(){
  return buildResearchDatasetSnapshotManifestV1({
    researchSha:SHA,
    createdAt:AT,
    market:'CRYPTO_FUTURES',
    evidence:{
      benchmarkDatasetDigest:H('1'),
      fundingHistoryDigest:H('2'),fundingCoverage:0.95,
      longShortHistoryDigest:H('3'),longShortCoverage:0.96,longShortTrainingParityConfirmed:true,
      openInterestHistoryDigest:H('4'),openInterestCoverage:0.97,openInterestTrainingParityConfirmed:true,
      sentimentHistoryDigest:H('5'),sentimentCoverage:0.93,sentimentTemporalParityConfirmed:true,
    },
  });
}

function receipt(profileId,requirement,hash){
  return {
    profileId,
    requirement,
    evidenceId:`canonical:${profileId}:${requirement}`,
    observedAt:AT,
    datasetSnapshotHash:hash,
    publicDataOnly:true,
    executionAuthority:'NONE',
  };
}

test('Dataset Snapshot automatically owns immutable identity and public-source requirements only',()=>{
  const manifest=futuresManifest();
  const result=buildAdaptiveEvidenceCatalogFromDataFactoryV1({
    datasetManifestsByMarket:{CRYPTO_FUTURES:manifest},
  });
  const row=result.readiness.profiles.find(p=>p.profileId==='CRYPTO_FUTURES:SWING');
  assert.equal(row.evidence.find(x=>x.requirement==='IMMUTABLE_DATASET_IDENTITY').status,'PRESENT');
  assert.equal(row.evidence.find(x=>x.requirement==='PUBLIC_ONLY_SOURCE').status,'PRESENT');
  assert.equal(row.evidence.find(x=>x.requirement==='MARK_PRICE').status,'MISSING');
  assert.equal(row.status,'BLOCKED_MISSING_EVIDENCE');
  assert.equal(result.safety.missingEvidenceNumericSubstitutionAllowed,false);
  assert.equal(result.safety.crossDatasetEvidenceAllowed,false);
});

test('profile becomes READY only when every non-Factory canonical receipt is same-snapshot bound',()=>{
  const manifest=futuresManifest();
  const profile=ADAPTIVE_MULTI_MARKET_PROFILES_V1.find(p=>p.profileId==='CRYPTO_FUTURES:SWING');
  const receipts=profile.requiredEvidence
    .filter(req=>!['IMMUTABLE_DATASET_IDENTITY','PUBLIC_ONLY_SOURCE'].includes(req))
    .map(req=>receipt(profile.profileId,req,manifest.datasetSnapshotHash));
  const result=buildAdaptiveEvidenceCatalogFromDataFactoryV1({
    datasetManifestsByMarket:{CRYPTO_FUTURES:manifest},
    receipts,
  });
  const row=result.readiness.profiles.find(p=>p.profileId===profile.profileId);
  assert.equal(row.status,'READY');
  assert.equal(row.missingRequirements.length,0);
  assert.equal(result.readiness.readyProfileCount,1);
});

test('cross-dataset receipt is rejected rather than credited',()=>{
  const manifest=futuresManifest();
  assert.throws(()=>buildAdaptiveEvidenceCatalogFromDataFactoryV1({
    datasetManifestsByMarket:{CRYPTO_FUTURES:manifest},
    receipts:[receipt('CRYPTO_FUTURES:SWING','MARK_PRICE',H('f'))],
  }),/DATASET_BINDING_MISMATCH/);
});

test('Factory-owned identity and public-source receipts cannot be overridden',()=>{
  const manifest=futuresManifest();
  assert.throws(()=>buildAdaptiveEvidenceCatalogFromDataFactoryV1({
    datasetManifestsByMarket:{CRYPTO_FUTURES:manifest},
    receipts:[receipt('CRYPTO_FUTURES:SWING','IMMUTABLE_DATASET_IDENTITY',manifest.datasetSnapshotHash)],
  }),/FACTORY_OWNED/);
});

test('duplicate and unknown canonical receipts fail closed',()=>{
  const manifest=futuresManifest();
  const row=receipt('CRYPTO_FUTURES:SWING','MARK_PRICE',manifest.datasetSnapshotHash);
  assert.throws(()=>buildAdaptiveEvidenceCatalogFromDataFactoryV1({
    datasetManifestsByMarket:{CRYPTO_FUTURES:manifest},
    receipts:[row,row],
  }),/DUPLICATE_RECEIPT/);
  assert.throws(()=>buildAdaptiveEvidenceCatalogFromDataFactoryV1({
    datasetManifestsByMarket:{CRYPTO_FUTURES:manifest},
    receipts:[{...row,requirement:'MADE_UP_REQUIREMENT'}],
  }),/REQUIREMENT_UNKNOWN/);
});
