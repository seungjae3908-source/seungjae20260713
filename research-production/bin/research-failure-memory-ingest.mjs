#!/usr/bin/env node
import { join, resolve } from 'node:path';
import { ingestResearchFailureObservationFileV1 } from '../src/research-failure-memory-store.mjs';

function arg(name){
  const index=process.argv.indexOf(name);
  if(index<0||!process.argv[index+1]) throw new Error(`missing required argument ${name}`);
  return String(process.argv[index+1]);
}
function sha(value){
  const text=String(value??'').trim().toLowerCase();
  if(!/^[0-9a-f]{40}$/.test(text)) throw new Error('research SHA must be exact');
  return text;
}
try{
  const root=resolve(process.env.RESEARCH_STATE_ROOT??'/var/lib/investment-research-production');
  const researchSha=sha(process.env.RESEARCH_CODE_SHA);
  const result=await ingestResearchFailureObservationFileV1({
    memoryPath:join(root,'failure-memory','research-failure-memory.json'),
    summaryPath:join(root,'latest','research-failure-memory.json'),
    researchSha,
    observationPath:resolve(arg('--input')),
  });
  process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
}catch(error){
  process.stderr.write(`${JSON.stringify({
    schemaVersion:1,
    contract:'research-failure-memory-store/v1',
    status:'failed_closed',
    error:String(error?.message??error).slice(0,400),
    executionAuthority:'NONE',
  })}\n`);
  process.exitCode=1;
}
