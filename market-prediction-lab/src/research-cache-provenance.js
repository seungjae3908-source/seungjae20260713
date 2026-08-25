import { createHash } from "node:crypto";

export const RESEARCH_DATASET_IDENTITY_SCHEMA_VERSION = "ResearchDatasetIdentityV1";
export const RESEARCH_CACHE_PROVENANCE_SCHEMA_VERSION = 3;
export const CACHE_REUSE_STATUS = Object.freeze({
  EXACT_IDENTITY_MATCH: "EXACT_IDENTITY_MATCH",
  MISSING_EVIDENCE: "MISSING_EVIDENCE",
  IDENTITY_MISMATCH: "IDENTITY_MISMATCH",
});

const SHA40 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

function canonical(value, stack = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical values must contain only finite numbers");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new TypeError(`unsupported canonical value: ${typeof value}`);
  }
  if (stack.has(value)) throw new TypeError("canonical values must not be circular");
  const nextStack = new Set(stack);
  nextStack.add(value);
  if (Array.isArray(value)) return value.map((item) => canonical(item, nextStack));
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("canonical values must contain only plain objects and arrays");
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key], nextStack)]));
}

function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

export function sha256Canonical(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${label} is required`);
  return value.trim();
}

function exactSha(value, label) {
  const normalized = nonEmptyString(value, label).toLowerCase();
  if (!SHA40.test(normalized)) throw new TypeError(`${label} must be a 40-character commit SHA`);
  return normalized;
}

function exactDigest(value, label) {
  const normalized = nonEmptyString(value, label).toLowerCase();
  if (!SHA256.test(normalized)) throw new TypeError(`${label} must be a SHA-256 digest`);
  return normalized;
}

function positiveTimestamp(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer timestamp`);
  return value;
}

function positiveCount(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive integer`);
  return value;
}

function optionalCount(value, label) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative integer when present`);
  return value;
}

function plainRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0) {
    throw new TypeError(`${label} is required`);
  }
  return canonical(value);
}

function isoTimestamp(value, label) {
  const input = nonEmptyString(value, label);
  const timestamp = Date.parse(input);
  if (!Number.isFinite(timestamp)) throw new TypeError(`${label} must be an ISO timestamp`);
  return new Date(timestamp).toISOString();
}

function datasetIdentityCore(identity) {
  return {
    schemaVersion: identity.schemaVersion,
    market: identity.market,
    symbol: identity.symbol,
    timeframe: identity.timeframe,
    provider: identity.provider,
    providerVersion: identity.providerVersion,
    sourceType: identity.sourceType,
    requestedStart: identity.requestedStart,
    requestedEnd: identity.requestedEnd,
    actualStart: identity.actualStart,
    actualEnd: identity.actualEnd,
    candleCount: identity.candleCount,
    rowCount: identity.rowCount,
    adjustmentMode: identity.adjustmentMode,
    corporateActionMode: identity.corporateActionMode,
    timezone: identity.timezone,
    splitContract: identity.splitContract,
    sourceDigest: identity.sourceDigest,
    datasetDigest: identity.datasetDigest,
    researchCodeSha: identity.researchCodeSha,
    loaderVersion: identity.loaderVersion,
    missingIntervalCount: identity.missingIntervalCount,
    duplicateRowCount: identity.duplicateRowCount,
    dataQualityStatus: identity.dataQualityStatus,
  };
}

