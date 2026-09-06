import { createHash } from "node:crypto";

import {
  ADAPTIVE_TOURNAMENT_STAGES_V1,
  canonicalSerializeAdaptiveTournamentV1,
  verifyAdaptiveMultiMarketTournamentPlanV1,
} from "./adaptive-multi-market-tournament-orchestrator-v1.js";

export const ADAPTIVE_TOURNAMENT_RUNTIME_ADAPTER_CONTRACT_V1 =
  "adaptive-multi-market-tournament-runtime-adapter/v1";

const SHA40 = /^[0-9a-f]{40}$/u;
const HASH64 = /^[0-9a-f]{64}$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

const CALLABLE_STAGES = Object.freeze(ADAPTIVE_TOURNAMENT_STAGES_V1.slice(0, 10));

const COMMON_PROPERTIES = Object.freeze({
  runtimeActivationAllowed: false,
  scheduleMutationAllowed: false,
  deploymentAllowed: false,
  finalHoldoutAccessAllowed: false,
  liveTradingAllowed: false,
  executionAuthority: "NONE",
});

const BINDING_REQUIREMENTS = Object.freeze({
  stageCheckpointExecutor: Object.freeze({
    ownerRefs: Object.freeze(["#551"]),
    capability: "TOURNAMENT_STAGE_CHECKPOINT_RESUME_V1",
    firstZero: "RESEARCH_TOURNAMENT_STAGE_CHECKPOINT_RESUME_PORT_MISSING",
    properties: Object.freeze({
      ...COMMON_PROPERTIES,
      checkpointResumeSupported: true,
      monolithicFullDepthOnly: false,
      finalHoldoutCallable: false,
      supportedStages: CALLABLE_STAGES,
    }),
  }),
  canonicalBundleSource: Object.freeze({
    ownerRefs: Object.freeze(["#821", "#833"]),
    capability: "AUTHENTIC_CANONICAL_BUNDLE_SOURCE_V1",
    firstZero: "AUTHENTIC_CANONICAL_BUNDLE_SOURCE_MISSING",
    properties: Object.freeze({
      ...COMMON_PROPERTIES,
      authenticOwnerPublishedCatalogRequired: true,
      testFixtureCreditAllowed: false,
      syntheticBundleAllowed: false,
    }),
  }),
  formulaCompiler: Object.freeze({
    ownerRefs: Object.freeze(["#550"]),
    capability: "BOUNDED_FORMULA_COMPILER_V1",
    firstZero: "BOUNDED_FORMULA_COMPILER_PORT_MISSING",
    properties: Object.freeze({
      ...COMMON_PROPERTIES,
      boundedDslOnly: true,
      arbitraryExecutableCodeAllowed: false,
      finalHoldoutFeedbackAllowed: false,
    }),
  }),
  canonicalBacktester: Object.freeze({
    ownerRefs: Object.freeze(["#690"]),
    capability: "ONE_PASS_EXECUTION_EQUIVALENT_BACKTESTER_V1",
    firstZero: "CANONICAL_BACKTESTER_PORT_MISSING",
    properties: Object.freeze({
      ...COMMON_PROPERTIES,
      onePassExecutionEquivalent: true,
      duplicateBacktesterAllowed: false,
      resultIdentityRequired: true,
    }),
  }),
  statisticalFirewall: Object.freeze({
    ownerRefs: Object.freeze(["#547"]),
    capability: "CANONICAL_STATISTICAL_FIREWALL_V1",
    firstZero: "CANONICAL_STATISTICAL_FIREWALL_PORT_MISSING",
    properties: Object.freeze({
      ...COMMON_PROPERTIES,
      originalCandidateFamilySizeRequired: true,
      dsrAndPboRequired: true,
      aiNumericAuthorityAllowed: false,
    }),
  }),
});

