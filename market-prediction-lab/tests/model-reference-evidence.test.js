import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256 } from "../src/data-quality.js";
import {
  PREPROCESSING_VERSION,
  finalizeModelReferenceEvidenceReceipts,
  modelReferenceSafety,
  preserveFutureModelReferenceEvidence,
  validateModelReferenceEvidencePackage,
} from "../src/model-reference-evidence.js";
import { buildCompositeDatasetProvenance, sha256Canonical } from "../src/research-cache-provenance.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const GROUP = "crypto-futures-15m";
const COMPONENTS = Object.freeze({
  "btcusdt-futures-15m-52d:train": "1".repeat(64),
  "btcusdt-futures-15m-52d:validation": "2".repeat(64),
  "ethusdt-futures-15m-52d:train": "3".repeat(64),
  "ethusdt-futures-15m-52d:validation": "4".repeat(64),
});
const MODEL = Object.freeze({
  id: "tiny-softmax-test-v1",
  trained: true,
  modelType: "multinomial-logistic-regression",
  featureOrder: Object.freeze(["x", "y"]),
  normalization: Object.freeze({ mean: Object.freeze([0, 1]), scale: Object.freeze([1, 2]) }),
  temperature: 1,
  classes: Object.freeze({
    bullish: Object.freeze({ bias: 0, weights: Object.freeze([1, 0]) }),
    neutral: Object.freeze({ bias: 0, weights: Object.freeze([0, 1]) }),
    bearish: Object.freeze({ bias: 0, weights: Object.freeze([-1, -1]) }),
  }),
});

function records(prefix, count, offset = 0) {
  return Array.from({ length: count }, (_, index) => ({
    schemaVersion: 2,
    id: `${prefix}-${index}`,
    anchorTimestamp: 1_700_000_000_000 + offset + index * 60_000,
    futureEndTimestamp: 1_700_000_030_000 + offset + index * 60_000,
    features: { x: index / 10, y: index / 20 },
    label: { direction: ["bullish", "neutral", "bearish"][index % 3] },
  }));
}

function sourceAttestation(overrides = {}) {
  return {
    sourceKind: "GENUINE_MARKET_DATA",
    reconstructed: false,
    synthetic: false,
    shadowDerived: false,
    finalHoldoutIncluded: false,
    ...overrides,
  };
}

function completeStrategyIdentity() {
  const datasetId = `prediction-lab:${GROUP}:train-validation`;
  const datasetDigest = buildCompositeDatasetProvenance({ datasetId, components: COMPONENTS }).datasetDigest;
  return {
    strategyId: "tiny-softmax-crypto-futures-15m-v1",
    strategyFamily: "tiny-softmax-directional",
    strategyVersion: "v1",
    market: "CRYPTO_FUTURES",
    direction: "LONG_NEUTRAL_SHORT",
    timeframe: "15m",
    formulaIdentity: { modelType: MODEL.modelType, inference: "deployed-rule-model-65-35" },
    parameterHash: sha256Canonical({ epochs: 520, learningRate: 0.075, l2: 0.003 }),
    researchCodeSha: SHA_A,
    datasetId,
    datasetDigest,
    datasetStart: "2026-06-01T00:00:00.000Z",
    datasetEnd: "2026-08-01T00:00:00.000Z",
    costPolicyVersion: "research-cost-policy-v1",
    riskPolicyVersion: "research-risk-policy-v1",
    evidenceSchemaVersion: "StrategyEvidenceEnvelopeV1",
  };
}

function artifactMetadata() {
  return {
    artifactId: "9001",
    artifactName: "prediction-lab-model-reference-evidence-raw-77",
    artifactReference: "https://github.com/example/repo/actions/runs/77/artifacts/9001",
    outerArtifactDigest: "5".repeat(64),
    createdAt: "2026-08-26T00:00:00.000Z",
    expiresAt: "2026-11-24T00:00:00.000Z",
    now: "2026-08-26T00:00:00.000Z",
  };
}

