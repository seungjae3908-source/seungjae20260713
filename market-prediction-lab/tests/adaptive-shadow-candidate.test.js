import test from "node:test";
import assert from "node:assert/strict";
import { BASELINE_MODEL } from "../src/tiny-model.js";
import {
  buildAdaptiveShadowCandidate,
  evaluateModelRecords,
  evaluatePredictionHealth,
} from "../src/adaptive-shadow-candidate.js";

function neutralModel(id = "neutral-v1") {
  return Object.freeze({
    id,
    trained: true,
    modelType: "multinomial-logistic-regression",
    featureOrder: Object.freeze(["return5"]),
    temperature: 1,
    classes: Object.freeze({
      bullish: Object.freeze({ bias: -2, weights: Object.freeze([0]) }),
      neutral: Object.freeze({ bias: 2, weights: Object.freeze([0]) }),
      bearish: Object.freeze({ bias: -2, weights: Object.freeze([0]) }),
    }),
  });
}

function features(direction, index) {
  const sign = direction === "bullish" ? 1 : direction === "bearish" ? -1 : 0;
  const magnitude = direction === "neutral" ? 0.0001 : 0.04 + (index % 5) * 0.003;
  return Object.freeze({
    return5: sign * magnitude,
    return20: sign * magnitude * 0.8,
    emaGap: sign * 0.01,
    rsiCentered: sign * 0.3,
    macdHistogramPct: sign * 0.001,
    atrPct: 0.008,
    volumeRatio: 1,
    trendSlope: sign * 0.002,
    sentimentScore: 0,
    benchmarkReturn: sign * 0.01,
    foreignNetRatio: 0,
    institutionNetRatio: 0,
    openInterestChange: 0,
    fundingRate: 0,
    longShortBias: 0,
  });
}

function state(count, modelId = "neutral-v1", { directionalRules = false } = {}) {
  const directions = ["bullish", "neutral", "bearish"];
  return {
    records: Array.from({ length: count }, (_, index) => {
      const actualDirection = directions[index % directions.length];
      const ruleScore = directionalRules
        ? actualDirection === "bullish" ? 20 : actualDirection === "bearish" ? -20 : 0
        : 0;
      return Object.freeze({
        status: "settled",
        modelId,
        referenceModelId: BASELINE_MODEL.id,
        symbol: index % 2 === 0 ? "BTCUSDT" : "ETHUSDT",
        anchorTimestamp: 1_700_000_000_000 + index * 60_000,
        actualDirection,
        ruleScore,
        features: features(actualDirection, index),
      });
    }),
  };
}

test("health flags dominant neutral collapse and zero directional recall on deployed inference", () => {
  const metrics = evaluateModelRecords(state(60).records, neutralModel());
  const health = evaluatePredictionHealth(metrics);
  assert.equal(health.collapsed, true);
  assert.equal(health.dominantClass, "neutral");
  assert.ok(health.dominantShare > 0.9);
  assert.ok(health.reasons.includes("directional_recall_collapse"));
});

test("adaptive evaluation fails closed without ruleScore provenance", () => {
  const records = state(10).records.map(({ ruleScore: _ruleScore, ...record }) => record);
  assert.throws(() => evaluateModelRecords(records, neutralModel()), /ruleScore is required/);
});

test("adaptive candidate waits for enough settled live samples", () => {
  const result = buildAdaptiveShadowCandidate({
    group: "crypto-futures-15m",
    state: state(30),
    referenceArtifact: { model: neutralModel() },
    minSettled: 60,
  });
  assert.equal(result.status, "research_hold");
  assert.equal(result.reason, "insufficient_live_shadow_samples");
  assert.equal(result.settled, 30);
});

test("adaptive blend uses chronological holdout with the deployed rule-model contract", () => {
  const result = buildAdaptiveShadowCandidate({
    group: "crypto-futures-15m",
    state: state(120, "neutral-v1", { directionalRules: true }),
    referenceArtifact: { model: neutralModel() },
    minSettled: 90,
    minCalibration: 60,
    minHoldout: 24,
  });
  assert.equal(result.safety.chronologicalSplit, true);
  assert.equal(result.diagnostics?.selection?.inferenceContract, "deployed-rule-model-65-35");
  if (result.status === "shadow_candidate_v2") {
    assert.equal(result.diagnostics.holdout.candidateHealth.collapsed, false);
    assert.ok(result.diagnostics.holdout.comparison.macroF1Delta > 0.02);
    assert.ok(result.diagnostics.selection.baselineWeight > 0);
  } else {
    assert.equal(result.status, "research_hold");
    assert.ok(["adaptive_candidate_gates_failed", "no_non_collapsed_blend_found"].includes(result.reason));
  }
});
