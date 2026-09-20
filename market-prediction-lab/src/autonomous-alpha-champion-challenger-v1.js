import crypto from "node:crypto";

import {
  MARKET_DIGITAL_TWIN_MICROSTRUCTURE_V1,
} from "./market-digital-twin-microstructure-v1.js";
import {
  WORLD_KNOWLEDGE_INGEST_V1,
  verifyWorldKnowledgeIngestV1,
} from "./world-knowledge-ingest-v1.js";

export const AUTONOMOUS_ALPHA_CHAMPION_CHALLENGER_V1 =
  "autonomous-alpha-champion-challenger-v1";

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

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function digest64(value) {
  const normalized = text(value)?.toLowerCase() ?? null;
  return normalized && /^[0-9a-f]{64}$/u.test(normalized) ? normalized : null;
}

function safety() {
  return {
    researchOnly: true,
    championAuthority: false,
    automaticChampionReplacementAllowed: false,
    sourceReputationCanBypassEvidenceGate: false,
    sourceReputationCanChangePositionSize: false,
    sourceReputationCanPlaceOrder: false,
    executionAuthority: "NONE",
    mayPlaceOrder: false,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    automaticPromotionAllowed: false,
    economicSampleCredit: 0,
    profitabilityProven: false,
  };
}

function betaPosterior(successes, failures, alpha, beta) {
  return (successes + alpha) / (successes + failures + alpha + beta);
}

