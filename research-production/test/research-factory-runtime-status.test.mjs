import test from 'node:test';
import assert from 'node:assert/strict';

import { ADAPTIVE_TOURNAMENT_STAGES_V1 } from '../../market-prediction-lab/src/adaptive-multi-market-tournament-orchestrator-v1.js';
import { createAdaptivePolicyRecordV1 } from '../src/adaptive-policy-record.mjs';
import { buildResearchFactoryRuntimeStatusV1 } from '../src/research-factory-runtime-status.mjs';

const SHA='a'.repeat(40);
const AT='2026-09-19T11:10:00.000Z';

function policy(){
  const caps=[16,16,12,10,6,4,3,2,2,1,1,1,1];
  const ratios=[1,1,0.75,0.625,0.375,0.25,0.1875,0.125,0.125,0.0625,0.0625,0.0625,0.0625];
  return {
    policyId:'fixture-policy-v1',
    totalCandidateBudget:16,
    minimumCandidatesPerReadyProfile:16,
    maximumCandidatesPerReadyProfile:16,
    diagnosticWeights:{dataCompleteness:0.3,signalCoverage:0.2,costCoverage:0.2,familyDiversity:0.2,computeCapacity:0.1},
    stagePolicy:ADAPTIVE_TOURNAMENT_STAGES_V1.map((stage,index)=>({stage,retentionRatio:ratios[index],maximumPerProfile:caps[index]})),
    maximumParetoSurvivorsPerSpecialist:2,
  };
}

test('missing policy is a stable blocker, not a runtime failure or invented budget',()=>{
  const result=buildResearchFactoryRuntimeStatusV1({researchSha:SHA,observedAt:AT});
  assert.equal(result.status,'BLOCKED_POLICY_MISSING');
  assert.equal(result.firstZero,'HUMAN_APPROVED_ADAPTIVE_POLICY_MISSING');
  assert.equal(result.policy.present,false);
  assert.equal(result.policy.policyDigest,null);
  assert.equal(result.canonicalAdaptive.readyProfileCount,null);
  assert.equal(result.safety.runtimeExecutionAttempted,false);
  assert.equal(result.safety.executionAuthority,'NONE');
});

test('tampered configured policy fails closed and exposes no policy values',()=>{
  const record=createAdaptivePolicyRecordV1({
    policy:policy(),
    approvedAt:'2026-09-19T11:00:00.000Z',
    approvalEvidenceId:'github-comment:123456',
  });
  const tampered={...record,policy:{...record.policy,totalCandidateBudget:999}};
  const result=buildResearchFactoryRuntimeStatusV1({
    researchSha:SHA,observedAt:AT,policyRecord:tampered,
  });
  assert.equal(result.status,'BLOCKED_POLICY_INVALID');
  assert.equal(result.policy.present,true);
  assert.equal(result.policy.valid,false);
  assert.equal(result.policy.policyDigest,null);
  assert.equal(JSON.stringify(result).includes('999'),false);
  assert.equal(result.safety.runtimeExecutionAttempted,false);
});

test('valid approved policy with no profile evidence stays blocked on canonical data readiness',()=>{
  const record=createAdaptivePolicyRecordV1({
    policy:policy(),
    approvedAt:'2026-09-19T11:00:00.000Z',
    approvalEvidenceId:'github-comment:123456',
  });
  const result=buildResearchFactoryRuntimeStatusV1({
    researchSha:SHA,observedAt:AT,policyRecord:record,
  });
  assert.equal(result.policy.valid,true);
  assert.equal(result.status,'BLOCKED_NO_READY_PROFILES');
  assert.equal(result.canonicalAdaptive.readyProfileCount,0);
  assert.equal(result.canonicalAdaptive.runtimeStatus,'BLOCKED_NO_READY_PROFILES');
  assert.equal(result.safety.executionAuthority,'NONE');
});
