import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { buildResearchDataReadinessV1 } from './research-data-factory.mjs';

export const RESEARCH_DATASET_SNAPSHOT_MANIFEST_CONTRACT_V1 = 'research-dataset-snapshot-manifest/v1';

const SHA40=/^[0-9a-f]{40}$/i;
const HASH64=/^[0-9a-f]{64}$/i;
const MARKET=/^(KR_STOCK|US_STOCK|CRYPTO_SPOT|CRYPTO_FUTURES)$/;

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
function safeRoot(value){
  const root=resolve(String(value??''));
  if(!root.startsWith('/')) throw new TypeError('stateRoot must be absolute');
  for(const forbidden of ['/opt/stock-app-data','/srv/stock-app','/var/lib/stock-app']){
    if(root===forbidden||root.startsWith(`${forbidden}/`)) throw new Error('dataset snapshot store overlaps protected app storage');
  }
  return root;
}
function core(manifest){
  const row={...manifest};
  delete row.manifestDigest;
  return row;
}

export function buildResearchDatasetSnapshotManifestV1({
  researchSha,
  createdAt,
  market,
  evidence,
}={}){
  const sha=exactSha(researchSha);
  const at=exactIso(createdAt);
  if(typeof market!=='string'||!MARKET.test(market)) throw new TypeError('market invalid');
  const readiness=buildResearchDataReadinessV1({market,evidence});
  if(readiness.ready!==true||!HASH64.test(readiness.datasetSnapshotHash??'')){
    const error=new Error('DATASET_NOT_RESEARCH_READY');
    error.code='DATASET_NOT_RESEARCH_READY';
    error.blockers=readiness.blockers;
    throw error;
  }
  const featureManifest=readiness.features.map(row=>Object.freeze({
    feature:row.feature,
    state:row.state,
    owner:row.owner,
    publicOnly:row.publicOnly,
    syntheticAllowed:false,
    replayCreditAllowed:false,
    backfillCreditAllowed:false,
  }));
  const body={
    schemaVersion:1,
    contract:RESEARCH_DATASET_SNAPSHOT_MANIFEST_CONTRACT_V1,
    researchSha:sha,
    createdAt:at,
    market,
    datasetSnapshotHash:readiness.datasetSnapshotHash,
    evidenceDigest:readiness.evidenceDigest,
    requiredFeatures:Object.freeze([...readiness.requiredFeatures]),
    features:Object.freeze(featureManifest),
    safety:Object.freeze({
      immutable:true,
      contentAddressed:true,
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
    ||!HASH64.test(manifest.evidenceDigest??'')
    ||!HASH64.test(manifest.manifestDigest??'')
    ||!Array.isArray(manifest.requiredFeatures)
    ||!Array.isArray(manifest.features)
    ||manifest.safety?.immutable!==true
    ||manifest.safety?.contentAddressed!==true
    ||manifest.safety?.publicDataOnly!==true
    ||manifest.safety?.syntheticImputation!==false
    ||manifest.safety?.zeroImputation!==false
    ||manifest.safety?.currentValueHistoricalBackfill!==false
    ||manifest.safety?.futureLeakage!==false
    ||manifest.safety?.economicCredit!==false
    ||manifest.safety?.executionAuthority!=='NONE'){
    throw new TypeError('invalid dataset snapshot manifest');
  }
  if(digest(core(manifest))!==manifest.manifestDigest) throw new Error('DATASET_MANIFEST_DIGEST_MISMATCH');
  return manifest;
}

export async function persistResearchDatasetSnapshotManifestV1({
  stateRoot,
  manifest,
}={}){
  assertResearchDatasetSnapshotManifestV1(manifest);
  const root=safeRoot(stateRoot);
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
      executionAuthority:'NONE',
    });
  }catch(error){
    if(error?.code!=='EEXIST') throw error;
    const existing=JSON.parse(await readFile(path,'utf8'));
    assertResearchDatasetSnapshotManifestV1(existing);
    if(existing.manifestDigest!==manifest.manifestDigest
      ||existing.datasetSnapshotHash!==manifest.datasetSnapshotHash){
      throw new Error('DATASET_SNAPSHOT_CONTENT_ADDRESS_CONFLICT');
    }
    return Object.freeze({
      status:'already_present',
      datasetSnapshotHash:existing.datasetSnapshotHash,
      manifestDigest:existing.manifestDigest,
      executionAuthority:'NONE',
    });
  }
}
