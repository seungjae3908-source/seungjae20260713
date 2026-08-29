import test from "node:test";
import assert from "node:assert/strict";

import { sha256 } from "../src/data-quality.js";
import {
  MODEL_REFERENCE_DRIFT_DIAGNOSTIC_SAFETY,
  buildModelReferenceDriftDiagnosticV1,
} from "../src/model-reference-drift-diagnostics-v1.js";
import { sha256Canonical } from "../src/research-cache-provenance.js";

const SHA = "a".repeat(40);
const FEATURE_ORDER = Object.freeze(["x", "y"]);

function jsonl(records) {
  return Buffer.from(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

function recordIdentityDigest(records) {
  return sha256(Buffer.from(`${records.map((record) => record.id).sort().join("\n")}\n`, "utf8"));
}

function records(prefix, xs, ys = xs) {
  return xs.map((x, index) => ({
    schemaVersion: 2,
    id: `${prefix}-${index}`,
    anchorTimestamp: 1_780_000_000_000 + index * 900_000,
    futureEndTimestamp: 1_780_000_900_000 + index * 900_000,
    features: { x, y: ys[index] },
    label: { direction: ["bullish", "neutral", "bearish"][index % 3] },
  }));
}

function fixture({ trainX, validationX, trainY = trainX, validationY = validationX } = {}) {
  const trainRecords = records("train", trainX, trainY);
  const validationRecords = records("validation", validationX, validationY);
  const trainBytes = jsonl(trainRecords);
  const validationBytes = jsonl(validationRecords);
  const trainDigest = sha256(trainBytes);
  const validationDigest = sha256(validationBytes);
  const manifest = {
    status: "VALID",
    referenceProvenanceStatus: "VALID",
    group: "crypto-futures-15m",
    datasetId: "prediction-lab:crypto-futures-15m:train-validation",
    datasetDigest: "1".repeat(64),
    strategyIdentityDigest: "2".repeat(64),
    researchCodeSha: SHA,
    trainingCodeSha: SHA,
    producerSha: SHA,
    modelSha: "3".repeat(64),
    preprocessingVersion: "prediction-lab-training-preprocessing-v1",
    featureOrder: [...FEATURE_ORDER],
    featureOrderDigest: sha256Canonical(FEATURE_ORDER),
    trainDatasetIdentity: `prediction-lab-model-reference:train:sha256:${trainDigest}`,
    validationDatasetIdentity: `prediction-lab-model-reference:validation:sha256:${validationDigest}`,
    trainDatasetDigest: trainDigest,
    validationDatasetDigest: validationDigest,
    trainSplitDigest: trainDigest,
    validationSplitDigest: validationDigest,
    trainSampleN: trainRecords.length,
    validationSampleN: validationRecords.length,
    trainRecordIdentityDigest: recordIdentityDigest(trainRecords),
    validationRecordIdentityDigest: recordIdentityDigest(validationRecords),
    rawArtifactDigest: "4".repeat(64),
    artifactDigest: "4".repeat(64),
    sourceAttestation: {
      sourceKind: "GENUINE_MARKET_DATA",
      futureOnly: true,
      reconstructed: false,
      historicalReconstruction: false,
      synthetic: false,
      replayDerived: false,
      shadowDerived: false,
      testFixture: false,
      oosIncluded: false,
      finalHoldoutIncluded: false,
      finalHoldoutAccessed: false,
    },
  };
  const reference = {
    group: manifest.group,
    datasetDigest: manifest.datasetDigest,
    strategyIdentityDigest: manifest.strategyIdentityDigest,
    modelSha: manifest.modelSha,
    featureOrderDigest: manifest.featureOrderDigest,
    trainDatasetDigest: manifest.trainDatasetDigest,
    validationDatasetDigest: manifest.validationDatasetDigest,
    trainSplitDigest: manifest.trainSplitDigest,
    validationSplitDigest: manifest.validationSplitDigest,
    rawArtifactDigest: manifest.rawArtifactDigest,
    artifactDigest: manifest.artifactDigest,
  };
  const durableReceiptValidation = {
    valid: true,
    status: "VALID",
    durableReferenceStore: "GITHUB_IMMUTABLE_RELEASE",
    longTermReferenceProven: true,
    publicationReceiptProven: true,
    receipt: {
      provider: "GITHUB_IMMUTABLE_RELEASE",
      releaseId: "9001",
      releaseTag: "prediction-lab-model-reference-v1-77",
      targetCommitSha: SHA,
      receiptDigest: "5".repeat(64),
      references: [reference],
    },
  };
  return { manifest, trainBytes, validationBytes, durableReceiptValidation };
}

const BASE = Array.from({ length: 20 }, (_, index) => index / 2);

test("authenticated identical TRAIN and VALIDATION feature populations report zero drift", () => {
  const input = fixture({ trainX: BASE, validationX: BASE, trainY: BASE.map((value) => value * 2), validationY: BASE.map((value) => value * 2) });
  const result = buildModelReferenceDriftDiagnosticV1({ ...input, generatedAt: 1_780_000_000_000 });
  assert.equal(result.status, "VALID");
  assert.equal(result.decisionStatus, "DIAGNOSTIC_ONLY");
  assert.equal(result.durableReferenceProven, true);
  assert.equal(result.reference.trainSampleN, 20);
  assert.equal(result.reference.validationSampleN, 20);
  for (const metric of Object.values(result.metrics.perFeature)) {
    assert.ok(Math.abs(metric.psi) < 1e-12);
    assert.ok(Math.abs(metric.ks) < 1e-12);
    assert.ok(Math.abs(metric.jsd) < 1e-12);
  }
  assert.equal(result.authority.tuningAllowed, false);
  assert.equal(result.authority.promotionDecisionAllowed, false);
  assert.equal(result.authority.profitabilityClaimAllowed, false);
});

test("shifted VALIDATION population produces PSI KS and JSD diagnostics without granting tuning authority", () => {
  const shifted = BASE.map((value) => value + 100);
  const input = fixture({ trainX: BASE, validationX: shifted, trainY: BASE, validationY: BASE });
  const result = buildModelReferenceDriftDiagnosticV1({ ...input, generatedAt: 1_780_000_000_000 });
  assert.ok(result.metrics.perFeature.x.psi > 0);
  assert.equal(result.metrics.perFeature.x.ks, 1);
  assert.ok(result.metrics.perFeature.x.jsd > 0);
  assert.ok(Math.abs(result.metrics.perFeature.y.psi) < 1e-12);
  assert.ok(Math.abs(result.metrics.perFeature.y.ks) < 1e-12);
  assert.ok(Math.abs(result.metrics.perFeature.y.jsd) < 1e-12);
  assert.equal(result.metrics.maxima.ks.feature, "x");
  assert.equal(result.authority.thresholdSelectionAllowed, false);
  assert.equal(result.authority.modelSelectionAllowed, false);
  assert.equal(result.authority.classWeightSelectionAllowed, false);
  assert.equal(result.authority.blendWeightSelectionAllowed, false);
});

test("exact durable split bytes are mandatory and tampering fails closed", () => {
  const input = fixture({ trainX: BASE, validationX: BASE });
  const tampered = Buffer.from(input.trainBytes);
  tampered[tampered.length - 2] = tampered[tampered.length - 2] === 48 ? 49 : 48;
  assert.throws(
    () => buildModelReferenceDriftDiagnosticV1({ ...input, trainBytes: tampered }),
    /exact-byte digest mismatch/u,
  );
});

test("missing durable publication readback never becomes diagnostic success", () => {
  const input = fixture({ trainX: BASE, validationX: BASE });
  assert.throws(
    () => buildModelReferenceDriftDiagnosticV1({
      ...input,
      durableReceiptValidation: {
        ...input.durableReceiptValidation,
        valid: false,
        status: "MISSING_EVIDENCE",
        longTermReferenceProven: false,
        publicationReceiptProven: false,
      },
    }),
    /DURABLE_REFERENCE_PROVEN=false/u,
  );
});

test("TRAIN VALIDATION identity overlap and non-genuine substitution fail closed", () => {
  const input = fixture({ trainX: BASE, validationX: BASE });
  const duplicatedValidationRecords = records("train", BASE);
  const duplicatedValidationBytes = jsonl(duplicatedValidationRecords);
  const overlapManifest = {
    ...input.manifest,
    validationSplitDigest: sha256(duplicatedValidationBytes),
    validationDatasetDigest: sha256(duplicatedValidationBytes),
    validationSampleN: duplicatedValidationRecords.length,
    validationRecordIdentityDigest: recordIdentityDigest(duplicatedValidationRecords),
  };
  const overlapValidation = {
    ...input.durableReceiptValidation,
    receipt: {
      ...input.durableReceiptValidation.receipt,
      references: [{
        ...input.durableReceiptValidation.receipt.references[0],
        validationSplitDigest: overlapManifest.validationSplitDigest,
        validationDatasetDigest: overlapManifest.validationDatasetDigest,
      }],
    },
  };
  assert.throws(
    () => buildModelReferenceDriftDiagnosticV1({
      manifest: overlapManifest,
      trainBytes: input.trainBytes,
      validationBytes: duplicatedValidationBytes,
      durableReceiptValidation: overlapValidation,
    }),
    /identity overlap/u,
  );
  assert.throws(
    () => buildModelReferenceDriftDiagnosticV1({
      ...input,
      manifest: {
        ...input.manifest,
        sourceAttestation: { ...input.manifest.sourceAttestation, reconstructed: true },
      },
    }),
    /only genuine future TRAIN\/VALIDATION/u,
  );
});

test("drift diagnostic safety contract is permanently non-executing and non-promotional", () => {
  assert.equal(MODEL_REFERENCE_DRIFT_DIAGNOSTIC_SAFETY.diagnosticsOnly, true);
  assert.equal(MODEL_REFERENCE_DRIFT_DIAGNOSTIC_SAFETY.tuningAuthority, false);
  assert.equal(MODEL_REFERENCE_DRIFT_DIAGNOSTIC_SAFETY.profitabilityCredit, 0);
  assert.equal(MODEL_REFERENCE_DRIFT_DIAGNOSTIC_SAFETY.promotionCredit, 0);
  assert.equal(MODEL_REFERENCE_DRIFT_DIAGNOSTIC_SAFETY.LIVE_TRADING, false);
  assert.equal(MODEL_REFERENCE_DRIFT_DIAGNOSTIC_SAFETY.PRIVATE_TRADING_API_ALLOWED, false);
  assert.equal(MODEL_REFERENCE_DRIFT_DIAGNOSTIC_SAFETY.executionAuthority, "NONE");
  assert.equal(MODEL_REFERENCE_DRIFT_DIAGNOSTIC_SAFETY.orderSubmitted, false);
});
