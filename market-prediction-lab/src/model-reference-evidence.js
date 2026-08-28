import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { sha256 } from "./data-quality.js";
import { isMaterializedExactTrainValidationSplits } from "./dataset-export.js";
import { resolveCanonicalStrategyIdentity } from "./canonical-strategy-identity-v1.js";
import {
  buildCompositeDatasetProvenance,
  buildReferenceArtifactReceipt,
  buildReferenceEvidenceProvenance,
  sha256Canonical,
  validateCompositeDatasetProvenance,
  validateReferenceArtifactReceipt,
  validateReferenceEvidenceProvenance,
} from "./research-cache-provenance.js";

export const MODEL_REFERENCE_EVIDENCE_SCHEMA_VERSION = "PredictionLabModelReferenceEvidenceV1";
export const RAW_REFERENCE_BUNDLE_SCHEMA_VERSION = "PredictionLabRawReferenceBundleIdentityV1";
export const TRAINING_INVOCATION_SCHEMA_VERSION = "PredictionLabExactTrainingInvocationV1";
export const PREPROCESSING_VERSION = "prediction-lab-training-preprocessing-v1";
export const PREPROCESSING_CONTRACT = Object.freeze({
  featureCalculation: "analyzeMarket-training-record-features-v1",
  missingValueBehavior: "non-finite-feature-to-zero-v1",
  normalizationBehavior: "train-population-mean-std-scale-floor-1e-6-v1",
  clippingBehavior: "normalized-feature-clamp-minus12-plus12-v1",
  orderingBehavior: "exact-model-feature-order-no-sort-v1",
});
export const MODEL_REFERENCE_STRATEGY_FORMULA_SCHEMA_VERSION = "prediction-lab-deployed-rule-model-formula-v1";
export const MODEL_REFERENCE_STRATEGY_PARAMETER_SCHEMA_VERSION = "prediction-lab-tiny-softmax-parameters-v1";
export const MODEL_REFERENCE_COST_POLICY_VERSION = "prediction-lab-shadow-observation-no-execution-cost-v1";
export const MODEL_REFERENCE_RISK_POLICY_VERSION = "prediction-lab-shadow-observation-no-execution-risk-v1";

const HASH_64 = /^[0-9a-f]{64}$/u;
const SHA_40 = /^[0-9a-f]{40}$/u;
const REQUIRED_SAFETY = Object.freeze({
  LIVE_TRADING: false,
  AUTO_TRADING: false,
  REAL_ORDER_ENABLED: false,
  PRIVATE_TRADING_API_ALLOWED: false,
  executionAuthority: "NONE",
  orderSubmitted: false,
});

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function normalizeSha(value) {
  return typeof value === "string" && SHA_40.test(value.toLowerCase()) ? value.toLowerCase() : null;
}

function normalizeDigest(value) {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase().replace(/^sha256:/u, "");
  return HASH_64.test(normalized) ? normalized : null;
}

function isoTimestamp(value, label) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new TypeError(`${label} must be an ISO timestamp`);
  return new Date(timestamp).toISOString();
}

async function atomicWrite(filePath, bytes) {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, bytes, { mode: 0o600 });
  await rename(temporaryPath, filePath);
}

