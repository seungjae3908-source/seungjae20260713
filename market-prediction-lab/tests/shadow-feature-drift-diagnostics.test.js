import test from "node:test";
import assert from "node:assert/strict";

import { buildShadowFeatureDriftDiagnostic, kolmogorovSmirnovDistance, populationStabilityIndex } from "../src/shadow-feature-drift-diagnostics.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function modelArtifact(overrides = {}) {
  return { model: { id: "candidate-v1", featureOrder: ["x", "y"], normalization: { mean: [1, 2], scale: [2, 4] }, ...overrides } };
}

function record({ id = "r", symbol = "BTCUSDT", timeframe = "15m", anchorTimestamp = 1000, x = 1, y = 2, actualDirection = "neutral", candidateProbabilities = { bullish: 0.2, neutral: 0.6, bearish: 0.2 }, featureAvailability = {} } = {}) {
  const candidateClass = Object.entries(candidateProbabilities).sort((a, b) => b[1] - a[1])[0][0];
  return { id, modelId: "candidate-v1", referenceModelId: "baseline-v0", symbol, timeframe, anchorTimestamp, status: "settled", actualDirection, candidateClass, candidateProbabilities, features: y === undefined ? { x } : { x, y }, featureAvailability };
}

function build(records, overrides = {}) {
  return buildShadowFeatureDriftDiagnostic({ records, modelArtifact: modelArtifact(), canonicalFeatureOrder: ["x", "y"], researchCodeSha: SHA_A, shadowResearchCodeSha: SHA_B, modelGroup: "crypto-futures-15m", generatedAt: 1234, ...overrides });
}

test("PSI and KS are deterministic and surface shifted distributions", () => {
  const reference = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4];
  const current = [4, 4, 5, 5, 6, 6, 7, 7, 8, 8];
  assert.equal(populationStabilityIndex(reference, current, { bins: 5 }), populationStabilityIndex(reference, current, { bins: 5 }));
  assert.equal(kolmogorovSmirnovDistance(reference, current), kolmogorovSmirnovDistance(reference, current));
  assert.ok(populationStabilityIndex(reference, current, { bins: 5 }) > 0);
  assert.ok(kolmogorovSmirnovDistance(reference, current) > 0);
});

test("diagnostic fails closed on model contract and future data", () => {
  assert.throws(() => buildShadowFeatureDriftDiagnostic({ records: [record()], modelArtifact: modelArtifact(), canonicalFeatureOrder: ["y", "x"], researchCodeSha: SHA_A, shadowResearchCodeSha: SHA_B, modelGroup: "x" }), /feature order mismatch/);
  assert.throws(() => buildShadowFeatureDriftDiagnostic({ records: [record()], modelArtifact: modelArtifact({ normalization: { mean: [1, 2], scale: [2] } }), canonicalFeatureOrder: ["x", "y"], researchCodeSha: SHA_A, shadowResearchCodeSha: SHA_B, modelGroup: "x" }), /scaler mismatch/);
  assert.throws(() => build([record({ featureAvailability: { fundingTimestamp: 1001 } })]), /future feature timestamp/);
});

test("missing and zero ratios stay explicit and PSI/KS remain unavailable without raw reference", () => {
  const diagnostic = build([
    record({ id: "a", anchorTimestamp: 1000, x: 0, y: 2 }),
    record({ id: "b", anchorTimestamp: 2000, x: 1, y: undefined }),
    record({ id: "c", anchorTimestamp: 3000, x: 2, y: 6 }),
  ]);
  assert.equal(diagnostic.diagnostics.features.x.raw.zeroRatio, 1 / 3);
  assert.equal(diagnostic.diagnostics.features.y.raw.missingRatio, 1 / 3);
  assert.equal(diagnostic.diagnostics.features.x.psi, null);
  assert.equal(diagnostic.diagnostics.features.x.ksDistance, null);
  assert.equal(diagnostic.trueDistributionDriftAvailable, false);
  assert.equal(diagnostic.rootCauseVerdict, "INSUFFICIENT_EVIDENCE");
});

test("true PSI and KS are computed only with raw reference records", () => {
  const current = [record({ id: "c1", anchorTimestamp: 1000, x: 10, y: 20 }), record({ id: "c2", anchorTimestamp: 2000, x: 12, y: 22 })];
  const referenceRecords = [record({ id: "r1", anchorTimestamp: 100, x: 0, y: 1 }), record({ id: "r2", anchorTimestamp: 200, x: 1, y: 2 })];
  const diagnostic = build(current, { referenceRecords });
  assert.ok(Number.isFinite(diagnostic.diagnostics.features.x.psi));
  assert.ok(Number.isFinite(diagnostic.diagnostics.features.x.ksDistance));
  assert.equal(diagnostic.trueDistributionDriftAvailable, true);
  assert.equal(diagnostic.rootCauseVerdict, "DRIFT_MEASURED_CAUSALITY_UNPROVEN");
});

test("symbols remain separated and mixed timeframe aggregation is forbidden", () => {
  const diagnostic = build([record({ id: "a", symbol: "BTCUSDT", anchorTimestamp: 1000 }), record({ id: "b", symbol: "ETHUSDT", anchorTimestamp: 2000 })]);
  assert.deepEqual(Object.keys(diagnostic.diagnostics.bySymbol), ["BTCUSDT", "ETHUSDT"]);
  assert.throws(() => build([record({ id: "a", timeframe: "15m" }), record({ id: "b", timeframe: "1h", anchorTimestamp: 2000 })]), /mixed timeframe aggregation/);
});