export function buildResearchDatasetIdentity(input = {}) {
  const rows = input.rows ?? input.candles ?? null;
  if (rows != null && (!Array.isArray(rows) || rows.length === 0)) throw new TypeError("rows must be a non-empty array when present");

  const requestedStart = positiveTimestamp(input.requestedStart ?? input.requestedStartTime, "requestedStart");
  const requestedEnd = positiveTimestamp(input.requestedEnd ?? input.requestedEndTime, "requestedEnd");
  const actualStart = positiveTimestamp(input.actualStart ?? input.actualStartTime, "actualStart");
  const actualEnd = positiveTimestamp(input.actualEnd ?? input.actualEndTime, "actualEnd");
  if (requestedEnd <= requestedStart) throw new RangeError("requestedEnd must be greater than requestedStart");
  if (actualEnd < actualStart) throw new RangeError("actualEnd must be greater than or equal to actualStart");

  const suppliedRowCount = input.rowCount ?? input.candleCount ?? rows?.length;
  const rowCount = positiveCount(suppliedRowCount, "rowCount");
  if (rows && rows.length !== rowCount) throw new Error("rowCount must exactly match rows.length");
  if (input.candleCount != null && input.candleCount !== rowCount) throw new Error("candleCount must exactly match rowCount");

  const computedDatasetDigest = rows ? sha256Canonical(rows) : null;
  const suppliedDatasetDigest = input.datasetDigest ?? input.dataDigest ?? computedDatasetDigest;
  const datasetDigest = exactDigest(suppliedDatasetDigest, "datasetDigest");
  if (computedDatasetDigest && computedDatasetDigest !== datasetDigest) throw new Error("datasetDigest does not match canonical rows");

  const market = nonEmptyString(input.market, "market").toUpperCase();
  const corporateActionMode = input.corporateActionMode == null
    ? (market.endsWith("STOCK") ? null : "not_applicable")
    : nonEmptyString(input.corporateActionMode, "corporateActionMode");
  if (corporateActionMode == null) throw new TypeError("corporateActionMode is required for stock datasets");

  const missingIntervalCount = optionalCount(input.missingIntervalCount, "missingIntervalCount");
  const duplicateRowCount = optionalCount(input.duplicateRowCount, "duplicateRowCount");
  const dataQualityStatus = input.dataQualityStatus == null
    ? "MISSING_EVIDENCE"
    : nonEmptyString(input.dataQualityStatus, "dataQualityStatus");

  const core = {
    schemaVersion: RESEARCH_DATASET_IDENTITY_SCHEMA_VERSION,
    market,
    symbol: nonEmptyString(input.symbol, "symbol").toUpperCase(),
    timeframe: nonEmptyString(input.timeframe, "timeframe"),
    provider: nonEmptyString(input.provider, "provider"),
    providerVersion: nonEmptyString(input.providerVersion, "providerVersion"),
    sourceType: nonEmptyString(input.sourceType, "sourceType"),
    requestedStart,
    requestedEnd,
    actualStart,
    actualEnd,
    candleCount: input.candleCount == null ? null : rowCount,
    rowCount,
    adjustmentMode: nonEmptyString(input.adjustmentMode, "adjustmentMode"),
    corporateActionMode,
    timezone: nonEmptyString(input.timezone, "timezone"),
    splitContract: plainRecord(input.splitContract, "splitContract"),
    sourceDigest: input.sourceDigest == null && input.providerManifestDigest == null
      ? null
      : exactDigest(input.sourceDigest ?? input.providerManifestDigest, "sourceDigest"),
    datasetDigest,
    researchCodeSha: exactSha(input.researchCodeSha, "researchCodeSha"),
    loaderVersion: nonEmptyString(input.loaderVersion, "loaderVersion"),
    missingIntervalCount,
    duplicateRowCount,
    dataQualityStatus,
  };
  const datasetIdentityId = sha256Canonical(core);
  return deepFreeze({
    ...core,
    datasetIdentityId,
    generatedAt: isoTimestamp(input.generatedAt, "generatedAt"),
  });
}

function inspectDatasetIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, status: CACHE_REUSE_STATUS.MISSING_EVIDENCE, reason: "dataset_identity_missing" };
  }
  if (value.schemaVersion !== RESEARCH_DATASET_IDENTITY_SCHEMA_VERSION) {
    return { valid: false, status: CACHE_REUSE_STATUS.MISSING_EVIDENCE, reason: "dataset_identity_schema_missing" };
  }
  try {
    const rebuilt = buildResearchDatasetIdentity({
      ...datasetIdentityCore(value),
      generatedAt: value.generatedAt,
    });
    if (typeof value.datasetIdentityId !== "string" || !SHA256.test(value.datasetIdentityId)) {
      return { valid: false, status: CACHE_REUSE_STATUS.MISSING_EVIDENCE, reason: "dataset_identity_digest_missing" };
    }
    if (rebuilt.datasetIdentityId !== value.datasetIdentityId) {
      return { valid: false, status: CACHE_REUSE_STATUS.IDENTITY_MISMATCH, reason: "dataset_identity_digest_mismatch" };
    }
    if (canonicalJson(datasetIdentityCore(rebuilt)) !== canonicalJson(datasetIdentityCore(value))) {
      return { valid: false, status: CACHE_REUSE_STATUS.IDENTITY_MISMATCH, reason: "dataset_identity_not_canonical" };
    }
    return { valid: true, status: "VALID", reason: null, identity: rebuilt };
  } catch {
    return { valid: false, status: CACHE_REUSE_STATUS.MISSING_EVIDENCE, reason: "dataset_identity_malformed" };
  }
}

