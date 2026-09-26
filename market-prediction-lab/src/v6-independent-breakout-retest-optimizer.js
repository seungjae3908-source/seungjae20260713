import { ResearchContractError } from "./research-governance.js";
import { RESEARCH_BACKTEST_PERIOD, runV1Backtest } from "./multi-market-backtest-engine.js";
import { runIndependentSignalBacktest } from "./independent-strategy-backtest.js";

const EPSILON = 1e-9;

export const V6_GRID = Object.freeze({
  structureLookback: Object.freeze([10, 20, 40]),
  breakoutRecencyBars: Object.freeze([1, 3, 5]),
  retestToleranceAtr: Object.freeze([0.25, 0.5]),
  confirmationMode: Object.freeze(["close_reclaim", "directional_body"]),
});

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new ResearchContractError("INVALID_V6_FILTER", `${label} must be a positive integer`, { label, value });
  return value;
}

function finiteNonNegative(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new ResearchContractError("INVALID_V6_FILTER", `${label} must be finite and non-negative`, { label, value });
  return value;
}

function normalizeFilter(filter) {
  if (!filter || typeof filter !== "object") throw new ResearchContractError("INVALID_V6_FILTER", "V6 filter is required");
  const confirmationMode = String(filter.confirmationMode ?? "");
  if (!new Set(["close_reclaim", "directional_body"]).has(confirmationMode)) {
    throw new ResearchContractError("INVALID_V6_FILTER", "confirmationMode must be close_reclaim or directional_body");
  }
  const normalized = Object.freeze({
    structureLookback: positiveInteger(filter.structureLookback, "filter.structureLookback"),
    breakoutRecencyBars: positiveInteger(filter.breakoutRecencyBars, "filter.breakoutRecencyBars"),
    retestToleranceAtr: finiteNonNegative(filter.retestToleranceAtr, "filter.retestToleranceAtr"),
    confirmationMode,
  });
  if (normalized.structureLookback > 250 || normalized.breakoutRecencyBars > 20 || normalized.retestToleranceAtr > 2) {
    throw new ResearchContractError("INVALID_V6_FILTER", "V6 filter exceeds bounded research limits", { filter: normalized });
  }
  return normalized;
}

function stableFilter(filter) {
  return [filter.structureLookback, filter.breakoutRecencyBars, filter.retestToleranceAtr, filter.confirmationMode].join(":");
}

export function buildV6Candidates(grid = V6_GRID) {
  const rows = [];
  for (const structureLookback of grid.structureLookback ?? []) {
    for (const breakoutRecencyBars of grid.breakoutRecencyBars ?? []) {
      for (const retestToleranceAtr of grid.retestToleranceAtr ?? []) {
        for (const confirmationMode of grid.confirmationMode ?? []) {
          rows.push(normalizeFilter({ structureLookback, breakoutRecencyBars, retestToleranceAtr, confirmationMode }));
        }
      }
    }
  }
  const unique = new Map(rows.map((row) => [stableFilter(row), row]));
  if (unique.size === 0 || unique.size > 64) throw new ResearchContractError("INVALID_V6_GRID", "V6 grid must contain 1..64 unique candidates", { count: unique.size });
  return Object.freeze([...unique.values()]);
}

function structureLevel(candles, breakoutIndex, lookback, side) {
  const start = breakoutIndex - lookback;
  if (start < 0) return null;
  const window = candles.slice(start, breakoutIndex);
  if (window.length !== lookback) return null;
  return side === "long"
    ? Math.max(...window.map((candle) => candle.high))
    : Math.min(...window.map((candle) => candle.low));
}

