import { createHash } from "node:crypto";

import { RESEARCH_TOURNAMENT_STAGE_STATUSES } from "./research-tournament-engine-v1.js";

export const RESEARCH_TOURNAMENT_STAGE_CHECKPOINT_RESUME_CONTRACT_V1 =
  "research-tournament-stage-checkpoint-resume/v1";

export const RESEARCH_TOURNAMENT_STAGE_CHECKPOINT_RESUME_STAGES_V1 = Object.freeze([
  "FORMULA_CANDIDATE",
  "SANITY_CHECK",
  "DEVELOPMENT_BACKTEST",
  "DEVELOPMENT_BASE_COST",
  "BLIND_OOS",
  "PURGED_OOS",
  "WALK_FORWARD",
  "COST_STRESS",
  "REGIME_STRESS",
  "STATISTICAL_FIREWALL",
]);

const SHA40 = /^[0-9a-f]{40}$/u;
const HASH64 = /^[0-9a-f]{64}$/u;
const STATUS_SET = new Set(RESEARCH_TOURNAMENT_STAGE_STATUSES);
const STAGE_INDEX = new Map(
  RESEARCH_TOURNAMENT_STAGE_CHECKPOINT_RESUME_STAGES_V1.map((stage, index) => [stage, index]),
);
const COST_COMPONENTS = Object.freeze([
  "commission",
  "spread",
  "slippage",
  "tax",
  "funding",
  "latency",
  "liquidityImpact",
]);

const STAGE_DEFINITIONS = Object.freeze({
  FORMULA_CANDIDATE: Object.freeze({
    mode: "INTERNAL_IDENTITY_CHECK",
    canonicalOwnerStage: "FORMULA_CANDIDATE",
    ownerRefs: Object.freeze(["#550", "#551"]),
    callback: null,
  }),
  SANITY_CHECK: Object.freeze({
    mode: "SINGLE_CANONICAL_CALLBACK",
    canonicalOwnerStage: "SANITY_CHECK",
    ownerRefs: Object.freeze(["#551"]),
    callback: "runSanityCheck",
  }),
  DEVELOPMENT_BACKTEST: Object.freeze({
    mode: "SINGLE_CANONICAL_CALLBACK",
    canonicalOwnerStage: "HISTORICAL_BACKTEST",
    ownerRefs: Object.freeze(["#551", "#690"]),
    callback: "runDevelopmentBacktest",
  }),
  DEVELOPMENT_BASE_COST: Object.freeze({
    mode: "DERIVE_FROM_PRIOR_STAGE",
    canonicalOwnerStage: "HISTORICAL_BACKTEST_COST_EVIDENCE",
    ownerRefs: Object.freeze(["#551", "#690"]),
    callback: null,
  }),
  BLIND_OOS: Object.freeze({
    mode: "SINGLE_CANONICAL_CALLBACK",
    canonicalOwnerStage: "OOS",
    ownerRefs: Object.freeze(["#551"]),
    callback: "runBlindOos",
  }),
  PURGED_OOS: Object.freeze({
    mode: "SINGLE_CANONICAL_CALLBACK",
    canonicalOwnerStage: "PURGED_OOS",
    ownerRefs: Object.freeze(["#551"]),
    callback: "runPurgedOos",
  }),
  WALK_FORWARD: Object.freeze({
    mode: "SINGLE_CANONICAL_CALLBACK",
    canonicalOwnerStage: "WALK_FORWARD",
    ownerRefs: Object.freeze(["#551"]),
    callback: "runWalkForward",
  }),
  COST_STRESS: Object.freeze({
    mode: "SINGLE_CANONICAL_CALLBACK",
    canonicalOwnerStage: "COST_STRESS",
    ownerRefs: Object.freeze(["#551", "#690"]),
    callback: "runCostStress",
  }),
  REGIME_STRESS: Object.freeze({
    mode: "SINGLE_CANONICAL_CALLBACK",
    canonicalOwnerStage: "REGIME_STRESS",
    ownerRefs: Object.freeze(["#551"]),
    callback: "runRegimeStress",
  }),
  STATISTICAL_FIREWALL: Object.freeze({
    mode: "SINGLE_CANONICAL_CALLBACK",
    canonicalOwnerStage: "STATISTICAL_FIREWALL",
    ownerRefs: Object.freeze(["#551", "#547"]),
    callback: "runStatisticalFirewall",
  }),
});

