import { runPhase3StrategyTournamentCoreV1 } from "./phase3-strategy-tournament-core-v1.js";

export const PHASE3_AUTHORITATIVE_PRODUCTION_SOURCE_SCHEMA_VERSION = 1;
export const PHASE3_AUTHORITATIVE_PRODUCTION_SOURCE_VERSION = "phase3-authoritative-production-source-v1";

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

function canonicalSnapshot(value, path = "value") {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must be finite`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item, index) => canonicalSnapshot(item, `${path}[${index}]`)));
  }
  if (isPlainObject(value)) {
    return Object.freeze(Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalSnapshot(value[key], `${path}.${key}`)]),
    ));
  }
  throw new TypeError(`${path} must contain JSON-compatible values only`);
}

function text(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function digest64(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function phase3CandidateId(value) {
  return typeof value === "string" && /^phase3-candidate:sha256:[0-9a-f]{64}$/u.test(value);
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

function blocked(reason, { detail = null, upstreamReason = null } = {}) {
  return Object.freeze({
    schemaVersion: PHASE3_AUTHORITATIVE_PRODUCTION_SOURCE_SCHEMA_VERSION,
    sourceVersion: PHASE3_AUTHORITATIVE_PRODUCTION_SOURCE_VERSION,
    status: "BLOCKED",
    FIRST_ZERO: reason,
    reason,
    detail,
    upstreamReason,
    sourceCount: 0,
    tournamentRunId: null,
    finalistCount: 0,
    authoritativePhase3Sources: Object.freeze([]),
    ...truthLocks(),
  });
}

function validateTournamentResult(result) {
  if (!isPlainObject(result) || result.status !== "COMPLETE") {
    return "PHASE3_TOURNAMENT_NOT_COMPLETE";
  }
  if (!Array.isArray(result.finalists) || result.finalists.length === 0) {
    return "PHASE3_FINALIST_MISSING";
  }
  if (!text(result.tournamentRunId)) return "PHASE3_TOURNAMENT_LINEAGE_MISSING";
  if (result.PROFITABILITY_PROVEN !== false
    || result.NET_ALPHA_PROVEN !== false
    || result.CHAMPION !== "NONE"
    || result.executionRealismEvidence?.credited !== false) {
    return "PHASE3_ECONOMIC_TRUTH_LOCK_VIOLATION";
  }
  const safety = result.safety;
  if (!isPlainObject(safety)
    || safety.LIVE_TRADING !== false
    || safety.AUTO_TRADING !== false
    || safety.REAL_ORDER_ENABLED !== false
    || safety.PRIVATE_TRADING_API_ALLOWED !== false
    || safety.executionAuthority !== "NONE"
    || safety.economicCreditCreated !== false) {
    return "PHASE3_SAFETY_LOCK_VIOLATION";
  }

  const handoff = result.phase4Handoff;
  if (!isPlainObject(handoff)
    || handoff.status !== "AWAITING_PHASE4_CANDIDATE_FREEZE"
    || handoff.candidateFreezePerformed !== false
    || !Array.isArray(handoff.finalistIds)) {
    return "PHASE3_PHASE4_HANDOFF_INVALID";
  }
  const finalistIds = result.finalists.map((finalist) => finalist?.candidateId ?? null);
  if (handoff.finalistIds.length !== finalistIds.length
    || handoff.finalistIds.some((candidateId, index) => candidateId !== finalistIds[index])) {
    return "PHASE3_FINALIST_HANDOFF_IDENTITY_MISMATCH";
  }

  const rankOne = result.finalists.filter((finalist) => finalist?.rank === 1);
  if (rankOne.length !== 1) return "PHASE3_CANONICAL_RANK1_INVALID";
  const finalist = rankOne[0];
  if (!phase3CandidateId(finalist.candidateId)
    || finalist.tournamentRunId !== result.tournamentRunId
    || !text(finalist.datasetIdentity)
    || !text(finalist.datasetDigest)
    || REQUIRED_POLICY_DIGEST_FIELDS.some((field) => !digest64(finalist[field]))) {
    return "PHASE3_FINALIST_IDENTITY_INVALID";
  }
  if (!isPlainObject(finalist.statisticalFirewall)
    || finalist.statisticalFirewall.status !== "PASS"
    || finalist.statisticalFirewall.policyDigest !== finalist.statisticalPolicyDigest) {
    return "PHASE3_STATISTICAL_POLICY_IDENTITY_INVALID";
  }
  return null;
}

export async function runPhase3AuthoritativeProductionSourceV1(input = {}, dependencies = {}) {
  if (!isPlainObject(input)) {
    return blocked("PHASE3_AUTHORITATIVE_PRODUCTION_INPUT_INVALID", { detail: "INPUT_NOT_OBJECT" });
  }
  if (input.tournamentResult !== undefined
    || input.phase3Result !== undefined
    || input.authoritativePhase3Sources !== undefined
    || input.candidateId !== undefined
    || input.finalists !== undefined) {
    return blocked("PHASE3_AUTHORITATIVE_PRODUCTION_SOURCE_OVERRIDE_REJECTED", {
      detail: "CALLER_SUPPLIED_RESULT_OR_IDENTITY_OVERRIDE_REJECTED",
    });
  }
  if (!isPlainObject(input.tournamentInput)) {
    return blocked("PHASE3_AUTHORITATIVE_PRODUCTION_INPUT_MISSING", { detail: "TOURNAMENT_INPUT_REQUIRED" });
  }

  let tournamentInput;
  try {
    tournamentInput = canonicalSnapshot(input.tournamentInput, "tournamentInput");
  } catch (error) {
    return blocked("PHASE3_AUTHORITATIVE_PRODUCTION_INPUT_INVALID", {
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  let tournamentResult;
  try {
    tournamentResult = await runPhase3StrategyTournamentCoreV1(tournamentInput, dependencies);
  } catch (error) {
    return blocked("PHASE3_AUTHORITATIVE_PRODUCTION_CORE_ERROR", {
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  if (!isPlainObject(tournamentResult) || tournamentResult.status !== "COMPLETE") {
    return blocked("PHASE3_AUTHORITATIVE_PRODUCTION_CORE_BLOCKED", {
      detail: "CANONICAL_PHASE3_TOURNAMENT_DID_NOT_COMPLETE",
      upstreamReason: tournamentResult?.FIRST_ZERO ?? tournamentResult?.reason ?? null,
    });
  }

  const resultValidation = validateTournamentResult(tournamentResult);
  if (resultValidation) {
    return blocked("PHASE3_AUTHORITATIVE_PRODUCTION_RESULT_INVALID", { detail: resultValidation });
  }

  const source = Object.freeze({
    schemaVersion: PHASE3_AUTHORITATIVE_PRODUCTION_SOURCE_SCHEMA_VERSION,
    sourceVersion: PHASE3_AUTHORITATIVE_PRODUCTION_SOURCE_VERSION,
    sourceAuthority: "runPhase3StrategyTournamentCoreV1",
    synthetic: false,
    replay: false,
    backfill: false,
    tournamentInput,
    tournamentResult,
  });

  return Object.freeze({
    schemaVersion: PHASE3_AUTHORITATIVE_PRODUCTION_SOURCE_SCHEMA_VERSION,
    sourceVersion: PHASE3_AUTHORITATIVE_PRODUCTION_SOURCE_VERSION,
    status: "PHASE3_AUTHORITATIVE_PRODUCTION_SOURCE_READY",
    FIRST_ZERO: null,
    reason: null,
    detail: null,
    upstreamReason: null,
    sourceCount: 1,
    tournamentRunId: tournamentResult.tournamentRunId,
    finalistCount: tournamentResult.finalists.length,
    authoritativePhase3Sources: Object.freeze([source]),
    ...truthLocks(),
  });
}
