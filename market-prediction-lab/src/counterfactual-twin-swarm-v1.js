import crypto from "node:crypto";

import {
  MULTI_HORIZON_FORECAST_UNCERTAINTY_V1,
} from "./multi-horizon-forecast-uncertainty-v1.js";

export const COUNTERFACTUAL_TWIN_SWARM_V1 = "counterfactual-twin-swarm-v1";

const EXECUTION_MODES = new Set(["MARKET_SIM", "LIMIT_SIM", "SPLIT_SIM"]);
const EXIT_MODES = new Set(["BASE_POLICY", "EARLY_PARTIAL", "TRAIL_ONLY", "TIME_EXIT"]);

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

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => String(a).localeCompare(String(b)));
}

function safety() {
  return {
    researchOnly: true,
    counterfactualOnly: true,
    simulatedExecutionOnly: true,
    executionAuthority: "NONE",
    mayPlaceOrder: false,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    automaticPromotionAllowed: false,
    economicSampleCredit: 0,
    counterfactualEconomicCredit: 0,
    profitabilityProven: false,
  };
}

function normalizePlanPolicy(policy) {
  const maximumTwins = policy?.maximumTwins;
  const sizeFractions = Array.isArray(policy?.sizeFractions)
    ? uniqueSorted(policy.sizeFractions.filter((value) => finite(value) != null))
    : null;
  const entryDelayBars = Array.isArray(policy?.entryDelayBars)
    ? uniqueSorted(policy.entryDelayBars.filter((value) => Number.isSafeInteger(value)))
    : null;
  const executionModes = Array.isArray(policy?.executionModes)
    ? uniqueSorted(policy.executionModes.map((value) => text(value)?.toUpperCase()).filter(Boolean))
    : null;
  const exitModes = Array.isArray(policy?.exitModes)
    ? uniqueSorted(policy.exitModes.map((value) => text(value)?.toUpperCase()).filter(Boolean))
    : null;

  if (!Number.isSafeInteger(maximumTwins) || maximumTwins < 2 || maximumTwins > 128
      || !sizeFractions || sizeFractions.length === 0
      || sizeFractions.some((value) => value <= 0 || value > 1)
      || !entryDelayBars || entryDelayBars.length === 0
      || entryDelayBars.some((value) => value < 0 || value > 32)
      || !executionModes || executionModes.length === 0
      || executionModes.some((value) => !EXECUTION_MODES.has(value))
      || !exitModes || exitModes.length === 0
      || exitModes.some((value) => !EXIT_MODES.has(value))) {
    return null;
  }

  return {
    maximumTwins,
    sizeFractions,
    entryDelayBars,
    executionModes,
    exitModes,
    includeNoTradeTwin: policy?.includeNoTradeTwin !== false,
  };
}

function twin(candidateId, forecastDigest, variant) {
  const core = {
    candidateId,
    forecastDigest,
    variant,
  };
  return deepFreeze({
    twinId: `counterfactual-twin:sha256:${digest(core)}`,
    ...variant,
    simulatedOnly: true,
    economicSampleCredit: 0,
    executionAuthority: "NONE",
  });
}

