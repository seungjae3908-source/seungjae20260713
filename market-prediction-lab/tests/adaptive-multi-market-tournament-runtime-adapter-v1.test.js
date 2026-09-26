import assert from "node:assert/strict";
import test from "node:test";

import {
  ADAPTIVE_MULTI_MARKET_PROFILES_V1,
  ADAPTIVE_TOURNAMENT_STAGES_V1,
  buildAdaptiveMultiMarketTournamentPlanV1,
} from "../src/adaptive-multi-market-tournament-orchestrator-v1.js";
import {
  ADAPTIVE_TOURNAMENT_RUNTIME_ADAPTER_CONTRACT_V1,
  ADAPTIVE_TOURNAMENT_RUNTIME_BINDING_KEYS_V1,
  ADAPTIVE_TOURNAMENT_RUNTIME_BINDING_REQUIREMENTS_V1,
  ADAPTIVE_TOURNAMENT_RUNTIME_STAGE_PORTS_V1,
  assessAdaptiveTournamentRuntimeBindingsV1,
  buildAdaptiveTournamentRuntimeAdapterV1,
  buildAdaptiveTournamentRuntimeCompatibilityReportV1,
  verifyAdaptiveTournamentRuntimeAdapterV1,
} from "../src/adaptive-multi-market-tournament-runtime-adapter-v1.js";

const SOURCE_SHA = "a".repeat(40);
const CREATED_AT = "2026-09-02T00:00:00.000Z";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function policy() {
  const caps = [4, 4, 4, 3, 2, 2, 2, 1, 1, 1, 1, 1, 1];
  const ratios = [1, 1, 1, 0.75, 0.5, 0.5, 0.5, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25];
  return {
    policyId: "human-approved-adaptive-runtime-test-v1",
    totalCandidateBudget: 4,
    minimumCandidatesPerReadyProfile: 4,
    maximumCandidatesPerReadyProfile: 4,
    diagnosticWeights: {
      dataCompleteness: 0.3,
      signalCoverage: 0.2,
      costCoverage: 0.2,
      familyDiversity: 0.2,
      computeCapacity: 0.1,
    },
    stagePolicy: ADAPTIVE_TOURNAMENT_STAGES_V1.map((stage, index) => ({
      stage,
      retentionRatio: ratios[index],
      maximumPerProfile: caps[index],
    })),
    maximumParetoSurvivorsPerSpecialist: 1,
  };
}

function present(requirement) {
  return {
    status: "PRESENT",
    evidenceId: `evidence:${requirement}:v1`,
    observedAt: CREATED_AT,
  };
}

function buildPlan({ ready = true } = {}) {
  const profile = ADAPTIVE_MULTI_MARKET_PROFILES_V1
    .find((row) => row.profileId === "CRYPTO_SPOT:SHORT");
  const evidenceCatalog = ready
    ? {
      [profile.profileId]: Object.fromEntries(
        profile.requiredEvidence.map((requirement) => [requirement, present(requirement)]),
      ),
    }
    : {};
  const developmentDiagnostics = ready
    ? {
      [profile.profileId]: {
        sourceRole: "DEVELOPMENT_ONLY",
        evidenceId: "development-diagnostic:crypto-spot-short:v1",
        dataCompleteness: 0.9,
        signalCoverage: 0.8,
        costCoverage: 0.8,
        familyDiversity: 0.7,
        computeCapacity: 0.9,
      },
    }
    : {};
  return buildAdaptiveMultiMarketTournamentPlanV1({
    sourceSha: SOURCE_SHA,
    createdAt: CREATED_AT,
    evidenceCatalog,
    developmentDiagnostics,
    policy: policy(),
  });
}

function availableBinding(plan, key) {
  const requirement = ADAPTIVE_TOURNAMENT_RUNTIME_BINDING_REQUIREMENTS_V1[key];
  return {
    status: "AVAILABLE",
    ownerRefs: [...requirement.ownerRefs],
    capability: requirement.capability,
    sourceSha: plan.sourceSha,
    evidenceId: `runtime-binding:${key}:v1`,
    properties: clone(requirement.properties),
    reason: null,
  };
}

function completeBindings(plan) {
  return Object.fromEntries(
    ADAPTIVE_TOURNAMENT_RUNTIME_BINDING_KEYS_V1
      .map((key) => [key, availableBinding(plan, key)]),
  );
}

