import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { resolveCanonicalStrategyIdentity } from "../src/canonical-strategy-identity-v1.js";
import { sha256Canonical } from "../src/research-cache-provenance.js";
import {
  FROZEN_BLEND_WEIGHTS,
  buildCanonicalShadowDriftHandoffV1,
  buildDriftVerdictV1,
  buildFutureShadowObservationV1,
  buildFutureShadowSettlementEvidenceV1,
  buildNormalizedFeatureSnapshotV1,
  computeShadowObservationArtifactDigestV1,
  resolveModelIdentityMappingV1,
  resolveProducerStrategyIdentityV1,
  resolveTrainValidationReferenceV1,
  shadowEvidenceSafetyV1,
  settleFutureShadowObservationV1,
  validateFutureShadowObservationBatchV1,
  validateFutureShadowObservationV1,
} from "../src/shadow-evidence-handoff-v1.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const clone = (value) => structuredClone(value);
const AS_OF = "2026-08-26T00:30:00.000Z";

function jsonl(records) {
  return Buffer.from(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

function strategyInput(overrides = {}) {
  return {
    strategyId: "CRYPTO_FUTURES_SCALP_V1_LONG",
    strategyFamily: "CRYPTO_FUTURES_SCALP_V1",
    strategyVersion: "V1",
    market: "CRYPTO_FUTURES",
    direction: "LONG",
    timeframe: "15m",
    formulaIdentity: { family: "v1", rules: ["trend", "momentum"] },
    parameterHash: hash("params-v1"),
    researchCodeSha: "a".repeat(40),
    datasetId: "prediction-lab:15m:train-validation",
    datasetDigest: hash("dataset-v1"),
    datasetStart: "2025-01-01T00:00:00.000Z",
    datasetEnd: "2026-08-01T00:00:00.000Z",
    costPolicyVersion: "cost-v1",
    riskPolicyVersion: "risk-v1",
    evidenceSchemaVersion: "evidence-v1",
    ...overrides,
  };
}

function modelFixture() {
  return {
    id: "tiny-softmax-candidate-v1",
    trained: true,
    modelType: "multinomial-logistic-regression",
    featureOrder: ["return5", "atrPct"],
    normalization: { mean: [0, 2], scale: [1, 0.5] },
    temperature: 1,
    classes: {
      bullish: { bias: 0.1, weights: [0.5, -0.2] },
      neutral: { bias: 0, weights: [0.1, 0.1] },
      bearish: { bias: -0.1, weights: [-0.4, 0.2] },
    },
  };
}

function referenceRecords() {
  const train = [
    { id: "t1", features: { return5: -1, atrPct: 1.5 } },
    { id: "t2", features: { return5: -0.4, atrPct: 1.8 } },
    { id: "t3", features: { return5: 0.3, atrPct: 2.1 } },
    { id: "t4", features: { return5: 1.1, atrPct: 2.5 } },
  ];
  const validation = [
    { id: "v1", features: { return5: -0.8, atrPct: 1.6 } },
    { id: "v2", features: { return5: -0.1, atrPct: 2.0 } },
    { id: "v3", features: { return5: 0.5, atrPct: 2.2 } },
    { id: "v4", features: { return5: 1.3, atrPct: 2.7 } },
  ];
  return { train, validation, trainBytes: jsonl(train), validationBytes: jsonl(validation) };
}

function manifestFixture({ strategy = strategyInput(), model = modelFixture(), references = referenceRecords() } = {}) {
  const strategyResolved = resolveCanonicalStrategyIdentity(strategy);
  assert.equal(strategyResolved.status, "IDENTITY_COMPLETE");
  const modelBytes = Buffer.from(JSON.stringify(model), "utf8");
  return {
    manifest: {
      schemaVersion: "PredictionLabModelReferenceEvidenceV1",
      status: "VALID",
      referenceProvenanceStatus: "VALID",
      datasetId: strategy.datasetId,
      datasetDigest: strategy.datasetDigest,
      strategyIdentity: strategy,
      strategyIdentityDigest: strategyResolved.strategyIdentityDigest,
      researchCodeSha: strategy.researchCodeSha,
      trainingCodeSha: "b".repeat(40),
      modelSha: hash(modelBytes),
      modelShaSemantics: "sha256(exact UTF-8 bytes of model/exact-model.json; existing JSON.stringify model identity)",
      modelArtifactCanonicalDigest: sha256Canonical(model),
      preprocessingVersion: "prediction-lab-training-preprocessing-v1",
      featureOrder: [...model.featureOrder],
      featureOrderDigest: sha256Canonical(model.featureOrder),
      trainSplitDigest: hash(references.trainBytes),
      validationSplitDigest: hash(references.validationBytes),
      trainSampleN: references.train.length,
      validationSampleN: references.validation.length,
      rawArtifactDigest: hash("raw-artifact-v1"),
      measuredAt: "2026-08-25T23:00:00.000Z",
      sourceAttestation: {
        sourceKind: "GENUINE_MARKET_DATA",
        reconstructed: false,
        synthetic: false,
        shadowDerived: false,
        finalHoldoutIncluded: false,
      },
      splitAttestations: {
        train: { sourceKind: "RAW_TRAIN" },
        validation: { sourceKind: "RAW_VALIDATION" },
      },
      artifactReceipt: {
        artifactId: "701-reference-1",
        artifactReference: "actions://run/701/artifact/1",
        outerArtifactDigest: hash("outer-artifact-v1"),
        createdAt: "2026-08-25T23:30:00.000Z",
        expiresAt: "2026-09-30T00:00:00.000Z",
      },
    },
    model,
    modelBytes,
    references,
    strategy,
    strategyResolved,
  };
}

function resolutions(fixture = manifestFixture()) {
  const strategyResolution = resolveProducerStrategyIdentityV1(fixture.manifest, fixture.strategy);
  assert.equal(strategyResolution.valid, true);
  const modelResolution = resolveModelIdentityMappingV1({
    producerManifest: fixture.manifest,
    exactModelBytes: fixture.modelBytes,
    modelArtifact: fixture.model,
    strategyResolution,
  });
  assert.equal(modelResolution.valid, true);
  const referenceResolution = resolveTrainValidationReferenceV1({
    producerManifest: fixture.manifest,
    trainReferenceBytes: fixture.references.trainBytes,
    validationReferenceBytes: fixture.references.validationBytes,
    asOf: AS_OF,
  });
  assert.equal(referenceResolution.valid, true);
  return { fixture, strategyResolution, modelResolution, referenceResolution };
}

function inference(index = 0) {
  const rows = [
    {
      ruleProbabilities: { bullish: 0.72, neutral: 0.18, bearish: 0.10 },
      modelProbabilities: { bullish: 0.60, neutral: 0.24, bearish: 0.16 },
      probabilities: { bullish: 0.678, neutral: 0.201, bearish: 0.121 },
    },
    {
      ruleProbabilities: { bullish: 0.20, neutral: 0.25, bearish: 0.55 },
      modelProbabilities: { bullish: 0.28, neutral: 0.30, bearish: 0.42 },
      probabilities: { bullish: 0.228, neutral: 0.2675, bearish: 0.5045 },
    },
    {
      ruleProbabilities: { bullish: 0.30, neutral: 0.50, bearish: 0.20 },
      modelProbabilities: { bullish: 0.32, neutral: 0.48, bearish: 0.20 },
      probabilities: { bullish: 0.307, neutral: 0.493, bearish: 0.20 },
    },
    {
      ruleProbabilities: { bullish: 0.65, neutral: 0.22, bearish: 0.13 },
      modelProbabilities: { bullish: 0.55, neutral: 0.28, bearish: 0.17 },
      probabilities: { bullish: 0.615, neutral: 0.241, bearish: 0.144 },
    },
  ];
  return rows[index % rows.length];
}

function makePendingObservations(context = resolutions()) {
  const raw = [
    { return5: -0.7, atrPct: 1.7 },
    { return5: 0.1, atrPct: 2.0 },
    { return5: 0.7, atrPct: 2.4 },
    { return5: 1.4, atrPct: 2.8 },
  ];
  return raw.map((features, index) => buildFutureShadowObservationV1({
    observationId: `future-${index + 1}`,
    observedAt: `2026-08-26T00:${String(index + 10).padStart(2, "0")}:00.000Z`,
    signalAt: `2026-08-26T00:${String(index + 9).padStart(2, "0")}:00.000Z`,
    symbol: index % 2 ? "ETHUSDT" : "BTCUSDT",
    market: context.strategyResolution.strategyIdentity.market,
    timeframe: context.strategyResolution.strategyIdentity.timeframe,
    direction: context.strategyResolution.strategyIdentity.direction,
    strategyIdentity: context.strategyResolution.strategyIdentity,
    strategyIdentityDigest: context.strategyResolution.strategyIdentityDigest,
    modelIdentity: context.modelResolution.modelIdentity,
    modelIdentityDigest: context.modelResolution.modelIdentityDigest,
    referenceIdentity: context.referenceResolution.referenceIdentity,
    regime: { key: index < 2 ? "Bear" : "Bull" },
    rawFeatureSnapshot: features,
    normalizedFeatureSnapshot: {
      return5: features.return5,
      atrPct: (features.atrPct - 2) / 0.5,
    },
    inference: inference(index),
    referencePrice: 100 + index,
    priceProvenance: {
      provider: "bitget-public-v2",
      source: "fixture-public-market-data",
      priceField: "close",
      candleTimestamp: Date.parse(`2026-08-26T00:${String(index + 8).padStart(2, "0")}:00.000Z`),
      signalAt: `2026-08-26T00:${String(index + 9).padStart(2, "0")}:00.000Z`,
    },
    dataFreshness: { status: "FRESH", ageMs: 500, maxAgeMs: 60_000 },
    sourceProvenance: {
      sourceKind: "GENUINE_SHADOW_OBSERVATION",
      provider: "bitget-public-v2",
      capturedAtObservationTime: true,
      reconstructed: false,
      synthetic: false,
      replayed: false,
      historicalBackfill: false,
    },
  }));
}

function settlementFor(observation, index = 0, actualDirection = ["bullish", "bearish", "neutral", "bullish"][index % 4]) {
  const signalPrice = observation.referencePrice;
  const futureCandles = [
    { timestamp: Date.parse(`2026-08-26T00:${String(index + 20).padStart(2, "0")}:00.000Z`), high: signalPrice * 1.02, low: signalPrice * 0.99, close: signalPrice * 1.01 },
    { timestamp: Date.parse(`2026-08-26T00:${String(index + 21).padStart(2, "0")}:00.000Z`), high: signalPrice * 1.03, low: signalPrice * 0.98, close: signalPrice * (index % 2 ? 0.99 : 1.02) },
  ];
  return buildFutureShadowSettlementEvidenceV1({
    observation,
    actualDirection,
    settlementPrice: futureCandles.at(-1).close,
    futureCandles,
    horizonBars: futureCandles.length,
    outcomeAt: `2026-08-26T00:${String(index + 30).padStart(2, "0")}:00.000Z`,
    settledAt: "2026-08-26T01:00:00.000Z",
    costEvidence: { applicable: false, reason: "SHADOW_NO_EXECUTION", commission: null, slippage: null, funding: null, netReturn: null },
    sourceProvenance: {
      sourceKind: "GENUINE_FUTURE_SHADOW_OUTCOME",
      provider: "bitget-public-v2",
      capturedAfterObservation: true,
      reconstructed: false,
      synthetic: false,
      replayed: false,
      historicalBackfill: false,
    },
  });
}

function makeObservations(context = resolutions()) {
  return makePendingObservations(context).map((observation, index) => settleFutureShadowObservationV1(observation, settlementFor(observation, index)));
}

function driftPolicy({ watch = { psi: 10, ksStatistic: 1, jsd: 1 }, brake = { psi: 20, ksStatistic: 2, jsd: 2, minimumTriggeredMetrics: 2 } } = {}) {
  const body = {
    schemaVersion: "canonical-drift-policy-v1",
    source: "CANONICAL_EXISTING_POLICY",
    hindsightTuned: false,
    watch,
    brake,
  };
  return { ...body, policyDigest: sha256Canonical(body) };
}

function fullHandoff(overrides = {}) {
  const context = resolutions();
  const observations = makeObservations(context);
  return buildCanonicalShadowDriftHandoffV1({
    producerManifest: context.fixture.manifest,
    exactModelBytes: context.fixture.modelBytes,
    modelArtifact: context.fixture.model,
    trainReferenceBytes: context.fixture.references.trainBytes,
    validationReferenceBytes: context.fixture.references.validationBytes,
    observations,
    expectedStrategyInput: context.fixture.strategy,
    canonicalDriftPolicy: driftPolicy(),
    asOf: AS_OF,
    ...overrides,
  });
}

test("valid canonical Strategy Identity handoff resolves from #687 contract", () => {
  const fixture = manifestFixture();
  const result = resolveProducerStrategyIdentityV1(fixture.manifest, fixture.strategy);
  assert.equal(result.status, "IDENTITY_COMPLETE");
  assert.equal(result.strategyIdentityDigest, fixture.strategyResolved.strategyIdentityDigest);
  assert.equal(result.strategyIdentity.market, "CRYPTO_FUTURES");
});

test("missing Strategy Identity stays MISSING_EVIDENCE", () => {
  const fixture = manifestFixture();
  fixture.manifest.strategyIdentity = null;
  fixture.manifest.strategyIdentityDigest = null;
  const result = resolveProducerStrategyIdentityV1(fixture.manifest);
  assert.equal(result.status, "MISSING_EVIDENCE");
  assert.equal(result.valid, false);
});

test("mismatched Strategy Identity is rejected", () => {
  const fixture = manifestFixture();
  const other = strategyInput({ direction: "SHORT" });
  const result = resolveProducerStrategyIdentityV1(fixture.manifest, other);
  assert.equal(result.status, "IDENTITY_MISMATCH");
});

test("formula parameter timeframe market direction and dataset identity mismatches all fail closed", async (t) => {
  const cases = {
    formula: { formulaIdentity: { family: "other", rules: ["trend"] } },
    parameter: { parameterHash: hash("other-parameters") },
    timeframe: { timeframe: "1h" },
    market: { market: "CRYPTO_SPOT" },
    direction: { direction: "SHORT" },
    datasetId: { datasetId: "other-dataset" },
    datasetDigest: { datasetDigest: hash("other-dataset") },
  };
  for (const [name, overrides] of Object.entries(cases)) {
    await t.test(name, () => {
      const fixture = manifestFixture();
      const result = resolveProducerStrategyIdentityV1(fixture.manifest, strategyInput(overrides));
      assert.equal(result.status, "IDENTITY_MISMATCH");
      assert.equal(result.valid, false);
    });
  }
});

test("exact model bytes SHA mismatch is distinct from canonical artifact digest", () => {
  const context = resolutions();
  const changedBytes = Buffer.from(`${context.fixture.modelBytes.toString("utf8")}\n`, "utf8");
  const result = resolveModelIdentityMappingV1({
    producerManifest: context.fixture.manifest,
    exactModelBytes: changedBytes,
    strategyResolution: context.strategyResolution,
  });
  assert.equal(result.status, "IDENTITY_MISMATCH");
  assert.equal(result.reason, "EXACT_MODEL_BYTES_SHA_MISMATCH");
});

test("canonical model artifact digest mismatch is rejected without comparing digest semantics", () => {
  const fixture = manifestFixture();
  fixture.manifest.modelArtifactCanonicalDigest = hash("wrong-canonical-model");
  const strategyResolution = resolveProducerStrategyIdentityV1(fixture.manifest, fixture.strategy);
  const result = resolveModelIdentityMappingV1({ producerManifest: fixture.manifest, exactModelBytes: fixture.modelBytes, strategyResolution });
  assert.equal(result.status, "IDENTITY_MISMATCH");
  assert.equal(result.reason, "CANONICAL_MODEL_ARTIFACT_DIGEST_MISMATCH");
});

test("model identity keeps exact-byte SHA and canonical artifact digest as separate provenance fields", () => {
  const context = resolutions();
  const identity = context.modelResolution.modelIdentity;
  assert.equal(identity.exactModelBytesSha, context.fixture.manifest.modelSha);
  assert.equal(identity.canonicalModelArtifactDigest, context.fixture.manifest.modelArtifactCanonicalDigest);
  assert.notEqual(identity.exactModelBytesShaSemantics, identity.canonicalModelArtifactDigestSemantics);
  assert.equal(identity.strategyIdentityDigest, context.strategyResolution.strategyIdentityDigest);
});

test("featureOrder mismatch fails closed", () => {
  const fixture = manifestFixture();
  fixture.manifest.featureOrderDigest = hash("wrong-feature-order");
  const strategyResolution = resolveProducerStrategyIdentityV1(fixture.manifest, fixture.strategy);
  const result = resolveModelIdentityMappingV1({ producerManifest: fixture.manifest, exactModelBytes: fixture.modelBytes, strategyResolution });
  assert.equal(result.status, "IDENTITY_MISMATCH");
  assert.equal(result.reason, "FEATURE_ORDER_DIGEST_MISMATCH");
});

test("preprocessingVersion mismatch between reference and observation fails closed", () => {
  const context = resolutions();
  const observation = clone(makeObservations(context)[0]);
  observation.referenceIdentity.preprocessingVersion = "other-preprocessing";
  observation.artifactDigest = computeShadowObservationArtifactDigestV1(observation);
  const result = validateFutureShadowObservationV1({ observation, ...context, featureOrder: context.fixture.model.featureOrder });
  assert.equal(result.status, "IDENTITY_MISMATCH");
  assert.match(result.reason, /PREPROCESSINGVERSION_MISMATCH/);
});

test("normalized feature snapshot must reproduce the exact model preprocessing identity", () => {
  const context = resolutions();
  const observation = clone(makeObservations(context)[0]);
  observation.normalizedFeatureSnapshot.return5 += 0.01;
  observation.artifactDigest = computeShadowObservationArtifactDigestV1(observation);
  const result = validateFutureShadowObservationV1({ observation, ...context, featureOrder: context.fixture.model.featureOrder });
  assert.equal(result.status, "IDENTITY_MISMATCH");
  assert.equal(result.reason, "NORMALIZED_FEATURE_SNAPSHOT_MISMATCH");
  assert.deepEqual(buildNormalizedFeatureSnapshotV1({
    rawFeatureSnapshot: observation.rawFeatureSnapshot,
    exactModel: context.fixture.model,
  }), { return5: -0.7, atrPct: -0.6000000000000001 });
});

test("expired reference emits REFERENCE_EXPIRED and no numeric drift credit", () => {
  const fixture = manifestFixture();
  fixture.manifest.artifactReceipt.expiresAt = "2026-08-25T00:00:00.000Z";
  const result = resolveTrainValidationReferenceV1({
    producerManifest: fixture.manifest,
    trainReferenceBytes: fixture.references.trainBytes,
    validationReferenceBytes: fixture.references.validationBytes,
    asOf: AS_OF,
  });
  assert.equal(result.status, "REFERENCE_EXPIRED");
});

test("missing TRAIN reference remains MISSING_EVIDENCE", () => {
  const fixture = manifestFixture();
  const result = resolveTrainValidationReferenceV1({ producerManifest: fixture.manifest, validationReferenceBytes: fixture.references.validationBytes, asOf: AS_OF });
  assert.equal(result.status, "MISSING_EVIDENCE");
  assert.equal(result.reason, "TRAIN_REFERENCE_BYTES_MISSING");
});

test("missing VALIDATION reference remains MISSING_EVIDENCE", () => {
  const fixture = manifestFixture();
  const result = resolveTrainValidationReferenceV1({ producerManifest: fixture.manifest, trainReferenceBytes: fixture.references.trainBytes, asOf: AS_OF });
  assert.equal(result.status, "MISSING_EVIDENCE");
  assert.equal(result.reason, "VALIDATION_REFERENCE_BYTES_MISSING");
});

test("genuine future Shadow sample validates against canonical identity chain", () => {
  const context = resolutions();
  const observations = makeObservations(context);
  const result = validateFutureShadowObservationBatchV1({ observations, ...context, featureOrder: context.fixture.model.featureOrder });
  assert.equal(result.status, "VALID");
  assert.equal(result.sampleN, 4);
});

test("historical observation missing rule/model components stays MISSING_EVIDENCE", () => {
  const context = resolutions();
  const historical = {
    observationId: "old-1",
    observedAt: "2026-08-20T00:00:00.000Z",
    candidateProbabilities: { bullish: 0.6, neutral: 0.2, bearish: 0.2 },
  };
  const result = validateFutureShadowObservationV1({ observation: historical, ...context, featureOrder: context.fixture.model.featureOrder });
  assert.equal(result.status, "MISSING_EVIDENCE");
});

test("each missing RULE_ONLY MODEL_ONLY or DEPLOYED_FROZEN_BLEND component is independently rejected", async (t) => {
  const context = resolutions();
  for (const name of ["RULE_ONLY", "MODEL_ONLY", "DEPLOYED_FROZEN_BLEND"]) {
    await t.test(name, () => {
      const observation = clone(makeObservations(context)[0]);
      delete observation.components[name];
      observation.artifactDigest = computeShadowObservationArtifactDigestV1(observation);
      const result = validateFutureShadowObservationV1({ observation, ...context, featureOrder: context.fixture.model.featureOrder });
      assert.equal(result.status, "MISSING_EVIDENCE");
      assert.equal(result.reason, "RULE_MODEL_BLEND_COMPONENT_MISSING");
    });
  }
});

test("duplicate Shadow observation is rejected", () => {
  const context = resolutions();
  const observation = makeObservations(context)[0];
  const result = validateFutureShadowObservationBatchV1({ observations: [observation, observation], ...context, featureOrder: context.fixture.model.featureOrder });
  assert.equal(result.status, "IDENTITY_MISMATCH");
  assert.equal(result.reason, "DUPLICATE_SHADOW_OBSERVATION");
});

test("replayed observation cannot receive future evidence credit", () => {
  const context = resolutions();
  const observation = clone(makeObservations(context)[0]);
  observation.sourceProvenance.replayed = true;
  observation.artifactDigest = computeShadowObservationArtifactDigestV1(observation);
  const result = validateFutureShadowObservationV1({ observation, ...context, featureOrder: context.fixture.model.featureOrder });
  assert.equal(result.status, "MISSING_EVIDENCE");
  assert.equal(result.reason, "HISTORICAL_OR_REPLAYED_COMPONENTS_NOT_CREDITABLE");
});

test("stale feature snapshot is rejected", () => {
  const context = resolutions();
  const observation = clone(makeObservations(context)[0]);
  observation.dataFreshness.ageMs = 120_000;
  observation.artifactDigest = computeShadowObservationArtifactDigestV1(observation);
  const result = validateFutureShadowObservationV1({ observation, ...context, featureOrder: context.fixture.model.featureOrder });
  assert.equal(result.status, "MISSING_EVIDENCE");
  assert.equal(result.reason, "STALE_FEATURE_SNAPSHOT");
});

test("RULE_ONLY MODEL_ONLY and frozen 65/35 blend are immutably preserved", () => {
  const context = resolutions();
  const observation = makeObservations(context)[0];
  assert.deepEqual(observation.components.RULE_ONLY.probabilities, inference(0).ruleProbabilities);
  assert.deepEqual(observation.components.MODEL_ONLY.probabilities, inference(0).modelProbabilities);
  assert.deepEqual(observation.components.DEPLOYED_FROZEN_BLEND.probabilities, inference(0).probabilities);
  assert.deepEqual(observation.components.DEPLOYED_FROZEN_BLEND.weights, FROZEN_BLEND_WEIGHTS);
  assert.equal(Object.isFrozen(observation), true);
});

test("synthetic and historical backfill observations receive zero credit", async (t) => {
  const context = resolutions();
  for (const flag of ["synthetic", "historicalBackfill"]) {
    await t.test(flag, () => {
      const observation = clone(makePendingObservations(context)[0]);
      observation.sourceProvenance[flag] = true;
      observation.artifactDigest = computeShadowObservationArtifactDigestV1(observation);
      const result = validateFutureShadowObservationV1({ observation, ...context, featureOrder: context.fixture.model.featureOrder });
      assert.equal(result.status, "MISSING_EVIDENCE");
      assert.equal(result.reason, "HISTORICAL_OR_REPLAYED_COMPONENTS_NOT_CREDITABLE");
    });
  }
});

test("signal timestamp must precede observation capture", () => {
  const context = resolutions();
  const observation = clone(makePendingObservations(context)[0]);
  observation.signalAt = "2026-08-26T00:59:00.000Z";
  observation.priceProvenance.signalAt = observation.signalAt;
  observation.artifactDigest = computeShadowObservationArtifactDigestV1(observation);
  const result = validateFutureShadowObservationV1({ observation, ...context, featureOrder: context.fixture.model.featureOrder });
  assert.equal(result.status, "MISSING_EVIDENCE");
  assert.equal(result.reason, "FUTURE_TIMESTAMP_INTEGRITY_FAILED");
});

test("future settlement preserves deterministic price outcome excursions costs and immutable provenance", () => {
  const context = resolutions();
  const pending = makePendingObservations(context)[0];
  const settlement = settlementFor(pending, 0, "SHORT");
  const settled = settleFutureShadowObservationV1(pending, settlement);
  assert.equal(pending.actualDirection, null);
  assert.equal(settled.actualDirection, "bearish");
  assert.equal(settled.settlementStatus, "SETTLED");
  assert.equal(settled.settlement.signalPrice, pending.referencePrice);
  assert.ok(Number.isFinite(settled.settlement.realizedMove));
  assert.ok(Number.isFinite(settled.settlement.excursions.maximumFavorableExcursion));
  assert.ok(Number.isFinite(settled.settlement.excursions.maximumAdverseExcursion));
  assert.equal(settled.settlement.costEvidence.applicable, false);
  assert.equal(settled.settlement.sourceProvenance.replayed, false);
  assert.notEqual(settled.artifactDigest, pending.artifactDigest);
  assert.equal(computeShadowObservationArtifactDigestV1(settled), settled.artifactDigest);
  assert.equal(settleFutureShadowObservationV1(settled, settlement), settled);
  const conflicting = settlementFor(pending, 0, "LONG");
  assert.throws(() => settleFutureShadowObservationV1(settled, conflicting), /settlement conflict/);
});

test("pending genuine observation remains POSITION and SETTLEMENT_NOT_DUE without fabricated outcome", () => {
  const pending = makePendingObservations()[0];
  assert.equal(pending.positionEvidence.status, "POSITION");
  assert.equal(pending.settlementStatus, "PENDING_SETTLEMENT");
  assert.equal(pending.settlement, null);
  assert.equal(pending.actualDirection, null);
});

test("settlement outcome and evidence digest reproduce deterministically", () => {
  const pending = makePendingObservations()[0];
  const first = settlementFor(pending, 0);
  const second = settlementFor(pending, 0);
  assert.deepEqual(first, second);
  assert.equal(first.evidenceDigest, second.evidenceDigest);
});

test("PSI deterministic reproduction uses genuine future Shadow features", () => {
  const first = fullHandoff();
  const second = fullHandoff();
  assert.equal(first.status, "COMPLETE");
  assert.equal(first.featureMetrics[0].psi, second.featureMetrics[0].psi);
  assert.ok(Number.isFinite(first.featureMetrics[0].psi));
});

test("KS deterministic reproduction uses genuine future Shadow features", () => {
  const first = fullHandoff();
  const second = fullHandoff();
  assert.equal(first.featureMetrics[0].ksStatistic, second.featureMetrics[0].ksStatistic);
  assert.ok(Number.isFinite(first.featureMetrics[0].ksStatistic));
  assert.equal(first.featureMetrics[0].ksPValue, null);
});

test("JSD deterministic reproduction uses genuine future Shadow features", () => {
  const first = fullHandoff();
  const second = fullHandoff();
  assert.equal(first.featureMetrics[0].jsd, second.featureMetrics[0].jsd);
  assert.ok(Number.isFinite(first.featureMetrics[0].jsd));
});

test("unsettled future observations do not enter directional quality or PSI KS JSD", () => {
  const context = resolutions();
  const result = fullHandoff({ observations: makePendingObservations(context), canonicalDriftPolicy: driftPolicy() });
  assert.equal(result.status, "MISSING_EVIDENCE");
  assert.equal(result.observationEvidence.sampleN, 4);
  assert.equal(result.observationEvidence.settledN, 0);
  assert.equal(result.observationEvidence.driftInputN, 0);
  assert.equal(result.directionalQuality.RULE_ONLY.sampleN, 0);
  assert.equal(result.directionalQuality.MODEL_ONLY.sampleN, 0);
  assert.equal(result.directionalQuality.DEPLOYED_FROZEN_BLEND.sampleN, 0);
  assert.equal(result.featureMetrics.every((metric) => metric.psi === null && metric.ksStatistic === null && metric.jsd === null), true);
  assert.equal(result.driftVerdict.status, "NOT_EVALUABLE");
  assert.equal(result.driftVerdict.reason, "SETTLEMENT_NOT_DUE");
  assert.deepEqual(result.strategyHealthHandoff.missingEvidence, ["SETTLEMENT_NOT_DUE"]);
});

test("Drift Verdict is NOT_EVALUABLE without canonical non-hindsight policy", () => {
  const measured = fullHandoff();
  const verdict = buildDriftVerdictV1({
    featureMetrics: measured.featureMetrics,
    canonicalDriftPolicy: null,
    strategyIdentityDigest: measured.strategyResolution.strategyIdentityDigest,
    modelIdentityDigest: measured.modelResolution.modelIdentityDigest,
    referenceIdentity: measured.referenceResolution.referenceIdentity,
    sampleN: measured.observationEvidence.sampleN,
    referenceN: measured.referenceResolution.trainSampleN + measured.referenceResolution.validationSampleN,
    freshness: measured.referenceResolution.freshness,
    asOf: AS_OF,
  });
  assert.equal(verdict.status, "NOT_EVALUABLE");
  assert.equal(verdict.reason, "CANONICAL_DRIFT_POLICY_MISSING");
});

test("single metric cannot trigger BRAKE; canonical multi-signal policy is required", () => {
  const context = resolutions();
  const featureMetrics = [
    { feature: "return5", status: "MEASURED", psi: 100, ksStatistic: 0, jsd: 0 },
    { feature: "atrPct", status: "MEASURED", psi: 0, ksStatistic: 0, jsd: 0 },
  ];
  const policy = driftPolicy({
    watch: { psi: 10, ksStatistic: 0.5, jsd: 0.5 },
    brake: { psi: 20, ksStatistic: 0.8, jsd: 0.8, minimumTriggeredMetrics: 2 },
  });
  const verdict = buildDriftVerdictV1({
    featureMetrics,
    canonicalDriftPolicy: policy,
    strategyIdentityDigest: context.strategyResolution.strategyIdentityDigest,
    modelIdentityDigest: context.modelResolution.modelIdentityDigest,
    referenceIdentity: context.referenceResolution.referenceIdentity,
    sampleN: 4,
    referenceN: 8,
    freshness: context.referenceResolution.freshness,
    asOf: AS_OF,
  });
  assert.equal(verdict.status, "WATCH");
  assert.equal(verdict.brakeSignals.length, 1);
});

test("Strategy Health handoff exposes canonical identities component quality drift and evidence digest only", () => {
  const result = fullHandoff();
  const handoff = result.strategyHealthHandoff;
  assert.equal(result.status, "COMPLETE");
  assert.equal(handoff.schemaVersion, "prediction-lab-strategy-health-shadow-handoff-v1");
  assert.equal(handoff.strategyIdentityDigest, result.strategyResolution.strategyIdentityDigest);
  assert.equal(handoff.modelIdentityDigest, result.modelResolution.modelIdentityDigest);
  assert.equal(handoff.ruleOnlyQuality.sampleN, 4);
  assert.equal(handoff.modelOnlyQuality.sampleN, 4);
  assert.equal(handoff.blendQuality.sampleN, 4);
  assert.ok(typeof handoff.evidenceDigest === "string" && handoff.evidenceDigest.length === 64);
  assert.equal(handoff.executionAuthority, "NONE");
});

test("directional collapse evidence is separated by component regime symbol and timeframe without tuning", () => {
  const result = fullHandoff();
  assert.equal(result.causeSeparation.ruleCollapse.status, "MEASURED");
  assert.equal(result.causeSeparation.modelCollapse.status, "MEASURED");
  assert.equal(result.causeSeparation.blendCollapse.status, "MEASURED");
  assert.ok(result.causeSeparation.regimeSpecific.Bear);
  assert.ok(result.causeSeparation.symbolSpecific.BTCUSDT);
  assert.ok(result.causeSeparation.timeframeSpecific["15m"]);
});

test("safety and profitability remain fail-closed", () => {
  const result = fullHandoff();
  assert.equal(result.PROFITABILITY_PROVEN, false);
  assert.equal(result.FORWARD_EVIDENCE_SUFFICIENT, false);
  assert.deepEqual(shadowEvidenceSafetyV1(), {
    LIVE_TRADING: false,
    AUTO_TRADING: false,
    REAL_ORDER_ENABLED: false,
    PRIVATE_TRADING_API_ALLOWED: false,
    executionAuthority: "NONE",
    orderSubmitted: false,
  });
});