export const RESEARCH_TOURNAMENT_STAGE_CHECKPOINT_RESUME_CAPABILITY_V1 = deepFreeze({
  ownerRefs: ["#551"],
  capability: "TOURNAMENT_STAGE_CHECKPOINT_RESUME_V1",
  properties: {
    runtimeActivationAllowed: false,
    scheduleMutationAllowed: false,
    deploymentAllowed: false,
    finalHoldoutAccessAllowed: false,
    liveTradingAllowed: false,
    executionAuthority: "NONE",
    checkpointResumeSupported: true,
    monolithicFullDepthOnly: false,
    finalHoldoutCallable: false,
    supportedStages: RESEARCH_TOURNAMENT_STAGE_CHECKPOINT_RESUME_STAGES_V1,
  },
});

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

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function canonical(value, path = "value") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("CHECKPOINT_NON_FINITE_NUMBER", { path });
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => canonical(entry, `${path}[${index}]`));
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    fail("CHECKPOINT_NON_PLAIN_OBJECT", { path });
  }
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonical(value[key], `${path}.${key}`)]),
  );
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
}

function checkpointSafety() {
  return deepFreeze({
    contractOnly: false,
    runtimeActivationAllowed: false,
    scheduleMutationAllowed: false,
    deploymentAllowed: false,
    databaseMutationAllowed: false,
    secretMutationAllowed: false,
    finalHoldoutAccessAllowed: false,
    finalHoldoutCallable: false,
    hindsightFeedbackAllowed: false,
    automaticPromotionAllowed: false,
    profitabilityClaimAllowed: false,
    championPromotionAllowed: false,
    liveTradingAllowed: false,
    autoTradingAllowed: false,
    realOrderAllowed: false,
    privateTradingApiAllowed: false,
    executionAuthority: "NONE",
  });
}

function checkpointCore(raw) {
  const core = { ...raw };
  delete core.checkpointDigest;
  return core;
}

function sealCheckpoint(core) {
  const frozen = deepFreeze(core);
  return deepFreeze({ ...frozen, checkpointDigest: digest(frozen) });
}

function exactStringArray(value, expected) {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((entry, index) => entry === expected[index]);
}

function verifyRecord(record, checkpoint) {
  if (!record || typeof record !== "object") return false;
  const definition = STAGE_DEFINITIONS[record.stage];
  if (!definition) return false;
  if (!STATUS_SET.has(record.status)) return false;
  if (record.strategyHash !== checkpoint.identity.strategyHash) return false;
  if (record.parameterIdentity !== checkpoint.identity.parameterIdentity) return false;
  if (record.datasetIdentity !== checkpoint.identity.datasetIdentity) return false;
  if (record.candidateFamilySize !== checkpoint.originalCandidateFamilySize) return false;
  if (record.canonicalOwnerStage !== definition.canonicalOwnerStage) return false;
  if (!exactStringArray(record.ownerRefs, definition.ownerRefs)) return false;
  if (record.finalHoldoutAccess !== false || record.executionAuthority !== "NONE") return false;
  if (!HASH64.test(record.evidenceDigest ?? "") || digest(record.evidence) !== record.evidenceDigest) return false;
  return true;
}

export function createResearchTournamentStageCheckpointV1({
  sourceSha,
  profileId,
  formulaCandidateId,
  generatedCandidateId,
  strategyHash,
  parameterIdentity,
  datasetIdentity,
  originalCandidateFamilySize,
  observedAt,
} = {}) {
  if (!SHA40.test(sourceSha ?? "")) fail("CHECKPOINT_SOURCE_SHA_INVALID");
  if (!HASH64.test(strategyHash ?? "")) fail("CHECKPOINT_STRATEGY_HASH_INVALID");
  if (!HASH64.test(parameterIdentity ?? "")) fail("CHECKPOINT_PARAMETER_IDENTITY_INVALID");
  if (!Number.isSafeInteger(originalCandidateFamilySize) || originalCandidateFamilySize < 1) {
    fail("CHECKPOINT_CANDIDATE_FAMILY_SIZE_INVALID");
  }
  const normalizedObservedAt = requiredText(observedAt, "CHECKPOINT_OBSERVED_AT_REQUIRED");
  if (!Number.isFinite(Date.parse(normalizedObservedAt))) fail("CHECKPOINT_OBSERVED_AT_INVALID");

  return sealCheckpoint({
    schemaVersion: 1,
    contract: RESEARCH_TOURNAMENT_STAGE_CHECKPOINT_RESUME_CONTRACT_V1,
    sourceSha,
    profileId: requiredText(profileId, "CHECKPOINT_PROFILE_ID_REQUIRED"),
    identity: deepFreeze({
      formulaCandidateId: requiredText(formulaCandidateId, "CHECKPOINT_FORMULA_ID_REQUIRED"),
      generatedCandidateId: requiredText(generatedCandidateId, "CHECKPOINT_GENERATED_ID_REQUIRED"),
      strategyHash,
      parameterIdentity,
      datasetIdentity: requiredText(datasetIdentity, "CHECKPOINT_DATASET_IDENTITY_REQUIRED"),
    }),
    originalCandidateFamilySize,
    observedAt: new Date(normalizedObservedAt).toISOString(),
    currentStage: null,
    nextStage: RESEARCH_TOURNAMENT_STAGE_CHECKPOINT_RESUME_STAGES_V1[0],
    status: "OPEN",
    completed: false,
    records: [],
    ownerCallCount: 0,
    actualFinalHoldoutCalls: 0,
    safety: checkpointSafety(),
  });
}