export function buildSourceResearchReputationV1({
  worldKnowledgeIngest,
  claimOutcomes = [],
  prior = { alpha: 1, beta: 1 },
  executionAuthority = "NONE",
} = {}) {
  const blockers = [];
  if (worldKnowledgeIngest?.schemaVersion !== WORLD_KNOWLEDGE_INGEST_V1
      || !verifyWorldKnowledgeIngestV1(worldKnowledgeIngest)
      || worldKnowledgeIngest?.executionAuthority !== "NONE") {
    blockers.push("SOURCE_REPUTATION_WORLD_KNOWLEDGE_INVALID");
  }
  if (!Array.isArray(claimOutcomes)) blockers.push("SOURCE_REPUTATION_OUTCOMES_ARRAY_REQUIRED");
  if (!(finite(prior?.alpha) > 0) || !(finite(prior?.beta) > 0)) {
    blockers.push("SOURCE_REPUTATION_PRIOR_INVALID");
  }
  if (executionAuthority !== "NONE") blockers.push("SOURCE_REPUTATION_EXECUTION_AUTHORITY_FORBIDDEN");

  if (blockers.length > 0) {
    return deepFreeze({
      schemaVersion: AUTONOMOUS_ALPHA_CHAMPION_CHALLENGER_V1,
      artifactType: "SOURCE_RESEARCH_REPUTATION",
      status: "BLOCKED_DATA",
      blockers: [...new Set(blockers)].sort(),
      sources: [],
      ...safety(),
    });
  }

  const claimToSource = new Map(
    worldKnowledgeIngest.evidenceGraph.claims
      .filter((claim) => claim.admissible)
      .map((claim) => [claim.claimId, claim.sourceId]),
  );
  const sourceRows = new Map(
    worldKnowledgeIngest.evidenceGraph.sources.map((source) => [
      source.sourceId,
      {
        sourceId: source.sourceId,
        sourceType: source.sourceType,
        claimTests: 0,
        oosPass: 0,
        redTeamPass: 0,
        forwardPass: 0,
        failures: 0,
      },
    ]),
  );

  for (const outcome of claimOutcomes) {
    const claimId = text(outcome?.claimId);
    const sourceId = claimToSource.get(claimId);
    if (!sourceId || !sourceRows.has(sourceId)) {
      blockers.push("SOURCE_REPUTATION_UNKNOWN_CLAIM");
      continue;
    }
    if (outcome?.pointInTimeSafe !== true
        || outcome?.frozenCandidate !== true
        || outcome?.finalHoldoutUsed === true
        || outcome?.executionAuthority != null && outcome.executionAuthority !== "NONE") {
      blockers.push("SOURCE_REPUTATION_OUTCOME_CONTRACT_INVALID");
      continue;
    }
    const row = sourceRows.get(sourceId);
    row.claimTests += 1;
    if (outcome.oosPass === true) row.oosPass += 1;
    if (outcome.redTeamPass === true) row.redTeamPass += 1;
    if (outcome.forwardPass === true) row.forwardPass += 1;
    if (outcome.failed === true) row.failures += 1;
  }

  if (blockers.length > 0) {
    return deepFreeze({
      schemaVersion: AUTONOMOUS_ALPHA_CHAMPION_CHALLENGER_V1,
      artifactType: "SOURCE_RESEARCH_REPUTATION",
      status: "BLOCKED_DATA",
      blockers: [...new Set(blockers)].sort(),
      sources: [],
      ...safety(),
    });
  }

  const sources = [...sourceRows.values()].map((row) => {
    const successes = row.forwardPass;
    const failures = Math.max(row.failures, row.claimTests - row.forwardPass);
    const researchPriorityPosterior = betaPosterior(
      successes,
      failures,
      prior.alpha,
      prior.beta,
    );
    return deepFreeze({
      ...row,
      researchPriorityPosterior,
      reliabilityClaimAllowed: false,
      autoTrustAllowed: false,
      researchQueuePriorityOnly: true,
    });
  }).sort((left, right) =>
    right.researchPriorityPosterior - left.researchPriorityPosterior
    || left.sourceId.localeCompare(right.sourceId));

  const core = {
    ingestDigest: worldKnowledgeIngest.ingestDigest,
    prior,
    sources,
  };

  return deepFreeze({
    schemaVersion: AUTONOMOUS_ALPHA_CHAMPION_CHALLENGER_V1,
    artifactType: "SOURCE_RESEARCH_REPUTATION",
    status: "SOURCE_REPUTATION_READY_RESEARCH_ONLY",
    blockers: [],
    ingestDigest: worldKnowledgeIngest.ingestDigest,
    prior: { alpha: prior.alpha, beta: prior.beta },
    sources,
    reputationDigest: digest(core),
    interpretation:
      "PRIORITIZE_WHAT_TO_RESEARCH_NEXT_NOT_WHAT_TO_TRADE",
    ...safety(),
  });
}

