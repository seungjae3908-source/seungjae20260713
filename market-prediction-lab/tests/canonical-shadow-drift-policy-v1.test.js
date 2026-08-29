import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  CANONICAL_SHADOW_DRIFT_POLICY_VERSION,
  DRIFT_VERDICT_MINIMUM_N,
  buildCanonicalShadowDriftPolicyV1,
  evaluateCanonicalShadowDriftPolicyV1,
  validateCanonicalShadowDriftPolicyV1,
} from "../src/canonical-shadow-drift-policy-v1.js";
import { sha256Canonical } from "../src/research-cache-provenance.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const AS_OF = "2026-08-26T06:00:00.000Z";

function fixture() {
  const records = Array.from({ length: 600 }, (_, index) => ({
    id: `reference-${index}`,
    features: {
      return5: Math.sin(index / 11) + index / 10_000,
      atrPct: 2 + Math.cos(index / 17) * 0.2,
    },
  }));
  const trainRecords = records.slice(0, 300);
  const validationRecords = records.slice(300);
  const referenceIdentity = {
    datasetId: "prediction-lab:15m:train-validation",
    datasetDigest: hash("dataset"),
    trainSplitDigest: hash("train"),
    validationSplitDigest: hash("validation"),
    rawArtifactDigest: hash("raw"),
    preprocessingVersion: "prediction-lab-training-preprocessing-v1",
    featureOrderDigest: sha256Canonical(["return5", "atrPct"]),
  };
  const producerManifest = {
    trainSplitDigest: referenceIdentity.trainSplitDigest,
    validationSplitDigest: referenceIdentity.validationSplitDigest,
    rawArtifactDigest: referenceIdentity.rawArtifactDigest,
    sourceAttestation: {
      sourceKind: "GENUINE_MARKET_DATA",
      reconstructed: false,
      synthetic: false,
      shadowDerived: false,
      finalHoldoutIncluded: false,
    },
    artifactReceipt: { expiresAt: "2026-09-30T00:00:00.000Z" },
  };
  const strategyIdentityDigest = hash("strategy");
  const modelIdentityDigest = hash("model");
  const strategyResolution = {
    valid: true,
    strategyIdentity: { market: "CRYPTO_FUTURES", timeframe: "15m" },
    strategyIdentityDigest,
  };
  const modelResolution = {
    valid: true,
    exactModel: {
      featureOrder: ["return5", "atrPct"],
      normalization: { mean: [0, 2], scale: [1, 0.2] },
    },
    modelIdentityDigest,
  };
  const referenceResolution = {
    valid: true,
    trainRecords,
    validationRecords,
    referenceRecords: records,
    referenceIdentity,
    freshness: { status: "FRESH", expiresAt: "2026-09-30T00:00:00.000Z" },
  };
  return { producerManifest, strategyResolution, modelResolution, referenceResolution };
}

function builtPolicy() {
  const context = fixture();
  const result = buildCanonicalShadowDriftPolicyV1(context);
  assert.equal(result.valid, true);
  return { context, policy: result.policy };
}

function reseal(policy) {
  const body = structuredClone(policy);
  delete body.policyDigest;
  return { ...body, policyDigest: sha256Canonical(body) };
}

function controlledPolicy() {
  const { context, policy } = builtPolicy();
  const body = structuredClone(policy);
  for (const name of Object.keys(body.rules)) body.rules[name] = { comparison: "GT", watch: 1, brake: 2 };
  return { context, policy: reseal(body) };
}

function metric(overrides = {}) {
  return {
    feature: "return5",
    status: "MEASURED",
    psi: 0,
    ksStatistic: 0,
    jsd: 0,
    standardizedMeanShift: 0,
    stdRatio: 1,
    missingRatio: { reference: 0, shadow: 0, delta: 0 },
    clippingRatio: { reference: 0, shadow: 0 },
    reference: { std: 1 },
    shadow: { std: 1 },
    ...overrides,
  };
}

function evaluate(policy, context, featureMetrics = [metric()], overrides = {}) {
  return evaluateCanonicalShadowDriftPolicyV1({
    policy,
    featureMetrics,
    sampleN: DRIFT_VERDICT_MINIMUM_N,
    strategyIdentityDigest: context.strategyResolution.strategyIdentityDigest,
    modelIdentityDigest: context.modelResolution.modelIdentityDigest,
    referenceIdentity: context.referenceResolution.referenceIdentity,
    market: context.strategyResolution.strategyIdentity.market,
    timeframe: context.strategyResolution.strategyIdentity.timeframe,
    asOf: AS_OF,
    ...overrides,
  });
}

test("canonical policy is deterministically frozen from TRAIN and VALIDATION only", () => {
  const context = fixture();
  const first = buildCanonicalShadowDriftPolicyV1(context);
  const second = buildCanonicalShadowDriftPolicyV1(context);
  assert.equal(first.valid, true);
  assert.equal(first.policy.policyVersion, CANONICAL_SHADOW_DRIFT_POLICY_VERSION);
  assert.equal(first.policy.policyDigest, second.policy.policyDigest);
  assert.deepEqual(first.policy.generatedFrom.sources, ["TRAIN", "VALIDATION"]);
  assert.equal(first.policy.generatedFrom.currentShadowUsed, false);
  assert.equal(first.policy.generatedFrom.settledShadowUsed, false);
  assert.equal(first.policy.generatedFrom.finalHoldoutUsed, false);
  assert.equal(first.policy.minimumSamplePolicy.profitabilitySufficientMinimumN, null);
  assert.equal(first.policy.generatedFrom.calibrationWindowCount, 20);
});

