#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { buildResearchFactoryRuntimeStatusV1 } from '../src/research-factory-runtime-status.mjs';

function exactSha(value) {
  const sha=String(value??'').trim().toLowerCase();
  if(!/^[0-9a-f]{40}$/.test(sha)) throw new Error('RESEARCH_CODE_SHA must be exact SHA');
  return sha;
}

function stateRoot(value) {
  const root=resolve(String(value??'/var/lib/investment-research-production'));
  if(!isAbsolute(root)) throw new Error('RESEARCH_STATE_ROOT must be absolute');
  for(const forbidden of ['/opt/stock-app-data','/srv/stock-app','/var/lib/stock-app']){
    if(root===forbidden||root.startsWith(`${forbidden}/`)) throw new Error('Factory state overlaps protected app storage');
  }
  return root;
}

function optionalAbsolute(value,name) {
  const text=String(value??'').trim();
  if(!text) return null;
  if(!isAbsolute(text)||resolve(text)!==text||/[\0\r\n]/u.test(text)) throw new Error(`${name} must be a normalized absolute path`);
  return text;
}

async function readOptionalJson(path) {
  if(!path) return null;
  return JSON.parse(await readFile(path,'utf8'));
}

async function atomicJson(path,value) {
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  const temp=`${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp,`${JSON.stringify(value,null,2)}\n`,{mode:0o600});
  await rename(temp,path);
}

let outputPath=null;
try{
  const researchSha=exactSha(process.env.RESEARCH_CODE_SHA);
  const root=stateRoot(process.env.RESEARCH_STATE_ROOT);
  outputPath=join(root,'latest','research-factory.json');
  const policyPath=optionalAbsolute(process.env.RESEARCH_ADAPTIVE_POLICY_RECORD_PATH,'RESEARCH_ADAPTIVE_POLICY_RECORD_PATH');
  const dataEvidencePath=optionalAbsolute(process.env.RESEARCH_DATA_FACTORY_EVIDENCE_PATH,'RESEARCH_DATA_FACTORY_EVIDENCE_PATH');
  const adaptiveEvidencePath=optionalAbsolute(process.env.RESEARCH_ADAPTIVE_EVIDENCE_CATALOG_PATH,'RESEARCH_ADAPTIVE_EVIDENCE_CATALOG_PATH');
  const diagnosticsPath=optionalAbsolute(process.env.RESEARCH_ADAPTIVE_DEVELOPMENT_DIAGNOSTICS_PATH,'RESEARCH_ADAPTIVE_DEVELOPMENT_DIAGNOSTICS_PATH');
  const bindingsPath=optionalAbsolute(process.env.RESEARCH_ADAPTIVE_RUNTIME_BINDINGS_PATH,'RESEARCH_ADAPTIVE_RUNTIME_BINDINGS_PATH');

  const [policyRecord,dataEvidenceByMarket,adaptiveEvidenceCatalog,developmentDiagnostics,runtimeBindings]=await Promise.all([
    readOptionalJson(policyPath),
    readOptionalJson(dataEvidencePath),
    readOptionalJson(adaptiveEvidencePath),
    readOptionalJson(diagnosticsPath),
    readOptionalJson(bindingsPath),
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
