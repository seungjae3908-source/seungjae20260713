#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  buildCanonicalBundleComponentReadinessV1,
} from '../src/services/research-canonical-component-registry.service.ts';

function requiredEnv(name: string): string {
  const value=String(process.env[name]??'').trim();
  if(!value) throw new Error(`${name}_REQUIRED`);
  return value;
}
function requiredArg(name: string): string {
  const index=process.argv.indexOf(name);
  if(index<0||!process.argv[index+1]) throw new Error(`${name}_REQUIRED`);
  return String(process.argv[index+1]);
}

try{
  const inputRoot=resolve(requiredEnv('RESEARCH_CANONICAL_BUNDLE_INPUT_ROOT'));
  const binding=JSON.parse(await readFile(resolve(requiredArg('--binding')),'utf8'));
  const result=await buildCanonicalBundleComponentReadinessV1({inputRoot,binding});
  const outputIndex=process.argv.indexOf('--output');
  if(outputIndex>=0&&process.argv[outputIndex+1]){
    const output=resolve(String(process.argv[outputIndex+1]));
    if(!output.startsWith(inputRoot+'/')) throw new Error('READINESS_OUTPUT_OUTSIDE_INPUT_ROOT');
    await import('node:fs/promises').then(({mkdir})=>mkdir(dirname(output),{recursive:true,mode:0o700}));
    await writeFile(output,`${JSON.stringify(result.componentPaths,null,2)}\n`,{mode:0o600});
  }
  process.stdout.write(`${JSON.stringify({
    status:result.status,
    bindingDigest:result.bindingDigest,
    presentKeys:result.presentKeys,
    missingKeys:result.missingKeys,
    readinessDigest:result.readinessDigest,
    assemblerSpecReady:result.status==='COMPLETE',
    executionAuthority:'NONE',
  },null,2)}\n`);
  if(result.status!=='COMPLETE') process.exitCode=2;
}catch(error){
  process.stderr.write(`${JSON.stringify({
    schemaVersion:1,
    contract:'research-canonical-component-readiness/v1',
    status:'failed_closed',
    error:String((error as Error)?.message??error).replace(/[\r\n]/g,'_').slice(0,500),
    executionAuthority:'NONE',
  })}\n`);
  process.exitCode=1;
}
