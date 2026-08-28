import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { BASELINE_MODEL, predictTinyModel } from "../src/tiny-model.js";
import { evaluateRules } from "../src/rules.js";
import { blendDeployedProbabilities } from "../src/deployment-inference.js";
import {
  SHADOW_BLEND_COLLAPSE_DIAGNOSTIC_SAFETY,
  buildAuthenticatedShadowBlendCollapseDiagnostic,
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

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const predictedClass = (probabilities) => ["bullish", "neutral", "bearish"].reduce((best, name) => probabilities[name] > probabilities[best] ? name : best, "bullish");

function features(macdHistogramPct = 0) {
  return {
    return1: 0.001,
    return5: 0,
    return20: 0,
    emaGap: 0,
    closeToEma20: 0,
    rsiCentered: 0,
    macdHistogramPct,
    atrPct: 0.01,
    volumeRatio: 1,
    trendSlope: 0,
    distanceToSupport: 0.02,
    distanceToResistance: 0.02,
    bollingerPosition: 0.5,
    breadth: 0,
    benchmarkReturn: 0,
    sentimentScore: 0,
    foreignNetRatio: 0,
    institutionNetRatio: 0,
    openInterestChange: 0,
    fundingRate: 0,
    fundingRateChange: 0,
    fundingRateZScore: 0,
    longShortBias: 0,
    basisRate: 0,
    markPremium: 0,
    marketMarkSpread: 0,
  };
}

function authenticatedFixture() {
  const model = { ...BASELINE_MODEL, id: "candidate-test-v1", trained: true };
  const modelArtifact = { schemaVersion: 1, status: "shadow_candidate", group: "crypto-futures-15m", model };
  const makeRecord = (id, symbol, actualDirection, macdHistogramPct, anchorTimestamp) => {
    const rowFeatures = features(macdHistogramPct);
    const rule = evaluateRules({ market: "CRYPTO_FUTURES" }, { features: rowFeatures, indicators: { rsi14: 50 } });
    const modelProbabilities = predictTinyModel(rowFeatures, model).probabilities;
    const blend = blendDeployedProbabilities(rule.score, modelProbabilities).probabilities;
    return {
      id,
      status: "settled",
      modelGroup: "crypto-futures-15m",
      modelId: model.id,
      referenceModelId: "tiny-linear-baseline-v0",
      symbol,
      timeframe: "15m",
      anchorTimestamp,
      candidateProbabilities: blend,
      candidateClass: predictedClass(blend),
      regime: { trend: macdHistogramPct > 0 ? "bull_trend" : macdHistogramPct < 0 ? "bear_trend" : "range" },
      features: rowFeatures,
      actualDirection,
    };
  };
  const state = {
    schemaVersion: 3,
    groups: {
      "crypto-futures-15m": {
        records: [
          makeRecord("a", "BTCUSDT", "bullish", 0.003, 1000),
          makeRecord("b", "ETHUSDT", "bearish", -0.003, 2000),
          makeRecord("c", "BTCUSDT", "neutral", 0, 3000),
        ],
      },
    },
  };
  const summary = {
    schemaVersion: 3,
    groups: {
      "crypto-futures-15m": {
        modelSelection: {
          source: "v1-vs-rule-baseline",
          candidateModelId: model.id,
          referenceModelId: "tiny-linear-baseline-v0",
        },
      },
    },
  };
  const stateBytes = Buffer.from(`${JSON.stringify(state, null, 2)}\n`);
  const summaryBytes = Buffer.from(`${JSON.stringify(summary, null, 2)}\n`);
  const manifest = {
    schemaVersion: 1,
    kind: "prediction-lab-shadow-state",
    researchCodeSha: "a".repeat(40),
    sourceGeneratedHead: "a".repeat(40),
    candidateModelIds: [model.id],
    referenceModelIds: ["tiny-linear-baseline-v0"],
    stateSha256: sha256(stateBytes),
    summarySha256: sha256(summaryBytes),
    sha256: sha256(Buffer.concat([stateBytes, Buffer.from([0]), summaryBytes])),
    branchWrite: false,
    liveOrderAllowed: false,
    privateAccountRequestAllowed: false,
  };
  return {
    manifestBytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
    stateBytes,
    summaryBytes,
    modelArtifactBytes: Buffer.from(`${JSON.stringify(modelArtifact, null, 2)}\n`),
    artifactIdentity: { workflowRunId: 123, artifactId: 456, artifactDigest: `sha256:${"b".repeat(64)}` },
    modelBlobSha: "c".repeat(40),
  };
}

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

test("detects rule-neutral dominance suppressing model-only actionable signals without authorizing retuning", () => {
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
  assert.equal(result.failureModeVerdict, "RULE_NEUTRAL_DOMINANCE_PROPAGATES_TO_BLEND");
  assert.equal(result.metrics.modelOnlyActionableN, 8);
  assert.equal(result.metrics.modelOnlyActionableSuppressionRate, 1);
  assert.equal(result.lanes.rule.distribution.neutralRate, 1);
  assert.equal(result.lanes.blend.distribution.neutralRate, 1);
  assert.equal(result.causalProof, false);
  assert.equal(result.safety.blendWeightModified, false);
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
  assert.equal(result.lanes.blend.quality.perClass.SHORT.recall, null);
});

test("authenticates immutable artifact bytes and proves exact persisted Blend reconstruction", () => {
  const fixture = authenticatedFixture();
  const result = buildAuthenticatedShadowBlendCollapseDiagnostic({ ...fixture, minSettledN: 3 });
  assert.equal(result.authenticatedEvidence.exactBlendParity, true);
  assert.ok(result.authenticatedEvidence.maxReconstructionError <= 1e-6);
  assert.equal(result.authenticatedEvidence.workflowRunId, 123);
  assert.equal(result.authenticatedEvidence.artifactId, 456);
  assert.equal(result.authenticatedEvidence.modelBlobSha, "c".repeat(40));
  assert.equal(result.mechanicalRootCause.NEUTRAL_COLLAPSE_FIXED, false);
  assert.equal(result.referenceDriftEvidence.status, "MISSING_EVIDENCE");
  assert.equal(result.referenceDriftEvidence.psi, null);
});

test("fails closed on tampered state bytes, persisted Blend mismatch, and unsafe artifact flags", () => {
  const fixture = authenticatedFixture();
  assert.throws(() => buildAuthenticatedShadowBlendCollapseDiagnostic({ ...fixture, stateBytes: Buffer.concat([fixture.stateBytes, Buffer.from(" ")]), minSettledN: 3 }), /digest mismatch/u);

  const unsafeManifest = JSON.parse(fixture.manifestBytes.toString("utf8"));
  unsafeManifest.liveOrderAllowed = true;
  assert.throws(() => buildAuthenticatedShadowBlendCollapseDiagnostic({ ...fixture, manifestBytes: Buffer.from(JSON.stringify(unsafeManifest)), minSettledN: 3 }), /safety flags/u);
});

test("rejects mixed timeframes and duplicate observation identities", () => {
  assert.throws(() => buildShadowBlendCollapseDiagnostic({ observations: [{ ...row("1", "LONG", "LONG", "LONG", "LONG"), timeframe: "1h" }], minSettledN: 3 }), /15m|mixed timeframe/u);
  assert.throws(() => buildShadowBlendCollapseDiagnostic({ observations: [row("same", "LONG", "LONG", "LONG", "LONG"), row("same", "SHORT", "SHORT", "SHORT", "SHORT", "BEAR"), row("3", "NEUTRAL", "NEUTRAL", "NEUTRAL", "NEUTRAL", "SIDEWAYS")], minSettledN: 3 }), /duplicate observation id/u);
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
