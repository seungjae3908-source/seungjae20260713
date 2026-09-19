import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ADAPTIVE_MULTI_MARKET_PROFILES_V1,
  ADAPTIVE_TOURNAMENT_STAGES_V1,
  buildAdaptiveMultiMarketTournamentPlanV1,
} from '../../market-prediction-lab/src/adaptive-multi-market-tournament-orchestrator-v1.js';
import {
  ADAPTIVE_TOURNAMENT_RUNTIME_BINDING_REQUIREMENTS_V1,
  buildAdaptiveTournamentRuntimeAdapterV1,
} from '../../market-prediction-lab/src/adaptive-multi-market-tournament-runtime-adapter-v1.js';
import { buildResearchFactoryControlPlaneV1 } from '../src/research-factory-controller.mjs';

const SHA='a'.repeat(40);
const AT='2026-09-19T10:00:00.000Z';

function policy(overrides={}){
  const caps=[16,16,12,10,6,4,3,2,2,1,1,1,1];
  const ratios=[1,1,0.75,0.625,0.375,0.25,0.1875,0.125,0.125,0.0625,0.0625,0.0625,0.0625];
  return {
    policyId:'human-approved-policy-v1',
    totalCandidateBudget:16,
    minimumCandidatesPerReadyProfile:16,
    maximumCandidatesPerReadyProfile:16,
    diagnosticWeights:{dataCompleteness:0.3,signalCoverage:0.2,costCoverage:0.2,familyDiversity:0.2,computeCapacity:0.1},
    stagePolicy:ADAPTIVE_TOURNAMENT_STAGES_V1.map((stage,index)=>({stage,retentionRatio:ratios[index],maximumPerProfile:caps[index]})),
    maximumParetoSurvivorsPerSpecialist:2,
    ...overrides,
  };
}

function evidenceCell(requirement){
  return {status:'PRESENT',evidenceId:`evidence:${requirement}`,observedAt:AT};
}

function readyProfileInput(profileId='CRYPTO_FUTURES:SWING'){
  const profile=ADAPTIVE_MULTI_MARKET_PROFILES_V1.find((row)=>row.profileId===profileId);
  const evidenceCatalog={
    [profileId]:Object.fromEntries(profile.requiredEvidence.map((requirement)=>[requirement,evidenceCell(requirement)])),
  };
  const developmentDiagnostics={
    [profileId]:{
      sourceRole:'DEVELOPMENT_ONLY',evidenceId:'development:1',
      dataCompleteness:0.9,signalCoverage:0.8,costCoverage:0.8,familyDiversity:0.7,computeCapacity:0.9,
    },
  };
  return {evidenceCatalog,developmentDiagnostics,policy:policy()};
}

function availableBindings(){
  return Object.fromEntries(Object.entries(ADAPTIVE_TOURNAMENT_RUNTIME_BINDING_REQUIREMENTS_V1).map(([key,requirement])=>[
    key,{
      status:'AVAILABLE',
      ownerRefs:[...requirement.ownerRefs],
      capability:requirement.capability,
      sourceSha:SHA,
      evidenceId:`binding:${key}`,
      properties:requirement.properties,
      reason:null,
    },
  ]));
}

test('control-plane does not duplicate the canonical tournament or stage sequence',()=>{
  const result=buildResearchFactoryControlPlaneV1({
    researchSha:SHA,observedAt:AT,evidenceByMarket:{},
    adaptive:{evidenceCatalog:{},developmentDiagnostics:{},policy:policy()},
  });
  assert.equal(result.status,'BLOCKED_NO_READY_PROFILES');
  assert.equal(result.nextAction.kind,'COLLECT_CANONICAL_PROFILE_EVIDENCE');
  assert.equal(result.safety.orchestrationDuplicated,false);
  assert.equal(result.safety.stageSequenceInvented,false);
  assert.equal(result.safety.candidateBudgetInvented,false);
  assert.equal(result.ownership.backtesterOwner,'#690');
  assert.equal(result.ownership.statisticalFirewallOwner,'#547');
  assert.equal(result.safety.executionAuthority,'NONE');
});

