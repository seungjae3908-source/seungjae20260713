import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  writeFile,
} from 'node:fs/promises';
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';

import {
  buildAutonomousAlphaArchitectureReadinessV1,
} from '../../market-prediction-lab/src/autonomous-alpha-certification-v1.js';

export const AUTONOMOUS_ALPHA_RUNTIME_HANDOFF_STORE_V1 =
  'autonomous-alpha-runtime-handoff-store/v1';

const SHA40=/^[0-9a-f]{40}$/u;
const HASH64=/^[0-9a-f]{64}$/u;

const REQUIRED_STAGE_KEYS=Object.freeze([
  'worldKnowledge',
  'alphaGenome',
  'redTeam',
  'forecast',
  'counterfactual',
  'digitalTwin',
  'championChallenger',
  'certification',
]);

function canonical(value){
  if(Array.isArray(value)) return value.map(canonical);
  if(!value||typeof value!=='object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key)=>[key,canonical(value[key])]),
  );
}

function digest(value){
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

function exactSha(value){
  const normalized=String(value??'').trim().toLowerCase();
  if(!SHA40.test(normalized)) throw new TypeError('sourceSha must be exact 40-character SHA');
  return normalized;
}

function absoluteRoot(value,name){
  const raw=String(value??'').trim();
  if(!raw||!isAbsolute(raw)) throw new TypeError(`${name} must be absolute`);
  return resolve(raw);
}

function below(root,value,name){
  const raw=String(value??'').trim();
  if(!raw||!isAbsolute(raw)) throw new TypeError(`${name} must be absolute`);
  const path=resolve(raw);
  const rel=relative(root,path);
  if(rel===''||rel==='..'||rel.startsWith(`..${sep}`)){
    throw new Error(`${name} must be below its allowed root`);
  }
  return path;
}

async function readSafeJsonOptional(path,{maxBytes=4*1024*1024}={}){
  try{
    const info=await lstat(path);
    if(!info.isFile()||info.isSymbolicLink()||info.size<=0||info.size>maxBytes){
      throw new Error('ALPHA_HANDOFF_INPUT_FILE_INVALID');
    }
    if(resolve(await realpath(path))!==path){
      throw new Error('ALPHA_HANDOFF_INPUT_PATH_UNSAFE');
    }
    return JSON.parse(await readFile(path,'utf8'));
  }catch(error){
    if(error?.code==='ENOENT') return null;
    throw error;
  }
}

async function atomicJson(path,value){
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  const temp=`${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp,`${JSON.stringify(value,null,2)}\n`,{mode:0o600});
  await rename(temp,path);
}

function safeCanonicalChain(value,sourceSha){
  return value
    && value.schemaVersion===1
    && value.contract==='research-canonical-chain/v1'
    && value.status==='CANONICAL_CHAIN_READY_NON_ACTIVATING'
    && value.researchSha===sourceSha
    && HASH64.test(String(value.dslDigest??''))
    && HASH64.test(String(value.bundleDigest??''))
    && HASH64.test(String(value.bindingsDigest??''))
    && value.publicationStatus==='READBACK_VERIFIED'
    && value.allBindingsAvailable===true
    && value.safety?.generatedEvidence===false
    && value.safety?.syntheticBundleAllowed===false
    && value.safety?.evidenceCredit===0
    && value.safety?.profitabilityProven===false
    && value.safety?.runtimeExecutionAttempted===false
    && value.safety?.runtimeActivationAllowed===false
    && value.safety?.scheduleMutationAllowed===false
    && value.safety?.deploymentAllowed===false
    && value.safety?.liveTrading===false
    && value.safety?.autoTrading===false
    && value.safety?.privateTradingApi===false
    && value.safety?.realOrder===false
    && value.safety?.executionAuthority==='NONE';
}

function safeBindingsRecord(record,rawBindings,sourceSha,chain){
  if(!record
    ||record.schemaVersion!==1
    ||record.contract!=='research-runtime-bindings-store/v1'
    ||record.sourceSha!==sourceSha
    ||!HASH64.test(String(record.bindingsDigest??''))
    ||!HASH64.test(String(record.recordDigest??''))
    ||record.allBindingsAvailable!==true
    ||!Array.isArray(record.missingKeys)
    ||record.missingKeys.length!==0
    ||record.safety?.rawBindingsAreCanonicalInput!==true
    ||record.safety?.runtimeExecutionAttempted!==false
    ||record.safety?.runtimeActivationAllowed!==false
    ||record.safety?.scheduleMutationAllowed!==false
    ||record.safety?.deploymentAllowed!==false
    ||record.safety?.liveTradingAllowed!==false
    ||record.safety?.executionAuthority!=='NONE'){
    return false;
  }
  const core={...record};
  delete core.recordDigest;
  return digest(core)===record.recordDigest
    && digest(rawBindings)===record.bindingsDigest
    && record.bindingsDigest===chain.bindingsDigest;
}

function safeArchitecture(readiness){
  return readiness
    && readiness.architectureReady===true
    && ['ARCHITECTURE_READY_EVIDENCE_PENDING_INACTIVE',
      'ARCHITECTURE_AND_PROFITABILITY_REVIEW_READY_INACTIVE'].includes(readiness.status)
    && readiness.executionAuthority==='NONE'
    && readiness.liveTradingAllowed===false
    && readiness.autoTradingAllowed===false
    && readiness.realOrderAllowed===false
    && Array.isArray(readiness.lineageChecks)
    && readiness.lineageChecks.every((row)=>row?.passed===true);
}

function safety(){
  return Object.freeze({
    publisherOnly:true,
    generatedEvidence:false,
    syntheticEvidenceAllowed:false,
    finalHoldoutSelectionAllowed:false,
    runtimeExecutionAttempted:false,
    runtimeActivationAllowed:false,
    scheduleMutationAllowed:false,
    deploymentAllowed:false,
    liveTrading:false,
    autoTrading:false,
    realOrderEnabled:false,
    privateTradingApiAllowed:false,
    executionAuthority:'NONE',
    economicSampleCredit:0,
  });
}

export async function buildAndPersistAutonomousAlphaRuntimeHandoffV1({
  sourceSha,
  artifactRoot,
  paperForwardRoot,
  canonicalChainPath,
  runtimeBindingsPath,
  runtimeBindingsRecordPath,
  stagePaths={},
  generatedAt=new Date().toISOString(),
  architectureReadinessBuilder=buildAutonomousAlphaArchitectureReadinessV1,
}={}){
  const sha=exactSha(sourceSha);
  const artifacts=absoluteRoot(artifactRoot,'artifactRoot');
  const paper=absoluteRoot(paperForwardRoot,'paperForwardRoot');
  const chainPath=below(artifacts,canonicalChainPath,'canonicalChainPath');
  const bindingsPath=below(artifacts,runtimeBindingsPath,'runtimeBindingsPath');
  const bindingsRecordPath=below(artifacts,runtimeBindingsRecordPath,'runtimeBindingsRecordPath');

  const normalizedStagePaths={};
  for(const key of REQUIRED_STAGE_KEYS){
    const value=stagePaths?.[key];
    normalizedStagePaths[key]=value==null
      ? null
      : below(artifacts,value,`stagePaths.${key}`);
  }

  const missing=[];
  const [chain,rawBindings,bindingsRecord]=await Promise.all([
    readSafeJsonOptional(chainPath),
    readSafeJsonOptional(bindingsPath),
    readSafeJsonOptional(bindingsRecordPath),
  ]);
  if(chain==null) missing.push('canonicalChain');
  if(rawBindings==null) missing.push('runtimeBindings');
  if(bindingsRecord==null) missing.push('runtimeBindingsRecord');

  const stages={};
  for(const key of REQUIRED_STAGE_KEYS){
    const path=normalizedStagePaths[key];
    if(path==null){
      missing.push(key);
      stages[key]=null;
      continue;
    }
    const value=await readSafeJsonOptional(path);
    if(value==null) missing.push(key);
    stages[key]=value;
  }

  if(missing.length>0){
    return Object.freeze({
      schemaVersion:1,
      contract:AUTONOMOUS_ALPHA_RUNTIME_HANDOFF_STORE_V1,
      status:'WAITING_FOR_CANONICAL_ALPHA_ARTIFACTS',
      sourceSha:sha,
      missingKeys:Object.freeze([...new Set(missing)].sort()),
      handoffWritten:false,
      profitabilityProven:false,
      ...safety(),
    });
  }

  if(!safeCanonicalChain(chain,sha)){
    return Object.freeze({
      schemaVersion:1,
      contract:AUTONOMOUS_ALPHA_RUNTIME_HANDOFF_STORE_V1,
      status:'BLOCKED_DATA',
      sourceSha:sha,
      blockers:Object.freeze(['ALPHA_CANONICAL_CHAIN_INVALID']),
      handoffWritten:false,
      profitabilityProven:false,
      ...safety(),
    });
  }

  if(!safeBindingsRecord(bindingsRecord,rawBindings,sha,chain)){
    return Object.freeze({
      schemaVersion:1,
      contract:AUTONOMOUS_ALPHA_RUNTIME_HANDOFF_STORE_V1,
      status:'BLOCKED_DATA',
      sourceSha:sha,
      blockers:Object.freeze(['ALPHA_RUNTIME_BINDINGS_INVALID']),
      handoffWritten:false,
      profitabilityProven:false,
      ...safety(),
    });
  }

  const architectureReadiness=architectureReadinessBuilder(stages);
  if(!safeArchitecture(architectureReadiness)){
    return Object.freeze({
      schemaVersion:1,
      contract:AUTONOMOUS_ALPHA_RUNTIME_HANDOFF_STORE_V1,
      status:'BLOCKED_DATA',
      sourceSha:sha,
      blockers:Object.freeze([
        'ALPHA_ARCHITECTURE_READINESS_INVALID',
        ...((architectureReadiness?.blockers??[]).map(String)),
      ]),
      handoffWritten:false,
      architectureReadiness,
      profitabilityProven:false,
      ...safety(),
    });
  }

  const generated=new Date(String(generatedAt??''));
  if(!Number.isFinite(generated.getTime())) throw new TypeError('generatedAt invalid');

  const core={
    schemaVersion:'autonomous-alpha-runtime-handoff-v1',
    generatedAt:generated.toISOString(),
    sourceSha:sha,
    canonicalChain:Object.freeze({
      bundleDigest:chain.bundleDigest,
      bindingsDigest:chain.bindingsDigest,
      publicationStatus:chain.publicationStatus,
      allBindingsAvailable:true,
    }),
    runtimeBindingsRecordDigest:bindingsRecord.recordDigest,
    worldKnowledge:stages.worldKnowledge,
    alphaGenome:stages.alphaGenome,
    redTeam:stages.redTeam,
    forecast:stages.forecast,
    counterfactual:stages.counterfactual,
    digitalTwin:stages.digitalTwin,
    championChallenger:stages.championChallenger,
    certification:stages.certification,
    liveTrading:false,
    autoTrading:false,
    realOrderEnabled:false,
    privateTradingApiAllowed:false,
    executionAuthority:'NONE',
  };
  const handoff=Object.freeze({
    ...core,
    handoffDigest:digest(core),
  });
  const outputPath=resolve(paper,'autonomous-alpha','handoff-v1.json');
  await atomicJson(outputPath,handoff);

  return Object.freeze({
    schemaVersion:1,
    contract:AUTONOMOUS_ALPHA_RUNTIME_HANDOFF_STORE_V1,
    status:'PUBLISHED_ALPHA_RUNTIME_HANDOFF',
    sourceSha:sha,
    outputPath,
    handoffDigest:handoff.handoffDigest,
    readinessDigest:architectureReadiness.readinessDigest,
    handoffWritten:true,
    profitabilityProven:architectureReadiness.profitabilityProven===true,
    ...safety(),
  });
}