export function buildCounterfactualTwinSwarmPlanV1({
  forecastResult,
  policy,
  executionAuthority = "NONE",
} = {}) {
  const blockers = [];
  const normalizedPolicy = normalizePlanPolicy(policy);
  if (forecastResult?.schemaVersion !== MULTI_HORIZON_FORECAST_UNCERTAINTY_V1
      || !["FORECAST_READY_RESEARCH_ONLY", "FORECAST_ABSTAINED"].includes(forecastResult?.status)
      || forecastResult?.executionAuthority !== "NONE"
      || !text(forecastResult?.forecastDigest)
      || !text(forecastResult?.candidateId)) {
    blockers.push("TWIN_FORECAST_RESULT_INVALID");
  }
  if (!normalizedPolicy) blockers.push("TWIN_POLICY_INVALID");
  if (executionAuthority !== "NONE") blockers.push("TWIN_EXECUTION_AUTHORITY_FORBIDDEN");

  if (blockers.length > 0) {
    return deepFreeze({
      schemaVersion: COUNTERFACTUAL_TWIN_SWARM_V1,
      artifactType: "COUNTERFACTUAL_TWIN_PLAN",
      status: "BLOCKED_DATA",
      blockers: [...new Set(blockers)].sort(),
      twins: [],
      nextStage: null,
      ...safety(),
    });
  }

  const variants = [];
  if (normalizedPolicy.includeNoTradeTwin) {
    variants.push({
      action: "NO_TRADE",
      positionFraction: 0,
      entryDelayBars: 0,
      executionMode: "NONE",
      exitMode: "NONE",
    });
  }

  outer:
  for (const positionFraction of normalizedPolicy.sizeFractions) {
    for (const entryDelayBars of normalizedPolicy.entryDelayBars) {
      for (const executionMode of normalizedPolicy.executionModes) {
        for (const exitMode of normalizedPolicy.exitModes) {
          variants.push({
            action: forecastResult.decision === "RESEARCH_SHORT_BIAS"
              ? "SIMULATED_SHORT"
              : forecastResult.decision === "RESEARCH_LONG_BIAS"
                ? "SIMULATED_LONG"
                : "SIMULATED_HYPOTHETICAL",
            positionFraction,
            entryDelayBars,
            executionMode,
            exitMode,
          });
          if (variants.length >= normalizedPolicy.maximumTwins) break outer;
        }
      }
    }
  }

  const twins = variants
    .slice(0, normalizedPolicy.maximumTwins)
    .map((variant) => twin(forecastResult.candidateId, forecastResult.forecastDigest, variant));

  const twinIds = twins.map((row) => row.twinId);
  if (new Set(twinIds).size !== twinIds.length) blockers.push("TWIN_DUPLICATE_ID");

  const core = {
    candidateId: forecastResult.candidateId,
    forecastDigest: forecastResult.forecastDigest,
    policy: normalizedPolicy,
    twins,
  };

  return deepFreeze({
    schemaVersion: COUNTERFACTUAL_TWIN_SWARM_V1,
    artifactType: "COUNTERFACTUAL_TWIN_PLAN",
    status: blockers.length === 0 ? "COUNTERFACTUAL_TWIN_PLAN_READY" : "BLOCKED_DATA",
    blockers: [...new Set(blockers)].sort(),
    candidateId: forecastResult.candidateId,
    forecastDigest: forecastResult.forecastDigest,
    forecastDecision: forecastResult.decision,
    policy: normalizedPolicy,
    twins,
    twinCount: twins.length,
    planDigest: digest(core),
    sameFuturePathRequired: true,
    marketImpactSimulationRequired: true,
    partialFillSimulationRequired: true,
    nextStage: blockers.length === 0 ? "COUNTERFACTUAL_TWIN_EVALUATION" : null,
    ...safety(),
  });
}

function normalizeOutcome(outcome, context) {
  const twinId = text(outcome?.twinId);
  const marketPathDigest = text(outcome?.marketPathDigest);
  const evidenceId = text(outcome?.evidenceId);
  const grossPnl = finite(outcome?.grossPnl);
  const fees = finite(outcome?.fees);
  const slippageCost = finite(outcome?.slippageCost);
  const marketImpactCost = finite(outcome?.marketImpactCost);
  const fundingCost = finite(outcome?.fundingCost);
  const netPnl = finite(outcome?.netPnl);
  const fillRatio = finite(outcome?.fillRatio);
  const reasons = [];

  if (!context.twinIds.has(twinId)) reasons.push("TWIN_OUTCOME_ID_UNKNOWN");
  if (!marketPathDigest || !/^[0-9a-f]{64}$/u.test(marketPathDigest)) {
    reasons.push("TWIN_MARKET_PATH_DIGEST_REQUIRED");
  }
  if (!evidenceId || !/^[a-zA-Z0-9_.:-]{8,240}$/u.test(evidenceId)) {
    reasons.push("TWIN_OUTCOME_EVIDENCE_ID_REQUIRED");
  }
  for (const [name, value] of Object.entries({
    grossPnl,
    fees,
    slippageCost,
    marketImpactCost,
    fundingCost,
    netPnl,
  })) {
    if (value == null) reasons.push(`TWIN_${name.toUpperCase()}_REQUIRED`);
  }
  if (fees != null && fees < 0) reasons.push("TWIN_FEES_NEGATIVE");
  if (slippageCost != null && slippageCost < 0) reasons.push("TWIN_SLIPPAGE_NEGATIVE");
  if (marketImpactCost != null && marketImpactCost < 0) reasons.push("TWIN_MARKET_IMPACT_NEGATIVE");
  if (fundingCost != null && fundingCost < 0) reasons.push("TWIN_FUNDING_NEGATIVE");
  if (fillRatio == null || fillRatio < 0 || fillRatio > 1) reasons.push("TWIN_FILL_RATIO_INVALID");
  if (outcome?.sameMarketPath !== true) reasons.push("TWIN_SAME_MARKET_PATH_REQUIRED");
  if (outcome?.simulated !== true) reasons.push("TWIN_SIMULATED_FLAG_REQUIRED");
  if (outcome?.pointInTimeSafe !== true) reasons.push("TWIN_POINT_IN_TIME_REQUIRED");
  if (outcome?.marketImpactModeled !== true) reasons.push("TWIN_MARKET_IMPACT_MODEL_REQUIRED");
  if (outcome?.partialFillModeled !== true) reasons.push("TWIN_PARTIAL_FILL_MODEL_REQUIRED");
  if (outcome?.finalHoldoutUsed === true) reasons.push("TWIN_FINAL_HOLDOUT_FORBIDDEN");
  if (outcome?.executionAuthority != null && outcome.executionAuthority !== "NONE") {
    reasons.push("TWIN_EXECUTION_AUTHORITY_FORBIDDEN");
  }

  const expectedNet = [grossPnl, fees, slippageCost, marketImpactCost, fundingCost]
    .every((value) => value != null)
    ? grossPnl - fees - slippageCost - marketImpactCost - fundingCost
    : null;
  if (expectedNet != null && netPnl != null && Math.abs(expectedNet - netPnl) > 1e-9) {
    reasons.push("TWIN_NET_PNL_ACCOUNTING_MISMATCH");
  }

  return deepFreeze({
    twinId: twinId ?? null,
    marketPathDigest: marketPathDigest ?? null,
    evidenceId: evidenceId ?? null,
    grossPnl,
    costs: {
      fees,
      slippageCost,
      marketImpactCost,
      fundingCost,
    },
    netPnl,
    fillRatio,
    contractValid: reasons.length === 0,
    reasons: [...new Set(reasons)].sort(),
  });
}

