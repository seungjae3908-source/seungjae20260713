import crypto from "node:crypto";

import { ALPHA_RED_TEAM_V1 } from "./alpha-red-team-v1.js";

export const MULTI_HORIZON_FORECAST_UNCERTAINTY_V1 =
  "multi-horizon-forecast-uncertainty-v1";

export const CANONICAL_FORECAST_HORIZONS = Object.freeze([
  "5m",
  "15m",
  "1h",
  "4h",
  "1d",
]);

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

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function safety() {
  return {
    researchOnly: true,
    forecastAuthority: "RESEARCH_FORECAST_ONLY",
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

function normalizePolicy(policy) {
  const requiredHorizons = Array.isArray(policy?.requiredHorizons)
    ? [...new Set(policy.requiredHorizons.map(text).filter(Boolean))]
    : null;
  const minimumIndependentModelGroups = policy?.minimumIndependentModelGroups;
  const minimumSampleSize = policy?.minimumSampleSize;
  const maximumCalibrationError = finite(policy?.maximumCalibrationError);
  const maximumBrierScore = finite(policy?.maximumBrierScore);
  const maximumUncertaintyWidth = finite(policy?.maximumUncertaintyWidth);
  const minimumAbsoluteExpectedReturn = finite(policy?.minimumAbsoluteExpectedReturn);
  const maximumCrossModelExpectedReturnDispersion =
    finite(policy?.maximumCrossModelExpectedReturnDispersion);

  if (!requiredHorizons || requiredHorizons.length === 0
      || requiredHorizons.some((horizon) => !CANONICAL_FORECAST_HORIZONS.includes(horizon))
      || !Number.isSafeInteger(minimumIndependentModelGroups)
      || minimumIndependentModelGroups < 2
      || !Number.isSafeInteger(minimumSampleSize) || minimumSampleSize < 1
      || maximumCalibrationError == null || maximumCalibrationError < 0
      || maximumBrierScore == null || maximumBrierScore < 0 || maximumBrierScore > 1
      || maximumUncertaintyWidth == null || maximumUncertaintyWidth <= 0
      || minimumAbsoluteExpectedReturn == null || minimumAbsoluteExpectedReturn < 0
      || maximumCrossModelExpectedReturnDispersion == null
      || maximumCrossModelExpectedReturnDispersion < 0) {
    return null;
  }

  return {
    requiredHorizons,
    minimumIndependentModelGroups,
    minimumSampleSize,
    maximumCalibrationError,
    maximumBrierScore,
    maximumUncertaintyWidth,
    minimumAbsoluteExpectedReturn,
    maximumCrossModelExpectedReturnDispersion,
  };
}

function normalizeForecast(row, context) {
  const horizon = text(row?.horizon);
  const modelId = text(row?.modelId);
  const independenceGroupId = text(row?.independenceGroupId);
  const evidenceId = text(row?.evidenceId);
  const candidateId = text(row?.candidateId);
  const redTeamResultDigest = text(row?.redTeamResultDigest);
  const asOf = text(row?.asOf);
  const parsedAsOf = asOf == null ? NaN : Date.parse(asOf);
  const quantiles = {
    q10: finite(row?.quantiles?.q10),
    q25: finite(row?.quantiles?.q25),
    q50: finite(row?.quantiles?.q50),
    q75: finite(row?.quantiles?.q75),
    q90: finite(row?.quantiles?.q90),
  };
  const expectedReturn = finite(row?.expectedReturn);
  const expectedDrawdown = finite(row?.expectedDrawdown);
  const upProbability = finite(row?.upProbability);
  const downProbability = finite(row?.downProbability);
  const brierScore = finite(row?.brierScore);
  const calibrationError = finite(row?.calibrationError);
  const sampleSize = row?.sampleSize;
  const reasons = [];

  if (!CANONICAL_FORECAST_HORIZONS.includes(horizon)) reasons.push("FORECAST_HORIZON_INVALID");
  if (!modelId) reasons.push("FORECAST_MODEL_ID_REQUIRED");
  if (!independenceGroupId) reasons.push("FORECAST_INDEPENDENCE_GROUP_REQUIRED");
  if (!evidenceId || !/^[a-zA-Z0-9_.:-]{8,240}$/u.test(evidenceId)) {
    reasons.push("FORECAST_EVIDENCE_ID_REQUIRED");
  }
  if (candidateId !== context.candidateId) reasons.push("FORECAST_CANDIDATE_MISMATCH");
  if (redTeamResultDigest !== context.redTeamResultDigest) {
    reasons.push("FORECAST_RED_TEAM_BINDING_MISMATCH");
  }
  if (!Number.isFinite(parsedAsOf)) reasons.push("FORECAST_AS_OF_INVALID");
  if (Object.values(quantiles).some((value) => value == null)) {
    reasons.push("FORECAST_QUANTILES_REQUIRED");
  } else if (!(quantiles.q10 <= quantiles.q25
      && quantiles.q25 <= quantiles.q50
      && quantiles.q50 <= quantiles.q75
      && quantiles.q75 <= quantiles.q90)) {
    reasons.push("FORECAST_QUANTILES_NOT_MONOTONIC");
  }
  if (expectedReturn == null) reasons.push("FORECAST_EXPECTED_RETURN_REQUIRED");
  if (expectedDrawdown == null || expectedDrawdown < 0) reasons.push("FORECAST_DRAWDOWN_INVALID");
  if (upProbability == null || upProbability < 0 || upProbability > 1) {
    reasons.push("FORECAST_UP_PROBABILITY_INVALID");
  }
  if (downProbability == null || downProbability < 0 || downProbability > 1) {
    reasons.push("FORECAST_DOWN_PROBABILITY_INVALID");
  }
  if (upProbability != null && downProbability != null && upProbability + downProbability > 1 + 1e-9) {
    reasons.push("FORECAST_DIRECTION_PROBABILITY_SUM_INVALID");
  }
  if (brierScore == null || brierScore < 0 || brierScore > 1) reasons.push("FORECAST_BRIER_INVALID");
  if (calibrationError == null || calibrationError < 0) reasons.push("FORECAST_CALIBRATION_INVALID");
  if (!Number.isSafeInteger(sampleSize) || sampleSize < 1) reasons.push("FORECAST_SAMPLE_SIZE_INVALID");
  if (row?.prospectiveOrOos !== true) reasons.push("FORECAST_PROSPECTIVE_OR_OOS_REQUIRED");
  if (row?.pointInTimeSafe !== true) reasons.push("FORECAST_POINT_IN_TIME_REQUIRED");
  if (row?.finalHoldoutUsed === true) reasons.push("FORECAST_FINAL_HOLDOUT_FORBIDDEN");
  if (row?.executionAuthority != null && row.executionAuthority !== "NONE") {
    reasons.push("FORECAST_EXECUTION_AUTHORITY_FORBIDDEN");
  }

  return deepFreeze({
    horizon: horizon ?? null,
    modelId: modelId ?? null,
    independenceGroupId: independenceGroupId ?? null,
    evidenceId: evidenceId ?? null,
    candidateId: candidateId ?? null,
    redTeamResultDigest: redTeamResultDigest ?? null,
    asOf: Number.isFinite(parsedAsOf) ? new Date(parsedAsOf).toISOString() : null,
    quantiles,
    expectedReturn,
    expectedDrawdown,
    upProbability,
    downProbability,
    brierScore,
    calibrationError,
    sampleSize: Number.isSafeInteger(sampleSize) ? sampleSize : null,
    prospectiveOrOos: row?.prospectiveOrOos === true,
    pointInTimeSafe: row?.pointInTimeSafe === true,
    contractValid: reasons.length === 0,
    reasons: [...new Set(reasons)].sort(),
  });
}

function summarizeHorizon(horizon, rows, policy) {
  const reasons = [];
  const groupIds = rows.map((row) => row.independenceGroupId);
  if (new Set(groupIds).size !== groupIds.length) {
    reasons.push("FORECAST_DUPLICATE_INDEPENDENCE_GROUP");
  }
  if (new Set(groupIds).size < policy.minimumIndependentModelGroups) {
    reasons.push("FORECAST_INDEPENDENT_MODELS_INSUFFICIENT");
  }
  if (rows.some((row) => !row.contractValid)) reasons.push("FORECAST_MODEL_RECEIPT_INVALID");
  if (rows.some((row) => row.sampleSize < policy.minimumSampleSize)) {
    reasons.push("FORECAST_SAMPLE_BELOW_POLICY");
  }
  if (rows.some((row) => row.calibrationError > policy.maximumCalibrationError)) {
    reasons.push("FORECAST_CALIBRATION_ABOVE_POLICY");
  }
  if (rows.some((row) => row.brierScore > policy.maximumBrierScore)) {
    reasons.push("FORECAST_BRIER_ABOVE_POLICY");
  }

  const q10 = median(rows.map((row) => row.quantiles.q10).filter((value) => value != null));
  const q25 = median(rows.map((row) => row.quantiles.q25).filter((value) => value != null));
  const q50 = median(rows.map((row) => row.quantiles.q50).filter((value) => value != null));
  const q75 = median(rows.map((row) => row.quantiles.q75).filter((value) => value != null));
  const q90 = median(rows.map((row) => row.quantiles.q90).filter((value) => value != null));
  const expectedReturn = median(rows.map((row) => row.expectedReturn).filter((value) => value != null));
  const expectedDrawdown = median(rows.map((row) => row.expectedDrawdown).filter((value) => value != null));
  const upProbability = median(rows.map((row) => row.upProbability).filter((value) => value != null));
  const downProbability = median(rows.map((row) => row.downProbability).filter((value) => value != null));
  const calibrationError = median(rows.map((row) => row.calibrationError).filter((value) => value != null));
  const brierScore = median(rows.map((row) => row.brierScore).filter((value) => value != null));
  const uncertaintyWidth = q90 == null || q10 == null ? null : q90 - q10;

  const expectedReturns = rows.map((row) => row.expectedReturn).filter((value) => value != null);
  const expectedReturnDispersion = expectedReturns.length === 0
    ? null
    : Math.max(...expectedReturns) - Math.min(...expectedReturns);

  if (uncertaintyWidth == null || uncertaintyWidth > policy.maximumUncertaintyWidth) {
    reasons.push("FORECAST_UNCERTAINTY_TOO_WIDE");
  }
  if (expectedReturnDispersion == null
      || expectedReturnDispersion > policy.maximumCrossModelExpectedReturnDispersion) {
    reasons.push("FORECAST_MODEL_DISAGREEMENT_TOO_HIGH");
  }

  const directionalStrength = expectedReturn == null
    ? "UNAVAILABLE"
    : Math.abs(expectedReturn) < policy.minimumAbsoluteExpectedReturn
      ? "ABSTAIN"
      : expectedReturn > 0 ? "POSITIVE" : "NEGATIVE";

  return deepFreeze({
    horizon,
    modelCount: rows.length,
    independentModelGroups: [...new Set(groupIds)].filter(Boolean).sort(),
    distribution: { q10, q25, q50, q75, q90 },
    expectedReturn,
    expectedDrawdown,
    upProbability,
    downProbability,
    calibrationError,
    brierScore,
    uncertaintyWidth,
    expectedReturnDispersion,
    directionalStrength,
    status: reasons.length === 0 ? "HORIZON_FORECAST_READY" : "HORIZON_ABSTAIN",
    reasons: [...new Set(reasons)].sort(),
  });
}

export function buildMultiHorizonForecastUncertaintyV1({
  redTeamResult,
  forecasts = [],
  policy,
  executionAuthority = "NONE",
} = {}) {
  const blockers = [];
  const normalizedPolicy = normalizePolicy(policy);
  if (redTeamResult?.schemaVersion !== ALPHA_RED_TEAM_V1
      || redTeamResult?.artifactType !== "ALPHA_RED_TEAM_RESULT"
      || redTeamResult?.status !== "RED_TEAM_SURVIVOR_RESEARCH_ONLY"
      || redTeamResult?.executionAuthority !== "NONE"
      || !text(redTeamResult?.resultDigest)) {
    blockers.push("FORECAST_RED_TEAM_RESULT_INVALID");
  }
  if (!normalizedPolicy) blockers.push("FORECAST_POLICY_INVALID");
  if (!Array.isArray(forecasts) || forecasts.length === 0) blockers.push("FORECAST_RECEIPTS_REQUIRED");
  if (executionAuthority !== "NONE") blockers.push("FORECAST_EXECUTION_AUTHORITY_FORBIDDEN");

  if (blockers.length > 0) {
    return deepFreeze({
      schemaVersion: MULTI_HORIZON_FORECAST_UNCERTAINTY_V1,
      status: "BLOCKED_DATA",
      blockers: [...new Set(blockers)].sort(),
      horizons: [],
      decision: "BLOCKED",
      nextStage: null,
      ...safety(),
    });
  }

  const normalized = forecasts.map((row) => normalizeForecast(row, {
    candidateId: redTeamResult.candidateId,
    redTeamResultDigest: redTeamResult.resultDigest,
  }));
  if (normalized.some((row) => !row.contractValid)) blockers.push("FORECAST_RECEIPT_CONTRACT_INVALID");

  const byHorizon = new Map();
  for (const row of normalized) {
    if (!byHorizon.has(row.horizon)) byHorizon.set(row.horizon, []);
    byHorizon.get(row.horizon).push(row);
  }
  const missingHorizons = normalizedPolicy.requiredHorizons
    .filter((horizon) => !byHorizon.has(horizon));
  if (missingHorizons.length > 0) blockers.push("FORECAST_REQUIRED_HORIZON_MISSING");

  const horizonSummaries = normalizedPolicy.requiredHorizons
    .map((horizon) => summarizeHorizon(horizon, byHorizon.get(horizon) ?? [], normalizedPolicy));

  const abstainedHorizons = horizonSummaries
    .filter((row) => row.status !== "HORIZON_FORECAST_READY"
      || row.directionalStrength === "ABSTAIN"
      || row.directionalStrength === "UNAVAILABLE")
    .map((row) => row.horizon);

  const directional = horizonSummaries
    .filter((row) => row.status === "HORIZON_FORECAST_READY")
    .map((row) => row.directionalStrength)
    .filter((value) => value === "POSITIVE" || value === "NEGATIVE");
  const hasPositive = directional.includes("POSITIVE");
  const hasNegative = directional.includes("NEGATIVE");
  const crossHorizonConflict = hasPositive && hasNegative;

  const decision = blockers.length > 0
    ? "BLOCKED"
    : abstainedHorizons.length > 0 || crossHorizonConflict
      ? "NO_TRADE"
      : hasPositive
        ? "RESEARCH_LONG_BIAS"
        : hasNegative
          ? "RESEARCH_SHORT_BIAS"
          : "NO_TRADE";

  const core = {
    candidateId: redTeamResult.candidateId,
    redTeamResultDigest: redTeamResult.resultDigest,
    policy: normalizedPolicy,
    horizons: horizonSummaries,
    decision,
    crossHorizonConflict,
  };

  return deepFreeze({
    schemaVersion: MULTI_HORIZON_FORECAST_UNCERTAINTY_V1,
    artifactType: "MULTI_HORIZON_FORECAST",
    status: blockers.length > 0
      ? "BLOCKED_DATA"
      : decision === "NO_TRADE"
        ? "FORECAST_ABSTAINED"
        : "FORECAST_READY_RESEARCH_ONLY",
    blockers: [...new Set(blockers)].sort(),
    candidateId: redTeamResult.candidateId,
    redTeamResultDigest: redTeamResult.resultDigest,
    policy: normalizedPolicy,
    horizons: horizonSummaries,
    abstainedHorizons,
    crossHorizonConflict,
    decision,
    forecastDigest: digest(core),
    uncertaintyCanReduceExposure: true,
    uncertaintyCanIncreaseExposure: false,
    nextStage: blockers.length === 0 ? "COUNTERFACTUAL_TWIN_SWARM" : null,
    ...safety(),
  });
}