export function validateResearchDatasetIdentity(value) {
  const result = inspectDatasetIdentity(value);
  return deepFreeze({
    valid: result.valid,
    status: result.status,
    reason: result.reason,
    datasetIdentityId: result.valid ? result.identity.datasetIdentityId : null,
  });
}

function historicalNamespace(identity) {
  return `historical:${sha256Canonical({
    schemaVersion: identity.schemaVersion,
    market: identity.market,
    provider: identity.provider,
    providerVersion: identity.providerVersion,
    sourceType: identity.sourceType,
    adjustmentMode: identity.adjustmentMode,
    corporateActionMode: identity.corporateActionMode,
    timezone: identity.timezone,
    loaderVersion: identity.loaderVersion,
  })}`;
}

export function buildHistoricalCacheProvenance(input = {}) {
  const identityAssessment = input.datasetIdentity
    ? inspectDatasetIdentity(input.datasetIdentity)
    : { valid: true, identity: buildResearchDatasetIdentity(input) };
  if (!identityAssessment.valid) throw new TypeError(`datasetIdentity is invalid: ${identityAssessment.reason}`);
  const datasetIdentity = identityAssessment.identity;
  const cacheNamespace = historicalNamespace(datasetIdentity);
  return deepFreeze({
    schemaVersion: RESEARCH_CACHE_PROVENANCE_SCHEMA_VERSION,
    cacheType: "historical_raw",
    cacheNamespace,
    cacheKey: `${cacheNamespace}:${datasetIdentity.datasetIdentityId}`,
    datasetIdentity,
    identity: datasetIdentity,
    coverage: {
      candleCount: datasetIdentity.candleCount,
      rowCount: datasetIdentity.rowCount,
      actualStart: datasetIdentity.actualStart,
      actualEnd: datasetIdentity.actualEnd,
    },
    guards: {
      provenanceComplete: true,
      closedCandlesOnly: input.closedCandlesOnly === true,
      duplicatesHandled: input.duplicatesHandled === true,
      missingIntervalsDetected: input.missingIntervalsDetected === true,
      exactDatasetIdentityRequired: true,
      exactProviderVersionRequired: true,
      exactCoverageRequired: true,
      exactAdjustmentModeRequired: true,
      exactDatasetDigestRequired: true,
      exactResearchCodeShaRequired: true,
      exactSplitContractRequired: true,
      exactLoaderVersionRequired: true,
      syntheticDataAllowed: false,
      staleReuseAllowed: false,
    },
  });
}

