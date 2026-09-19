import test from "node:test";
import assert from "node:assert/strict";

import {
  ADAPTIVE_MULTI_MARKET_PROFILES_V1,
  ADAPTIVE_TOURNAMENT_STAGES_V1,
  buildAdaptiveMultiMarketTournamentPlanV1,
} from "../src/adaptive-multi-market-tournament-orchestrator-v1.js";
import {
  ADAPTIVE_TOURNAMENT_RUNTIME_BINDING_REQUIREMENTS_V1,
  assessAdaptiveTournamentRuntimeBindingsV1,
} from "../src/adaptive-multi-market-tournament-runtime-adapter-v1.js";
import {
  buildAdaptiveRuntimeOwnerBindingsV1,
  createCanonicalBundleOfflinePublicationReceiptV1,
  validateCanonicalBundlePublicationV1,
} from "../src/adaptive-runtime-owner-capabilities-v1.js";

const SHA="a".repeat(40);
const HASH="b".repeat(64);
const AT="2026-09-20T00:00:00.000Z";

function policy(){
  const stageMaximums=[32,32,24,20,12,8,6,4,3,2,2,1,1];
  const stageRatios=[1,1,0.75,0.625,0.375,0.25,0.1875,0.125,0.09375,0.0625,0.0625,0.03125,0.03125];
  return {
    policyId:"human-approved-policy-v1",
    totalCandidateBudget:32,
    minimumCandidatesPerReadyProfile:16,
    maximumCandidatesPerReadyProfile:32,
    diagnosticWeights:{
      dataCompleteness:0.3,
      signalCoverage:0.2,
      costCoverage:0.2,
      familyDiversity:0.2,
      computeCapacity:0.1,
    },
    stagePolicy:ADAPTIVE_TOURNAMENT_STAGES_V1.map((stage,index)=>({
      stage,
      retentionRatio:stageRatios[index],
      maximumPerProfile:stageMaximums[index],
    })),
    maximumParetoSurvivorsPerSpecialist:2,
  };
}

function present(requirement){
  return {
    status:"PRESENT",
    evidenceId:`capability-test:${requirement}`,
    observedAt:AT,
  };
}

function readyPlan(){
  const profile=ADAPTIVE_MULTI_MARKET_PROFILES_V1
    .find(row=>row.profileId==="CRYPTO_FUTURES:SHORT");
  const evidenceCatalog={
    [profile.profileId]:Object.fromEntries(
      profile.requiredEvidence.map(req=>[req,present(req)]),
    ),
  };
  const developmentDiagnostics={
    [profile.profileId]:{
      sourceRole:"DEVELOPMENT_ONLY",
      evidenceId:"development-diagnostic:1",
      dataCompleteness:0.9,
      signalCoverage:0.9,
      costCoverage:0.9,
      familyDiversity:0.8,
      computeCapacity:0.9,
    },
  };
  return buildAdaptiveMultiMarketTournamentPlanV1({
    sourceSha:SHA,
    createdAt:AT,
    evidenceCatalog,
    developmentDiagnostics,
    policy:policy(),
  });
}

function rawPublication(overrides={}){
  return {
    schemaVersion:"research-canonical-bundle-publication-v1",
    dslDigest:HASH,
    bundleDigest:"c".repeat(64),
    publicationStatus:"READBACK_VERIFIED",
    evidenceCredit:0,
    profitabilityProven:false,
    executionAuthority:"NONE",
    ...overrides,
  };
}

function publication(overrides={}){
  const researchCodeSha=overrides.researchCodeSha??SHA;
  const publishedAt=overrides.publishedAt??AT;
  const rawOverrides={...overrides};
  delete rawOverrides.researchCodeSha;
  delete rawOverrides.publishedAt;
  return createCanonicalBundleOfflinePublicationReceiptV1({
    researchCodeSha,
    publishedAt,
    publication:rawPublication(rawOverrides),
  });
}

test("owner capability builder leaves canonical bundle missing without durable readback receipt",()=>{
  const result=buildAdaptiveRuntimeOwnerBindingsV1({sourceSha:SHA});
  assert.deepEqual([...result.availableKeys].sort(),[
    "canonicalBacktester","formulaCompiler","stageCheckpointExecutor","statisticalFirewall",
  ]);
  assert.deepEqual(result.missingKeys,["canonicalBundleSource"]);
  assert.equal(result.allBindingsAvailable,false);
  assert.equal(result.bindings.canonicalBundleSource.status,"MISSING");
  assert.equal(
    result.bindings.canonicalBundleSource.reason,
    "CANONICAL_BUNDLE_READBACK_VERIFIED_PUBLICATION_REQUIRED",
  );
  assert.equal(result.safety.executionAuthority,"NONE");
});