export function calculateV6Signal({ side, candles, atr, index, filter }) {
  const normalizedFilter = normalizeFilter(filter);
  if (!new Set(["long", "short"]).has(side)) throw new ResearchContractError("INVALID_V6_SIDE", "side must be long or short");
  if (!Array.isArray(candles) || !Array.isArray(atr) || !Number.isInteger(index) || index <= 0 || index >= candles.length) return null;
  const atrNow = atr[index];
  if (!Number.isFinite(atrNow) || atrNow <= 0) return null;
  const current = candles[index];
  const previous = candles[index - 1];
  const earliest = Math.max(normalizedFilter.structureLookback, index - normalizedFilter.breakoutRecencyBars);
  for (let breakoutIndex = index - 1; breakoutIndex >= earliest; breakoutIndex -= 1) {
    const level = structureLevel(candles, breakoutIndex, normalizedFilter.structureLookback, side);
    if (!Number.isFinite(level)) continue;
    const breakout = candles[breakoutIndex];
    const breakoutConfirmed = side === "long" ? breakout.close > level : breakout.close < level;
    if (!breakoutConfirmed) continue;
    const tolerance = normalizedFilter.retestToleranceAtr * atrNow;
    const retestTouched = side === "long"
      ? current.low <= level + tolerance + EPSILON && current.low >= level - tolerance - EPSILON && current.close > level
      : current.high >= level - tolerance - EPSILON && current.high <= level + tolerance + EPSILON && current.close < level;
    if (!retestTouched) continue;
    if (normalizedFilter.confirmationMode === "directional_body") {
      const directional = side === "long"
        ? current.close > current.open && current.close >= previous.close
        : current.close < current.open && current.close <= previous.close;
      if (!directional) continue;
    }
    return Object.freeze({
      independentSignal: true,
      structureLevel: level,
      breakoutTimestamp: breakout.timestamp,
      barsSinceBreakout: index - breakoutIndex,
      retestDistanceAtr: side === "long" ? (current.low - level) / atrNow : (level - current.high) / atrNow,
      confirmationMode: normalizedFilter.confirmationMode,
      usesV1EntrySignal: false,
      usesOnlyClosedHistoryThroughSignal: true,
    });
  }
  return null;
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

function developmentPeriod() {
  return Object.freeze({ startTime: RESEARCH_BACKTEST_PERIOD.startTime, endTime: RESEARCH_BACKTEST_PERIOD.developmentEndTime, includeFinalHoldout: false });
}

function validationPeriod() {
  return Object.freeze({ startTime: RESEARCH_BACKTEST_PERIOD.validationStartTime, endTime: RESEARCH_BACKTEST_PERIOD.validationEndTime, includeFinalHoldout: false });
}

function runCandidate(backtestInput, parameters, filter, period) {
  return runIndependentSignalBacktest({
    backtestInput,
    strategy: "v6_independent_breakout_retest",
    strategyVersion: "V6",
    parameters,
    period,
    signalEvaluator: ({ side, candles, atr, index }) => calculateV6Signal({ side, candles, atr, index, filter }),
  });
}

function sampleFloor(baselineTrades, phase) {
  const ratio = phase === "development" ? 0.3 : 0.5;
  return Math.max(phase === "development" ? 6 : 3, Math.ceil(baselineTrades * ratio));
}

function compareDesc(left, right, fields) {
  for (const field of fields) {
    const lv = Number.isFinite(left[field]) ? left[field] : -Infinity;
    const rv = Number.isFinite(right[field]) ? right[field] : -Infinity;
    if (lv !== rv) return rv - lv;
  }
  return 0;
}

function selectDevelopmentLeaders(candidates, baseline) {
  const minimumTrades = sampleFloor(baseline.trades, "development");
  const sampleSafe = candidates.filter((candidate) => candidate.trades >= minimumTrades);
  const returnLeader = [...sampleSafe].sort((a, b) => compareDesc(a, b, ["returnPercent", "successRatePercent", "profitFactor"]) || a.maximumDrawdownPercent - b.maximumDrawdownPercent)[0] ?? null;
  const successLeader = [...sampleSafe].sort((a, b) => compareDesc(a, b, ["successRatePercent", "returnPercent", "profitFactor"]) || a.maximumDrawdownPercent - b.maximumDrawdownPercent)[0] ?? null;
  return Object.freeze({ minimumTrades, returnLeader, successLeader });
}

export function evaluateV6Validation({ baseline, candidate }) {
  const returnDelta = candidate.returnPercent - baseline.returnPercent;
  const successDelta = candidate.successRatePercent - baseline.successRatePercent;
  const minimumTrades = sampleFloor(baseline.trades, "validation");
  const sampleSafe = candidate.trades >= minimumTrades;
  const returnSafe = returnDelta >= -EPSILON;
  const successSafe = successDelta >= -EPSILON;
  const strictImprovement = returnDelta > EPSILON || successDelta > EPSILON;
  const pfSafe = !Number.isFinite(baseline.profitFactor) || !Number.isFinite(candidate.profitFactor) || candidate.profitFactor + EPSILON >= baseline.profitFactor * 0.95;
  const mddLimit = Math.max(baseline.maximumDrawdownPercent * 1.25, baseline.maximumDrawdownPercent + 2);
  const mddSafe = candidate.maximumDrawdownPercent <= mddLimit + EPSILON;
  let verdict = "reject";
  if (returnSafe && successSafe && strictImprovement) {
    if (!sampleSafe) verdict = "sample_review";
    else if (!pfSafe) verdict = "profit_factor_review";
    else if (!mddSafe) verdict = "risk_review";
    else verdict = "adopt_candidate";
  } else if ((returnDelta > EPSILON && successDelta < -EPSILON) || (returnDelta < -EPSILON && successDelta > EPSILON)) {
    verdict = "tradeoff_review";
  }
  return Object.freeze({
    verdict,
    returnDeltaPercentagePoints: returnDelta,
    successRateDeltaPercentagePoints: successDelta,
    maximumDrawdownDeltaPercentagePoints: candidate.maximumDrawdownPercent - baseline.maximumDrawdownPercent,
    profitFactorDelta: Number.isFinite(candidate.profitFactor) && Number.isFinite(baseline.profitFactor) ? candidate.profitFactor - baseline.profitFactor : null,
    tradeCountDelta: candidate.trades - baseline.trades,
    minimumTrades,
    weightedScoreUsed: false,
  });
}

function verdictPriority(verdict) {
  return ({ adopt_candidate: 6, risk_review: 5, profit_factor_review: 4, sample_review: 3, tradeoff_review: 2, reject: 1 })[verdict] ?? 0;
}

function selectPreferred(evaluated) {
  return [...evaluated].sort((a, b) => {
    const priority = verdictPriority(b.comparison.verdict) - verdictPriority(a.comparison.verdict);
    if (priority) return priority;
    const ret = b.validation.returnPercent - a.validation.returnPercent;
    if (Math.abs(ret) > EPSILON) return ret;
    const win = b.validation.successRatePercent - a.validation.successRatePercent;
    if (Math.abs(win) > EPSILON) return win;
    return a.validation.maximumDrawdownPercent - b.validation.maximumDrawdownPercent;
  })[0] ?? null;
}

export function optimizeV6IndependentBreakoutRetest({ backtestInput, v2Optimization, grid } = {}) {
  if (!backtestInput || !v2Optimization) throw new ResearchContractError("INVALID_V6_INPUT", "backtestInput and v2Optimization are required");
  if (v2Optimization.periods?.finalHoldoutUsedForSelection === true) throw new ResearchContractError("V6_TAINTED_V2", "V6 cannot use tainted V2 results");
  if (v2Optimization.status === "v2_candidate_frozen_for_holdout") {
    return Object.freeze({
      schemaVersion: 1,
      strategyCandidate: "V6_INDEPENDENT_BREAKOUT_RETEST",
      market: backtestInput.market,
      symbol: backtestInput.symbol,
      side: backtestInput.side ?? "long",
      status: "v2_frozen_not_retested",
      reason: "V2 already passed independent validation; V6 does not retune frozen BTC candidates.",
      candidateCount: 0,
      preferred: null,
      periods: Object.freeze({ finalHoldoutUsedForSelection: false }),
      liveOrderAllowed: false,
      privateAccountRequestAllowed: false,
    });
  }
  const parameters = v2Optimization.preferred?.parameters;
  if (!parameters) throw new ResearchContractError("MISSING_V6_BASE_PARAMETERS", "V6 needs V2 risk/exit parameters; V1 entry logic is not reused");
  const baselineDevelopment = compact(runV1Backtest({ ...backtestInput, parameters, period: developmentPeriod() }));
  const baselineValidation = compact(runV1Backtest({ ...backtestInput, parameters, period: validationPeriod() }));
  const candidateRows = buildV6Candidates(grid).map((filter) => Object.freeze({ filter, ...compact(runCandidate(backtestInput, parameters, filter, developmentPeriod())) }));
  const leaders = selectDevelopmentLeaders(candidateRows, baselineDevelopment);
  const evaluated = [];
  const seen = new Set();
  for (const [leaderType, leader] of Object.entries({ returnLeader: leaders.returnLeader, successLeader: leaders.successLeader })) {
    if (!leader) continue;
    const key = stableFilter(leader.filter);
    if (seen.has(key)) continue;
    seen.add(key);
    const validation = compact(runCandidate(backtestInput, parameters, leader.filter, validationPeriod()));
    evaluated.push(Object.freeze({
      leaderType,
      filter: leader.filter,
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
      comparison: evaluateV6Validation({ baseline: baselineValidation, candidate: validation }),
    }));
  }
  const preferred = selectPreferred(evaluated);
  return Object.freeze({
    schemaVersion: 1,
    strategyCandidate: "V6_INDEPENDENT_BREAKOUT_RETEST",
    market: backtestInput.market,
    symbol: backtestInput.symbol,
    side: backtestInput.side ?? "long",
    frozenRiskExitParameters: Object.freeze({ atrPeriod: parameters.atrPeriod, stopAtrMultiple: parameters.stopAtrMultiple, targetRiskMultiple: parameters.targetRiskMultiple }),
    objective: Object.freeze({
      primaryMetrics: Object.freeze(["returnPercent", "successRatePercent"]),
      riskMetrics: Object.freeze(["profitFactor", "maximumDrawdownPercent", "trades"]),
      weightedScoreUsed: false,
      developmentSelection: "Only two predeclared development leaders advance: best return and best success rate, both above a sample floor.",
      validationRule: "2025 must avoid return and success-rate regression, preserve PF, respect MDD and sample floors.",
    }),
    periods: Object.freeze({ development: developmentPeriod(), validation: validationPeriod(), finalHoldoutStartTime: RESEARCH_BACKTEST_PERIOD.finalHoldoutStartTime, finalHoldoutUsedForSelection: false }),
    candidateCount: candidateRows.length,
    developmentMinimumTrades: leaders.minimumTrades,
    baseline: Object.freeze({ development: baselineDevelopment, validation: baselineValidation }),
    leaders: Object.freeze(evaluated),
    preferred: preferred ? Object.freeze({ ...preferred }) : null,
    status: preferred?.comparison.verdict === "adopt_candidate" ? "v6_candidate_frozen_for_holdout" : "v6_research_hold",
    safeguards: Object.freeze({
      v1EntrySignalReused: false,
      onlyV2RiskExitParametersFrozen: true,
      finalHoldoutUsedForSelection: false,
      orderSubmitted: false,
      privateAccountRequestAllowed: false,
    }),
    liveOrderAllowed: false,
    privateAccountRequestAllowed: false,
  });
}
