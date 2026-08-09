import { ResearchContractError } from "./research-governance.js";
import {
  RESEARCH_BACKTEST_PERIOD,
  V1_DEFAULT_PARAMETERS,
  runV1Backtest,
} from "./multi-market-backtest-engine.js";

const CASH_MARKETS = new Set(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT"]);

export const V2_MARKET_PARAMETER_GRIDS = Object.freeze({
  KR_STOCK: Object.freeze({
    fastPeriod: Object.freeze([10, 20, 30]),
    slowPeriod: Object.freeze([40, 50, 80]),
    atrPeriod: Object.freeze([14]),
    pullbackTolerancePct: Object.freeze([0.25, 0.5, 1]),
    stopAtrMultiple: Object.freeze([1.25, 1.5, 2]),
    targetRiskMultiple: Object.freeze([1.5, 2, 2.5]),
  }),
  US_STOCK: Object.freeze({
    fastPeriod: Object.freeze([10, 20, 30]),
    slowPeriod: Object.freeze([40, 50, 80]),
    atrPeriod: Object.freeze([14]),
    pullbackTolerancePct: Object.freeze([0.25, 0.5, 1]),
    stopAtrMultiple: Object.freeze([1.25, 1.5, 2]),
    targetRiskMultiple: Object.freeze([1.5, 2, 2.5]),
  }),
  CRYPTO_SPOT: Object.freeze({
    fastPeriod: Object.freeze([10, 20, 30]),
    slowPeriod: Object.freeze([40, 50, 80]),
    atrPeriod: Object.freeze([14]),
    pullbackTolerancePct: Object.freeze([0.25, 0.5, 1]),
    stopAtrMultiple: Object.freeze([1.25, 1.5, 2]),
    targetRiskMultiple: Object.freeze([1.5, 2, 2.5]),
  }),
  CRYPTO_FUTURES: Object.freeze({
    fastPeriod: Object.freeze([8, 12, 20]),
    slowPeriod: Object.freeze([30, 50, 80]),
    atrPeriod: Object.freeze([10, 14]),
    pullbackTolerancePct: Object.freeze([0.25, 0.5, 0.75]),
    stopAtrMultiple: Object.freeze([1, 1.5, 2]),
    targetRiskMultiple: Object.freeze([1.5, 2, 3]),
  }),
});

function stableParameters(parameters) {
  return [
    parameters.fastPeriod,
    parameters.slowPeriod,
    parameters.atrPeriod,
    parameters.pullbackTolerancePct,
    parameters.stopAtrMultiple,
    parameters.targetRiskMultiple,
  ].join(":");
}

export function buildV2ParameterCandidates(market, grid = V2_MARKET_PARAMETER_GRIDS[market]) {
  if (!grid) throw new ResearchContractError("MISSING_V2_GRID", `no V2 parameter grid for ${market}`);
  const candidates = [];
  for (const fastPeriod of grid.fastPeriod) {
    for (const slowPeriod of grid.slowPeriod) {
      if (slowPeriod <= fastPeriod) continue;
      for (const atrPeriod of grid.atrPeriod) {
        for (const pullbackTolerancePct of grid.pullbackTolerancePct) {
          for (const stopAtrMultiple of grid.stopAtrMultiple) {
            for (const targetRiskMultiple of grid.targetRiskMultiple) {
              candidates.push(Object.freeze({
                fastPeriod,
                slowPeriod,
                atrPeriod,
                pullbackTolerancePct,
                stopAtrMultiple,
                targetRiskMultiple,
              }));
            }
          }
        }
      }
    }
  }
  const unique = new Map(candidates.map((parameters) => [stableParameters(parameters), parameters]));
  return Object.freeze([...unique.values()]);
}

function developmentPeriod() {
  return Object.freeze({
    startTime: RESEARCH_BACKTEST_PERIOD.startTime,
    endTime: RESEARCH_BACKTEST_PERIOD.developmentEndTime,
    includeFinalHoldout: false,
  });
}

function validationPeriod() {
  return Object.freeze({
    startTime: RESEARCH_BACKTEST_PERIOD.validationStartTime,
    endTime: RESEARCH_BACKTEST_PERIOD.validationEndTime,
    includeFinalHoldout: false,
  });
}

function preHoldoutPeriod() {
  return Object.freeze({
    startTime: RESEARCH_BACKTEST_PERIOD.startTime,
    endTime: RESEARCH_BACKTEST_PERIOD.validationEndTime,
    includeFinalHoldout: false,
  });
}

function compact(result) {
  return Object.freeze({
    returnPercent: result.totalReturnPercent,
    successRatePercent: result.successRatePercent,
    profitFactor: result.profitFactor,
    maximumDrawdownPercent: result.maximumDrawdownPercent,
    expectancy: result.expectancy,
    trades: result.totalTrades,
    finalCapital: result.finalCapital,
  });
}

function runPeriod(input, parameters, period) {
  return runV1Backtest({ ...input, parameters, period });
}

function compareDesc(left, right, fields) {
  for (const field of fields) {
    const leftValue = Number.isFinite(left[field]) ? left[field] : -Infinity;
    const rightValue = Number.isFinite(right[field]) ? right[field] : -Infinity;
    if (leftValue !== rightValue) return rightValue - leftValue;
  }
  return 0;
}

function candidateRecord(parameters, result) {
  const metrics = compact(result);
  return Object.freeze({ parameters, ...metrics });
}

function selectDevelopmentLeaders(candidates, baseline) {
  const epsilon = 1e-9;
  const nonRegressingSuccess = candidates.filter((candidate) => candidate.successRatePercent + epsilon >= baseline.successRatePercent);
  const nonRegressingReturn = candidates.filter((candidate) => candidate.returnPercent + epsilon >= baseline.returnPercent);

  const returnLeader = [...nonRegressingSuccess].sort((left, right) => {
    const byReturn = compareDesc(left, right, ["returnPercent", "successRatePercent", "profitFactor"]);
    return byReturn || left.maximumDrawdownPercent - right.maximumDrawdownPercent || stableParameters(left.parameters).localeCompare(stableParameters(right.parameters));
  })[0] ?? null;

  const successLeader = [...nonRegressingReturn].sort((left, right) => {
    const bySuccess = compareDesc(left, right, ["successRatePercent", "returnPercent", "profitFactor"]);
    return bySuccess || left.maximumDrawdownPercent - right.maximumDrawdownPercent || stableParameters(left.parameters).localeCompare(stableParameters(right.parameters));
  })[0] ?? null;

  return Object.freeze({ returnLeader, successLeader });
}

function validationVerdict(baseline, candidate) {
  const epsilon = 1e-9;
  const returnDelta = candidate.returnPercent - baseline.returnPercent;
  const successDelta = candidate.successRatePercent - baseline.successRatePercent;
  const returnNonRegression = returnDelta >= -epsilon;
  const successNonRegression = successDelta >= -epsilon;
  const strictImprovement = returnDelta > epsilon || successDelta > epsilon;
  const riskLimit = Math.max(baseline.maximumDrawdownPercent * 1.25, baseline.maximumDrawdownPercent + 2);
  let verdict;
  if (returnNonRegression && successNonRegression && strictImprovement) {
    verdict = candidate.maximumDrawdownPercent <= riskLimit + epsilon ? "adopt_candidate" : "risk_review";
  } else if ((returnDelta > epsilon && successDelta < -epsilon) || (returnDelta < -epsilon && successDelta > epsilon)) {
    verdict = "tradeoff_review";
  } else {
    verdict = "reject";
  }
  return Object.freeze({
    verdict,
    returnDeltaPercentagePoints: returnDelta,
    successRateDeltaPercentagePoints: successDelta,
    maximumDrawdownDeltaPercentagePoints: candidate.maximumDrawdownPercent - baseline.maximumDrawdownPercent,
    weightedScoreUsed: false,
  });
}

function verdictPriority(verdict) {
  return ({ adopt_candidate: 4, risk_review: 3, tradeoff_review: 2, reject: 1 })[verdict] ?? 0;
}

function selectPreferred(evaluated) {
  const candidates = evaluated.filter(Boolean);
  if (candidates.length === 0) return null;
  return [...candidates].sort((left, right) => {
    const priority = verdictPriority(right.comparison.verdict) - verdictPriority(left.comparison.verdict);
    if (priority) return priority;
    const returnNonRegression = right.validation.returnPercent - left.validation.returnPercent;
    if (Math.abs(returnNonRegression) > 1e-9) return returnNonRegression;
    const successNonRegression = right.validation.successRatePercent - left.validation.successRatePercent;
    if (Math.abs(successNonRegression) > 1e-9) return successNonRegression;
    return left.validation.maximumDrawdownPercent - right.validation.maximumDrawdownPercent;
  })[0];
}

export function optimizeV2MarketParameters({ backtestInput, grid } = {}) {
  if (!backtestInput || typeof backtestInput !== "object") throw new ResearchContractError("INVALID_V2_INPUT", "backtestInput is required");
  if (!V2_MARKET_PARAMETER_GRIDS[backtestInput.market] && !grid) {
    throw new ResearchContractError("MISSING_V2_GRID", `unsupported V2 market: ${backtestInput.market}`);
  }
  if (CASH_MARKETS.has(backtestInput.market) && (backtestInput.side ?? "long") !== "long") {
    throw new ResearchContractError("CASH_SHORT_NOT_ALLOWED", `${backtestInput.market} V2 research is long-only`);
  }

  const baselineDevelopmentResult = runPeriod(backtestInput, V1_DEFAULT_PARAMETERS, developmentPeriod());
  const baselineDevelopment = compact(baselineDevelopmentResult);
  const baselineKey = stableParameters(V1_DEFAULT_PARAMETERS);
  const candidates = buildV2ParameterCandidates(backtestInput.market, grid)
    .filter((parameters) => stableParameters(parameters) !== baselineKey)
    .map((parameters) => candidateRecord(parameters, runPeriod(backtestInput, parameters, developmentPeriod())));

  const leaders = selectDevelopmentLeaders(candidates, baselineDevelopment);
  const baselineValidation = compact(runPeriod(backtestInput, V1_DEFAULT_PARAMETERS, validationPeriod()));
  const evaluated = [];
  const seen = new Set();
  for (const [leaderType, leader] of Object.entries(leaders)) {
    if (!leader) continue;
    const key = stableParameters(leader.parameters);
    if (seen.has(key)) continue;
    seen.add(key);
    const validation = compact(runPeriod(backtestInput, leader.parameters, validationPeriod()));
    const fullPreHoldout = compact(runPeriod(backtestInput, leader.parameters, preHoldoutPeriod()));
    evaluated.push(Object.freeze({
      leaderType,
      parameters: leader.parameters,
      development: Object.freeze({
        returnPercent: leader.returnPercent,
        successRatePercent: leader.successRatePercent,
        profitFactor: leader.profitFactor,
        maximumDrawdownPercent: leader.maximumDrawdownPercent,
        expectancy: leader.expectancy,
        trades: leader.trades,
        finalCapital: leader.finalCapital,
      }),
      validation,
      fullPreHoldout,
      comparison: validationVerdict(baselineValidation, validation),
    }));
  }
  const preferred = selectPreferred(evaluated);
  const baselinePreHoldout = compact(runPeriod(backtestInput, V1_DEFAULT_PARAMETERS, preHoldoutPeriod()));

  return Object.freeze({
    schemaVersion: 1,
    strategyCandidate: "V2_MARKET_TUNED_EMA_ATR",
    market: backtestInput.market,
    symbol: backtestInput.symbol,
    side: backtestInput.side ?? "long",
    objective: Object.freeze({
      primaryMetrics: Object.freeze(["returnPercent", "successRatePercent"]),
      weightedScoreUsed: false,
      developmentSelection: "return leader requires success non-regression; success leader requires return non-regression",
      validationRule: "candidate must avoid regression in both return and success rate; excessive MDD triggers risk_review",
    }),
    periods: Object.freeze({
      development: developmentPeriod(),
      validation: validationPeriod(),
      finalHoldoutStartTime: RESEARCH_BACKTEST_PERIOD.finalHoldoutStartTime,
      finalHoldoutUsedForSelection: false,
    }),
    candidateCount: candidates.length,
    baseline: Object.freeze({
      parameters: V1_DEFAULT_PARAMETERS,
      development: baselineDevelopment,
      validation: baselineValidation,
      fullPreHoldout: baselinePreHoldout,
    }),
    leaders: Object.freeze(evaluated),
    preferred: preferred ? Object.freeze({ ...preferred }) : null,
    status: preferred?.comparison.verdict === "adopt_candidate" ? "v2_candidate_frozen_for_holdout" : "v2_research_hold",
    liveOrderAllowed: false,
    privateAccountRequestAllowed: false,
  });
}