export function verifyResearchTournamentStageCheckpointV1(checkpoint) {
  if (!checkpoint || checkpoint.contract !== RESEARCH_TOURNAMENT_STAGE_CHECKPOINT_RESUME_CONTRACT_V1) {
    return false;
  }
  if (!SHA40.test(checkpoint.sourceSha ?? "") || !HASH64.test(checkpoint.checkpointDigest ?? "")) {
    return false;
  }
  if (digest(checkpointCore(checkpoint)) !== checkpoint.checkpointDigest) return false;
  if (!HASH64.test(checkpoint.identity?.strategyHash ?? "")
    || !HASH64.test(checkpoint.identity?.parameterIdentity ?? "")) return false;
  if (!Number.isSafeInteger(checkpoint.originalCandidateFamilySize)
    || checkpoint.originalCandidateFamilySize < 1) return false;
  if (!Array.isArray(checkpoint.records)
    || checkpoint.records.some((record) => !verifyRecord(record, checkpoint))) return false;
  if (checkpoint.actualFinalHoldoutCalls !== 0) return false;
  if (checkpoint.safety?.finalHoldoutCallable !== false
    || checkpoint.safety?.finalHoldoutAccessAllowed !== false
    || checkpoint.safety?.executionAuthority !== "NONE"
    || checkpoint.safety?.automaticPromotionAllowed !== false) return false;

  if (checkpoint.completed) {
    return checkpoint.nextStage === null
      && ["READY_FOR_HANDOFF", "TERMINAL_FAIL_CLOSED"].includes(checkpoint.status);
  }
  const expectedIndex = checkpoint.records.length;
  return checkpoint.status === "OPEN"
    && expectedIndex < RESEARCH_TOURNAMENT_STAGE_CHECKPOINT_RESUME_STAGES_V1.length
    && checkpoint.nextStage === RESEARCH_TOURNAMENT_STAGE_CHECKPOINT_RESUME_STAGES_V1[expectedIndex]
    && checkpoint.currentStage === (expectedIndex === 0
      ? null
      : RESEARCH_TOURNAMENT_STAGE_CHECKPOINT_RESUME_STAGES_V1[expectedIndex - 1]);
}

function callbackPayload(checkpoint, stage, definition) {
  return deepFreeze({
    sourceSha: checkpoint.sourceSha,
    checkpointDigest: checkpoint.checkpointDigest,
    profileId: checkpoint.profileId,
    stage,
    canonicalOwnerStage: definition.canonicalOwnerStage,
    ownerRefs: definition.ownerRefs,
    identity: checkpoint.identity,
    originalCandidateFamilySize: checkpoint.originalCandidateFamilySize,
    priorStageRecord: checkpoint.records.at(-1) ?? null,
    finalHoldoutAccess: false,
    automaticPromotionAllowed: false,
    executionAuthority: "NONE",
  });
}

function validateResultIdentity(raw, checkpoint, stage, definition) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail("CHECKPOINT_STAGE_RESULT_INVALID", { stage });
  }
  if (!STATUS_SET.has(raw.status)) fail("CHECKPOINT_STAGE_STATUS_INVALID", { stage, status: raw.status });
  if (raw.strategyHash !== checkpoint.identity.strategyHash
    || raw.parameterIdentity !== checkpoint.identity.parameterIdentity
    || raw.datasetIdentity !== checkpoint.identity.datasetIdentity) {
    fail("CHECKPOINT_STAGE_IDENTITY_MISMATCH", { stage });
  }
  if (raw.candidateFamilySize !== checkpoint.originalCandidateFamilySize) {
    fail("CHECKPOINT_CANDIDATE_FAMILY_SIZE_MISMATCH", {
      stage,
      actual: raw.candidateFamilySize,
      expected: checkpoint.originalCandidateFamilySize,
    });
  }
  if (raw.canonicalOwnerStage !== definition.canonicalOwnerStage
    || !exactStringArray(raw.ownerRefs, definition.ownerRefs)) {
    fail("CHECKPOINT_STAGE_OWNER_MISMATCH", { stage });
  }
  if (raw.finalHoldoutAccess !== false
    || raw.automaticPromotionAllowed !== false
    || raw.executionAuthority !== "NONE") {
    fail("CHECKPOINT_STAGE_AUTHORITY_ESCALATION", { stage });
  }
  return raw;
}