export function buildStrategyResultCacheProvenance({
  datasetIdentity,
  historicalCacheProvenance,
  historicalCacheKey,
  researchCodeSha,
  strategyVersion,
  parameters,
  costModel,
  splitContract,
  direction,
} = {}) {
  const resolvedDatasetIdentity = datasetIdentity ?? historicalCacheProvenance?.datasetIdentity;
  const assessment = inspectDatasetIdentity(resolvedDatasetIdentity);
  if (!assessment.valid) throw new TypeError(`datasetIdentity is invalid: ${assessment.reason}`);
  const resolvedHistoricalCacheKey = historicalCacheKey ?? historicalCacheProvenance?.cacheKey;
  if (typeof resolvedHistoricalCacheKey !== "string" || !resolvedHistoricalCacheKey.startsWith("historical:")) throw new TypeError("historicalCacheKey is required");
  const normalizedResearchSha = exactSha(researchCodeSha, "researchCodeSha");
  if (normalizedResearchSha !== assessment.identity.researchCodeSha) throw new Error("researchCodeSha must match datasetIdentity");
  const normalizedSplit = plainRecord(splitContract, "splitContract");
  if (sha256Canonical(normalizedSplit) !== sha256Canonical(assessment.identity.splitContract)) throw new Error("splitContract must match datasetIdentity");
  const identity = {
    datasetIdentityId: assessment.identity.datasetIdentityId,
    datasetDigest: assessment.identity.datasetDigest,
    researchCodeSha: normalizedResearchSha,
    historicalCacheKey: resolvedHistoricalCacheKey,
    strategyVersion: nonEmptyString(strategyVersion, "strategyVersion"),
    parameters: plainRecord(parameters, "parameters"),
    costModel: plainRecord(costModel, "costModel"),
    splitContract: normalizedSplit,
    direction: nonEmptyString(direction, "direction").toUpperCase(),
  };
  return deepFreeze({
    schemaVersion: RESEARCH_CACHE_PROVENANCE_SCHEMA_VERSION,
    cacheType: "strategy_result",
    cacheKey: `strategy:${sha256Canonical(identity)}`,
    datasetIdentity: assessment.identity,
    identity,
    guards: {
      provenanceComplete: true,
      exactDatasetIdentityRequired: true,
      exactResearchCodeShaRequired: true,
      exactHistoricalDataDigestRequired: true,
      exactParametersRequired: true,
      exactCostModelRequired: true,
      exactSplitContractRequired: true,
      staleReuseAllowed: false,
    },
  });
}

function decision(reusable, status, reason = null) {
  return deepFreeze({
    reusable,
    reason,
    cacheReuseAllowed: reusable,
    cacheStatus: status,
    CACHE_REUSE_ALLOWED: reusable,
    CACHE_STATUS: status,
  });
}

function assessGuards(record, requiredTrue, requiredFalse) {
  if (!record.guards || typeof record.guards !== "object" || Array.isArray(record.guards)) {
    return { status: CACHE_REUSE_STATUS.MISSING_EVIDENCE, reason: "cache_guards_missing" };
  }
  for (const key of [...requiredTrue, ...requiredFalse]) {
    if (typeof record.guards[key] !== "boolean") return { status: CACHE_REUSE_STATUS.MISSING_EVIDENCE, reason: `cache_guard_missing:${key}` };
  }
  for (const key of requiredTrue) {
    if (record.guards[key] !== true) return { status: CACHE_REUSE_STATUS.IDENTITY_MISMATCH, reason: `cache_guard_mismatch:${key}` };
  }
  for (const key of requiredFalse) {
    if (record.guards[key] !== false) return { status: CACHE_REUSE_STATUS.IDENTITY_MISMATCH, reason: `cache_guard_mismatch:${key}` };
  }
  return null;
}

function assessHistoricalRecord(record) {
  if (record.schemaVersion !== RESEARCH_CACHE_PROVENANCE_SCHEMA_VERSION || record.cacheType !== "historical_raw") {
    return { status: CACHE_REUSE_STATUS.MISSING_EVIDENCE, reason: "historical_cache_provenance_missing" };
  }
  const identityAssessment = inspectDatasetIdentity(record.datasetIdentity);
  if (!identityAssessment.valid) return identityAssessment;
  if (!record.identity || canonicalJson(datasetIdentityCore(record.identity)) !== canonicalJson(datasetIdentityCore(record.datasetIdentity))) {
    return { status: CACHE_REUSE_STATUS.MISSING_EVIDENCE, reason: "cache_identity_alias_missing" };
  }
  const namespace = historicalNamespace(identityAssessment.identity);
  const cacheKey = `${namespace}:${identityAssessment.identity.datasetIdentityId}`;
  if (typeof record.cacheNamespace !== "string" || typeof record.cacheKey !== "string") {
    return { status: CACHE_REUSE_STATUS.MISSING_EVIDENCE, reason: "historical_cache_key_missing" };
  }
  if (record.cacheNamespace !== namespace || record.cacheKey !== cacheKey) {
    return { status: CACHE_REUSE_STATUS.IDENTITY_MISMATCH, reason: "historical_cache_digest_mismatch" };
  }
  const guardFailure = assessGuards(record, [
    "provenanceComplete",
    "closedCandlesOnly",
    "duplicatesHandled",
    "missingIntervalsDetected",
    "exactDatasetIdentityRequired",
    "exactProviderVersionRequired",
    "exactCoverageRequired",
    "exactAdjustmentModeRequired",
    "exactDatasetDigestRequired",
    "exactResearchCodeShaRequired",
    "exactSplitContractRequired",
    "exactLoaderVersionRequired",
  ], ["syntheticDataAllowed", "staleReuseAllowed"]);
  if (guardFailure) return guardFailure;
  return { valid: true, identity: datasetIdentityCore(identityAssessment.identity) };
}

