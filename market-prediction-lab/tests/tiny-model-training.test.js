import test from "node:test";
import assert from "node:assert/strict";
import { predictTinyModel, BASELINE_MODEL } from "../src/tiny-model.js";
import {
  calibrateTemperature,
  compareCandidateToBaseline,
  evaluateRawTinyModel,
  evaluateStoredBaseline,
  evaluateTinyModel,
  fitFeatureNormalization,
  trainTinySoftmaxModel,
} from "../src/tiny-model-training.js";

const FEATURE_ORDER = Object.freeze(["x", "y", "noise"]);
const DIRECTIONS = Object.freeze(["bullish", "neutral", "bearish"]);

function syntheticRecords(count = 360) {
  return Array.from({ length: count }, (_, index) => {
    const classIndex = index % 3;
    const direction = DIRECTIONS[classIndex];
    const x = classIndex === 0 ? 2 + ((index % 7) / 10)
      : classIndex === 2 ? -2 - ((index % 7) / 10)
        : ((index % 5) - 2) / 20;
    const y = classIndex === 1 ? 1.5 + ((index % 3) / 10) : ((index % 5) - 2) / 10;
    const ruleScore = direction === "bullish" ? 60 : direction === "bearish" ? -60 : 0;
    return Object.freeze({
      features: Object.freeze({ x, y, noise: Math.sin(index) * 0.03 }),
      ruleScore,
      label: Object.freeze({ direction }),
      probabilities: Object.freeze({ bullish: 1 / 3, neutral: 1 / 3, bearish: 1 / 3 }),
    });
  });
}

test("baseline model remains compatible without normalization", () => {
  const result = predictTinyModel(Object.fromEntries(BASELINE_MODEL.featureOrder.map((key) => [key, 0])), BASELINE_MODEL);
  const total = Object.values(result.probabilities).reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(total - 1) < 1e-8);
  assert.equal(result.trained, false);
});

test("feature normalization uses training records and remains finite", () => {
  const normalization = fitFeatureNormalization(syntheticRecords(90), FEATURE_ORDER);
  assert.equal(normalization.mean.length, FEATURE_ORDER.length);
  assert.equal(normalization.scale.length, FEATURE_ORDER.length);
  assert.ok(normalization.mean.every(Number.isFinite));
  assert.ok(normalization.scale.every((value) => Number.isFinite(value) && value > 0));
});

test("softmax trainer, deployed-path calibration and test evaluation are deterministic", () => {
  const records = syntheticRecords();
  const train = records.slice(0, 216);
  const validation = records.slice(216, 288);
  const heldOutTest = records.slice(288);
  const first = trainTinySoftmaxModel(train, { featureOrder: FEATURE_ORDER, id: "synthetic-v1", epochs: 500 });
  const second = trainTinySoftmaxModel(train, { featureOrder: FEATURE_ORDER, id: "synthetic-v1", epochs: 500 });
  assert.deepEqual(first.classes, second.classes);
  assert.deepEqual(first.normalization, second.normalization);

  const calibrated = calibrateTemperature(validation, first);
  const baseline = evaluateStoredBaseline(heldOutTest);
  const candidate = evaluateTinyModel(heldOutTest, calibrated);
  const rawCandidate = evaluateRawTinyModel(heldOutTest, calibrated);
  assert.ok(candidate.accuracy > 0.95);
  assert.ok(rawCandidate.accuracy > 0.95);
  assert.ok(candidate.logLoss < baseline.logLoss);
  assert.equal(compareCandidateToBaseline(baseline, candidate).promoted, true);
  assert.equal(calibrated.calibration.inferenceContract, "deployed-rule-model-65-35");
  assert.ok(calibrated.temperature >= 0.5 && calibrated.temperature <= 3);
});

test("candidate evaluation fails closed rather than silently dropping the deployed rule layer", () => {
  const records = syntheticRecords(90).map(({ ruleScore: _ruleScore, ...record }) => record);
  const model = trainTinySoftmaxModel(syntheticRecords(90), { featureOrder: FEATURE_ORDER, epochs: 120 });
  assert.throws(() => evaluateTinyModel(records, model), /ruleScore is required/);
  assert.doesNotThrow(() => evaluateRawTinyModel(records, model));
});

test("trainer rejects datasets missing one of the three classes", () => {
  const records = syntheticRecords(180).filter((record) => record.label.direction !== "neutral");
  assert.ok(records.length >= 90);
  assert.throws(() => trainTinySoftmaxModel(records, { featureOrder: FEATURE_ORDER }), /all three classes/);
});

test("promotion policy holds a candidate when probability quality regresses", () => {
  const baseline = { logLoss: 0.8, macroF1: 0.5, accuracy: 0.55 };
  const candidate = { logLoss: 0.9, macroF1: 0.48, accuracy: 0.54 };
  const comparison = compareCandidateToBaseline(baseline, candidate);
  assert.equal(comparison.promoted, false);
  assert.ok(comparison.reasons.includes("log_loss_improvement_insufficient"));
});
