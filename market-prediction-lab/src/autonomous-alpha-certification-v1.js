import crypto from "node:crypto";

import {
  AUTONOMOUS_ALPHA_CHAMPION_CHALLENGER_V1,
} from "./autonomous-alpha-champion-challenger-v1.js";
import {
  ADAPTIVE_MULTI_EVIDENCE_NATURAL_PAPER_V2_VERSION,
} from "./adaptive-multi-evidence-natural-paper-v2.js";
import {
  UNIFIED_PROFITABILITY_PROMOTION_SCHEMA_VERSION,
} from "./unified-profitability-promotion-gate-v1.js";
import {
  PROFITABILITY_LIFECYCLE_CONTROL_SCHEMA_VERSION,
} from "./profitability-lifecycle-orchestrator.js";

export const AUTONOMOUS_ALPHA_CERTIFICATION_V1 =
  "autonomous-alpha-certification-v1";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safety() {
  return {
    paperOnlyUntilSeparateLiveApproval: true,
    automaticLivePromotionAllowed: false,
    automaticChampionSwapAllowed: false,
    automaticCapitalMutationAllowed: false,
    liveTradingAllowed: false,
    autoTradingAllowed: false,
    realOrderAllowed: false,
    privateTradingApiAllowed: false,
    executionAuthority: "NONE",
  };
}

function validActivationReceipt(receipt, candidateId) {
  if (receipt == null) return false;
  return receipt.schemaVersion === "autonomous-alpha-natural-paper-activation-receipt-v1"
    && receipt.candidateId === candidateId
    && text(receipt.humanApprovalId)
    && text(receipt.runtimeSourceSha)
    && /^[0-9a-f]{40}$/u.test(receipt.runtimeSourceSha)
    && receipt.paperOnly === true
    && receipt.scheduleActive === true
    && receipt.naturalCronObserved === true
    && receipt.replay === false
    && receipt.backfill === false
    && receipt.synthetic === false
    && receipt.actualOrders === 0
    && receipt.privateAccountRequests === 0
    && receipt.liveTrading === false
    && receipt.autoTrading === false
    && receipt.executionAuthority === "NONE";
}

