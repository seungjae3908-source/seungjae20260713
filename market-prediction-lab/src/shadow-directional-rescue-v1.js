import { createHash } from "node:crypto";
import {
  SHADOW_OBSERVATION_SCHEMA_VERSION,
  computeShadowObservationArtifactDigestV1,
} from "./shadow-evidence-handoff-v1.js";
import { sha256Canonical } from "./research-cache-provenance.js";

const ACTIONABLE = new Set(["LONG", "SHORT"]);
const DIRECTIONS = Object.freeze(["LONG", "NEUTRAL", "SHORT"]);
const FROZEN_RULE_WEIGHT = 0.65;
const FROZEN_MODEL_WEIGHT = 0.35;
const HASH_64 = /^[0-9a-f]{64}$/u;
const SHA_40 = /^[0-9a-f]{40}$/u;

export const SHADOW_DIRECTIONAL_RESCUE_IDENTITY_MAPPING_V1 = Object.freeze({
  strategyDigest: "observation.strategyIdentityDigest",
  datasetDigest: "observation.referenceIdentity.datasetDigest",
  modelDigest: "observation.modelIdentity.canonicalModelArtifactDigest",
  featureOrderDigest: "observation.referenceIdentity.featureOrderDigest",
  preprocessingVersion: "observation.referenceIdentity.preprocessingVersion",
  policyDigest: "policyFreeze.policyDigest",
  candidateIdentity: "observation.modelIdentityDigest",
  researchCodeSha: "observation.strategyIdentity.researchCodeSha",
  trainingArtifactIdentity: "observation.modelIdentity.trainingRunIdentityDigest",
  trainIdentity: "observation.referenceIdentity.trainSplitDigest",
  validationIdentity: "observation.referenceIdentity.validationSplitDigest",
});

const POLICY_CORE = Object.freeze({
  schemaVersion: 1,
  policyId: "shadow-rule-neutral-model-rescue-v1",
  timeframe: "15m",
  mode: "RESEARCH_ONLY",
  condition: "RULE_NEUTRAL_AND_MODEL_ACTIONABLE",
  action: "FOLLOW_MODEL_ELSE_PRESERVE_FROZEN_BLEND",
  frozenRuleWeight: FROZEN_RULE_WEIGHT,
  frozenModelWeight: FROZEN_MODEL_WEIGHT,
  newThresholds: 0,
  thresholdModified: false,
  labelModified: false,
  classWeightModified: false,
  blendWeightModified: false,
  modelModified: false,
  finalHoldoutOptimizationAllowed: false,
  historicalEvidenceUsedToSelectPolicy: true,
  historicalDataUsedForPolicySelection: true,
  historicalDataUsedForParameterSelection: false,
  historicalPromotionCredit: 0,
  preFreezePromotionCredit: 0,
  syntheticPromotionCredit: 0,
  replayPromotionCredit: 0,
  manualPromotionCredit: 0,
  profitabilityCredit: 0,
  prospectiveGenuineEvidenceRequired: true,
  modelCutoverAuthorized: false,
  scheduleMutationAuthorized: false,
  paperOrLiveAuthority: false,
});

export const SHADOW_DIRECTIONAL_RESCUE_POLICY_V1 = POLICY_CORE;
export const SHADOW_DIRECTIONAL_RESCUE_POLICY_V1_SHA256 = createHash("sha256")
  .update(JSON.stringify(POLICY_CORE))
  .digest("hex");

function normalizeDirection(value, label) {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (["LONG", "BULL", "BULLISH"].includes(normalized)) return "LONG";
  if (["SHORT", "BEAR", "BEARISH"].includes(normalized)) return "SHORT";
  if (["NEUTRAL", "FLAT", "NO_TRADE", "NO-TRADE"].includes(normalized)) return "NEUTRAL";
  throw new TypeError(`${label} must be LONG/NEUTRAL/SHORT`);
}

function digest(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return HASH_64.test(normalized) ? normalized : null;
}

function sha(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return SHA_40.test(normalized) ? normalized : null;
}

