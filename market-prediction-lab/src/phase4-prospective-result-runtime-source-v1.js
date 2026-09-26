import { runPhase4CanonicalFrozenChallengerV1 } from "./phase4-canonical-finalist-selection-policy-v1.js";

export const PHASE4_PROSPECTIVE_RESULT_RUNTIME_SOURCE_SCHEMA_VERSION = 1;
export const PHASE4_PROSPECTIVE_RESULT_RUNTIME_SOURCE_VERSION = "phase4-prospective-result-runtime-source-v1";

const REQUIRED_POLICY_DIGEST_FIELDS = Object.freeze([
  "searchPolicyDigest",
  "hardFilterPolicyDigest",
  "rankingPolicyDigest",
  "statisticalPolicyDigest",
  "costPolicyDigest",
]);

function isPlainObject(value) {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function digest64(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function truthLocks() {
  return Object.freeze({
    runtimeActivationAllowed: false,
    dispatchAllowed: false,
    economicCreditCreated: false,
    sampleCredit: 0,
    executionRealismCredit: 0,
    profitabilityCredit: 0,
    FULL_COST_READY: false,
    NET_ALPHA_PROVEN: false,
    PROFITABILITY_PROVEN: false,
    CHAMPION: "NONE",
    executionAuthority: "NONE",
    LIVE_TRADING: false,
    AUTO_TRADING: false,
    REAL_ORDER_ENABLED: false,
    PRIVATE_TRADING_API_ALLOWED: false,
    actualForwardHandoffs: 0,
    actualShadowHandoffs: 0,
    actualPaperHandoffs: 0,
    realOrderCount: 0,
  });
}

function blocked(reason, { detail = null, sourceCount = 0, upstreamReason = null } = {}) {
  return Object.freeze({
    schemaVersion: PHASE4_PROSPECTIVE_RESULT_RUNTIME_SOURCE_SCHEMA_VERSION,
    sourceVersion: PHASE4_PROSPECTIVE_RESULT_RUNTIME_SOURCE_VERSION,
    status: "BLOCKED",
    FIRST_ZERO: reason,
    reason,
    detail,
    upstreamReason,
    sourceCount,
    phase4Result: null,
    ...truthLocks(),
  });
}

function validatePhase3SourceEnvelope(source) {
  if (!isPlainObject(source)) {
    return blocked("PHASE4_PROSPECTIVE_RESULT_RUNTIME_SOURCE_INVALID", { detail: "SOURCE_NOT_OBJECT", sourceCount: 1 });
  }
  if (source.candidateId !== undefined || source.selectionPolicy !== undefined || source.phase4Result !== undefined) {
    return blocked("PHASE4_PROSPECTIVE_RESULT_RUNTIME_SOURCE_OVERRIDE_REJECTED", {
      detail: "MANUAL_CANDIDATE_POLICY_OR_PHASE4_RESULT_OVERRIDE_REJECTED",
      sourceCount: 1,
    });
  }

  const tournamentResult = source.tournamentResult;
  const tournamentInput = source.tournamentInput;
  if (!isPlainObject(tournamentResult) || !isPlainObject(tournamentInput)) {
    return blocked("PHASE4_PROSPECTIVE_RESULT_RUNTIME_SOURCE_INVALID", {
      detail: "PHASE3_TOURNAMENT_RESULT_OR_INPUT_MISSING",
      sourceCount: 1,
    });
  }
  if (tournamentResult.status !== "COMPLETE" || !Array.isArray(tournamentResult.finalists)) {
    return blocked("PHASE4_PROSPECTIVE_RESULT_RUNTIME_SOURCE_INVALID", {
      detail: "PHASE3_TOURNAMENT_NOT_COMPLETE",
      sourceCount: 1,
    });
  }
  if (tournamentResult.PROFITABILITY_PROVEN !== false
    || tournamentResult.NET_ALPHA_PROVEN !== false
    || tournamentResult.CHAMPION !== "NONE"
    || tournamentResult.executionRealismEvidence?.credited !== false) {
    return blocked("PHASE4_PROSPECTIVE_RESULT_RUNTIME_SOURCE_INVALID", {
      detail: "PHASE3_ECONOMIC_TRUTH_LOCK_VIOLATION",
      sourceCount: 1,
    });
  }

  const handoff = tournamentResult.phase4Handoff;
  if (!isPlainObject(handoff)
    || handoff.status !== "AWAITING_PHASE4_CANDIDATE_FREEZE"
    || handoff.candidateFreezePerformed !== false
    || !Array.isArray(handoff.finalistIds)) {
    return blocked("PHASE4_PROSPECTIVE_RESULT_RUNTIME_SOURCE_INVALID", {
      detail: "PHASE3_PHASE4_HANDOFF_NOT_AUTHORITATIVE",
      sourceCount: 1,
    });
  }

  const finalistIds = tournamentResult.finalists.map((finalist) => finalist?.candidateId ?? null);
  if (handoff.finalistIds.length !== finalistIds.length
    || handoff.finalistIds.some((candidateId, index) => candidateId !== finalistIds[index])) {
    return blocked("PHASE4_PROSPECTIVE_RESULT_RUNTIME_SOURCE_IDENTITY_MISMATCH", {
      detail: "PHASE3_FINALIST_HANDOFF_IDENTITY_MISMATCH",
      sourceCount: 1,
    });
  }

  const rankOne = tournamentResult.finalists.filter((finalist) => finalist?.rank === 1);
  if (rankOne.length === 1) {
    const finalist = rankOne[0];
    if (typeof finalist.datasetIdentity !== "string" || !finalist.datasetIdentity.trim()
      || typeof finalist.datasetDigest !== "string" || !finalist.datasetDigest.trim()) {
      return blocked("PHASE4_PROSPECTIVE_RESULT_RUNTIME_SOURCE_IDENTITY_MISMATCH", {
        detail: "PHASE3_DATASET_IDENTITY_MISSING",
        sourceCount: 1,
      });
    }
    if (REQUIRED_POLICY_DIGEST_FIELDS.some((field) => !digest64(finalist[field]))) {
      return blocked("PHASE4_PROSPECTIVE_RESULT_RUNTIME_SOURCE_POLICY_MISMATCH", {
        detail: "PHASE3_POLICY_DIGEST_MISSING_OR_INVALID",
        sourceCount: 1,
      });
    }
    if (!isPlainObject(finalist.statisticalFirewall)
      || finalist.statisticalFirewall.status !== "PASS"
      || finalist.statisticalFirewall.policyDigest !== finalist.statisticalPolicyDigest) {
      return blocked("PHASE4_PROSPECTIVE_RESULT_RUNTIME_SOURCE_POLICY_MISMATCH", {
        detail: "PHASE3_STATISTICAL_POLICY_DIGEST_MISMATCH",
        sourceCount: 1,
      });
    }
  }

  return null;
}

export function runPhase4ProspectiveResultRuntimeSourceV1(input = {}) {
  const sources = input.authoritativePhase3Sources;
  if (!Array.isArray(sources) || sources.length === 0) {
    return blocked("PHASE4_PROSPECTIVE_RESULT_RUNTIME_SOURCE_MISSING");
  }
  if (sources.length !== 1) {
    return blocked("PHASE4_PROSPECTIVE_RESULT_RUNTIME_SOURCE_AMBIGUOUS", {
      detail: "EXACTLY_ONE_AUTHORITATIVE_PHASE3_SOURCE_REQUIRED",
      sourceCount: sources.length,
    });
  }
  if (input.candidateId !== undefined || input.selectionPolicy !== undefined || input.phase4Result !== undefined) {
    return blocked("PHASE4_PROSPECTIVE_RESULT_RUNTIME_SOURCE_OVERRIDE_REJECTED", {
      detail: "RUNTIME_OVERRIDE_REJECTED",
      sourceCount: 1,
    });
  }

  const source = sources[0];
  const sourceValidation = validatePhase3SourceEnvelope(source);
  if (sourceValidation) return sourceValidation;

  const phase4Result = runPhase4CanonicalFrozenChallengerV1({
    tournamentResult: source.tournamentResult,
    tournamentInput: source.tournamentInput,
    freezeTimestamp: input.freezeTimestamp,
  });
  if (phase4Result.status !== "PROSPECTIVE_ADMISSION_READY") {
    return blocked(phase4Result.reason ?? "PHASE4_PROSPECTIVE_RESULT_RUNTIME_SOURCE_INVALID", {
      detail: phase4Result.detail ?? "PHASE4_CANONICAL_FREEZE_BLOCKED",
      sourceCount: 1,
      upstreamReason: phase4Result.reason ?? null,
    });
  }

  return Object.freeze({
    schemaVersion: PHASE4_PROSPECTIVE_RESULT_RUNTIME_SOURCE_SCHEMA_VERSION,
    sourceVersion: PHASE4_PROSPECTIVE_RESULT_RUNTIME_SOURCE_VERSION,
    status: "PHASE4_PROSPECTIVE_RESULT_RUNTIME_SOURCE_READY",
    FIRST_ZERO: null,
    reason: null,
    detail: null,
    sourceCount: 1,
    tournamentRunId: phase4Result.challenger.tournamentRunId,
    candidateId: phase4Result.challenger.candidateId,
    parameterDigest: phase4Result.challenger.parameterDigest,
    datasetIdentity: phase4Result.admission.datasetIdentity,
    datasetDigest: phase4Result.admission.datasetDigest,
    prospectiveBoundary: phase4Result.challenger.prospectiveBoundary,
    prospectiveBoundaryMs: phase4Result.challenger.prospectiveBoundaryMs,
    phase4Result,
    ...truthLocks(),
  });
}
