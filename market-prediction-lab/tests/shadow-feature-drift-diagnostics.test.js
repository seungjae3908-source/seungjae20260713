import test from "node:test";
import assert from "node:assert/strict";

import {
  buildReferenceArtifactReceipt,
  buildReferenceEvidenceProvenance,
  sha256Canonical,
} from "../src/research-cache-provenance.js";
import {
  buildShadowFeatureDriftDiagnostic,
  jensenShannonDivergence,
  kolmogorovSmirnovDistance,
  populationStabilityIndex,
} from "../src/shadow-feature-drift-diagnostics.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const DIGEST_A = "1".repeat(64);
const DIGEST_B = "2".repeat(64);
const DIGEST_C = "3".repeat(64);
const DIGEST_D = "4".repeat(64);
const DIGEST_E = "5".repeat(64);
const DIGEST_F = "6".repeat(64);
const DIGEST_G = "7".repeat(64);
const NOW = "2026-08-25T12:00:00.000Z";

function modelArtifact(overrides = {}) {
  return {
    sourceDatasets: ["btc-test", "eth-test"],
    classCounts: { train: { bullish: 10, neutral: 12, bearish: 9 }, validation: { bullish: 3, neutral: 4, bearish: 3 } },
    model: {
      id: "candidate-v1",
      featureOrder: ["x", "y"],
      normalization: { mean: [1, 2], scale: [2, 4] },
      ...overrides,
    },
  };
}

function record({ id = "r", symbol = "BTCUSDT", timeframe = "15m", anchorTimestamp = 1000, x = 1, y = 2, actualDirection = "neutral", candidateProbabilities = { bullish: 0.2, neutral: 0.6, bearish: 0.2 }, featureAvailability = {}, trend = "range" } = {}) {
  const candidateClass = Object.entries(candidateProbabilities).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0][0];
  return {
    id,
    modelId: "candidate-v1",
    referenceModelId: "baseline-v0",
    symbol,
    timeframe,
    anchorTimestamp,
    status: "settled",
    actualDirection,
    candidateClass,
    candidateProbabilities,
    features: y === undefined ? { x } : { x, y },
    featureAvailability,
    regime: { trend, key: `${trend}:normal` },
  };
}

function provenance(overrides = {}, { expired = false } = {}) {
  const artifact = modelArtifact();
  const receipt = buildReferenceArtifactReceipt({
    artifactId: "reference-artifact-1",
    artifactName: "raw-train-validation",
    artifactReference: "actions://reference-artifact-1",
    outerArtifactDigest: DIGEST_G,
    createdAt: "2026-08-24T00:00:00.000Z",
    expiresAt: expired ? "2026-08-25T00:00:00.000Z" : "2026-09-25T00:00:00.000Z",
  });
  return buildReferenceEvidenceProvenance({
    datasetId: "dataset-v1",
    datasetDigest: DIGEST_A,
    strategyIdentityDigest: DIGEST_B,
    researchCodeSha: SHA_A,
    trainingCodeSha: SHA_B,
    modelSha: sha256Canonical(artifact),
    preprocessingVersion: "preprocess-v1",
    featureOrderDigest: sha256Canonical(artifact.model.featureOrder),
    trainSplitDigest: DIGEST_C,
    validationSplitDigest: DIGEST_D,
    rawArtifactDigest: DIGEST_E,
    measuredAt: "2026-08-24T12:00:00.000Z",
    artifactReceipt: receipt,
    ...overrides,
  });
}

function referenceBundle({ expected = provenance(), actual = expected, envelope = {}, trainRecords, validationRecords } = {}) {
  return {
    expectedReferenceProvenance: expected,
    referenceEvidence: {
      sourceKind: "RAW_TRAIN_VALIDATION",
      reconstructed: false,
      shadowDerived: false,
      splitAttestations: {
        train: { sourceKind: "RAW_TRAIN", modelSha: actual.modelSha, splitDigest: actual.trainSplitDigest },
        validation: { sourceKind: "RAW_VALIDATION", modelSha: actual.modelSha, splitDigest: actual.validationSplitDigest },
      },
      provenance: actual,
      trainRecords: trainRecords ?? [record({ id: "t1", anchorTimestamp: 100, x: 0, y: 1 }), record({ id: "t2", anchorTimestamp: 200, x: 1, y: 2 })],
      validationRecords: validationRecords ?? [record({ id: "v1", anchorTimestamp: 300, x: 2, y: 3 }), record({ id: "v2", anchorTimestamp: 400, x: 3, y: 4 })],
      ...envelope,
    },
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
    generatedAt: Date.parse(NOW),
    referenceNow: NOW,
    ...overrides,
  });
}

