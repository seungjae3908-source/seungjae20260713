import test from "node:test";
import assert from "node:assert/strict";
import {
  SHADOW_BLEND_COLLAPSE_DIAGNOSTIC_SAFETY,
  buildShadowBlendCollapseDiagnostic,
} from "../src/shadow-blend-collapse-diagnostics-v1.js";

const row = (id, actualDirection, ruleDirection, modelDirection, blendDirection, regime = "BULL") => ({
  id,
  timeframe: "15m",
  actualDirection,
  ruleDirection,
  modelDirection,
  blendDirection,
  regime,
});

test("fails closed when settled support is insufficient", () => {
  const observations = [
    row("a", "LONG", "NEUTRAL", "LONG", "NEUTRAL"),
    row("b", null, "NEUTRAL", "SHORT", "NEUTRAL"),
    row("c", "NEUTRAL", "NEUTRAL", "NEUTRAL", "NEUTRAL", "SIDEWAYS"),
  ];
  const result = buildShadowBlendCollapseDiagnostic({ observations, minSettledN: 3 });
  assert.equal(result.evaluationStatus, "NOT_EVALUABLE");
  assert.equal(result.failureModeVerdict, "NOT_EVALUABLE_INSUFFICIENT_SETTLED");
  assert.ok(result.limitations.includes("insufficient_settled_sample"));
});

test("detects model-only actionable signals being neutralized by the blend without authorizing retuning", () => {
  const observations = [
    row("l1", "LONG", "NEUTRAL", "LONG", "NEUTRAL", "BULL"),
    row("l2", "LONG", "NEUTRAL", "LONG", "NEUTRAL", "BULL"),
    row("l3", "LONG", "NEUTRAL", "LONG", "NEUTRAL", "BULL"),
    row("l4", "LONG", "NEUTRAL", "LONG", "NEUTRAL", "SIDEWAYS"),
    row("s1", "SHORT", "NEUTRAL", "SHORT", "NEUTRAL", "BEAR"),
    row("s2", "SHORT", "NEUTRAL", "SHORT", "NEUTRAL", "BEAR"),
    row("s3", "SHORT", "NEUTRAL", "SHORT", "NEUTRAL", "SIDEWAYS"),
    row("s4", "SHORT", "NEUTRAL", "SHORT", "NEUTRAL", "BEAR"),
    row("n1", "NEUTRAL", "NEUTRAL", "NEUTRAL", "NEUTRAL", "SIDEWAYS"),
    row("n2", "NEUTRAL", "NEUTRAL", "NEUTRAL", "NEUTRAL", "SIDEWAYS"),
    row("n3", "NEUTRAL", "NEUTRAL", "NEUTRAL", "NEUTRAL", "BULL"),
    row("n4", "NEUTRAL", "NEUTRAL", "NEUTRAL", "NEUTRAL", "SIDEWAYS"),
  ];
  const result = buildShadowBlendCollapseDiagnostic({ observations, minSettledN: 12 });
  assert.equal(result.evaluationStatus, "EVALUABLE_DIAGNOSTIC_ONLY");
  assert.equal(result.failureModeVerdict, "BLEND_ARBITRATION_SUPPRESSES_MODEL_ONLY_ACTIONABLE");
  assert.equal(result.metrics.modelOnlyActionableN, 8);
  assert.equal(result.metrics.modelOnlyActionableSuppressionRate, 1);
  assert.equal(result.lanes.rule.distribution.neutralRate, 1);
  assert.equal(result.lanes.blend.distribution.neutralRate, 1);
  assert.equal(result.causalProof, false);
  assert.equal(result.safety.blendWeightModified, false);
  assert.equal(result.safety.thresholdModified, false);
});