export const ADAPTIVE_TOURNAMENT_RUNTIME_BINDING_KEYS_V1 = Object.freeze(
  Object.keys(BINDING_REQUIREMENTS),
);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function plainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function fail(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = deepFreeze({ ...details });
  throw error;
}

function requiredText(value, code) {
  if (typeof value !== "string" || value.trim().length === 0) fail(code, { value });
  return value.trim();
}

function exactKeys(value, expected, code) {
  if (!plainObject(value)) fail(code, { reason: "NOT_PLAIN_OBJECT" });
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(code, { actual, expected: wanted });
  }
}

function canonicalDigest(value) {
  return createHash("sha256")
    .update(canonicalSerializeAdaptiveTournamentV1(value), "utf8")
    .digest("hex");
}

function valuesEqual(left, right) {
  return canonicalSerializeAdaptiveTournamentV1(left)
    === canonicalSerializeAdaptiveTournamentV1(right);
}

function missingBinding(key, reason = "MISSING_BINDING_EVIDENCE") {
  return deepFreeze({
    bindingKey: key,
    status: "MISSING",
    ownerRefs: null,
    capability: null,
    sourceSha: null,
    evidenceId: null,
    properties: null,
    reason,
  });
}

function normalizeAvailableBinding(key, raw, requirement, planSourceSha) {
  exactKeys(raw, [
    "status",
    "ownerRefs",
    "capability",
    "sourceSha",
    "evidenceId",
    "properties",
    "reason",
  ], "ADAPTIVE_RUNTIME_BINDING_SHAPE_INVALID");

  const status = requiredText(raw.status, "ADAPTIVE_RUNTIME_BINDING_STATUS_REQUIRED").toUpperCase();
  if (status !== "AVAILABLE") {
    if (!new Set(["MISSING", "INVALID"]).has(status)) {
      fail("ADAPTIVE_RUNTIME_BINDING_STATUS_INVALID", { key, status });
    }
    if (
      raw.ownerRefs !== null
      || raw.capability !== null
      || raw.sourceSha !== null
      || raw.evidenceId !== null
      || raw.properties !== null
    ) {
      fail("MISSING_RUNTIME_BINDING_MUST_PRESERVE_NULL", { key, status });
    }
    return deepFreeze({
      bindingKey: key,
      status,
      ownerRefs: null,
      capability: null,
      sourceSha: null,
      evidenceId: null,
      properties: null,
      reason: requiredText(raw.reason, "ADAPTIVE_RUNTIME_BINDING_REASON_REQUIRED"),
    });
  }

  if (raw.reason !== null) fail("AVAILABLE_RUNTIME_BINDING_REASON_MUST_BE_NULL", { key });
  if (!Array.isArray(raw.ownerRefs) || !valuesEqual(raw.ownerRefs, requirement.ownerRefs)) {
    fail("ADAPTIVE_RUNTIME_BINDING_OWNER_MISMATCH", {
      key,
      actual: raw.ownerRefs,
      expected: requirement.ownerRefs,
    });
  }
  if (raw.capability !== requirement.capability) {
    fail("ADAPTIVE_RUNTIME_BINDING_CAPABILITY_MISMATCH", {
      key,
      actual: raw.capability,
      expected: requirement.capability,
    });
  }
  if (!SHA40.test(raw.sourceSha ?? "") || raw.sourceSha !== planSourceSha) {
    fail("ADAPTIVE_RUNTIME_BINDING_SOURCE_SHA_MISMATCH", {
      key,
      actual: raw.sourceSha,
      expected: planSourceSha,
    });
  }
  const evidenceId = requiredText(raw.evidenceId, "ADAPTIVE_RUNTIME_BINDING_EVIDENCE_ID_REQUIRED");
  if (!plainObject(raw.properties) || !valuesEqual(raw.properties, requirement.properties)) {
    fail("ADAPTIVE_RUNTIME_BINDING_PROPERTIES_MISMATCH", {
      key,
      actual: raw.properties,
      expected: requirement.properties,
    });
  }

  return deepFreeze({
    bindingKey: key,
    status: "AVAILABLE",
    ownerRefs: [...requirement.ownerRefs],
    capability: requirement.capability,
    sourceSha: raw.sourceSha,
    evidenceId,
    properties: requirement.properties,
    reason: null,
  });
}