test("defines an exact non-activating adapter contract with ten callable and three handoff-only stages", () => {
  assert.equal(ADAPTIVE_TOURNAMENT_RUNTIME_ADAPTER_CONTRACT_V1,
    "adaptive-multi-market-tournament-runtime-adapter/v1");
  assert.equal(ADAPTIVE_TOURNAMENT_RUNTIME_STAGE_PORTS_V1.length, 13);
  assert.deepEqual(
    ADAPTIVE_TOURNAMENT_RUNTIME_STAGE_PORTS_V1.map((row) => row.stage),
    ADAPTIVE_TOURNAMENT_STAGES_V1,
  );
  assert.equal(
    ADAPTIVE_TOURNAMENT_RUNTIME_STAGE_PORTS_V1
      .filter((row) => row.mode === "CHECKPOINT_EXECUTOR_REQUIRED").length,
    10,
  );
  assert.equal(
    ADAPTIVE_TOURNAMENT_RUNTIME_STAGE_PORTS_V1
      .filter((row) => row.mode === "HANDOFF_ONLY_EXISTING_OWNER_REQUIRED").length,
    3,
  );
  assert.equal(
    ADAPTIVE_TOURNAMENT_RUNTIME_STAGE_PORTS_V1.some((row) => row.stage === "FINAL_HOLDOUT"),
    false,
  );
  assert.ok(ADAPTIVE_TOURNAMENT_RUNTIME_STAGE_PORTS_V1.every((row) => row.executionAuthorized === false));
});

test("maps Development Backtest and Development Base Cost to #551 plus canonical #690 without a second Backtester", () => {
  const historical = ADAPTIVE_TOURNAMENT_RUNTIME_STAGE_PORTS_V1
    .find((row) => row.stage === "DEVELOPMENT_BACKTEST");
  const cost = ADAPTIVE_TOURNAMENT_RUNTIME_STAGE_PORTS_V1
    .find((row) => row.stage === "DEVELOPMENT_BASE_COST");
  assert.deepEqual(historical.ownerRefs, ["#551", "#690"]);
  assert.deepEqual(cost.ownerRefs, ["#551", "#690"]);
  assert.equal(historical.canonicalOwnerStage, "HISTORICAL_BACKTEST");
  assert.equal(cost.canonicalOwnerStage, "HISTORICAL_BACKTEST_COST_EVIDENCE");
});

test("fails closed at the missing #551 stage-checkpoint/resume port before pretending a monolithic runner is adaptive", () => {
  const plan = buildPlan();
  const assessment = assessAdaptiveTournamentRuntimeBindingsV1({ plan, bindings: {} });
  assert.equal(assessment.status, "BLOCKED_RUNTIME_BINDINGS");
  assert.equal(assessment.nextFirstZero, "RESEARCH_TOURNAMENT_STAGE_CHECKPOINT_RESUME_PORT_MISSING");
  assert.equal(assessment.stageCheckpointResumeProven, false);
  assert.equal(assessment.monolithicFullDepthExecutionAccepted, false);
  assert.equal(assessment.actualOwnerCalls, 0);
  assert.equal(assessment.actualBacktests, 0);
});

test("preserves earlier market-profile readiness FIRST_ZERO when no profile has genuine data evidence", () => {
  const plan = buildPlan({ ready: false });
  const assessment = assessAdaptiveTournamentRuntimeBindingsV1({ plan, bindings: {} });
  assert.equal(assessment.status, "BLOCKED_NO_READY_PROFILES");
  assert.equal(assessment.nextFirstZero, "MARKET_PROFILE_DATA_READINESS_MISSING");
  assert.equal(assessment.actualOwnerCalls, 0);
});

test("accepts only exact integrated-main owner capabilities and remains non-activating even when every binding is present", () => {
  const plan = buildPlan();
  const assessment = assessAdaptiveTournamentRuntimeBindingsV1({
    plan,
    bindings: completeBindings(plan),
  });
  assert.equal(assessment.status, "READY_NON_ACTIVATING");
  assert.equal(assessment.nextFirstZero, "ADAPTIVE_TOURNAMENT_RUNTIME_EXECUTION_AUTHORITY_NOT_GRANTED");
  assert.equal(assessment.stageCheckpointResumeProven, true);
  assert.equal(assessment.actualOwnerCalls, 0);
});

test("rejects the current unsafe compatibility shape where #551 is monolithic full-depth only", () => {
  const plan = buildPlan();
  const bindings = completeBindings(plan);
  bindings.stageCheckpointExecutor.properties.monolithicFullDepthOnly = true;
  assert.throws(
    () => assessAdaptiveTournamentRuntimeBindingsV1({ plan, bindings }),
    (error) => error.code === "ADAPTIVE_RUNTIME_BINDING_PROPERTIES_MISMATCH",
  );
});