test("reference calibration fails closed below twenty independent 30-record windows", () => {
  const context = fixture();
  context.referenceResolution.trainRecords = context.referenceResolution.trainRecords.slice(0, 270);
  context.referenceResolution.validationRecords = context.referenceResolution.validationRecords.slice(0, 300);
  context.referenceResolution.referenceRecords = [...context.referenceResolution.trainRecords, ...context.referenceResolution.validationRecords];
  const result = buildCanonicalShadowDriftPolicyV1(context);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "POLICY_REFERENCE_SAMPLE_INSUFFICIENT");
});

test("missing policy is NOT_EVALUABLE", () => {
  const { context } = builtPolicy();
  const result = evaluate(null, context);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "CANONICAL_DRIFT_POLICY_MISSING");
});

test("tampered policy digest is rejected", () => {
  const { context, policy } = builtPolicy();
  const tampered = structuredClone(policy);
  tampered.rules.psi.watch += 1;
  const result = evaluate(tampered, context);
  assert.equal(result.reason, "POLICY_DIGEST_MISMATCH");
});

test("stale policy is rejected", () => {
  const { context, policy } = builtPolicy();
  const stale = reseal({ ...structuredClone(policy), expiresAt: "2026-08-26T05:59:59.000Z" });
  const result = evaluate(stale, context);
  assert.equal(result.reason, "POLICY_EXPIRED");
});

test("wrong policy version is rejected", () => {
  const { context, policy } = builtPolicy();
  const wrong = reseal({ ...structuredClone(policy), policyVersion: "wrong-version" });
  const result = evaluate(wrong, context);
  assert.equal(result.reason, "POLICY_VERSION_MISMATCH");
});

test("wrong market and timeframe are rejected", async (t) => {
  const { context, policy } = builtPolicy();
  await t.test("market", () => assert.equal(evaluate(policy, context, [metric()], { market: "CRYPTO_SPOT" }).reason, "POLICY_MARKET_MISMATCH"));
  await t.test("timeframe", () => assert.equal(evaluate(policy, context, [metric()], { timeframe: "1h" }).reason, "POLICY_TIMEFRAME_MISMATCH"));
});

test("N below verdict minimum remains metric-computable but NOT_EVALUABLE", () => {
  const { context, policy } = builtPolicy();
  const result = evaluate(policy, context, [metric()], { sampleN: 2 });
  assert.equal(result.valid, false);
  assert.equal(result.reason, "INSUFFICIENT_SAMPLE");
  assert.equal(result.metricComputable, true);
  assert.equal(result.verdictSufficient, false);
  assert.equal(result.verdictMinimumN, 30);
});

test("PSI-only breach is WATCH and cannot independently BRAKE", () => {
  const { context, policy } = controlledPolicy();
  const result = evaluate(policy, context, [metric({ psi: 3 })]);
  assert.equal(result.status, "WATCH");
  assert.deepEqual(result.brakeMetricFamilies, ["psi"]);
});

test("KS-only breach is WATCH and cannot independently BRAKE", () => {
  const { context, policy } = controlledPolicy();
  assert.equal(evaluate(policy, context, [metric({ ksStatistic: 3 })]).status, "WATCH");
});

test("JSD-only breach is WATCH and cannot independently BRAKE", () => {
  const { context, policy } = controlledPolicy();
  assert.equal(evaluate(policy, context, [metric({ jsd: 3 })]).status, "WATCH");
});

test("multiple moderate breaches remain WATCH below brake limits", () => {
  const { context, policy } = controlledPolicy();
  const result = evaluate(policy, context, [metric({ psi: 1.5, ksStatistic: 1.5 })]);
  assert.equal(result.status, "WATCH");
  assert.equal(result.brakeMetricFamilies.length, 0);
});

test("two brake-level metric families produce BRAKE", () => {
  const { context, policy } = controlledPolicy();
  const result = evaluate(policy, context, [metric({ psi: 3, ksStatistic: 3 })]);
  assert.equal(result.status, "BRAKE");
  assert.deepEqual(result.brakeMetricFamilies, ["psi", "ksStatistic"]);
});

test("one moderate breach produces WATCH", () => {
  const { context, policy } = controlledPolicy();
  assert.equal(evaluate(policy, context, [metric({ psi: 1.5 })]).status, "WATCH");
});

test("all metrics within limits produce STABLE", () => {
  const { context, policy } = controlledPolicy();
  const result = evaluate(policy, context, [metric()]);
  assert.equal(result.valid, true);
  assert.equal(result.status, "STABLE");
});

test("canonical validator returns valid policy provenance", () => {
  const { context, policy } = builtPolicy();
  const result = validateCanonicalShadowDriftPolicyV1({
    policy,
    strategyIdentityDigest: context.strategyResolution.strategyIdentityDigest,
    modelIdentityDigest: context.modelResolution.modelIdentityDigest,
    referenceIdentity: context.referenceResolution.referenceIdentity,
    market: "CRYPTO_FUTURES",
    timeframe: "15m",
    asOf: AS_OF,
  });
  assert.equal(result.valid, true);
});