export function assessAdaptiveTournamentRuntimeBindingsV1({ plan, bindings = {} } = {}) {
  if (!verifyAdaptiveMultiMarketTournamentPlanV1(plan)) {
    fail("ADAPTIVE_TOURNAMENT_PLAN_INVALID");
  }
  if (!plainObject(bindings)) fail("ADAPTIVE_RUNTIME_BINDINGS_INVALID");
  const unknown = Object.keys(bindings)
    .filter((key) => !ADAPTIVE_TOURNAMENT_RUNTIME_BINDING_KEYS_V1.includes(key));
  if (unknown.length > 0) fail("ADAPTIVE_RUNTIME_BINDING_UNKNOWN", { unknown: unknown.sort() });

  const normalized = ADAPTIVE_TOURNAMENT_RUNTIME_BINDING_KEYS_V1.map((key) => {
    const requirement = BINDING_REQUIREMENTS[key];
    return bindings[key] === undefined
      ? missingBinding(key)
      : normalizeAvailableBinding(key, bindings[key], requirement, plan.sourceSha);
  });
  const byKey = Object.fromEntries(normalized.map((binding) => [binding.bindingKey, binding]));
  const unavailable = normalized.filter((binding) => binding.status !== "AVAILABLE");
  const firstUnavailable = normalized.find((binding) => binding.status !== "AVAILABLE") ?? null;
  const noReadyProfiles = plan.readiness?.readyProfileCount === 0;
  const status = noReadyProfiles
    ? "BLOCKED_NO_READY_PROFILES"
    : unavailable.length === 0
      ? "READY_NON_ACTIVATING"
      : "BLOCKED_RUNTIME_BINDINGS";

  return deepFreeze({
    schemaVersion: 1,
    contract: "adaptive-tournament-runtime-binding-assessment/v1",
    planDigest: plan.planDigest,
    sourceSha: plan.sourceSha,
    status,
    bindings: byKey,
    unavailableBindingKeys: unavailable.map((binding) => binding.bindingKey),
    nextFirstZero: noReadyProfiles
      ? "MARKET_PROFILE_DATA_READINESS_MISSING"
      : firstUnavailable
        ? BINDING_REQUIREMENTS[firstUnavailable.bindingKey].firstZero
        : "ADAPTIVE_TOURNAMENT_RUNTIME_EXECUTION_AUTHORITY_NOT_GRANTED",
    stageCheckpointResumeProven: byKey.stageCheckpointExecutor.status === "AVAILABLE",
    monolithicFullDepthExecutionAccepted: false,
    finalHoldoutCallable: false,
    actualOwnerCalls: 0,
    actualBacktests: 0,
    actualStatisticalFirewallCalls: 0,
  });
}

