import test from "node:test";
import assert from "node:assert/strict";
import { predictTinyModel } from "../src/tiny-model.js";
import { buildProbabilityEnsemble, selectProbabilityEnsemble } from "../src/model-ensemble.js";

function model(id, bullishWeight, bearishWeight) {
  return Object.freeze({
    id,
    trained: true,
    modelType: "multinomial-logistic-regression",
    featureOrder: Object.freeze(["x"]),
    temperature: 1,
    classes: Object.freeze({
      bullish: Object.freeze({ bias: 0, weights: Object.freeze([bullishWeight]) }),
      neutral: Object.freeze({ bias: 0.1, weights: Object.freeze([0]) }),
      bearish: Object.freeze({ bias: 0, weights: Object.freeze([bearishWeight]) }),
    }),
  });
}

const reference = model("reference", 1.8, -1.8);
const alternate = model("alternate", 2.5, -2.5);

function records(count = 120) {
  return Array.from({ length: count }, (_, index) => {
    const x = ((index % 20) - 10) / 5;
    const direction = x > 0.3 ? "bullish" : x < -0.3 ? "bearish" : "neutral";
    const ruleScore = direction === "bullish" ? 45 : direction === "bearish" ? -45 : 0;
    return Object.freeze({
      features: Object.freeze({ x }),
      ruleScore,
      label: Object.freeze({ direction }),
    });
  });
}

test("ensemble prediction is normalized and deterministic", () => {
  const ensemble = buildProbabilityEnsemble({
    id: "ensemble-v1",
    referenceModel: reference,
    alternateModel: alternate,
    alternateWeight: 0.35,
    temperature: 0.9,
  });
  const first = predictTinyModel({ x: 1 }, ensemble);
  const second = predictTinyModel({ x: 1 }, ensemble);
  assert.deepEqual(first, second);
  const total = Object.values(first.probabilities).reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(total - 1) < 1e-8);
  assert.equal(first.modelId, "ensemble-v1");
});

test("validation-only selector returns a bounded reproducible deployed-path blend", () => {
  const first = selectProbabilityEnsemble(records(), {
    id: "selected-ensemble",
    referenceModel: reference,
    alternateModel: alternate,
    weightStep: 0.1,
    minTemperature: 0.5,
    maxTemperature: 2,
    temperatureStep: 0.1,
  });
  const second = selectProbabilityEnsemble(records(), {
    id: "selected-ensemble",
    referenceModel: reference,
    alternateModel: alternate,
    weightStep: 0.1,
    minTemperature: 0.5,
    maxTemperature: 2,
    temperatureStep: 0.1,
  });
  assert.deepEqual(first.selection, second.selection);
  assert.ok(first.selection.alternateWeight >= 0 && first.selection.alternateWeight <= 1);
  assert.ok(first.selection.temperature >= 0.5 && first.selection.temperature <= 2);
  assert.equal(first.model.modelType, "probability-ensemble");
});

test("ensemble validation fails closed when deployed rule provenance is missing", () => {
  const withoutRuleScore = records().map(({ ruleScore: _ruleScore, ...record }) => record);
  assert.throws(() => selectProbabilityEnsemble(withoutRuleScore, {
    id: "missing-rule-score",
    referenceModel: reference,
    alternateModel: alternate,
  }), /ruleScore is required/);
});

test("ensemble rejects invalid or recursively deep definitions", () => {
  assert.throws(() => buildProbabilityEnsemble({
    id: "bad",
    referenceModel: reference,
    alternateModel: alternate,
    alternateWeight: 1.5,
  }), /alternateWeight/);
  const nested1 = buildProbabilityEnsemble({ id: "nested1", referenceModel: reference, alternateModel: alternate, alternateWeight: 0.5 });
  const nested2 = buildProbabilityEnsemble({ id: "nested2", referenceModel: nested1, alternateModel: alternate, alternateWeight: 0.5 });
  const nested3 = buildProbabilityEnsemble({ id: "nested3", referenceModel: nested2, alternateModel: alternate, alternateWeight: 0.5 });
  const nested4 = buildProbabilityEnsemble({ id: "nested4", referenceModel: nested3, alternateModel: alternate, alternateWeight: 0.5 });
  const nested5 = buildProbabilityEnsemble({ id: "nested5", referenceModel: nested4, alternateModel: alternate, alternateWeight: 0.5 });
  assert.throws(() => predictTinyModel({ x: 1 }, nested5), /nesting is too deep/);
});