function normalizeCandidate(raw) {
  const candidateId = text(raw?.candidateId);
  const metrics = {
    costAdjustedExpectancy: finite(raw?.metrics?.costAdjustedExpectancy),
    profitFactor: finite(raw?.metrics?.profitFactor),
    maximumDrawdown: finite(raw?.metrics?.maximumDrawdown),
    walkForwardStability: finite(raw?.metrics?.walkForwardStability),
    calibrationError: finite(raw?.metrics?.calibrationError),
  };
  const evidenceDigests = {
    sealedOos: digest64(raw?.evidenceDigests?.sealedOos),
    redTeam: digest64(raw?.evidenceDigests?.redTeam),
    digitalTwin: digest64(raw?.evidenceDigests?.digitalTwin),
    strategyHealth: digest64(raw?.evidenceDigests?.strategyHealth),
    fullCost: digest64(raw?.evidenceDigests?.fullCost),
  };
  const reasons = [];
  if (!candidateId) reasons.push("CHALLENGER_CANDIDATE_ID_REQUIRED");
  if (Object.values(metrics).some((value) => value == null)) reasons.push("CHALLENGER_METRICS_REQUIRED");
  if (Object.values(evidenceDigests).some((value) => value == null)) {
    reasons.push("CHALLENGER_EVIDENCE_DIGESTS_REQUIRED");
  }
  if (metrics.profitFactor != null && metrics.profitFactor < 0) reasons.push("CHALLENGER_PROFIT_FACTOR_INVALID");
  if (metrics.maximumDrawdown != null && metrics.maximumDrawdown < 0) reasons.push("CHALLENGER_DRAWDOWN_INVALID");
  if (metrics.calibrationError != null && metrics.calibrationError < 0) reasons.push("CHALLENGER_CALIBRATION_INVALID");
  if (raw?.sealedOosPassed !== true) reasons.push("CHALLENGER_SEALED_OOS_REQUIRED");
  if (raw?.redTeamPassed !== true) reasons.push("CHALLENGER_RED_TEAM_REQUIRED");
  if (raw?.digitalTwinEvaluated !== true) reasons.push("CHALLENGER_DIGITAL_TWIN_REQUIRED");
  if (raw?.strategyHealthOk !== true) reasons.push("CHALLENGER_STRATEGY_HEALTH_REQUIRED");
  if (raw?.fullCostApplied !== true) reasons.push("CHALLENGER_FULL_COST_REQUIRED");
  if (raw?.pointInTimeSafe !== true) reasons.push("CHALLENGER_POINT_IN_TIME_REQUIRED");
  if (raw?.finalHoldoutReused === true) reasons.push("CHALLENGER_FINAL_HOLDOUT_REUSE_FORBIDDEN");
  if (raw?.executionAuthority != null && raw.executionAuthority !== "NONE") {
    reasons.push("CHALLENGER_EXECUTION_AUTHORITY_FORBIDDEN");
  }
  return deepFreeze({
    candidateId: candidateId ?? null,
    metrics,
    evidenceDigests,
    eligibleForResearchCompetition: reasons.length === 0,
    reasons: [...new Set(reasons)].sort(),
  });
}

function dominates(left, right) {
  const l = left.metrics;
  const r = right.metrics;
  const noWorse = l.costAdjustedExpectancy >= r.costAdjustedExpectancy
    && l.profitFactor >= r.profitFactor
    && l.maximumDrawdown <= r.maximumDrawdown
    && l.walkForwardStability >= r.walkForwardStability
    && l.calibrationError <= r.calibrationError;
  const strictlyBetter = l.costAdjustedExpectancy > r.costAdjustedExpectancy
    || l.profitFactor > r.profitFactor
    || l.maximumDrawdown < r.maximumDrawdown
    || l.walkForwardStability > r.walkForwardStability
    || l.calibrationError < r.calibrationError;
  return noWorse && strictlyBetter;
}