function stagePortDefinitions() {
  const callable = {
    FORMULA_CANDIDATE: {
      mode: "CHECKPOINT_EXECUTOR_REQUIRED",
      bindingKeys: ["formulaCompiler", "stageCheckpointExecutor"],
      ownerRefs: ["#550", "#551"],
      canonicalOwnerStage: "FORMULA_CANDIDATE",
    },
    SANITY_CHECK: {
      mode: "CHECKPOINT_EXECUTOR_REQUIRED",
      bindingKeys: ["stageCheckpointExecutor"],
      ownerRefs: ["#551"],
      canonicalOwnerStage: "SANITY_CHECK",
    },
    DEVELOPMENT_BACKTEST: {
      mode: "CHECKPOINT_EXECUTOR_REQUIRED",
      bindingKeys: ["stageCheckpointExecutor", "canonicalBacktester"],
      ownerRefs: ["#551", "#690"],
      canonicalOwnerStage: "HISTORICAL_BACKTEST",
    },
    DEVELOPMENT_BASE_COST: {
      mode: "CHECKPOINT_EXECUTOR_REQUIRED",
      bindingKeys: ["stageCheckpointExecutor", "canonicalBacktester"],
      ownerRefs: ["#551", "#690"],
      canonicalOwnerStage: "HISTORICAL_BACKTEST_COST_EVIDENCE",
    },
    BLIND_OOS: {
      mode: "CHECKPOINT_EXECUTOR_REQUIRED",
      bindingKeys: ["stageCheckpointExecutor"],
      ownerRefs: ["#551"],
      canonicalOwnerStage: "OOS",
    },
    PURGED_OOS: {
      mode: "CHECKPOINT_EXECUTOR_REQUIRED",
      bindingKeys: ["stageCheckpointExecutor"],
      ownerRefs: ["#551"],
      canonicalOwnerStage: "PURGED_OOS",
    },
    WALK_FORWARD: {
      mode: "CHECKPOINT_EXECUTOR_REQUIRED",
      bindingKeys: ["stageCheckpointExecutor"],
      ownerRefs: ["#551"],
      canonicalOwnerStage: "WALK_FORWARD",
    },
    COST_STRESS: {
      mode: "CHECKPOINT_EXECUTOR_REQUIRED",
      bindingKeys: ["stageCheckpointExecutor", "canonicalBacktester"],
      ownerRefs: ["#551", "#690"],
      canonicalOwnerStage: "COST_STRESS",
    },
    REGIME_STRESS: {
      mode: "CHECKPOINT_EXECUTOR_REQUIRED",
      bindingKeys: ["stageCheckpointExecutor"],
      ownerRefs: ["#551"],
      canonicalOwnerStage: "REGIME_STRESS",
    },
    STATISTICAL_FIREWALL: {
      mode: "CHECKPOINT_EXECUTOR_REQUIRED",
      bindingKeys: ["stageCheckpointExecutor", "statisticalFirewall"],
      ownerRefs: ["#551", "#547"],
      canonicalOwnerStage: "STATISTICAL_FIREWALL",
    },
  };

  return ADAPTIVE_TOURNAMENT_STAGES_V1.map((stage, index) => {
    const priorStage = index === 0 ? null : ADAPTIVE_TOURNAMENT_STAGES_V1[index - 1];
    if (callable[stage]) {
      return deepFreeze({
        stage,
        stageIndex: index,
        priorStage,
        ...callable[stage],
        executionAuthorized: false,
        automaticPromotionAllowed: false,
      });
    }
    const handoffTarget = stage === "SHADOW_CANDIDATE"
      ? "CANONICAL_SHADOW_OWNER"
      : stage === "FORWARD_CANDIDATE"
        ? "CANONICAL_FORWARD_OWNER_CHAIN"
        : "CANONICAL_PAPER_OWNER_CHAIN";
    return deepFreeze({
      stage,
      stageIndex: index,
      priorStage,
      mode: "HANDOFF_ONLY_EXISTING_OWNER_REQUIRED",
      bindingKeys: [],
      ownerRefs: [],
      canonicalOwnerStage: null,
      handoffTarget,
      executionAuthorized: false,
      automaticPromotionAllowed: false,
    });
  });
}

export const ADAPTIVE_TOURNAMENT_RUNTIME_STAGE_PORTS_V1 = deepFreeze(stagePortDefinitions());