test("rejects any stage executor that can open Final Holdout through this adaptive runtime path", () => {
  const plan = buildPlan();
  const bindings = completeBindings(plan);
  bindings.stageCheckpointExecutor.properties.finalHoldoutCallable = true;
  assert.throws(
    () => assessAdaptiveTournamentRuntimeBindingsV1({ plan, bindings }),
    (error) => error.code === "ADAPTIVE_RUNTIME_BINDING_PROPERTIES_MISMATCH",
  );
});

test("rejects owner laundering, stale source SHA, unknown bindings, and unsafe properties", () => {
  const plan = buildPlan();

  const wrongOwner = completeBindings(plan);
  wrongOwner.canonicalBacktester.ownerRefs = ["#999"];
  assert.throws(
    () => assessAdaptiveTournamentRuntimeBindingsV1({ plan, bindings: wrongOwner }),
    (error) => error.code === "ADAPTIVE_RUNTIME_BINDING_OWNER_MISMATCH",
  );

  const stale = completeBindings(plan);
  stale.formulaCompiler.sourceSha = "b".repeat(40);
  assert.throws(
    () => assessAdaptiveTournamentRuntimeBindingsV1({ plan, bindings: stale }),
    (error) => error.code === "ADAPTIVE_RUNTIME_BINDING_SOURCE_SHA_MISMATCH",
  );

  assert.throws(
    () => assessAdaptiveTournamentRuntimeBindingsV1({
      plan,
      bindings: { unexpectedDuplicateEngine: {} },
    }),
    (error) => error.code === "ADAPTIVE_RUNTIME_BINDING_UNKNOWN",
  );

  const unsafe = completeBindings(plan);
  unsafe.statisticalFirewall.properties.aiNumericAuthorityAllowed = true;
  assert.throws(
    () => assessAdaptiveTournamentRuntimeBindingsV1({ plan, bindings: unsafe }),
    (error) => error.code === "ADAPTIVE_RUNTIME_BINDING_PROPERTIES_MISMATCH",
  );
});

test("requires missing/invalid binding evidence to remain null instead of becoming a safe-looking binding", () => {
  const plan = buildPlan();
  const bindings = {
    stageCheckpointExecutor: {
      status: "MISSING",
      ownerRefs: ["#551"],
      capability: null,
      sourceSha: null,
      evidenceId: null,
      properties: null,
      reason: "NO_CHECKPOINT_PORT",
    },
  };
  assert.throws(
    () => assessAdaptiveTournamentRuntimeBindingsV1({ plan, bindings }),
    (error) => error.code === "MISSING_RUNTIME_BINDING_MUST_PRESERVE_NULL",
  );
});

test("builds a deterministic adapter that preserves every profile stage cap and initial family size", () => {
  const plan = buildPlan();
  const adapter = buildAdaptiveTournamentRuntimeAdapterV1({
    plan,
    bindings: completeBindings(plan),
    createdAt: CREATED_AT,
  });
  assert.equal(adapter.status, "READY_NON_ACTIVATING");
  assert.equal(adapter.initialCandidateFamilySize, 4);
  assert.equal(adapter.capacityPlan.length, 12);
  const profile = adapter.capacityPlan.find((row) => row.profileId === "CRYPTO_SPOT:SHORT");
  assert.deepEqual(profile.stages.map((row) => row.candidateCap), [4, 4, 4, 3, 2, 2, 2, 1, 1, 1, 1, 1, 1]);
  assert.equal(profile.stages.find((row) => row.stage === "DEVELOPMENT_BASE_COST").selectionFeedbackAllowed, true);
  assert.equal(profile.stages.find((row) => row.stage === "BLIND_OOS").selectionFeedbackAllowed, false);
  assert.ok(profile.stages.every((row) => row.globalInitialCandidateFamilySize === 4));
  assert.equal(verifyAdaptiveTournamentRuntimeAdapterV1(adapter), true);
});

