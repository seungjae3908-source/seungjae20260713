import test from "node:test";
import assert from "node:assert/strict";
import { summarizeShadowSourceHealth } from "../src/shadow-source-health.js";

const MODEL = Object.freeze({
  id: "candidate-v1",
  featureOrder: Object.freeze(["atrPct", "return5"]),
  normalization: Object.freeze({ mean: Object.freeze([0.01, 0]), scale: Object.freeze([0.005, 0.01]) }),
});

function record(index, actualDirection, candidateClass, atrPct = 0.002) {
  return {
    status: "settled",
    modelId: MODEL.id,
    symbol: index % 2 === 0 ? "BTCUSDT" : "ETHUSDT",
    anchorTimestamp: 1_000 + index,
    actualDirection,
    candidateClass,
    features: { atrPct, return5: 0.001 },
  };
}

test("source health exposes label-vs-prediction collapse and feature mean shift", () => {
  const records = [];
  for (let index = 0; index < 5; index += 1) records.push(record(index, "bullish", "neutral"));
  for (let index = 5; index < 20; index += 1) records.push(record(index, "neutral", "neutral"));
  for (let index = 20; index < 25; index += 1) records.push(record(index, "bearish", "neutral"));

  const health = summarizeShadowSourceHealth({ state: { records }, model: MODEL });
  assert.equal(health.sampleCount, 25);
  assert.equal(health.status, "MODEL_DEGENERATE");
  assert.equal(health.dominantClass, "neutral");
  assert.equal(health.dominantShare, 1);
  assert.deepEqual(health.actualCounts, { bullish: 5, neutral: 15, bearish: 5 });
  assert.deepEqual(health.predictedCounts, { bullish: 0, neutral: 25, bearish: 0 });
  assert.ok(health.reasons.includes("dominant_prediction_share:neutral"));
  assert.ok(health.reasons.includes("directional_recall_collapse"));
  assert.equal(health.featureMeanShift.available, true);
  const atr = health.featureMeanShift.features.find((row) => row.feature === "atrPct");
  assert.ok(atr.absMeanZ > 1.5);
});

test("collapse gate stays inconclusive before minimum live sample count", () => {
  const records = Array.from({ length: 10 }, (_, index) => record(index, "neutral", "neutral"));
  const health = summarizeShadowSourceHealth({ state: { records }, model: MODEL });
  assert.equal(health.status, "INSUFFICIENT_SAMPLE");
  assert.equal(health.collapsed, false);
  assert.equal(health.dominantShare, 1);
});

test("mixed predictions are not marked as class collapse", () => {
  const directions = ["bullish", "neutral", "bearish"];
  const records = Array.from({ length: 30 }, (_, index) => {
    const direction = directions[index % directions.length];
    return record(index, direction, direction, 0.01);
  });
  const health = summarizeShadowSourceHealth({ state: { records }, model: MODEL });
  assert.equal(health.status, "HEALTHY_OR_UNPROVEN");
  assert.equal(health.collapsed, false);
  assert.ok(health.dominantShare < 0.8);
});
