import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';

import {
  buildResearchDatasetIdentity,
  sha256Canonical as hash,
  validateResearchDatasetIdentity,
} from '../../market-prediction-lab/src/research-cache-provenance.js';
import {
  assertResearchDatasetSnapshotManifestV1,
} from './research-dataset-snapshot-store.mjs';

export const RESEARCH_CANONICAL_DATASET_COMPONENT_CONTRACT_V1 =
  'research-canonical-dataset-component/v1';

const HASH64=/^[0-9a-f]{64}$/u;
const TIMEFRAME_MS=Object.freeze({
  '15m':15*60*1000,
  '1h':60*60*1000,
  '1d':24*60*60*1000,
});

function exactKeys(value,keys,code){
  if(!value||typeof value!=='object'||Array.isArray(value)) throw new TypeError(code);
  const actual=Object.keys(value).sort(),expected=[...keys].sort();
  if(actual.length!==expected.length||actual.some((key,index)=>key!==expected[index])) throw new Error(code);
}
function absolute(value,name){
  const path=resolve(String(value??''));
  if(!isAbsolute(path)) throw new TypeError(`${name} must be absolute`);
  return path;
}
function seal(id,payload){
  return Object.freeze({id:String(id),payload:Object.freeze(structuredClone(payload)),digest:hash(payload)});
}
async function writeOnce(directory,fileName,value){
  await mkdir(directory,{recursive:true,mode:0o700});
  const finalPath=join(directory,basename(fileName));
  const temp=join(directory,`.pending-${randomUUID()}`);
  const handle=await open(temp,'wx',0o600);
  try{
    await handle.writeFile(`${JSON.stringify(value,null,2)}\n`,'utf8');
    await handle.sync();
  }finally{
    await handle.close();
  }
  try{
    await link(temp,finalPath);
    return Object.freeze({status:'created',path:finalPath,digest:hash(value)});
  }catch(error){
    if(error?.code!=='EEXIST') throw error;
    const info=await lstat(finalPath);
    if(!info.isFile()||info.isSymbolicLink()||resolve(await realpath(finalPath))!==finalPath){
      throw new Error('DATASET_COMPONENT_EXISTING_PATH_UNSAFE');
    }
    const existing=JSON.parse(await readFile(finalPath,'utf8'));
    if(hash(existing)!==hash(value)) throw new Error('DATASET_COMPONENT_CONTENT_CONFLICT');
    return Object.freeze({status:'already_present',path:finalPath,digest:hash(existing)});
  }finally{
    try{await unlink(temp);}catch{}
  }
}
function validateRows(rows,manifest,symbol){
  if(!Array.isArray(rows)||rows.length<2||rows.length>250000) throw new TypeError('dataset rows invalid');
  const interval=TIMEFRAME_MS[manifest.scope.timeframe];
  if(!interval) throw new Error('DATASET_TIMEFRAME_UNSUPPORTED');
  const expectedCount=(manifest.scope.endTime-manifest.scope.startTime)/interval;
  if(!Number.isSafeInteger(expectedCount)||expectedCount<2||rows.length!==expectedCount){
    throw new Error('DATASET_SCOPE_COVERAGE_INCOMPLETE');
  }
  for(let index=0;index<rows.length;index+=1){
    const row=rows[index];
    if(!row||typeof row!=='object'||Array.isArray(row)) throw new Error('DATASET_ROW_INVALID');
    const expectedTimestamp=manifest.scope.startTime+index*interval;
    if(row.timestamp!==expectedTimestamp) throw new Error('DATASET_INTERVAL_OR_RANGE_MISMATCH');
    if(!['open','high','low','close','volume'].every(key=>typeof row[key]==='number'&&Number.isFinite(row[key]))){
      throw new Error('DATASET_ROW_NON_FINITE');
    }
    if(row.open<=0||row.high<=0||row.low<=0||row.close<=0||row.volume<0
      ||row.high<Math.max(row.open,row.close,row.low)
      ||row.low>Math.min(row.open,row.close,row.high)){
      throw new Error('DATASET_ROW_OHLC_INVALID');
    }
    if(row.symbol!=null&&String(row.symbol).toUpperCase()!==symbol) throw new Error('DATASET_ROW_SYMBOL_MISMATCH');
  }
  return interval;
}