test("valid durable canonical bundle publication completes all five exact runtime bindings",()=>{
  const result=buildAdaptiveRuntimeOwnerBindingsV1({
    sourceSha:SHA,
    bundlePublication:publication(),
  });
  assert.equal(result.allBindingsAvailable,true);
  assert.deepEqual(result.missingKeys,[]);
  for(const [key,binding] of Object.entries(result.bindings)){
    const wanted=ADAPTIVE_TOURNAMENT_RUNTIME_BINDING_REQUIREMENTS_V1[key];
    assert.equal(binding.status,"AVAILABLE");
    assert.deepEqual(binding.ownerRefs,wanted.ownerRefs);
    assert.equal(binding.capability,wanted.capability);
    assert.equal(binding.sourceSha,SHA);
    assert.deepEqual(binding.properties,wanted.properties);
    assert.equal(binding.reason,null);
    assert.match(binding.evidenceId,/^.+sha256:[0-9a-f]{64}$/);
  }
});

test("runtime adapter accepts capability envelopes and becomes READY_NON_ACTIVATING only with real bundle publication",()=>{
  const plan=readyPlan();
  const blocked=buildAdaptiveRuntimeOwnerBindingsV1({sourceSha:SHA});
  const blockedAssessment=assessAdaptiveTournamentRuntimeBindingsV1({
    plan,
    bindings:blocked.bindings,
  });
  assert.equal(blockedAssessment.status,"BLOCKED_RUNTIME_BINDINGS");
  assert.deepEqual(blockedAssessment.unavailableBindingKeys,["canonicalBundleSource"]);
  assert.equal(blockedAssessment.nextFirstZero,"AUTHENTIC_CANONICAL_BUNDLE_SOURCE_MISSING");

  const ready=buildAdaptiveRuntimeOwnerBindingsV1({
    sourceSha:SHA,
    bundlePublication:publication(),
  });
  const readyAssessment=assessAdaptiveTournamentRuntimeBindingsV1({
    plan,
    bindings:ready.bindings,
  });
  assert.equal(readyAssessment.status,"READY_NON_ACTIVATING");
  assert.deepEqual(readyAssessment.unavailableBindingKeys,[]);
  assert.equal(
    readyAssessment.nextFirstZero,
    "ADAPTIVE_TOURNAMENT_RUNTIME_EXECUTION_AUTHORITY_NOT_GRANTED",
  );
});

test("tampered, stale-SHA or economically authoritative bundle publication remains missing instead of being credited",()=>{
  const valid=publication();
  const badRows=[
    {...valid,researchCodeSha:"d".repeat(40)},
    {...valid,publishedAt:"2026-09-20T00:00:01.000Z"},
    {...valid,evidenceCredit:1},
    {...valid,profitabilityProven:true},
    {...valid,executionAuthority:"TRADING"},
    {...valid,bundleDigest:"not-a-digest"},
    rawPublication(),
  ];
  for(const bad of badRows){
    assert.equal(validateCanonicalBundlePublicationV1(bad,SHA),false);
    const result=buildAdaptiveRuntimeOwnerBindingsV1({
      sourceSha:SHA,
      bundlePublication:bad,
    });
    assert.equal(result.bindings.canonicalBundleSource.status,"MISSING");
    assert.equal(result.allBindingsAvailable,false);
  }
});

test("offline publication receipt creator rejects invalid raw publication and binds exact source SHA",()=>{
  const receipt=publication();
  assert.equal(validateCanonicalBundlePublicationV1(receipt,SHA),true);
  assert.equal(validateCanonicalBundlePublicationV1(receipt,"f".repeat(40)),false);
  assert.throws(()=>createCanonicalBundleOfflinePublicationReceiptV1({
    researchCodeSha:SHA,
    publishedAt:AT,
    publication:rawPublication({evidenceCredit:1}),
  }),/RAW_PUBLICATION_INVALID/);
});

test("source SHA is exact and capability proof cannot be rebound to symbolic refs",()=>{
  assert.throws(
    ()=>buildAdaptiveRuntimeOwnerBindingsV1({sourceSha:"main"}),
    /exact 40-character SHA/,
  );
});