test('ready canonical profiles proceed to missing owner bindings while Data Factory gaps continue in parallel',()=>{
  const adaptive=readyProfileInput();
  const result=buildResearchFactoryControlPlaneV1({
    researchSha:SHA,observedAt:AT,evidenceByMarket:{},adaptive,
  });
  assert.equal(result.canonicalAdaptive.readyProfileCount,1);
  assert.equal(result.status,'BLOCKED_RUNTIME_BINDINGS');
  assert.equal(result.nextAction.kind,'BIND_EXISTING_CANONICAL_RUNTIME_OWNERS');
  assert.ok(result.nextAction.missingBindings.length>0);
  assert.equal(result.parallelDataWork.length,4);
  assert.equal(result.safety.runtimeExecutionAttempted,false);
});

test('fully bound canonical adapter is ready but still cannot activate or execute from the control-plane',()=>{
  const adaptiveInput=readyProfileInput();
  const plan=buildAdaptiveMultiMarketTournamentPlanV1({
    sourceSha:SHA,createdAt:AT,
    evidenceCatalog:adaptiveInput.evidenceCatalog,
    developmentDiagnostics:adaptiveInput.developmentDiagnostics,
    policy:adaptiveInput.policy,
  });
  const runtimeAdapter=buildAdaptiveTournamentRuntimeAdapterV1({
    plan,bindings:availableBindings(),createdAt:AT,
  });
  const result=buildResearchFactoryControlPlaneV1({
    researchSha:SHA,observedAt:AT,evidenceByMarket:{},
    adaptive:{plan,runtimeAdapter},
  });
  assert.equal(result.status,'READY_NON_ACTIVATING');
  assert.equal(result.nextAction.kind,'CANONICAL_RUNTIME_READY_FOR_SEPARATE_EXECUTION');
  assert.equal(result.canonicalAdaptive.runtimeStatus,'READY_NON_ACTIVATING');
  assert.equal(result.safety.runtimeActivationAllowed,false);
  assert.equal(result.safety.runtimeExecutionAttempted,false);
  assert.equal(result.safety.finalHoldoutAccessAllowed,false);
  assert.equal(result.safety.profitabilityClaim,false);
});

test('tampered canonical plan is rejected rather than normalized or reimplemented',()=>{
  const adaptiveInput=readyProfileInput();
  const plan=buildAdaptiveMultiMarketTournamentPlanV1({
    sourceSha:SHA,createdAt:AT,
    evidenceCatalog:adaptiveInput.evidenceCatalog,
    developmentDiagnostics:adaptiveInput.developmentDiagnostics,
    policy:adaptiveInput.policy,
  });
  const tampered=structuredClone(plan);
  tampered.allocation.initialCandidateFamilySize+=1;
  assert.throws(()=>buildResearchFactoryControlPlaneV1({
    researchSha:SHA,observedAt:AT,evidenceByMarket:{},
    adaptive:{plan:tampered},
  }),/CANONICAL_ADAPTIVE_PLAN_INVALID/);
});

test('source SHA mismatch fails closed across canonical artifacts',()=>{
  const adaptiveInput=readyProfileInput();
  const plan=buildAdaptiveMultiMarketTournamentPlanV1({
    sourceSha:SHA,createdAt:AT,
    evidenceCatalog:adaptiveInput.evidenceCatalog,
    developmentDiagnostics:adaptiveInput.developmentDiagnostics,
    policy:adaptiveInput.policy,
  });
  assert.throws(()=>buildResearchFactoryControlPlaneV1({
    researchSha:'b'.repeat(40),observedAt:AT,evidenceByMarket:{},
    adaptive:{plan},
  }),/SOURCE_SHA_MISMATCH/);
});
