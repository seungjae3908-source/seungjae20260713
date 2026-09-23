import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import {
  buildAdaptiveRuntimeOwnerBindingsV1,
} from '../../market-prediction-lab/src/adaptive-runtime-owner-capabilities-v1.js';

export const RESEARCH_RUNTIME_BINDINGS_STORE_CONTRACT_V1 =
  'research-runtime-bindings-store/v1';

function canonical(value){
  if(Array.isArray(value)) return value.map(canonical);
  if(!value||typeof value!=='object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
}
function digest(value){
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
function rootPath(value){
  const root=resolve(String(value??''));
  if(!isAbsolute(root)) throw new TypeError('stateRoot must be absolute');
  return root;
}
async function atomicJson(path,value){
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  const temp=`${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp,`${JSON.stringify(value,null,2)}\n`,{mode:0o600});
  await rename(temp,path);
}
async function readOptionalSafeJson(pathValue){
  if(pathValue==null||String(pathValue).trim()==='') return null;
  const path=resolve(String(pathValue));
  if(!isAbsolute(path)) throw new TypeError('bundle publication path must be absolute');
  const info=await lstat(path);
  if(!info.isFile()||info.isSymbolicLink()||info.size<=0||info.size>4*1024*1024){
    throw new Error('BUNDLE_PUBLICATION_FILE_INVALID');
  }
  if(resolve(await realpath(path))!==path) throw new Error('BUNDLE_PUBLICATION_PATH_UNSAFE');
  return JSON.parse(await readFile(path,'utf8'));
}

export function buildResearchRuntimeBindingsStoreRecordV1({
  capabilityResult,
  generatedAt,
}={}){
  if(!capabilityResult
    ||capabilityResult.contract!=='adaptive-runtime-owner-capabilities/v1'
    ||!capabilityResult.bindings
    ||capabilityResult.safety?.capabilityEvidenceOnly!==true
    ||capabilityResult.safety?.runtimeExecutionAttempted!==false
    ||capabilityResult.safety?.runtimeActivationAllowed!==false
    ||capabilityResult.safety?.scheduleMutationAllowed!==false
    ||capabilityResult.safety?.deploymentAllowed!==false
    ||capabilityResult.safety?.finalHoldoutAccessAllowed!==false
    ||capabilityResult.safety?.liveTradingAllowed!==false
    ||capabilityResult.safety?.executionAuthority!=='NONE'){
    throw new TypeError('valid runtime owner capability result required');
  }
  const at=new Date(String(generatedAt??''));
  if(!Number.isFinite(at.getTime())) throw new TypeError('generatedAt invalid');
  const bindingsDigest=digest(capabilityResult.bindings);
  const core={
    schemaVersion:1,
    contract:RESEARCH_RUNTIME_BINDINGS_STORE_CONTRACT_V1,
    generatedAt:at.toISOString(),
    sourceSha:capabilityResult.sourceSha,
    bindingsDigest,
    availableKeys:capabilityResult.availableKeys,
    missingKeys:capabilityResult.missingKeys,
    allBindingsAvailable:capabilityResult.allBindingsAvailable,
    safety:Object.freeze({
      rawBindingsAreCanonicalInput:true,
      runtimeExecutionAttempted:false,
      runtimeActivationAllowed:false,
      scheduleMutationAllowed:false,
      deploymentAllowed:false,
      liveTradingAllowed:false,
      executionAuthority:'NONE',
    }),
  };
  return Object.freeze({...core,recordDigest:digest(core)});
}

export function assertResearchRuntimeBindingsStoreRecordV1({
  rawBindings,
  record,
}={}){
  if(!rawBindings||typeof rawBindings!=='object'||Array.isArray(rawBindings)
    ||!record||record.contract!==RESEARCH_RUNTIME_BINDINGS_STORE_CONTRACT_V1
    ||record.schemaVersion!==1
    ||record.safety?.rawBindingsAreCanonicalInput!==true
    ||record.safety?.runtimeExecutionAttempted!==false
    ||record.safety?.runtimeActivationAllowed!==false
    ||record.safety?.scheduleMutationAllowed!==false
    ||record.safety?.deploymentAllowed!==false
    ||record.safety?.liveTradingAllowed!==false
    ||record.safety?.executionAuthority!=='NONE'){
    throw new TypeError('invalid runtime bindings store record');
  }
  const core={...record};
  delete core.recordDigest;
  if(digest(core)!==record.recordDigest) throw new Error('RUNTIME_BINDINGS_RECORD_DIGEST_MISMATCH');
  if(digest(rawBindings)!==record.bindingsDigest) throw new Error('RUNTIME_BINDINGS_RAW_DIGEST_MISMATCH');
  return Object.freeze({rawBindings,record});
}

export async function buildAndPersistResearchRuntimeBindingsV1({
  stateRoot,
  sourceSha,
  bundlePublication=null,
  bundlePublicationPath=null,
  generatedAt=new Date().toISOString(),
}={}){
  const root=rootPath(stateRoot);
  if(bundlePublication!=null&&bundlePublicationPath!=null){
    throw new Error('BUNDLE_PUBLICATION_INPUT_AMBIGUOUS');
  }
  const publication=bundlePublicationPath==null
    ? bundlePublication
    : await readOptionalSafeJson(bundlePublicationPath);
  const capabilityResult=buildAdaptiveRuntimeOwnerBindingsV1({
    sourceSha,
    bundlePublication:publication,
  });
  const record=buildResearchRuntimeBindingsStoreRecordV1({
    capabilityResult,
    generatedAt,
  });
  const rawPath=resolve(root,'latest','adaptive-runtime-bindings.json');
  const recordPath=resolve(root,'latest','adaptive-runtime-bindings-record.json');
  await atomicJson(rawPath,capabilityResult.bindings);
  await atomicJson(recordPath,record);
  return Object.freeze({
    schemaVersion:1,
    contract:RESEARCH_RUNTIME_BINDINGS_STORE_CONTRACT_V1,
    status:'persisted',
    rawPath,
    recordPath,
    bindingsDigest:record.bindingsDigest,
    availableKeys:record.availableKeys,
    missingKeys:record.missingKeys,
    allBindingsAvailable:record.allBindingsAvailable,
    executionAuthority:'NONE',
  });
}

export async function loadPersistedResearchRuntimeBindingsV1({stateRoot}={}){
  const root=rootPath(stateRoot);
  const rawBindings=JSON.parse(await readFile(resolve(root,'latest','adaptive-runtime-bindings.json'),'utf8'));
  const record=JSON.parse(await readFile(resolve(root,'latest','adaptive-runtime-bindings-record.json'),'utf8'));
  return assertResearchRuntimeBindingsStoreRecordV1({rawBindings,record});
}