export function buildCanonicalDatasetComponentV1({
  datasetSnapshotManifest,
  datasetId,
  symbol,
  rows,
  splitAssignments,
  metadata,
  observedAtMs,
}={}){
  assertResearchDatasetSnapshotManifestV1(datasetSnapshotManifest);
  const manifest=datasetSnapshotManifest;
  const normalizedSymbol=String(symbol??'').trim().toUpperCase();
  if(!manifest.scope.symbols.includes(normalizedSymbol)) throw new Error('DATASET_SYMBOL_OUTSIDE_PROFILE_SNAPSHOT');
  exactKeys(splitAssignments,['TRAIN','VALIDATION','OOS'],'DATASET_SPLIT_ASSIGNMENTS_SHAPE_INVALID');
  exactKeys(metadata,[
    'provider','providerVersion','sourceType','adjustmentMode','corporateActionMode',
    'timezone','sourceDigest','loaderVersion','missingIntervalCount','duplicateRowCount',
    'dataQualityStatus','profileSourceDigest',
  ],'DATASET_METADATA_SHAPE_INVALID');
  const interval=validateRows(rows,manifest,normalizedSymbol);
  if(metadata.profileSourceDigest!==manifest.scope.primaryDatasetDigest){
    throw new Error('DATASET_PROFILE_SOURCE_DIGEST_MISMATCH');
  }
  if(!HASH64.test(String(metadata.sourceDigest??''))) throw new Error('DATASET_SOURCE_DIGEST_INVALID');
  if(metadata.missingIntervalCount!==0||metadata.duplicateRowCount!==0||metadata.dataQualityStatus!=='VERIFIED'){
    throw new Error('DATASET_QUALITY_NOT_VERIFIED');
  }
  const timestamps=rows.map(row=>row.timestamp);
  const combined=[...splitAssignments.TRAIN,...splitAssignments.VALIDATION,...splitAssignments.OOS].sort((a,b)=>a-b);
  if(combined.length!==timestamps.length||combined.some((value,index)=>value!==timestamps[index])
    ||new Set(combined).size!==combined.length){
    throw new Error('DATASET_SPLIT_CONTRACT_NOT_EXACT');
  }

  const identity=buildResearchDatasetIdentity({
    market:manifest.market,
    symbol:normalizedSymbol,
    timeframe:manifest.scope.timeframe,
    rows,
    provider:metadata.provider,
    providerVersion:metadata.providerVersion,
    sourceType:metadata.sourceType,
    requestedStart:manifest.scope.startTime,
    requestedEnd:manifest.scope.endTime,
    actualStart:rows[0].timestamp,
    actualEnd:rows.at(-1).timestamp,
    adjustmentMode:metadata.adjustmentMode,
    corporateActionMode:metadata.corporateActionMode,
    timezone:metadata.timezone,
    splitContract:splitAssignments,
    sourceDigest:metadata.sourceDigest,
    researchCodeSha:manifest.researchSha,
    loaderVersion:metadata.loaderVersion,
    missingIntervalCount:0,
    duplicateRowCount:0,
    dataQualityStatus:'VERIFIED',
    generatedAt:manifest.createdAt,
  });
  if(validateResearchDatasetIdentity(identity).valid!==true) throw new Error('DATASET_IDENTITY_INVALID_AFTER_BUILD');
  if(identity.actualStart!==manifest.scope.startTime
    ||identity.actualEnd!==manifest.scope.endTime-interval
    ||identity.timeframe!==manifest.scope.timeframe
    ||identity.market!==manifest.market
    ||identity.symbol!==normalizedSymbol
    ||identity.researchCodeSha!==manifest.researchSha){
    throw new Error('DATASET_IDENTITY_PROFILE_SCOPE_MISMATCH');
  }

  const scope=Object.freeze({
    datasetId:String(datasetId),
    datasetDigest:identity.datasetDigest,
    market:identity.market,
    symbol:identity.symbol,
    timeframe:identity.timeframe,
    researchCodeSha:identity.researchCodeSha,
  });
  const receipt=seal(`dataset-receipt:${identity.datasetIdentityId}`,Object.freeze({
    ...scope,
    datasetIdentityId:identity.datasetIdentityId,
    rowCount:rows.length,
  }));
  const component=Object.freeze({
    id:scope.datasetId,
    identity,
    rows:Object.freeze(structuredClone(rows)),
    observationIntervalMs:interval,
    purpose:'STRATEGY_OHLCV',
    immutable:true,
    pointInTimeSafe:true,
    leakageStatus:'CLEAR',
    observedAtMs:Number(observedAtMs),
    receipt,
  });
  if(!Number.isSafeInteger(component.observedAtMs)
    ||component.observedAtMs<identity.actualEnd
    ||component.observedAtMs>Date.now()+365*24*60*60*1000){
    throw new Error('DATASET_OBSERVED_AT_INVALID');
  }
  const core=Object.freeze({
    schemaVersion:1,
    contract:RESEARCH_CANONICAL_DATASET_COMPONENT_CONTRACT_V1,
    profileId:manifest.profileId,
    datasetSnapshotHash:manifest.datasetSnapshotHash,
    datasetSnapshotManifestDigest:manifest.manifestDigest,
    profileSourceDigest:manifest.scope.primaryDatasetDigest,
    symbol:normalizedSymbol,
    datasetId:scope.datasetId,
    datasetIdentityId:identity.datasetIdentityId,
    datasetDigest:identity.datasetDigest,
    sourceDigest:identity.sourceDigest,
    componentDigest:hash(component),
    safety:Object.freeze({
      explicitRowsOnly:true,
      rowRepairAllowed:false,
      intervalInterpolationAllowed:false,
      syntheticDataAllowed:false,
      profileSnapshotBindingRequired:true,
      pointInTimeSafeRequired:true,
      executionAuthority:'NONE',
    }),
  });
  return Object.freeze({component,record:Object.freeze({...core,recordDigest:hash(core)})});
}

export async function persistCanonicalDatasetComponentV1({
  componentRoot,
  ...input
}={}){
  const root=absolute(componentRoot,'componentRoot');
  const built=buildCanonicalDatasetComponentV1(input);
  const directory=join(root,'dataset-components',built.record.datasetSnapshotHash,built.record.symbol);
  const componentWrite=await writeOnce(directory,'dataset.json',built.component);
  const recordWrite=await writeOnce(directory,'record.json',built.record);
  return Object.freeze({
    schemaVersion:1,
    contract:RESEARCH_CANONICAL_DATASET_COMPONENT_CONTRACT_V1,
    status:componentWrite.status==='created'||recordWrite.status==='created'?'persisted':'already_present',
    datasetSnapshotHash:built.record.datasetSnapshotHash,
    datasetIdentityId:built.record.datasetIdentityId,
    datasetDigest:built.record.datasetDigest,
    paths:Object.freeze({dataset:componentWrite.path,record:recordWrite.path}),
    executionAuthority:'NONE',
  });
}
