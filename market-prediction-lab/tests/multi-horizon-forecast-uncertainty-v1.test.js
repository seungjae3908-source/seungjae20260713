import test from "node:test";
import assert from "node:assert/strict";

import { ALPHA_RED_TEAM_V1 } from "../src/alpha-red-team-v1.js";
import {
  CANONICAL_FORECAST_HORIZONS,
  MULTI_HORIZON_FORECAST_UNCERTAINTY_V1,
  buildMultiHorizonForecastUncertaintyV1,
} from "../src/multi-horizon-forecast-uncertainty-v1.js";

const redTeamResult = Object.freeze({
  schemaVersion: ALPHA_RED_TEAM_V1,
  artifactType: "ALPHA_RED_TEAM_RESULT",
  status: "RED_TEAM_SURVIVOR_RESEARCH_ONLY",
  candidateId: "alpha-forecast-001",
  resultDigest: "f".repeat(64),
  executionAuthority: "NONE",
});

const policy = Object.freeze({
  requiredHorizons: [...CANONICAL_FORECAST_HORIZONS],
  minimumIndependentModelGroups: 2,
  minimumSampleSize: 100,
  maximumCalibrationError: 0.12,
  maximumBrierScore: 0.24,
  maximumUncertaintyWidth: 0.08,
  minimumAbsoluteExpectedReturn: 0.001,
  maximumCrossModelExpectedReturnDispersion: 0.01,
});

function receipt(horizon, model, overrides = {}) {
  return {
    horizon,
    modelId: `model-${model}`,
    independenceGroupId: `group-${model}`,
    evidenceId: `forecast:${horizon}:${model}`,
    candidateId: redTeamResult.candidateId,
    redTeamResultDigest: redTeamResult.resultDigest,
    asOf: "2026-09-20T03:00:00.000Z",
    quantiles: {
      q10: -0.01,
      q25: -0.002,
      q50: 0.004,
      q75: 0.011,
      q90: 0.02,
    },
    expectedReturn: 0.005,
    expectedDrawdown: 0.012,
    upProbability: 0.62,
    downProbability: 0.31,
    brierScore: 0.18,
    calibrationError: 0.06,
    sampleSize: 500,
    prospectiveOrOos: true,
    pointInTimeSafe: true,
    finalHoldoutUsed: false,
    executionAuthority: "NONE",
    ...overrides,
  };
}

function allForecasts(overridesByKey = {}) {
  return CANONICAL_FORECAST_HORIZONS.flatMap((horizon) => [
    receipt(horizon, "price", overridesByKey[`${horizon}:price`] ?? {}),
    receipt(horizon, "orderflow", overridesByKey[`${horizon}:orderflow`] ?? {}),
  ]);
}

test("builds calibrated multi-horizon research forecast from independent model groups", () => {
  const result = buildMultiHorizonForecastUncertaintyV1({
    redTeamResult,
    forecasts: allForecasts(),
    policy,
  });

  assert.equal(result.schemaVersion, MULTI_HORIZON_FORECAST_UNCERTAINTY_V1);
  assert.equal(result.status, "FORECAST_READY_RESEARCH_ONLY");
  assert.equal(result.decision, "RESEARCH_LONG_BIAS");
  assert.equal(result.horizons.length, CANONICAL_FORECAST_HORIZONS.length);
  assert.equal(result.horizons.every((row) => row.modelCount === 2), true);
  assert.equal(result.horizons.every((row) => row.status === "HORIZON_FORECAST_READY"), true);
  assert.equal(result.crossHorizonConflict, false);
  assert.deepEqual(result.abstainedHorizons, []);
  assert.equal(result.uncertaintyCanReduceExposure, true);
  assert.equal(result.uncertaintyCanIncreaseExposure, false);
  assert.equal(result.nextStage, "COUNTERFACTUAL_TWIN_SWARM");
  assert.equal(result.executionAuthority, "NONE");
  assert.equal(result.economicSampleCredit, 0);
  assert.equal(result.profitabilityProven, false);
});