test("PSI and KS are deterministic and surface shifted distributions", () => {
  const reference = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4];
  const current = [4, 4, 5, 5, 6, 6, 7, 7, 8, 8];
  assert.equal(populationStabilityIndex(reference, current, { bins: 5 }), populationStabilityIndex(reference, current, { bins: 5 }));
  assert.equal(kolmogorovSmirnovDistance(reference, current), kolmogorovSmirnovDistance(reference, current));
  assert.ok(populationStabilityIndex(reference, current, { bins: 5 }) > 0);
  assert.ok(kolmogorovSmirnovDistance(reference, current) > 0);
});

test("JSD is zero for identical samples, symmetric, deterministic, finite, and non-negative", () => {
  const left = [0, 0, 1, 1, 2, 2];
  const right = [2, 2, 3, 3, 4, 4];
  assert.equal(jensenShannonDivergence(left, left), 0);
  assert.equal(jensenShannonDivergence(left, right), jensenShannonDivergence(right, left));
  assert.equal(jensenShannonDivergence(left, right), jensenShannonDivergence(left, right));
  assert.ok(Number.isFinite(jensenShannonDivergence(left, right)));
  assert.ok(jensenShannonDivergence(left, right) >= 0);
});

test("JSD fails closed on malformed or empty empirical samples", () => {
  assert.throws(() => jensenShannonDivergence([], [1]), /empty/);
  assert.throws(() => jensenShannonDivergence([1], []), /empty/);
  assert.throws(() => jensenShannonDivergence([1, Number.NaN], [1, 2]), /non-finite/);
  assert.throws(() => jensenShannonDivergence("not-an-array", [1]), /must be an array/);
});

test("diagnostic fails closed on empty, model, scaler, timeframe, and future-data violations", () => {
  assert.throws(() => build([]), /empty shadow sample/);
  assert.throws(() => buildShadowFeatureDriftDiagnostic({ records: [record()], modelArtifact: modelArtifact(), canonicalFeatureOrder: ["y", "x"], researchCodeSha: SHA_A, shadowResearchCodeSha: SHA_B, modelGroup: "x" }), /feature order mismatch/);
  assert.throws(() => buildShadowFeatureDriftDiagnostic({ records: [record()], modelArtifact: modelArtifact({ normalization: { mean: [1, 2], scale: [2] } }), canonicalFeatureOrder: ["x", "y"], researchCodeSha: SHA_A, shadowResearchCodeSha: SHA_B, modelGroup: "x" }), /scaler mismatch/);
  assert.throws(() => build([record({ featureAvailability: { fundingTimestamp: 1001 } })]), /future feature timestamp/);
  assert.throws(() => build([record({ id: "a", timeframe: "15m" }), record({ id: "b", timeframe: "1h", anchorTimestamp: 2000 })]), /mixed timeframe aggregation/);
});

test("confidence, entropy, class-conditional summaries, and zero support stay explicit", () => {
  const diagnostic = build([
    record({ id: "a", anchorTimestamp: 1000, actualDirection: "bullish", candidateProbabilities: { bullish: 0.7, neutral: 0.2, bearish: 0.1 } }),
    record({ id: "b", anchorTimestamp: 2000, actualDirection: "neutral", candidateProbabilities: { bullish: 0.1, neutral: 0.8, bearish: 0.1 } }),
  ]);
  const probabilities = diagnostic.diagnostics.probabilities;
  assert.equal(probabilities.top1.mean, 0.75);
  assert.equal(probabilities.top2.mean, 0.15000000000000002);
  assert.equal(probabilities.confidenceMargin.mean, 0.6);
  assert.ok(probabilities.entropy.mean > 0);
  assert.equal(probabilities.classConditional.bullish.count, 1);
  assert.equal(probabilities.classConditional.neutral.predictedClassDistribution.neutral, 1);
  assert.equal(probabilities.classConditional.bearish.count, 0);
  assert.equal(probabilities.classConditional.bearish.entropy.mean, null);
});

test("Bull, Bear, and Sideways regimes include distribution, support, recall, confidence, and entropy", () => {
  const diagnostic = build([
    record({ id: "bull", trend: "uptrend", actualDirection: "bullish", candidateProbabilities: { bullish: 0.7, neutral: 0.2, bearish: 0.1 } }),
    record({ id: "bear", trend: "downtrend", anchorTimestamp: 2000, actualDirection: "bearish", candidateProbabilities: { bullish: 0.1, neutral: 0.8, bearish: 0.1 } }),
    record({ id: "side", trend: "range", anchorTimestamp: 3000, actualDirection: "neutral", candidateProbabilities: { bullish: 0.1, neutral: 0.8, bearish: 0.1 } }),
  ]);
  assert.deepEqual(Object.keys(diagnostic.diagnostics.byRegime), ["Bull", "Bear", "Sideways"]);
  assert.equal(diagnostic.diagnostics.byRegime.Bull.probabilities.predictedDirectionalDistribution.LONG, 1);
  assert.equal(diagnostic.diagnostics.byRegime.Bear.directionalQuality.bearRecall, 0);
  assert.equal(diagnostic.diagnostics.byRegime.Sideways.directionalQuality.neutralRecall, 1);
  assert.ok(diagnostic.diagnostics.byRegime.Bull.probabilities.top1.mean > 0);
  assert.ok(diagnostic.diagnostics.byRegime.Bull.probabilities.entropy.mean > 0);
});

