import { sha256 } from "./data-quality.js";
import { sha256Canonical } from "./research-cache-provenance.js";

export const MODEL_REFERENCE_DURABLE_RECEIPT_SCHEMA_VERSION = "PredictionLabModelReferenceDurableReceiptV1";
export const MODEL_REFERENCE_DURABLE_PROVIDER = "GITHUB_IMMUTABLE_RELEASE";
export const MODEL_REFERENCE_DURABLE_TAG_PREFIX = "prediction-lab-model-reference-v1";

const HASH_64 = /^[0-9a-f]{64}$/u;
const SHA_40 = /^[0-9a-f]{40}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
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

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function text(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${label} is required`);
  return value.trim();
}

function digest(value, label) {
  const normalized = typeof value === "string" ? value.toLowerCase().replace(/^sha256:/u, "") : "";
  if (!HASH_64.test(normalized)) throw new TypeError(`${label} must be an exact SHA256 digest`);
  return normalized;
}

function sha(value, label) {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  if (!SHA_40.test(normalized)) throw new TypeError(`${label} must be an immutable 40-character SHA`);
  return normalized;
}

function identifier(value, label) {
  const normalized = String(value ?? "");
  if (!POSITIVE_INTEGER.test(normalized)) throw new TypeError(`${label} must be a positive numeric identifier`);
  return normalized;
}

function iso(value, label) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${label} must be an ISO timestamp`);
  return new Date(parsed).toISOString();
}

function repository(value) {
  const normalized = text(value, "repository").toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/u.test(normalized)) throw new TypeError("repository must be owner/name");
  return normalized;
}

function referenceBinding(manifest) {
  if (!object(manifest)) throw new TypeError("reference manifest is required");
  if (manifest.status !== "VALID" || manifest.referenceProvenanceStatus !== "VALID") {
    throw new Error("only canonically VALID future reference manifests may enter the durable store");
  }
  const source = manifest.sourceAttestation;
  if (source?.sourceKind !== "GENUINE_MARKET_DATA"
      || source.futureOnly !== true
      || source.reconstructed !== false
      || source.historicalReconstruction !== false
      || source.synthetic !== false
      || source.replayDerived !== false
      || source.shadowDerived !== false
      || source.testFixture !== false
      || source.oosIncluded !== false
      || source.finalHoldoutIncluded !== false
      || source.finalHoldoutAccessed !== false) {
    throw new Error("durable reference source substitution rejected");
  }
  const binding = Object.freeze({
    group: text(manifest.group, "reference.group"),
    datasetId: text(manifest.datasetId, "reference.datasetId"),
    datasetDigest: digest(manifest.datasetDigest, "reference.datasetDigest"),
    strategyIdentityDigest: digest(manifest.strategyIdentityDigest, "reference.strategyIdentityDigest"),
    researchCodeSha: sha(manifest.researchCodeSha, "reference.researchCodeSha"),
    trainingCodeSha: sha(manifest.trainingCodeSha, "reference.trainingCodeSha"),
    producerSha: sha(manifest.producerSha, "reference.producerSha"),
    modelSha: digest(manifest.modelSha, "reference.modelSha"),
    preprocessingVersion: text(manifest.preprocessingVersion, "reference.preprocessingVersion"),
    featureOrderDigest: digest(manifest.featureOrderDigest, "reference.featureOrderDigest"),
    trainDatasetIdentity: text(manifest.trainDatasetIdentity, "reference.trainDatasetIdentity"),
    validationDatasetIdentity: text(manifest.validationDatasetIdentity, "reference.validationDatasetIdentity"),
    trainDatasetDigest: digest(manifest.trainDatasetDigest, "reference.trainDatasetDigest"),
    validationDatasetDigest: digest(manifest.validationDatasetDigest, "reference.validationDatasetDigest"),
    trainSplitDigest: digest(manifest.trainSplitDigest, "reference.trainSplitDigest"),
    validationSplitDigest: digest(manifest.validationSplitDigest, "reference.validationSplitDigest"),
    trainingInvocationDigest: digest(manifest.trainingInvocationDigest, "reference.trainingInvocationDigest"),
    oosExclusionDigest: digest(manifest.oosExclusionDigest, "reference.oosExclusionDigest"),
    splitIsolationStatus: manifest.splitIsolationStatus === "PASS" ? "PASS" : (() => { throw new Error("reference split isolation must PASS"); })(),
    rawArtifactDigest: digest(manifest.rawArtifactDigest, "reference.rawArtifactDigest"),
    artifactIdentity: text(manifest.artifactIdentity, "reference.artifactIdentity"),
    artifactDigest: digest(manifest.artifactDigest, "reference.artifactDigest"),
    artifactReceiptDigest: digest(manifest.referenceProvenance?.artifactReceiptDigest, "reference.artifactReceiptDigest"),
    referenceProvenanceDigest: digest(manifest.referenceProvenance?.provenanceDigest, "reference.referenceProvenanceDigest"),
    measuredAt: iso(manifest.measuredAt, "reference.measuredAt"),
    trainSampleN: Number.isSafeInteger(manifest.trainSampleN) && manifest.trainSampleN > 0 ? manifest.trainSampleN : (() => { throw new TypeError("reference.trainSampleN is required"); })(),
    validationSampleN: Number.isSafeInteger(manifest.validationSampleN) && manifest.validationSampleN > 0 ? manifest.validationSampleN : (() => { throw new TypeError("reference.validationSampleN is required"); })(),
  });
  if (binding.trainDatasetIdentity === binding.validationDatasetIdentity
      || binding.trainDatasetDigest === binding.validationDatasetDigest
      || binding.trainDatasetDigest !== binding.trainSplitDigest
      || binding.validationDatasetDigest !== binding.validationSplitDigest
      || binding.artifactDigest !== binding.rawArtifactDigest
      || binding.artifactIdentity !== `prediction-lab-model-reference:${binding.group}:sha256:${binding.rawArtifactDigest}`) {
    throw new Error("durable TRAIN and VALIDATION split identities must be distinct and exact");
  }
  return binding;
}