function capacityPlan(plan) {
  if (
    plan.successiveHalving?.contract !== "adaptive-successive-halving-plan/v1"
    || !Array.isArray(plan.successiveHalving.stagePlans)
  ) {
    fail("ADAPTIVE_SUCCESSIVE_HALVING_PLAN_REQUIRED");
  }
  return plan.successiveHalving.stagePlans.map((profile) => {
    if (!Array.isArray(profile.stages) || profile.stages.length !== ADAPTIVE_TOURNAMENT_STAGES_V1.length) {
      fail("ADAPTIVE_PROFILE_STAGE_CAPACITY_INVALID", { profileId: profile.profileId });
    }
    const stages = profile.stages.map((stage, index) => {
      if (stage.stage !== ADAPTIVE_TOURNAMENT_STAGES_V1[index]) {
        fail("ADAPTIVE_PROFILE_STAGE_ORDER_MISMATCH", { profileId: profile.profileId, index });
      }
      if (!Number.isSafeInteger(stage.candidateCap) || stage.candidateCap < 0) {
        fail("ADAPTIVE_PROFILE_STAGE_CAP_INVALID", {
          profileId: profile.profileId,
          stage: stage.stage,
          candidateCap: stage.candidateCap,
        });
      }
      return deepFreeze({
        stage: stage.stage,
        candidateCap: stage.candidateCap,
        globalInitialCandidateFamilySize: stage.globalInitialCandidateFamilySize,
        selectionFeedbackAllowed: stage.selectionFeedbackAllowed,
      });
    });
    return deepFreeze({
      profileId: profile.profileId,
      market: profile.market,
      horizon: profile.horizon,
      timeframe: profile.timeframe,
      directions: profile.directions,
      stages,
    });
  });
}

function adapterSafety() {
  return deepFreeze({
    contractOnly: true,
    runtimeExecutionAllowed: false,
    runtimeActivationAllowed: false,
    scheduleMutationAllowed: false,
    deploymentAllowed: false,
    databaseMutationAllowed: false,
    secretMutationAllowed: false,
    environmentMutationAllowed: false,
    finalHoldoutAccessAllowed: false,
    monolithicFullDepthExecutionAllowed: false,
    oosFeedbackToGeneratorAllowed: false,
    forwardFeedbackToGeneratorAllowed: false,
    paperFeedbackToGeneratorAllowed: false,
    missingEvidenceNumericSubstitutionAllowed: false,
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
    actualOwnerCalls: 0,
    actualBacktests: 0,
    actualStatisticalFirewallCalls: 0,
    actualShadowHandoffs: 0,
    actualForwardHandoffs: 0,
    actualPaperHandoffs: 0,
    realOrderCount: 0,
  });
}

export function buildAdaptiveTournamentRuntimeAdapterV1({
  plan,
  bindings = {},
  createdAt,
} = {}) {
  if (!verifyAdaptiveMultiMarketTournamentPlanV1(plan)) fail("ADAPTIVE_TOURNAMENT_PLAN_INVALID");
  if (typeof createdAt !== "string" || !ISO_TIMESTAMP.test(createdAt)) {
    fail("ADAPTIVE_RUNTIME_ADAPTER_TIMESTAMP_INVALID", { createdAt });
  }
  const bindingAssessment = assessAdaptiveTournamentRuntimeBindingsV1({ plan, bindings });
  const stages = ADAPTIVE_TOURNAMENT_RUNTIME_STAGE_PORTS_V1;
  const capacities = capacityPlan(plan);
  const safety = adapterSafety();
  const core = {
    schemaVersion: 1,
    contract: ADAPTIVE_TOURNAMENT_RUNTIME_ADAPTER_CONTRACT_V1,
    sourceSha: plan.sourceSha,
    createdAt,
    planDigest: plan.planDigest,
    initialCandidateFamilySize: plan.successiveHalving.initialCandidateFamilySize,
    bindingAssessment,
    stagePorts: stages,
    capacityPlan: capacities,
    status: bindingAssessment.status,
    nextFirstZero: bindingAssessment.nextFirstZero,
    finalHoldoutStagePresent: stages.some((stage) => stage.stage === "FINAL_HOLDOUT"),
    safety,
  };
  return deepFreeze({ ...core, adapterDigest: canonicalDigest(core) });
}

