// Contract-only fixtures below are never market, Shadow, Paper, or profitability evidence.
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildShadowDirectionalRecoveryComparison,
  SHADOW_DIRECTIONAL_METHODS,
} from "../src/shadow-directional-recovery-v1.js";

const EVIDENCE_ID = "frozen-directional-fixture-v1";

function model() {
  return Object.freeze({
    id: "directional-recovery-fixture-v1",
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

function policy() {
  return Object.freeze({
    version: "directional-recovery-policy-fixture-v1",
    confidenceThreshold: 0.6,
    abstainMinConfidence: 0.55,
    abstainMargin: 0.08,
    dynamicRuleWeightGrid: Object.freeze([0, 0.15, 0.3, 0.45, 0.65]),
    regimeRuleWeightGrid: Object.freeze([0, 0.2, 0.4, 0.65]),
    minDevelopmentSamples: 30,
    minStageSamples: 30,
    minRegimeSamples: 6,
    minBullRecallImprovement: 0.01,
    minBearRecallImprovement: 0.01,
    minMacroF1Improvement: 0.01,
    minBalancedAccuracyImprovement: 0.01,
    maxLogLossRegression: 0.03,
    maxBrierRegression: 0.03,
    maxCalibrationErrorRegression: 0.03,
    maxCatastrophicRateIncrease: 0,
    maxCostAdjustedExpectancyRegression: 0,
    maxRegimeMetricRegression: 0.02,
  });
}

function records(count = 90, start = 1_700_000_000_000) {
  const directions = ["bullish", "neutral", "bearish"];
  return Array.from({ length: count }, (_, index) => {
    const direction = directions[index % directions.length];
    const x = direction === "bullish" ? 1 : direction === "bearish" ? -1 : 0;
    const symbol = index % 2 === 0 ? "BTCUSDT" : "ETHUSDT";
    const timeframe = index % 4 < 2 ? "15m" : "1h";
    const regime = index % 6 < 3 ? "trend" : "range";
    const volatilityBucket = index % 5 < 2 ? "high-vol" : "low-vol";
    return Object.freeze({
      frozenEvidenceId: EVIDENCE_ID,
      features: Object.freeze({ x }),
      ruleScore: 0,
      label: Object.freeze({ direction }),
      symbol,
      timeframe,
      regime,
      volatilityBucket,
      anchorTimestamp: start + index * 60_000,
      costAdjustedResultByPrediction: Object.freeze({
        bullish: direction === "bullish" ? 0.018 : direction === "bearish" ? -0.028 : -0.004,
        neutral: direction === "neutral" ? -0.001 : -0.002,
        bearish: direction === "bearish" ? 0.018 : direction === "bullish" ? -0.028 : -0.004,
        abstain: 0,
      }),
    });
  });
}

function fullInput(overrides = {}) {
  return {
    frozenEvidenceId: EVIDENCE_ID,
    model: model(),
    policy: policy(),
    developmentRecords: records(90, 1_700_000_000_000),
    oosRecords: records(90, 1_800_000_000_000),
    purgedWalkForwardRecords: records(90, 1_900_000_000_000),
    costStressRecords: records(90, 2_000_000_000_000),
    regimeStressRecords: records(90, 2_100_000_000_000),
    finalHoldoutRecords: records(90, 2_200_000_000_000),
    ...overrides,
  };
}

test("compares all seven preregistered methods and keeps model-only diagnostic-only", () => {
  const result = buildShadowDirectionalRecoveryComparison(fullInput());
  assert.deepEqual(Object.keys(result.stages.development.methods), [...SHADOW_DIRECTIONAL_METHODS]);
  assert.equal(result.stages.development.methods.MODEL_ONLY_DIAGNOSTIC.promotable, false);
  assert.deepEqual(result.stages.development.methods.MODEL_ONLY_DIAGNOSTIC.gate.reasons, ["diagnostic_only_never_promotable"]);
  assert.equal(result.selection.source, "development_only");
  assert.equal(result.selection.oosUsedForSelection, false);
  assert.equal(result.selection.finalHoldoutUsedForSelection, false);
  assert.notEqual(result.selection.selectedMethod, "MODEL_ONLY_DIAGNOSTIC");
});

test("agreement gate abstains on rule/model disagreement while confidence gate can recover high-confidence direction", () => {
  const result = buildShadowDirectionalRecoveryComparison(fullInput());
  const agreement = result.stages.development.methods.AGREEMENT_GATE.metrics;
  const confidence = result.stages.development.methods.CONFIDENCE_GATE.metrics;
  assert.ok(agreement.predictedCounts.abstain > 0);
  assert.ok(confidence.predictedCounts.bullish > 0);
  assert.ok(confidence.predictedCounts.bearish > 0);
  assert.ok(confidence.perClass.bullish.recall > result.stages.development.methods.CURRENT_FIXED_BLEND.metrics.perClass.bullish.recall);
  assert.ok(confidence.perClass.bearish.recall > result.stages.development.methods.CURRENT_FIXED_BLEND.metrics.perClass.bearish.recall);
});

test("OOS and final holdout outcomes cannot change development-only method or parameter selection", () => {
  const baseline = buildShadowDirectionalRecoveryComparison(fullInput());
  const reversed = records(90, 1_800_000_000_000).map((record) => Object.freeze({
    ...record,
    label: Object.freeze({
      direction: record.label.direction === "bullish" ? "bearish" : record.label.direction === "bearish" ? "bullish" : "neutral",
    }),
  }));
  const changed = buildShadowDirectionalRecoveryComparison(fullInput({
    oosRecords: reversed,
    finalHoldoutRecords: reversed.map((record, index) => Object.freeze({ ...record, anchorTimestamp: 2_300_000_000_000 + index * 60_000 })),
  }));
  assert.equal(changed.selection.selectedMethod, baseline.selection.selectedMethod);
  assert.deepEqual(changed.selection.selectedParameters, baseline.selection.selectedParameters);
  assert.equal(changed.selection.oosUsedForSelection, false);
  assert.equal(changed.selection.finalHoldoutUsedForSelection, false);
});

test("missing cost-adjusted evidence fails closed instead of inventing profitability", () => {
  const noCost = records(90, 1_800_000_000_000).map(({ costAdjustedResultByPrediction: _cost, ...record }) => Object.freeze(record));
  const result = buildShadowDirectionalRecoveryComparison(fullInput({ oosRecords: noCost }));
  assert.equal(result.status, "research_hold");
  assert.equal(result.stages.oos.methods.CURRENT_FIXED_BLEND.metrics.costAdjusted.available, false);
  assert.ok(result.stages.oos.selectedGate.reasons.includes("cost_adjusted_evidence_missing"));
});

test("abstain is preserved as its own decision class and safety authority remains NONE", () => {
  const strict = Object.freeze({ ...policy(), abstainMinConfidence: 0.99, abstainMargin: 0.99 });
  const directionalDevelopment = records(90, 1_700_000_000_000).map((record) => Object.freeze({
    ...record,
    ruleScore: record.label.direction === "bullish" ? 100 : record.label.direction === "bearish" ? -100 : 0,
  }));
  const result = buildShadowDirectionalRecoveryComparison(fullInput({
    policy: strict,
    developmentRecords: directionalDevelopment,
  }));
  const abstainFirst = result.stages.development.methods.ABSTAIN_FIRST.metrics;
  assert.ok(abstainFirst.predictedCounts.abstain > 0);
  assert.ok(Object.prototype.hasOwnProperty.call(abstainFirst.confusion.bullish, "abstain"));
  assert.equal(result.safety.executionAuthority, "NONE");
  assert.equal(result.safety.liveTrading, false);
  assert.equal(result.safety.autoTrading, false);
  assert.equal(result.safety.realOrderEnabled, false);
  assert.equal(result.safety.privateTradingApiAllowed, false);
  assert.equal(result.safety.orderCount, 0);
});

test("frozen evidence identity mismatch fails closed", () => {
  const broken = records(90, 1_800_000_000_000).map((record, index) => index === 5
    ? Object.freeze({ ...record, frozenEvidenceId: "other-evidence" })
    : record);
  assert.throws(() => buildShadowDirectionalRecoveryComparison(fullInput({ oosRecords: broken })), /frozen evidence identity mismatch/);
});