test("preserves agreed actionable directions and does not invent a collapse", () => {
  const observations = [
    row("1", "LONG", "LONG", "LONG", "LONG", "BULL"),
    row("2", "LONG", "LONG", "LONG", "LONG", "BULL"),
    row("3", "SHORT", "SHORT", "SHORT", "SHORT", "BEAR"),
    row("4", "SHORT", "SHORT", "SHORT", "SHORT", "BEAR"),
    row("5", "NEUTRAL", "NEUTRAL", "NEUTRAL", "NEUTRAL", "SIDEWAYS"),
    row("6", "NEUTRAL", "NEUTRAL", "NEUTRAL", "NEUTRAL", "SIDEWAYS"),
  ];
  const result = buildShadowBlendCollapseDiagnostic({ observations, minSettledN: 6 });
  assert.equal(result.failureModeVerdict, "NO_SINGLE_FAILURE_MODE_PROVEN");
  assert.equal(result.metrics.agreedActionableRetentionRate, 1);
  assert.equal(result.lanes.blend.quality.balancedAccuracy, 1);
  assert.deepEqual(result.coverage.missingActualClasses, []);
  assert.deepEqual(result.coverage.missingRegimes, []);
});

test("reports class and regime coverage gaps without converting them to zero evidence", () => {
  const observations = [
    row("1", "LONG", "LONG", "LONG", "LONG", "BULL"),
    row("2", "LONG", "LONG", "LONG", "LONG", "BULL"),
    row("3", "NEUTRAL", "NEUTRAL", "NEUTRAL", "NEUTRAL", "SIDEWAYS"),
    row("4", "NEUTRAL", "NEUTRAL", "NEUTRAL", "NEUTRAL", "SIDEWAYS"),
  ];
  const result = buildShadowBlendCollapseDiagnostic({ observations, minSettledN: 4 });
  assert.deepEqual(result.coverage.missingActualClasses, ["SHORT"]);
  assert.deepEqual(result.coverage.missingRegimes, ["BEAR"]);
  assert.ok(result.limitations.includes("actual_class_coverage_incomplete"));
  assert.ok(result.limitations.includes("regime_coverage_incomplete"));
  assert.equal(result.lanes.blend.quality.perClass.SHORT.recall, null);
});

test("rejects mixed timeframes and duplicate observation identities", () => {
  assert.throws(() => buildShadowBlendCollapseDiagnostic({
    observations: [{ ...row("1", "LONG", "LONG", "LONG", "LONG"), timeframe: "1h" }],
    minSettledN: 3,
  }), /15m|mixed timeframe/u);

  assert.throws(() => buildShadowBlendCollapseDiagnostic({
    observations: [
      row("same", "LONG", "LONG", "LONG", "LONG"),
      row("same", "SHORT", "SHORT", "SHORT", "SHORT", "BEAR"),
      row("3", "NEUTRAL", "NEUTRAL", "NEUTRAL", "NEUTRAL", "SIDEWAYS"),
    ],
    minSettledN: 3,
  }), /duplicate observation id/u);
});

test("safety contract grants no tuning, profitability, promotion, private API, or order authority", () => {
  assert.equal(SHADOW_BLEND_COLLAPSE_DIAGNOSTIC_SAFETY.diagnosticsOnly, true);
  assert.equal(SHADOW_BLEND_COLLAPSE_DIAGNOSTIC_SAFETY.modelModified, false);
  assert.equal(SHADOW_BLEND_COLLAPSE_DIAGNOSTIC_SAFETY.thresholdModified, false);
  assert.equal(SHADOW_BLEND_COLLAPSE_DIAGNOSTIC_SAFETY.blendWeightModified, false);
  assert.equal(SHADOW_BLEND_COLLAPSE_DIAGNOSTIC_SAFETY.finalHoldoutOptimizationAllowed, false);
  assert.equal(SHADOW_BLEND_COLLAPSE_DIAGNOSTIC_SAFETY.profitabilityCredit, 0);
  assert.equal(SHADOW_BLEND_COLLAPSE_DIAGNOSTIC_SAFETY.promotionCredit, 0);
  assert.equal(SHADOW_BLEND_COLLAPSE_DIAGNOSTIC_SAFETY.LIVE_TRADING, false);
  assert.equal(SHADOW_BLEND_COLLAPSE_DIAGNOSTIC_SAFETY.PRIVATE_TRADING_API_ALLOWED, false);
  assert.equal(SHADOW_BLEND_COLLAPSE_DIAGNOSTIC_SAFETY.executionAuthority, "NONE");
  assert.equal(SHADOW_BLEND_COLLAPSE_DIAGNOSTIC_SAFETY.orderSubmitted, false);
});