function assessStrategyRecord(record) {
  if (record.schemaVersion !== RESEARCH_CACHE_PROVENANCE_SCHEMA_VERSION || record.cacheType !== "strategy_result") {
    return { status: CACHE_REUSE_STATUS.MISSING_EVIDENCE, reason: "strategy_cache_provenance_missing" };
  }
  const identityAssessment = inspectDatasetIdentity(record.datasetIdentity);
  if (!identityAssessment.valid) return identityAssessment;
  if (!record.identity || typeof record.identity !== "object" || Array.isArray(record.identity)) {
    return { status: CACHE_REUSE_STATUS.MISSING_EVIDENCE, reason: "strategy_cache_identity_missing" };
  }
  const required = ["datasetIdentityId", "datasetDigest", "researchCodeSha", "historicalCacheKey", "strategyVersion", "parameters", "costModel", "splitContract", "direction"];
  if (required.some((key) => record.identity[key] == null)) {
    return { status: CACHE_REUSE_STATUS.MISSING_EVIDENCE, reason: "strategy_cache_identity_malformed" };
  }
  if (record.identity.datasetIdentityId !== identityAssessment.identity.datasetIdentityId
      || record.identity.datasetDigest !== identityAssessment.identity.datasetDigest
      || record.identity.researchCodeSha !== identityAssessment.identity.researchCodeSha
      || sha256Canonical(record.identity.splitContract) !== sha256Canonical(identityAssessment.identity.splitContract)) {
    return { status: CACHE_REUSE_STATUS.IDENTITY_MISMATCH, reason: "strategy_dataset_identity_mismatch" };
  }
  const expectedKey = `strategy:${sha256Canonical(record.identity)}`;
  if (typeof record.cacheKey !== "string") return { status: CACHE_REUSE_STATUS.MISSING_EVIDENCE, reason: "strategy_cache_key_missing" };
  if (record.cacheKey !== expectedKey) return { status: CACHE_REUSE_STATUS.IDENTITY_MISMATCH, reason: "strategy_cache_digest_mismatch" };
  const guardFailure = assessGuards(record, [
    "provenanceComplete",
    "exactDatasetIdentityRequired",
    "exactResearchCodeShaRequired",
    "exactHistoricalDataDigestRequired",
    "exactParametersRequired",
    "exactCostModelRequired",
    "exactSplitContractRequired",
  ], ["staleReuseAllowed"]);
  if (guardFailure) return guardFailure;
  return { valid: true, identity: record.identity };
}

function assessCacheRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return { status: CACHE_REUSE_STATUS.MISSING_EVIDENCE, reason: "cache_provenance_missing" };
  }
  if (record.cacheType === "historical_raw") return assessHistoricalRecord(record);
  if (record.cacheType === "strategy_result") return assessStrategyRecord(record);
  return { status: CACHE_REUSE_STATUS.MISSING_EVIDENCE, reason: "cache_type_missing" };
}

