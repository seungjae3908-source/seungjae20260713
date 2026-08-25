import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { sha256 } from "./data-quality.js";
import { exportRawTrainValidationSplits } from "./dataset-export.js";
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
export const PREPROCESSING_VERSION = "prediction-lab-training-preprocessing-v1";
export const PREPROCESSING_CONTRACT = Object.freeze({
  featureCalculation: "analyzeMarket-training-record-features-v1",
  missingValueBehavior: "non-finite-feature-to-zero-v1",
  normalizationBehavior: "train-population-mean-std-scale-floor-1e-6-v1",
  clippingBehavior: "normalized-feature-clamp-minus12-plus12-v1",
  orderingBehavior: "exact-model-feature-order-no-sort-v1",
});

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

function splitAttestations({ modelSha, trainSplitDigest, validationSplitDigest }) {
  return {
    train: { sourceKind: "RAW_TRAIN", modelSha, splitDigest: trainSplitDigest },
    validation: { sourceKind: "RAW_VALIDATION", modelSha, splitDigest: validationSplitDigest },
  };
}

function rawArtifactIdentity(manifest) {
  return {
    schemaVersion: RAW_REFERENCE_BUNDLE_SCHEMA_VERSION,
    datasetId: manifest.datasetId,
    datasetDigest: manifest.datasetDigest,
    modelSha: manifest.modelSha,
    preprocessingVersion: manifest.preprocessingVersion,
    featureOrderDigest: manifest.featureOrderDigest,
    trainSplitDigest: manifest.trainSplitDigest,
    validationSplitDigest: manifest.validationSplitDigest,
    trainSampleN: manifest.trainSampleN,
    validationSampleN: manifest.validationSampleN,
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
      || attestation.reconstructed !== false
      || attestation.synthetic !== false
      || attestation.shadowDerived !== false
      || attestation.finalHoldoutIncluded !== false) {
    throw new Error("only genuine future TRAIN/VALIDATION market-data evidence is allowed");
  }
}