test("directional quality keeps Bear recall null when actual bearish support is zero", () => {
  const diagnostic = build([
    record({ id: "a", actualDirection: "bullish" }),
    record({ id: "b", anchorTimestamp: 2000, actualDirection: "neutral" }),
  ]);
  assert.equal(diagnostic.diagnostics.directionalQuality.bearRecall, null);
  assert.ok(Number.isFinite(diagnostic.diagnostics.directionalQuality.macroF1));
  assert.ok(Number.isFinite(diagnostic.diagnostics.directionalQuality.balancedAccuracy));
});

test("feature summaries retain quantiles, normalized values, missing, zero, and clipping proxies", () => {
  const diagnostic = build([
    record({ id: "a", x: 0, y: 2 }),
    record({ id: "b", anchorTimestamp: 2000, x: 1, y: null }),
    record({ id: "c", anchorTimestamp: 3000, x: 2, y: 6 }),
    record({ id: "d", anchorTimestamp: 4000, x: 3, y: 8 }),
    record({ id: "e", anchorTimestamp: 5000, x: 4, y: 10 }),
  ]);
  const x = diagnostic.diagnostics.features.x;
  assert.equal(x.raw.p01, 0.04);
  assert.equal(x.raw.p25, 1);
  assert.equal(x.raw.p50, 2);
  assert.equal(x.raw.p75, 3);
  assert.equal(x.raw.p99, 3.96);
  assert.ok(Number.isFinite(x.normalized.mean));
  assert.ok(Number.isFinite(x.normalized.std));
  assert.equal(x.raw.zeroRatio, 0.2);
  assert.equal(diagnostic.diagnostics.features.y.raw.missingRatio, 0.2);
  assert.ok(Number.isFinite(x.clippingRatio));
});

test("exact #664 provenance plus genuine raw TRAIN/VALIDATION enables PSI, KS, and JSD", () => {
  const bundle = referenceBundle();
  const diagnostic = build([
    record({ id: "c1", anchorTimestamp: 1000, x: 10, y: 20 }),
    record({ id: "c2", anchorTimestamp: 2000, x: 12, y: 22 }),
  ], bundle);
  assert.equal(diagnostic.referenceEvidence.status, "EXACT_IDENTITY_MATCH");
  assert.equal(diagnostic.referenceEvidence.receiptStatus, "VALID");
  assert.equal(diagnostic.referenceEvidence.rawTrainSampleN, 2);
  assert.equal(diagnostic.referenceEvidence.rawValidationSampleN, 2);
  assert.equal(diagnostic.DRIFT_EVIDENCE_VALID, true);
  assert.equal(diagnostic.DRIFT_PROXY_ONLY, false);
  assert.ok(Number.isFinite(diagnostic.diagnostics.features.x.psi));
  assert.ok(Number.isFinite(diagnostic.diagnostics.features.x.ksDistance));
  assert.ok(Number.isFinite(diagnostic.diagnostics.features.x.jsd));
});

test("missing and expired provenance keep true drift metrics unavailable", () => {
  const missing = build([record(), record({ id: "b", anchorTimestamp: 2000 })]);
  assert.equal(missing.referenceEvidence.status, "MISSING_EVIDENCE");
  assert.equal(missing.diagnostics.features.x.psi, null);
  assert.equal(missing.diagnostics.features.x.ksDistance, null);
  assert.equal(missing.diagnostics.features.x.jsd, null);
  assert.equal(missing.DRIFT_PROXY_ONLY, true);
  const expired = provenance({}, { expired: true });
  const expiredDiagnostic = build([record(), record({ id: "b", anchorTimestamp: 2000 })], referenceBundle({ expected: expired, actual: expired }));
  assert.equal(expiredDiagnostic.referenceEvidence.status, "REFERENCE_EXPIRED");
  assert.equal(expiredDiagnostic.DRIFT_EVIDENCE_VALID, false);
});

