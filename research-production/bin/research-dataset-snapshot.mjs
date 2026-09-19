#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

import {
  buildResearchDatasetSnapshotManifestV1,
  persistResearchDatasetSnapshotManifestV1,
} from '../src/research-dataset-snapshot-store.mjs';

function arg(name){
  const index=process.argv.indexOf(name);
  if(index<0||!process.argv[index+1]) throw new Error(`missing required argument ${name}`);
  return String(process.argv[index+1]);
}

try{
  const input=JSON.parse(await readFile(arg('--input'),'utf8'));
  const manifest=buildResearchDatasetSnapshotManifestV1({
    researchSha:process.env.RESEARCH_CODE_SHA,
    createdAt:new Date().toISOString(),
    profileId:String(input.profileId??''),
    evidence:input.evidence??{},
    scope:input.scope??null,
  });
  const persisted=await persistResearchDatasetSnapshotManifestV1({
    stateRoot:process.env.RESEARCH_STATE_ROOT??'/var/lib/investment-research-production',
    manifest,
  });
  process.stdout.write(`${JSON.stringify({...persisted,manifest},null,2)}\n`);
}catch(error){
  process.stderr.write(`${JSON.stringify({
    schemaVersion:1,
    contract:'research-dataset-snapshot-manifest/v1',
    status:'failed_closed',
    code:String(error?.code??'DATASET_SNAPSHOT_FAILED'),
    error:String(error?.message??error).slice(0,400),
    executionAuthority:'NONE',
  })}\n`);
  process.exitCode=1;
}
