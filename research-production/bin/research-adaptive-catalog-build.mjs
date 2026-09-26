#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  buildAndPersistAdaptiveEvidenceCatalogV1,
} from '../src/research-adaptive-evidence-catalog-store.mjs';

function arg(name){
  const index=process.argv.indexOf(name);
  if(index<0||!process.argv[index+1]) throw new Error(`missing required argument ${name}`);
  return String(process.argv[index+1]);
}

try{
  const stateRoot=process.env.RESEARCH_STATE_ROOT??'/var/lib/investment-research-production';
  const spec=JSON.parse(await readFile(resolve(arg('--input')),'utf8'));
  const result=await buildAndPersistAdaptiveEvidenceCatalogV1({
    stateRoot,
    manifestPathsByProfile:spec.manifestPathsByProfile??{},
    receiptPaths:spec.receiptPaths??[],
  });
  process.stdout.write(`${JSON.stringify({
    status:result.persisted.status,
    evidenceCatalogDigest:result.persisted.evidenceCatalogDigest,
    readyProfileCount:result.persisted.readyProfileCount,
    blockedProfileCount:result.persisted.blockedProfileCount,
    executionAuthority:'NONE',
  },null,2)}\n`);
}catch(error){
  process.stderr.write(`${JSON.stringify({
    schemaVersion:1,
    contract:'research-adaptive-evidence-catalog-store/v1',
    status:'failed_closed',
    error:String(error?.message??error).slice(0,400),
    executionAuthority:'NONE',
  })}\n`);
  process.exitCode=1;
}
