import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import {
  ADAPTIVE_MULTI_MARKET_PROFILES_V1,
} from '../../market-prediction-lab/src/adaptive-multi-market-tournament-orchestrator-v1.js';

export const RESEARCH_DEVELOPMENT_DIAGNOSTICS_CONTRACT_V1 =
  'research-development-diagnostics/v1';

const HASH64=/^[0-9a-f]{64}$/i;
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const PROFILE_IDS=new Set(ADAPTIVE_MULTI_MARKET_PROFILES_V1.map(row=>row.profileId));
const DIAGNOSTIC_KEYS=[
  'sourceRole','evidenceId','dataCompleteness','signalCoverage','costCoverage','familyDiversity','computeCapacity',
];
const SOURCE_DIGEST_KEYS=['dataset','signals','costs','families','compute'];
const RECORD_SAFETY_KEYS=[
  'developmentOnly','oosInputAllowed','forwardInputAllowed','paperInputAllowed',
  'holdoutInputAllowed','profitabilityInputAllowed','executionAuthority',
];

function canonical(value){
  if(Array.isArray(value)) return value.map(canonical);
  if(value===null||typeof value!=='object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
}
function digest(value){
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
function exactKeys(value,keys,code){
  if(!value||typeof value!=='object'||Array.isArray(value)) throw new TypeError(code);
  const actual=Object.keys(value).sort();
  const expected=[...keys].sort();
  if(actual.length!==expected.length||actual.some((key,index)=>key!==expected[index])) throw new Error(code);
}
function nonNegativeInt(value,name){
  if(!Number.isSafeInteger(value)||value<0) throw new TypeError(`${name}_INVALID`);
  return value;
}
function positiveInt(value,name){
  if(!Number.isSafeInteger(value)||value<=0) throw new TypeError(`${name}_INVALID`);
  return value;
}
function evidenceDigest(value,name){
  const text=String(value??'').toLowerCase();
  if(!HASH64.test(text)) throw new TypeError(`${name}_INVALID`);
  return text;
}
function ratio(numerator,denominator,name){
  const n=nonNegativeInt(numerator,`${name}_NUMERATOR`);
  const d=positiveInt(denominator,`${name}_DENOMINATOR`);
  if(n>d) throw new Error(`${name}_NUMERATOR_EXCEEDS_DENOMINATOR`);
  return n/d;
}
function normalizedEntropy(counts){
  if(!Array.isArray(counts)||counts.length===0) throw new TypeError('FAMILY_COUNTS_INVALID');
  const values=counts.map((value,index)=>nonNegativeInt(value,`FAMILY_COUNT_${index}`)).filter(value=>value>0);
  if(values.length===0) throw new Error('FAMILY_COUNTS_EMPTY');
  if(values.length===1) return 0;
  const total=values.reduce((sum,value)=>sum+value,0);
  let entropy=0;
  for(const value of values){
    const p=value/total;
    entropy-=p*Math.log(p);
  }
  return entropy/Math.log(values.length);
}
function exactIso(value){
  const text=String(value??'');
  const date=new Date(text);
  const normalized=text.includes('.')?text:text.replace(/Z$/u,'.000Z');
  if(!ISO.test(text)||!Number.isFinite(date.getTime())||date.toISOString()!==normalized){
    throw new TypeError('OBSERVED_AT_INVALID');
  }
  return date.toISOString();
}
function unitMetric(value,name){
  if(!Number.isFinite(value)||value<0||value>1) throw new TypeError(`${name}_INVALID`);
  return value;
}
function developmentInput(raw){
  exactKeys(raw,[
    'profileId','sourceRole','observedAt','dataset','signals','costs','families','compute',
  ],'DEVELOPMENT_DIAGNOSTIC_INPUT_SHAPE_INVALID');
  if(raw.sourceRole!=='DEVELOPMENT_ONLY') throw new Error('DEVELOPMENT_ONLY_SOURCE_REQUIRED');
  if(!PROFILE_IDS.has(raw.profileId)) throw new Error('DEVELOPMENT_PROFILE_UNKNOWN');
  exactKeys(raw.dataset,['observedCells','expectedCells','evidenceDigest'],'DEVELOPMENT_DATASET_SHAPE_INVALID');
  exactKeys(raw.signals,['evaluableCandidates','totalCandidates','evidenceDigest'],'DEVELOPMENT_SIGNALS_SHAPE_INVALID');
  exactKeys(raw.costs,['readyComponents','requiredComponents','evidenceDigest'],'DEVELOPMENT_COSTS_SHAPE_INVALID');
  exactKeys(raw.families,['counts','evidenceDigest'],'DEVELOPMENT_FAMILIES_SHAPE_INVALID');
  exactKeys(raw.compute,['maxConcurrentJobs','baseConcurrency','evidenceDigest'],'DEVELOPMENT_COMPUTE_SHAPE_INVALID');
  return raw;
}

export function buildResearchDevelopmentDiagnosticV1(raw={}){
  const input=developmentInput(raw);
  const dataCompleteness=ratio(input.dataset.observedCells,input.dataset.expectedCells,'DATA_COMPLETENESS');
  const signalCoverage=ratio(input.signals.evaluableCandidates,input.signals.totalCandidates,'SIGNAL_COVERAGE');
  const costCoverage=ratio(input.costs.readyComponents,input.costs.requiredComponents,'COST_COVERAGE');
  const familyTotal=input.families.counts.reduce((sum,value)=>sum+nonNegativeInt(value,'FAMILY_COUNT'),0);
  if(familyTotal!==input.signals.totalCandidates){
    throw new Error('FAMILY_COUNT_TOTAL_MISMATCH');
  }
  const familyDiversity=normalizedEntropy(input.families.counts);
  const computeCapacity=ratio(input.compute.maxConcurrentJobs,input.compute.baseConcurrency,'COMPUTE_CAPACITY');
  const observedAt=exactIso(input.observedAt);
  const sourceDigests=Object.freeze({
    dataset:evidenceDigest(input.dataset.evidenceDigest,'DATASET_EVIDENCE_DIGEST'),
    signals:evidenceDigest(input.signals.evidenceDigest,'SIGNAL_EVIDENCE_DIGEST'),
    costs:evidenceDigest(input.costs.evidenceDigest,'COST_EVIDENCE_DIGEST'),
    families:evidenceDigest(input.families.evidenceDigest,'FAMILY_EVIDENCE_DIGEST'),
    compute:evidenceDigest(input.compute.evidenceDigest,'COMPUTE_EVIDENCE_DIGEST'),
  });
  const evidenceCore={
    contract:RESEARCH_DEVELOPMENT_DIAGNOSTICS_CONTRACT_V1,
    profileId:input.profileId,
    observedAt,
    sourceDigests,
    metrics:{dataCompleteness,signalCoverage,costCoverage,familyDiversity,computeCapacity},
  };
  const evidenceId=`development-diagnostic:sha256:${digest(evidenceCore)}`;
  return Object.freeze({
    profileId:input.profileId,
    observedAt,
    diagnostic:Object.freeze({
      sourceRole:'DEVELOPMENT_ONLY',
      evidenceId,
      dataCompleteness,
      signalCoverage,
      costCoverage,
      familyDiversity,
      computeCapacity,
    }),
    sourceDigests,
    evidenceDigest:digest(evidenceCore),
    safety:Object.freeze({
      developmentOnly:true,
      oosInputAllowed:false,
      forwardInputAllowed:false,
      paperInputAllowed:false,
      holdoutInputAllowed:false,
      profitabilityInputAllowed:false,
      performanceMetricInputAllowed:false,
      numericSubstitutionAllowed:false,
      executionAuthority:'NONE',
    }),
  });
}

export function buildResearchDevelopmentDiagnosticsMapV1({profiles=[]}={}){
  if(!Array.isArray(profiles)) throw new TypeError('profiles must be an array');
  const diagnostics={};
  const records={};
  for(const raw of profiles){
    const result=buildResearchDevelopmentDiagnosticV1(raw);
    if(Object.hasOwn(diagnostics,result.profileId)) throw new Error('DUPLICATE_DEVELOPMENT_PROFILE');
    diagnostics[result.profileId]=result.diagnostic;
    records[result.profileId]=Object.freeze({
      observedAt:result.observedAt,
      evidenceDigest:result.evidenceDigest,
      sourceDigests:result.sourceDigests,
    });
  }
  const recordCore={
    schemaVersion:1,
    contract:'research-development-diagnostics-record/v1',
    profileCount:Object.keys(diagnostics).length,
    records:Object.freeze(records),
    safety:Object.freeze({
      developmentOnly:true,
      oosInputAllowed:false,
      forwardInputAllowed:false,
      paperInputAllowed:false,
      holdoutInputAllowed:false,
      profitabilityInputAllowed:false,
      executionAuthority:'NONE',
    }),
  };
  return Object.freeze({
    diagnostics:Object.freeze(diagnostics),
    record:Object.freeze({...recordCore,recordDigest:digest(recordCore)}),
  });
}

export function validateResearchDevelopmentDiagnosticsV1({diagnostics=null,record=null}={}){
  if(diagnostics==null&&record==null) return Object.freeze({});
  if(!diagnostics||typeof diagnostics!=='object'||Array.isArray(diagnostics)){
    throw new TypeError('DEVELOPMENT_DIAGNOSTICS_MAP_INVALID');
  }
  if(record==null) throw new Error('DEVELOPMENT_DIAGNOSTICS_RECORD_REQUIRED');
  exactKeys(record,[
    'schemaVersion','contract','profileCount','records','safety','recordDigest',
  ],'DEVELOPMENT_DIAGNOSTICS_RECORD_SHAPE_INVALID');
  if(record.schemaVersion!==1||record.contract!=='research-development-diagnostics-record/v1'){
    throw new Error('DEVELOPMENT_DIAGNOSTICS_RECORD_CONTRACT_INVALID');
  }
  const profileIds=Object.keys(diagnostics).sort();
  if(record.profileCount!==profileIds.length) throw new Error('DEVELOPMENT_DIAGNOSTICS_PROFILE_COUNT_MISMATCH');
  exactKeys(record.records,profileIds,'DEVELOPMENT_DIAGNOSTICS_RECORD_PROFILE_SET_MISMATCH');
  exactKeys(record.safety,RECORD_SAFETY_KEYS,'DEVELOPMENT_DIAGNOSTICS_RECORD_SAFETY_SHAPE_INVALID');
  if(record.safety.developmentOnly!==true
    || record.safety.oosInputAllowed!==false
    || record.safety.forwardInputAllowed!==false
    || record.safety.paperInputAllowed!==false
    || record.safety.holdoutInputAllowed!==false
    || record.safety.profitabilityInputAllowed!==false
    || record.safety.executionAuthority!=='NONE'){
    throw new Error('DEVELOPMENT_DIAGNOSTICS_RECORD_SAFETY_INVALID');
  }

  const normalizedDiagnostics={};
  const normalizedRecords={};
  for(const profileId of profileIds){
    if(!PROFILE_IDS.has(profileId)) throw new Error('DEVELOPMENT_PROFILE_UNKNOWN');
    const diagnostic=diagnostics[profileId];
    exactKeys(diagnostic,DIAGNOSTIC_KEYS,'DEVELOPMENT_DIAGNOSTIC_SHAPE_INVALID');
    if(diagnostic.sourceRole!=='DEVELOPMENT_ONLY') throw new Error('DEVELOPMENT_ONLY_SOURCE_REQUIRED');
    const metrics={
      dataCompleteness:unitMetric(diagnostic.dataCompleteness,'DATA_COMPLETENESS'),
      signalCoverage:unitMetric(diagnostic.signalCoverage,'SIGNAL_COVERAGE'),
      costCoverage:unitMetric(diagnostic.costCoverage,'COST_COVERAGE'),
      familyDiversity:unitMetric(diagnostic.familyDiversity,'FAMILY_DIVERSITY'),
      computeCapacity:unitMetric(diagnostic.computeCapacity,'COMPUTE_CAPACITY'),
    };
    const row=record.records[profileId];
    exactKeys(row,['observedAt','evidenceDigest','sourceDigests'],'DEVELOPMENT_DIAGNOSTICS_RECORD_ROW_SHAPE_INVALID');
    const observedAt=exactIso(row.observedAt);
    exactKeys(row.sourceDigests,SOURCE_DIGEST_KEYS,'DEVELOPMENT_DIAGNOSTICS_SOURCE_DIGESTS_SHAPE_INVALID');
    const sourceDigests=Object.fromEntries(SOURCE_DIGEST_KEYS.map(key=>[
      key,evidenceDigest(row.sourceDigests[key],`${key.toUpperCase()}_EVIDENCE_DIGEST`),
    ]));
    const evidenceCore={
      contract:RESEARCH_DEVELOPMENT_DIAGNOSTICS_CONTRACT_V1,
      profileId,
      observedAt,
      sourceDigests,
      metrics,
    };
    const expectedEvidenceDigest=digest(evidenceCore);
    if(String(row.evidenceDigest??'').toLowerCase()!==expectedEvidenceDigest){
      throw new Error('DEVELOPMENT_DIAGNOSTICS_EVIDENCE_DIGEST_MISMATCH');
    }
    if(diagnostic.evidenceId!==`development-diagnostic:sha256:${expectedEvidenceDigest}`){
      throw new Error('DEVELOPMENT_DIAGNOSTICS_EVIDENCE_ID_MISMATCH');
    }
    normalizedDiagnostics[profileId]=Object.freeze({
      sourceRole:'DEVELOPMENT_ONLY',
      evidenceId:diagnostic.evidenceId,
      ...metrics,
    });
    normalizedRecords[profileId]=Object.freeze({
      observedAt,
      evidenceDigest:expectedEvidenceDigest,
      sourceDigests:Object.freeze(sourceDigests),
    });
  }

  const recordCore={
    schemaVersion:1,
    contract:'research-development-diagnostics-record/v1',
    profileCount:profileIds.length,
    records:Object.freeze(normalizedRecords),
    safety:Object.freeze({...record.safety}),
  };
  if(String(record.recordDigest??'').toLowerCase()!==digest(recordCore)){
    throw new Error('DEVELOPMENT_DIAGNOSTICS_RECORD_DIGEST_MISMATCH');
  }
  return Object.freeze(normalizedDiagnostics);
}

async function safeStateRoot(value){
  const raw=String(value??'').trim();
  if(!raw||!isAbsolute(raw)) throw new TypeError('stateRoot must be absolute');
  const root=resolve(raw);
  for(const forbidden of ['/opt/stock-app-data','/srv/stock-app','/var/lib/stock-app']){
    if(root===forbidden||root.startsWith(`${forbidden}/`)){
      throw new Error('development diagnostics state overlaps protected app storage');
    }
  }
  let probe=root;
  while(true){
    try{
      const info=await lstat(probe);
      if(info.isSymbolicLink()) throw new Error('development diagnostics stateRoot must not contain symbolic links');
      if(resolve(await realpath(probe))!==probe) throw new Error('development diagnostics stateRoot must not contain symbolic links');
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

async function ensureSafeDirectory(path,name,{recursive=false}={}){
  try{
    await mkdir(path,{recursive,mode:0o700});
  }catch(error){
    if(error?.code!=='EEXIST') throw error;
  }
  const info=await lstat(path);
  if(!info.isDirectory()||info.isSymbolicLink()) throw new Error(`${name} must be a regular non-symlink directory`);
  if(resolve(await realpath(path))!==path) throw new Error(`${name} must not traverse symbolic links`);
  return path;
}

async function atomicJson(path,value){
  const directory=dirname(path);
  const info=await lstat(directory);
  if(!info.isDirectory()||info.isSymbolicLink()||resolve(await realpath(directory))!==directory){
    throw new Error('development diagnostics output directory unsafe');
  }
  const temp=`${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp,`${JSON.stringify(value,null,2)}\n`,{mode:0o600});
  await rename(temp,path);
}

export async function persistResearchDevelopmentDiagnosticsV1({
  stateRoot,
  profiles=[],
}={}){
  const root=await safeStateRoot(stateRoot);
  const built=buildResearchDevelopmentDiagnosticsMapV1({profiles});
  await ensureSafeDirectory(root,'development diagnostics stateRoot',{recursive:true});
  const latest=await ensureSafeDirectory(resolve(root,'latest'),'development diagnostics latest');
  const diagnosticsPath=resolve(latest,'adaptive-development-diagnostics.json');
  const recordPath=resolve(latest,'adaptive-development-diagnostics-record.json');
  await atomicJson(diagnosticsPath,built.diagnostics);
  await atomicJson(recordPath,built.record);
  return Object.freeze({
    status:'persisted',
    diagnosticsPath,
    recordPath,
    profileCount:built.record.profileCount,
    recordDigest:built.record.recordDigest,
    executionAuthority:'NONE',
  });
}
