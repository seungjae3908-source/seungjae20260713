import { createHash } from "node:crypto";
import { predictRuleModelBlend } from "./rule-model-blend-challenger.js";

export const RULE_MODEL_1H_CHALLENGER_GROUP = "crypto-futures-1h-rule0-forward";
export const RULE_MODEL_1H_CHALLENGER_WEIGHT = 0;
export const RULE_MODEL_1H_REFERENCE_WEIGHT = 0.65;

function stableModelHash(model) {
  return createHash("sha256").update(JSON.stringify(model)).digest("hex");
}

export function verifyFrozenShadowChallengerModel(artifact) {
  if (!artifact || artifact.status !== "frozen_shadow_challenger_model") {
    throw new TypeError("frozen shadow challenger artifact is required");
  }
  if (artifact.group !== "crypto-futures-1h") throw new Error("only crypto-futures-1h is allowed");
  if (artifact.ruleWeight !== RULE_MODEL_1H_CHALLENGER_WEIGHT
      || artifact.referenceRuleWeight !== RULE_MODEL_1H_REFERENCE_WEIGHT) {
    throw new Error("frozen rule-weight contract mismatch");
  }
  if (!artifact.model?.trained || typeof artifact.model.id !== "string") throw new Error("trained frozen model is required");
  const actualSha256 = stableModelHash(artifact.model);
  if (actualSha256 !== artifact.provenance?.modelObjectSha256) {
    throw new Error("frozen model object SHA-256 mismatch");
  }
  if (artifact.safety?.historicalBackfillAllowed !== false
      || artifact.safety?.runtimeReplacement !== false
      || artifact.safety?.liveAuthority !== false
      || artifact.safety?.promotionAuthority !== false) {
    throw new Error("unsafe frozen challenger safety flags");
  }
  return Object.freeze({ model: artifact.model, modelObjectSha256: actualSha256 });
}

export function buildRuleModelShadowPair({ features, ruleScore, model }) {
  const challenger = predictRuleModelBlend({ features, ruleScore }, model, RULE_MODEL_1H_CHALLENGER_WEIGHT);
  const reference = predictRuleModelBlend({ features, ruleScore }, model, RULE_MODEL_1H_REFERENCE_WEIGHT);
  return Object.freeze({
    challengerProbabilities: challenger.probabilities,
    referenceProbabilities: reference.probabilities,
    challengerModelId: `${model.id}:rule-0.00`,
    referenceModelId: `${model.id}:rule-0.65`,
  });
}

export function assertForwardOnlyChallengerState(state) {
  if (!state || typeof state !== "object") throw new TypeError("challenger state is required");
  if (!Number.isInteger(state.challengerStartedAt) || state.challengerStartedAt <= 0) {
    throw new TypeError("challengerStartedAt is required");
  }
  for (const record of state.records ?? []) {
    if (!Number.isInteger(record.anchorTimestamp) || record.anchorTimestamp < state.challengerStartedAt) {
      throw new Error("historical challenger backfill is forbidden");
    }
    if (record.modelGroup !== RULE_MODEL_1H_CHALLENGER_GROUP || record.timeframe !== "1h") {
      throw new Error("challenger state contains an unexpected model group or timeframe");
    }
  }
  return state;
}

function directionalRecallAverage(metrics) {
  if (!metrics?.perClass) return null;
  return ((metrics.perClass.bullish?.recall ?? 0) + (metrics.perClass.bearish?.recall ?? 0)) / 2;
}

export function evaluateRuleModelShadowChallenger(summary, {
  minSettled = 300,
  minPerSymbol = 100,
  minElapsedMs = 28 * 24 * 60 * 60 * 1000,
  minRegimeSamples = 30,
  minQualifiedRegimes = 2,
} = {}) {
  if (!summary || typeof summary !== "object") throw new TypeError("summary is required");
  const reasons = [];
  if (summary.settled < minSettled) reasons.push("insufficient_settled_samples");
  if (!summary.firstAnchorTimestamp || !summary.lastAnchorTimestamp
      || summary.lastAnchorTimestamp - summary.firstAnchorTimestamp < minElapsedMs) {
    reasons.push("insufficient_elapsed_shadow_period");
  }
  const candidate = summary.candidate;
  const reference = summary.reference;
  if (!candidate || !reference) {
    reasons.push("no_settled_comparison");
  } else {
    const macroF1Delta = candidate.macroF1 - reference.macroF1;
    const balancedAccuracyDelta = candidate.balancedAccuracy - reference.balancedAccuracy;
    const accuracyDelta = candidate.accuracy - reference.accuracy;
    const logLossImprovement = reference.logLoss - candidate.logLoss;
    const directionalRecallDelta = directionalRecallAverage(candidate) - directionalRecallAverage(reference);
    if (macroF1Delta < 0.05) reasons.push("macro_f1_gain_below_gate");
    if (balancedAccuracyDelta < 0.03) reasons.push("balanced_accuracy_gain_below_gate");
    if (directionalRecallDelta < 0.03) reasons.push("directional_recall_gain_below_gate");
    if (accuracyDelta < -0.02) reasons.push("accuracy_regressed");
    if (logLossImprovement < 0) reasons.push("log_loss_regressed");
  }

  for (const [symbol, group] of Object.entries(summary.bySymbol ?? {})) {
    if ((group.candidate?.sampleCount ?? 0) < minPerSymbol) reasons.push(`${symbol}:insufficient_samples`);
    if (group.candidate && group.reference) {
      if (group.candidate.macroF1 < group.reference.macroF1) reasons.push(`${symbol}:macro_f1_regressed`);
      if (group.candidate.balancedAccuracy < group.reference.balancedAccuracy) reasons.push(`${symbol}:balanced_accuracy_regressed`);
      if (group.candidate.logLoss > group.reference.logLoss) reasons.push(`${symbol}:log_loss_regressed`);
    }
  }

  const qualifiedRegimes = Object.entries(summary.byRegime ?? {})
    .filter(([, group]) => (group.candidate?.sampleCount ?? 0) >= minRegimeSamples);
  if (qualifiedRegimes.length < minQualifiedRegimes) reasons.push("insufficient_regime_coverage");
  for (const [regime, group] of qualifiedRegimes) {
    if (group.candidate && group.reference) {
      if (group.candidate.macroF1 < group.reference.macroF1 - 0.02) reasons.push(`${regime}:macro_f1_regressed`);
      if (group.candidate.logLoss > group.reference.logLoss + 0.015) reasons.push(`${regime}:log_loss_regressed`);
    }
  }

  return Object.freeze({
    approved: reasons.length === 0,
    status: reasons.length === 0 ? "shadow_challenger_review_ready" : "shadow_challenger_continue",
    qualifiedRegimes: Object.freeze(qualifiedRegimes.map(([regime]) => regime)),
    reasons: Object.freeze([...new Set(reasons)]),
    safety: Object.freeze({
      promotionAuthority: false,
      liveAuthority: false,
      actualOrders: 0,
      privateAccountRequests: 0,
      runtimeReplacement: false,
    }),
  });
}
