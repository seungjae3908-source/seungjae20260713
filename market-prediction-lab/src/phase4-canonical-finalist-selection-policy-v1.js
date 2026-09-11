import {
  PHASE4_SELECTION_POLICY_SCHEMA,
  admitPhase3FinalistV1,
  bindPhase4FinalistSelectionPolicyV1,
  runPhase4FrozenChallengerCoreV1,
} from "./phase4-frozen-challenger-core-v1.js";

export const PHASE4_CANONICAL_SELECTION_POLICY_VERSION = "phase4-canonical-rank1-only-v1";
export const PHASE4_CANONICAL_SELECTION_RULE = "PHASE3_CANONICAL_RANK_1_ONLY";

function truthLocks() {
  return Object.freeze({
    FULL_COST_READY: false,
    NET_ALPHA_PROVEN: false,
    PROFITABILITY_PROVEN: false,
    CHAMPION: "NONE",
    executionRealismCredit: 0,
    profitabilityCredit: 0,
  });
}

function blocked(reason, detail = null) {
  return Object.freeze({
    status: "BLOCKED",
    FIRST_ZERO: reason,
    reason,
    detail,
    candidateId: null,
    selectionPolicy: null,
    selection: null,
    ...truthLocks(),
  });
}

function canonicalSelectionPolicy({ tournamentRunId, candidateId }) {
  return Object.freeze({
    schemaVersion: PHASE4_SELECTION_POLICY_SCHEMA,
    policyVersion: PHASE4_CANONICAL_SELECTION_POLICY_VERSION,
    selectionRule: "PRECOMMITTED_EXPLICIT_FINALIST_ID",
    canonicalSelectionRule: PHASE4_CANONICAL_SELECTION_RULE,
    selectionAuthority: "HUMAN_FROZEN_POLICY",
    tournamentRunId,
    selectedCandidateId: candidateId,
    requiredRank: 1,
    fallbackToLowerRankAllowed: false,
    skipInvalidHigherRankAllowed: false,
    validationOutcomeConsulted: false,
    oosOutcomeConsulted: false,
    paperOutcomeConsulted: false,
    settlementOutcomeConsulted: false,
    futurePnlConsulted: false,
    futureFillConsulted: false,
    championStatusConsulted: false,
    postOutcomeManualSelection: false,
    postFreezeMutationAllowed: false,
  });
}

export function resolvePhase4CanonicalFinalistV1({ tournamentResult, tournamentInput } = {}) {
  if (!tournamentResult || tournamentResult.status !== "COMPLETE" || !Array.isArray(tournamentResult.finalists)) {
    return blocked("FINALIST_MISSING");
  }
  if (typeof tournamentResult.tournamentRunId !== "string" || !tournamentResult.tournamentRunId.trim()) {
    return blocked("TOURNAMENT_LINEAGE_MISSING");
  }

  const rankOne = tournamentResult.finalists.filter((finalist) => finalist?.rank === 1);
  if (rankOne.length !== 1) {
    return blocked("FINALIST_NOT_ADMISSIBLE", rankOne.length === 0 ? "CANONICAL_RANK_1_MISSING" : "CANONICAL_RANK_1_DUPLICATED");
  }

  const selected = rankOne[0];
  const admissionResult = admitPhase3FinalistV1({
    tournamentResult,
    tournamentInput,
    candidateId: selected.candidateId,
  });
  if (admissionResult.status !== "ACCEPTED") {
    return Object.freeze({
      ...admissionResult,
      detail: "CANONICAL_RANK_1_FAILED_ADMISSION_NO_FALLBACK",
      selectionPolicy: null,
      selection: null,
    });
  }
  if (admissionResult.admission.rank !== 1) {
    return blocked("FINALIST_NOT_ADMISSIBLE", "CANONICAL_RANK_1_IDENTITY_MISMATCH");
  }

  const selectionPolicy = canonicalSelectionPolicy({
    tournamentRunId: admissionResult.admission.tournamentRunId,
    candidateId: admissionResult.admission.candidateId,
  });
  const selectionResult = bindPhase4FinalistSelectionPolicyV1({
    admission: admissionResult.admission,
    selectionPolicy,
  });
  if (selectionResult.status !== "BOUND") return selectionResult;

  return Object.freeze({
    status: "CANONICAL_FINALIST_SELECTED",
    FIRST_ZERO: null,
    reason: null,
    detail: null,
    candidateId: admissionResult.admission.candidateId,
    admission: admissionResult.admission,
    selectionPolicy,
    selection: selectionResult.selection,
    ...truthLocks(),
  });
}

export function runPhase4CanonicalFrozenChallengerV1(input = {}) {
  if (input.candidateId !== undefined || input.selectionPolicy !== undefined) {
    return blocked("FINALIST_NOT_ADMISSIBLE", "MANUAL_FINALIST_OVERRIDE_REJECTED");
  }

  const resolved = resolvePhase4CanonicalFinalistV1({
    tournamentResult: input.tournamentResult,
    tournamentInput: input.tournamentInput,
  });
  if (resolved.status !== "CANONICAL_FINALIST_SELECTED") return resolved;

  return runPhase4FrozenChallengerCoreV1({
    ...input,
    candidateId: resolved.candidateId,
    selectionPolicy: resolved.selectionPolicy,
  });
}