test("abstains when independent models disagree too widely", () => {
  const result = buildMultiHorizonForecastUncertaintyV1({
    redTeamResult,
    forecasts: allForecasts({
      "15m:price": { expectedReturn: 0.012 },
      "15m:orderflow": { expectedReturn: -0.008 },
    }),
    policy,
  });

  assert.equal(result.status, "FORECAST_ABSTAINED");
  assert.equal(result.decision, "NO_TRADE");
  assert.ok(result.abstainedHorizons.includes("15m"));
  const row = result.horizons.find((item) => item.horizon === "15m");
  assert.ok(row.reasons.includes("FORECAST_MODEL_DISAGREEMENT_TOO_HIGH"));
});

test("abstains when the predictive interval is too wide", () => {
  const result = buildMultiHorizonForecastUncertaintyV1({
    redTeamResult,
    forecasts: allForecasts({
      "1h:price": {
        quantiles: { q10: -0.08, q25: -0.03, q50: 0.004, q75: 0.04, q90: 0.09 },
      },
      "1h:orderflow": {
        quantiles: { q10: -0.07, q25: -0.025, q50: 0.004, q75: 0.035, q90: 0.08 },
      },
    }),
    policy,
  });

  assert.equal(result.decision, "NO_TRADE");
  const row = result.horizons.find((item) => item.horizon === "1h");
  assert.equal(row.status, "HORIZON_ABSTAIN");
  assert.ok(row.reasons.includes("FORECAST_UNCERTAINTY_TOO_WIDE"));
});

test("blocks incomplete required horizons rather than extrapolating them", () => {
  const forecasts = allForecasts().filter((row) => row.horizon !== "1d");
  const result = buildMultiHorizonForecastUncertaintyV1({
    redTeamResult,
    forecasts,
    policy,
  });

  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.decision, "BLOCKED");
  assert.ok(result.blockers.includes("FORECAST_REQUIRED_HORIZON_MISSING"));
  assert.equal(result.nextStage, null);
});

test("blocks non-OOS or final-holdout-contaminated forecast evidence", () => {
  const result = buildMultiHorizonForecastUncertaintyV1({
    redTeamResult,
    forecasts: allForecasts({
      "4h:price": { prospectiveOrOos: false },
      "4h:orderflow": { finalHoldoutUsed: true },
    }),
    policy,
  });

  assert.equal(result.status, "BLOCKED_DATA");
  assert.ok(result.blockers.includes("FORECAST_RECEIPT_CONTRACT_INVALID"));
  assert.equal(result.decision, "BLOCKED");
});

test("cross-horizon direction conflict becomes NO_TRADE, never an automatic position flip", () => {
  const result = buildMultiHorizonForecastUncertaintyV1({
    redTeamResult,
    forecasts: allForecasts({
      "4h:price": {
        expectedReturn: -0.006,
        quantiles: { q10: -0.025, q25: -0.015, q50: -0.005, q75: 0.001, q90: 0.008 },
        upProbability: 0.28,
        downProbability: 0.65,
      },
      "4h:orderflow": {
        expectedReturn: -0.005,
        quantiles: { q10: -0.022, q25: -0.013, q50: -0.004, q75: 0.002, q90: 0.009 },
        upProbability: 0.30,
        downProbability: 0.63,
      },
      "1d:price": {
        expectedReturn: -0.007,
        quantiles: { q10: -0.03, q25: -0.018, q50: -0.006, q75: 0.001, q90: 0.01 },
        upProbability: 0.26,
        downProbability: 0.67,
      },
      "1d:orderflow": {
        expectedReturn: -0.006,
        quantiles: { q10: -0.028, q25: -0.017, q50: -0.005, q75: 0.002, q90: 0.011 },
        upProbability: 0.27,
        downProbability: 0.66,
      },
    }),
    policy,
  });

  assert.equal(result.crossHorizonConflict, true);
  assert.equal(result.decision, "NO_TRADE");
  assert.equal(result.status, "FORECAST_ABSTAINED");
  assert.equal(result.executionAuthority, "NONE");
});
