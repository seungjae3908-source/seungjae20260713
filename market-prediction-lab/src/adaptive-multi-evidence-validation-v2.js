import { sha256Canonical } from "./research-cache-provenance.js";
import { RESEARCH_TOURNAMENT_STAGES } from "./research-tournament-engine-v1.js";
import { ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID } from "./adaptive-multi-evidence-point-in-time-v2.js";
import { ADAPTIVE_MULTI_EVIDENCE_FORMULA_TOURNAMENT_V2_VERSION } from "./adaptive-multi-evidence-formula-tournament-v2.js";

export const ADAPTIVE_MULTI_EVIDENCE_VALIDATION_V2_VERSION =
  "adaptive-multi-evidence-validation-v2";

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function safety() {
  return {
    finalHoldoutReuseAllowed: false,
    failureFeedbackToSearchAllowed: false,
    statisticalProofClaimAllowed: false,
    profitabilityClaimAllowed: false,
    promotionAllowed: false,
    frozenV1Contamination: 0,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: "NONE",
  };
}

function failure(blockers) {
  return deepFreeze({
    schemaVersion: ADAPTIVE_MULTI_EVIDENCE_VALIDATION_V2_VERSION,
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    status: "BLOCKED_DATA",
    finalists: [],
    rejected: [],
    blockers: unique(blockers),
    economicSampleCredit: 0,
    profitabilityProven: false,
    decisionAuthority: "NONE",
    ...safety(),
  });
}

function stageMap(candidate) {
  return new Map((candidate?.stageRecords ?? []).map((record) => [record.stage, record]));
}

function validateStageOrder(candidate) {
  const actual = candidate?.stageRecords?.map((record) => record.stage) ?? [];
  return actual.length === RESEARCH_TOURNAMENT_STAGES.length
    && actual.every((stage, index) => stage === RESEARCH_TOURNAMENT_STAGES[index])
    && candidate.stageRecords.every((record) => record.status === "PASS");
}

function validateStatisticalFirewall(record, familySize) {
  const firewall = record?.evidence?.firewall;
  const neighborhood = record?.evidence?.neighborhood;
  const analysis = record?.evidence?.analysis;
  const requiredAlpha = 0.05 / Math.max(1, familySize);
  return firewall?.canonicalOwner === "#547"
    && Number.isSafeInteger(firewall.candidateFamilySize)
    && firewall.candidateFamilySize >= familySize
    && firewall.multipleTesting?.passed === true
    && Number.isFinite(firewall.multipleTesting?.adjustedAlpha)
    && firewall.multipleTesting.adjustedAlpha <= requiredAlpha
    && firewall.dsr?.passed === true
    && Number.isFinite(firewall.dsr?.value)
    && firewall.pbo?.passed === true
    && Number.isFinite(firewall.pbo?.value)
    && firewall.minimumN?.passed === true
    && firewall.parameterStability?.passed === true
    && firewall.walkForwardStability?.passed === true
    && firewall.regimeStability?.passed === true
    && neighborhood?.passed === true
    && neighborhood?.needleOptimum === false
    && analysis?.status === "PASS";
}

function finalist(candidate, formulaTournament) {
  const reasons = [];
  if (candidate?.researchSurvivor !== true || candidate?.failure !== null) {
    reasons.push(candidate?.failure?.code ?? "NOT_RESEARCH_SURVIVOR");
    return { rejected: { candidateId: candidate?.generatedCandidateId ?? null, reasons } };
  }
  if (!validateStageOrder(candidate)) reasons.push("VALIDATION_STAGE_ORDER_OR_PASS_INVALID");
  const stages = stageMap(candidate);
  const oos = stages.get("OOS")?.evidence;
  if (!oos?.trainDatasetIdentity || !oos?.oosDatasetIdentity
      || oos.trainDatasetIdentity === oos.oosDatasetIdentity) reasons.push("GENUINE_OOS_IDENTITY_INVALID");
  const purged = stages.get("PURGED_OOS")?.evidence;
  if (purged?.status !== "PASS") reasons.push("PURGED_OOS_EVIDENCE_INVALID");
  const walkForward = stages.get("WALK_FORWARD")?.evidence;
  if (!Array.isArray(walkForward?.windows) || walkForward.windows.length === 0
      || walkForward?.analysis?.status !== "PASS") reasons.push("WALK_FORWARD_EVIDENCE_INVALID");
  const costs = stages.get("COST_STRESS")?.evidence;
  if (!Array.isArray(costs?.scenarios) || costs.scenarios.length === 0
      || costs?.analysis?.status !== "PASS") reasons.push("COST_STRESS_EVIDENCE_INVALID");
  const regimes = stages.get("REGIME_STRESS")?.evidence;
  if (!regimes?.regimes || regimes?.analysis?.status !== "PASS") reasons.push("REGIME_STRESS_EVIDENCE_INVALID");
  const statistical = stages.get("STATISTICAL_FIREWALL");
  if (!validateStatisticalFirewall(statistical, formulaTournament.globalCandidateFamilySize)) {
    reasons.push("STATISTICAL_FIREWALL_EVIDENCE_INVALID");
  }
  const holdout = stages.get("FINAL_HOLDOUT")?.evidence;
  if (holdout?.evaluationCount !== 1 || !holdout?.capabilityId || !holdout?.datasetIdentity
      || holdout?.selectionAllowed !== false || holdout?.parameterTuningAllowed !== false) {
    reasons.push("FINAL_HOLDOUT_ONE_SHOT_CONTRACT_INVALID");
  }
  const survivor = stages.get("RESEARCH_SURVIVOR")?.evidence;
  if (survivor?.survivor !== true || survivor?.profitable !== false
      || survivor?.provisionalChampion !== false || survivor?.validatedChampion !== false
      || survivor?.tradingAuthority !== false) reasons.push("RESEARCH_SURVIVOR_SAFETY_INVALID");
  if (reasons.length > 0) return { rejected: { candidateId: candidate.generatedCandidateId, reasons } };

  const validationEvidenceIds = candidate.stageRecords.map((record) => record.evidenceId);
  return {
    finalist: {
      candidateId: candidate.generatedCandidateId,
      formulaCandidateId: candidate.formulaCandidateId,
      strategyHash: candidate.strategyHash,
      parameterIdentity: candidate.parameterIdentity,
      validationEvidenceIds,
      validationDigest: sha256Canonical({
        candidateId: candidate.generatedCandidateId,
        strategyHash: candidate.strategyHash,
        parameterIdentity: candidate.parameterIdentity,
        validationEvidenceIds,
      }),
      completedStages: [...RESEARCH_TOURNAMENT_STAGES],
      statisticalFirewallOwner: "#547",
      finalHoldoutEvaluationCount: 1,
      status: "VALIDATED_FINALIST_NOT_FROZEN",
      profitabilityProven: false,
      promotionEligible: false,
      executionAuthority: "NONE",
    },
  };
}

