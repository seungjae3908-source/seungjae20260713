import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRuleModelBlendChallenger,
  DEPLOYED_RULE_WEIGHT,
  evaluateRuleModelBlend,
} from "../src/rule-model-blend-challenger.js";

function model() {
  return Object.freeze({
    id: "directional-fixture-v1",
    trained: true,
    modelType: "multinomial-logistic-regression",
    featureOrder: Object.freeze(["x"]),
    temperature: 1,
    classes: Object.freeze({
      bullish: Object.freeze({ bias: -0.2, weights: Object.freeze([2]) }),
      neutral: Object.freeze({ bias: 1.1, weights: Object.freeze([0]) }),
      bearish: Object.freeze({ bias: -0.2, weights: Object.freeze([-2]) }),
    }),
  });
}

function records(count = 120) {
  const directions = ["bullish", "neutral", "bearish"];
  return Array.from({ length: count }, (_, index) => {
    const direction = directions[index % directions.length];
    const x = direction === "bullish" ? 1 : direction === "bearish" ? -1 : 0;
    return Object.freeze({
      features: Object.freeze({ x }),
      ruleScore: 0,
      label: Object.freeze({ direction }),
      anchorTimestamp: 1_700_000_000_000 + index * 60_000,
    });
  });
}

test("deployed 65% rule baseline is not silently changed", () => {
  const metrics = evaluateRuleModelBlend(records(90), model(), DEPLOYED_RULE_WEIGHT);
  assert.equal(metrics.ruleWeight, 0.65);
  assert.equal(metrics.modelWeight, 0.35);
  assert.ok(metrics.predictedShares.neutral > 0.9);
});

test("challenger selects weight on validation only and gates on untouched test", () => {
  const validation = records(120);
  const untouchedTest = records(120).map((record, index) => Object.freeze({
    ...record,
    anchorTimestamp: 1_800_000_000_000 + index * 60_000,
  }));
  const result = buildRuleModelBlendChallenger({
    validationRecords: validation,
    testRecords: untouchedTest,
    model: model(),
  });
  assert.equal(result.selection.source, "validation_only");
  assert.equal(result.selection.testUsedForSelection, false);
  assert.ok(result.candidateRuleWeight < DEPLOYED_RULE_WEIGHT);
  assert.equal(result.status, "shadow_challenger_candidate");
  assert.ok(result.test.comparison.macroF1Delta >= 0.05);
  assert.ok(result.test.comparison.balancedAccuracyDelta >= 0.03);
  assert.ok(result.test.comparison.directionalRecallAverageDelta >= 0.03);
  assert.equal(result.safety.runtimeChanged, false);
  assert.equal(result.safety.finalHoldoutUsed, false);
  assert.equal(result.safety.paperUsed, false);
  assert.equal(result.safety.shadowUsedForSelection, false);
  assert.equal(result.safety.liveAuthority, false);
});

test("challenger fails closed when rule provenance is missing", () => {
  const validation = records(90).map(({ ruleScore: _ruleScore, ...record }) => record);
  assert.throws(() => buildRuleModelBlendChallenger({
    validationRecords: validation,
    testRecords: records(90),
    model: model(),
  }), /ruleScore is required/);
});

test("challenger refuses a different deployed baseline weight", () => {
  assert.throws(() => buildRuleModelBlendChallenger({
    validationRecords: records(90),
    testRecords: records(90),
    model: model(),
    deployedRuleWeight: 0.5,
  }), /must remain 0.65/);
});
