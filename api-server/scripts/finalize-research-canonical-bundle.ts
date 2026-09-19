#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  finalizeResearchCanonicalBundleFromRegistryV1,
} from '../src/services/research-canonical-bundle-finalizer.service.ts';

function requiredEnv(name:string){
  const value=String(process.env[name]??'').trim();
  if(!value) throw new Error(`${name}_REQUIRED`);
  return value;
}
function requiredArg(name:string){
  const index=process.argv.indexOf(name);
  if(index<0||!process.argv[index+1]) throw new Error(`${name}_REQUIRED`);
  return String(process.argv[index+1]);
}

try{
  const binding=JSON.parse(await readFile(resolve(requiredArg('--binding')),'utf8'));
  const result=await finalizeResearchCanonicalBundleFromRegistryV1({
    inputRoot:resolve(requiredEnv('RESEARCH_CANONICAL_BUNDLE_INPUT_ROOT')),
    stateRoot:resolve(requiredEnv('RESEARCH_BUNDLE_STATE_ROOT')),
    binding,
  });
  process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
  if(result.status==='BLOCKED_MISSING_COMPONENTS') process.exitCode=2;
}catch(error){
  process.stderr.write(`${JSON.stringify({
    schemaVersion:1,
    contract:'research-canonical-bundle-finalizer/v1',
    status:'failed_closed',
    error:String((error as Error)?.message??error).replace(/[\r\n]/g,'_').slice(0,500),
    evidenceCredit:0,
    profitabilityProven:false,
    executionAuthority:'NONE',
  })}\n`);
  process.exitCode=1;
}