function receiptBody(receipt) {
  const body = structuredClone(receipt);
  delete body.receiptDigest;
  return body;
}

function bundleAsset(value) {
  if (!object(value)) throw new TypeError("bundleAsset is required");
  const byteLength = value.byteLength;
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0) throw new TypeError("bundleAsset.byteLength is required");
  return Object.freeze({
    assetId: identifier(value.assetId, "bundleAsset.assetId"),
    assetName: text(value.assetName, "bundleAsset.assetName"),
    assetReference: text(value.assetReference, "bundleAsset.assetReference"),
    outerArtifactDigest: digest(value.outerArtifactDigest, "bundleAsset.outerArtifactDigest"),
    byteLength,
    createdAt: iso(value.createdAt, "bundleAsset.createdAt"),
    state: value.state === "uploaded" ? "uploaded" : (() => { throw new TypeError("bundleAsset.state must be uploaded"); })(),
  });
}

export function buildModelReferenceDurableReceiptV1(input = {}) {
  const sourceWorkflowRunId = identifier(input.sourceWorkflowRunId, "sourceWorkflowRunId");
  const targetCommitSha = sha(input.targetCommitSha, "targetCommitSha");
  const releaseTag = text(input.releaseTag, "releaseTag");
  if (releaseTag !== `${MODEL_REFERENCE_DURABLE_TAG_PREFIX}-${sourceWorkflowRunId}`) {
    throw new Error("releaseTag must bind the exact producer workflow run");
  }
  if (!Array.isArray(input.referenceManifests) || input.referenceManifests.length === 0) {
    throw new TypeError("referenceManifests are required");
  }
  const references = input.referenceManifests.map(referenceBinding).sort((left, right) => left.group.localeCompare(right.group));
  if (new Set(references.map((item) => item.group)).size !== references.length) throw new Error("duplicate durable reference group");
  if (references.some((item) => item.researchCodeSha !== targetCommitSha
      || item.trainingCodeSha !== targetCommitSha || item.producerSha !== targetCommitSha)) {
    throw new Error("durable reference code SHA does not match the exact release target");
  }
  const body = {
    schemaVersion: MODEL_REFERENCE_DURABLE_RECEIPT_SCHEMA_VERSION,
    provider: MODEL_REFERENCE_DURABLE_PROVIDER,
    repository: repository(input.repository),
    sourceWorkflowRunId,
    targetCommitSha,
    releaseId: identifier(input.releaseId, "releaseId"),
    releaseTag,
    releaseReference: text(input.releaseReference, "releaseReference"),
    releaseImmutabilityRequired: true,
    releaseAttestationRequired: true,
    expiresAt: null,
    bundleAsset: bundleAsset(input.bundleAsset),
    receiptAssetName: text(input.receiptAssetName, "receiptAssetName"),
    references,
    sourceContract: {
      actionsReceiptAuthority: "#664 buildReferenceArtifactReceipt",
      referenceProvenanceAuthority: "#664 buildReferenceEvidenceProvenance",
      durableOuterDigestSemantics: "sha256(exact immutable GitHub Release bundle asset bytes)",
      actionsArtifactDigestIsDurableDigest: false,
      reconstructedReferenceAllowed: false,
      shadowReferenceAllowed: false,
      historicalBackfillAllowed: false,
      replayReferenceAllowed: false,
      testFixtureReferenceAllowed: false,
      oosIncluded: false,
      finalHoldoutIncluded: false,
      finalHoldoutAccessed: false,
      exactStoredBytesConsumedByTraining: true,
    },
    safety: REQUIRED_SAFETY,
  };
  return deepFreeze({ ...body, receiptDigest: sha256Canonical(body) });
}

