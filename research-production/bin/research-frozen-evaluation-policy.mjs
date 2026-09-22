#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { persistFrozenResearchEvaluationPoliciesV1 } from '../src/research-frozen-evaluation-policy-store.mjs';

function reqArg(name){
  const index=process.argv.indexOf(name);
  if(index<0||!process.argv[index+1]) throw new Error(`${name}_REQUIRED`);
  return String(process.argv[index+1]);
}
try{
  const input=JSON.parse(await readFile(resolve(reqArg('--input')),'utf8'));
  const result=await persistFrozenResearchEvaluationPoliciesV1({
    componentRoot:resolve(process.env.RESEARCH_CANONICAL_BUNDLE_INPUT_ROOT??''),
    input,
  });
  process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
}catch(error){
  process.stderr.write(`${JSON.stringify({
    schemaVersion:1,
    contract:'research-frozen-evaluation-policy-store/v1',
    status:'failed_closed',
    error:String(error?.message??error).slice(0,400),
    executionAuthority:'NONE',
  })}\n`);
  process.exitCode=1;
}
