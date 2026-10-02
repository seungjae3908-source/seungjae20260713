import crypto from "node:crypto";

import { AUTONOMOUS_ALPHA_SCIENTIST_FOUNDATION_V1 } from "./autonomous-alpha-scientist-foundation-v1.js";

export const ALPHA_RED_TEAM_V1 = "alpha-red-team-v1";

export const REQUIRED_ALPHA_RED_TEAM_SCENARIOS = Object.freeze([
  "FULL_COST_BASELINE",
  "COST_MULTIPLIER_2X",
  "SLIPPAGE_MULTIPLIER_3X",
  "ENTRY_DELAY_1_BAR",
  "PARTIAL_FILL",
  "SPREAD_SHOCK",
  "MISSING_DATA",
  "REGIME_FLIP",
  "CORRELATION_SPIKE",
  "PARAMETER_PERTURBATION",
  "OUTLIER_SHOCK",
  "CALIBRATION_DEGRADATION",
]);

const REQUIRED = new Set(REQUIRED_ALPHA_RED_TEAM_SCENARIOS);

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

function safety() {
  return {
    researchOnly: true,
    adversarialValidationOnly: true,
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

export function buildAlphaRedTeamAttackPlanV1({ genome, executionAuthority = "NONE" } = {}) {
  const blockers = [];
  if (genome?.schemaVersion !== AUTONOMOUS_ALPHA_SCIENTIST_FOUNDATION_V1
      || genome?.artifactType !== "ALPHA_GENOME"
      || genome?.status !== "ALPHA_GENOME_READY_FOR_FALSIFICATION"
      || genome?.executionAuthority !== "NONE") {
    blockers.push("RED_TEAM_ALPHA_GENOME_INVALID");
  }
  if (executionAuthority !== "NONE") blockers.push("RED_TEAM_EXECUTION_AUTHORITY_FORBIDDEN");

  const attacks = REQUIRED_ALPHA_RED_TEAM_SCENARIOS.map((scenarioId) => ({
    scenarioId,
    required: true,
    selectionAuthority: false,
    mayTuneCandidate: false,
    mustUseFrozenGenome: true,
  }));

  const core = {
    genomeDigest: genome?.genomeDigest ?? null,
    attacks,
  };
  return deepFreeze({
    schemaVersion: ALPHA_RED_TEAM_V1,
    artifactType: "ALPHA_RED_TEAM_ATTACK_PLAN",
    status: blockers.length === 0 ? "RED_TEAM_PLAN_READY" : "BLOCKED_DATA",
    blockers: [...new Set(blockers)].sort(),
    genomeDigest: genome?.genomeDigest ?? null,
    attacks,
    attackPlanDigest: digest(core),
    frozenGenomeRequired: true,
    retuningDuringRedTeamForbidden: true,
    finalHoldoutAccessAllowed: false,
    ...safety(),
  });
}

function normalizePolicy(policy) {
  const minNetExpectancy = finite(policy?.minNetExpectancy);
  const minProfitFactor = finite(policy?.minProfitFactor);
  const maxDrawdown = finite(policy?.maxDrawdown);
  const minTradeCount = policy?.minTradeCount;
  const maxCalibrationError = finite(policy?.maxCalibrationError);
  const minimumScenarioPassRatio = finite(policy?.minimumScenarioPassRatio);
  if (minNetExpectancy == null
      || minProfitFactor == null || minProfitFactor <= 0
      || maxDrawdown == null || maxDrawdown < 0
      || !Number.isSafeInteger(minTradeCount) || minTradeCount < 1
      || maxCalibrationError == null || maxCalibrationError < 0
      || minimumScenarioPassRatio == null
      || minimumScenarioPassRatio <= 0 || minimumScenarioPassRatio > 1) {
    return null;
  }
  return {
    minNetExpectancy,
    minProfitFactor,
    maxDrawdown,
    minTradeCount,
    maxCalibrationError,
    minimumScenarioPassRatio,
  };
}

function normalizeReceipt(receipt, context) {
  const scenarioId = text(receipt?.scenarioId)?.toUpperCase();
  const candidateId = text(receipt?.candidateId);
  const genomeDigest = text(receipt?.genomeDigest);
  const evidenceId = text(receipt?.evidenceId);
  const netExpectancy = finite(receipt?.netExpectancy);
  const profitFactor = finite(receipt?.profitFactor);
  const maximumDrawdown = finite(receipt?.maximumDrawdown);
  const calibrationError = finite(receipt?.calibrationError);
  const tradeCount = receipt?.tradeCount;
  const frozenParameters = receipt?.frozenParameters === true;
  const fullCostApplied = receipt?.fullCostApplied === true;
  const pointInTimeSafe = receipt?.pointInTimeSafe === true;
  const reasons = [];

  if (!REQUIRED.has(scenarioId)) reasons.push("RED_TEAM_SCENARIO_UNKNOWN");
  if (candidateId !== context.candidateId) reasons.push("RED_TEAM_CANDIDATE_MISMATCH");
  if (genomeDigest !== context.genomeDigest) reasons.push("RED_TEAM_GENOME_DIGEST_MISMATCH");
  if (!evidenceId || !/^[a-zA-Z0-9_.:-]{8,240}$/u.test(evidenceId)) {
    reasons.push("RED_TEAM_EVIDENCE_ID_REQUIRED");
  }
  if (netExpectancy == null) reasons.push("RED_TEAM_NET_EXPECTANCY_REQUIRED");
  if (profitFactor == null || profitFactor < 0) reasons.push("RED_TEAM_PROFIT_FACTOR_REQUIRED");
  if (maximumDrawdown == null || maximumDrawdown < 0) reasons.push("RED_TEAM_DRAWDOWN_REQUIRED");
  if (calibrationError == null || calibrationError < 0) reasons.push("RED_TEAM_CALIBRATION_REQUIRED");
  if (!Number.isSafeInteger(tradeCount) || tradeCount < 0) reasons.push("RED_TEAM_TRADE_COUNT_INVALID");
  if (!frozenParameters) reasons.push("RED_TEAM_FROZEN_PARAMETERS_REQUIRED");
  if (!fullCostApplied) reasons.push("RED_TEAM_FULL_COST_REQUIRED");
  if (!pointInTimeSafe) reasons.push("RED_TEAM_POINT_IN_TIME_REQUIRED");
  if (receipt?.finalHoldoutUsed === true) reasons.push("RED_TEAM_FINAL_HOLDOUT_FORBIDDEN");
  if (receipt?.executionAuthority != null && receipt.executionAuthority !== "NONE") {
    reasons.push("RED_TEAM_EXECUTION_AUTHORITY_FORBIDDEN");
  }

  const pass = reasons.length === 0
    && netExpectancy >= context.policy.minNetExpectancy
    && profitFactor >= context.policy.minProfitFactor
    && maximumDrawdown <= context.policy.maxDrawdown
    && tradeCount >= context.policy.minTradeCount
    && calibrationError <= context.policy.maxCalibrationError;

  return deepFreeze({
    scenarioId: scenarioId ?? null,
    candidateId: candidateId ?? null,
    genomeDigest: genomeDigest ?? null,
    evidenceId: evidenceId ?? null,
    metrics: {
      netExpectancy,
      profitFactor,
      maximumDrawdown,
      tradeCount: Number.isSafeInteger(tradeCount) ? tradeCount : null,
      calibrationError,
    },
    frozenParameters,
    fullCostApplied,
    pointInTimeSafe,
    contractValid: reasons.length === 0,
    pass,
    reasons: [
      ...new Set([
        ...reasons,
        ...(reasons.length === 0 && netExpectancy < context.policy.minNetExpectancy
          ? ["RED_TEAM_EXPECTANCY_FAILED"] : []),
        ...(reasons.length === 0 && profitFactor < context.policy.minProfitFactor
          ? ["RED_TEAM_PROFIT_FACTOR_FAILED"] : []),
        ...(reasons.length === 0 && maximumDrawdown > context.policy.maxDrawdown
          ? ["RED_TEAM_DRAWDOWN_FAILED"] : []),
        ...(reasons.length === 0 && tradeCount < context.policy.minTradeCount
          ? ["RED_TEAM_SAMPLE_FAILED"] : []),
        ...(reasons.length === 0 && calibrationError > context.policy.maxCalibrationError
          ? ["RED_TEAM_CALIBRATION_FAILED"] : []),
      ]),
    ].sort(),
  });
}

export function evaluateAlphaRedTeamV1({
  genome,
  attackPlan,
  policy,
  receipts = [],
  executionAuthority = "NONE",
} = {}) {
  const blockers = [];
  const normalizedPolicy = normalizePolicy(policy);
  if (genome?.schemaVersion !== AUTONOMOUS_ALPHA_SCIENTIST_FOUNDATION_V1
      || genome?.artifactType !== "ALPHA_GENOME"
      || genome?.status !== "ALPHA_GENOME_READY_FOR_FALSIFICATION"
      || genome?.executionAuthority !== "NONE") {
    blockers.push("RED_TEAM_ALPHA_GENOME_INVALID");
  }
  if (attackPlan?.schemaVersion !== ALPHA_RED_TEAM_V1
      || attackPlan?.artifactType !== "ALPHA_RED_TEAM_ATTACK_PLAN"
      || attackPlan?.status !== "RED_TEAM_PLAN_READY"
      || attackPlan?.genomeDigest !== genome?.genomeDigest
      || attackPlan?.executionAuthority !== "NONE") {
    blockers.push("RED_TEAM_ATTACK_PLAN_INVALID");
  }
  if (!normalizedPolicy) blockers.push("RED_TEAM_POLICY_INVALID");
  if (!Array.isArray(receipts)) blockers.push("RED_TEAM_RECEIPTS_ARRAY_REQUIRED");
  if (executionAuthority !== "NONE") blockers.push("RED_TEAM_EXECUTION_AUTHORITY_FORBIDDEN");

  if (blockers.length > 0) {
    return deepFreeze({
      schemaVersion: ALPHA_RED_TEAM_V1,
      artifactType: "ALPHA_RED_TEAM_RESULT",
      status: "BLOCKED_DATA",
      blockers: [...new Set(blockers)].sort(),
      scenarioResults: [],
      nextStage: null,
      ...safety(),
    });
  }

  const candidateId = genome.candidateId;
  const normalized = receipts.map((receipt) => normalizeReceipt(receipt, {
    candidateId,
    genomeDigest: genome.genomeDigest,
    policy: normalizedPolicy,
  }));
  const byScenario = new Map();
  for (const row of normalized) {
    if (!row.scenarioId || byScenario.has(row.scenarioId)) {
      blockers.push(row.scenarioId ? "RED_TEAM_DUPLICATE_SCENARIO" : "RED_TEAM_SCENARIO_ID_MISSING");
      continue;
    }
    byScenario.set(row.scenarioId, row);
  }

  const missing = REQUIRED_ALPHA_RED_TEAM_SCENARIOS.filter((scenarioId) => !byScenario.has(scenarioId));
  if (missing.length > 0) blockers.push("RED_TEAM_REQUIRED_SCENARIOS_MISSING");
  if (normalized.some((row) => !row.contractValid)) blockers.push("RED_TEAM_RECEIPT_CONTRACT_INVALID");

  const orderedResults = REQUIRED_ALPHA_RED_TEAM_SCENARIOS
    .map((scenarioId) => byScenario.get(scenarioId))
    .filter(Boolean);
  const passedCount = orderedResults.filter((row) => row.pass).length;
  const passRatio = REQUIRED_ALPHA_RED_TEAM_SCENARIOS.length === 0
    ? 0
    : passedCount / REQUIRED_ALPHA_RED_TEAM_SCENARIOS.length;
  const baseline = byScenario.get("FULL_COST_BASELINE");
  const mandatoryBaselinePass = baseline?.pass === true;
  const allCostExecutionShocksPass = [
    "COST_MULTIPLIER_2X",
    "SLIPPAGE_MULTIPLIER_3X",
    "ENTRY_DELAY_1_BAR",
    "PARTIAL_FILL",
    "SPREAD_SHOCK",
  ].every((scenarioId) => byScenario.get(scenarioId)?.pass === true);
  const allDataRobustnessPass = [
    "MISSING_DATA",
    "PARAMETER_PERTURBATION",
    "CALIBRATION_DEGRADATION",
  ].every((scenarioId) => byScenario.get(scenarioId)?.pass === true);

  const survived = blockers.length === 0
    && mandatoryBaselinePass
    && allCostExecutionShocksPass
    && allDataRobustnessPass
    && passRatio >= normalizedPolicy.minimumScenarioPassRatio;

  const core = {
    candidateId,
    genomeDigest: genome.genomeDigest,
    policy: normalizedPolicy,
    scenarioResults: orderedResults,
    passRatio,
    mandatoryBaselinePass,
    allCostExecutionShocksPass,
    allDataRobustnessPass,
  };

  return deepFreeze({
    schemaVersion: ALPHA_RED_TEAM_V1,
    artifactType: "ALPHA_RED_TEAM_RESULT",
    status: blockers.length > 0
      ? "BLOCKED_DATA"
      : survived
        ? "RED_TEAM_SURVIVOR_RESEARCH_ONLY"
        : "RED_TEAM_REJECTED",
    blockers: [...new Set(blockers)].sort(),
    candidateId,
    genomeDigest: genome.genomeDigest,
    policy: normalizedPolicy,
    scenarioResults: orderedResults,
    passedCount,
    requiredScenarioCount: REQUIRED_ALPHA_RED_TEAM_SCENARIOS.length,
    passRatio,
    mandatoryBaselinePass,
    allCostExecutionShocksPass,
    allDataRobustnessPass,
    resultDigest: digest(core),
    nextStage: survived ? "MULTI_HORIZON_FORECAST_UNCERTAINTY" : null,
    promotionEligible: false,
    ...safety(),
  });
}
