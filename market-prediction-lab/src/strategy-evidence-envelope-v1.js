import { sha256Canonical } from "./research-cache-provenance.js";
import { resolveCanonicalStrategyIdentity } from "./canonical-strategy-identity-v1.js";

export const STRATEGY_EVIDENCE_ENVELOPE_SCHEMA_VERSION = "strategy-evidence-envelope-v1";
export const STRATEGY_EVIDENCE_STAGES = Object.freeze([
  "RESEARCH",
  "HISTORICAL_BACKTEST",
  "OOS",
  "PURGED_OOS",
  "WALK_FORWARD",
  "COST_STRESS",
  "REGIME_STRESS",
  "STATISTICAL_FIREWALL",
  "FINAL_HOLDOUT",
  "SHADOW",
  "NATURAL_PAPER",
  "SETTLEMENT",
  "STRATEGY_HEALTH",
]);

const SHA_40 = /^[0-9a-f]{40}$/iu;
const HASH_64 = /^[0-9a-f]{64}$/iu;
const METRIC_FIELDS = Object.freeze([
  "netReturn", "cagr", "winRate", "profitFactor", "expectancy", "mdd", "sharpe", "sortino",
  "mae", "mfe", "turnover", "tailLoss", "costAdjustedReturn", "positiveWindowRatio", "dsr", "pbo",
]);
const PROFITABILITY_METRICS = new Set([
  "netReturn", "cagr", "winRate", "profitFactor", "expectancy", "mdd", "sharpe", "sortino",
  "mae", "mfe", "turnover", "tailLoss", "costAdjustedReturn",
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

function nonEmpty(value) { return typeof value === "string" && value.trim().length > 0; }
function iso(value) {
  if (!nonEmpty(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
function count(value, label, blockers) {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < 0) { blockers.push(`${label}_INVALID`); return null; }
  return value;
}
function normalizedStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(nonEmpty).map((value) => value.trim()))].sort();
}

function forbiddenAttestations(value, path = "verdict", seen = new WeakSet()) {
  if (!value || typeof value !== "object") return [];
  if (seen.has(value)) return [`CYCLIC_EVIDENCE_FORBIDDEN:${path}`];
  seen.add(value);
  const blockers = [];
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (SELF_ATTESTATION_FIELDS.includes(key)) blockers.push(`SELF_ATTESTATION_FORBIDDEN:${childPath}`);
    if (key === "executionAuthority" && child !== "NONE") blockers.push(`EXECUTION_AUTHORITY_FORBIDDEN:${childPath}`);
    blockers.push(...forbiddenAttestations(child, childPath, seen));
  }
  return blockers;
}

function failure(status, blockers, missingEvidence = []) {
  return deepFreeze({
    schemaVersion: STRATEGY_EVIDENCE_ENVELOPE_SCHEMA_VERSION,
    status,
    envelope: null,
    evidenceDigest: null,
    blockers: [...new Set(blockers)].sort(),
    missingEvidence: normalizedStrings(missingEvidence),
    executionAuthority: "NONE",
  });
}

