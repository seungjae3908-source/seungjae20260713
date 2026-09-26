import { evaluateGlobalStrategyStatisticalFirewall } from "./global-strategy-statistical-firewall-v1.js";

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.trim().length > 0;
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const freeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
};

function blocked(status, code, reason, extra = {}) {
  return freeze({
    status,
    code,
    reason,
    canonicalOwner: "#547",
    candidateFamilySize: Number.isSafeInteger(extra.candidateFamilySize) ? extra.candidateFamilySize : null,
    multipleTesting: extra.multipleTesting ?? null,
    dsr: extra.dsr ?? null,
    pbo: extra.pbo ?? null,
    minimumN: extra.minimumN ?? { passed: false },
    parameterStability: extra.parameterStability ?? { passed: false },
    walkForwardStability: extra.walkForwardStability ?? { passed: false },
    regimeStability: extra.regimeStability ?? { passed: false },
    confidenceScore: null,
    sourceFirewallDecision: extra.sourceFirewallDecision ?? null,
    sourceFirewallStatus: extra.sourceFirewallStatus ?? null,
    finalHoldoutAccess: false,
    executionAuthority: "NONE",
  });
}

function assertTournamentRequest(request) {
  if (!object(request)
    || request.canonicalOwner !== "#547"
    || !Number.isSafeInteger(request.candidateFamilySize)
    || request.candidateFamilySize < 1
    || !finite(request.requiredAdjustedAlpha)
    || request.requiredAdjustedAlpha <= 0
    || request.requiredAdjustedAlpha > 1
    || request.finalHoldoutAccess !== false) {
    throw new Error("TOURNAMENT_STATISTICAL_FIREWALL_REQUEST_INVALID");
  }
  for (const key of ["finalHoldout", "finalHoldoutResult", "holdoutEvidence", "holdoutMetrics", "selectionFeedback", "llmPromptContext"]) {
    if (Object.hasOwn(request, key)) throw new Error("TOURNAMENT_STATISTICAL_FIREWALL_HOLDOUT_INPUT_FORBIDDEN");
  }
}

function normalizeStability(evidence) {
  const required = ["minimumN", "parameterStability", "walkForwardStability", "regimeStability"];
  if (!object(evidence)) return null;
  const normalized = {};
  for (const key of required) {
    const row = evidence[key];
    if (!object(row) || typeof row.passed !== "boolean" || !text(row.evidenceId)) return null;
    normalized[key] = freeze({ passed: row.passed, evidenceId: row.evidenceId.trim() });
  }
  return freeze(normalized);
}

function failureCode(firewall, stability) {
  if (!stability) return "STATISTICAL_EVIDENCE_MISSING";
  if (!stability.minimumN.passed || !stability.parameterStability.passed
    || !stability.walkForwardStability.passed || !stability.regimeStability.passed) return "PARAMETER_INSTABILITY";
  const reasons = new Set(firewall?.decision?.reasons ?? []);
  if (reasons.has("DSR_BELOW_POLICY")) return "DSR_FAIL";
  if (reasons.has("PBO_EXCEEDS_POLICY")) return "PBO_FAIL";
  if (reasons.has("REALITY_CHECK_NULL_NOT_REJECTED") || reasons.has("SPA_NULL_NOT_REJECTED")) return "MULTIPLE_TESTING_FAIL";
  return "STATISTICAL_EVIDENCE_MISSING";
}

