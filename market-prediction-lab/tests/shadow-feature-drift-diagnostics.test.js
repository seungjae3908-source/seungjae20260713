import test from "node:test";
import assert from "node:assert/strict";

import {
  buildShadowFeatureDriftDiagnostic,
  kolmogorovSmirnovDistance,
  populationStabilityIndex,
} from "../src/shadow-feature-drift-diagnostics.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function modelArtifact(overrides = {}) {
  return {
    sourceDatasets: ["btc-test", "eth-test"],
    classCounts: {
      train: { bullish: 10, neutral: 12, bearish: 9 },
      validation: { bullish: 3, neutral: 4, bearish: 3 },
    },
    model: {
      id: "candidate-v1",
      featureOrder: ["x", "y"],
      normalization: {
        mean: [1, 2],
        scale: [2, 4],
      },
      ...overrides,
    },
  };
}

function record({
  id,
  symbol = "BTCUSDT",
  timeframe = "15m",
  anchorTimestamp = 1000,
  x = 1,
  y,
  actualDirection = "neutral",
  candidateProbabilities = { bullish: 0.2, neutral: 0.6, bearish: 0.2 },
  featureAvailability = {},
} = {}) {
  const ranked = Object.entries(candidateProbabilities).sort((left, right) => right[1] - left[1]);
  return {
    id: id ?? `${symbol}-${timeframe}-${anchorTimestamp}`,
    modelId: "candidate-v1",
    referenceModelId: "baseline-v0",
    symbol,
    timeframe,
    anchorTimestamp,
    status: "settled",
    actualDirection,
    candidateClass: ranked[0][0],
    candidateProbabilities,
    features: y === undefined ? { x } : { x, y },
    featureAvailability,
    regime: { key: "range:low_volatility" },
  };
}

function build(records, overrides = {}) {
  return buildShadowFeatureDriftDiagnostic({
    records,
    modelArtifact: modelArtifact(),
    canonicalFeatureOrder: ["x", "y"],
    researchCodeSha: SHA_A,
    shadowResearchCodeSha: SHA_B,
    modelGroup: "crypto-futures-15m",
    generatedAt: 1234,
    ...overrides,
  });
}

test("PSI and KS are deterministic and surface shifted distributions", () => {
  const reference = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4];
  const current = [4, 4, 5, 5, 6, 6, 7, 7, 8, 8];
  const psi1 = populationStabilityIndex(reference, current, { bins: 5 });
  const psi2 = populationStabilityIndex(reference, current, { bins: 5 });
  const ks1 = kolmogorovSmirnovDistance(reference, current);
  const ks2 = kolmogorovSmirnovDistance(reference, current);
  assert.equal(psi1, psi2);
  assert.equal(ks1, ks2);
  assert.ok(psi1 > 0);
  assert.ok(ks1 > 0);
});

test("diagnostic fails closed on feature order mismatch", () => {
  assert.throws(() => buildShadowFeatureDriftDiagnostic({
    records: [record()],
    modelArtifact: modelArtifact(),
    canonicalFeatureOrder: ["y", "x"],
    researchCodeSha: SHA_A,
    shadowResearchCodeSha: SHA_B,
    modelGroup: "crypto-futures-15m",
  }), /feature order mismatch/);
});

test("diagnostic fails closed on scaler mismatch", () => {
  assert.throws(() => buildShadowFeatureDriftDiagnostic({
    records: [record()],
    modelArtifact: modelArtifact({ normalization: { mean: [1, 2], scale: [2] } }),
    canonicalFeatureOrder: ["x", "y"],
    researchCodeSha: SHA_A,
    shadowResearchCodeSha: SHA_B,
    modelGroup: "crypto-futures-15m",
  }), /scaler mismatch/);
});

test("diagnostic rejects future feature timestamps", () => {
  assert.throws(() => build([
    record({ anchorTimestamp: 1000, featureAvailability: { fundingTimestamp: 1001 } }),
  ]), /future feature timestamp/);
});

test("diagnostic fails closed on empty sample", () => {
  assert.throws(() => build([]), /empty shadow sample/);
});

