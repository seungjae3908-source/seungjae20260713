import test from 'node:test';
import assert from 'node:assert/strict';

import { buildFrozenResearchEvaluationPoliciesV1 } from '../src/research-frozen-evaluation-policy.mjs';

const SHA='a'.repeat(40);
const D='b'.repeat(64);
const START=Date.UTC(2025,0,1);
const STEP=15*60*1000;
const all=Array.from({length:12},(_,i)=>START+i*STEP);
const holdout=Array.from({length:3},(_,i)=>START+(20+i)*STEP);

function input(overrides={}){
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
    wfWindows:[
      {train:all.slice(0,3),validation:all.slice(6,7)},
      {train:all.slice(0,5),validation:all.slice(7,9)},
    ],
    holdoutPolicyId:'holdout-policy:v1',
    holdoutFrozenAtMs:START-2*STEP,
    holdoutDatasetId:'dataset:holdout:v1',
    holdoutFirewallIdentity:'statistical-firewall:#547',
    holdoutAssignments:holdout,
    holdoutStartTime:holdout[0],
    holdoutEndTime:holdout.at(-1),
    ...overrides,
  };
}

test('explicit frozen inputs produce sealed split OOS WF and holdout policies without inferred ratios',()=>{
  const result=buildFrozenResearchEvaluationPoliciesV1(input());
  assert.equal(result.splitPolicy.payload.assignments.TRAIN.length,6);
  assert.equal(result.splitPolicy.payload.assignments.VALIDATION.length,3);
  assert.equal(result.splitPolicy.payload.assignments.OOS.length,3);
  assert.equal(result.splitReceipt.payload.untouchedOos,true);
  assert.equal(result.oosPolicy.payload.untouched,true);
  assert.equal(result.oosPolicy.payload.startTime,all[9]);
  assert.equal(result.wfPolicy.payload.windows.length,2);
  assert.equal(result.holdoutPolicy.payload.locked,true);
  assert.equal(result.holdoutPolicy.payload.datasetId,'dataset:holdout:v1');
  assert.match(result.splitPolicy.digest,/^[0-9a-f]{64}$/);
  assert.match(result.policySetDigest,/^[0-9a-f]{64}$/);
  assert.equal(result.safety.automaticSplitRatioAllowed,false);
  assert.equal(result.safety.timingInferenceAllowed,false);
  assert.equal(result.safety.executionAuthority,'NONE');
});

test('dataset split must be an exact non-overlapping partition in temporal order',()=>{
  assert.throws(()=>buildFrozenResearchEvaluationPoliciesV1(input({
    oosAssignments:[...all.slice(9),all[0]],
  })),/strictly increasing|NOT_EXACT|OVERLAP/);
  assert.throws(()=>buildFrozenResearchEvaluationPoliciesV1(input({
    trainAssignments:all.slice(0,5),
  })),/NOT_EXACT_DATASET_PARTITION/);
  assert.throws(()=>buildFrozenResearchEvaluationPoliciesV1(input({
    validationAssignments:[all[5],all[6],all[7],all[8]],
    trainAssignments:all.slice(0,6),
  })),/NOT_EXACT_DATASET_PARTITION|OVERLAP/);
});

test('all policies must be frozen before first observed outcome and receipts cannot predate their freeze',()=>{
  assert.throws(()=>buildFrozenResearchEvaluationPoliciesV1(input({
    splitFrozenAtMs:START,
  })),/SPLIT_NOT_FROZEN_BEFORE_OUTCOME/);
  assert.throws(()=>buildFrozenResearchEvaluationPoliciesV1(input({
    splitObservedAtMs:START-3*STEP,
  })),/SPLIT_RECEIPT_OBSERVED_BEFORE_SPLIT_FREEZE/);
  assert.throws(()=>buildFrozenResearchEvaluationPoliciesV1(input({
    oosFrozenAtMs:START-STEP,
  })),/OOS_POLICY_FROZEN_AFTER_SPLIT_FREEZE/);
  assert.throws(()=>buildFrozenResearchEvaluationPoliciesV1(input({
    wfFrozenAtMs:START-STEP,
  })),/WF_POLICY_FROZEN_AFTER_SPLIT_FREEZE/);
  assert.throws(()=>buildFrozenResearchEvaluationPoliciesV1(input({
    holdoutFrozenAtMs:START-STEP,
  })),/HOLDOUT_POLICY_FROZEN_AFTER_SPLIT_FREEZE/);
});

test('OOS range and WF windows must exactly respect the explicit frozen split',()=>{
  assert.throws(()=>buildFrozenResearchEvaluationPoliciesV1(input({oosStartTime:all[8]})),/OOS_POLICY_RANGE_MISMATCH/);
  assert.throws(()=>buildFrozenResearchEvaluationPoliciesV1(input({
    wfWindows:[{train:[all[0],all[1]],validation:[all[9]]}],
  })),/WF_WINDOW_OUTSIDE_FROZEN_SPLIT/);
});

test('holdout must be a distinct locked dataset strictly after and disjoint from research data',()=>{
  assert.throws(()=>buildFrozenResearchEvaluationPoliciesV1(input({
    holdoutDatasetId:'dataset:research:v1',
  })),/HOLDOUT_DATASET_MUST_BE_DISTINCT/);
  assert.throws(()=>buildFrozenResearchEvaluationPoliciesV1(input({
    holdoutAssignments:[all[11],holdout[1],holdout[2]],
    holdoutStartTime:all[11],
  })),/HOLDOUT_OVERLAPS_RESEARCH_DATASET/);
  assert.throws(()=>buildFrozenResearchEvaluationPoliciesV1(input({
    holdoutStartTime:holdout[1],
  })),/HOLDOUT_POLICY_RANGE_MISMATCH/);
});

test('unknown or missing inputs are rejected instead of defaulting policy values',()=>{
  const missing=input();
  delete missing.splitObservedAtMs;
  assert.throws(()=>buildFrozenResearchEvaluationPoliciesV1(missing),/INPUT_SHAPE_INVALID/);
  assert.throws(()=>buildFrozenResearchEvaluationPoliciesV1({...input(),unexpected:true}),/INPUT_SHAPE_INVALID/);
});
