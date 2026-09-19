import { createHash } from 'node:crypto';
import {
  ADAPTIVE_MULTI_MARKET_PROFILES_V1,
  assessAdaptiveProfileReadinessV1,
} from '../../market-prediction-lab/src/adaptive-multi-market-tournament-orchestrator-v1.js';
import {
  assertResearchDatasetSnapshotManifestV1,
} from './research-dataset-snapshot-store.mjs';

export const RESEARCH_ADAPTIVE_EVIDENCE_CATALOG_CONTRACT_V1 =
  'research-adaptive-evidence-catalog/v1';

const HASH64=/^[0-9a-f]{64}$/i;
const SAFE_ID=/^[A-Za-z0-9._:/#-]{1,240}$/;
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const RECEIPT_CONTRACT='research-adaptive-evidence-receipt/v1';

function canonical(value){
  if(Array.isArray(value)) return value.map(canonical);
  if(!value||typeof value!=='object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
}
function digest(value){return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');}
function missing(){return Object.freeze({status:'MISSING',evidenceId:null,observedAt:null});}
function present(evidenceId,observedAt){
  if(typeof evidenceId!=='string'||!SAFE_ID.test(evidenceId)) throw new TypeError('evidenceId invalid');
  if(typeof observedAt!=='string'||!ISO.test(observedAt)) throw new TypeError('observedAt invalid');
  return Object.freeze({status:'PRESENT',evidenceId,observedAt});
}
function profileMap(){
  return new Map(ADAPTIVE_MULTI_MARKET_PROFILES_V1.map(row=>[row.profileId,row]));
}

export function createAdaptiveEvidenceReceiptV1({
  profileId,
  requirement,
  evidenceId,
  observedAt,
  datasetSnapshotHash,
  sourceDigest,
}={}){
  const profile=profileMap().get(profileId);
  if(!profile) throw new Error('ADAPTIVE_EVIDENCE_PROFILE_UNKNOWN');
  if(!profile.requiredEvidence.includes(requirement)) throw new Error('ADAPTIVE_EVIDENCE_REQUIREMENT_UNKNOWN');
  if(requirement==='IMMUTABLE_DATASET_IDENTITY'||requirement==='PUBLIC_ONLY_SOURCE'){
    throw new Error('ADAPTIVE_EVIDENCE_REQUIREMENT_FACTORY_OWNED');
  }
  if(typeof datasetSnapshotHash!=='string'||!HASH64.test(datasetSnapshotHash)){
    throw new Error('ADAPTIVE_EVIDENCE_DATASET_HASH_INVALID');
  }
  if(typeof sourceDigest!=='string'||!HASH64.test(sourceDigest)){
    throw new Error('ADAPTIVE_EVIDENCE_SOURCE_DIGEST_INVALID');
  }
  present(evidenceId,observedAt);
  const core={
    schemaVersion:1,
    contract:RECEIPT_CONTRACT,
    profileId,
    requirement,
    evidenceId,
    observedAt,
    datasetSnapshotHash:datasetSnapshotHash.toLowerCase(),
    sourceDigest:sourceDigest.toLowerCase(),
    publicDataOnly:true,
    executionAuthority:'NONE',
  };
  return Object.freeze({...core,receiptDigest:digest(core)});
}

function normalizeManifests(input={}){
  if(!input||typeof input!=='object'||Array.isArray(input)){
    throw new TypeError('datasetManifestsByProfile must be an object');
  }
  const profiles=profileMap();
  const byProfile={};
  for(const [profileId,manifest] of Object.entries(input)){
    const profile=profiles.get(profileId);
    if(!profile) throw new Error('DATASET_MANIFEST_PROFILE_UNKNOWN');
    assertResearchDatasetSnapshotManifestV1(manifest);
    if(manifest.profileId!==profileId) throw new Error('DATASET_MANIFEST_PROFILE_MISMATCH');
    if(manifest.market!==profile.market) throw new Error('DATASET_MANIFEST_MARKET_MISMATCH');
    if(manifest.scope?.timeframe!==profile.timeframe) throw new Error('DATASET_MANIFEST_TIMEFRAME_MISMATCH');
    byProfile[profileId]=manifest;
  }
  return Object.freeze(byProfile);
}

function normalizeReceipts(receipts=[],manifests){
  if(!Array.isArray(receipts)) throw new TypeError('receipts must be an array');
  const profiles=profileMap();
  const result=new Map();
  for(const raw of receipts){
    if(!raw||typeof raw!=='object'||Array.isArray(raw)) throw new TypeError('evidence receipt invalid');
    const exactKeys=[
      'schemaVersion','contract','profileId','requirement','evidenceId','observedAt',
      'datasetSnapshotHash','sourceDigest','publicDataOnly','executionAuthority','receiptDigest',
    ].sort();
    const actualKeys=Object.keys(raw).sort();
    if(actualKeys.length!==exactKeys.length||actualKeys.some((key,index)=>key!==exactKeys[index])){
      throw new Error('ADAPTIVE_EVIDENCE_RECEIPT_SHAPE_INVALID');
    }
    if(raw.schemaVersion!==1||raw.contract!==RECEIPT_CONTRACT) throw new Error('ADAPTIVE_EVIDENCE_RECEIPT_CONTRACT_INVALID');
    const receiptCore={...raw};
    delete receiptCore.receiptDigest;
    if(typeof raw.receiptDigest!=='string'||!HASH64.test(raw.receiptDigest)||digest(receiptCore)!==raw.receiptDigest){
      throw new Error('ADAPTIVE_EVIDENCE_RECEIPT_DIGEST_MISMATCH');
    }
    if(typeof raw.sourceDigest!=='string'||!HASH64.test(raw.sourceDigest)){
      throw new Error('ADAPTIVE_EVIDENCE_SOURCE_DIGEST_INVALID');
    }
    const profile=profiles.get(raw.profileId);
    if(!profile) throw new Error('ADAPTIVE_EVIDENCE_PROFILE_UNKNOWN');
    if(!profile.requiredEvidence.includes(raw.requirement)) throw new Error('ADAPTIVE_EVIDENCE_REQUIREMENT_UNKNOWN');
    if(raw.requirement==='IMMUTABLE_DATASET_IDENTITY'||raw.requirement==='PUBLIC_ONLY_SOURCE'){
      throw new Error('ADAPTIVE_EVIDENCE_REQUIREMENT_FACTORY_OWNED');
    }
    if(raw.executionAuthority!=='NONE') throw new Error('ADAPTIVE_EVIDENCE_AUTHORITY_INVALID');
    if(raw.publicDataOnly!==true) throw new Error('ADAPTIVE_EVIDENCE_PUBLIC_ONLY_REQUIRED');
    if(typeof raw.datasetSnapshotHash!=='string'||!HASH64.test(raw.datasetSnapshotHash)){
      throw new Error('ADAPTIVE_EVIDENCE_DATASET_HASH_INVALID');
    }
    const manifest=manifests[raw.profileId];
    if(!manifest||manifest.datasetSnapshotHash!==raw.datasetSnapshotHash){
      throw new Error('ADAPTIVE_EVIDENCE_DATASET_BINDING_MISMATCH');
    }
    const cell=present(raw.evidenceId,raw.observedAt);
    const key=`${raw.profileId}|${raw.requirement}`;
    if(result.has(key)) throw new Error('ADAPTIVE_EVIDENCE_DUPLICATE_RECEIPT');
    result.set(key,cell);
  }
  return result;
}

export function buildAdaptiveEvidenceCatalogFromDataFactoryV1({
  datasetManifestsByProfile={},
  receipts=[],
}={}){
  const manifests=normalizeManifests(datasetManifestsByProfile);
  const receiptMap=normalizeReceipts(receipts,manifests);
  const evidenceCatalog={};

  for(const profile of ADAPTIVE_MULTI_MARKET_PROFILES_V1){
    const manifest=manifests[profile.profileId]??null;
    const supplied={};
    for(const requirement of profile.requiredEvidence){
      if(requirement==='IMMUTABLE_DATASET_IDENTITY'){
        supplied[requirement]=manifest
          ? present(`dataset-snapshot:${manifest.datasetSnapshotHash}`,manifest.createdAt)
          : missing();
        continue;
      }
      if(requirement==='PUBLIC_ONLY_SOURCE'){
        supplied[requirement]=manifest?.safety?.publicDataOnly===true
          ? present(`public-dataset:${manifest.datasetSnapshotHash}`,manifest.createdAt)
          : missing();
        continue;
      }
      supplied[requirement]=receiptMap.get(`${profile.profileId}|${requirement}`)??missing();
    }
    evidenceCatalog[profile.profileId]=Object.freeze(supplied);
  }

  const readiness=assessAdaptiveProfileReadinessV1({evidenceCatalog});
  return Object.freeze({
    schemaVersion:1,
    contract:RESEARCH_ADAPTIVE_EVIDENCE_CATALOG_CONTRACT_V1,
    evidenceCatalog:Object.freeze(evidenceCatalog),
    readiness,
    datasetBindings:Object.freeze(Object.fromEntries(
      Object.entries(manifests).map(([profileId,manifest])=>[
        profileId,
        Object.freeze({
          market:manifest.market,
          timeframe:manifest.scope.timeframe,
          datasetSnapshotHash:manifest.datasetSnapshotHash,
          manifestDigest:manifest.manifestDigest,
          evidenceDigest:manifest.evidenceDigest,
          primaryDatasetDigest:manifest.scope.primaryDatasetDigest,
        }),
      ]),
    )),
    safety:Object.freeze({
      profileScopedDatasetRequired:true,
      missingEvidenceNumericSubstitutionAllowed:false,
      crossDatasetEvidenceAllowed:false,
      crossProfileEvidenceAllowed:false,
      syntheticEvidenceAllowed:false,
      backfillCreditAllowed:false,
      executionAuthority:'NONE',
    }),
  });
}
