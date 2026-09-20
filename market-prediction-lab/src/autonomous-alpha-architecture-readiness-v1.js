import crypto from "node:crypto";

export const AUTONOMOUS_ALPHA_CERTIFICATION_V1 =
  "autonomous-alpha-certification-v1";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
  );
}

function digest(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
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
    ...acceptance
      .filter((row) => !row.passed)
      .map((row) => `ARCH_${row.name}_INVALID`),
    ...lineageChecks
      .filter((row) => !row.passed)
      .map((row) => `ARCH_LINEAGE_${row.name}_INVALID`),
  ];

  const profitabilityProven =
    certification?.status === "PROFITABILITY_REVIEW_READY_NOT_LIVE"
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
