import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createResearchFailureObservationV1 } from '../../market-prediction-lab/src/autonomous-alpha-factory-phase3-v1.js';
import {
  ingestResearchFailureObservationFileV1,
  loadResearchFailureMemoryV1,
} from '../src/research-failure-memory-store.mjs';

const SHA='a'.repeat(40);
const ID='1'.repeat(64);

async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'research-failure-memory-'));
  const observation=createResearchFailureObservationV1({
    strategyIdentityDigest:ID,
    stage:'SHADOW',
    status:'FAIL',
    failureCodes:['SHADOW_DATA_FRESHNESS_FAILURE'],
    observedAt:'2026-09-20T00:00:00.000Z',
    evidence:{source:'canonical-shadow'},
  });
  const input=join(root,'observation.json');
  await writeFile(input,JSON.stringify(observation));
  return {
    root,input,observation,
    memoryPath:join(root,'failure-memory','memory.json'),
    summaryPath:join(root,'latest','failure-memory.json'),
  };
}

test('ingest atomically persists verified canonical failure and safe summary',async()=>{
  const f=await fixture();
  const result=await ingestResearchFailureObservationFileV1({
    memoryPath:f.memoryPath,summaryPath:f.summaryPath,researchSha:SHA,observationPath:f.input,
  });
  assert.equal(result.status,'persisted');
  assert.equal(result.observationCount,1);
  assert.equal(result.strategyIdentityCount,1);
  assert.equal(result.duplicate,false);
  assert.equal(result.executionAuthority,'NONE');

  const memory=JSON.parse(await readFile(f.memoryPath,'utf8'));
  const summary=JSON.parse(await readFile(f.summaryPath,'utf8'));
  assert.equal(memory.observations.length,1);
  assert.equal(summary.observationCount,1);
  assert.equal(summary.economicMetricsIncluded,false);
  assert.equal(summary.executionAuthority,'NONE');
});

test('same canonical failure is idempotent across repeated ingestion',async()=>{
  const f=await fixture();
  await ingestResearchFailureObservationFileV1({
    memoryPath:f.memoryPath,summaryPath:f.summaryPath,researchSha:SHA,observationPath:f.input,
  });
  const second=await ingestResearchFailureObservationFileV1({
    memoryPath:f.memoryPath,summaryPath:f.summaryPath,researchSha:SHA,observationPath:f.input,
  });
  assert.equal(second.duplicate,true);
  assert.equal(second.observationCount,1);
});

test('tampered failure file is rejected and existing memory remains unchanged',async()=>{
  const f=await fixture();
  await ingestResearchFailureObservationFileV1({
    memoryPath:f.memoryPath,summaryPath:f.summaryPath,researchSha:SHA,observationPath:f.input,
  });
  const before=await readFile(f.memoryPath,'utf8');
  await writeFile(f.input,JSON.stringify({...f.observation,stage:'PAPER'}));
  await assert.rejects(
    ingestResearchFailureObservationFileV1({
      memoryPath:f.memoryPath,summaryPath:f.summaryPath,researchSha:SHA,observationPath:f.input,
    }),
    /RESEARCH_FAILURE_OBSERVATION_INVALID/,
  );
  assert.equal(await readFile(f.memoryPath,'utf8'),before);
});

test('persisted memory tamper is detected before append',async()=>{
  const f=await fixture();
  await ingestResearchFailureObservationFileV1({
    memoryPath:f.memoryPath,summaryPath:f.summaryPath,researchSha:SHA,observationPath:f.input,
  });
  const memory=JSON.parse(await readFile(f.memoryPath,'utf8'));
  memory.observations[0].failureObservation.stage='PAPER';
  await writeFile(f.memoryPath,JSON.stringify(memory));
  await assert.rejects(
    loadResearchFailureMemoryV1({memoryPath:f.memoryPath,researchSha:SHA}),
    /RESEARCH_FAILURE_OBSERVATION_INVALID|DIGEST|MISMATCH/,
  );
});

test('persisted memory from a different research SHA is rejected fail-closed',async()=>{
  const f=await fixture();
  await ingestResearchFailureObservationFileV1({
    memoryPath:f.memoryPath,summaryPath:f.summaryPath,researchSha:SHA,observationPath:f.input,
  });
  await assert.rejects(
    loadResearchFailureMemoryV1({memoryPath:f.memoryPath,researchSha:'b'.repeat(40)}),
    /RESEARCH_FAILURE_MEMORY_RESEARCH_SHA_MISMATCH/,
  );
});