export function validateCacheReuse(expected, actual) {
  try {
    const expectedAssessment = assessCacheRecord(expected);
    if (!expectedAssessment.valid) return decision(false, expectedAssessment.status, `expected:${expectedAssessment.reason}`);
    const actualAssessment = assessCacheRecord(actual);
    if (!actualAssessment.valid) return decision(false, actualAssessment.status, actualAssessment.reason);
    if (expected.cacheType !== actual.cacheType) return decision(false, CACHE_REUSE_STATUS.IDENTITY_MISMATCH, "cache_type_mismatch");
    if (expected.cacheKey !== actual.cacheKey || sha256Canonical(expectedAssessment.identity) !== sha256Canonical(actualAssessment.identity)) {
      return decision(false, CACHE_REUSE_STATUS.IDENTITY_MISMATCH, "cache_identity_mismatch");
    }
    return decision(true, CACHE_REUSE_STATUS.EXACT_IDENTITY_MATCH);
  } catch {
    return decision(false, CACHE_REUSE_STATUS.MISSING_EVIDENCE, "cache_record_malformed");
  }
}

export const RESEARCH_COMPOSITE_DATASET_PROVENANCE_SCHEMA_VERSION = "ResearchCompositeDatasetProvenanceV1";
export const RESEARCH_REFERENCE_ARTIFACT_RECEIPT_SCHEMA_VERSION = "ResearchReferenceArtifactReceiptV1";
export const RESEARCH_REFERENCE_EVIDENCE_SCHEMA_VERSION = "ResearchReferenceEvidenceProvenanceV1";
export const REFERENCE_EVIDENCE_STATUS = Object.freeze({
  EXACT_IDENTITY_MATCH: CACHE_REUSE_STATUS.EXACT_IDENTITY_MATCH,
  MISSING_EVIDENCE: CACHE_REUSE_STATUS.MISSING_EVIDENCE,
  IDENTITY_MISMATCH: CACHE_REUSE_STATUS.IDENTITY_MISMATCH,
  REFERENCE_EXPIRED: "REFERENCE_EXPIRED",
});

function digestComponents(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0) {
    throw new TypeError(`${label} is required`);
  }
  const normalized = {};
  for (const key of Object.keys(value).sort()) {
    const component = nonEmptyString(key, `${label} key`);
    normalized[component] = exactDigest(value[key], `${label}.${component}`);
  }
  return normalized;
}

export function buildCompositeDatasetProvenance({ datasetId, components } = {}) {
  const core = {
    schemaVersion: RESEARCH_COMPOSITE_DATASET_PROVENANCE_SCHEMA_VERSION,
    datasetId: nonEmptyString(datasetId, "datasetId"),
    components: digestComponents(components, "components"),
  };
  return deepFreeze({
    ...core,
    componentCount: Object.keys(core.components).length,
    datasetDigest: sha256Canonical(core),
  });
}

function inspectCompositeDatasetProvenance(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, status: REFERENCE_EVIDENCE_STATUS.MISSING_EVIDENCE, reason: "composite_dataset_missing" };
  }
  if (value.schemaVersion !== RESEARCH_COMPOSITE_DATASET_PROVENANCE_SCHEMA_VERSION) {
    return { valid: false, status: REFERENCE_EVIDENCE_STATUS.MISSING_EVIDENCE, reason: "composite_dataset_schema_missing" };
  }
  try {
    const rebuilt = buildCompositeDatasetProvenance({ datasetId: value.datasetId, components: value.components });
    if (typeof value.datasetDigest !== "string" || !SHA256.test(value.datasetDigest)) {
      return { valid: false, status: REFERENCE_EVIDENCE_STATUS.MISSING_EVIDENCE, reason: "composite_dataset_digest_missing" };
    }
    if (rebuilt.datasetDigest !== value.datasetDigest || rebuilt.componentCount !== value.componentCount) {
      return { valid: false, status: REFERENCE_EVIDENCE_STATUS.IDENTITY_MISMATCH, reason: "composite_dataset_digest_mismatch" };
    }
    return { valid: true, status: "VALID", reason: null, provenance: rebuilt };
  } catch {
    return { valid: false, status: REFERENCE_EVIDENCE_STATUS.MISSING_EVIDENCE, reason: "composite_dataset_malformed" };
  }
}

export function validateCompositeDatasetProvenance(value) {
  const result = inspectCompositeDatasetProvenance(value);
  return deepFreeze({
    valid: result.valid,
    status: result.status,
    reason: result.reason,
    datasetDigest: result.valid ? result.provenance.datasetDigest : null,
  });
}