export function buildChampionChallengerResearchPlanV1({
  digitalTwinResult,
  candidates = [],
  incumbentCandidateId = null,
  sourceReputation = null,
  executionAuthority = "NONE",
} = {}) {
  const blockers = [];
  if (digitalTwinResult?.schemaVersion !== MARKET_DIGITAL_TWIN_MICROSTRUCTURE_V1
      || digitalTwinResult?.artifactType !== "MARKET_DIGITAL_TWIN_RESULT"
      || digitalTwinResult?.status !== "MARKET_DIGITAL_TWIN_EVALUATED_RESEARCH_ONLY"
      || digitalTwinResult?.executionAuthority !== "NONE"
      || !text(digitalTwinResult?.resultDigest)) {
    blockers.push("CHALLENGER_DIGITAL_TWIN_RESULT_INVALID");
  }
  if (!Array.isArray(candidates) || candidates.length === 0) blockers.push("CHALLENGER_CANDIDATES_REQUIRED");
  if (sourceReputation != null
      && (sourceReputation?.schemaVersion !== AUTONOMOUS_ALPHA_CHAMPION_CHALLENGER_V1
        || sourceReputation?.artifactType !== "SOURCE_RESEARCH_REPUTATION"
        || sourceReputation?.status !== "SOURCE_REPUTATION_READY_RESEARCH_ONLY"
        || sourceReputation?.executionAuthority !== "NONE")) {
    blockers.push("CHALLENGER_SOURCE_REPUTATION_INVALID");
  }
  if (executionAuthority !== "NONE") blockers.push("CHALLENGER_EXECUTION_AUTHORITY_FORBIDDEN");

  const normalized = Array.isArray(candidates) ? candidates.map(normalizeCandidate) : [];
  if (normalized.some((candidate) => !candidate.eligibleForResearchCompetition)) {
    blockers.push("CHALLENGER_CANDIDATE_CONTRACT_INVALID");
  }
  const ids = normalized.map((candidate) => candidate.candidateId);
  if (new Set(ids).size !== ids.length) blockers.push("CHALLENGER_DUPLICATE_CANDIDATE_ID");
  const digitalTwinCandidateId = text(digitalTwinResult?.candidateId);
  const digitalTwinCandidate = normalized.find((candidate) => candidate.candidateId === digitalTwinCandidateId);
  if (!digitalTwinCandidateId || !digitalTwinCandidate) {
    blockers.push("CHALLENGER_DIGITAL_TWIN_CANDIDATE_MISSING");
  } else if (digitalTwinCandidate.evidenceDigests.digitalTwin !== digitalTwinResult.resultDigest) {
    blockers.push("CHALLENGER_DIGITAL_TWIN_LINEAGE_MISMATCH");
  }

  if (blockers.length > 0) {
    return deepFreeze({
      schemaVersion: AUTONOMOUS_ALPHA_CHAMPION_CHALLENGER_V1,
      artifactType: "CHAMPION_CHALLENGER_RESEARCH_PLAN",
      status: "BLOCKED_DATA",
      blockers: [...new Set(blockers)].sort(),
      paretoChallengerIds: [],
      nextStage: null,
      ...safety(),
    });
  }

  const pareto = normalized.filter((candidate) =>
    !normalized.some((other) =>
      other.candidateId !== candidate.candidateId && dominates(other, candidate)));

  const incumbent = text(incumbentCandidateId);
  const incumbentPresent = incumbent == null || ids.includes(incumbent);
  if (!incumbentPresent) blockers.push("CHALLENGER_INCUMBENT_NOT_IN_CANDIDATES");

  const core = {
    digitalTwinResultDigest: digitalTwinResult.resultDigest,
    candidates: normalized,
    paretoChallengerIds: pareto.map((candidate) => candidate.candidateId).sort(),
    incumbentCandidateId: incumbent,
    sourceReputationDigest: sourceReputation?.reputationDigest ?? null,
  };

  return deepFreeze({
    schemaVersion: AUTONOMOUS_ALPHA_CHAMPION_CHALLENGER_V1,
    artifactType: "CHAMPION_CHALLENGER_RESEARCH_PLAN",
    status: blockers.length === 0
      ? "CHAMPION_CHALLENGER_READY_FOR_NATURAL_PAPER"
      : "BLOCKED_DATA",
    blockers: [...new Set(blockers)].sort(),
    digitalTwinResultDigest: digitalTwinResult.resultDigest,
    candidates: normalized,
    comparisonMethod: "PARETO_NO_SCALAR_SCORE",
    paretoChallengerIds: pareto.map((candidate) => candidate.candidateId).sort(),
    incumbentCandidateId: incumbent,
    incumbentReplacementDecision: "NOT_AUTHORIZED",
    sourceReputationDigest: sourceReputation?.reputationDigest ?? null,
    sourceReputationUsedInPerformanceRanking: false,
    failureMemoryPersistenceOwner: "EXISTING_RESEARCH_FAILURE_MEMORY_OWNER",
    duplicateFailureMemoryImplementationAllowed: false,
    planDigest: digest(core),
    nextStage: blockers.length === 0 ? "NATURAL_PAPER_PROFITABILITY_CERTIFICATION" : null,
    ...safety(),
  });
}
