import { ResearchContractError } from "./research-governance.js";
import {
  RESEARCH_BACKTEST_PERIOD,
  calculateV1Signal,
  runV1Backtest,
} from "./multi-market-backtest-engine.js";
import { summarizeResearchPerformance } from "./research-validation-layer.js";

const EPSILON = 1e-9;

export const V5_FILTER_GRID = Object.freeze({
  structureLookback: Object.freeze([20, 40]),
  breakoutRecencyBars: Object.freeze([3, 5, 10]),
  retestToleranceAtr: Object.freeze([0.25, 0.5, 0.75]),
  atrPctMin: Object.freeze([0, 0.02]),
});

function mean(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ResearchContractError("INVALID_V5_FILTER", `${label} must be a positive integer`, { label, value });
  }
  return value;
}

function finiteNonNegative(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ResearchContractError("INVALID_V5_FILTER", `${label} must be a finite non-negative number`, { label, value });
  }
  return value;
}

function normalizeFilter(filter) {
  if (!filter || typeof filter !== "object") throw new ResearchContractError("INVALID_V5_FILTER", "V5 filter is required");
  const normalized = {
    structureLookback: positiveInteger(filter.structureLookback, "filter.structureLookback"),
    breakoutRecencyBars: positiveInteger(filter.breakoutRecencyBars, "filter.breakoutRecencyBars"),
    retestToleranceAtr: finiteNonNegative(filter.retestToleranceAtr, "filter.retestToleranceAtr"),
    atrPctMin: finiteNonNegative(filter.atrPctMin, "filter.atrPctMin"),
  };
  if (normalized.structureLookback < 5 || normalized.structureLookback > 250) {
    throw new ResearchContractError("INVALID_V5_FILTER", "filter.structureLookback must be between 5 and 250");
  }
  if (normalized.breakoutRecencyBars > 50) {
    throw new ResearchContractError("INVALID_V5_FILTER", "filter.breakoutRecencyBars must be <= 50");
  }
  if (normalized.retestToleranceAtr > 3) {
    throw new ResearchContractError("INVALID_V5_FILTER", "filter.retestToleranceAtr must be <= 3");
  }
  if (normalized.atrPctMin > 0.5) {
    throw new ResearchContractError("INVALID_V5_FILTER", "filter.atrPctMin must be <= 0.5");
  }
  return Object.freeze(normalized);
}

function stableFilter(filter) {
  return [
    filter.structureLookback,
    filter.breakoutRecencyBars,
    filter.retestToleranceAtr,
    filter.atrPctMin,
  ].join(":");
}

export function buildV5FilterCandidates(grid = V5_FILTER_GRID) {
  if (!grid || typeof grid !== "object") throw new ResearchContractError("INVALID_V5_GRID", "V5 filter grid is required");
  const candidates = [];
  for (const structureLookback of grid.structureLookback ?? []) {
    for (const breakoutRecencyBars of grid.breakoutRecencyBars ?? []) {
      for (const retestToleranceAtr of grid.retestToleranceAtr ?? []) {
        for (const atrPctMin of grid.atrPctMin ?? []) {
          candidates.push(normalizeFilter({ structureLookback, breakoutRecencyBars, retestToleranceAtr, atrPctMin }));
        }
      }
    }
  }
  const unique = new Map(candidates.map((filter) => [stableFilter(filter), filter]));
  if (unique.size === 0 || unique.size > 64) {
    throw new ResearchContractError("INVALID_V5_GRID", "V5 filter grid must contain between 1 and 64 unique candidates", { candidateCount: unique.size });
  }
  return Object.freeze([...unique.values()]);
}

function emaSeries(values, period) {
  const result = new Array(values.length).fill(null);
  if (values.length < period) return result;
  const multiplier = 2 / (period + 1);
  let current = mean(values.slice(0, period));
  result[period - 1] = current;
  for (let index = period; index < values.length; index += 1) {
    current = (values[index] - current) * multiplier + current;
    result[index] = current;
  }
  return result;
}

function atrSeries(candles, period) {
  const result = new Array(candles.length).fill(null);
  if (candles.length <= period) return result;
  const trueRanges = new Array(candles.length).fill(null);
  for (let index = 1; index < candles.length; index += 1) {
    const candle = candles[index];
    const previousClose = candles[index - 1].close;
    trueRanges[index] = Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
    if (index >= period) {
      const window = trueRanges.slice(index - period + 1, index + 1);
      if (window.every(Number.isFinite)) result[index] = mean(window);
    }
  }
  return result;
}

