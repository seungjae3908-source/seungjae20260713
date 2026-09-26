import test from "node:test";
import assert from "node:assert/strict";
import {
  SHADOW_DIRECTIONAL_RESCUE_IDENTITY_MAPPING_V1,
  SHADOW_DIRECTIONAL_RESCUE_POLICY_V1,
  SHADOW_DIRECTIONAL_RESCUE_POLICY_V1_SHA256,
  buildFutureShadowDirectionalRescueEvidenceV1,
  buildShadowDirectionalRescueCandidateV1,
  selectShadowDirectionalRescueV1,
} from "../src/shadow-directional-rescue-v1.js";
import { computeShadowObservationArtifactDigestV1 } from "../src/shadow-evidence-handoff-v1.js";
import { sha256Canonical } from "../src/research-cache-provenance.js";

const HASHES = Object.freeze({
  dataset: "1".repeat(64),
  model: "2".repeat(64),
  features: "3".repeat(64),
  training: "4".repeat(64),
  train: "5".repeat(64),
  validation: "6".repeat(64),
  runtimeArtifact: "7".repeat(64),
});

function artifactContext(overrides = {}) {
  return {
    workflowRunHead: "b".repeat(40),
    createdAt: "2026-08-31T00:00:00.000Z",
    expiresAt: "2026-11-30T00:00:00.000Z",
    checkedAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

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
      sourceGeneratedHead: "b".repeat(40),
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

function futureFixture({ timeframe = "15m", settled = true, observedAt = "2026-09-02T00:15:00.000Z" } = {}) {
  const strategyIdentity = Object.freeze({
    market: "CRYPTO_FUTURES",
    timeframe,
    direction: "BOTH",
    researchCodeSha: "8".repeat(40),
  });
  const strategyIdentityDigest = sha256Canonical(strategyIdentity);
  const modelIdentity = Object.freeze({
    canonicalModelArtifactDigest: HASHES.model,
    exactModelBytesSha: "9".repeat(64),
    trainingRunIdentityDigest: HASHES.training,
    strategyIdentityDigest,
    datasetIdentityDigest: HASHES.dataset,
    featureOrderDigest: HASHES.features,
    preprocessingVersion: "prediction-lab-training-preprocessing-v1",
  });
  const modelIdentityDigest = sha256Canonical(modelIdentity);
  const referenceIdentity = Object.freeze({
    datasetDigest: HASHES.dataset,
    featureOrderDigest: HASHES.features,
    preprocessingVersion: "prediction-lab-training-preprocessing-v1",
    trainSplitDigest: HASHES.train,
    validationSplitDigest: HASHES.validation,
  });
  const probabilities = Object.freeze({ bullish: 0.7, neutral: 0.2, bearish: 0.1 });
  const neutral = Object.freeze({ bullish: 0.2, neutral: 0.7, bearish: 0.1 });
  const observation = {
    schemaVersion: "prediction-lab-shadow-observation-components-v1",
    observationId: `future-${timeframe}-${settled ? "settled" : "pending"}`,
    observedAt,
    signalAt: "2026-09-02T00:14:00.000Z",
    timeframe,
    strategyIdentity,
    strategyIdentityDigest,
    modelIdentity,
    modelIdentityDigest,
    referenceIdentity,
    components: {
      RULE_ONLY: { probabilities: neutral, finalDirection: "neutral" },
      MODEL_ONLY: { probabilities, finalDirection: "bullish" },
      DEPLOYED_FROZEN_BLEND: {
        probabilities: neutral,
        finalDirection: "neutral",
        weights: { rule: 0.65, model: 0.35 },
      },
    },
    sourceProvenance: {
      sourceKind: "GENUINE_SHADOW_OBSERVATION",
      capturedAtObservationTime: true,
      reconstructed: false,
      synthetic: false,
      replayed: false,
      historicalBackfill: false,
    },
    creditEligibility: {
      genuineFuture: true,
      duplicate: false,
      replay: false,
      synthetic: false,
      historicalBackfill: false,
      hindsightReconstruction: false,
    },
    settlementStatus: settled ? "SETTLED" : "PENDING_SETTLEMENT",
    settlement: settled ? {
      horizon: { outcomeAt: "2026-09-02T00:30:00.000Z" },
      settledAt: "2026-09-02T00:31:00.000Z",
      sourceProvenance: {
        sourceKind: "GENUINE_FUTURE_SHADOW_OUTCOME",
        capturedAfterObservation: true,
        reconstructed: false,
        synthetic: false,
        replayed: false,
        historicalBackfill: false,
      },
    } : null,
  };
  observation.artifactDigest = computeShadowObservationArtifactDigestV1(observation);
  const expectedIdentity = Object.freeze({
    strategyDigest: strategyIdentityDigest,
    datasetDigest: HASHES.dataset,
    modelDigest: HASHES.model,
    featureOrderDigest: HASHES.features,
    preprocessingVersion: "prediction-lab-training-preprocessing-v1",
    policyDigest: SHADOW_DIRECTIONAL_RESCUE_POLICY_V1_SHA256,
    candidateIdentity: modelIdentityDigest,
    researchCodeSha: "8".repeat(40),
    trainingArtifactIdentity: HASHES.training,
    trainIdentity: HASHES.train,
    validationIdentity: HASHES.validation,
  });
  return { observation, expectedIdentity };
}

function futureContext(overrides = {}) {
  const { observation, expectedIdentity } = futureFixture();
  return {
    observations: [observation],
    expectedIdentity,
    policyFreeze: {
      policyDigest: SHADOW_DIRECTIONAL_RESCUE_POLICY_V1_SHA256,
      policyFrozenAt: "2026-09-02T00:00:00.000Z",
      historicalEvidenceUsedToSelectPolicy: true,
      historicalDataUsedForPolicySelection: true,
      historicalDataUsedForParameterSelection: false,
    },
    runtimeEvidence: {
      trigger: "schedule",
      sourceArtifactImmutable: true,
      publicationStatus: "PUBLISHED",
      workflowRunId: 987,
      artifactDigest: HASHES.runtimeArtifact,
    },
    ...overrides,
  };
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

test("policy is zero-parameter research-only and gives historically selected evidence zero credit", () => {
  assert.equal(SHADOW_DIRECTIONAL_RESCUE_POLICY_V1.newThresholds, 0);
  assert.equal(SHADOW_DIRECTIONAL_RESCUE_POLICY_V1.thresholdModified, false);
  assert.equal(SHADOW_DIRECTIONAL_RESCUE_POLICY_V1.labelModified, false);
  assert.equal(SHADOW_DIRECTIONAL_RESCUE_POLICY_V1.classWeightModified, false);
  assert.equal(SHADOW_DIRECTIONAL_RESCUE_POLICY_V1.blendWeightModified, false);
  assert.equal(SHADOW_DIRECTIONAL_RESCUE_POLICY_V1.modelModified, false);
  assert.equal(SHADOW_DIRECTIONAL_RESCUE_POLICY_V1.historicalEvidenceUsedToSelectPolicy, true);
  assert.equal(SHADOW_DIRECTIONAL_RESCUE_POLICY_V1.historicalDataUsedForPolicySelection, true);
  assert.equal(SHADOW_DIRECTIONAL_RESCUE_POLICY_V1.historicalDataUsedForParameterSelection, false);
  assert.equal(SHADOW_DIRECTIONAL_RESCUE_POLICY_V1.historicalPromotionCredit, 0);
  assert.equal(SHADOW_DIRECTIONAL_RESCUE_POLICY_V1.preFreezePromotionCredit, 0);
  assert.equal(SHADOW_DIRECTIONAL_RESCUE_POLICY_V1.replayPromotionCredit, 0);
  assert.equal(SHADOW_DIRECTIONAL_RESCUE_POLICY_V1.syntheticPromotionCredit, 0);
  assert.equal(SHADOW_DIRECTIONAL_RESCUE_POLICY_V1.manualPromotionCredit, 0);
  assert.equal(SHADOW_DIRECTIONAL_RESCUE_POLICY_V1.profitabilityCredit, 0);
  assert.equal(SHADOW_DIRECTIONAL_RESCUE_POLICY_V1.prospectiveGenuineEvidenceRequired, true);
  assert.equal(SHADOW_DIRECTIONAL_RESCUE_POLICY_V1.modelCutoverAuthorized, false);
  assert.equal(SHADOW_DIRECTIONAL_RESCUE_POLICY_V1.scheduleMutationAuthorized, false);
  assert.equal(SHADOW_DIRECTIONAL_RESCUE_POLICY_V1.paperOrLiveAuthority, false);
  assert.match(SHADOW_DIRECTIONAL_RESCUE_POLICY_V1_SHA256, /^[0-9a-f]{64}$/u);
});

test("authenticated all-neutral Rule cohort can derive an exact historical rescue counterfactual", () => {
  const diagnostic = authenticatedDiagnostic();
  const candidate = buildShadowDirectionalRescueCandidateV1(diagnostic, artifactContext());
  assert.equal(candidate.status, "READY_FOR_PROSPECTIVE_FREEZE");
  assert.equal(candidate.reason, null);
  assert.equal(candidate.derivation.mode, "EXACT_COUNTERFACTUAL_IDENTITY");
  assert.equal(candidate.derivation.newParameterCount, 0);
  assert.equal(candidate.derivation.historicalDataUsedForPolicySelection, true);
  assert.equal(candidate.derivation.historicalDataUsedForParameterSelection, false);
  assert.equal(candidate.historicalEvaluation.rescue, diagnostic.lanes.model);
  assert.equal(candidate.historicalEvaluation.promotionCredit, 0);
  assert.equal(candidate.promotionCredit, 0);
  assert.equal(candidate.profitabilityCredit, 0);
  assert.equal(candidate.prospectiveGate.historicalSamplesEligible, 0);
  assert.equal(candidate.prospectiveGate.preFreezeSamplesEligible, 0);
  assert.equal(candidate.prospectiveGate.replaySamplesEligible, 0);
  assert.equal(candidate.prospectiveGate.syntheticSamplesEligible, 0);
  assert.equal(candidate.prospectiveGate.manualSamplesEligible, 0);
  assert.equal(candidate.futureEvidence.counts["15m"].TOTAL_N, 0);
  assert.equal(candidate.futureEvidence.counts["1h"].TOTAL_N, 0);
  assert.equal(candidate.futureEvidence.counts.SAME_CANDIDATE_MATCHED_N, 0);
  assert.equal(candidate.sourceArtifact.authentication.immutable, true);
  assert.equal(candidate.historicalEvaluation.comparisonVsFrozenBlend.accuracyDelta, 2 / 6);
  assert.equal(candidate.historicalEvaluation.comparisonVsFrozenBlend.longRecallDelta, 0.5);
  assert.equal(candidate.historicalEvaluation.comparisonVsFrozenBlend.shortRecallDelta, 1);
});

test("candidate fails closed without exact parity or mechanical proof", () => {
  const diagnostic = authenticatedDiagnostic();
  const noParity = buildShadowDirectionalRescueCandidateV1({
    ...diagnostic,
    authenticatedEvidence: { ...diagnostic.authenticatedEvidence, exactBlendParity: false },
  }, artifactContext());
  assert.equal(noParity.status, "NOT_EVALUABLE");
  assert.equal(noParity.reason, "EXACT_BLEND_PARITY_NOT_PROVEN");
  assert.equal(noParity.promotionCredit, 0);

  const noRootCause = buildShadowDirectionalRescueCandidateV1({
    ...diagnostic,
    mechanicalRootCause: { ...diagnostic.mechanicalRootCause, P1_1_MECHANICAL_ROOT_CAUSE_PROVEN: false },
  }, artifactContext());
  assert.equal(noRootCause.status, "NOT_EVALUABLE");
  assert.equal(noRootCause.reason, "MECHANICAL_ROOT_CAUSE_NOT_PROVEN");
});

test("aggregate counterfactual refuses mixed Rule cohorts and frozen-weight mismatch", () => {
  const diagnostic = authenticatedDiagnostic();
  const mixedRule = buildShadowDirectionalRescueCandidateV1({
    ...diagnostic,
    mechanicalRootCause: { ...diagnostic.mechanicalRootCause, ruleNeutralN: 5 },
  }, artifactContext());
  assert.equal(mixedRule.status, "NOT_EVALUABLE");
  assert.equal(mixedRule.reason, "RULE_NOT_NEUTRAL_FOR_ENTIRE_AUTHENTICATED_COHORT");
  assert.equal(mixedRule.promotionCredit, 0);

  assert.throws(() => buildShadowDirectionalRescueCandidateV1({
    ...diagnostic,
    declaredBlendWeights: { rule: 0.6, model: 0.4 },
  }, artifactContext()), /frozen 65\/35 Blend identity mismatch/u);
});

test("latest immutable artifact context rejects corrupt, stale, future, and wrong-head evidence", () => {
  const diagnostic = authenticatedDiagnostic();
  assert.throws(() => buildShadowDirectionalRescueCandidateV1({
    ...diagnostic,
    authenticatedEvidence: { ...diagnostic.authenticatedEvidence, artifactDigest: "corrupt" },
  }, artifactContext()), /immutable Shadow artifact identity/u);
  assert.throws(() => buildShadowDirectionalRescueCandidateV1(diagnostic, artifactContext({ expiresAt: "2026-09-01T23:59:59.000Z" })), /stale or expired/u);
  assert.throws(() => buildShadowDirectionalRescueCandidateV1(diagnostic, artifactContext({ createdAt: "2026-09-02T00:00:01.000Z" })), /future-created/u);
  assert.throws(() => buildShadowDirectionalRescueCandidateV1(diagnostic, artifactContext({ workflowRunHead: "invalid" })), /carrier\/source HEAD identity/u);
});

test("future-only cohort proves exact same-candidate identity across Rule Model Blend and Challenger", () => {
  const result = buildFutureShadowDirectionalRescueEvidenceV1(futureContext());
  assert.equal(result.status, "GENUINE_POST_FREEZE_EVIDENCE_PRESENT");
  assert.equal(result.identityChainState, "SAME_CANDIDATE_FULLY_PROVEN");
  assert.equal(result.counts["15m"].TOTAL_N, 1);
  assert.equal(result.counts["15m"].SETTLED_N, 1);
  assert.equal(result.counts["15m"].PENDING_N, 0);
  assert.equal(result.counts["1h"].TOTAL_N, 0);
  assert.equal(result.counts.SAME_CANDIDATE_MATCHED_N, 1);
  assert.equal(result.genuineSampleCredit, 1);
  assert.equal(result.observations[0].outputs.challengerDirection, "LONG");
  assert.deepEqual(result.observations[0].laneIdentity.RULE_ONLY, result.observations[0].laneIdentity.DIRECTIONAL_RESCUE_CHALLENGER);
  assert.deepEqual(Object.keys(result.identityMapping), Object.keys(SHADOW_DIRECTIONAL_RESCUE_IDENTITY_MAPPING_V1));
});

test("future-only cohort records 15m and 1h TOTAL SETTLED PENDING separately", () => {
  const first = futureFixture({ timeframe: "15m", settled: true });
  const second = futureFixture({ timeframe: "1h", settled: false, observedAt: "2026-09-02T01:00:00.000Z" });
  const result = buildFutureShadowDirectionalRescueEvidenceV1(futureContext({
    observations: [first.observation, second.observation],
    expectedIdentity: { "15m": first.expectedIdentity, "1h": second.expectedIdentity },
  }));
  assert.equal(result.counts["15m"].SETTLED_N, 1);
  assert.equal(result.counts["1h"].TOTAL_N, 1);
  assert.equal(result.counts["1h"].PENDING_N, 1);
  assert.equal(result.counts.SAME_CANDIDATE_MATCHED_N, 2);
});

for (const [field, label] of [
  ["strategyDigest", "strategyDigest"],
  ["datasetDigest", "datasetDigest"],
  ["modelDigest", "modelDigest"],
  ["featureOrderDigest", "featureOrderDigest"],
  ["preprocessingVersion", "preprocessingVersion"],
  ["policyDigest", "policyDigest"],
]) {
  test(`future same-candidate contract rejects ${label} mismatch`, () => {
    const context = futureContext();
    const changed = field === "preprocessingVersion" ? "prediction-lab-training-preprocessing-v2" : "f".repeat(64);
    assert.throws(() => buildFutureShadowDirectionalRescueEvidenceV1({
      ...context,
      expectedIdentity: { ...context.expectedIdentity, [field]: changed },
    }), new RegExp(`${field} mismatch`, "u"));
  });
}

test("future same-candidate contract rejects candidate training TRAIN and VALIDATION identity mismatches", () => {
  for (const field of ["candidateIdentity", "trainingArtifactIdentity", "trainIdentity", "validationIdentity", "researchCodeSha"]) {
    const context = futureContext();
    const changed = field === "researchCodeSha" ? "f".repeat(40) : "f".repeat(64);
    assert.throws(() => buildFutureShadowDirectionalRescueEvidenceV1({
      ...context,
      expectedIdentity: { ...context.expectedIdentity, [field]: changed },
    }), new RegExp(`${field} mismatch`, "u"));
  }
});

test("future contract rejects pre-freeze replay synthetic backfill and duplicate observations", () => {
  const preFreeze = futureContext();
  preFreeze.observations[0].observedAt = "2026-09-01T23:59:59.000Z";
  preFreeze.observations[0].artifactDigest = computeShadowObservationArtifactDigestV1(preFreeze.observations[0]);
  assert.throws(() => buildFutureShadowDirectionalRescueEvidenceV1(preFreeze), /pre-freeze/u);

  for (const field of ["replayed", "synthetic", "historicalBackfill"]) {
    const context = futureContext();
    context.observations[0].sourceProvenance[field] = true;
    context.observations[0].artifactDigest = computeShadowObservationArtifactDigestV1(context.observations[0]);
    assert.throws(() => buildFutureShadowDirectionalRescueEvidenceV1(context), /credit is forbidden/u);
  }

  const duplicate = futureContext();
  assert.throws(() => buildFutureShadowDirectionalRescueEvidenceV1({
    ...duplicate,
    observations: [duplicate.observations[0], duplicate.observations[0]],
  }), /duplicate future Shadow observation/u);
});

test("future contract requires scheduled immutable publication and rejects settlement leakage", () => {
  const manual = futureContext({ runtimeEvidence: { ...futureContext().runtimeEvidence, trigger: "workflow_dispatch" } });
  assert.throws(() => buildFutureShadowDirectionalRescueEvidenceV1(manual), /scheduled immutable Shadow runtime publication/u);

  const leakage = futureContext();
  leakage.observations[0].settlement.horizon.outcomeAt = leakage.observations[0].observedAt;
  leakage.observations[0].artifactDigest = computeShadowObservationArtifactDigestV1(leakage.observations[0]);
  assert.throws(() => buildFutureShadowDirectionalRescueEvidenceV1(leakage), /settled future horizon evidence is invalid/u);
});

test("frozen Blend parity and Rule-directional Challenger semantics stay exact", () => {
  const parity = futureContext();
  parity.observations[0].components.DEPLOYED_FROZEN_BLEND.weights = { rule: 0.6, model: 0.4 };
  parity.observations[0].artifactDigest = computeShadowObservationArtifactDigestV1(parity.observations[0]);
  assert.throws(() => buildFutureShadowDirectionalRescueEvidenceV1(parity), /frozen Blend parity mismatch/u);

  const directional = futureContext();
  directional.observations[0].components.RULE_ONLY = {
    probabilities: { bullish: 0.8, neutral: 0.1, bearish: 0.1 },
    finalDirection: "bullish",
  };
  directional.observations[0].artifactDigest = computeShadowObservationArtifactDigestV1(directional.observations[0]);
  const result = buildFutureShadowDirectionalRescueEvidenceV1(directional);
  assert.equal(result.observations[0].outputs.challengerDirection, "NEUTRAL");
});

test("future evidence never grants promotion profitability model cutover schedule or trading authority", () => {
  const result = buildFutureShadowDirectionalRescueEvidenceV1(futureContext());
  assert.equal(result.historicalPromotionCredit, 0);
  assert.equal(result.preFreezePromotionCredit, 0);
  assert.equal(result.replayCredit, 0);
  assert.equal(result.syntheticCredit, 0);
  assert.equal(result.manualCredit, 0);
  assert.equal(result.profitabilityCredit, 0);
  assert.equal(result.promotionCredit, 0);
  assert.equal(result.psi, null);
  assert.equal(result.ks, null);
  assert.equal(result.jsd, null);
  assert.equal(result.strategyHealth, "NOT_EVALUABLE");
  assert.equal(result.safety.modelCutoverAuthorized, false);
  assert.equal(result.safety.scheduleMutationAuthorized, false);
  assert.equal(result.safety.LIVE_TRADING, false);
  assert.equal(result.safety.AUTO_TRADING, false);
  assert.equal(result.safety.REAL_ORDER_ENABLED, false);
  assert.equal(result.safety.PRIVATE_TRADING_API_ALLOWED, false);
  assert.equal(result.safety.executionAuthority, "NONE");
});