export function buildAdaptiveMultiEvidenceValidationV2({
  formulaTournament,
  tournamentResult,
  executionAuthority = "NONE",
} = {}) {
  const blockers = [];
  if (formulaTournament?.schemaVersion !== ADAPTIVE_MULTI_EVIDENCE_FORMULA_TOURNAMENT_V2_VERSION
      || formulaTournament?.lineageId !== ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID
      || formulaTournament?.status !== "READY_FOR_VALIDATION_PIPELINE"
      || formulaTournament?.executionAuthority !== "NONE") blockers.push("V2_FORMULA_TOURNAMENT_INPUT_INVALID");
  if (tournamentResult?.tournament?.tournamentId !== formulaTournament?.tournamentId
      || !Array.isArray(tournamentResult?.tournament?.candidates)
      || tournamentResult?.tournament?.profitable !== false
      || tournamentResult?.tournament?.champion != null
      || tournamentResult?.safety?.executionAuthority !== "NONE") {
    blockers.push("RESEARCH_TOURNAMENT_OWNER_RESULT_INVALID");
  }
  if (executionAuthority !== "NONE") blockers.push("V2_VALIDATION_EXECUTION_AUTHORITY_FORBIDDEN");
  if (blockers.length > 0) return failure(blockers);

  const finalists = [];
  const rejected = [];
  for (const candidate of tournamentResult.tournament.candidates) {
    const result = finalist(candidate, formulaTournament);
    if (result.finalist) finalists.push(result.finalist);
    else rejected.push(result.rejected);
  }
  const candidateIds = finalists.map((item) => item.candidateId);
  if (candidateIds.length !== new Set(candidateIds).size) return failure(["DUPLICATE_VALIDATED_FINALIST_ID"]);
  const declaredSurvivorIds = new Set(tournamentResult.tournament.candidates
    .filter((candidate) => candidate?.researchSurvivor === true)
    .map((candidate) => candidate.generatedCandidateId));
  const invalidSurvivor = rejected.some((item) => declaredSurvivorIds.has(item.candidateId));
  if (invalidSurvivor) return failure(["OWNER_RESEARCH_SURVIVOR_VALIDATION_CONTRACT_INVALID"]);

  return deepFreeze({
    schemaVersion: ADAPTIVE_MULTI_EVIDENCE_VALIDATION_V2_VERSION,
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    status: finalists.length > 0 ? "VALIDATED_FINALISTS_AVAILABLE" : "NO_VALIDATED_FINALIST_EVIDENCE",
    tournamentId: formulaTournament.tournamentId,
    totalTrialCount: formulaTournament.totalTrialCount,
    globalCandidateFamilySize: formulaTournament.globalCandidateFamilySize,
    finalists,
    rejected,
    finalistCount: finalists.length,
    requiredProgression: [...RESEARCH_TOURNAMENT_STAGES],
    multipleTestingRiskResolvedByOwner: finalists.length > 0,
    statisticalProofClaimAllowed: false,
    finalHoldoutReusable: false,
    economicSampleCredit: 0,
    profitabilityProven: false,
    promotionEligible: false,
    blockers: [],
    decisionAuthority: "VALIDATED_RESEARCH_ONLY",
    ...safety(),
  });
}
