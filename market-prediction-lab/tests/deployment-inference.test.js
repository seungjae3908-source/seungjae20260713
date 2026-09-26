import test from "node:test";
import assert from "node:assert/strict";
import { scoreToProbabilities } from "../src/rules.js";
import {
  blendDeployedProbabilities,
  DEPLOYED_INFERENCE_CONTRACT,
  DEPLOYED_MODEL_WEIGHT,
  DEPLOYED_RULE_WEIGHT,
  predictDeployedTinyModel,
} from "../src/deployment-inference.js";

const MODEL_PROBABILITIES = Object.freeze({ bullish: 0.8, neutral: 0.1, bearish: 0.1 });

test("deployed inference keeps the production 65/35 rule-model contract", () => {
  const rule = scoreToProbabilities(0);
  const result = blendDeployedProbabilities(0, MODEL_PROBABILITIES);
  assert.equal(DEPLOYED_RULE_WEIGHT, 0.65);
  assert.equal(DEPLOYED_MODEL_WEIGHT, 0.35);
  assert.equal(DEPLOYED_INFERENCE_CONTRACT, "deployed-rule-model-65-35");
  assert.ok(Math.abs(result.probabilities.bullish
    - ((rule.bullish * 0.65) + (MODEL_PROBABILITIES.bullish * 0.35))) < 1e-12);
  assert.ok(Math.abs(result.probabilities.neutral
    - ((rule.neutral * 0.65) + (MODEL_PROBABILITIES.neutral * 0.35))) < 1e-12);
  assert.ok(Math.abs(result.probabilities.bearish
    - ((rule.bearish * 0.65) + (MODEL_PROBABILITIES.bearish * 0.35))) < 1e-12);
});

test("deployment-parity prediction fails closed when ruleScore provenance is missing", () => {
  const model = Object.freeze({
    id: "fixture-model",
    trained: true,
    modelType: "multinomial-logistic-regression",
    featureOrder: Object.freeze(["x"]),
    temperature: 1,
    classes: Object.freeze({
      bullish: Object.freeze({ bias: 1, weights: Object.freeze([1]) }),
      neutral: Object.freeze({ bias: 0, weights: Object.freeze([0]) }),
      bearish: Object.freeze({ bias: -1, weights: Object.freeze([-1]) }),
    }),
  });
  assert.throws(
    () => predictDeployedTinyModel({ features: { x: 1 } }, model),
    /ruleScore is required/,
  );
});