function missingIdentityFields(manifest) {
  const missing = [];
  if (!manifest.strategyIdentityDigest) missing.push("STRATEGY_IDENTITY_DIGEST");
  if (!normalizeSha(manifest.researchCodeSha)) missing.push("RESEARCH_CODE_SHA");
  if (!normalizeSha(manifest.trainingCodeSha)) missing.push("TRAINING_CODE_SHA");
  if (!manifest.artifactReceipt) missing.push("ARTIFACT_RECEIPT");
  return [...new Set(missing)];
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

export async function preserveFutureModelReferenceEvidence({
  outputRoot,
  group,
  trainRecords,
  validationRecords,
  model,
  modelSha,
  datasetComponents,
  researchCodeSha,
  trainingCodeSha,
  measuredAt,
  strategyIdentity = null,
  sourceAttestation,
} = {}) {
  requireGenuineSource(sourceAttestation);
  if (typeof group !== "string" || group.length === 0) throw new TypeError("group is required");
  if (!model || typeof model !== "object" || !Array.isArray(model.featureOrder) || model.featureOrder.length === 0) throw new TypeError("exact trained model is required");
  const exactModelSha = normalizeDigest(modelSha);
  if (!exactModelSha) throw new TypeError("existing modelSha is required");
  const packageRoot = resolve(outputRoot, group);
  const outputs = await exportRawTrainValidationSplits(join(packageRoot, "records"), { train: trainRecords, validation: validationRecords });
  const modelBytes = Buffer.from(JSON.stringify(model), "utf8");
  if (sha256(modelBytes) !== exactModelSha) throw new Error("modelSha does not match exact model JSON bytes");
  await atomicWrite(join(packageRoot, "model", "exact-model.json"), modelBytes);

  const datasetId = `prediction-lab:${group}:train-validation`;
  const datasetProvenance = buildCompositeDatasetProvenance({ datasetId, components: datasetComponents });
  const datasetValidation = validateCompositeDatasetProvenance(datasetProvenance);
  if (!datasetValidation.valid || datasetValidation.status !== "VALID") throw new Error("#664 composite dataset provenance is invalid");
  const normalizedResearchSha = normalizeSha(researchCodeSha);
  const normalizedTrainingSha = normalizeSha(trainingCodeSha);
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
    modelSha: exactModelSha,
    modelShaSemantics: "sha256(exact UTF-8 bytes of model/exact-model.json; existing JSON.stringify model identity)",
    modelArtifactCanonicalDigest: sha256Canonical(model),
    preprocessingVersion: PREPROCESSING_VERSION,
    preprocessingContract: PREPROCESSING_CONTRACT,
    preprocessingContractDigest: sha256Canonical(PREPROCESSING_CONTRACT),
    featureOrder,
    featureOrderDigest: sha256Canonical(featureOrder),
    trainSplitDigest: outputs.train.sha256,
    validationSplitDigest: outputs.validation.sha256,
    measuredAt: isoTimestamp(measuredAt, "measuredAt"),
    trainSampleN: outputs.train.count,
    validationSampleN: outputs.validation.count,
    trainByteLength: outputs.train.byteLength,
    validationByteLength: outputs.validation.byteLength,
    sourceAttestation: {
      sourceKind: "GENUINE_MARKET_DATA",
      reconstructed: false,
      synthetic: false,
      shadowDerived: false,
      finalHoldoutIncluded: false,
    },
    splitAttestations: null,
    rawArtifactDigest: null,
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
  base.rawArtifactDigest = sha256Canonical(rawArtifactIdentity(base));
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

function jsonlCount(bytes) {
  const text = bytes.toString("utf8");
  if (!text.endsWith("\n")) throw new Error("raw split JSONL must end with one newline");
  const lines = text.slice(0, -1).split("\n");
  if (lines.some((line) => line.length === 0)) throw new Error("raw split JSONL contains an empty record");
  for (const line of lines) JSON.parse(line);
  return lines.length;
}

export async function validateModelReferenceEvidencePackage(packageRoot, { now = null } = {}) {
  let manifest;
  try { manifest = JSON.parse(await readFile(join(packageRoot, "reference-manifest.json"), "utf8")); }
  catch { return decision("MISSING_EVIDENCE", "reference_manifest_missing"); }
  if (manifest.schemaVersion !== MODEL_REFERENCE_EVIDENCE_SCHEMA_VERSION) return decision("MISSING_EVIDENCE", "reference_manifest_schema_missing", manifest);
  const required = ["datasetId", "datasetDigest", "modelSha", "featureOrderDigest", "trainSplitDigest", "validationSplitDigest", "rawArtifactDigest", "measuredAt"];
  if (required.some((field) => !manifest[field])) return decision("MISSING_EVIDENCE", "reference_identity_field_missing", manifest);
  if (!manifest.preprocessingVersion) return decision("MISSING_EVIDENCE", "preprocessing_version_missing", manifest);
  if (manifest.preprocessingVersion !== PREPROCESSING_VERSION || manifest.preprocessingContractDigest !== sha256Canonical(PREPROCESSING_CONTRACT)) return decision("IDENTITY_MISMATCH", "preprocessing_identity_mismatch", manifest);
  if (!Array.isArray(manifest.featureOrder) || manifest.featureOrder.length === 0 || sha256Canonical(manifest.featureOrder) !== manifest.featureOrderDigest) return decision("IDENTITY_MISMATCH", "feature_order_mismatch", manifest);
  const datasetValidation = validateCompositeDatasetProvenance(manifest.datasetProvenance);
  if (!datasetValidation.valid) return decision(datasetValidation.status, datasetValidation.reason, manifest);
  if (manifest.datasetId !== manifest.datasetProvenance.datasetId || manifest.datasetDigest !== manifest.datasetProvenance.datasetDigest) return decision("IDENTITY_MISMATCH", "dataset_identity_mismatch", manifest);
  const source = manifest.sourceAttestation;
  if (source?.sourceKind !== "GENUINE_MARKET_DATA" || source.reconstructed !== false || source.synthetic !== false || source.shadowDerived !== false || source.finalHoldoutIncluded !== false) return decision("IDENTITY_MISMATCH", "reference_source_substitution_rejected", manifest);
  const trainBytes = await readFile(join(packageRoot, "records", "train.jsonl")).catch(() => null);
  const validationBytes = await readFile(join(packageRoot, "records", "validation.jsonl")).catch(() => null);
  const modelBytes = await readFile(join(packageRoot, "model", "exact-model.json")).catch(() => null);
  if (!trainBytes || !validationBytes || !modelBytes) return decision("MISSING_EVIDENCE", "raw_reference_file_missing", manifest);
  if (sha256(trainBytes) !== manifest.trainSplitDigest || sha256(validationBytes) !== manifest.validationSplitDigest) return decision("IDENTITY_MISMATCH", "raw_split_byte_digest_mismatch", manifest);
  let trainSampleN;
  let validationSampleN;
  try {
    trainSampleN = jsonlCount(trainBytes);
    validationSampleN = jsonlCount(validationBytes);
  } catch {
    return decision("IDENTITY_MISMATCH", "raw_split_jsonl_malformed", manifest);
  }
  if (trainSampleN !== manifest.trainSampleN || validationSampleN !== manifest.validationSampleN
      || trainBytes.length !== manifest.trainByteLength || validationBytes.length !== manifest.validationByteLength) return decision("IDENTITY_MISMATCH", "raw_split_count_or_length_mismatch", manifest);
  if (sha256(modelBytes) !== manifest.modelSha) return decision("IDENTITY_MISMATCH", "model_sha_mismatch", manifest);
  let model;
  try { model = JSON.parse(modelBytes.toString("utf8")); }
  catch { return decision("IDENTITY_MISMATCH", "model_json_malformed", manifest); }
  if (sha256Canonical(model) !== manifest.modelArtifactCanonicalDigest) return decision("IDENTITY_MISMATCH", "model_canonical_digest_mismatch", manifest);
  if (sha256Canonical(model.featureOrder) !== manifest.featureOrderDigest) return decision("IDENTITY_MISMATCH", "model_feature_order_mismatch", manifest);
  const attestations = manifest.splitAttestations;
  if (attestations?.train?.sourceKind !== "RAW_TRAIN" || attestations?.validation?.sourceKind !== "RAW_VALIDATION") return decision("MISSING_EVIDENCE", "split_attestation_missing", manifest);
  if (attestations.train.modelSha !== manifest.modelSha || attestations.validation.modelSha !== manifest.modelSha
      || attestations.train.splitDigest !== manifest.trainSplitDigest || attestations.validation.splitDigest !== manifest.validationSplitDigest) return decision("IDENTITY_MISMATCH", "split_attestation_mismatch", manifest);
  if (sha256Canonical(rawArtifactIdentity(manifest)) !== manifest.rawArtifactDigest) return decision("IDENTITY_MISMATCH", "raw_artifact_digest_mismatch", manifest);
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
