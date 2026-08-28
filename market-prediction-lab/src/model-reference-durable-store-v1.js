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
      || source.reconstructed !== false
      || source.synthetic !== false
      || source.shadowDerived !== false
      || source.finalHoldoutIncluded !== false) {
    throw new Error("durable reference source substitution rejected");
  }
  return Object.freeze({
    group: text(manifest.group, "reference.group"),
    datasetId: text(manifest.datasetId, "reference.datasetId"),
    datasetDigest: digest(manifest.datasetDigest, "reference.datasetDigest"),
    strategyIdentityDigest: digest(manifest.strategyIdentityDigest, "reference.strategyIdentityDigest"),
    researchCodeSha: sha(manifest.researchCodeSha, "reference.researchCodeSha"),
    trainingCodeSha: sha(manifest.trainingCodeSha, "reference.trainingCodeSha"),
    modelSha: digest(manifest.modelSha, "reference.modelSha"),
    preprocessingVersion: text(manifest.preprocessingVersion, "reference.preprocessingVersion"),
    featureOrderDigest: digest(manifest.featureOrderDigest, "reference.featureOrderDigest"),
    trainSplitDigest: digest(manifest.trainSplitDigest, "reference.trainSplitDigest"),
    validationSplitDigest: digest(manifest.validationSplitDigest, "reference.validationSplitDigest"),
    rawArtifactDigest: digest(manifest.rawArtifactDigest, "reference.rawArtifactDigest"),
    artifactReceiptDigest: digest(manifest.referenceProvenance?.artifactReceiptDigest, "reference.artifactReceiptDigest"),
    referenceProvenanceDigest: digest(manifest.referenceProvenance?.provenanceDigest, "reference.referenceProvenanceDigest"),
    measuredAt: iso(manifest.measuredAt, "reference.measuredAt"),
    trainSampleN: Number.isSafeInteger(manifest.trainSampleN) && manifest.trainSampleN > 0 ? manifest.trainSampleN : (() => { throw new TypeError("reference.trainSampleN is required"); })(),
    validationSampleN: Number.isSafeInteger(manifest.validationSampleN) && manifest.validationSampleN > 0 ? manifest.validationSampleN : (() => { throw new TypeError("reference.validationSampleN is required"); })(),
  });
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
  if (references.some((item) => item.researchCodeSha !== targetCommitSha || item.trainingCodeSha !== targetCommitSha)) {
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
      finalHoldoutIncluded: false,
    },
    safety: REQUIRED_SAFETY,
  };
  return deepFreeze({ ...body, receiptDigest: sha256Canonical(body) });
}

function failure(status, reason, receipt = null) {
  return deepFreeze({ valid: false, status, reason, receipt, durableReferenceStore: "NOT_PROVEN", longTermReferenceProven: false, safety: REQUIRED_SAFETY });
}

export function validateModelReferenceDurableReceiptV1(receipt, { releaseMetadata, assetMetadata, exactBundleBytes } = {}) {
  if (!object(receipt)) return failure("MISSING_EVIDENCE", "DURABLE_RECEIPT_MISSING");
  let rebuilt;
  try {
    rebuilt = buildModelReferenceDurableReceiptV1({
      ...receipt,
      referenceManifests: receipt.references?.map((reference) => ({
        ...reference,
        status: "VALID",
        referenceProvenanceStatus: "VALID",
        sourceAttestation: { sourceKind: "GENUINE_MARKET_DATA", reconstructed: false, synthetic: false, shadowDerived: false, finalHoldoutIncluded: false },
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
  return deepFreeze({
    valid: true,
    status: "VALID",
    reason: null,
    receipt,
    durableReferenceStore: MODEL_REFERENCE_DURABLE_PROVIDER,
    longTermReferenceProven: true,
    safety: REQUIRED_SAFETY,
  });
}

export function modelReferenceDurableSafetyV1() {
  return REQUIRED_SAFETY;
}
