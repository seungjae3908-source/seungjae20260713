import { createHash } from "node:crypto";

const ACTIONABLE = new Set(["LONG", "SHORT"]);
const DIRECTIONS = Object.freeze(["LONG", "NEUTRAL", "SHORT"]);
const FROZEN_RULE_WEIGHT = 0.65;
const FROZEN_MODEL_WEIGHT = 0.35;

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
  historicalPromotionCredit: 0,
  syntheticPromotionCredit: 0,
  replayPromotionCredit: 0,
  profitabilityCredit: 0,
  prospectiveGenuineEvidenceRequired: true,
});

export const SHADOW_DIRECTIONAL_RESCUE_POLICY_V1 = POLICY_CORE;
export const SHADOW_DIRECTIONAL_RESCUE_POLICY_V1_SHA256 = createHash("sha256")
  .update(JSON.stringify(POLICY_CORE))
  .digest("hex");

function normalizeDirection(value, label) {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (!DIRECTIONS.includes(normalized)) throw new TypeError(`${label} must be LONG/NEUTRAL/SHORT`);
  return normalized;
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

function notEvaluable(reason, diagnostic) {
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
    }),
    historicalEvaluation: null,
    promotionCredit: 0,
    profitabilityCredit: 0,
    prospectiveGate: Object.freeze({
      status: "REQUIRES_POLICY_FREEZE_AND_FUTURE_GENUINE_COHORT",
      policyFreezeSha: null,
      earliestEligibleObservationAt: null,
    }),
  });
}

export function buildShadowDirectionalRescueCandidateV1(diagnostic) {
  if (!diagnostic || typeof diagnostic !== "object") throw new TypeError("authenticated diagnostic is required");
  if (diagnostic.kind !== "authenticated-shadow-15m-blend-collapse-diagnostic") {
    throw new Error("directional rescue requires authenticated 15m Shadow evidence");
  }
  if (diagnostic.declaredBlendWeights?.rule !== FROZEN_RULE_WEIGHT
      || diagnostic.declaredBlendWeights?.model !== FROZEN_MODEL_WEIGHT) {
    throw new Error("frozen 65/35 Blend identity mismatch");
  }
  if (diagnostic.authenticatedEvidence?.exactBlendParity !== true) {
    return notEvaluable("EXACT_BLEND_PARITY_NOT_PROVEN", diagnostic);
  }
  if (diagnostic.mechanicalRootCause?.P1_1_MECHANICAL_ROOT_CAUSE_PROVEN !== true) {
    return notEvaluable("MECHANICAL_ROOT_CAUSE_NOT_PROVEN", diagnostic);
  }

  const ruleNeutralN = diagnostic.mechanicalRootCause.ruleNeutralN;
  const ruleTotalN = diagnostic.mechanicalRootCause.ruleTotalN;
  if (!Number.isInteger(ruleNeutralN) || !Number.isInteger(ruleTotalN) || ruleTotalN <= 0 || ruleNeutralN !== ruleTotalN) {
    return notEvaluable("RULE_NOT_NEUTRAL_FOR_ENTIRE_AUTHENTICATED_COHORT", diagnostic);
  }
  if (!diagnostic.lanes?.model || !diagnostic.lanes?.blend) {
    return notEvaluable("MODEL_OR_BLEND_LANE_MISSING", diagnostic);
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
      replaySamplesEligible: 0,
      syntheticSamplesEligible: 0,
    }),
    safety: Object.freeze({
      researchOnly: true,
      deployedBlendChanged: false,
      thresholdChanged: false,
      labelChanged: false,
      classWeightChanged: false,
      modelChanged: false,
      executionAuthority: "NONE",
    }),
    promotionCredit: 0,
    profitabilityCredit: 0,
  });
}
