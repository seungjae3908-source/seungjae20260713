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

function missing(){
  return Object.freeze({status:'MISSING',evidenceId:null,observedAt:null});
}
function present(evidenceId,observedAt){
  if(typeof evidenceId!=='string'||!SAFE_ID.test(evidenceId)) throw new TypeError('evidenceId invalid');
  if(typeof observedAt!=='string'||!ISO.test(observedAt)) throw new TypeError('observedAt invalid');
  return Object.freeze({status:'PRESENT',evidenceId,observedAt});
}
function profileMap(){
  return new Map(ADAPTIVE_MULTI_MARKET_PROFILES_V1.map(row=>[row.profileId,row]));
}
function normalizeManifests(input={}){
  const byMarket={};
  for(const [market,manifest] of Object.entries(input)){
    assertResearchDatasetSnapshotManifestV1(manifest);
    if(manifest.market!==market) throw new Error('DATASET_MANIFEST_MARKET_MISMATCH');
    byMarket[market]=manifest;
  }
  return Object.freeze(byMarket);
}
function normalizeReceipts(receipts=[],manifests){
  if(!Array.isArray(receipts)) throw new TypeError('receipts must be an array');
  const profiles=profileMap();
  const result=new Map();
  for(const raw of receipts){
    if(!raw||typeof raw!=='object'||Array.isArray(raw)) throw new TypeError('evidence receipt invalid');
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
    const manifest=manifests[profile.market];
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
  datasetManifestsByMarket={},
  receipts=[],
}={}){
  const manifests=normalizeManifests(datasetManifestsByMarket);
  const receiptMap=normalizeReceipts(receipts,manifests);
  const evidenceCatalog={};

  for(const profile of ADAPTIVE_MULTI_MARKET_PROFILES_V1){
    const manifest=manifests[profile.market]??null;
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
      Object.entries(manifests).map(([market,manifest])=>[
        market,
        Object.freeze({
          datasetSnapshotHash:manifest.datasetSnapshotHash,
          manifestDigest:manifest.manifestDigest,
          evidenceDigest:manifest.evidenceDigest,
        }),
      ]),
    )),
    safety:Object.freeze({
      missingEvidenceNumericSubstitutionAllowed:false,
      crossDatasetEvidenceAllowed:false,
      syntheticEvidenceAllowed:false,
      backfillCreditAllowed:false,
      executionAuthority:'NONE',
    }),
  });
}