function identityPass(checkpoint, stage, definition) {
  return deepFreeze({
    status: "PASS",
    canonicalOwnerStage: definition.canonicalOwnerStage,
    ownerRefs: definition.ownerRefs,
    strategyHash: checkpoint.identity.strategyHash,
    parameterIdentity: checkpoint.identity.parameterIdentity,
    datasetIdentity: checkpoint.identity.datasetIdentity,
    candidateFamilySize: checkpoint.originalCandidateFamilySize,
    evidence: {
      formulaCandidateId: checkpoint.identity.formulaCandidateId,
      generatedCandidateId: checkpoint.identity.generatedCandidateId,
      immutableIdentity: true,
    },
    finalHoldoutAccess: false,
    automaticPromotionAllowed: false,
    executionAuthority: "NONE",
  });
}

function baseCostResult(checkpoint, stage, definition) {
  const prior = checkpoint.records.at(-1);
  const costs = prior?.evidence?.costEvidence;
  if (!costs || typeof costs !== "object" || Array.isArray(costs)) {
    return deepFreeze({
      status: "MISSING_EVIDENCE",
      canonicalOwnerStage: definition.canonicalOwnerStage,
      ownerRefs: definition.ownerRefs,
      strategyHash: checkpoint.identity.strategyHash,
      parameterIdentity: checkpoint.identity.parameterIdentity,
      datasetIdentity: checkpoint.identity.datasetIdentity,
      candidateFamilySize: checkpoint.originalCandidateFamilySize,
      evidence: { costEvidence: null, blocker: "DEVELOPMENT_BASE_COST_EVIDENCE_MISSING" },
      finalHoldoutAccess: false,
      automaticPromotionAllowed: false,
      executionAuthority: "NONE",
    });
  }
  const missing = COST_COMPONENTS.filter((component) => costs[component] == null);
  return deepFreeze({
    status: missing.length === 0 ? "PASS" : "MISSING_EVIDENCE",
    canonicalOwnerStage: definition.canonicalOwnerStage,
    ownerRefs: definition.ownerRefs,
    strategyHash: checkpoint.identity.strategyHash,
    parameterIdentity: checkpoint.identity.parameterIdentity,
    datasetIdentity: checkpoint.identity.datasetIdentity,
    candidateFamilySize: checkpoint.originalCandidateFamilySize,
    evidence: {
      costEvidence: costs,
      derivedFromStage: "DEVELOPMENT_BACKTEST",
      priorEvidenceDigest: prior.evidenceDigest,
      missingComponents: missing,
    },
    finalHoldoutAccess: false,
    automaticPromotionAllowed: false,
    executionAuthority: "NONE",
  });
}

async function runSingleStage(checkpoint, stage, definition, dependencies) {
  if (definition.mode === "INTERNAL_IDENTITY_CHECK") return identityPass(checkpoint, stage, definition);
  if (definition.mode === "DERIVE_FROM_PRIOR_STAGE") return baseCostResult(checkpoint, stage, definition);
  const runner = dependencies?.[definition.callback];
  if (typeof runner !== "function") {
    return deepFreeze({
      status: "MISSING_EVIDENCE",
      canonicalOwnerStage: definition.canonicalOwnerStage,
      ownerRefs: definition.ownerRefs,
      strategyHash: checkpoint.identity.strategyHash,
      parameterIdentity: checkpoint.identity.parameterIdentity,
      datasetIdentity: checkpoint.identity.datasetIdentity,
      candidateFamilySize: checkpoint.originalCandidateFamilySize,
      evidence: { blocker: "MISSING_CANONICAL_STAGE_CALLBACK", callback: definition.callback },
      finalHoldoutAccess: false,
      automaticPromotionAllowed: false,
      executionAuthority: "NONE",
    });
  }
  try {
    return validateResultIdentity(
      await runner(callbackPayload(checkpoint, stage, definition)),
      checkpoint,
      stage,
      definition,
    );
  } catch (error) {
    if (error?.code?.startsWith?.("CHECKPOINT_")) throw error;
    return deepFreeze({
      status: "NOT_EVALUABLE",
      canonicalOwnerStage: definition.canonicalOwnerStage,
      ownerRefs: definition.ownerRefs,
      strategyHash: checkpoint.identity.strategyHash,
      parameterIdentity: checkpoint.identity.parameterIdentity,
      datasetIdentity: checkpoint.identity.datasetIdentity,
      candidateFamilySize: checkpoint.originalCandidateFamilySize,
      evidence: {
        blocker: "EVALUATION_RUNTIME_ERROR",
        error: error instanceof Error ? error.message : String(error),
      },
      finalHoldoutAccess: false,
      automaticPromotionAllowed: false,
      executionAuthority: "NONE",
    });
  }
}

