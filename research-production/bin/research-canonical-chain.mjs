#!/usr/bin/env node
import { resolve } from 'node:path';
import { runResearchCanonicalChainV1 } from '../src/research-canonical-chain.mjs';

function reqEnv(name){
  const value=String(process.env[name]??'').trim();
  if(!value) throw new Error(`${name}_REQUIRED`);
  return value;
}
function reqArg(name){
  const i=process.argv.indexOf(name);
  if(i<0||!process.argv[i+1]) throw new Error(`${name}_REQUIRED`);
  return String(process.argv[i+1]);
}
try{
  const result=await runResearchCanonicalChainV1({
    repoRoot:resolve(reqEnv('RESEARCH_REPO_ROOT')),
    researchSha:reqEnv('RESEARCH_CODE_SHA'),
    inputRoot:resolve(reqEnv('RESEARCH_CANONICAL_BUNDLE_INPUT_ROOT')),
    bundleStateRoot:resolve(reqEnv('RESEARCH_BUNDLE_STATE_ROOT')),
    researchStateRoot:resolve(reqEnv('RESEARCH_STATE_ROOT')),
    componentsPath:resolve(reqArg('--components')),
  });
  process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
}catch(error){
  process.stderr.write(`${JSON.stringify({
    schemaVersion:1,
    contract:'research-canonical-chain/v1',
    status:'FAILED_CLOSED',
    error:String(error?.message??error).replace(/[\r\n]+/g,'_').slice(0,500),
    runtimeActivationAllowed:false,
    liveTrading:false,
    executionAuthority:'NONE',
  })}\n`);
  process.exitCode=1;
}