export function evaluateCounterfactualTwinSwarmV1({
  plan,
  outcomes = [],
  executionAuthority = "NONE",
} = {}) {
  const blockers = [];
  if (plan?.schemaVersion !== COUNTERFACTUAL_TWIN_SWARM_V1
      || plan?.artifactType !== "COUNTERFACTUAL_TWIN_PLAN"
      || plan?.status !== "COUNTERFACTUAL_TWIN_PLAN_READY"
      || plan?.executionAuthority !== "NONE"
      || !text(plan?.planDigest)) {
    blockers.push("TWIN_PLAN_INVALID");
  }
  if (!Array.isArray(outcomes)) blockers.push("TWIN_OUTCOMES_ARRAY_REQUIRED");
  if (executionAuthority !== "NONE") blockers.push("TWIN_EXECUTION_AUTHORITY_FORBIDDEN");

  if (blockers.length > 0) {
    return deepFreeze({
      schemaVersion: COUNTERFACTUAL_TWIN_SWARM_V1,
      artifactType: "COUNTERFACTUAL_TWIN_RESULT",
      status: "BLOCKED_DATA",
      blockers: [...new Set(blockers)].sort(),
      outcomes: [],
      researchLeaderTwinId: null,
      nextStage: null,
      ...safety(),
    });
  }

  const twinIds = new Set(plan.twins.map((row) => row.twinId));
  const normalized = outcomes.map((outcome) => normalizeOutcome(outcome, { twinIds }));
  if (normalized.some((row) => !row.contractValid)) blockers.push("TWIN_OUTCOME_CONTRACT_INVALID");

  const outcomeIds = normalized.map((row) => row.twinId);
  if (new Set(outcomeIds).size !== outcomeIds.length) blockers.push("TWIN_DUPLICATE_OUTCOME");
  const missingTwinIds = [...twinIds].filter((twinId) => !outcomeIds.includes(twinId));
  if (missingTwinIds.length > 0) blockers.push("TWIN_OUTCOMES_INCOMPLETE");

  const pathDigests = new Set(normalized.map((row) => row.marketPathDigest).filter(Boolean));
  if (pathDigests.size !== 1) blockers.push("TWIN_MARKET_PATH_NOT_IDENTICAL");

  const ranked = normalized
    .filter((row) => row.contractValid)
    .sort((left, right) => right.netPnl - left.netPnl || left.twinId.localeCompare(right.twinId));
  const researchLeader = blockers.length === 0 ? ranked[0] ?? null : null;
  const noTradeTwin = plan.twins.find((row) => row.action === "NO_TRADE");
  const noTradeOutcome = noTradeTwin
    ? normalized.find((row) => row.twinId === noTradeTwin.twinId)
    : null;

  const core = {
    planDigest: plan.planDigest,
    marketPathDigest: pathDigests.size === 1 ? [...pathDigests][0] : null,
    outcomes: normalized,
    researchLeaderTwinId: researchLeader?.twinId ?? null,
  };

  return deepFreeze({
    schemaVersion: COUNTERFACTUAL_TWIN_SWARM_V1,
    artifactType: "COUNTERFACTUAL_TWIN_RESULT",
    status: blockers.length === 0 ? "COUNTERFACTUAL_TWIN_EVALUATED_RESEARCH_ONLY" : "BLOCKED_DATA",
    blockers: [...new Set(blockers)].sort(),
    candidateId: plan.candidateId,
    forecastDigest: plan.forecastDigest,
    planDigest: plan.planDigest,
    marketPathDigest: pathDigests.size === 1 ? [...pathDigests][0] : null,
    outcomes: normalized,
    researchLeaderTwinId: researchLeader?.twinId ?? null,
    researchLeaderNetPnl: researchLeader?.netPnl ?? null,
    noTradeTwinNetPnl: noTradeOutcome?.netPnl ?? null,
    diagnosticRegretVsResearchLeader: noTradeOutcome && researchLeader
      ? researchLeader.netPnl - noTradeOutcome.netPnl
      : null,
    resultDigest: digest(core),
    selectionAuthority: false,
    promotionEligible: false,
    nextStage: blockers.length === 0 ? "MARKET_DIGITAL_TWIN" : null,
    ...safety(),
  });
}
