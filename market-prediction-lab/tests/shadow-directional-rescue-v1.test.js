import test from "node:test";
import assert from "node:assert/strict";
import {
  SHADOW_DIRECTIONAL_RESCUE_POLICY_V1,
  SHADOW_DIRECTIONAL_RESCUE_POLICY_V1_SHA256,
  buildShadowDirectionalRescueCandidateV1,
  selectShadowDirectionalRescueV1,
} from "../src/shadow-directional-rescue-v1.js";

function authenticatedDiagnostic() {
  const modelQuality = Object.freeze({
    settledN: 6,
    confusionMatrix: Object.freeze({
      LONG: Object.freeze({ LONG: 1, NEUTRAL: 1, SHORT: 0 }),
      NEUTRAL: Object.freeze({ LONG: 1, NEUTRAL: 1, SHORT: 0 }),
      SHORT: Object.freeze({ LONG: 0, NEUTRAL: 0, SHORT: 2 }),
    }),
    perClass: Object.freeze({
      LONG: Object.freeze({ recall: 0.5 }),
      NEUTRAL: Object.freeze({ recall: 0.5 }),
      SHORT: Object.freeze({ recall: 1 }),
    }),
    macroF1: 0.6,
    balancedAccuracy: 2 / 3,
  });
  const blendQuality = Object.freeze({
    settledN: 6,
    confusionMatrix: Object.freeze({
      LONG: Object.freeze({ LONG: 0, NEUTRAL: 2, SHORT: 0 }),
      NEUTRAL: Object.freeze({ LONG: 0, NEUTRAL: 2, SHORT: 0 }),
      SHORT: Object.freeze({ LONG: 0, NEUTRAL: 2, SHORT: 0 }),
    }),
    perClass: Object.freeze({
      LONG: Object.freeze({ recall: 0 }),
      NEUTRAL: Object.freeze({ recall: 1 }),
      SHORT: Object.freeze({ recall: 0 }),
    }),
    macroF1: 1 / 6,
    balancedAccuracy: 1 / 3,
  });
  return Object.freeze({
    kind: "authenticated-shadow-15m-blend-collapse-diagnostic",
    declaredBlendWeights: Object.freeze({ rule: 0.65, model: 0.35 }),
    authenticatedEvidence: Object.freeze({
      workflowRunId: 123,
      artifactId: 456,
      artifactDigest: `sha256:${"a".repeat(64)}`,
      researchCodeSha: "b".repeat(40),
      exactBlendParity: true,
    }),
    mechanicalRootCause: Object.freeze({
      P1_1_MECHANICAL_ROOT_CAUSE_PROVEN: true,
      ruleNeutralN: 6,
      ruleTotalN: 6,
    }),
    lanes: Object.freeze({
      model: Object.freeze({
        distribution: Object.freeze({ LONG: 2, NEUTRAL: 2, SHORT: 2, total: 6 }),
        quality: modelQuality,
      }),
      blend: Object.freeze({
        distribution: Object.freeze({ LONG: 0, NEUTRAL: 6, SHORT: 0, total: 6 }),
        quality: blendQuality,
      }),
    }),
  });
}

test("directional rescue only follows Model when Rule is neutral and Model is actionable", () => {
  assert.equal(selectShadowDirectionalRescueV1({
    ruleDirection: "NEUTRAL", modelDirection: "LONG", blendDirection: "NEUTRAL",
  }), "LONG");
  assert.equal(selectShadowDirectionalRescueV1({
    ruleDirection: "NEUTRAL", modelDirection: "SHORT", blendDirection: "NEUTRAL",
  }), "SHORT");
  assert.equal(selectShadowDirectionalRescueV1({
    ruleDirection: "NEUTRAL", modelDirection: "NEUTRAL", blendDirection: "NEUTRAL",
  }), "NEUTRAL");
});

test("directional rescue never overrides frozen Blend when Rule is actionable", () => {
  assert.equal(selectShadowDirectionalRescueV1({
    ruleDirection: "LONG", modelDirection: "SHORT", blendDirection: "NEUTRAL",
  }), "NEUTRAL");
  assert.equal(selectShadowDirectionalRescueV1({
    ruleDirection: "SHORT", modelDirection: "LONG", blendDirection: "SHORT",
  }), "SHORT");
});

