import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import {
  ADAPTIVE_MULTI_MARKET_PROFILES_V1,
} from '../../market-prediction-lab/src/adaptive-multi-market-tournament-orchestrator-v1.js';
import { buildResearchDataReadinessV1 } from './research-data-factory.mjs';

export const RESEARCH_DATASET_SNAPSHOT_MANIFEST_CONTRACT_V1 = 'research-dataset-snapshot-manifest/v1';

const SHA40=/^[0-9a-f]{40}$/i;
const HASH64=/^[0-9a-f]{64}$/i;
const SYMBOL=/^[A-Z0-9._:-]{1,64}$/;

function canonical(value){
  if(Array.isArray(value)) return value.map(canonical);
  if(!value||typeof value!=='object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
}
function digest(value){return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');}
function exactSha(value){
  const text=String(value??'').trim().toLowerCase();
  if(!SHA40.test(text)) throw new TypeError('researchSha must be exact SHA');
  return text;
}
function exactIso(value){
  const text=String(value??'');
  const date=new Date(text);
  if(!Number.isFinite(date.getTime())) throw new TypeError('createdAt invalid');
  return date.toISOString();
}
function assertProtectedRoot(root){
  for(const forbidden of ['/opt/stock-app-data','/srv/stock-app','/var/lib/stock-app']){
    if(root===forbidden||root.startsWith(`${forbidden}/`)) {
      throw new Error('dataset snapshot store overlaps protected app storage');
    }
  }
}
async function safeRoot(value){
  const raw=String(value??'').trim();
  if(!raw||!isAbsolute(raw)) throw new TypeError('stateRoot must be absolute');
  const root=resolve(raw);
  assertProtectedRoot(root);

  let probe=root;
  while(true){
    try{
      const info=await lstat(probe);
      if(info.isSymbolicLink()) throw new Error('dataset snapshot stateRoot must not contain symbolic links');
      const canonical=resolve(await realpath(probe));
      if(canonical!==probe) throw new Error('dataset snapshot stateRoot must not contain symbolic links');
      break;
    }catch(error){
      if(error?.code!=='ENOENT') throw error;
      const parent=dirname(probe);
      if(parent===probe) throw error;
      probe=parent;
    }
  }
  return root;
}
function profile(profileId){
  const row=ADAPTIVE_MULTI_MARKET_PROFILES_V1.find(item=>item.profileId===profileId);
  if(!row) throw new TypeError('profileId invalid');
  return row;
}
function normalizeScope(raw,expectedProfile){
  if(!raw||typeof raw!=='object'||Array.isArray(raw)) throw new TypeError('scope is required');
  if(raw.timeframe!==expectedProfile.timeframe) throw new Error('DATASET_SCOPE_TIMEFRAME_MISMATCH');
  if(!Array.isArray(raw.symbols)||raw.symbols.length===0||raw.symbols.length>5000){
    throw new TypeError('scope.symbols invalid');
  }
  const symbols=[...new Set(raw.symbols.map(value=>String(value??'').trim().toUpperCase()))].sort();
  if(symbols.length!==raw.symbols.length||symbols.some(value=>!SYMBOL.test(value))){
    throw new TypeError('scope.symbols must be unique canonical symbols');
  }
  if(!Number.isSafeInteger(raw.startTime)||raw.startTime<=0
    ||!Number.isSafeInteger(raw.endTime)||raw.endTime<=raw.startTime){
    throw new TypeError('scope time range invalid');
  }
  if(typeof raw.primaryDatasetDigest!=='string'||!HASH64.test(raw.primaryDatasetDigest)){
    throw new TypeError('scope.primaryDatasetDigest invalid');
  }
  const universeDigest=raw.universeDigest==null?null:String(raw.universeDigest).toLowerCase();
  if(universeDigest!=null&&!HASH64.test(universeDigest)) throw new TypeError('scope.universeDigest invalid');
  if(raw.publicDataOnly!==true) throw new Error('DATASET_SCOPE_PUBLIC_ONLY_REQUIRED');
  return Object.freeze({
    timeframe:expectedProfile.timeframe,
    symbols:Object.freeze(symbols),
    startTime:raw.startTime,
    endTime:raw.endTime,
    primaryDatasetDigest:String(raw.primaryDatasetDigest).toLowerCase(),
    universeDigest,
    publicDataOnly:true,
  });
}
function snapshotIdentity({market,profileId,scope,marketReadinessHash,evidenceDigest}){
  return digest({market,profileId,scope,marketReadinessHash,evidenceDigest});
}
function core(manifest){
  const row={...manifest};
  delete row.manifestDigest;
  return row;
}

export function buildResearchDatasetSnapshotManifestV1({
  researchSha,
  createdAt,
  profileId,
  evidence,
  scope,
}={}){
  const sha=exactSha(researchSha);
  const at=exactIso(createdAt);
  const adaptiveProfile=profile(profileId);
  const readiness=buildResearchDataReadinessV1({market:adaptiveProfile.market,evidence});
  if(readiness.ready!==true||!HASH64.test(readiness.datasetSnapshotHash??'')){
    const error=new Error('DATASET_NOT_RESEARCH_READY');
    error.code='DATASET_NOT_RESEARCH_READY';
    error.blockers=readiness.blockers;
    throw error;
  }
  const normalizedScope=normalizeScope(scope,adaptiveProfile);
  const featureManifest=readiness.features.map(row=>Object.freeze({
    feature:row.feature,
    state:row.state,
    owner:row.owner,
    publicOnly:row.publicOnly,
    syntheticAllowed:false,
    replayCreditAllowed:false,
    backfillCreditAllowed:false,
  }));
  const datasetSnapshotHash=snapshotIdentity({
    market:adaptiveProfile.market,
    profileId:adaptiveProfile.profileId,
    scope:normalizedScope,
    marketReadinessHash:readiness.datasetSnapshotHash,
    evidenceDigest:readiness.evidenceDigest,
  });
  const body={
    schemaVersion:1,
    contract:RESEARCH_DATASET_SNAPSHOT_MANIFEST_CONTRACT_V1,
    researchSha:sha,
    createdAt:at,
    market:adaptiveProfile.market,
    profileId:adaptiveProfile.profileId,
    datasetSnapshotHash,
    marketReadinessHash:readiness.datasetSnapshotHash,
    evidenceDigest:readiness.evidenceDigest,
    scope:normalizedScope,
    requiredFeatures:Object.freeze([...readiness.requiredFeatures]),
    features:Object.freeze(featureManifest),
    safety:Object.freeze({
      immutable:true,
      contentAddressed:true,
      profileScoped:true,
      publicDataOnly:true,
      syntheticImputation:false,
      zeroImputation:false,
      currentValueHistoricalBackfill:false,
      futureLeakage:false,
      economicCredit:false,
      executionAuthority:'NONE',
    }),
  };
  return Object.freeze({...body,manifestDigest:digest(body)});
}

export function assertResearchDatasetSnapshotManifestV1(manifest){
  if(!manifest||manifest.contract!==RESEARCH_DATASET_SNAPSHOT_MANIFEST_CONTRACT_V1
    ||manifest.schemaVersion!==1
    ||!SHA40.test(manifest.researchSha??'')
    ||!HASH64.test(manifest.datasetSnapshotHash??'')
    ||!HASH64.test(manifest.marketReadinessHash??'')
    ||!HASH64.test(manifest.evidenceDigest??'')
    ||!HASH64.test(manifest.manifestDigest??'')
    ||!Array.isArray(manifest.requiredFeatures)
    ||!Array.isArray(manifest.features)
    ||manifest.safety?.immutable!==true
    ||manifest.safety?.contentAddressed!==true
    ||manifest.safety?.profileScoped!==true
    ||manifest.safety?.publicDataOnly!==true
    ||manifest.safety?.syntheticImputation!==false
    ||manifest.safety?.zeroImputation!==false
    ||manifest.safety?.currentValueHistoricalBackfill!==false
    ||manifest.safety?.futureLeakage!==false
    ||manifest.safety?.economicCredit!==false
    ||manifest.safety?.executionAuthority!=='NONE'){
    throw new TypeError('invalid dataset snapshot manifest');
  }
  const adaptiveProfile=profile(manifest.profileId);
  if(adaptiveProfile.market!==manifest.market) throw new Error('DATASET_MANIFEST_PROFILE_MARKET_MISMATCH');
  const normalizedScope=normalizeScope(manifest.scope,adaptiveProfile);
  if(JSON.stringify(normalizedScope)!==JSON.stringify(manifest.scope)) throw new Error('DATASET_SCOPE_NOT_CANONICAL');
  const expectedSnapshot=snapshotIdentity({
    market:manifest.market,
    profileId:manifest.profileId,
    scope:manifest.scope,
    marketReadinessHash:manifest.marketReadinessHash,
    evidenceDigest:manifest.evidenceDigest,
  });
  if(expectedSnapshot!==manifest.datasetSnapshotHash) throw new Error('DATASET_SNAPSHOT_HASH_MISMATCH');
  if(digest(core(manifest))!==manifest.manifestDigest) throw new Error('DATASET_MANIFEST_DIGEST_MISMATCH');
  return manifest;
}

export async function persistResearchDatasetSnapshotManifestV1({
  stateRoot,
  manifest,
}={}){
  assertResearchDatasetSnapshotManifestV1(manifest);
  const root=await safeRoot(stateRoot);
  const directory=join(root,'datasets',manifest.datasetSnapshotHash);
  const path=join(directory,'manifest.json');
  await mkdir(directory,{recursive:true,mode:0o700});
  const serialized=`${JSON.stringify(manifest,null,2)}\n`;
  try{
    await writeFile(path,serialized,{encoding:'utf8',mode:0o600,flag:'wx'});
    return Object.freeze({
      status:'created',
      datasetSnapshotHash:manifest.datasetSnapshotHash,
      manifestDigest:manifest.manifestDigest,
      profileId:manifest.profileId,
      executionAuthority:'NONE',
    });
  }catch(error){
    if(error?.code!=='EEXIST') throw error;
    const existing=JSON.parse(await readFile(path,'utf8'));
    assertResearchDatasetSnapshotManifestV1(existing);
    const sameContent =
      existing.datasetSnapshotHash===manifest.datasetSnapshotHash
      &&existing.evidenceDigest===manifest.evidenceDigest
      &&existing.marketReadinessHash===manifest.marketReadinessHash
      &&existing.market===manifest.market
      &&existing.profileId===manifest.profileId
      &&JSON.stringify(existing.scope)===JSON.stringify(manifest.scope)
      &&JSON.stringify(existing.requiredFeatures)===JSON.stringify(manifest.requiredFeatures)
      &&JSON.stringify(existing.features)===JSON.stringify(manifest.features)
      &&JSON.stringify(existing.safety)===JSON.stringify(manifest.safety);
    if(!sameContent){
      throw new Error('DATASET_SNAPSHOT_CONTENT_ADDRESS_CONFLICT');
    }
    return Object.freeze({
      status:'already_present',
      datasetSnapshotHash:existing.datasetSnapshotHash,
      manifestDigest:existing.manifestDigest,
      profileId:existing.profileId,
      createdByResearchSha:existing.researchSha,
      createdAt:existing.createdAt,
      executionAuthority:'NONE',
    });
  }
}