function failure(status, reason, receipt = null) {
  return deepFreeze({ valid: false, status, reason, receipt, durableReferenceStore: "NOT_PROVEN", longTermReferenceProven: false, safety: REQUIRED_SAFETY });
}

export function validateModelReferenceDurableReceiptV1(receipt, {
  releaseMetadata,
  assetMetadata,
  exactBundleBytes,
  receiptAssetMetadata,
  exactReceiptBytes,
} = {}) {
  if (!object(receipt)) return failure("MISSING_EVIDENCE", "DURABLE_RECEIPT_MISSING");
  let rebuilt;
  try {
    rebuilt = buildModelReferenceDurableReceiptV1({
      ...receipt,
      referenceManifests: receipt.references?.map((reference) => ({
        ...reference,
        status: "VALID",
        referenceProvenanceStatus: "VALID",
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
        referenceProvenance: { artifactReceiptDigest: reference.artifactReceiptDigest, provenanceDigest: reference.referenceProvenanceDigest },
      })),
    });
  } catch {
    return failure("IDENTITY_MISMATCH", "DURABLE_RECEIPT_CONTRACT_INVALID", receipt);
  }
  if (!HASH_64.test(String(receipt.receiptDigest ?? "")) || rebuilt.receiptDigest !== receipt.receiptDigest
      || sha256Canonical(receiptBody(receipt)) !== receipt.receiptDigest) {
    return failure("IDENTITY_MISMATCH", "DURABLE_RECEIPT_DIGEST_MISMATCH", receipt);
  }
  if (!object(releaseMetadata) || releaseMetadata.immutable !== true || releaseMetadata.draft !== false) {
    return failure("MISSING_EVIDENCE", "IMMUTABLE_RELEASE_NOT_PROVEN", receipt);
  }
  const releaseId = String(releaseMetadata.id ?? "");
  const releaseTarget = String(releaseMetadata.target_commitish ?? "").toLowerCase();
  if (releaseId !== receipt.releaseId || releaseMetadata.tag_name !== receipt.releaseTag || releaseTarget !== receipt.targetCommitSha) {
    return failure("IDENTITY_MISMATCH", "IMMUTABLE_RELEASE_IDENTITY_MISMATCH", receipt);
  }
  if (!object(assetMetadata)) return failure("MISSING_EVIDENCE", "DURABLE_ASSET_METADATA_MISSING", receipt);
  const assetDigest = typeof assetMetadata.digest === "string" ? assetMetadata.digest.replace(/^sha256:/u, "").toLowerCase() : "";
  if (String(assetMetadata.id ?? "") !== receipt.bundleAsset.assetId
      || assetMetadata.name !== receipt.bundleAsset.assetName
      || assetMetadata.browser_download_url !== receipt.bundleAsset.assetReference
      || assetMetadata.state !== "uploaded"
      || assetMetadata.size !== receipt.bundleAsset.byteLength
      || assetDigest !== receipt.bundleAsset.outerArtifactDigest) {
    return failure("IDENTITY_MISMATCH", "DURABLE_ASSET_IDENTITY_MISMATCH", receipt);
  }
  if (!(Buffer.isBuffer(exactBundleBytes) || exactBundleBytes instanceof Uint8Array)) {
    return failure("MISSING_EVIDENCE", "DURABLE_BUNDLE_BYTES_MISSING", receipt);
  }
  if (sha256(exactBundleBytes) !== receipt.bundleAsset.outerArtifactDigest) {
    return failure("IDENTITY_MISMATCH", "DURABLE_BUNDLE_BYTE_DIGEST_MISMATCH", receipt);
  }
  if (!object(receiptAssetMetadata)) return failure("MISSING_EVIDENCE", "DURABLE_RECEIPT_ASSET_METADATA_MISSING", receipt);
  if (!(Buffer.isBuffer(exactReceiptBytes) || exactReceiptBytes instanceof Uint8Array)) {
    return failure("MISSING_EVIDENCE", "DURABLE_RECEIPT_EXACT_BYTES_MISSING", receipt);
  }
  const exactReceiptDigest = sha256(exactReceiptBytes);
  const receiptAssetDigest = typeof receiptAssetMetadata.digest === "string"
    ? receiptAssetMetadata.digest.replace(/^sha256:/u, "").toLowerCase()
    : "";
  let parsedReceipt;
  try { parsedReceipt = JSON.parse(Buffer.from(exactReceiptBytes).toString("utf8")); }
  catch { return failure("IDENTITY_MISMATCH", "DURABLE_RECEIPT_ASSET_JSON_MALFORMED", receipt); }
  if (String(receiptAssetMetadata.id ?? "") === receipt.bundleAsset.assetId
      || receiptAssetMetadata.name !== receipt.receiptAssetName
      || receiptAssetMetadata.state !== "uploaded"
      || receiptAssetMetadata.size !== exactReceiptBytes.length
      || receiptAssetDigest !== exactReceiptDigest
      || sha256Canonical(parsedReceipt) !== sha256Canonical(receipt)) {
    return failure("IDENTITY_MISMATCH", "DURABLE_RECEIPT_ASSET_IDENTITY_MISMATCH", receipt);
  }
  const releaseAssetIds = new Set(Array.isArray(releaseMetadata.assets)
    ? releaseMetadata.assets.map((asset) => String(asset?.id ?? ""))
    : []);
  if (!releaseAssetIds.has(receipt.bundleAsset.assetId)
      || !releaseAssetIds.has(String(receiptAssetMetadata.id ?? ""))) {
    return failure("IDENTITY_MISMATCH", "DURABLE_RELEASE_ASSET_MEMBERSHIP_MISMATCH", receipt);
  }
  return deepFreeze({
    valid: true,
    status: "VALID",
    reason: null,
    receipt,
    durableReferenceStore: MODEL_REFERENCE_DURABLE_PROVIDER,
    longTermReferenceProven: true,
    publicationReceiptProven: true,
    safety: REQUIRED_SAFETY,
  });
}

export function modelReferenceDurableSafetyV1() {
  return REQUIRED_SAFETY;
}
