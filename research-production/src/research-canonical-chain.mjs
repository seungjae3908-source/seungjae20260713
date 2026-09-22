import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

export const RESEARCH_CANONICAL_CHAIN_CONTRACT_V1='research-canonical-chain/v1';

const SHA40=/^[0-9a-f]{40}$/i;
const HASH64=/^[0-9a-f]{64}$/i;

function exactSha(value){
  const sha=String(value??'').trim().toLowerCase();
  if(!SHA40.test(sha)) throw new TypeError('researchSha must be exact 40-character SHA');
  return sha;
}
function absolute(value,name){
  const raw=String(value??'').trim();
  if(!raw||!isAbsolute(raw)) throw new TypeError(`${name} must be absolute`);
  return resolve(raw);
}
function below(root,pathValue,name){
  const path=absolute(pathValue,name);
  const rel=relative(root,path);
  if(rel===''||rel==='..'||rel.startsWith(`..${sep}`)) throw new Error(`${name} must be below expected root`);
  return path;
}
async function safeExistingFileBelow(root,pathValue,name){
  const path=below(root,pathValue,name);
  const info=await lstat(path);
  if(!info.isFile()||info.isSymbolicLink()) throw new Error(`${name} must be a regular non-symlink file`);
  if(resolve(await realpath(path))!==path) throw new Error(`${name} real path must remain below expected root`);
  return path;
}
function parseJson(text,name){
  try{return JSON.parse(String(text??''));}
  catch{throw new Error(`${name}_OUTPUT_INVALID_JSON`);}
}
function defaultRunner({cwd,args,env}){
  const result=spawnSync(process.execPath,args,{
    cwd,
    env:{...process.env,...env},
    encoding:'utf8',
    maxBuffer:8*1024*1024,
  });
  return {
    status:result.status??1,
    stdout:result.stdout??'',
    stderr:result.stderr??'',
    error:result.error??null,
  };
}
function runStep(runner,request,name){
  const result=runner(request);
  if(result?.error) throw result.error;
  if(result?.status!==0){
    throw new Error(`${name}_FAILED:${String(result?.stderr??'').replace(/[\r\n]+/g,' ').slice(0,400)}`);
  }
  return parseJson(result.stdout,name);
}

export async function runResearchCanonicalChainV1({
  repoRoot,
  researchSha,
  inputRoot,
  bundleStateRoot,
  researchStateRoot,
  componentsPath,
  runner=defaultRunner,
}={}){
  const repo=absolute(repoRoot,'repoRoot');
  const sha=exactSha(researchSha);
  const input=absolute(inputRoot,'inputRoot');
  const bundleState=absolute(bundleStateRoot,'bundleStateRoot');
  const researchState=absolute(researchStateRoot,'researchStateRoot');
  const specPath=await safeExistingFileBelow(input,componentsPath,'componentsPath');
  const spec=parseJson(await readFile(specPath,'utf8'),'COMPONENT_SPEC');
  const dslPath=await safeExistingFileBelow(input,spec?.dsl,'dslPath');

  const assemble=runStep(runner,{
    cwd:repo,
    args:[
      'api-server/dist/tools/assemble-research-canonical-bundle.mjs',
      '--components',specPath,
    ],
    env:{
      RESEARCH_CODE_SHA:sha,
      RESEARCH_CANONICAL_BUNDLE_INPUT_ROOT:input,
    },
  },'ASSEMBLER');
  if(assemble?.status!=='assembled'&&assemble?.status!=='already_present') throw new Error('ASSEMBLER_STATUS_INVALID');
  if(assemble?.researchCodeSha!==sha) throw new Error('ASSEMBLER_SHA_MISMATCH');
  if(!HASH64.test(String(assemble?.dslDigest??''))||!HASH64.test(String(assemble?.bundleDigest??''))){
    throw new Error('ASSEMBLER_DIGEST_INVALID');
  }
  const bundlePath=below(input,assemble?.bundlePath,'bundlePath');

  const publish=runStep(runner,{
    cwd:repo,
    args:[
      'api-server/dist/tools/publish-research-canonical-bundle.mjs',
      '--dsl',dslPath,
      '--bundle',bundlePath,
    ],
    env:{
      RESEARCH_CODE_SHA:sha,
      RESEARCH_CANONICAL_BUNDLE_INPUT_ROOT:input,
      RESEARCH_BUNDLE_STATE_ROOT:bundleState,
    },
  },'PUBLISHER');
  if(!['published','verified_existing_catalog'].includes(publish?.status)) throw new Error('PUBLISHER_STATUS_INVALID');
  if(publish?.researchCodeSha!==sha) throw new Error('PUBLISHER_SHA_MISMATCH');
  if(publish?.publicationStatus!=='READBACK_VERIFIED'
    ||publish?.evidenceCredit!==0
    ||publish?.profitabilityProven!==false
    ||publish?.executionAuthority!=='NONE'){
    throw new Error('PUBLISHER_AUTHORITY_INVALID');
  }
  const receiptPath=below(bundleState,publish?.receiptPath,'receiptPath');

  const bindings=runStep(runner,{
    cwd:repo,
    args:[
      'research-production/bin/research-runtime-bindings-build.mjs',
      '--bundle-publication',receiptPath,
    ],
    env:{
      RESEARCH_CODE_SHA:sha,
      RESEARCH_STATE_ROOT:researchState,
    },
  },'RUNTIME_BINDINGS');
  if(bindings?.status!=='persisted'
    ||bindings?.allBindingsAvailable!==true
    ||!Array.isArray(bindings?.missingKeys)
    ||bindings.missingKeys.length!==0
    ||bindings?.executionAuthority!=='NONE'){
    throw new Error('RUNTIME_BINDINGS_NOT_COMPLETE');
  }

  return Object.freeze({
    schemaVersion:1,
    contract:RESEARCH_CANONICAL_CHAIN_CONTRACT_V1,
    status:'CANONICAL_CHAIN_READY_NON_ACTIVATING',
    researchSha:sha,
    dslDigest:assemble.dslDigest,
    bundleDigest:assemble.bundleDigest,
    publicationStatus:publish.publicationStatus,
    bindingsDigest:bindings.bindingsDigest,
    allBindingsAvailable:true,
    safety:Object.freeze({
      generatedEvidence:false,
      syntheticBundleAllowed:false,
      evidenceCredit:0,
      profitabilityProven:false,
      runtimeExecutionAttempted:false,
      runtimeActivationAllowed:false,
      scheduleMutationAllowed:false,
      deploymentAllowed:false,
      liveTrading:false,
      autoTrading:false,
      privateTradingApi:false,
      realOrder:false,
      executionAuthority:'NONE',
    }),
  });
}