export function buildAutonomousAlphaCertificationV1({
  championChallengerPlan,
  naturalPaperCandidate,
  activationReceipt = null,
  settlementProfitabilityGate = null,
  unifiedProfitabilityPromotion = null,
  lifecycleControl = null,
  executionAuthority = "NONE",
} = {}) {
  const blockers = [];
  if (championChallengerPlan?.schemaVersion !== AUTONOMOUS_ALPHA_CHAMPION_CHALLENGER_V1
      || championChallengerPlan?.artifactType !== "CHAMPION_CHALLENGER_RESEARCH_PLAN"
      || championChallengerPlan?.status !== "CHAMPION_CHALLENGER_READY_FOR_NATURAL_PAPER"
      || championChallengerPlan?.executionAuthority !== "NONE"
      || !text(championChallengerPlan?.planDigest)) {
    blockers.push("CERT_CHAMPION_CHALLENGER_PLAN_INVALID");
  }
  if (naturalPaperCandidate?.schemaVersion !== ADAPTIVE_MULTI_EVIDENCE_NATURAL_PAPER_V2_VERSION
      || naturalPaperCandidate?.status !== "NATURAL_PAPER_CANDIDATE_READY_INACTIVE"
      || naturalPaperCandidate?.executionAuthority !== "NONE"
      || naturalPaperCandidate?.scheduleActive !== false
      || naturalPaperCandidate?.runtimeActivated !== false
      || naturalPaperCandidate?.activationRequiresSeparateApproval !== true) {
    blockers.push("CERT_NATURAL_PAPER_CANDIDATE_INVALID");
  }
  if (executionAuthority !== "NONE") blockers.push("CERT_EXECUTION_AUTHORITY_FORBIDDEN");

  const candidateId = naturalPaperCandidate?.candidate?.candidateId
    ?? naturalPaperCandidate?.candidateId
    ?? null;
  if (!text(candidateId)) blockers.push("CERT_CANDIDATE_ID_REQUIRED");
  if (!Array.isArray(championChallengerPlan?.candidates)
      || !championChallengerPlan.candidates.some((candidate) => candidate?.candidateId === candidateId)) {
    blockers.push("CERT_CANDIDATE_NOT_IN_CHALLENGER_PLAN");
  }

  if (blockers.length > 0) {
    return deepFreeze({
      schemaVersion: AUTONOMOUS_ALPHA_CERTIFICATION_V1,
      artifactType: "AUTONOMOUS_ALPHA_CERTIFICATION",
      status: "BLOCKED_DATA",
      blockers: [...new Set(blockers)].sort(),
      candidateId,
      championPlanDigest: championChallengerPlan?.planDigest ?? null,
      profitabilityProven: false,
      nextAction: null,
      ...safety(),
    });
  }

  if (!validActivationReceipt(activationReceipt, candidateId)) {
    const core = {
      candidateId,
      championPlanDigest: championChallengerPlan.planDigest,
      naturalPaperHandoffDigest: naturalPaperCandidate.handoffDigest ?? null,
    };
    return deepFreeze({
      schemaVersion: AUTONOMOUS_ALPHA_CERTIFICATION_V1,
      artifactType: "AUTONOMOUS_ALPHA_CERTIFICATION",
      status: "READY_FOR_SEPARATE_NATURAL_PAPER_ACTIVATION_APPROVAL",
      blockers: [],
      candidateId,
      championPlanDigest: championChallengerPlan.planDigest,
      certificationDigest: digest(core),
      profitabilityProven: false,
      economicSampleCredit: 0,
      activationPerformed: false,
      activationReceiptRequired: true,
      nextAction: "SEPARATE_HUMAN_APPROVAL_FOR_PAPER_ONLY_24_7_ACTIVATION",
      ...safety(),
    });
  }

  const evidenceBlockers = [];
  if (settlementProfitabilityGate?.schemaVersion !== "settlement-profitability-evidence-gate-v1"
      || settlementProfitabilityGate?.executionAuthority !== "NONE") {
    evidenceBlockers.push("CERT_SETTLEMENT_PROFITABILITY_GATE_INVALID");
  }
  if (unifiedProfitabilityPromotion?.schemaVersion !== UNIFIED_PROFITABILITY_PROMOTION_SCHEMA_VERSION
      || unifiedProfitabilityPromotion?.safety?.orderAuthority !== false
      || unifiedProfitabilityPromotion?.safety?.liveTradingAllowed !== false) {
    evidenceBlockers.push("CERT_UNIFIED_PROMOTION_GATE_INVALID");
  }
  if (lifecycleControl?.schemaVersion !== PROFITABILITY_LIFECYCLE_CONTROL_SCHEMA_VERSION
      || lifecycleControl?.safety?.orderAuthority !== false
      || lifecycleControl?.safety?.liveTradingAllowed !== false
      || lifecycleControl?.safety?.automaticPromotionAllowed !== false) {
    evidenceBlockers.push("CERT_LIFECYCLE_CONTROL_INVALID");
  }

  const sampleEvidenceComplete = settlementProfitabilityGate?.prerequisiteEvidenceComplete === true
    && settlementProfitabilityGate?.sampleCountStatus === "READY"
    && settlementProfitabilityGate?.naturalEligibility?.status === "PRESENT"
    && settlementProfitabilityGate?.fullCostEvidence?.status === "PRESENT"
    && settlementProfitabilityGate?.pathEvidence?.status === "PRESENT"
    && settlementProfitabilityGate?.regimeEvidence?.status === "PRESENT";

  const canonicalProfitabilityProven =
    settlementProfitabilityGate?.profitabilityProven === true
    && settlementProfitabilityGate?.profitabilityClaimAllowed === true
    && unifiedProfitabilityPromotion?.promotionEligible === true
    && unifiedProfitabilityPromotion?.status === "PROMOTION_REVIEW_READY"
    && lifecycleControl?.status === "LIFECYCLE_REVIEW_READY";

  const holdReasons = [];
  if (!sampleEvidenceComplete) holdReasons.push("CERT_NATURAL_FULL_COST_SAMPLE_EVIDENCE_INCOMPLETE");
  if (settlementProfitabilityGate?.p1_5Complete !== true) {
    holdReasons.push("CERT_SETTLEMENT_PROFITABILITY_POLICY_NOT_COMPLETE");
  }
  if (settlementProfitabilityGate?.profitabilityProven !== true) {
    holdReasons.push("CERT_CANONICAL_PROFITABILITY_NOT_PROVEN");
  }
  if (unifiedProfitabilityPromotion?.promotionEligible !== true) {
    holdReasons.push("CERT_UNIFIED_PROMOTION_NOT_ELIGIBLE");
  }
  if (lifecycleControl?.status !== "LIFECYCLE_REVIEW_READY") {
    holdReasons.push("CERT_LIFECYCLE_REVIEW_NOT_READY");
  }

  const blocked = evidenceBlockers.length > 0;
  const ready = !blocked && canonicalProfitabilityProven && holdReasons.length === 0;
  const core = {
    candidateId,
    activationReceipt,
    settlementGateDigest: settlementProfitabilityGate?.settlementSetDigest ?? null,
    unifiedPromotionStatus: unifiedProfitabilityPromotion?.status ?? null,
    lifecycleStatus: lifecycleControl?.status ?? null,
    sampleEvidenceComplete,
    canonicalProfitabilityProven,
  };

  return deepFreeze({
    schemaVersion: AUTONOMOUS_ALPHA_CERTIFICATION_V1,
    artifactType: "AUTONOMOUS_ALPHA_CERTIFICATION",
    status: blocked
      ? "BLOCKED_DATA"
      : ready
        ? "PROFITABILITY_REVIEW_READY_NOT_LIVE"
        : "RESEARCH_HOLD_COLLECT_GENUINE_FORWARD_EVIDENCE",
    blockers: [...new Set(evidenceBlockers)].sort(),
    holdReasons: [...new Set(holdReasons)].sort(),
    candidateId,
    championPlanDigest: championChallengerPlan.planDigest,
    certificationDigest: digest(core),
    activationPerformed: true,
    paperOnly: true,
    sampleEvidenceComplete,
    profitabilityProven: ready,
    livePromotionEligible: false,
    finalHumanReviewRequired: true,
    nextAction: ready
      ? "HUMAN_REVIEW_ONLY_NO_AUTOMATIC_LIVE_PROMOTION"
      : "CONTINUE_GENUINE_NATURAL_PAPER_SETTLEMENT_COLLECTION",
    ...safety(),
  });
}