export function buildStrategyEvidenceEnvelope(input = {}) {
  const blockers = [];
  const missingEvidence = normalizedStrings(input.missingEvidence);
  for (const field of SELF_ATTESTATION_FIELDS) {
    if (Object.hasOwn(input, field)) blockers.push(`SELF_ATTESTATION_FORBIDDEN:${field}`);
  }
  blockers.push(...forbiddenAttestations(input.verdict));
  blockers.push(...forbiddenAttestations(input.validation, "validation"));
  if (input.executionAuthority != null && input.executionAuthority !== "NONE") blockers.push("EXECUTION_AUTHORITY_FORBIDDEN");

  const resolvedIdentity = resolveCanonicalStrategyIdentity(input.strategyIdentity);
  if (resolvedIdentity.status !== "IDENTITY_COMPLETE") {
    return failure("UNLINKED_EVIDENCE", ["IDENTITY_INCOMPLETE", ...resolvedIdentity.blockers], resolvedIdentity.missingFields);
  }
  if (!HASH_64.test(input.strategyIdentityDigest ?? "")) blockers.push("STRATEGY_IDENTITY_DIGEST_REQUIRED");
  else if (input.strategyIdentityDigest.toLowerCase() !== resolvedIdentity.strategyIdentityDigest) blockers.push("STRATEGY_IDENTITY_DIGEST_MISMATCH");
  if (resolvedIdentity.identity.evidenceSchemaVersion !== STRATEGY_EVIDENCE_ENVELOPE_SCHEMA_VERSION) {
    blockers.push("EVIDENCE_SCHEMA_IDENTITY_MISMATCH");
  }

  if (!STRATEGY_EVIDENCE_STAGES.includes(input.evidenceStage)) blockers.push("EVIDENCE_STAGE_UNSUPPORTED");
  if (!nonEmpty(input.evidenceType)) blockers.push("EVIDENCE_TYPE_REQUIRED");
  if (!nonEmpty(input.source)) blockers.push("EVIDENCE_SOURCE_REQUIRED");
  if (!SHA_40.test(input.sourceSha ?? "")) blockers.push("SOURCE_SHA_INVALID");
  if (!nonEmpty(input.artifactId)) blockers.push("ARTIFACT_ID_REQUIRED");
  if (!HASH_64.test(input.artifactDigest ?? "")) blockers.push("ARTIFACT_DIGEST_INVALID");
  const measuredAt = iso(input.measuredAt);
  if (!measuredAt) blockers.push("MEASURED_AT_INVALID");

  if (input.artifactPayload !== undefined && HASH_64.test(input.artifactDigest ?? "")) {
    if (sha256Canonical(input.artifactPayload) !== input.artifactDigest.toLowerCase()) blockers.push("ARTIFACT_DIGEST_MISMATCH");
  } else if (input.artifactPayload === undefined) {
    missingEvidence.push("ARTIFACT_CONTENT_UNAVAILABLE");
  }

  const identity = resolvedIdentity.identity;
  const datasetIdentity = input.datasetIdentity ?? {};
  const expectedDataset = {
    datasetId: identity.datasetId,
    datasetDigest: identity.datasetDigest,
    datasetStart: identity.datasetStart,
    datasetEnd: identity.datasetEnd,
  };
  for (const [field, expected] of Object.entries(expectedDataset)) {
    const actual = field.endsWith("Start") || field.endsWith("End") ? iso(datasetIdentity[field]) : datasetIdentity[field];
    const normalized = field === "datasetDigest" && nonEmpty(actual) ? actual.toLowerCase() : actual;
    if (normalized !== expected) blockers.push(`DATASET_IDENTITY_MISMATCH:${field}`);
  }
  if (input.costs?.costPolicyVersion != null && input.costs.costPolicyVersion !== identity.costPolicyVersion) {
    blockers.push("COST_POLICY_IDENTITY_MISMATCH");
  }

  const sample = Object.freeze({
    sampleN: count(input.sample?.sampleN, "SAMPLE_N", blockers),
    tradeN: count(input.sample?.tradeN, "TRADE_N", blockers),
    settledN: count(input.sample?.settledN, "SETTLED_N", blockers),
  });
  const zeroOutcome = sample.tradeN === 0 || sample.settledN === 0
    || (sample.sampleN === 0 && sample.tradeN == null && sample.settledN == null);
  const metrics = {};
  for (const field of METRIC_FIELDS) {
    const value = input.metrics?.[field];
    if (zeroOutcome && PROFITABILITY_METRICS.has(field)) metrics[field] = null;
    else if (value == null) metrics[field] = null;
    else if (typeof value === "number" && Number.isFinite(value)) metrics[field] = value;
    else { metrics[field] = null; blockers.push(`METRIC_INVALID:${field}`); }
  }
  if (zeroOutcome) missingEvidence.push("ZERO_OUTCOME_SAMPLE_PROFITABILITY_METRICS_NA");

  const identityMismatch = blockers.some((blocker) => /IDENTITY.*MISMATCH/u.test(blocker));
  if (blockers.length > 0) {
    return failure(identityMismatch ? "IDENTITY_MISMATCH" : "UNLINKED_EVIDENCE", blockers, missingEvidence);
  }

  const envelope = deepFreeze({
    schemaVersion: STRATEGY_EVIDENCE_ENVELOPE_SCHEMA_VERSION,
    strategyIdentity: identity,
    strategyIdentityDigest: resolvedIdentity.strategyIdentityDigest,
    evidenceType: input.evidenceType.trim(),
    evidenceStage: input.evidenceStage,
    source: input.source.trim(),
    sourceSha: input.sourceSha.toLowerCase(),
    artifactId: input.artifactId.trim(),
    artifactDigest: input.artifactDigest.toLowerCase(),
    measuredAt,
    datasetIdentity: expectedDataset,
    sample,
    metrics,
    costs: input.costs == null ? null : structuredClone(input.costs),
    validation: input.validation == null ? null : structuredClone(input.validation),
    limitations: normalizedStrings(input.limitations),
    missingEvidence: normalizedStrings(missingEvidence),
    researchEvidenceRefs: normalizedStrings(input.researchEvidenceRefs),
    verdict: input.verdict == null ? null : structuredClone(input.verdict),
    executionAuthority: "NONE",
    profitabilityProven: false,
    liveTradingEligible: false,
    validatedChampion: false,
  });
  return deepFreeze({
    schemaVersion: STRATEGY_EVIDENCE_ENVELOPE_SCHEMA_VERSION,
    status: "LINKED",
    envelope,
    evidenceDigest: sha256Canonical(envelope),
    blockers: [],
    missingEvidence: envelope.missingEvidence,
    executionAuthority: "NONE",
  });
}
