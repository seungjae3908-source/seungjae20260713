import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  appendResearchFailureObservationV1,
  assertResearchFailureMemoryV1,
  createResearchFailureMemoryV1,
  summarizeResearchFailureMemoryV1,
} from './research-failure-memory.mjs';

export const RESEARCH_FAILURE_MEMORY_STORE_CONTRACT_V1 = 'research-failure-memory-store/v1';

function absolutePath(value, name) {
  const path=resolve(String(value??''));
  if(!path.startsWith('/')) throw new TypeError(`${name} must resolve to an absolute path`);
  return path;
}

function exactResearchSha(value) {
  const sha=String(value??'').trim().toLowerCase();
  if(!/^[0-9a-f]{40}$/.test(sha)) throw new TypeError('researchSha must be exact SHA');
  return sha;
}

async function atomicJson(path,value) {
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  const temp=`${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp,`${JSON.stringify(value,null,2)}\n`,{mode:0o600});
  await rename(temp,path);
}

export async function loadResearchFailureMemoryV1({
  memoryPath,
  researchSha,
} = {}) {
  const path=absolutePath(memoryPath,'memoryPath');
  const expectedResearchSha=exactResearchSha(researchSha);
  try {
    const memory=JSON.parse(await readFile(path,'utf8'));
    assertResearchFailureMemoryV1(memory);
    if(memory.createdByResearchSha.toLowerCase()!==expectedResearchSha) {
      throw new Error('RESEARCH_FAILURE_MEMORY_RESEARCH_SHA_MISMATCH');
    }
    return memory;
  } catch(error) {
    if(error?.code==='ENOENT') return createResearchFailureMemoryV1({researchSha:expectedResearchSha});
    throw error;
  }
}

export async function persistResearchFailureMemoryV1({
  memoryPath,
  summaryPath,
  memory,
} = {}) {
  assertResearchFailureMemoryV1(memory);
  const target=absolutePath(memoryPath,'memoryPath');
  const summaryTarget=absolutePath(summaryPath,'summaryPath');
  const summary=summarizeResearchFailureMemoryV1(memory);
  await atomicJson(target,memory);
  await atomicJson(summaryTarget,summary);
  return Object.freeze({
    schemaVersion:1,
    contract:RESEARCH_FAILURE_MEMORY_STORE_CONTRACT_V1,
    status:'persisted',
    memoryDigest:memory.memoryDigest,
    observationCount:summary.observationCount,
    strategyIdentityCount:summary.strategyIdentityCount,
    executionAuthority:'NONE',
  });
}

export async function ingestResearchFailureObservationFileV1({
  memoryPath,
  summaryPath,
  researchSha,
  observationPath,
} = {}) {
  const input=absolutePath(observationPath,'observationPath');
  const observation=JSON.parse(await readFile(input,'utf8'));
  const current=await loadResearchFailureMemoryV1({memoryPath,researchSha});
  const next=appendResearchFailureObservationV1(current,observation);
  const persisted=await persistResearchFailureMemoryV1({memoryPath,summaryPath,memory:next});
  return Object.freeze({
    ...persisted,
    duplicate:next===current,
    sourceObservationDigest:observation.failureObservationDigest??null,
  });
}