export function adaptGlobalStatisticalFirewallToTournamentV1({
  tournamentRequest,
  trials,
  selectedTrialId,
  benchmarkReturns = null,
  blockCount = 8,
  maxCombinations = 5000,
  realityCheckPolicy,
  decisionPolicy,
  stabilityEvidence,
} = {}) {
  assertTournamentRequest(tournamentRequest);

  if (!Array.isArray(trials) || trials.length !== tournamentRequest.candidateFamilySize) {
    return blocked("MISSING_EVIDENCE", "STATISTICAL_EVIDENCE_MISSING",
      "all generated selection trials must be represented exactly once", { candidateFamilySize: tournamentRequest.candidateFamilySize });
  }
  if (!object(decisionPolicy) || decisionPolicy.status !== "empirically_calibrated"
    || !finite(decisionPolicy.maxPbo) || decisionPolicy.maxPbo < 0 || decisionPolicy.maxPbo > 1
    || !finite(decisionPolicy.minDsrProbability) || decisionPolicy.minDsrProbability < 0 || decisionPolicy.minDsrProbability > 1
    || !finite(decisionPolicy.alpha) || decisionPolicy.alpha <= 0 || decisionPolicy.alpha >= 0.5) {
    return blocked("MISSING_EVIDENCE", "STATISTICAL_EVIDENCE_MISSING",
      "bounded empirically calibrated statistical decision policy is required", { candidateFamilySize: tournamentRequest.candidateFamilySize });
  }

  const stability = normalizeStability(stabilityEvidence);
  const firewall = evaluateGlobalStrategyStatisticalFirewall({
    trials,
    selectedTrialId,
    benchmarkReturns,
    blockCount,
    maxCombinations,
    realityCheckPolicy,
    decisionPolicy,
  });

  if (firewall.status !== "EVIDENCE_READY"
    || !finite(firewall.dsr?.result?.probability)
    || !finite(firewall.pbo?.result?.pbo)
    || !finite(firewall.realityCheckAndSpa?.result?.realityCheck?.pValue)
    || !finite(firewall.realityCheckAndSpa?.result?.spa?.pValue)) {
    return blocked("MISSING_EVIDENCE", "STATISTICAL_EVIDENCE_MISSING",
      "canonical #547 statistical evidence is incomplete", {
        candidateFamilySize: tournamentRequest.candidateFamilySize,
        sourceFirewallDecision: firewall.decision ?? null,
        sourceFirewallStatus: firewall.status,
      });
  }

  const dsrValue = firewall.dsr.result.probability;
  const pboValue = firewall.pbo.result.pbo;
  const dsrPassed = dsrValue >= decisionPolicy.minDsrProbability;
  const pboPassed = pboValue <= decisionPolicy.maxPbo;
  const rcPassed = firewall.realityCheckAndSpa.result.realityCheck.pValue <= decisionPolicy.alpha;
  const spaPassed = firewall.realityCheckAndSpa.result.spa.pValue <= decisionPolicy.alpha;
  const multipleTesting = freeze({
    method: "FAMILY_ALPHA_BOUND_PLUS_REALITY_CHECK_SPA",
    adjustedAlpha: tournamentRequest.requiredAdjustedAlpha,
    passed: rcPassed && spaPassed,
    realityCheckPValue: firewall.realityCheckAndSpa.result.realityCheck.pValue,
    spaPValue: firewall.realityCheckAndSpa.result.spa.pValue,
  });
  const mapped = {
    candidateFamilySize: tournamentRequest.candidateFamilySize,
    multipleTesting,
    dsr: freeze({ value: dsrValue, passed: dsrPassed }),
    pbo: freeze({ value: pboValue, passed: pboPassed }),
    minimumN: stability?.minimumN ?? { passed: false },
    parameterStability: stability?.parameterStability ?? { passed: false },
    walkForwardStability: stability?.walkForwardStability ?? { passed: false },
    regimeStability: stability?.regimeStability ?? { passed: false },
    sourceFirewallDecision: firewall.decision,
    sourceFirewallStatus: firewall.status,
  };

  if (!stability || firewall.decision.status !== "STATISTICAL_REVIEW_READY"
    || !dsrPassed || !pboPassed || !multipleTesting.passed
    || !stability.minimumN.passed || !stability.parameterStability.passed
    || !stability.walkForwardStability.passed || !stability.regimeStability.passed) {
    const code = failureCode(firewall, stability);
    return blocked(code === "STATISTICAL_EVIDENCE_MISSING" ? "MISSING_EVIDENCE" : "FAIL", code,
      "canonical #547 evidence did not clear the tournament statistical gate", mapped);
  }

  const confidenceScore = Math.max(0, Math.min(1,
    (dsrValue + (1 - pboValue) + (1 - firewall.realityCheckAndSpa.result.realityCheck.pValue)
      + (1 - firewall.realityCheckAndSpa.result.spa.pValue)) / 4));

  return freeze({
    status: "PASS",
    canonicalOwner: "#547",
    candidateFamilySize: tournamentRequest.candidateFamilySize,
    multipleTesting,
    dsr: mapped.dsr,
    pbo: mapped.pbo,
    minimumN: stability.minimumN,
    parameterStability: stability.parameterStability,
    walkForwardStability: stability.walkForwardStability,
    regimeStability: stability.regimeStability,
    confidenceScore,
    sourceFirewallDecision: firewall.decision,
    sourceFirewallStatus: firewall.status,
    sourceDataSnoopingDisclosure: firewall.dataSnoopingDisclosure,
    finalHoldoutAccess: false,
    executionAuthority: "NONE",
  });
}