test("adapter safety explicitly prevents execution, activation, holdout, Shadow, Forward, Paper, Champion and trading authority", () => {
  const plan = buildPlan();
  const adapter = buildAdaptiveTournamentRuntimeAdapterV1({
    plan,
    bindings: completeBindings(plan),
    createdAt: CREATED_AT,
  });
  assert.deepEqual(
    {
      runtimeExecutionAllowed: adapter.safety.runtimeExecutionAllowed,
      runtimeActivationAllowed: adapter.safety.runtimeActivationAllowed,
      finalHoldoutAccessAllowed: adapter.safety.finalHoldoutAccessAllowed,
      shadowExecutionAllowed: adapter.safety.shadowExecutionAllowed,
      forwardExecutionAllowed: adapter.safety.forwardExecutionAllowed,
      paperExecutionAllowed: adapter.safety.paperExecutionAllowed,
      championPromotionAllowed: adapter.safety.championPromotionAllowed,
      profitabilityClaimAllowed: adapter.safety.profitabilityClaimAllowed,
      liveTrading: adapter.safety.liveTrading,
      autoTrading: adapter.safety.autoTrading,
      realOrderEnabled: adapter.safety.realOrderEnabled,
      privateTradingApiAllowed: adapter.safety.privateTradingApiAllowed,
      executionAuthority: adapter.safety.executionAuthority,
    },
    {
      runtimeExecutionAllowed: false,
      runtimeActivationAllowed: false,
      finalHoldoutAccessAllowed: false,
      shadowExecutionAllowed: false,
      forwardExecutionAllowed: false,
      paperExecutionAllowed: false,
      championPromotionAllowed: false,
      profitabilityClaimAllowed: false,
      liveTrading: false,
      autoTrading: false,
      realOrderEnabled: false,
      privateTradingApiAllowed: false,
      executionAuthority: "NONE",
    },
  );
  assert.equal(adapter.safety.actualOwnerCalls, 0);
  assert.equal(adapter.safety.realOrderCount, 0);
});

test("compatibility report is truthful and never converts a contract into an execution claim", () => {
  const plan = buildPlan();
  const blocked = buildAdaptiveTournamentRuntimeAdapterV1({
    plan,
    bindings: {},
    createdAt: CREATED_AT,
  });
  const report = buildAdaptiveTournamentRuntimeCompatibilityReportV1({ adapter: blocked });
  assert.equal(report.status, "BLOCKED_RUNTIME_BINDINGS");
  assert.equal(report.nextFirstZero, "RESEARCH_TOURNAMENT_STAGE_CHECKPOINT_RESUME_PORT_MISSING");
  assert.equal(report.callableStageCount, 10);
  assert.equal(report.handoffOnlyStageCount, 3);
  assert.equal(report.finalHoldoutStagePresent, false);
  assert.equal(report.executionAttempted, false);
  assert.equal(report.ownerCalls, 0);
  assert.equal(report.backtestsExecuted, 0);
  assert.equal(report.statisticalFirewallCalls, 0);
  assert.equal(report.profitabilityProven, false);
  assert.equal(report.currentValidatedChampion, "NONE");
  assert.equal(report.executionAuthority, "NONE");
});

test("adapter digest detects capacity, binding, safety and FIRST_ZERO tampering", () => {
  const plan = buildPlan();
  const adapter = buildAdaptiveTournamentRuntimeAdapterV1({
    plan,
    bindings: completeBindings(plan),
    createdAt: CREATED_AT,
  });
  for (const mutate of [
    (copy) => { copy.capacityPlan[0].stages[0].candidateCap += 1; },
    (copy) => { copy.bindingAssessment.stageCheckpointResumeProven = false; },
    (copy) => { copy.safety.runtimeExecutionAllowed = true; },
    (copy) => { copy.nextFirstZero = "FAKE_COMPLETE"; },
  ]) {
    const tampered = clone(adapter);
    mutate(tampered);
    assert.equal(verifyAdaptiveTournamentRuntimeAdapterV1(tampered), false);
  }
});

test("rejects tampered or non-canonical #874 plans before any owner call", () => {
  const plan = buildPlan();
  const tampered = clone(plan);
  tampered.planDigest = "b".repeat(64);
  assert.throws(
    () => buildAdaptiveTournamentRuntimeAdapterV1({
      plan: tampered,
      bindings: {},
      createdAt: CREATED_AT,
    }),
    (error) => error.code === "ADAPTIVE_TOURNAMENT_PLAN_INVALID",
  );
});

test("handoff stages remain existing-owner-only and cannot silently promote or trade", () => {
  for (const stage of ["SHADOW_CANDIDATE", "FORWARD_CANDIDATE", "PAPER_ELIGIBLE"]) {
    const port = ADAPTIVE_TOURNAMENT_RUNTIME_STAGE_PORTS_V1.find((row) => row.stage === stage);
    assert.equal(port.mode, "HANDOFF_ONLY_EXISTING_OWNER_REQUIRED");
    assert.deepEqual(port.bindingKeys, []);
    assert.equal(port.executionAuthorized, false);
    assert.equal(port.automaticPromotionAllowed, false);
    assert.ok(port.handoffTarget.startsWith("CANONICAL_"));
  }
});