function buildIndicators(candles, parameters) {
  const closes = candles.map((candle) => candle.close);
  return Object.freeze({
    fast: Object.freeze(emaSeries(closes, parameters.fastPeriod)),
    slow: Object.freeze(emaSeries(closes, parameters.slowPeriod)),
    atr: Object.freeze(atrSeries(candles, parameters.atrPeriod)),
  });
}

function structureLevel(candles, breakoutIndex, lookback, side) {
  const start = breakoutIndex - lookback;
  if (start < 0) return null;
  const window = candles.slice(start, breakoutIndex);
  if (window.length !== lookback) return null;
  if (side === "long") return Math.max(...window.map((candle) => candle.high));
  return Math.min(...window.map((candle) => candle.low));
}

export function calculateV5SignalFeatures({ side, candles, indicators, index, filter }) {
  if (!new Set(["long", "short"]).has(side)) throw new ResearchContractError("INVALID_V5_SIDE", "side must be long or short");
  if (!Array.isArray(candles) || !indicators || !Number.isInteger(index) || index < 0 || index >= candles.length) {
    throw new ResearchContractError("INVALID_V5_FEATURE_INPUT", "candles, indicators and a valid index are required");
  }
  const normalizedFilter = normalizeFilter(filter);
  const atrNow = indicators.atr[index];
  const current = candles[index];
  if (!Number.isFinite(atrNow) || atrNow <= 0 || !Number.isFinite(current?.close) || current.close <= 0) return null;
  const atrPct = atrNow / current.close;
  if (atrPct + EPSILON < normalizedFilter.atrPctMin) return null;

  const earliestBreakout = Math.max(
    normalizedFilter.structureLookback,
    index - normalizedFilter.breakoutRecencyBars,
  );
  for (let breakoutIndex = index - 1; breakoutIndex >= earliestBreakout; breakoutIndex -= 1) {
    const level = structureLevel(candles, breakoutIndex, normalizedFilter.structureLookback, side);
    if (!Number.isFinite(level)) continue;
    const breakout = candles[breakoutIndex];
    const breakoutConfirmed = side === "long" ? breakout.close > level : breakout.close < level;
    if (!breakoutConfirmed) continue;

    const tolerance = normalizedFilter.retestToleranceAtr * atrNow;
    const remainedBeyondLevel = candles
      .slice(breakoutIndex + 1, index + 1)
      .every((candle) => side === "long" ? candle.close + EPSILON >= level : candle.close - EPSILON <= level);
    if (!remainedBeyondLevel) continue;

    const retestTouched = side === "long"
      ? current.low <= level + tolerance + EPSILON && current.close + EPSILON >= level
      : current.high >= level - tolerance - EPSILON && current.close - EPSILON <= level;
    if (!retestTouched) continue;

    return Object.freeze({
      structureConfirmed: true,
      structureLevel: level,
      breakoutIndex,
      breakoutTimestamp: breakout.timestamp,
      barsSinceBreakout: index - breakoutIndex,
      retestDistanceAtr: side === "long"
        ? Math.max(0, current.low - level) / atrNow
        : Math.max(0, level - current.high) / atrNow,
      atrPct,
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

function compactPerformance(performance, initialCapital) {
  const overall = performance.overall;
  return Object.freeze({
    returnPercent: overall.totalReturn * 100,
    successRatePercent: overall.winRate * 100,
    profitFactor: overall.profitFactor,
    maximumDrawdownPercent: overall.maximumDrawdownPercent * 100,
    expectancy: overall.expectancy,
    trades: overall.sampleCount,
    finalCapital: initialCapital + overall.netPnl,
  });
}

function developmentPeriod() {
  return Object.freeze({ startTime: RESEARCH_BACKTEST_PERIOD.startTime, endTime: RESEARCH_BACKTEST_PERIOD.developmentEndTime, includeFinalHoldout: false });
}

function validationPeriod() {
  return Object.freeze({ startTime: RESEARCH_BACKTEST_PERIOD.validationStartTime, endTime: RESEARCH_BACKTEST_PERIOD.validationEndTime, includeFinalHoldout: false });
}

function cloneTradeAsV5(trade, filter, structure) {
  return Object.freeze({
    ...trade,
    strategy: "v5_ema_atr_structure_retest",
    strategyVersion: "V5",
    entryFilter: filter,
    structureContext: structure,
  });
}

function firstIndexAfter(candles, timestamp, startIndex) {
  let index = Math.max(0, startIndex);
  while (index < candles.length && candles[index].timestamp <= timestamp) index += 1;
  return index;
}

export function runV5FilteredBacktest({ backtestInput, parameters, filter, period } = {}) {
  if (!backtestInput || typeof backtestInput !== "object") throw new ResearchContractError("INVALID_V5_INPUT", "backtestInput is required");
  if (!parameters || typeof parameters !== "object") throw new ResearchContractError("INVALID_V5_PARAMETERS", "frozen V2 parameters are required");
  const normalizedFilter = normalizeFilter(filter);
  const normalizedPeriod = period ?? developmentPeriod();
  if (normalizedPeriod.includeFinalHoldout === true || normalizedPeriod.endTime >= RESEARCH_BACKTEST_PERIOD.finalHoldoutStartTime) {
    throw new ResearchContractError("V5_HOLDOUT_LOCKED", "V5 selection cannot use the 2026 final holdout");
  }
  const candles = [...(backtestInput.candles ?? [])]
    .filter((candle) => candle.timestamp <= normalizedPeriod.endTime)
    .sort((left, right) => left.timestamp - right.timestamp);
  if (candles.length === 0) throw new ResearchContractError("INVALID_V5_CANDLES", "V5 requires historical candles");
  const indicators = buildIndicators(candles, parameters);
  const side = backtestInput.side ?? "long";
  const initialCapital = backtestInput.initialCapital ?? RESEARCH_BACKTEST_PERIOD.initialCapital;
  const trades = [];
  let equity = initialCapital;
  let index = 1;

  while (index < candles.length - 1 && equity > 0) {
    const candle = candles[index];
    if (candle.timestamp < normalizedPeriod.startTime) {
      index += 1;
      continue;
    }
    const baseSignal = calculateV1Signal({ market: backtestInput.market, side, candles, indicators, index, parameters });
    if (!baseSignal) {
      index += 1;
      continue;
    }
    const structure = calculateV5SignalFeatures({ side, candles, indicators, index, filter: normalizedFilter });
    if (!structure?.structureConfirmed) {
      index += 1;
      continue;
    }
    const continuation = runV1Backtest({
      ...backtestInput,
      candles,
      parameters,
      initialCapital: equity,
      period: Object.freeze({ startTime: candle.timestamp, endTime: normalizedPeriod.endTime, includeFinalHoldout: false }),
    });
    const trade = continuation.trades[0];
    if (!trade || trade.signalTime !== candle.timestamp) {
      throw new ResearchContractError("V5_ENGINE_DIVERGENCE", "V5 structure signal did not match the reused V1 execution engine", {
        expectedSignalTime: candle.timestamp,
        actualSignalTime: trade?.signalTime ?? null,
      });
    }
    const v5Trade = cloneTradeAsV5(trade, normalizedFilter, structure);
    trades.push(v5Trade);
    equity = v5Trade.equityAfter;
    index = firstIndexAfter(candles, v5Trade.exitTime, index + 1);
  }

  const performance = summarizeResearchPerformance(trades, { initialCapital });
  const metrics = compactPerformance(performance, initialCapital);
  return Object.freeze({
    ok: true,
    mode: "backtest-only",
    strategy: "v5_ema_atr_structure_retest",
    strategyVersion: "V5",
    market: backtestInput.market,
    symbol: backtestInput.symbol,
    side,
    timeframe: backtestInput.timeframe,
    parameters: Object.freeze({ ...parameters }),
    filter: normalizedFilter,
    period: Object.freeze({ ...normalizedPeriod, finalHoldoutLocked: true }),
    initialCapital,
    finalCapital: metrics.finalCapital,
    totalReturnPercent: metrics.returnPercent,
    successRatePercent: metrics.successRatePercent,
    profitFactor: metrics.profitFactor,
    maximumDrawdownPercent: metrics.maximumDrawdownPercent,
    expectancy: metrics.expectancy,
    totalTrades: metrics.trades,
    trades: Object.freeze(trades),
    performance,
    safeguards: Object.freeze({
      baseSignalReusesV1Logic: true,
      executionReusesV1Engine: true,
      structureUsesPriorClosedHighLowOnly: true,
      retestUsesSignalCandleAndPastOnly: true,
      volatilityUsesSignalAtrOnly: true,
      finalHoldoutUsedForSelection: false,
      orderSubmitted: false,
      privateAccountRequestAllowed: false,
    }),
  });
}

function candidateRecord(filter, result) {
  return Object.freeze({ filter, ...compact(result) });
}

function compareDesc(left, right, fields) {
  for (const field of fields) {
    const leftValue = Number.isFinite(left[field]) ? left[field] : -Infinity;
    const rightValue = Number.isFinite(right[field]) ? right[field] : -Infinity;
    if (leftValue !== rightValue) return rightValue - leftValue;
  }
  return 0;
}

function sampleFloor(baselineTrades) {
  return Math.max(4, Math.ceil(baselineTrades * 0.5));
}

function selectDevelopmentLeaders(candidates, baseline) {
  const minimumTrades = sampleFloor(baseline.trades);
  const sampleSafe = candidates.filter((candidate) => candidate.trades >= minimumTrades);
  const returnPool = sampleSafe.filter((candidate) => candidate.successRatePercent + EPSILON >= baseline.successRatePercent);
  const successPool = sampleSafe.filter((candidate) => candidate.returnPercent + EPSILON >= baseline.returnPercent);
  const returnLeader = [...returnPool].sort((left, right) => {
    const primary = compareDesc(left, right, ["returnPercent", "successRatePercent", "profitFactor"]);
    return primary || left.maximumDrawdownPercent - right.maximumDrawdownPercent || stableFilter(left.filter).localeCompare(stableFilter(right.filter));
  })[0] ?? null;
  const successLeader = [...successPool].sort((left, right) => {
    const primary = compareDesc(left, right, ["successRatePercent", "returnPercent", "profitFactor"]);
    return primary || left.maximumDrawdownPercent - right.maximumDrawdownPercent || stableFilter(left.filter).localeCompare(stableFilter(right.filter));
  })[0] ?? null;
  return Object.freeze({ minimumTrades, returnLeader, successLeader });
}

export function evaluateV5Validation({ baseline, candidate }) {
  if (!baseline || !candidate) throw new ResearchContractError("INVALID_V5_VALIDATION", "baseline and candidate metrics are required");
  const returnDelta = candidate.returnPercent - baseline.returnPercent;
  const successDelta = candidate.successRatePercent - baseline.successRatePercent;
  const returnNonRegression = returnDelta >= -EPSILON;
  const successNonRegression = successDelta >= -EPSILON;
  const strictImprovement = returnDelta > EPSILON || successDelta > EPSILON;
  const riskLimit = Math.max(baseline.maximumDrawdownPercent * 1.25, baseline.maximumDrawdownPercent + 2);
  const minimumTrades = sampleFloor(baseline.trades);
  const sampleSafe = candidate.trades >= minimumTrades;
  const profitFactorSafe = !Number.isFinite(baseline.profitFactor)
    || !Number.isFinite(candidate.profitFactor)
    || candidate.profitFactor + EPSILON >= baseline.profitFactor * 0.95;
  const drawdownSafe = candidate.maximumDrawdownPercent <= riskLimit + EPSILON;
  let verdict = "reject";
  if (returnNonRegression && successNonRegression && strictImprovement) {
    if (!sampleSafe) verdict = "sample_review";
    else if (!profitFactorSafe) verdict = "profit_factor_review";
    else if (!drawdownSafe) verdict = "risk_review";
    else verdict = "adopt_candidate";
  } else if ((returnDelta > EPSILON && successDelta < -EPSILON) || (returnDelta < -EPSILON && successDelta > EPSILON)) {
    verdict = "tradeoff_review";
  }
  return Object.freeze({
    verdict,
    returnDeltaPercentagePoints: returnDelta,
    successRateDeltaPercentagePoints: successDelta,
    profitFactorDelta: Number.isFinite(candidate.profitFactor) && Number.isFinite(baseline.profitFactor)
      ? candidate.profitFactor - baseline.profitFactor
      : null,
    maximumDrawdownDeltaPercentagePoints: candidate.maximumDrawdownPercent - baseline.maximumDrawdownPercent,
    tradeCountDelta: candidate.trades - baseline.trades,
    minimumTrades,
    weightedScoreUsed: false,
  });
}

function verdictPriority(verdict) {
  return ({ adopt_candidate: 6, risk_review: 5, profit_factor_review: 4, sample_review: 3, tradeoff_review: 2, reject: 1 })[verdict] ?? 0;
}

function selectPreferred(evaluated) {
  const candidates = evaluated.filter(Boolean);
  if (candidates.length === 0) return null;
  return [...candidates].sort((left, right) => {
    const priority = verdictPriority(right.comparison.verdict) - verdictPriority(left.comparison.verdict);
    if (priority) return priority;
    const returnDifference = right.validation.returnPercent - left.validation.returnPercent;
    if (Math.abs(returnDifference) > EPSILON) return returnDifference;
    const successDifference = right.validation.successRatePercent - left.validation.successRatePercent;
    if (Math.abs(successDifference) > EPSILON) return successDifference;
    return left.validation.maximumDrawdownPercent - right.validation.maximumDrawdownPercent;
  })[0];
}

export function optimizeV5PriceStructure({ backtestInput, v2Optimization, grid } = {}) {
  if (!backtestInput || typeof backtestInput !== "object") throw new ResearchContractError("INVALID_V5_INPUT", "backtestInput is required");
  if (!v2Optimization || typeof v2Optimization !== "object") throw new ResearchContractError("INVALID_V5_V2", "v2Optimization is required");
  if (v2Optimization.periods?.finalHoldoutUsedForSelection === true) {
    throw new ResearchContractError("V5_TAINTED_V2", "V5 cannot build on a V2 result that used final holdout data");
  }
  if (v2Optimization.status === "v2_candidate_frozen_for_holdout") {
    return Object.freeze({
      schemaVersion: 1,
      strategyCandidate: "V5_PRICE_STRUCTURE_RETEST",
      market: backtestInput.market,
      symbol: backtestInput.symbol,
      side: backtestInput.side ?? "long",
      status: "v2_frozen_not_retested",
      reason: "V2 already passed independent validation; V5 does not retune a frozen BTC candidate before the final holdout.",
      v2Parameters: v2Optimization.preferred?.parameters ?? null,
      periods: Object.freeze({ finalHoldoutUsedForSelection: false }),
      candidateCount: 0,
      preferred: null,
      liveOrderAllowed: false,
      privateAccountRequestAllowed: false,
    });
  }

  const parameters = v2Optimization.preferred?.parameters;
  if (!parameters) throw new ResearchContractError("MISSING_V5_BASE_PARAMETERS", "V5 requires the preferred V2 parameters as the frozen baseline");
  const baselineDevelopment = compact(runV1Backtest({ ...backtestInput, parameters, period: developmentPeriod() }));
  const baselineValidation = compact(runV1Backtest({ ...backtestInput, parameters, period: validationPeriod() }));
  const candidates = buildV5FilterCandidates(grid).map((filter) => candidateRecord(
    filter,
    runV5FilteredBacktest({ backtestInput, parameters, filter, period: developmentPeriod() }),
  ));
  const leaders = selectDevelopmentLeaders(candidates, baselineDevelopment);
  const evaluated = [];
  const seen = new Set();
  for (const [leaderType, leader] of Object.entries({ returnLeader: leaders.returnLeader, successLeader: leaders.successLeader })) {
    if (!leader) continue;
    const key = stableFilter(leader.filter);
    if (seen.has(key)) continue;
    seen.add(key);
    const validation = compact(runV5FilteredBacktest({ backtestInput, parameters, filter: leader.filter, period: validationPeriod() }));
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
      comparison: evaluateV5Validation({ baseline: baselineValidation, candidate: validation }),
    }));
  }
  const preferred = selectPreferred(evaluated);
  return Object.freeze({
    schemaVersion: 1,
    strategyCandidate: "V5_PRICE_STRUCTURE_RETEST",
    market: backtestInput.market,
    symbol: backtestInput.symbol,
    side: backtestInput.side ?? "long",
    frozenV2Parameters: Object.freeze({ ...parameters }),
    objective: Object.freeze({
      primaryMetrics: Object.freeze(["returnPercent", "successRatePercent"]),
      riskMetrics: Object.freeze(["profitFactor", "maximumDrawdownPercent", "trades"]),
      weightedScoreUsed: false,
      developmentSelection: "return leader requires success non-regression; success leader requires return non-regression; both require a sample floor",
      validationRule: "2025 candidate must avoid return and success-rate regression, preserve PF within 5%, respect MDD limit and sample floor",
    }),
    periods: Object.freeze({
      development: developmentPeriod(),
      validation: validationPeriod(),
      finalHoldoutStartTime: RESEARCH_BACKTEST_PERIOD.finalHoldoutStartTime,
      finalHoldoutUsedForSelection: false,
    }),
    candidateCount: candidates.length,
    developmentMinimumTrades: leaders.minimumTrades,
    baseline: Object.freeze({ development: baselineDevelopment, validation: baselineValidation }),
    leaders: Object.freeze(evaluated),
    preferred: preferred ? Object.freeze({ ...preferred }) : null,
    status: preferred?.comparison.verdict === "adopt_candidate" ? "v5_candidate_frozen_for_holdout" : "v5_research_hold",
    liveOrderAllowed: false,
    privateAccountRequestAllowed: false,
  });
}
