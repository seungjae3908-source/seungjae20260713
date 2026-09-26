#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  persistResearchDevelopmentDiagnosticsV1,
} from '../src/research-development-diagnostics.mjs';

function arg(name){
  const index=process.argv.indexOf(name);
  if(index<0||!process.argv[index+1]) throw new Error(`missing required argument ${name}`);
  return String(process.argv[index+1]);
}

try{
  const spec=JSON.parse(await readFile(resolve(arg('--input')),'utf8'));
  const result=await persistResearchDevelopmentDiagnosticsV1({
    stateRoot:process.env.RESEARCH_STATE_ROOT??'/var/lib/investment-research-production',
    profiles:spec.profiles??[],
  });
  process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
}catch(error){
  process.stderr.write(`${JSON.stringify({
    schemaVersion:1,
    contract:'research-development-diagnostics/v1',
    status:'failed_closed',
    error:String(error?.message??error).replace(/[\r\n]/g,'_').slice(0,500),
    executionAuthority:'NONE',
  })}\n`);
  process.exitCode=1;
}
