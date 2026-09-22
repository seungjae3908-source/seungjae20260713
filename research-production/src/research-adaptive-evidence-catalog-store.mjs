import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import {
  buildAdaptiveEvidenceCatalogFromDataFactoryV1,
} from './research-adaptive-evidence-catalog.mjs';

export const RESEARCH_ADAPTIVE_CATALOG_STORE_CONTRACT_V1 =
  'research-adaptive-evidence-catalog-store/v1';

function canonical(value){
  if(Array.isArray(value)) return value.map(canonical);
  if(!value||typeof value!=='object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
}
function digest(value){return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');}
async function rootPath(value){
  const raw=String(value??'').trim();
  if(!raw||!isAbsolute(raw)) throw new TypeError('stateRoot must be absolute');
  const root=resolve(raw);
  let probe=root;
  while(true){
    try{
      const info=await lstat(probe);
      if(info.isSymbolicLink()) throw new Error('stateRoot must not contain symbolic links');
      if(resolve(await realpath(probe))!==probe) throw new Error('stateRoot must not contain symbolic links');
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
function childPath(root,value,name){
  const raw=String(value??'').trim();
  if(!raw||!isAbsolute(raw)) throw new Error(`${name} must be an absolute file below stateRoot`);
  const path=resolve(raw);
  const rel=relative(root,path);
  if(rel===''||rel==='..'||rel.startsWith(`..${sep}`)){
    throw new Error(`${name} must be a file below stateRoot`);
  }
  return path;
}
async function safeChildFile(root,value,name){
  const path=childPath(root,value,name);
  const info=await lstat(path);
  if(!info.isFile()||info.isSymbolicLink()) throw new Error(`${name} must be a regular non-symlink file`);
  const canonical=resolve(await realpath(path));
  const rel=relative(root,canonical);
  if(canonical!==path||rel===''||rel==='..'||rel.startsWith(`..${sep}`)){
    throw new Error(`${name} real path must remain below stateRoot`);
  }
  return path;
}
async function atomicJson(path,value){
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  const temp=`${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp,`${JSON.stringify(value,null,2)}\n`,{mode:0o600});
  await rename(temp,path);
}

export async function loadAdaptiveEvidenceCatalogInputsV1({
  stateRoot,
  manifestPathsByProfile={},
  receiptPaths=[],
}={}){
  const root=await rootPath(stateRoot);
  if(!manifestPathsByProfile||typeof manifestPathsByProfile!=='object'||Array.isArray(manifestPathsByProfile)){
    throw new TypeError('manifestPathsByProfile must be an object');
  }
  if(!Array.isArray(receiptPaths)) throw new TypeError('receiptPaths must be an array');
  const manifests={};
  for(const [profileId,pathValue] of Object.entries(manifestPathsByProfile)){
    const path=await safeChildFile(root,pathValue,`manifestPathsByProfile.${profileId}`);
    manifests[profileId]=JSON.parse(await readFile(path,'utf8'));
  }
  const receipts=[];
  for(let index=0;index<receiptPaths.length;index+=1){
    const path=await safeChildFile(root,receiptPaths[index],`receiptPaths[${index}]`);
    const value=JSON.parse(await readFile(path,'utf8'));
    if(Array.isArray(value)) receipts.push(...value);
    else if(Array.isArray(value?.receipts)) receipts.push(...value.receipts);
    else if(value?.receipt) receipts.push(value.receipt);
    else receipts.push(value);
  }
  return Object.freeze({
    datasetManifestsByProfile:Object.freeze(manifests),
    receipts:Object.freeze(receipts),
  });
}

export function buildAdaptiveEvidenceCatalogStoreRecordV1({
  catalog,
  generatedAt,
}={}){
  if(!catalog||catalog.contract!=='research-adaptive-evidence-catalog/v1'){
    throw new TypeError('validated adaptive evidence catalog is required');
  }
  const at=new Date(String(generatedAt??''));
  if(!Number.isFinite(at.getTime())) throw new TypeError('generatedAt invalid');
  const evidenceCatalogDigest=digest(catalog.evidenceCatalog);
  const datasetBindingsDigest=digest(catalog.datasetBindings);
  const core={
    schemaVersion:1,
    contract:RESEARCH_ADAPTIVE_CATALOG_STORE_CONTRACT_V1,
    generatedAt:at.toISOString(),
    evidenceCatalogDigest,
    datasetBindingsDigest,
    readyProfileCount:catalog.readiness.readyProfileCount,
    blockedProfileCount:catalog.readiness.blockedProfileCount,
    datasetBindings:catalog.datasetBindings,
    safety:Object.freeze({
      rawCatalogIsCanonicalInput:true,
      missingEvidenceNumericSubstitutionAllowed:false,
      crossDatasetEvidenceAllowed:false,
      crossProfileEvidenceAllowed:false,
      syntheticEvidenceAllowed:false,
      backfillCreditAllowed:false,
      executionAuthority:'NONE',
    }),
  };
  return Object.freeze({...core,recordDigest:digest(core)});
}

export function assertAdaptiveEvidenceCatalogStoreRecordV1({
  rawCatalog,
  record,
}={}){
  if(!rawCatalog||typeof rawCatalog!=='object'||Array.isArray(rawCatalog)
    ||!record||record.contract!==RESEARCH_ADAPTIVE_CATALOG_STORE_CONTRACT_V1
    ||record.schemaVersion!==1
    ||record.safety?.rawCatalogIsCanonicalInput!==true
    ||record.safety?.missingEvidenceNumericSubstitutionAllowed!==false
    ||record.safety?.crossDatasetEvidenceAllowed!==false
    ||record.safety?.crossProfileEvidenceAllowed!==false
    ||record.safety?.syntheticEvidenceAllowed!==false
    ||record.safety?.backfillCreditAllowed!==false
    ||record.safety?.executionAuthority!=='NONE'){
    throw new TypeError('invalid adaptive evidence catalog store record');
  }
  const core={...record};
  delete core.recordDigest;
  if(digest(core)!==record.recordDigest) throw new Error('ADAPTIVE_CATALOG_RECORD_DIGEST_MISMATCH');
  if(digest(rawCatalog)!==record.evidenceCatalogDigest) throw new Error('ADAPTIVE_CATALOG_RAW_DIGEST_MISMATCH');
  return Object.freeze({rawCatalog,record});
}

export async function persistAdaptiveEvidenceCatalogV1({
  stateRoot,
  catalog,
  generatedAt=new Date().toISOString(),
}={}){
  const root=await rootPath(stateRoot);
  const record=buildAdaptiveEvidenceCatalogStoreRecordV1({catalog,generatedAt});
  const rawPath=resolve(root,'latest','adaptive-evidence-catalog.json');
  const recordPath=resolve(root,'latest','adaptive-evidence-catalog-record.json');
  await atomicJson(rawPath,catalog.evidenceCatalog);
  await atomicJson(recordPath,record);
  return Object.freeze({
    schemaVersion:1,
    contract:RESEARCH_ADAPTIVE_CATALOG_STORE_CONTRACT_V1,
    status:'persisted',
    rawPath,
    recordPath,
    evidenceCatalogDigest:record.evidenceCatalogDigest,
    readyProfileCount:record.readyProfileCount,
    blockedProfileCount:record.blockedProfileCount,
    executionAuthority:'NONE',
  });
}

export async function loadPersistedAdaptiveEvidenceCatalogV1({stateRoot}={}){
  const root=await rootPath(stateRoot);
  const rawCatalog=JSON.parse(await readFile(resolve(root,'latest','adaptive-evidence-catalog.json'),'utf8'));
  const record=JSON.parse(await readFile(resolve(root,'latest','adaptive-evidence-catalog-record.json'),'utf8'));
  return assertAdaptiveEvidenceCatalogStoreRecordV1({rawCatalog,record});
}

export async function buildAndPersistAdaptiveEvidenceCatalogV1({
  stateRoot,
  manifestPathsByProfile,
  receiptPaths,
  generatedAt=new Date().toISOString(),
}={}){
  const inputs=await loadAdaptiveEvidenceCatalogInputsV1({
    stateRoot,manifestPathsByProfile,receiptPaths,
  });
  const catalog=buildAdaptiveEvidenceCatalogFromDataFactoryV1(inputs);
  const persisted=await persistAdaptiveEvidenceCatalogV1({stateRoot,catalog,generatedAt});
  return Object.freeze({catalog,persisted});
}
