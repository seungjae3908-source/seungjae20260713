#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  registerCanonicalBundleComponentV1,
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
  const inputRoot=requiredEnv('RESEARCH_CANONICAL_BUNDLE_INPUT_ROOT');
  const binding=JSON.parse(await readFile(resolve(requiredArg('--binding')),'utf8'));
  const result=await registerCanonicalBundleComponentV1({
    inputRoot,
    binding,
    key:requiredArg('--key'),
    ownerRef:requiredArg('--owner'),
    payloadPath:requiredArg('--payload'),
  });
  process.stdout.write(`${JSON.stringify({
    status:result.status,
    bindingDigest:result.bindingDigest,
    key:result.key,
    ownerRef:result.ownerRef,
    payloadDigest:result.payloadDigest,
    payloadPath:result.payloadPath,
    executionAuthority:'NONE',
  },null,2)}\n`);
}catch(error){
  process.stderr.write(`${JSON.stringify({
    schemaVersion:1,
    contract:'research-canonical-component-registration/v1',
    status:'failed_closed',
    error:String((error as Error)?.message??error).replace(/[\r\n]/g,'_').slice(0,500),
    executionAuthority:'NONE',
  })}\n`);
  process.exitCode=1;
}
