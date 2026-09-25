#!/usr/bin/env node
import { resolve } from 'node:path';

import {
  buildAndPersistAutonomousAlphaRuntimeHandoffV1,
} from '../src/autonomous-alpha-runtime-handoff-store.mjs';

function env(name){
  const value=String(process.env[name]??'').trim();
  if(!value) throw new Error(`${name}_REQUIRED`);
  return value;
}
function option(name){
  const index=process.argv.indexOf(name);
  if(index<0||!process.argv[index+1]) throw new Error(`${name}_REQUIRED`);
  return resolve(String(process.argv[index+1]));
}

try{
  const result=await buildAndPersistAutonomousAlphaRuntimeHandoffV1({
    sourceSha:env('RESEARCH_CODE_SHA'),
    artifactRoot:resolve(env('AUTONOMOUS_ALPHA_ARTIFACT_ROOT')),
    paperForwardRoot:resolve(env('PAPER_FORWARD_ROOT')),
    canonicalChainPath:option('--canonical-chain'),
    runtimeBindingsPath:option('--runtime-bindings'),
    runtimeBindingsRecordPath:option('--runtime-bindings-record'),
    stagePaths:{
      worldKnowledge:option('--world-knowledge'),
      alphaGenome:option('--alpha-genome'),
      redTeam:option('--red-team'),
      forecast:option('--forecast'),
      counterfactual:option('--counterfactual'),
      digitalTwin:option('--digital-twin'),
      championChallenger:option('--champion-challenger'),
      certification:option('--certification'),
    },
  });
  process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
  if(result.status==='WAITING_FOR_CANONICAL_ALPHA_ARTIFACTS') process.exitCode=2;
  else if(result.status!=='PUBLISHED_ALPHA_RUNTIME_HANDOFF') process.exitCode=1;
}catch(error){
  process.stderr.write(`${JSON.stringify({
    schemaVersion:1,
    contract:'autonomous-alpha-runtime-handoff-store/v1',
    status:'FAILED_CLOSED',
    error:String(error?.message??error).replace(/[\r\n]+/g,'_').slice(0,500),
    handoffWritten:false,
    profitabilityProven:false,
    liveTrading:false,
    autoTrading:false,
    realOrderEnabled:false,
    privateTradingApiAllowed:false,
    executionAuthority:'NONE',
  })}\n`);
  process.exitCode=1;
}