test("diagnostic forbids mixed timeframe aggregation", () => {
  assert.throws(() => build([
    record({ id: "a", timeframe: "15m", anchorTimestamp: 1000 }),
    record({ id: "b", timeframe: "1h", anchorTimestamp: 2000 }),
  ]), /mixed timeframe aggregation is forbidden/);
});

test("missing and zero ratios remain explicit instead of being synthesized", () => {
  const diagnostic = build([
    record({ id: "a", symbol: "BTCUSDT", anchorTimestamp: 1000, x: 0, y: 2 }),
    record({ id: "b", symbol: "BTCUSDT", anchorTimestamp: 2000, x: 1 }),
    record({ id: "c", symbol: "ETHUSDT", anchorTimestamp: 3000, x: 2, y: 6 }),
  ]);
  const x = diagnostic.diagnostics.features.x.raw;
  const y = diagnostic.diagnostics.features.y.raw;
  assert.equal(x.count, 3);
  assert.equal(x.zeroCount, 1);
  assert.equal(x.zeroRatio, 1 / 3);
  assert.equal(y.count, 2);
  assert.equal(y.missingCount, 1);
  assert.equal(y.missingRatio, 1 / 3);
  assert.equal(diagnostic.diagnostics.features.x.psi, null);
  assert.equal(diagnostic.rootCauseVerdict, "INSUFFICIENT_EVIDENCE");
  assert.ok(diagnostic.limitations.includes("raw_train_validation_feature_samples_not_persisted"));
});

test("symbols stay separated and confidence collapse evidence is measurable", () => {
  const diagnostic = build([
    record({
      id: "btc-1",
      symbol: "BTCUSDT",
      anchorTimestamp: 1000,
      actualDirection: "bullish",
      candidateProbabilities: { bullish: 0.2, neutral: 0.7, bearish: 0.1 },
    }),
    record({
      id: "btc-2",
      symbol: "BTCUSDT",
      anchorTimestamp: 2000,
      actualDirection: "neutral",
      candidateProbabilities: { bullish: 0.1, neutral: 0.8, bearish: 0.1 },
    }),
    record({
      id: "eth-1",
      symbol: "ETHUSDT",
      anchorTimestamp: 3000,
      actualDirection: "bearish",
      candidateProbabilities: { bullish: 0.15, neutral: 0.75, bearish: 0.1 },
    }),
    record({
      id: "eth-2",
      symbol: "ETHUSDT",
      anchorTimestamp: 4000,
      actualDirection: "neutral",
      candidateProbabilities: { bullish: 0.2, neutral: 0.65, bearish: 0.15 },
    }),
  ]);
  assert.deepEqual(Object.keys(diagnostic.diagnostics.bySymbol), ["BTCUSDT", "ETHUSDT"]);
  assert.equal(diagnostic.diagnostics.bySymbol.BTCUSDT.count, 2);
  assert.equal(diagnostic.diagnostics.bySymbol.ETHUSDT.count, 2);
  assert.equal(diagnostic.diagnostics.probabilities.predictedClassDistribution.neutral, 4);
  assert.equal(diagnostic.diagnostics.probabilities.actualLabelDistribution.bullish, 1);
  assert.equal(diagnostic.diagnostics.probabilities.actualLabelDistribution.bearish, 1);
  assert.ok(diagnostic.diagnostics.probabilities.confidenceMargin.mean > 0);
});

test("true PSI and KS are computed only when raw reference records are supplied", () => {
  const current = [
    record({ id: "c1", anchorTimestamp: 1000, x: 10, y: 20 }),
    record({ id: "c2", anchorTimestamp: 2000, x: 12, y: 22 }),
  ];
  const referenceRecords = [
    record({ id: "r1", anchorTimestamp: 100, x: 0, y: 1 }),
    record({ id: "r2", anchorTimestamp: 200, x: 1, y: 2 }),
  ];
  const diagnostic = build(current, { referenceRecords });
  assert.ok(Number.isFinite(diagnostic.diagnostics.features.x.psi));
  assert.ok(Number.isFinite(diagnostic.diagnostics.features.x.ksDistance));
  assert.equal(diagnostic.limitations.length, 0);
});
