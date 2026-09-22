import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { persistFrozenResearchEvaluationPoliciesV1 } from '../src/research-frozen-evaluation-policy-store.mjs';

const SHA='a'.repeat(40);
const D='b'.repeat(64);
const START=Date.UTC(2025,0,1);
const STEP=15*60*1000;
const all=Array.from({length:12},(_,i)=>START+i*STEP);
const holdout=Array.from({length:3},(_,i)=>START+(20+i)*STEP);

function input(){
  return {
    scope:{datasetId:'dataset:research:v1',datasetDigest:D,market:'US_STOCK',symbol:'AAPL',timeframe:'15m',researchCodeSha:SHA},
    datasetTimestamps:all,
    trainAssignments:all.slice(0,6),
    validationAssignments:all.slice(6,9),
    oosAssignments:all.slice(9),
    splitPolicyId:'split-policy:v1',
    splitReceiptId:'split-receipt:v1',
    splitFrozenAtMs:START-2*STEP,
    firstOutcomeObservedAtMs:START-STEP,
    splitObservedAtMs:START-STEP,
    oosPolicyId:'oos-policy:v1',
    oosFrozenAtMs:START-2*STEP,
    oosStartTime:all[9],
    oosEndTime:all[11],
    wfPolicyId:'wf-policy:v1',
    wfFrozenAtMs:START-2*STEP,
    wfWindows:[{train:all.slice(0,3),validation:all.slice(6,7)}],
    holdoutPolicyId:'holdout-policy:v1',
    holdoutFrozenAtMs:START-2*STEP,
    holdoutDatasetId:'dataset:holdout:v1',
    holdoutFirewallIdentity:'statistical-firewall:#547',
    holdoutAssignments:holdout,
    holdoutStartTime:holdout[0],
    holdoutEndTime:holdout.at(-1),
  };
}

test('persists all five sealed evaluation policy components and digest record write-once',async()=>{
  const root=await mkdtemp(join(tmpdir(),'evaluation-policy-store-'));
  const first=await persistFrozenResearchEvaluationPoliciesV1({componentRoot:root,input:input()});
  assert.equal(first.status,'persisted');
  for(const key of ['splitPolicy','splitReceipt','oosPolicy','wfPolicy','holdoutPolicy']){
    const value=JSON.parse(await readFile(first.paths[key],'utf8'));
    assert.match(value.digest,/^[0-9a-f]{64}$/);
    assert.ok(value.payload);
  }
  const record=JSON.parse(await readFile(first.paths.record,'utf8'));
  assert.equal(record.policySetDigest,first.policySetDigest);
  assert.equal(Object.keys(record.componentDigests).length,5);
  assert.equal(record.safety.executionAuthority,'NONE');

  const repeated=await persistFrozenResearchEvaluationPoliciesV1({componentRoot:root,input:input()});
  assert.equal(repeated.status,'already_present');
  assert.equal(repeated.policySetDigest,first.policySetDigest);
});

test('tampered existing component conflicts instead of overwrite',async()=>{
  const root=await mkdtemp(join(tmpdir(),'evaluation-policy-store-'));
  const first=await persistFrozenResearchEvaluationPoliciesV1({componentRoot:root,input:input()});
  const split=JSON.parse(await readFile(first.paths.splitPolicy,'utf8'));
  split.payload.assignments.TRAIN=[split.payload.assignments.TRAIN[0]];
  await writeFile(first.paths.splitPolicy,JSON.stringify(split));
  await assert.rejects(
    persistFrozenResearchEvaluationPoliciesV1({componentRoot:root,input:input()}),
    /CONTENT_CONFLICT/,
  );
});