function stageRecord(checkpoint, stage, definition, result) {
  const evidence = canonical(result.evidence ?? null, `${stage}.evidence`);
  return deepFreeze({
    stage,
    status: result.status,
    canonicalOwnerStage: definition.canonicalOwnerStage,
    ownerRefs: definition.ownerRefs,
    strategyHash: checkpoint.identity.strategyHash,
    parameterIdentity: checkpoint.identity.parameterIdentity,
    datasetIdentity: checkpoint.identity.datasetIdentity,
    candidateFamilySize: checkpoint.originalCandidateFamilySize,
    evidence,
    evidenceDigest: digest(evidence),
    priorCheckpointDigest: checkpoint.checkpointDigest,
    observedAt: checkpoint.observedAt,
    finalHoldoutAccess: false,
    executionAuthority: "NONE",
  });
}

export async function executeResearchTournamentStageCheckpointV1(
  checkpoint,
  { stage } = {},
  dependencies = {},
) {
  if (!verifyResearchTournamentStageCheckpointV1(checkpoint)) {
    fail("CHECKPOINT_RESUME_INTEGRITY_INVALID");
  }
  if (checkpoint.completed) fail("CHECKPOINT_ALREADY_COMPLETE");
  if (!STAGE_INDEX.has(stage)) fail("CHECKPOINT_STAGE_UNSUPPORTED", { stage });
  if (stage !== checkpoint.nextStage) {
    fail("CHECKPOINT_STAGE_ORDER_INVALID", { expected: checkpoint.nextStage, actual: stage });
  }

  const definition = STAGE_DEFINITIONS[stage];
  const result = await runSingleStage(checkpoint, stage, definition, dependencies);
  const record = stageRecord(checkpoint, stage, definition, result);
  const records = [...checkpoint.records, record];
  const index = STAGE_INDEX.get(stage);
  const passed = result.status === "PASS";
  const isLast = index === RESEARCH_TOURNAMENT_STAGE_CHECKPOINT_RESUME_STAGES_V1.length - 1;
  const completed = !passed || isLast;
  const nextStage = completed
    ? null
    : RESEARCH_TOURNAMENT_STAGE_CHECKPOINT_RESUME_STAGES_V1[index + 1];
  const status = !passed
    ? "TERMINAL_FAIL_CLOSED"
    : isLast
      ? "READY_FOR_HANDOFF"
      : "OPEN";
  const ownerCallIncrement = definition.mode === "SINGLE_CANONICAL_CALLBACK"
    && typeof dependencies?.[definition.callback] === "function"
    ? 1
    : 0;

  return sealCheckpoint({
    ...checkpointCore(checkpoint),
    currentStage: stage,
    nextStage,
    status,
    completed,
    records,
    ownerCallCount: checkpoint.ownerCallCount + ownerCallIncrement,
    actualFinalHoldoutCalls: 0,
  });
}

export function createResearchTournamentStageCheckpointCapabilityEvidenceV1({ sourceSha } = {}) {
  if (!SHA40.test(sourceSha ?? "")) fail("CHECKPOINT_CAPABILITY_SOURCE_SHA_INVALID");
  const core = {
    ownerRefs: RESEARCH_TOURNAMENT_STAGE_CHECKPOINT_RESUME_CAPABILITY_V1.ownerRefs,
    capability: RESEARCH_TOURNAMENT_STAGE_CHECKPOINT_RESUME_CAPABILITY_V1.capability,
    sourceSha,
    properties: RESEARCH_TOURNAMENT_STAGE_CHECKPOINT_RESUME_CAPABILITY_V1.properties,
  };
  return deepFreeze({
    status: "AVAILABLE",
    ...core,
    evidenceId: `tournament-stage-checkpoint-resume:sha256:${digest(core)}`,
    reason: null,
  });
}
