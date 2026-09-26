#!/usr/bin/env node
import { resolve } from 'node:path';

import {
  buildAndPersistResearchRuntimeBindingsV1,
} from '../src/research-runtime-bindings-store.mjs';

function option(name){
  const index=process.argv.indexOf(name);
  return index>=0&&process.argv[index+1]?String(process.argv[index+1]):null;
}
function sha(value){
  const text=String(value??'').trim().toLowerCase();
  if(!/^[0-9a-f]{40}$/.test(text)) throw new Error('RESEARCH_CODE_SHA must be exact');
  return text;
}

try{
  const stateRoot=resolve(process.env.RESEARCH_STATE_ROOT??'/var/lib/investment-research-production');
  const sourceSha=sha(process.env.RESEARCH_CODE_SHA);
  const result=await buildAndPersistResearchRuntimeBindingsV1({
    stateRoot,
    sourceSha,
    bundlePublicationPath:option('--bundle-publication'),
  });
  process.stdout.write(`${JSON.stringify({
    status:result.status,
    bindingsDigest:result.bindingsDigest,
    availableKeys:result.availableKeys,
    missingKeys:result.missingKeys,
    allBindingsAvailable:result.allBindingsAvailable,
    executionAuthority:'NONE',
  },null,2)}\n`);
}catch(error){
  process.stderr.write(`${JSON.stringify({
    schemaVersion:1,
    contract:'research-runtime-bindings-store/v1',
    status:'failed_closed',
    error:String(error?.message??error).slice(0,400),
    executionAuthority:'NONE',
  })}\n`);
  process.exitCode=1;
}