function normalizeArtifactReceiptInput(input = {}) {
  const createdAt = isoTimestamp(input.createdAt, "artifactReceipt.createdAt");
  const expiresAt = isoTimestamp(input.expiresAt, "artifactReceipt.expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) throw new RangeError("artifactReceipt.expiresAt must be after createdAt");
  return {
    schemaVersion: RESEARCH_REFERENCE_ARTIFACT_RECEIPT_SCHEMA_VERSION,
    artifactId: nonEmptyString(input.artifactId, "artifactReceipt.artifactId"),
    artifactName: nonEmptyString(input.artifactName, "artifactReceipt.artifactName"),
    artifactReference: nonEmptyString(input.artifactReference, "artifactReceipt.artifactReference"),
    outerArtifactDigest: exactDigest(input.outerArtifactDigest, "artifactReceipt.outerArtifactDigest"),
    createdAt,
    expiresAt,
  };
}

export function buildReferenceArtifactReceipt(input = {}) {
  const core = normalizeArtifactReceiptInput(input);
  return deepFreeze({ ...core, receiptDigest: sha256Canonical(core) });
}

function inspectReferenceArtifactReceipt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, status: REFERENCE_EVIDENCE_STATUS.MISSING_EVIDENCE, reason: "reference_artifact_receipt_missing" };
  }
  if (value.schemaVersion !== RESEARCH_REFERENCE_ARTIFACT_RECEIPT_SCHEMA_VERSION) {
    return { valid: false, status: REFERENCE_EVIDENCE_STATUS.MISSING_EVIDENCE, reason: "reference_artifact_receipt_schema_missing" };
  }
  try {
    const rebuilt = buildReferenceArtifactReceipt(value);
    if (typeof value.receiptDigest !== "string" || !SHA256.test(value.receiptDigest)) {
      return { valid: false, status: REFERENCE_EVIDENCE_STATUS.MISSING_EVIDENCE, reason: "reference_artifact_receipt_digest_missing" };
    }
    if (rebuilt.receiptDigest !== value.receiptDigest) {
      return { valid: false, status: REFERENCE_EVIDENCE_STATUS.IDENTITY_MISMATCH, reason: "reference_artifact_receipt_digest_mismatch" };
    }
    return { valid: true, status: "VALID", reason: null, receipt: rebuilt };
  } catch {
    return { valid: false, status: REFERENCE_EVIDENCE_STATUS.MISSING_EVIDENCE, reason: "reference_artifact_receipt_malformed" };
  }
}

export function validateReferenceArtifactReceipt(value, { now = null } = {}) {
  const result = inspectReferenceArtifactReceipt(value);
  if (!result.valid) return deepFreeze({ valid: false, status: result.status, reason: result.reason, receiptDigest: null });
  if (now != null) {
    const checkedAt = isoTimestamp(now, "now");
    if (Date.parse(result.receipt.expiresAt) <= Date.parse(checkedAt)) {
      return deepFreeze({ valid: false, status: REFERENCE_EVIDENCE_STATUS.REFERENCE_EXPIRED, reason: "reference_artifact_expired", receiptDigest: result.receipt.receiptDigest });
    }
  }
  return deepFreeze({ valid: true, status: "VALID", reason: null, receiptDigest: result.receipt.receiptDigest });
}

function referenceEvidenceCore(input, receipt) {
  return {
    schemaVersion: RESEARCH_REFERENCE_EVIDENCE_SCHEMA_VERSION,
    datasetId: nonEmptyString(input.datasetId, "datasetId"),
    datasetDigest: exactDigest(input.datasetDigest, "datasetDigest"),
    strategyIdentityDigest: exactDigest(input.strategyIdentityDigest, "strategyIdentityDigest"),
    researchCodeSha: exactSha(input.researchCodeSha, "researchCodeSha"),
    trainingCodeSha: exactSha(input.trainingCodeSha, "trainingCodeSha"),
    modelSha: exactDigest(input.modelSha, "modelSha"),
    preprocessingVersion: nonEmptyString(input.preprocessingVersion, "preprocessingVersion"),
    featureOrderDigest: exactDigest(input.featureOrderDigest, "featureOrderDigest"),
    trainSplitDigest: exactDigest(input.trainSplitDigest, "trainSplitDigest"),
    validationSplitDigest: exactDigest(input.validationSplitDigest, "validationSplitDigest"),
    rawArtifactDigest: exactDigest(input.rawArtifactDigest, "rawArtifactDigest"),
    measuredAt: isoTimestamp(input.measuredAt, "measuredAt"),
    artifactReceiptDigest: receipt.receiptDigest,
  };
}