async function fixture({ strategyIdentity = null, attestation = sourceAttestation() } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "model-reference-evidence-"));
  try {
    const root = join(directory, "reference-evidence");
    const modelSha = sha256(Buffer.from(JSON.stringify(MODEL), "utf8"));
    const manifest = await preserveFutureModelReferenceEvidence({
      outputRoot: root,
      group: GROUP,
      trainRecords: records("train", 12),
      validationRecords: records("validation", 6, 10_000_000),
      model: MODEL,
      modelSha,
      datasetComponents: COMPONENTS,
      researchCodeSha: SHA_A,
      trainingCodeSha: SHA_B,
      measuredAt: "2026-08-26T00:00:00.000Z",
      strategyIdentity,
      sourceAttestation: attestation,
    });
    return { directory, root, packageRoot: join(root, GROUP), manifest };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function readManifest(packageRoot) {
  return JSON.parse(await readFile(join(packageRoot, "reference-manifest.json"), "utf8"));
}

async function writeManifest(packageRoot, manifest) {
  await writeFile(join(packageRoot, "reference-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

test("exact stored TRAIN and VALIDATION bytes produce the preserved split digests", async () => {
  const value = await fixture();
  try {
    const train = await readFile(join(value.packageRoot, "records", "train.jsonl"));
    const validation = await readFile(join(value.packageRoot, "records", "validation.jsonl"));
    assert.equal(sha256(train), value.manifest.trainSplitDigest);
    assert.equal(sha256(validation), value.manifest.validationSplitDigest);
    assert.equal(value.manifest.trainSampleN, 12);
    assert.equal(value.manifest.validationSampleN, 6);
    await assert.rejects(
      readFile(join(value.packageRoot, "records", "test.jsonl")),
      (error) => error?.code === "ENOENT",
    );
    const assessment = await validateModelReferenceEvidencePackage(value.packageRoot);
    assert.equal(assessment.status, "MISSING_EVIDENCE");
    assert.equal(assessment.rawReferenceValid, true);
  } finally { await rm(value.directory, { recursive: true, force: true }); }
});

test("modified or swapped TRAIN and VALIDATION bytes are rejected", async (t) => {
  await t.test("modified TRAIN", async () => {
    const value = await fixture();
    try {
      await writeFile(join(value.packageRoot, "records", "train.jsonl"), "tampered\n", "utf8");
      assert.equal((await validateModelReferenceEvidencePackage(value.packageRoot)).status, "IDENTITY_MISMATCH");
    } finally { await rm(value.directory, { recursive: true, force: true }); }
  });
  await t.test("modified VALIDATION", async () => {
    const value = await fixture();
    try {
      await writeFile(join(value.packageRoot, "records", "validation.jsonl"), "tampered\n", "utf8");
      assert.equal((await validateModelReferenceEvidencePackage(value.packageRoot)).status, "IDENTITY_MISMATCH");
    } finally { await rm(value.directory, { recursive: true, force: true }); }
  });
  await t.test("TRAIN VALIDATION swap", async () => {
    const value = await fixture();
    try {
      const trainPath = join(value.packageRoot, "records", "train.jsonl");
      const validationPath = join(value.packageRoot, "records", "validation.jsonl");
      const [train, validation] = await Promise.all([readFile(trainPath), readFile(validationPath)]);
      await Promise.all([writeFile(trainPath, validation), writeFile(validationPath, train)]);
      assert.equal((await validateModelReferenceEvidencePackage(value.packageRoot)).status, "IDENTITY_MISMATCH");
    } finally { await rm(value.directory, { recursive: true, force: true }); }
  });
});

test("feature order is exact and reordered, missing, or extra features mismatch", async (t) => {
  for (const [name, featureOrder] of [["reordered", ["y", "x"]], ["missing", ["x"]], ["extra", ["x", "y", "z"]]]) {
    await t.test(name, async () => {
      const value = await fixture();
      try {
        const manifest = await readManifest(value.packageRoot);
        manifest.featureOrder = featureOrder;
        await writeManifest(value.packageRoot, manifest);
        assert.equal((await validateModelReferenceEvidencePackage(value.packageRoot)).status, "IDENTITY_MISMATCH");
      } finally { await rm(value.directory, { recursive: true, force: true }); }
    });
  }
});

test("preprocessing version is deterministic, mismatched versions reject, and missing stays missing evidence", async () => {
  const value = await fixture();
  try {
    assert.equal(value.manifest.preprocessingVersion, PREPROCESSING_VERSION);
    const mismatched = await readManifest(value.packageRoot);
    mismatched.preprocessingVersion = "prediction-lab-training-preprocessing-v2";
    await writeManifest(value.packageRoot, mismatched);
    assert.equal((await validateModelReferenceEvidencePackage(value.packageRoot)).status, "IDENTITY_MISMATCH");
    delete mismatched.preprocessingVersion;
    await writeManifest(value.packageRoot, mismatched);
    assert.equal((await validateModelReferenceEvidencePackage(value.packageRoot)).status, "MISSING_EVIDENCE");
  } finally { await rm(value.directory, { recursive: true, force: true }); }
});

test("exact existing modelSha passes and model or split-model substitution rejects", async (t) => {
  await t.test("model bytes", async () => {
    const value = await fixture();
    try {
      await writeFile(join(value.packageRoot, "model", "exact-model.json"), JSON.stringify({ ...MODEL, id: "other-model" }), "utf8");
      assert.equal((await validateModelReferenceEvidencePackage(value.packageRoot)).status, "IDENTITY_MISMATCH");
    } finally { await rm(value.directory, { recursive: true, force: true }); }
  });
  await t.test("another-model TRAIN and VALIDATION", async () => {
    const value = await fixture();
    try {
      const manifest = await readManifest(value.packageRoot);
      manifest.splitAttestations.train.modelSha = "9".repeat(64);
      manifest.splitAttestations.validation.modelSha = "9".repeat(64);
      await writeManifest(value.packageRoot, manifest);
      assert.equal((await validateModelReferenceEvidencePackage(value.packageRoot)).status, "IDENTITY_MISMATCH");
    } finally { await rm(value.directory, { recursive: true, force: true }); }
  });
});

test("#664 composite dataset identity is exact and dataset mismatches reject", async (t) => {
  for (const field of ["datasetId", "datasetDigest"]) {
    await t.test(field, async () => {
      const value = await fixture();
      try {
        const manifest = await readManifest(value.packageRoot);
        manifest[field] = field === "datasetId" ? "other-dataset" : "8".repeat(64);
        await writeManifest(value.packageRoot, manifest);
        assert.equal((await validateModelReferenceEvidencePackage(value.packageRoot)).status, "IDENTITY_MISMATCH");
      } finally { await rm(value.directory, { recursive: true, force: true }); }
    });
  }
});

test("canonical strategy identity plus exact #664 receipt enables VALID provenance", async () => {
  const value = await fixture({ strategyIdentity: completeStrategyIdentity() });
  try {
    const [report] = await finalizeModelReferenceEvidenceReceipts(value.root, artifactMetadata());
    assert.equal(report.status, "VALID");
    assert.equal(report.receiptValidation.status, "VALID");
    assert.equal(report.provenanceValidation.status, "VALID");
    assert.match(report.manifest.strategyIdentityDigest, /^[0-9a-f]{64}$/u);
  } finally { await rm(value.directory, { recursive: true, force: true }); }
});

test("missing strategy identity preserves genuine raw evidence but never claims complete provenance", async () => {
  const value = await fixture();
  try {
    const [report] = await finalizeModelReferenceEvidenceReceipts(value.root, artifactMetadata());
    assert.equal(report.status, "MISSING_EVIDENCE");
    assert.equal(report.rawReferenceValid, true);
    assert.equal(report.receiptValidation.status, "VALID");
    assert.equal(report.manifest.strategyIdentityDigest, null);
    assert.equal(report.manifest.referenceProvenance, null);
  } finally { await rm(value.directory, { recursive: true, force: true }); }
});

test("canonical strategy identity from another dataset remains IDENTITY_MISMATCH", async () => {
  const strategyIdentity = { ...completeStrategyIdentity(), datasetId: "other-dataset" };
  const value = await fixture({ strategyIdentity });
  try {
    const [report] = await finalizeModelReferenceEvidenceReceipts(value.root, artifactMetadata());
    assert.equal(report.status, "IDENTITY_MISMATCH");
    assert.equal(report.rawReferenceValid, true);
    assert.equal(report.manifest.strategyIdentityDigest, null);
    assert.equal(report.manifest.referenceProvenance, null);
  } finally { await rm(value.directory, { recursive: true, force: true }); }
});

test("expired and mismatched #664 artifact receipts fail closed", async (t) => {
  await t.test("expired", async () => {
    const value = await fixture({ strategyIdentity: completeStrategyIdentity() });
    try {
      await finalizeModelReferenceEvidenceReceipts(value.root, artifactMetadata());
      const report = await validateModelReferenceEvidencePackage(value.packageRoot, { now: "2026-11-24T00:00:00.000Z" });
      assert.equal(report.status, "REFERENCE_EXPIRED");
    } finally { await rm(value.directory, { recursive: true, force: true }); }
  });
  await t.test("receipt mismatch", async () => {
    const value = await fixture({ strategyIdentity: completeStrategyIdentity() });
    try {
      await finalizeModelReferenceEvidenceReceipts(value.root, artifactMetadata());
      const manifest = await readManifest(value.packageRoot);
      manifest.artifactReceipt.outerArtifactDigest = "7".repeat(64);
      await writeManifest(value.packageRoot, manifest);
      assert.equal((await validateModelReferenceEvidencePackage(value.packageRoot, { now: artifactMetadata().now })).status, "IDENTITY_MISMATCH");
    } finally { await rm(value.directory, { recursive: true, force: true }); }
  });
});

test("reconstructed, synthetic, Shadow, and Final Holdout substitutions are rejected", async (t) => {
  const cases = [
    ["reconstructed", { reconstructed: true }],
    ["synthetic", { synthetic: true }],
    ["Shadow", { sourceKind: "SHADOW", shadowDerived: true }],
    ["Final Holdout", { finalHoldoutIncluded: true }],
  ];
  for (const [name, overrides] of cases) {
    await t.test(name, async () => {
      await assert.rejects(fixture({ attestation: sourceAttestation(overrides) }), /only genuine future TRAIN\/VALIDATION/);
    });
  }
});

test("all six trading safety invariants remain locked", () => {
  assert.deepEqual(modelReferenceSafety(), {
    LIVE_TRADING: false,
    AUTO_TRADING: false,
    REAL_ORDER_ENABLED: false,
    PRIVATE_TRADING_API_ALLOWED: false,
    executionAuthority: "NONE",
    orderSubmitted: false,
  });
});