async function writeJson(filePath, value) {
  await atomicWrite(filePath, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

function splitAttestations(manifest) {
  return {
    train: {
      sourceKind: "RAW_TRAIN",
      modelSha: manifest.modelSha,
      splitDigest: manifest.trainSplitDigest,
      datasetIdentity: manifest.trainDatasetIdentity,
      datasetDigest: manifest.trainDatasetDigest,
      sampleN: manifest.trainSampleN,
      byteLength: manifest.trainByteLength,
      recordIdentityDigest: manifest.trainRecordIdentityDigest,
    },
    validation: {
      sourceKind: "RAW_VALIDATION",
      modelSha: manifest.modelSha,
      splitDigest: manifest.validationSplitDigest,
      datasetIdentity: manifest.validationDatasetIdentity,
      datasetDigest: manifest.validationDatasetDigest,
      sampleN: manifest.validationSampleN,
      byteLength: manifest.validationByteLength,
      recordIdentityDigest: manifest.validationRecordIdentityDigest,
    },
  };
}

function expectedSplitDatasetIdentity(role, digest) {
  return `prediction-lab-model-reference:${role.toLowerCase()}:sha256:${digest}`;
}

function recordIdentityDigest(records) {
  const ids = records.map((record) => typeof record?.id === "string" ? record.id : "");
  if (ids.some((id) => id.length === 0) || new Set(ids).size !== ids.length) return null;
  return sha256(Buffer.from(`${[...ids].sort().join("\n")}\n`, "utf8"));
}

function rawArtifactIdentity(manifest) {
  return {
    schemaVersion: RAW_REFERENCE_BUNDLE_SCHEMA_VERSION,
    datasetId: manifest.datasetId,
    datasetDigest: manifest.datasetDigest,
    modelSha: manifest.modelSha,
    producerSha: manifest.producerSha,
    trainingCodeSha: manifest.trainingCodeSha,
    preprocessingVersion: manifest.preprocessingVersion,
    featureOrderDigest: manifest.featureOrderDigest,
    trainDatasetIdentity: manifest.trainDatasetIdentity,
    validationDatasetIdentity: manifest.validationDatasetIdentity,
    trainDatasetDigest: manifest.trainDatasetDigest,
    validationDatasetDigest: manifest.validationDatasetDigest,
    trainSplitDigest: manifest.trainSplitDigest,
    validationSplitDigest: manifest.validationSplitDigest,
    trainSampleN: manifest.trainSampleN,
    validationSampleN: manifest.validationSampleN,
    trainByteLength: manifest.trainByteLength,
    validationByteLength: manifest.validationByteLength,
    trainRecordIdentityDigest: manifest.trainRecordIdentityDigest,
    validationRecordIdentityDigest: manifest.validationRecordIdentityDigest,
    oosExclusionDigest: manifest.oosExclusionDigest,
    trainingInvocationDigest: manifest.trainingInvocationDigest,
    trainPath: "records/train.jsonl",
    validationPath: "records/validation.jsonl",
    modelPath: "model/exact-model.json",
  };
}

function assessStrategyIdentity(strategyIdentity, exact) {
  const resolved = resolveCanonicalStrategyIdentity(strategyIdentity ?? {});
  if (resolved.status !== "IDENTITY_COMPLETE" || resolved.executionAuthority !== "NONE") {
    return { status: "MISSING_EVIDENCE", strategyIdentity: null, strategyIdentityDigest: null, missingEvidence: ["STRATEGY_IDENTITY_DIGEST"] };
  }
  const identity = resolved.identity;
  const mismatched = [];
  if (identity.datasetId !== exact.datasetId) mismatched.push("STRATEGY_DATASET_ID");
  if (identity.datasetDigest !== exact.datasetDigest) mismatched.push("STRATEGY_DATASET_DIGEST");
  if (identity.researchCodeSha !== exact.researchCodeSha) mismatched.push("STRATEGY_RESEARCH_CODE_SHA");
  if (mismatched.length > 0) {
    return { status: "IDENTITY_MISMATCH", strategyIdentity: null, strategyIdentityDigest: null, missingEvidence: mismatched };
  }
  return { status: "IDENTITY_COMPLETE", strategyIdentity: identity, strategyIdentityDigest: resolved.strategyIdentityDigest, missingEvidence: [] };
}

function requireGenuineSource(attestation = {}) {
  if (attestation.sourceKind !== "GENUINE_MARKET_DATA"
      || attestation.futureOnly !== true
      || attestation.reconstructed !== false
      || attestation.historicalReconstruction !== false
      || attestation.synthetic !== false
      || attestation.replayDerived !== false
      || attestation.shadowDerived !== false
      || attestation.testFixture !== false
      || attestation.oosIncluded !== false
      || attestation.finalHoldoutIncluded !== false
      || attestation.finalHoldoutAccessed !== false) {
    throw new Error("only genuine future TRAIN/VALIDATION market-data evidence is allowed");
  }
}

function missingIdentityFields(manifest) {
  const missing = [];
  if (!manifest.strategyIdentityDigest) missing.push("STRATEGY_IDENTITY_DIGEST");
  if (!normalizeSha(manifest.researchCodeSha)) missing.push("RESEARCH_CODE_SHA");
  if (!normalizeSha(manifest.trainingCodeSha)) missing.push("TRAINING_CODE_SHA");
  if (!normalizeSha(manifest.producerSha)) missing.push("PRODUCER_SHA");
  if (!manifest.trainingInvocationDigest) missing.push("TRAINING_INVOCATION_DIGEST");
  if (!manifest.artifactReceipt) missing.push("ARTIFACT_RECEIPT");
  return [...new Set(missing)];
}

function trainingInvocationIdentity(manifest) {
  return {
    schemaVersion: TRAINING_INVOCATION_SCHEMA_VERSION,
    researchCodeSha: manifest.researchCodeSha,
    trainingCodeSha: manifest.trainingCodeSha,
    producerSha: manifest.producerSha,
    datasetId: manifest.datasetId,
    datasetDigest: manifest.datasetDigest,
    trainDatasetIdentity: manifest.trainDatasetIdentity,
    trainDatasetDigest: manifest.trainDatasetDigest,
    trainSampleN: manifest.trainSampleN,
    trainByteLength: manifest.trainByteLength,
    validationDatasetIdentity: manifest.validationDatasetIdentity,
    validationDatasetDigest: manifest.validationDatasetDigest,
    validationSampleN: manifest.validationSampleN,
    validationByteLength: manifest.validationByteLength,
    preprocessingVersion: manifest.preprocessingVersion,
    preprocessingContractDigest: manifest.preprocessingContractDigest,
    featureOrderDigest: manifest.featureOrderDigest,
    trainingParametersDigest: manifest.trainingParametersDigest,
    modelSha: manifest.modelSha,
    modelArtifactCanonicalDigest: manifest.modelArtifactCanonicalDigest,
    oosExclusionDigest: manifest.oosExclusionDigest,
    finalHoldoutAccessed: false,
  };
}

function buildReferenceProvenance(manifest) {
  return buildReferenceEvidenceProvenance({
    datasetId: manifest.datasetId,
    datasetDigest: manifest.datasetDigest,
    strategyIdentityDigest: manifest.strategyIdentityDigest,
    researchCodeSha: manifest.researchCodeSha,
    trainingCodeSha: manifest.trainingCodeSha,
    modelSha: manifest.modelSha,
    preprocessingVersion: manifest.preprocessingVersion,
    featureOrderDigest: manifest.featureOrderDigest,
    trainSplitDigest: manifest.trainSplitDigest,
    validationSplitDigest: manifest.validationSplitDigest,
    rawArtifactDigest: manifest.rawArtifactDigest,
    measuredAt: manifest.measuredAt,
    artifactReceipt: manifest.artifactReceipt,
  });
}

function recordRange(records) {
  if (!Array.isArray(records) || records.length === 0) throw new TypeError("TRAIN and VALIDATION records are required for strategy identity");
  const starts = records.map((record) => record?.anchorTimestamp);
  const ends = records.map((record) => record?.futureEndTimestamp ?? record?.anchorTimestamp);
  if ([...starts, ...ends].some((value) => !Number.isInteger(value) || value <= 0)) {
    throw new TypeError("strategy identity dataset range requires immutable record timestamps");
  }
  return Object.freeze({
    datasetStart: new Date(Math.min(...starts)).toISOString(),
    datasetEnd: new Date(Math.max(...ends)).toISOString(),
  });
}

export function buildCanonicalModelReferenceStrategyIdentity({
  group,
  market,
  timeframe,
  trainRecords,
  validationRecords,
  datasetComponents,
  researchCodeSha,
  featureOrder,
  trainingParameters,
  datasetSpecifications,
  inferenceContract,
  ruleWeight,
  modelWeight,
} = {}) {
  if (typeof group !== "string" || !group) throw new TypeError("group is required");
  if (typeof market !== "string" || !market || typeof timeframe !== "string" || !timeframe) {
    throw new TypeError("market and timeframe are required");
  }
  if (!Array.isArray(featureOrder) || !featureOrder.length) throw new TypeError("featureOrder is required");
  if (!trainingParameters || typeof trainingParameters !== "object") throw new TypeError("trainingParameters are required");
  if (!Array.isArray(datasetSpecifications) || !datasetSpecifications.length) throw new TypeError("datasetSpecifications are required");
  if (typeof inferenceContract !== "string" || !inferenceContract) throw new TypeError("inferenceContract is required");
  if (!Number.isFinite(ruleWeight) || !Number.isFinite(modelWeight) || ruleWeight + modelWeight !== 1) {
    throw new TypeError("exact frozen blend weights are required");
  }
  const normalizedResearchSha = normalizeSha(researchCodeSha);
  if (!normalizedResearchSha) throw new TypeError("immutable researchCodeSha is required");
  const datasetId = `prediction-lab:${group}:train-validation`;
  const datasetProvenance = buildCompositeDatasetProvenance({ datasetId, components: datasetComponents });
  const range = recordRange([...(trainRecords ?? []), ...(validationRecords ?? [])]);
  const formulaIdentity = deepFreeze({
    schemaVersion: MODEL_REFERENCE_STRATEGY_FORMULA_SCHEMA_VERSION,
    inferenceContract,
    classNames: ["bullish", "neutral", "bearish"],
    featureOrder: [...featureOrder],
    blendWeights: { rule: ruleWeight, model: modelWeight },
  });
  const parameterIdentity = deepFreeze({
    schemaVersion: MODEL_REFERENCE_STRATEGY_PARAMETER_SCHEMA_VERSION,
    training: structuredClone(trainingParameters),
    datasets: structuredClone(datasetSpecifications),
    preprocessingVersion: PREPROCESSING_VERSION,
    preprocessingContractDigest: sha256Canonical(PREPROCESSING_CONTRACT),
  });
  const resolved = resolveCanonicalStrategyIdentity({
    strategyId: `prediction-lab-${group}-deployed-blend-v1`,
    strategyFamily: "prediction-lab-deployed-rule-model-blend",
    strategyVersion: "v1",
    market,
    direction: "LONG_SHORT_NEUTRAL",
    timeframe,
    formulaIdentity,
    parameterHash: sha256Canonical(parameterIdentity),
    researchCodeSha: normalizedResearchSha,
    datasetId,
    datasetDigest: datasetProvenance.datasetDigest,
    ...range,
    costPolicyVersion: MODEL_REFERENCE_COST_POLICY_VERSION,
    riskPolicyVersion: MODEL_REFERENCE_RISK_POLICY_VERSION,
    evidenceSchemaVersion: MODEL_REFERENCE_EVIDENCE_SCHEMA_VERSION,
  });
  if (resolved.status !== "IDENTITY_COMPLETE") {
    throw new Error(`canonical producer strategy identity is incomplete: ${[...resolved.missingFields, ...resolved.blockers].join(",")}`);
  }
  return deepFreeze({
    strategyIdentity: resolved.identity,
    strategyIdentityDigest: resolved.strategyIdentityDigest,
    formulaIdentity,
    parameterIdentity,
    datasetProvenance,
  });
}

export async function preserveFutureModelReferenceEvidence({
  outputRoot,
  group,
  consumedSplits,
  model,
  modelSha,
  datasetComponents,
  researchCodeSha,
  trainingCodeSha,
  producerSha,
  trainingParameters,
  measuredAt,
  strategyIdentity = null,
  sourceAttestation,
} = {}) {
  requireGenuineSource(sourceAttestation);
  if (typeof group !== "string" || group.length === 0) throw new TypeError("group is required");
  if (!isMaterializedExactTrainValidationSplits(consumedSplits)) {
    throw new TypeError("exact stored TRAIN/VALIDATION bytes must be materialized before training");
  }
  if (!trainingParameters || typeof trainingParameters !== "object" || Array.isArray(trainingParameters)) {
    throw new TypeError("exact trainingParameters are required");
  }
  if (!model || typeof model !== "object" || !Array.isArray(model.featureOrder) || model.featureOrder.length === 0) throw new TypeError("exact trained model is required");
  const exactModelSha = normalizeDigest(modelSha);
  if (!exactModelSha) throw new TypeError("existing modelSha is required");
  const packageRoot = resolve(outputRoot, group);
  const outputs = consumedSplits;
  const expectedRecordsRoot = resolve(packageRoot, "records");
  if (resolve(dirname(outputs.train.path)) !== expectedRecordsRoot || resolve(dirname(outputs.validation.path)) !== expectedRecordsRoot) {
    throw new Error("materialized split paths do not match the immutable reference package");
  }
  const [storedTrainBytes, storedValidationBytes] = await Promise.all([
    readFile(outputs.train.path),
    readFile(outputs.validation.path),
  ]);
  if (sha256(storedTrainBytes) !== outputs.train.sha256 || sha256(storedValidationBytes) !== outputs.validation.sha256
      || storedTrainBytes.length !== outputs.train.byteLength || storedValidationBytes.length !== outputs.validation.byteLength) {
    throw new Error("materialized split bytes changed after the training input boundary");
  }
  const modelBytes = Buffer.from(JSON.stringify(model), "utf8");
  if (sha256(modelBytes) !== exactModelSha) throw new Error("modelSha does not match exact model JSON bytes");
  await atomicWrite(join(packageRoot, "model", "exact-model.json"), modelBytes);

  const datasetId = `prediction-lab:${group}:train-validation`;
  const datasetProvenance = buildCompositeDatasetProvenance({ datasetId, components: datasetComponents });
  const datasetValidation = validateCompositeDatasetProvenance(datasetProvenance);
  if (!datasetValidation.valid || datasetValidation.status !== "VALID") throw new Error("#664 composite dataset provenance is invalid");
  const normalizedResearchSha = normalizeSha(researchCodeSha);
  const normalizedTrainingSha = normalizeSha(trainingCodeSha);
  const normalizedProducerSha = normalizeSha(producerSha);
  if (!normalizedResearchSha || !normalizedTrainingSha || !normalizedProducerSha) {
    throw new TypeError("exact research, training, and producer SHAs are required");
  }
  if (normalizedResearchSha !== normalizedTrainingSha || normalizedResearchSha !== normalizedProducerSha) {
    throw new Error("research, training, and producer SHAs must bind the same exact checkout");
  }
  if (outputs.train.datasetIdentity === outputs.validation.datasetIdentity
      || outputs.train.datasetDigest === outputs.validation.datasetDigest) {
    throw new Error("TRAIN and VALIDATION dataset identities and digests must be distinct");
  }
  const featureOrder = [...model.featureOrder];
  const base = {
    schemaVersion: MODEL_REFERENCE_EVIDENCE_SCHEMA_VERSION,
    status: "MISSING_EVIDENCE",
    referenceProvenanceStatus: "MISSING_EVIDENCE",
    group,
    datasetId,
    datasetDigest: datasetProvenance.datasetDigest,
    datasetProvenance,
    strategyIdentity: null,
    strategyIdentityDigest: null,
    strategyIdentityStatus: "MISSING_EVIDENCE",
    researchCodeSha: normalizedResearchSha,
    trainingCodeSha: normalizedTrainingSha,
    producerSha: normalizedProducerSha,
    modelSha: exactModelSha,
    modelShaSemantics: "sha256(exact UTF-8 bytes of model/exact-model.json; existing JSON.stringify model identity)",
    modelArtifactCanonicalDigest: sha256Canonical(model),
    preprocessingVersion: PREPROCESSING_VERSION,
    preprocessingContract: PREPROCESSING_CONTRACT,
    preprocessingContractDigest: sha256Canonical(PREPROCESSING_CONTRACT),
    featureOrder,
    featureOrderDigest: sha256Canonical(featureOrder),
    trainingParameters: structuredClone(trainingParameters),
    trainingParametersDigest: sha256Canonical(trainingParameters),
    trainDatasetIdentity: outputs.train.datasetIdentity,
    validationDatasetIdentity: outputs.validation.datasetIdentity,
    trainDatasetDigest: outputs.train.datasetDigest,
    validationDatasetDigest: outputs.validation.datasetDigest,
    trainSplitDigest: outputs.train.sha256,
    validationSplitDigest: outputs.validation.sha256,
    measuredAt: isoTimestamp(measuredAt, "measuredAt"),
    trainSampleN: outputs.train.count,
    validationSampleN: outputs.validation.count,
    trainByteLength: outputs.train.byteLength,
    validationByteLength: outputs.validation.byteLength,
    trainRecordIdentityDigest: outputs.train.recordIdentityDigest,
    validationRecordIdentityDigest: outputs.validation.recordIdentityDigest,
    splitIsolation: structuredClone(outputs.isolation),
    splitIsolationStatus: outputs.isolation.status,
    oosExclusionDigest: sha256Canonical(outputs.isolation),
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
    splitAttestations: null,
    trainingInvocation: null,
    trainingInvocationDigest: null,
    rawArtifactDigest: null,
    artifactIdentity: null,
    artifactDigest: null,
    artifactReceipt: null,
    artifactReceiptValidation: { valid: false, status: "MISSING_EVIDENCE", reason: "artifact_receipt_pending_upload" },
    referenceProvenance: null,
    referenceProvenanceValidation: { valid: false, status: "MISSING_EVIDENCE", reason: "artifact_receipt_pending_upload" },
    missingEvidence: [],
    retention: {
      requestedDays: 90,
      durableReferenceStore: "NOT_CONFIGURED",
      longTermReferenceProven: false,
    },
    profitability: { PROFITABILITY_PROVEN: false, FORWARD_EVIDENCE_SUFFICIENT: false },
    safety: REQUIRED_SAFETY,
  };
  const strategy = assessStrategyIdentity(strategyIdentity, {
    datasetId,
    datasetDigest: datasetProvenance.datasetDigest,
    researchCodeSha: normalizedResearchSha,
  });
  base.strategyIdentity = strategy.strategyIdentity;
  base.strategyIdentityDigest = strategy.strategyIdentityDigest;
  base.strategyIdentityStatus = strategy.status;
  if (strategy.status === "IDENTITY_MISMATCH") {
    base.status = "IDENTITY_MISMATCH";
    base.referenceProvenanceStatus = "IDENTITY_MISMATCH";
  }
  base.splitAttestations = splitAttestations(base);
  base.trainingInvocation = trainingInvocationIdentity(base);
  base.trainingInvocationDigest = sha256Canonical(base.trainingInvocation);
  base.rawArtifactDigest = sha256Canonical(rawArtifactIdentity(base));
  base.artifactIdentity = `prediction-lab-model-reference:${group}:sha256:${base.rawArtifactDigest}`;
  base.artifactDigest = base.rawArtifactDigest;
  base.missingEvidence = [...new Set([...strategy.missingEvidence, ...missingIdentityFields(base)])].sort();
  await writeJson(join(packageRoot, "reference-manifest.json"), base);
  return deepFreeze(structuredClone(base));
}

async function groupDirectories(root) {
  const entries = await readdir(root, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name)).sort();
}

export async function finalizeModelReferenceEvidenceReceipts(root, artifactMetadata = {}) {
  const outerArtifactDigest = normalizeDigest(artifactMetadata.outerArtifactDigest);
  if (!outerArtifactDigest) throw new TypeError("actual outer artifact digest is required");
  const receipt = buildReferenceArtifactReceipt({
    artifactId: String(artifactMetadata.artifactId ?? ""),
    artifactName: artifactMetadata.artifactName,
    artifactReference: artifactMetadata.artifactReference,
    outerArtifactDigest,
    createdAt: artifactMetadata.createdAt,
    expiresAt: artifactMetadata.expiresAt,
  });
  const receiptValidation = validateReferenceArtifactReceipt(receipt, { now: artifactMetadata.now ?? artifactMetadata.createdAt });
  if (!receiptValidation.valid || receiptValidation.status !== "VALID") throw new Error("#664 artifact receipt validation failed");
  const reports = [];
  for (const packageRoot of await groupDirectories(resolve(root))) {
    const manifestPath = join(packageRoot, "reference-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.artifactReceipt = receipt;
    manifest.artifactReceiptValidation = receiptValidation;
    manifest.missingEvidence = missingIdentityFields(manifest).filter((item) => item !== "ARTIFACT_RECEIPT");
    if (manifest.strategyIdentityStatus === "IDENTITY_MISMATCH") {
      manifest.referenceProvenance = null;
      manifest.referenceProvenanceValidation = { valid: false, status: "IDENTITY_MISMATCH", reason: "strategy_identity_mismatch" };
      manifest.referenceProvenanceStatus = "IDENTITY_MISMATCH";
      manifest.status = "IDENTITY_MISMATCH";
    } else if (manifest.missingEvidence.length === 0) {
      const provenance = buildReferenceProvenance(manifest);
      const validation = validateReferenceEvidenceProvenance(provenance, { now: artifactMetadata.now ?? artifactMetadata.createdAt });
      if (!validation.valid || validation.status !== "VALID") throw new Error("#664 reference evidence provenance validation failed");
      manifest.referenceProvenance = provenance;
      manifest.referenceProvenanceValidation = validation;
      manifest.referenceProvenanceStatus = "VALID";
      manifest.status = "VALID";
      await writeJson(join(packageRoot, "reference-provenance.json"), provenance);
    } else {
      manifest.referenceProvenance = null;
      manifest.referenceProvenanceValidation = { valid: false, status: "MISSING_EVIDENCE", reason: manifest.missingEvidence.join(",") };
      manifest.referenceProvenanceStatus = "MISSING_EVIDENCE";
      manifest.status = "MISSING_EVIDENCE";
    }
    await writeJson(join(packageRoot, "reference-artifact-receipt.json"), receipt);
    await writeJson(manifestPath, manifest);
    reports.push(await validateModelReferenceEvidencePackage(packageRoot, { now: artifactMetadata.now ?? artifactMetadata.createdAt }));
  }
  return deepFreeze(reports);
}

function decision(status, reason, manifest = null, extra = {}) {
  return deepFreeze({ valid: status === "VALID", status, reason, manifest, ...extra });
}

function jsonlRecords(bytes) {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("raw split JSONL must be exact UTF-8 bytes");
  if (!text.endsWith("\n")) throw new Error("raw split JSONL must end with one newline");
  const lines = text.slice(0, -1).split("\n");
  if (lines.some((line) => line.length === 0)) throw new Error("raw split JSONL contains an empty record");
  const records = lines.map((line) => JSON.parse(line));
  if (records.some((record) => !record || typeof record !== "object" || Array.isArray(record))) {
    throw new Error("raw split JSONL records must be objects");
  }
  return records;
}

export async function validateModelReferenceEvidencePackage(packageRoot, { now = null } = {}) {
  let manifest;
  try { manifest = JSON.parse(await readFile(join(packageRoot, "reference-manifest.json"), "utf8")); }
  catch { return decision("MISSING_EVIDENCE", "reference_manifest_missing"); }
  if (manifest.schemaVersion !== MODEL_REFERENCE_EVIDENCE_SCHEMA_VERSION) return decision("MISSING_EVIDENCE", "reference_manifest_schema_missing", manifest);
  const required = [
    "datasetId", "datasetDigest", "modelSha", "producerSha", "trainingCodeSha", "featureOrderDigest",
    "trainDatasetIdentity", "validationDatasetIdentity", "trainDatasetDigest", "validationDatasetDigest",
    "trainSplitDigest", "validationSplitDigest", "trainingInvocationDigest", "oosExclusionDigest",
    "rawArtifactDigest", "artifactIdentity", "artifactDigest", "measuredAt",
  ];
  if (required.some((field) => !manifest[field])) return decision("MISSING_EVIDENCE", "reference_identity_field_missing", manifest);
  if (!normalizeSha(manifest.researchCodeSha) || !normalizeSha(manifest.trainingCodeSha) || !normalizeSha(manifest.producerSha)
      || manifest.researchCodeSha !== manifest.trainingCodeSha || manifest.researchCodeSha !== manifest.producerSha) {
    return decision("IDENTITY_MISMATCH", "exact_code_sha_binding_mismatch", manifest);
  }
  if (!manifest.preprocessingVersion) return decision("MISSING_EVIDENCE", "preprocessing_version_missing", manifest);
  if (manifest.preprocessingVersion !== PREPROCESSING_VERSION || manifest.preprocessingContractDigest !== sha256Canonical(PREPROCESSING_CONTRACT)) return decision("IDENTITY_MISMATCH", "preprocessing_identity_mismatch", manifest);
  if (!Array.isArray(manifest.featureOrder) || manifest.featureOrder.length === 0 || sha256Canonical(manifest.featureOrder) !== manifest.featureOrderDigest) return decision("IDENTITY_MISMATCH", "feature_order_mismatch", manifest);
  if (!manifest.trainingParameters || sha256Canonical(manifest.trainingParameters) !== manifest.trainingParametersDigest) return decision("IDENTITY_MISMATCH", "training_parameters_identity_mismatch", manifest);
  const datasetValidation = validateCompositeDatasetProvenance(manifest.datasetProvenance);
  if (!datasetValidation.valid) return decision(datasetValidation.status, datasetValidation.reason, manifest);
  if (manifest.datasetId !== manifest.datasetProvenance.datasetId || manifest.datasetDigest !== manifest.datasetProvenance.datasetDigest) return decision("IDENTITY_MISMATCH", "dataset_identity_mismatch", manifest);
  const source = manifest.sourceAttestation;
  if (source?.sourceKind !== "GENUINE_MARKET_DATA" || source.futureOnly !== true
      || source.reconstructed !== false || source.historicalReconstruction !== false
      || source.synthetic !== false || source.replayDerived !== false || source.shadowDerived !== false
      || source.testFixture !== false || source.oosIncluded !== false
      || source.finalHoldoutIncluded !== false || source.finalHoldoutAccessed !== false) {
    return decision("IDENTITY_MISMATCH", "reference_source_substitution_rejected", manifest);
  }
  const trainBytes = await readFile(join(packageRoot, "records", "train.jsonl")).catch(() => null);
  const validationBytes = await readFile(join(packageRoot, "records", "validation.jsonl")).catch(() => null);
  const modelBytes = await readFile(join(packageRoot, "model", "exact-model.json")).catch(() => null);
  if (!trainBytes || !validationBytes || !modelBytes) return decision("MISSING_EVIDENCE", "raw_reference_file_missing", manifest);
  if (sha256(trainBytes) !== manifest.trainSplitDigest || sha256(validationBytes) !== manifest.validationSplitDigest) return decision("IDENTITY_MISMATCH", "raw_split_byte_digest_mismatch", manifest);
  if (trainBytes.equals(validationBytes) || manifest.trainSplitDigest === manifest.validationSplitDigest
      || manifest.trainDatasetIdentity === manifest.validationDatasetIdentity
      || manifest.trainDatasetDigest === manifest.validationDatasetDigest) {
    return decision("IDENTITY_MISMATCH", "train_validation_independence_mismatch", manifest);
  }
  if (manifest.trainDatasetDigest !== manifest.trainSplitDigest || manifest.validationDatasetDigest !== manifest.validationSplitDigest
      || manifest.trainDatasetIdentity !== expectedSplitDatasetIdentity("TRAIN", manifest.trainDatasetDigest)
      || manifest.validationDatasetIdentity !== expectedSplitDatasetIdentity("VALIDATION", manifest.validationDatasetDigest)) {
    return decision("IDENTITY_MISMATCH", "split_dataset_identity_mismatch", manifest);
  }
  let trainRecords;
  let validationRecords;
  try {
    trainRecords = jsonlRecords(trainBytes);
    validationRecords = jsonlRecords(validationBytes);
  } catch {
    return decision("IDENTITY_MISMATCH", "raw_split_jsonl_malformed", manifest);
  }
  const trainSampleN = trainRecords.length;
  const validationSampleN = validationRecords.length;
  if (trainSampleN !== manifest.trainSampleN || validationSampleN !== manifest.validationSampleN
      || trainBytes.length !== manifest.trainByteLength || validationBytes.length !== manifest.validationByteLength) return decision("IDENTITY_MISMATCH", "raw_split_count_or_length_mismatch", manifest);
  const trainIds = trainRecords.map((record) => record.id);
  const validationIds = validationRecords.map((record) => record.id);
  const validationIdSet = new Set(validationIds);
  const trainIdentityDigest = recordIdentityDigest(trainRecords);
  const validationIdentityDigest = recordIdentityDigest(validationRecords);
  if (!trainIdentityDigest || !validationIdentityDigest
      || trainIdentityDigest !== manifest.trainRecordIdentityDigest
      || validationIdentityDigest !== manifest.validationRecordIdentityDigest
      || trainIds.some((id) => validationIdSet.has(id))) {
    return decision("IDENTITY_MISMATCH", "split_record_identity_overlap_or_mismatch", manifest);
  }
  const isolation = manifest.splitIsolation;
  if (!isolation || isolation.schemaVersion !== "PredictionLabReferenceSplitIsolationV1" || isolation.status !== "PASS"
      || isolation.trainValidationOverlapN !== 0 || isolation.trainOosOverlapN !== 0 || isolation.validationOosOverlapN !== 0
      || !Number.isSafeInteger(isolation.oosSampleN) || isolation.oosSampleN <= 0
      || !normalizeDigest(isolation.oosRecordIdentityDigest) || isolation.oosRawBytesPublished !== false
      || isolation.finalHoldoutAccessed !== false || isolation.finalHoldoutIncluded !== false
      || sha256Canonical(isolation) !== manifest.oosExclusionDigest || manifest.splitIsolationStatus !== "PASS") {
    return decision("IDENTITY_MISMATCH", "oos_holdout_contamination_guard_mismatch", manifest);
  }
  if (sha256(modelBytes) !== manifest.modelSha) return decision("IDENTITY_MISMATCH", "model_sha_mismatch", manifest);
  let model;
  try { model = JSON.parse(modelBytes.toString("utf8")); }
  catch { return decision("IDENTITY_MISMATCH", "model_json_malformed", manifest); }
  if (sha256Canonical(model) !== manifest.modelArtifactCanonicalDigest) return decision("IDENTITY_MISMATCH", "model_canonical_digest_mismatch", manifest);
  if (sha256Canonical(model.featureOrder) !== manifest.featureOrderDigest) return decision("IDENTITY_MISMATCH", "model_feature_order_mismatch", manifest);
  const expectedInvocation = trainingInvocationIdentity(manifest);
  if (!manifest.trainingInvocation || sha256Canonical(manifest.trainingInvocation) !== manifest.trainingInvocationDigest
      || sha256Canonical(expectedInvocation) !== manifest.trainingInvocationDigest) {
    return decision("IDENTITY_MISMATCH", "training_invocation_identity_mismatch", manifest);
  }
  const attestations = manifest.splitAttestations;
  if (attestations?.train?.sourceKind !== "RAW_TRAIN" || attestations?.validation?.sourceKind !== "RAW_VALIDATION") return decision("MISSING_EVIDENCE", "split_attestation_missing", manifest);
  if (attestations.train.modelSha !== manifest.modelSha || attestations.validation.modelSha !== manifest.modelSha
      || attestations.train.splitDigest !== manifest.trainSplitDigest || attestations.validation.splitDigest !== manifest.validationSplitDigest
      || attestations.train.datasetIdentity !== manifest.trainDatasetIdentity || attestations.validation.datasetIdentity !== manifest.validationDatasetIdentity
      || attestations.train.datasetDigest !== manifest.trainDatasetDigest || attestations.validation.datasetDigest !== manifest.validationDatasetDigest
      || attestations.train.sampleN !== manifest.trainSampleN || attestations.validation.sampleN !== manifest.validationSampleN
      || attestations.train.byteLength !== manifest.trainByteLength || attestations.validation.byteLength !== manifest.validationByteLength
      || attestations.train.recordIdentityDigest !== manifest.trainRecordIdentityDigest
      || attestations.validation.recordIdentityDigest !== manifest.validationRecordIdentityDigest) return decision("IDENTITY_MISMATCH", "split_attestation_mismatch", manifest);
  if (sha256Canonical(rawArtifactIdentity(manifest)) !== manifest.rawArtifactDigest) return decision("IDENTITY_MISMATCH", "raw_artifact_digest_mismatch", manifest);
  if (manifest.artifactDigest !== manifest.rawArtifactDigest
      || manifest.artifactIdentity !== `prediction-lab-model-reference:${manifest.group}:sha256:${manifest.rawArtifactDigest}`) {
    return decision("IDENTITY_MISMATCH", "artifact_identity_mismatch", manifest);
  }
  const receiptValidation = validateReferenceArtifactReceipt(manifest.artifactReceipt, { now });
  if (!receiptValidation.valid) return decision(receiptValidation.status, receiptValidation.reason, manifest, { rawReferenceValid: true, receiptValidation });
  if (manifest.strategyIdentityStatus === "IDENTITY_MISMATCH") return decision("IDENTITY_MISMATCH", "strategy_identity_mismatch", manifest, { rawReferenceValid: true, receiptValidation });
  if (!manifest.strategyIdentityDigest || !manifest.referenceProvenance) return decision("MISSING_EVIDENCE", "STRATEGY_IDENTITY_DIGEST", manifest, { rawReferenceValid: true, receiptValidation });
  const provenanceValidation = validateReferenceEvidenceProvenance(manifest.referenceProvenance, { now });
  if (!provenanceValidation.valid) return decision(provenanceValidation.status, provenanceValidation.reason, manifest, { rawReferenceValid: true, receiptValidation, provenanceValidation });
  const expected = buildReferenceProvenance(manifest);
  if (expected.provenanceDigest !== manifest.referenceProvenance.provenanceDigest) return decision("IDENTITY_MISMATCH", "reference_provenance_identity_mismatch", manifest, { rawReferenceValid: true, receiptValidation, provenanceValidation });
  return decision("VALID", null, manifest, { rawReferenceValid: true, receiptValidation, provenanceValidation });
}

export function modelReferenceSafety() {
  return REQUIRED_SAFETY;
}