export function buildAutonomousAlphaArchitectureReadinessV1({
  worldKnowledge,
  alphaGenome,
  redTeam,
  forecast,
  counterfactual,
  digitalTwin,
  championChallenger,
  certification,
} = {}) {
  const stages = [
    ["WORLD_KNOWLEDGE", worldKnowledge, ["WORLD_KNOWLEDGE_READY", "WORLD_KNOWLEDGE_PARTIAL"]],
    ["ALPHA_GENOME", alphaGenome, ["ALPHA_GENOME_READY_FOR_FALSIFICATION"]],
    ["ALPHA_RED_TEAM", redTeam, ["RED_TEAM_SURVIVOR_RESEARCH_ONLY"]],
    ["MULTI_HORIZON_FORECAST", forecast, ["FORECAST_READY_RESEARCH_ONLY", "FORECAST_ABSTAINED"]],
    ["COUNTERFACTUAL_TWIN", counterfactual, ["COUNTERFACTUAL_TWIN_EVALUATED_RESEARCH_ONLY"]],
    ["MARKET_DIGITAL_TWIN", digitalTwin, ["MARKET_DIGITAL_TWIN_EVALUATED_RESEARCH_ONLY"]],
    ["CHAMPION_CHALLENGER", championChallenger, ["CHAMPION_CHALLENGER_READY_FOR_NATURAL_PAPER"]],
    ["CERTIFICATION", certification, [
      "READY_FOR_SEPARATE_NATURAL_PAPER_ACTIVATION_APPROVAL",
      "RESEARCH_HOLD_COLLECT_GENUINE_FORWARD_EVIDENCE",
      "PROFITABILITY_REVIEW_READY_NOT_LIVE",
    ]],
  ];

  const acceptance = stages.map(([name, value, allowed]) => ({
    name,
    status: value?.status ?? null,
    passed: allowed.includes(value?.status)
      && value?.executionAuthority === "NONE",
  }));
  const lineageChecks = [
    {
      name: "WORLD_TO_GENOME",
      passed: text(worldKnowledge?.evidenceGraph?.graphDigest) != null
        && alphaGenome?.evidenceGraphDigest === worldKnowledge.evidenceGraph.graphDigest,
    },
    {
      name: "GENOME_TO_RED_TEAM",
      passed: text(alphaGenome?.genomeDigest) != null
        && redTeam?.genomeDigest === alphaGenome.genomeDigest,
    },
    {
      name: "RED_TEAM_TO_FORECAST",
      passed: text(redTeam?.resultDigest) != null
        && forecast?.redTeamResultDigest === redTeam.resultDigest,
    },
    {
      name: "FORECAST_TO_COUNTERFACTUAL",
      passed: text(forecast?.forecastDigest) != null
        && counterfactual?.forecastDigest === forecast.forecastDigest,
    },
    {
      name: "COUNTERFACTUAL_TO_DIGITAL_TWIN",
      passed: text(counterfactual?.resultDigest) != null
        && digitalTwin?.counterfactualResultDigest === counterfactual.resultDigest,
    },
    {
      name: "DIGITAL_TWIN_TO_CHAMPION",
      passed: text(digitalTwin?.resultDigest) != null
        && championChallenger?.digitalTwinResultDigest === digitalTwin.resultDigest,
    },
    {
      name: "RED_TEAM_TO_CHAMPION_EVIDENCE",
      passed: text(redTeam?.resultDigest) != null
        && Array.isArray(championChallenger?.candidates)
        && championChallenger.candidates.some((candidate) =>
          candidate?.candidateId === alphaGenome?.candidateId
          && candidate?.evidenceDigests?.redTeam === redTeam.resultDigest),
    },
    {
      name: "CHAMPION_TO_CERTIFICATION",
      passed: text(championChallenger?.planDigest) != null
        && certification?.championPlanDigest === championChallenger.planDigest,
    },
  ];
  const candidateIds = [
    alphaGenome?.candidateId,
    redTeam?.candidateId,
    forecast?.candidateId,
    counterfactual?.candidateId,
    digitalTwin?.candidateId,
    certification?.candidateId,
  ].map(text);
  lineageChecks.push({
    name: "CANDIDATE_ID_CONTINUITY",
    passed: candidateIds.every(Boolean) && new Set(candidateIds).size === 1,
  });

  const blockers = [
    ...acceptance.filter((row) => !row.passed).map((row) => `ARCH_${row.name}_INVALID`),
    ...lineageChecks.filter((row) => !row.passed).map((row) => `ARCH_LINEAGE_${row.name}_INVALID`),
  ];
  const profitabilityProven = certification?.status === "PROFITABILITY_REVIEW_READY_NOT_LIVE"
    && certification?.profitabilityProven === true;
  const core = {
    acceptance,
    lineageChecks,
    profitabilityProven,
    certificationDigest: certification?.certificationDigest ?? null,
  };

  return deepFreeze({
    schemaVersion: AUTONOMOUS_ALPHA_CERTIFICATION_V1,
    artifactType: "AUTONOMOUS_ALPHA_ARCHITECTURE_READINESS",
    status: blockers.length > 0
      ? "ARCHITECTURE_BLOCKED"
      : profitabilityProven
        ? "ARCHITECTURE_AND_PROFITABILITY_REVIEW_READY_INACTIVE"
        : "ARCHITECTURE_READY_EVIDENCE_PENDING_INACTIVE",
    blockers,
    acceptance,
    lineageChecks,
    architectureReady: blockers.length === 0,
    profitabilityProven,
    readinessDigest: digest(core),
    finalHumanStop: profitabilityProven
      ? "SEPARATE_LIVE_TRADING_REVIEW_AND_APPROVAL_REQUIRED"
      : "NO_LIVE_REVIEW_UNTIL_PROFITABILITY_EVIDENCE_PROVEN",
    ...safety(),
  });
}