function iso(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function immutableHistoricalArtifactContext(diagnostic, context = {}) {
  const checkedAt = iso(context.checkedAt ?? new Date().toISOString());
  const createdAt = iso(context.createdAt);
  const expiresAt = iso(context.expiresAt);
  const workflowRunHead = sha(context.workflowRunHead);
  const sourceGeneratedHead = sha(diagnostic?.authenticatedEvidence?.sourceGeneratedHead);
  if (!checkedAt || !createdAt || !expiresAt) throw new Error("immutable Shadow artifact temporal context is required");
  if (Date.parse(createdAt) > Date.parse(checkedAt)) throw new Error("future-created Shadow artifact is forbidden");
  if (Date.parse(expiresAt) <= Date.parse(checkedAt)) throw new Error("stale or expired Shadow artifact is forbidden");
  if (!workflowRunHead || !sourceGeneratedHead) throw new Error("Shadow artifact carrier/source HEAD identity is invalid");
  if (!Number.isInteger(Number(diagnostic?.authenticatedEvidence?.workflowRunId))
      || !Number.isInteger(Number(diagnostic?.authenticatedEvidence?.artifactId))
      || !/^sha256:[0-9a-f]{64}$/u.test(String(diagnostic?.authenticatedEvidence?.artifactDigest ?? ""))) {
    throw new Error("immutable Shadow artifact identity is invalid");
  }
  return Object.freeze({
    workflowRunId: Number(diagnostic.authenticatedEvidence.workflowRunId),
    artifactId: Number(diagnostic.authenticatedEvidence.artifactId),
    artifactDigest: diagnostic.authenticatedEvidence.artifactDigest,
    workflowRunHead,
    sourceGeneratedHead,
    createdAt,
    expiresAt,
    checkedAt,
    immutable: true,
    temporalStatus: "VALID",
  });
}

export function selectShadowDirectionalRescueV1({ ruleDirection, modelDirection, blendDirection } = {}) {
  const rule = normalizeDirection(ruleDirection, "ruleDirection");
  const model = normalizeDirection(modelDirection, "modelDirection");
  const blend = normalizeDirection(blendDirection, "blendDirection");
  return rule === "NEUTRAL" && ACTIONABLE.has(model) ? model : blend;
}

function accuracy(quality) {
  if (!quality || !Number.isInteger(quality.settledN) || quality.settledN <= 0) return null;
  const matrix = quality.confusionMatrix;
  if (!matrix || typeof matrix !== "object") return null;
  const hits = DIRECTIONS.reduce((sum, name) => sum + (Number(matrix?.[name]?.[name]) || 0), 0);
  return hits / quality.settledN;
}

function delta(candidate, baseline) {
  return Number.isFinite(candidate) && Number.isFinite(baseline) ? candidate - baseline : null;
}

function recall(quality, direction) {
  const value = quality?.perClass?.[direction]?.recall;
  return Number.isFinite(value) ? value : null;
}

function comparison(candidateLane, blendLane) {
  const candidateQuality = candidateLane?.quality;
  const blendQuality = blendLane?.quality;
  return Object.freeze({
    accuracyDelta: delta(accuracy(candidateQuality), accuracy(blendQuality)),
    macroF1Delta: delta(candidateQuality?.macroF1, blendQuality?.macroF1),
    balancedAccuracyDelta: delta(candidateQuality?.balancedAccuracy, blendQuality?.balancedAccuracy),
    longRecallDelta: delta(recall(candidateQuality, "LONG"), recall(blendQuality, "LONG")),
    neutralRecallDelta: delta(recall(candidateQuality, "NEUTRAL"), recall(blendQuality, "NEUTRAL")),
    shortRecallDelta: delta(recall(candidateQuality, "SHORT"), recall(blendQuality, "SHORT")),
  });
}

function emptyFutureEvidence() {
  return Object.freeze({
    schemaVersion: 1,
    kind: "future-shadow-directional-rescue-evidence",
    status: "FUTURE_GENUINE_EVIDENCE_REQUIRED",
    reason: "NO_POST_FREEZE_GENUINE_OBSERVATIONS",
    identityChainState: "NOT_EVIDENCED_NO_FUTURE_OBSERVATIONS",
    counts: Object.freeze({
      "15m": Object.freeze({ TOTAL_N: 0, SETTLED_N: 0, PENDING_N: 0 }),
      "1h": Object.freeze({ TOTAL_N: 0, SETTLED_N: 0, PENDING_N: 0 }),
      SAME_CANDIDATE_MATCHED_N: 0,
    }),
    genuineSampleCredit: 0,
    historicalPromotionCredit: 0,
    preFreezePromotionCredit: 0,
    replayCredit: 0,
    syntheticCredit: 0,
    manualCredit: 0,
    profitabilityCredit: 0,
    promotionCredit: 0,
    psi: null,
    ks: null,
    jsd: null,
    strategyHealth: "NOT_EVALUABLE",
  });
}

function notEvaluable(reason, diagnostic, artifactContext = null) {
  return Object.freeze({
    schemaVersion: 1,
    kind: "shadow-15m-directional-rescue-candidate",
    status: "NOT_EVALUABLE",
    reason,
    policy: SHADOW_DIRECTIONAL_RESCUE_POLICY_V1,
    policySha256: SHADOW_DIRECTIONAL_RESCUE_POLICY_V1_SHA256,
    sourceArtifact: Object.freeze({
      workflowRunId: diagnostic?.authenticatedEvidence?.workflowRunId ?? null,
      artifactId: diagnostic?.authenticatedEvidence?.artifactId ?? null,
      artifactDigest: diagnostic?.authenticatedEvidence?.artifactDigest ?? null,
      researchCodeSha: diagnostic?.authenticatedEvidence?.researchCodeSha ?? null,
      authentication: artifactContext,
    }),
    historicalEvaluation: null,
    promotionCredit: 0,
    profitabilityCredit: 0,
    prospectiveGate: Object.freeze({
      status: "REQUIRES_POLICY_FREEZE_AND_FUTURE_GENUINE_COHORT",
      policyFreezeSha: null,
      earliestEligibleObservationAt: null,
      historicalSamplesEligible: 0,
      preFreezeSamplesEligible: 0,
      replaySamplesEligible: 0,
      syntheticSamplesEligible: 0,
      manualSamplesEligible: 0,
    }),
    futureEvidence: emptyFutureEvidence(),
  });
}

export function buildShadowDirectionalRescueCandidateV1(diagnostic, artifactContextInput) {
  if (!diagnostic || typeof diagnostic !== "object") throw new TypeError("authenticated diagnostic is required");
  if (diagnostic.kind !== "authenticated-shadow-15m-blend-collapse-diagnostic") {
    throw new Error("directional rescue requires authenticated 15m Shadow evidence");
  }
  if (diagnostic.declaredBlendWeights?.rule !== FROZEN_RULE_WEIGHT
      || diagnostic.declaredBlendWeights?.model !== FROZEN_MODEL_WEIGHT) {
    throw new Error("frozen 65/35 Blend identity mismatch");
  }
  const artifactContext = immutableHistoricalArtifactContext(diagnostic, artifactContextInput);
  if (diagnostic.authenticatedEvidence?.exactBlendParity !== true) {
    return notEvaluable("EXACT_BLEND_PARITY_NOT_PROVEN", diagnostic, artifactContext);
  }
  if (diagnostic.mechanicalRootCause?.P1_1_MECHANICAL_ROOT_CAUSE_PROVEN !== true) {
    return notEvaluable("MECHANICAL_ROOT_CAUSE_NOT_PROVEN", diagnostic, artifactContext);
  }

  const ruleNeutralN = diagnostic.mechanicalRootCause.ruleNeutralN;
  const ruleTotalN = diagnostic.mechanicalRootCause.ruleTotalN;
  if (!Number.isInteger(ruleNeutralN) || !Number.isInteger(ruleTotalN) || ruleTotalN <= 0 || ruleNeutralN !== ruleTotalN) {
    return notEvaluable("RULE_NOT_NEUTRAL_FOR_ENTIRE_AUTHENTICATED_COHORT", diagnostic, artifactContext);
  }
  if (!diagnostic.lanes?.model || !diagnostic.lanes?.blend) {
    return notEvaluable("MODEL_OR_BLEND_LANE_MISSING", diagnostic, artifactContext);
  }

  const rescueLane = diagnostic.lanes.model;
  return Object.freeze({
    schemaVersion: 1,
    kind: "shadow-15m-directional-rescue-candidate",
    status: "READY_FOR_PROSPECTIVE_FREEZE",
    reason: null,
    policy: SHADOW_DIRECTIONAL_RESCUE_POLICY_V1,
    policySha256: SHADOW_DIRECTIONAL_RESCUE_POLICY_V1_SHA256,
    sourceArtifact: Object.freeze({
      workflowRunId: diagnostic.authenticatedEvidence.workflowRunId,
      artifactId: diagnostic.authenticatedEvidence.artifactId,
      artifactDigest: diagnostic.authenticatedEvidence.artifactDigest,
      researchCodeSha: diagnostic.authenticatedEvidence.researchCodeSha,
      exactBlendParity: true,
      authentication: artifactContext,
    }),
    derivation: Object.freeze({
      mode: "EXACT_COUNTERFACTUAL_IDENTITY",
      proof: "WHEN_RULE_NEUTRAL_N_EQUALS_TOTAL_N_THE_POLICY_OUTPUT_EQUALS_STANDALONE_MODEL_LANE",
      ruleNeutralN,
      ruleTotalN,
      historicalDataUsedForPolicySelection: true,
      historicalDataUsedForParameterSelection: false,
      newParameterCount: 0,
    }),
    historicalEvaluation: Object.freeze({
      diagnosticOnly: true,
      promotionCredit: 0,
      profitabilityCredit: 0,
      rescue: rescueLane,
      frozenBlend: diagnostic.lanes.blend,
      comparisonVsFrozenBlend: comparison(rescueLane, diagnostic.lanes.blend),
    }),
    prospectiveGate: Object.freeze({
      status: "REQUIRES_POLICY_FREEZE_AND_FUTURE_GENUINE_COHORT",
      policyFreezeSha: null,
      earliestEligibleObservationAt: null,
      historicalSamplesEligible: 0,
      preFreezeSamplesEligible: 0,
      replaySamplesEligible: 0,
      syntheticSamplesEligible: 0,
      manualSamplesEligible: 0,
    }),
    safety: Object.freeze({
      researchOnly: true,
      deployedBlendChanged: false,
      thresholdChanged: false,
      labelChanged: false,
      classWeightChanged: false,
      modelChanged: false,
      executionAuthority: "NONE",
      modelCutoverAuthorized: false,
      scheduleMutationAuthorized: false,
      paperOrLiveAuthority: false,
    }),
    futureEvidence: emptyFutureEvidence(),
    promotionCredit: 0,
    profitabilityCredit: 0,
  });
}

function laneDirection(observation, laneName) {
  const lane = observation?.components?.[laneName];
  if (!lane || typeof lane !== "object") throw new Error(`${laneName} output is required`);
  const result = normalizeDirection(lane.finalDirection, `${laneName}.finalDirection`);
  const probabilities = lane.probabilities;
  if (!probabilities || typeof probabilities !== "object") throw new Error(`${laneName} probabilities are required`);
  const classes = [["bullish", "LONG"], ["neutral", "NEUTRAL"], ["bearish", "SHORT"]];
  if (classes.some(([name]) => typeof probabilities[name] !== "number" || !Number.isFinite(probabilities[name]) || probabilities[name] < 0 || probabilities[name] > 1)) {
    throw new Error(`${laneName} probabilities are invalid`);
  }
  const total = classes.reduce((sum, [name]) => sum + probabilities[name], 0);
  if (Math.abs(total - 1) > 1e-6) throw new Error(`${laneName} probabilities must sum to one`);
  const top = classes.reduce((best, item) => probabilities[item[0]] > probabilities[best[0]] ? item : best, classes[0])[1];
  if (top !== result) throw new Error(`${laneName} final direction mismatch`);
  return result;
}

function resolveObservationIdentity(observation, policyDigest) {
  const identity = {
    strategyDigest: digest(observation?.strategyIdentityDigest),
    datasetDigest: digest(observation?.referenceIdentity?.datasetDigest),
    modelDigest: digest(observation?.modelIdentity?.canonicalModelArtifactDigest),
    featureOrderDigest: digest(observation?.referenceIdentity?.featureOrderDigest),
    preprocessingVersion: String(observation?.referenceIdentity?.preprocessingVersion ?? "").trim() || null,
    policyDigest: digest(policyDigest),
    candidateIdentity: digest(observation?.modelIdentityDigest),
    researchCodeSha: sha(observation?.strategyIdentity?.researchCodeSha),
    trainingArtifactIdentity: digest(observation?.modelIdentity?.trainingRunIdentityDigest),
    trainIdentity: digest(observation?.referenceIdentity?.trainSplitDigest),
    validationIdentity: digest(observation?.referenceIdentity?.validationSplitDigest),
  };
  const missing = Object.entries(identity).filter(([, value]) => !value).map(([field]) => field);
  if (missing.length) throw new Error(`same-candidate identity missing: ${missing.join(",")}`);
  if (sha256Canonical(observation.strategyIdentity) !== identity.strategyDigest) throw new Error("strategy digest mismatch");
  if (sha256Canonical(observation.modelIdentity) !== identity.candidateIdentity) throw new Error("candidate identity mismatch");
  if (digest(observation.modelIdentity?.strategyIdentityDigest) !== identity.strategyDigest) throw new Error("model strategy digest mismatch");
  if (digest(observation.modelIdentity?.datasetIdentityDigest) !== identity.datasetDigest) throw new Error("model dataset digest mismatch");
  if (digest(observation.modelIdentity?.featureOrderDigest) !== identity.featureOrderDigest) throw new Error("model feature order mismatch");
  if (observation.modelIdentity?.preprocessingVersion !== identity.preprocessingVersion) throw new Error("model preprocessing mismatch");
  return Object.freeze(identity);
}

function assertExpectedIdentity(actual, expected) {
  if (!expected || typeof expected !== "object") throw new Error("expected same-candidate identity is required");
  for (const field of Object.keys(SHADOW_DIRECTIONAL_RESCUE_IDENTITY_MAPPING_V1)) {
    if (actual[field] !== expected[field]) throw new Error(`${field} mismatch`);
  }
}

function validateRuntimeEvidence(runtimeEvidence) {
  if (!runtimeEvidence || runtimeEvidence.trigger !== "schedule" || runtimeEvidence.sourceArtifactImmutable !== true
      || runtimeEvidence.publicationStatus !== "PUBLISHED" || !Number.isInteger(runtimeEvidence.workflowRunId)
      || runtimeEvidence.workflowRunId <= 0 || !digest(runtimeEvidence.artifactDigest)) {
    throw new Error("genuine scheduled immutable Shadow runtime publication is required");
  }
}

function validateCreditFlags(observation) {
  const source = observation?.sourceProvenance;
  const credit = observation?.creditEligibility;
  if (source?.sourceKind !== "GENUINE_SHADOW_OBSERVATION" || source.capturedAtObservationTime !== true
      || source.reconstructed !== false || source.synthetic !== false || source.replayed !== false
      || source.historicalBackfill !== false || credit?.genuineFuture !== true || credit.duplicate !== false
      || credit.replay !== false || credit.synthetic !== false || credit.historicalBackfill !== false
      || credit.hindsightReconstruction !== false) {
    throw new Error("historical/replay/manual/synthetic Shadow credit is forbidden");
  }
}

export function buildFutureShadowDirectionalRescueEvidenceV1({
  observations = [],
  policyFreeze = null,
  expectedIdentity = null,
  runtimeEvidence = null,
} = {}) {
  if (!Array.isArray(observations)) throw new TypeError("future observations must be an array");
  if (!observations.length) return emptyFutureEvidence();
  const frozenAt = iso(policyFreeze?.policyFrozenAt);
  if (!frozenAt || digest(policyFreeze?.policyDigest) !== SHADOW_DIRECTIONAL_RESCUE_POLICY_V1_SHA256
      || policyFreeze?.historicalEvidenceUsedToSelectPolicy !== true
      || policyFreeze?.historicalDataUsedForPolicySelection !== true
      || policyFreeze?.historicalDataUsedForParameterSelection !== false) {
    throw new Error("exact immutable directional-rescue policy freeze is required");
  }
  validateRuntimeEvidence(runtimeEvidence);
  const ids = new Set();
  const artifactDigests = new Set();
  const counts = {
    "15m": { TOTAL_N: 0, SETTLED_N: 0, PENDING_N: 0 },
    "1h": { TOTAL_N: 0, SETTLED_N: 0, PENDING_N: 0 },
  };
  const accepted = [];
  for (const observation of observations) {
    if (observation?.schemaVersion !== SHADOW_OBSERVATION_SCHEMA_VERSION) throw new Error("canonical future Shadow observation is required");
    if (!Object.hasOwn(counts, observation.timeframe)) throw new Error("future Shadow timeframe must be 15m or 1h");
    if (!digest(observation.artifactDigest) || observation.artifactDigest !== computeShadowObservationArtifactDigestV1(observation)) {
      throw new Error("future Shadow observation artifact digest mismatch");
    }
    if (ids.has(observation.observationId) || artifactDigests.has(observation.artifactDigest)) throw new Error("duplicate future Shadow observation");
    const observedAt = iso(observation.observedAt);
    if (!observedAt || Date.parse(observedAt) <= Date.parse(frozenAt)) throw new Error("pre-freeze Shadow observation is forbidden");
    validateCreditFlags(observation);
    const identity = resolveObservationIdentity(observation, policyFreeze.policyDigest);
    assertExpectedIdentity(identity, expectedIdentity?.[observation.timeframe] ?? expectedIdentity);
    const ruleDirection = laneDirection(observation, "RULE_ONLY");
    const modelDirection = laneDirection(observation, "MODEL_ONLY");
    const blendDirection = laneDirection(observation, "DEPLOYED_FROZEN_BLEND");
    const weights = observation.components.DEPLOYED_FROZEN_BLEND.weights;
    if (weights?.rule !== FROZEN_RULE_WEIGHT || weights?.model !== FROZEN_MODEL_WEIGHT) throw new Error("frozen Blend parity mismatch");
    const challengerDirection = selectShadowDirectionalRescueV1({ ruleDirection, modelDirection, blendDirection });
    const settled = observation.settlementStatus === "SETTLED";
    if (settled) {
      const outcomeAt = iso(observation.settlement?.horizon?.outcomeAt);
      const settledAt = iso(observation.settlement?.settledAt);
      if (!outcomeAt || !settledAt || Date.parse(outcomeAt) <= Date.parse(observedAt)
          || Date.parse(settledAt) < Date.parse(outcomeAt)
          || observation.settlement?.sourceProvenance?.sourceKind !== "GENUINE_FUTURE_SHADOW_OUTCOME"
          || observation.settlement.sourceProvenance.capturedAfterObservation !== true
          || observation.settlement.sourceProvenance.reconstructed !== false
          || observation.settlement.sourceProvenance.synthetic !== false
          || observation.settlement.sourceProvenance.replayed !== false
          || observation.settlement.sourceProvenance.historicalBackfill !== false) {
        throw new Error("settled future horizon evidence is invalid");
      }
    } else if (observation.settlementStatus !== "PENDING_SETTLEMENT" || observation.settlement !== null) {
      throw new Error("future Shadow settlement status is invalid");
    }
    ids.add(observation.observationId);
    artifactDigests.add(observation.artifactDigest);
    counts[observation.timeframe].TOTAL_N += 1;
    counts[observation.timeframe][settled ? "SETTLED_N" : "PENDING_N"] += 1;
    accepted.push(Object.freeze({
      observationId: observation.observationId,
      artifactDigest: observation.artifactDigest,
      timeframe: observation.timeframe,
      settlementStatus: observation.settlementStatus,
      identity,
      laneIdentity: Object.freeze({
        RULE_ONLY: identity,
        MODEL_ONLY: identity,
        DEPLOYED_FROZEN_BLEND: identity,
        DIRECTIONAL_RESCUE_CHALLENGER: identity,
      }),
      outputs: Object.freeze({ ruleDirection, modelDirection, blendDirection, challengerDirection }),
    }));
  }
  const settledMatchedN = counts["15m"].SETTLED_N + counts["1h"].SETTLED_N;
  return Object.freeze({
    schemaVersion: 1,
    kind: "future-shadow-directional-rescue-evidence",
    status: settledMatchedN ? "GENUINE_POST_FREEZE_EVIDENCE_PRESENT" : "PENDING_SETTLEMENT",
    reason: settledMatchedN ? null : "SETTLED_HORIZON_NOT_YET_AVAILABLE",
    policyFreeze: Object.freeze({ policyDigest: policyFreeze.policyDigest, policyFrozenAt: frozenAt }),
    runtimeEvidence: Object.freeze({ ...runtimeEvidence }),
    identityChainState: "SAME_CANDIDATE_FULLY_PROVEN",
    identityMapping: SHADOW_DIRECTIONAL_RESCUE_IDENTITY_MAPPING_V1,
    observations: Object.freeze(accepted),
    counts: Object.freeze({
      "15m": Object.freeze(counts["15m"]),
      "1h": Object.freeze(counts["1h"]),
      SAME_CANDIDATE_MATCHED_N: accepted.length,
    }),
    genuineSampleCredit: settledMatchedN,
    historicalPromotionCredit: 0,
    preFreezePromotionCredit: 0,
    replayCredit: 0,
    syntheticCredit: 0,
    manualCredit: 0,
    profitabilityCredit: 0,
    promotionCredit: 0,
    psi: null,
    ks: null,
    jsd: null,
    strategyHealth: "NOT_EVALUABLE",
    safety: Object.freeze({
      LIVE_TRADING: false,
      AUTO_TRADING: false,
      REAL_ORDER_ENABLED: false,
      PRIVATE_TRADING_API_ALLOWED: false,
      executionAuthority: "NONE",
      modelCutoverAuthorized: false,
      scheduleMutationAuthorized: false,
    }),
  });
}