export function buildReferenceEvidenceProvenance(input = {}) {
  const receiptAssessment = inspectReferenceArtifactReceipt(input.artifactReceipt);
  if (!receiptAssessment.valid) throw new TypeError(`artifactReceipt is invalid: ${receiptAssessment.reason}`);
  const core = referenceEvidenceCore(input, receiptAssessment.receipt);
  return deepFreeze({
    ...core,
    artifactReceipt: receiptAssessment.receipt,
    provenanceDigest: sha256Canonical(core),
  });
}

function inspectReferenceEvidenceProvenance(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, status: REFERENCE_EVIDENCE_STATUS.MISSING_EVIDENCE, reason: "reference_evidence_missing" };
  }
  if (value.schemaVersion !== RESEARCH_REFERENCE_EVIDENCE_SCHEMA_VERSION) {
    return { valid: false, status: REFERENCE_EVIDENCE_STATUS.MISSING_EVIDENCE, reason: "reference_evidence_schema_missing" };
  }
  try {
    const rebuilt = buildReferenceEvidenceProvenance(value);
    if (typeof value.provenanceDigest !== "string" || !SHA256.test(value.provenanceDigest)) {
      return { valid: false, status: REFERENCE_EVIDENCE_STATUS.MISSING_EVIDENCE, reason: "reference_evidence_digest_missing" };
    }
    if (rebuilt.provenanceDigest !== value.provenanceDigest) {
      return { valid: false, status: REFERENCE_EVIDENCE_STATUS.IDENTITY_MISMATCH, reason: "reference_evidence_digest_mismatch" };
    }
    return { valid: true, status: "VALID", reason: null, provenance: rebuilt };
  } catch {
    return { valid: false, status: REFERENCE_EVIDENCE_STATUS.MISSING_EVIDENCE, reason: "reference_evidence_malformed" };
  }
}

export function validateReferenceEvidenceProvenance(value, { now = null } = {}) {
  const result = inspectReferenceEvidenceProvenance(value);
  if (!result.valid) return deepFreeze({ valid: false, status: result.status, reason: result.reason, provenanceDigest: null });
  const receipt = validateReferenceArtifactReceipt(result.provenance.artifactReceipt, { now });
  if (!receipt.valid) {
    return deepFreeze({ valid: false, status: receipt.status, reason: receipt.reason, provenanceDigest: result.provenance.provenanceDigest });
  }
  return deepFreeze({ valid: true, status: "VALID", reason: null, provenanceDigest: result.provenance.provenanceDigest });
}

export function compareReferenceEvidenceProvenance(expected, actual, { now = null } = {}) {
  const expectedAssessment = validateReferenceEvidenceProvenance(expected, { now });
  if (!expectedAssessment.valid) return deepFreeze({ match: false, status: expectedAssessment.status, reason: `expected:${expectedAssessment.reason}` });
  const actualAssessment = validateReferenceEvidenceProvenance(actual, { now });
  if (!actualAssessment.valid) return deepFreeze({ match: false, status: actualAssessment.status, reason: actualAssessment.reason });
  if (expectedAssessment.provenanceDigest !== actualAssessment.provenanceDigest) {
    return deepFreeze({ match: false, status: REFERENCE_EVIDENCE_STATUS.IDENTITY_MISMATCH, reason: "reference_evidence_identity_mismatch" });
  }
  return deepFreeze({ match: true, status: REFERENCE_EVIDENCE_STATUS.EXACT_IDENTITY_MATCH, reason: null });
}