export function verifyAdaptiveTournamentRuntimeAdapterV1(adapter) {
  if (!plainObject(adapter)) return false;
  if (adapter.contract !== ADAPTIVE_TOURNAMENT_RUNTIME_ADAPTER_CONTRACT_V1) return false;
  if (!SHA40.test(adapter.sourceSha ?? "") || !HASH64.test(adapter.planDigest ?? "")) return false;
  if (!HASH64.test(adapter.adapterDigest ?? "")) return false;
  const core = { ...adapter };
  delete core.adapterDigest;
  if (canonicalDigest(core) !== adapter.adapterDigest) return false;
  if (!Array.isArray(adapter.stagePorts) || !valuesEqual(adapter.stagePorts, ADAPTIVE_TOURNAMENT_RUNTIME_STAGE_PORTS_V1)) {
    return false;
  }
  if (adapter.finalHoldoutStagePresent !== false) return false;
  const safety = adapter.safety;
  return safety?.contractOnly === true
    && safety.runtimeExecutionAllowed === false
    && safety.runtimeActivationAllowed === false
    && safety.scheduleMutationAllowed === false
    && safety.deploymentAllowed === false
    && safety.finalHoldoutAccessAllowed === false
    && safety.monolithicFullDepthExecutionAllowed === false
    && safety.oosFeedbackToGeneratorAllowed === false
    && safety.forwardFeedbackToGeneratorAllowed === false
    && safety.paperFeedbackToGeneratorAllowed === false
    && safety.missingEvidenceNumericSubstitutionAllowed === false
    && safety.shadowExecutionAllowed === false
    && safety.forwardExecutionAllowed === false
    && safety.paperExecutionAllowed === false
    && safety.championPromotionAllowed === false
    && safety.profitabilityClaimAllowed === false
    && safety.liveTrading === false
    && safety.autoTrading === false
    && safety.realOrderEnabled === false
    && safety.privateTradingApiAllowed === false
    && safety.executionAuthority === "NONE"
    && safety.actualOwnerCalls === 0
    && safety.actualBacktests === 0
    && safety.actualStatisticalFirewallCalls === 0
    && safety.realOrderCount === 0;
}

export function buildAdaptiveTournamentRuntimeCompatibilityReportV1({ adapter } = {}) {
  if (!verifyAdaptiveTournamentRuntimeAdapterV1(adapter)) {
    fail("ADAPTIVE_RUNTIME_ADAPTER_INVALID");
  }
  const missing = adapter.bindingAssessment.unavailableBindingKeys;
  return deepFreeze({
    schemaVersion: 1,
    contract: "adaptive-tournament-runtime-compatibility-report/v1",
    sourceSha: adapter.sourceSha,
    planDigest: adapter.planDigest,
    adapterDigest: adapter.adapterDigest,
    status: adapter.status,
    nextFirstZero: adapter.nextFirstZero,
    missingBindings: [...missing],
    stageCheckpointResumeProven: adapter.bindingAssessment.stageCheckpointResumeProven,
    callableStageCount: adapter.stagePorts.filter((stage) => stage.mode === "CHECKPOINT_EXECUTOR_REQUIRED").length,
    handoffOnlyStageCount: adapter.stagePorts.filter((stage) => stage.mode === "HANDOFF_ONLY_EXISTING_OWNER_REQUIRED").length,
    finalHoldoutStagePresent: false,
    executionAttempted: false,
    runtimeActivated: false,
    ownerCalls: 0,
    backtestsExecuted: 0,
    statisticalFirewallCalls: 0,
    shadowHandoffs: 0,
    forwardHandoffs: 0,
    paperHandoffs: 0,
    profitabilityProven: false,
    currentValidatedChampion: "NONE",
    executionAuthority: "NONE",
  });
}

export const ADAPTIVE_TOURNAMENT_RUNTIME_BINDING_REQUIREMENTS_V1 = BINDING_REQUIREMENTS;
