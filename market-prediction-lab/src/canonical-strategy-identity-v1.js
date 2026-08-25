import { sha256Canonical } from "./research-cache-provenance.js";

export const CANONICAL_STRATEGY_IDENTITY_SCHEMA_VERSION = "canonical-strategy-identity-v1";

const HASH_64 = /^[0-9a-f]{64}$/iu;
const SHA_40 = /^[0-9a-f]{40}$/iu;
const REQUIRED_STRING_FIELDS = Object.freeze([
  "strategyId",
  "strategyFamily",
  "strategyVersion",
  "market",
  "direction",
  "timeframe",
  "parameterHash",
  "researchCodeSha",
  "datasetId",
  "datasetDigest",
  "costPolicyVersion",
  "riskPolicyVersion",
  "evidenceSchemaVersion",
]);
const SELF_ATTESTATION_FIELDS = Object.freeze([
  "validated",
  "validatedChampion",
  "champion",
  "provisionalChampion",
  "profitabilityProven",
  "liveTradingEligible",
]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function knownString(value) {
  return nonEmpty(value) && !["UNKNOWN", "MISSING", "NONE"].includes(value.trim().toUpperCase());
}

function hasFormulaIdentity(value) {
  if (knownString(value)) return true;
  return value != null && typeof value === "object" && Object.keys(value).length > 0;
}

function normalizedTime(value) {
  if (!nonEmpty(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function failure(status, missingFields, blockers) {
  return deepFreeze({
    schemaVersion: CANONICAL_STRATEGY_IDENTITY_SCHEMA_VERSION,
    status,
    identity: null,
    strategyIdentityDigest: null,
    missingFields: [...new Set(missingFields)].sort(),
    blockers: [...new Set(blockers)].sort(),
    executionAuthority: "NONE",
  });
}

export function resolveCanonicalStrategyIdentity(input = {}) {
  const missingFields = [];
  const blockers = [];
  for (const field of REQUIRED_STRING_FIELDS) {
    if (!knownString(input[field])) missingFields.push(field);
  }
  const formulaIdentityPresent = hasFormulaIdentity(input.formulaIdentity);
  if (!formulaIdentityPresent && !nonEmpty(input.formulaHash)) missingFields.push("formulaIdentity|formulaHash");
  for (const field of SELF_ATTESTATION_FIELDS) {
    if (Object.hasOwn(input, field)) blockers.push(`SELF_ATTESTATION_FORBIDDEN:${field}`);
  }

  if (nonEmpty(input.parameterHash) && !HASH_64.test(input.parameterHash)) blockers.push("PARAMETER_HASH_INVALID");
  if (nonEmpty(input.datasetDigest) && !HASH_64.test(input.datasetDigest)) blockers.push("DATASET_DIGEST_INVALID");
  if (nonEmpty(input.researchCodeSha) && !SHA_40.test(input.researchCodeSha)) blockers.push("RESEARCH_CODE_SHA_INVALID");
  if (nonEmpty(input.formulaHash) && !HASH_64.test(input.formulaHash)) blockers.push("FORMULA_HASH_INVALID");

  const datasetStart = normalizedTime(input.datasetStart);
  const datasetEnd = normalizedTime(input.datasetEnd);
  if (!datasetStart) missingFields.push("datasetStart");
  if (!datasetEnd) missingFields.push("datasetEnd");
  if (datasetStart && datasetEnd && Date.parse(datasetEnd) <= Date.parse(datasetStart)) blockers.push("DATASET_RANGE_INVALID");

  let formulaHash = nonEmpty(input.formulaHash) ? input.formulaHash.toLowerCase() : null;
  if (formulaIdentityPresent) {
    const calculated = sha256Canonical(input.formulaIdentity);
    if (formulaHash && formulaHash !== calculated) blockers.push("FORMULA_IDENTITY_HASH_MISMATCH");
    formulaHash ??= calculated;
  }

  if (missingFields.length > 0 || blockers.length > 0) {
    return failure("IDENTITY_INCOMPLETE", missingFields, blockers);
  }

  const identity = deepFreeze({
    schemaVersion: CANONICAL_STRATEGY_IDENTITY_SCHEMA_VERSION,
    strategyId: input.strategyId.trim(),
    strategyFamily: input.strategyFamily.trim(),
    strategyVersion: input.strategyVersion.trim(),
    market: input.market.trim(),
    direction: input.direction.trim(),
    timeframe: input.timeframe.trim(),
    formulaIdentity: formulaIdentityPresent ? structuredClone(input.formulaIdentity) : null,
    formulaHash,
    parameterHash: input.parameterHash.toLowerCase(),
    researchCodeSha: input.researchCodeSha.toLowerCase(),
    datasetId: input.datasetId.trim(),
    datasetDigest: input.datasetDigest.toLowerCase(),
    datasetStart,
    datasetEnd,
    costPolicyVersion: input.costPolicyVersion.trim(),
    riskPolicyVersion: input.riskPolicyVersion.trim(),
    evidenceSchemaVersion: input.evidenceSchemaVersion.trim(),
  });
  return deepFreeze({
    schemaVersion: CANONICAL_STRATEGY_IDENTITY_SCHEMA_VERSION,
    status: "READY",
    identity,
    strategyIdentityDigest: sha256Canonical(identity),
    missingFields: [],
    blockers: [],
    executionAuthority: "NONE",
  });
}

export function compareCanonicalStrategyIdentities(expectedInput, actualInput) {
  const expected = resolveCanonicalStrategyIdentity(expectedInput);
  const actual = resolveCanonicalStrategyIdentity(actualInput);
  if (expected.status !== "READY" || actual.status !== "READY") {
    return deepFreeze({
      status: "IDENTITY_INCOMPLETE",
      matched: false,
      mismatchedFields: [],
      blockers: [...expected.blockers, ...actual.blockers, ...expected.missingFields, ...actual.missingFields],
      executionAuthority: "NONE",
    });
  }
  if (expected.strategyIdentityDigest === actual.strategyIdentityDigest) {
    return deepFreeze({ status: "MATCH", matched: true, mismatchedFields: [], blockers: [], executionAuthority: "NONE" });
  }
  const mismatchedFields = Object.keys(expected.identity)
    .filter((field) => sha256Canonical(expected.identity[field]) !== sha256Canonical(actual.identity[field]))
    .sort();
  return deepFreeze({
    status: "IDENTITY_MISMATCH",
    matched: false,
    mismatchedFields,
    blockers: mismatchedFields.map((field) => `IDENTITY_MISMATCH:${field}`),
    executionAuthority: "NONE",
  });
}