test("every exact identity mismatch is rejected before PSI, KS, or JSD", async (t) => {
  const cases = [
    ["strategy digest", { strategyIdentityDigest: DIGEST_F }],
    ["dataset id", { datasetId: "dataset-v2" }],
    ["dataset digest", { datasetDigest: DIGEST_F }],
    ["model", { modelSha: DIGEST_F }],
    ["preprocessing", { preprocessingVersion: "preprocess-v2" }],
    ["feature order", { featureOrderDigest: DIGEST_F }],
    ["train split", { trainSplitDigest: DIGEST_F }],
    ["validation split", { validationSplitDigest: DIGEST_F }],
    ["raw artifact", { rawArtifactDigest: DIGEST_F }],
  ];
  for (const [name, overrides] of cases) {
    await t.test(name, () => {
      const diagnostic = build([record(), record({ id: "b", anchorTimestamp: 2000 })], referenceBundle({ actual: provenance(overrides) }));
      assert.equal(diagnostic.referenceEvidence.status, "IDENTITY_MISMATCH");
      assert.equal(diagnostic.DRIFT_EVIDENCE_VALID, false);
      assert.equal(diagnostic.diagnostics.features.x.psi, null);
      assert.equal(diagnostic.diagnostics.features.x.ksDistance, null);
      assert.equal(diagnostic.diagnostics.features.x.jsd, null);
    });
  }
});

test("another-model TRAIN/VALIDATION, reconstructed, and Shadow-as-reference substitutions are rejected", async (t) => {
  const substitutions = [
    ["another model TRAIN", { splitAttestations: { train: { sourceKind: "RAW_TRAIN", modelSha: DIGEST_F, splitDigest: DIGEST_C }, validation: { sourceKind: "RAW_VALIDATION", modelSha: provenance().modelSha, splitDigest: DIGEST_D } } }],
    ["another model VALIDATION", { splitAttestations: { train: { sourceKind: "RAW_TRAIN", modelSha: provenance().modelSha, splitDigest: DIGEST_C }, validation: { sourceKind: "RAW_VALIDATION", modelSha: DIGEST_F, splitDigest: DIGEST_D } } }],
    ["reconstructed", { reconstructed: true }],
    ["Shadow as reference", { sourceKind: "SHADOW", shadowDerived: true }],
  ];
  for (const [name, envelope] of substitutions) {
    await t.test(name, () => {
      const diagnostic = build([record(), record({ id: "b", anchorTimestamp: 2000 })], referenceBundle({ envelope }));
      assert.equal(diagnostic.referenceEvidence.status, "IDENTITY_MISMATCH");
      assert.equal(diagnostic.diagnostics.features.x.jsd, null);
    });
  }
});

test("insufficient empirical sample is not promoted to valid drift evidence", () => {
  const bundle = referenceBundle({ trainRecords: [record({ id: "t", anchorTimestamp: 100 })], validationRecords: [record({ id: "v", anchorTimestamp: 200 })] });
  const diagnostic = build([record({ id: "only" })], bundle);
  assert.equal(diagnostic.referenceEvidence.status, "EXACT_IDENTITY_MATCH");
  assert.equal(diagnostic.driftEvidenceStatus, "INSUFFICIENT_EVIDENCE");
  assert.equal(diagnostic.DRIFT_EVIDENCE_VALID, false);
  assert.equal(diagnostic.DRIFT_PROXY_ONLY, true);
  assert.equal(diagnostic.diagnostics.features.x.jsd, null);
});

test("symbols and oldest/middle/newest windows remain separated", () => {
  const diagnostic = build([
    record({ id: "a", symbol: "BTCUSDT", anchorTimestamp: 1000 }),
    record({ id: "b", symbol: "BTCUSDT", anchorTimestamp: 2000 }),
    record({ id: "c", symbol: "ETHUSDT", anchorTimestamp: 3000 }),
    record({ id: "d", symbol: "ETHUSDT", anchorTimestamp: 4000 }),
    record({ id: "e", symbol: "ETHUSDT", anchorTimestamp: 5000 }),
    record({ id: "f", symbol: "ETHUSDT", anchorTimestamp: 6000 }),
  ]);
  assert.deepEqual(Object.keys(diagnostic.diagnostics.bySymbol), ["BTCUSDT", "ETHUSDT"]);
  assert.deepEqual(Object.keys(diagnostic.diagnostics.temporal), ["oldest", "middle", "newest"]);
  assert.equal(diagnostic.diagnostics.temporal.oldest.count, 2);
  assert.equal(diagnostic.diagnostics.temporal.middle.count, 2);
  assert.equal(diagnostic.diagnostics.temporal.newest.count, 2);
});

test("all six execution safety invariants stay fail-closed", () => {
  const safety = build([record(), record({ id: "b", anchorTimestamp: 2000 })]).safety;
  assert.equal(safety.LIVE_TRADING, false);
  assert.equal(safety.AUTO_TRADING, false);
  assert.equal(safety.REAL_ORDER_ENABLED, false);
  assert.equal(safety.PRIVATE_TRADING_API_ALLOWED, false);
  assert.equal(safety.executionAuthority, "NONE");
  assert.equal(safety.orderSubmitted, false);
});
