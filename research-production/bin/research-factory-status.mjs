#!/usr/bin/env node
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { buildResearchFactoryRuntimeStatusV1 } from '../src/research-factory-runtime-status.mjs';

function exactSha(value) {
  const sha=String(value??'').trim().toLowerCase();
  if(!/^[0-9a-f]{40}$/.test(sha)) throw new Error('RESEARCH_CODE_SHA must be exact SHA');
  return sha;
}

async function stateRoot(value) {
  const raw=String(value??'/var/lib/investment-research-production').trim();
  if(!raw||!isAbsolute(raw)) throw new Error('RESEARCH_STATE_ROOT must be absolute');
  const root=resolve(raw);
  for(const forbidden of ['/opt/stock-app-data','/srv/stock-app','/var/lib/stock-app']){
    if(root===forbidden||root.startsWith(`${forbidden}/`)) throw new Error('Factory state overlaps protected app storage');
  }
  let probe=root;
  while(true){
    try{
      const info=await lstat(probe);
      if(info.isSymbolicLink()) throw new Error('Factory state root must not contain symbolic links');
      if(resolve(await realpath(probe))!==probe) throw new Error('Factory state root must not contain symbolic links');
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

function optionalAbsolute(value,name) {
  const text=String(value??'').trim();
  if(!text) return null;
  if(!isAbsolute(text)||resolve(text)!==text||/[\0\r\n]/u.test(text)) throw new Error(`${name} must be a normalized absolute path`);
  return text;
}

async function readOptionalJson(path,{missingAsNull=false,name='Factory input'}={}) {
  if(!path) return null;
  try{
    const info=await lstat(path);
    if(!info.isFile()||info.isSymbolicLink()) throw new Error(`${name} must be a regular non-symlink file`);
    if(resolve(await realpath(path))!==path) throw new Error(`${name} must not traverse symbolic links`);
    return JSON.parse(await readFile(path,'utf8'));
  }catch(error){
    if(missingAsNull&&error?.code==='ENOENT') return null;
    throw error;
  }
}

async function ensureSafeDirectory(path,name,{recursive=false}={}) {
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

async function atomicJson(path,value) {
  const directory=dirname(path);
  const info=await lstat(directory);
  if(!info.isDirectory()||info.isSymbolicLink()||resolve(await realpath(directory))!==directory){
    throw new Error('Factory output directory unsafe');
  }
  const temp=`${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp,`${JSON.stringify(value,null,2)}\n`,{mode:0o600});
  await rename(temp,path);
}

let outputPath=null;
try{
  const researchSha=exactSha(process.env.RESEARCH_CODE_SHA);
  const root=await stateRoot(process.env.RESEARCH_STATE_ROOT);
  await ensureSafeDirectory(root,'Factory state root',{recursive:true});
  const latest=await ensureSafeDirectory(join(root,'latest'),'Factory latest');
  outputPath=join(latest,'research-factory.json');
  const policyPath=optionalAbsolute(process.env.RESEARCH_ADAPTIVE_POLICY_RECORD_PATH,'RESEARCH_ADAPTIVE_POLICY_RECORD_PATH');
  const dataEvidencePath=optionalAbsolute(process.env.RESEARCH_DATA_FACTORY_EVIDENCE_PATH,'RESEARCH_DATA_FACTORY_EVIDENCE_PATH');
  const adaptiveEvidencePath=optionalAbsolute(process.env.RESEARCH_ADAPTIVE_EVIDENCE_CATALOG_PATH,'RESEARCH_ADAPTIVE_EVIDENCE_CATALOG_PATH');
  const configuredDiagnosticsPath=optionalAbsolute(
    process.env.RESEARCH_ADAPTIVE_DEVELOPMENT_DIAGNOSTICS_PATH,
    'RESEARCH_ADAPTIVE_DEVELOPMENT_DIAGNOSTICS_PATH',
  );
  const configuredBindingsPath=optionalAbsolute(
    process.env.RESEARCH_ADAPTIVE_RUNTIME_BINDINGS_PATH,
    'RESEARCH_ADAPTIVE_RUNTIME_BINDINGS_PATH',
  );
  const diagnosticsPath=configuredDiagnosticsPath??join(latest,'adaptive-development-diagnostics.json');
  const bindingsPath=configuredBindingsPath??join(latest,'adaptive-runtime-bindings.json');

  const [policyRecord,dataEvidenceByMarket,adaptiveEvidenceCatalog,developmentDiagnostics,runtimeBindings]=await Promise.all([
    readOptionalJson(policyPath,{name:'adaptive policy record'}),
    readOptionalJson(dataEvidencePath,{name:'Data Factory evidence'}),
    readOptionalJson(adaptiveEvidencePath,{name:'adaptive evidence catalog'}),
    readOptionalJson(diagnosticsPath,{
      missingAsNull:configuredDiagnosticsPath==null,
      name:'adaptive development diagnostics',
    }),
    readOptionalJson(bindingsPath,{
      missingAsNull:configuredBindingsPath==null,
      name:'adaptive runtime bindings',
    }),
  ]);

  const status=buildResearchFactoryRuntimeStatusV1({
    researchSha,
    observedAt:new Date().toISOString(),
    policyRecord,
    dataEvidenceByMarket:dataEvidenceByMarket??{},
    adaptiveEvidenceCatalog:adaptiveEvidenceCatalog??{},
    developmentDiagnostics:developmentDiagnostics??{},
    runtimeBindings:runtimeBindings??{},
  });
  await atomicJson(outputPath,status);
  process.stdout.write(`${JSON.stringify({
    contract:status.contract,
    status:status.status,
    firstZero:status.firstZero,
    researchSha:status.researchSha,
    policyPresent:status.policy.present,
    policyValid:status.policy.valid,
    readyMarketCount:status.dataFactory.readyMarketCount,
    readyProfileCount:status.canonicalAdaptive.readyProfileCount,
    runtimeExecutionAttempted:false,
    executionAuthority:'NONE',
  },null,2)}\n`);
  if(status.status==='BLOCKED_POLICY_INVALID') process.exitCode=1;
}catch(error){
  const failure={
    schemaVersion:1,
    contract:'research-factory-runtime-status/v1',
    generatedAt:new Date().toISOString(),
    status:'FAILED_CLOSED',
    firstZero:'FACTORY_RUNTIME_STATUS_INPUT_INVALID',
    diagnostic:String(error?.message??error).replace(/[\r\n]/g,'_').slice(0,240),
    safety:{
      runtimeExecutionAttempted:false,
      runtimeActivationAllowed:false,
      liveTrading:false,
      autoTrading:false,
      privateTradingApi:false,
      realOrder:false,
      executionAuthority:'NONE',
    },
  };
  if(outputPath){
    try{await atomicJson(outputPath,failure);}catch{}
  }
  process.stderr.write(`${JSON.stringify(failure)}\n`);
  process.exitCode=1;
}