test("policy is zero-parameter research-only and gives historical evidence zero credit", () => {
  assert.equal(SHADOW_DIRECTIONAL_RESCUE_POLICY_V1.newThresholds, 0);
  assert.equal(SHADOW_DIRECTIONAL_RESCUE_POLICY_V1.thresholdModified, false);
  assert.equal(SHADOW_DIRECTIONAL_RESCUE_POLICY_V1.labelModified, false);
  assert.equal(SHADOW_DIRECTIONAL_RESCUE_POLICY_V1.classWeightModified, false);
  assert.equal(SHADOW_DIRECTIONAL_RESCUE_POLICY_V1.blendWeightModified, false);
  assert.equal(SHADOW_DIRECTIONAL_RESCUE_POLICY_V1.modelModified, false);
  assert.equal(SHADOW_DIRECTIONAL_RESCUE_POLICY_V1.historicalPromotionCredit, 0);
  assert.equal(SHADOW_DIRECTIONAL_RESCUE_POLICY_V1.prospectiveGenuineEvidenceRequired, true);
  assert.match(SHADOW_DIRECTIONAL_RESCUE_POLICY_V1_SHA256, /^[0-9a-f]{64}$/u);
});

test("authenticated all-neutral Rule cohort can derive an exact historical rescue counterfactual", () => {
  const diagnostic = authenticatedDiagnostic();
  const candidate = buildShadowDirectionalRescueCandidateV1(diagnostic);
  assert.equal(candidate.status, "READY_FOR_PROSPECTIVE_FREEZE");
  assert.equal(candidate.reason, null);
  assert.equal(candidate.derivation.mode, "EXACT_COUNTERFACTUAL_IDENTITY");
  assert.equal(candidate.derivation.newParameterCount, 0);
  assert.equal(candidate.derivation.historicalDataUsedForParameterSelection, false);
  assert.equal(candidate.historicalEvaluation.rescue, diagnostic.lanes.model);
  assert.equal(candidate.historicalEvaluation.promotionCredit, 0);
  assert.equal(candidate.promotionCredit, 0);
  assert.equal(candidate.profitabilityCredit, 0);
  assert.equal(candidate.prospectiveGate.historicalSamplesEligible, 0);
  assert.equal(candidate.prospectiveGate.replaySamplesEligible, 0);
  assert.equal(candidate.prospectiveGate.syntheticSamplesEligible, 0);
  assert.equal(candidate.historicalEvaluation.comparisonVsFrozenBlend.accuracyDelta, 2 / 6);
  assert.equal(candidate.historicalEvaluation.comparisonVsFrozenBlend.longRecallDelta, 0.5);
  assert.equal(candidate.historicalEvaluation.comparisonVsFrozenBlend.shortRecallDelta, 1);
});

test("candidate fails closed without exact parity or mechanical proof", () => {
  const diagnostic = authenticatedDiagnostic();
  const noParity = buildShadowDirectionalRescueCandidateV1({
    ...diagnostic,
    authenticatedEvidence: { ...diagnostic.authenticatedEvidence, exactBlendParity: false },
  });
  assert.equal(noParity.status, "NOT_EVALUABLE");
  assert.equal(noParity.reason, "EXACT_BLEND_PARITY_NOT_PROVEN");
  assert.equal(noParity.promotionCredit, 0);

  const noRootCause = buildShadowDirectionalRescueCandidateV1({
    ...diagnostic,
    mechanicalRootCause: { ...diagnostic.mechanicalRootCause, P1_1_MECHANICAL_ROOT_CAUSE_PROVEN: false },
  });
  assert.equal(noRootCause.status, "NOT_EVALUABLE");
  assert.equal(noRootCause.reason, "MECHANICAL_ROOT_CAUSE_NOT_PROVEN");
});

test("aggregate counterfactual refuses mixed Rule cohorts and frozen-weight mismatch", () => {
  const diagnostic = authenticatedDiagnostic();
  const mixedRule = buildShadowDirectionalRescueCandidateV1({
    ...diagnostic,
    mechanicalRootCause: { ...diagnostic.mechanicalRootCause, ruleNeutralN: 5 },
  });
  assert.equal(mixedRule.status, "NOT_EVALUABLE");
  assert.equal(mixedRule.reason, "RULE_NOT_NEUTRAL_FOR_ENTIRE_AUTHENTICATED_COHORT");
  assert.equal(mixedRule.promotionCredit, 0);

  assert.throws(() => buildShadowDirectionalRescueCandidateV1({
    ...diagnostic,
    declaredBlendWeights: { rule: 0.6, model: 0.4 },
  }), /frozen 65\/35 Blend identity mismatch/u);
});
