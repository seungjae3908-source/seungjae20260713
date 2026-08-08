import { ResearchContractError } from "./research-governance.js";
import {
  RESEARCH_BACKTEST_PERIOD,
  calculateV1Signal,
  runV1Backtest,
} from "./multi-market-backtest-engine.js";
import { summarizeResearchPerformance } from "./research-validation-layer.js";

export const V3_FILTER_GRID = Object.freeze({
  rvolMin: Object.freeze([0.9, 1.05, 1.2]),
  volumeExpansionMin: Object.freeze([0.9, 1.05, 1.2]),
  trendStrengthMin: Object.freeze([0.25, 0.5, 0.8]),
});

const RVOL_LOOKBACK = 20;
const VOLUME_EXPANSION_LOOKBACK = 5;
const EPSILON = 1e-9;

function mean(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stableFilter(filter) {
  return [filter.rvolMin, filter.volumeExpansionMin, filter.trendStrengthMin].join(":");
}

function finitePositive(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ResearchContractError("INVALID_V3_FILTER", `${label} must be a finite positive number`, { label, value });
  }
  return value;
}

function normalizeFilter(filter) {
  if (!filter || typeof filter !== "object") throw new ResearchContractError("INVALID_V3_FILTER", "V3 filter is required");
  return Object.freeze({
    rvolMin: finitePositive(filter.rvolMin, "filter.rvolMin"),
    volumeExpansionMin: finitePositive(filter.volumeExpansionMin, "filter.volumeExpansionMin"),
    trendStrengthMin: finitePositive(filter.trendStrengthMin, "filter.trendStrengthMin"),
  });
}

export function buildV3FilterCandidates(grid = V3_FILTER_GRID) {
  if (!grid || typeof grid !== "object") throw new ResearchContractError("INVALID_V3_GRID", "V3 filter grid is required");
  const candidates = [];
  for (const rvolMin of grid.rvolMin ?? []) {
    for (const volumeExpansionMin of grid.volumeExpansionMin ?? []) {
      for (const trendStrengthMin of grid.trendStrengthMin ?? []) {
        candidates.push(normalizeFilter({ rvolMin, volumeExpansionMin, trendStrengthMin }));
      }
    }
  }
  const unique = new Map(candidates.map((filter) => [stableFilter(filter), filter]));
  if (unique.size === 0 || unique.size > 64) {
    throw new ResearchContractError("INVALID_V3_GRID", "V3 filter grid must contain between 1 and 64 unique candidates", { candidateCount: unique.size });
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

function buildSignalIndicators(candles, parameters) {
  const closes = candles.map((candle) => candle.close);
  return Object.freeze({
    fast: Object.freeze(emaSeries(closes, parameters.fastPeriod)),
    slow: Object.freeze(emaSeries(closes, parameters.slowPeriod)),
    atr: Object.freeze(atrSeries(candles, parameters.atrPeriod)),
  });
}

export function calculateV3SignalFeatures({ candles, indicators, index }) {
  if (!Array.isArray(candles) || !indicators || !Number.isInteger(index) || index < 0 || index >= candles.length) {
    throw new ResearchContractError("INVALID_V3_FEATURE_INPUT", "candles, indicators and a valid index are required");
  }
  if (index < Math.max(RVOL_LOOKBACK, VOLUME_EXPANSION_LOOKBACK)) return null;
  const currentVolume = candles[index].volume ?? 0;
  const rvolBase = mean(candles.slice(index - RVOL_LOOKBACK, index).map((candle) => candle.volume ?? 0));
  const expansionBase = mean(candles.slice(index - VOLUME_EXPANSION_LOOKBACK, index).map((candle) => candle.volume ?? 0));
  const fast = indicators.fast[index];
  const slow = indicators.slow[index];
  const atr = indicators.atr[index];
  if (![currentVolume, rvolBase, expansionBase, fast, slow, atr].every(Number.isFinite) || rvolBase <= 0 || expansionBase <= 0 || atr <= 0) {
    return null;
  }
  return Object.freeze({
    rvol: currentVolume / rvolBase,
    volumeExpansion: currentVolume / expansionBase,
    trendStrength: Math.abs(fast - slow) / atr,
    usesOnlyClosedHistoryThroughSignal: true,
  });
}

function passesFilter(features, filter) {
  return features !== null
    && features.rvol + EPSILON >= filter.rvolMin
    && features.volumeExpansion + EPSILON >= filter.volumeExpansionMin
    && features.trendStrength + EPSILON >= filter.trendStrengthMin;
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

function cloneTradeAsV3(trade, filter) {
  return Object.freeze({
    ...trade,
    strategy: "v3_ema_atr_volume_trend",
    strategyVersion: "V3",
    entryFilter: filter,
  });
}

function firstIndexAfter(candles, timestamp, startIndex) {
  let index = Math.max(0, startIndex);
  while (index < candles.length && candles[index].timestamp <= timestamp) index += 1;
  return index;
}

export function runV3FilteredBacktest({ backtestInput, parameters, filter, period } = {}) {
  if (!backtestInput || typeof backtestInput !== "object") throw new ResearchContractError("INVALID_V3_INPUT", "backtestInput is required");
  if (!parameters || typeof parameters !== "object") throw new ResearchContractError("INVALID_V3_PARAMETERS", "frozen V2 parameters are required");
  const normalizedFilter = normalizeFilter(filter);
  const normalizedPeriod = period ?? developmentPeriod();
  if (normalizedPeriod.includeFinalHoldout === true || normalizedPeriod.endTime >= RESEARCH_BACKTEST_PERIOD.finalHoldoutStartTime) {
    throw new ResearchContractError("V3_HOLDOUT_LOCKED", "V3 selection cannot use the 2026 final holdout");
  }
  const candles = (backtestInput.candles ?? [])
    .filter((candle) => candle.timestamp <= normalizedPeriod.endTime)
    .sort((left, right) => left.timestamp - right.timestamp);
  if (candles.length === 0) throw new ResearchContractError("INVALID_V3_CANDLES", "V3 requires historical candles");
  const indicators = buildSignalIndicators(candles, parameters);
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
    const baseSignal = calculateV1Signal({
      market: backtestInput.market,
      side: backtestInput.side ?? "long",
      candles,
      indicators,
      index,
      parameters,
    });
    if (!baseSignal) {
      index += 1;
      continue;
    }
    const features = calculateV3SignalFeatures({ candles, indicators, index });
    if (!passesFilter(features, normalizedFilter)) {
      index += 1;
      continue;
    }

    const continuation = runV1Backtest({
      ...backtestInput,
      candles,
      parameters,
      initialCapital: equity,
      period: Object.freeze({
        startTime: candle.timestamp,
        endTime: normalizedPeriod.endTime,
        includeFinalHoldout: false,
      }),
    });
    const trade = continuation.trades[0];
    if (!trade || trade.signalTime !== candle.timestamp) {
      throw new ResearchContractError("V3_ENGINE_DIVERGENCE", "V3 filter signal did not match the reused V1 execution engine", {
        expectedSignalTime: candle.timestamp,
        actualSignalTime: trade?.signalTime ?? null,
      });
    }
    const v3Trade = cloneTradeAsV3(trade, normalizedFilter);
    trades.push(v3Trade);
    equity = v3Trade.equityAfter;
    index = firstIndexAfter(candles, v3Trade.exitTime, index + 1);
  }

  const performance = summarizeResearchPerformance(trades, { initialCapital });
  const metrics = compactPerformance(performance, initialCapital);
  return Object.freeze({
    ok: true,
    mode: "backtest-only",
    strategy: "v3_ema_atr_volume_trend",
    strategyVersion: "V3",
    market: backtestInput.market,
    symbol: backtestInput.symbol,
    side: backtestInput.side ?? "long",
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
      filterUsesClosedSignalAndPastVolumeOnly: true,
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

export function evaluateV3Validation({ baseline, candidate }) {
  if (!baseline || !candidate) throw new ResearchContractError("INVALID_V3_VALIDATION", "baseline and candidate metrics are required");
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
  const rows = evaluated.filter(Boolean);
  if (rows.length === 0) return null;
  return [...rows].sort((left, right) => {
    const priority = verdictPriority(right.comparison.verdict) - verdictPriority(left.comparison.verdict);
    if (priority) return priority;
    const byReturn = right.validation.returnPercent - left.validation.returnPercent;
    if (Math.abs(byReturn) > EPSILON) return byReturn;
    const bySuccess = right.validation.successRatePercent - left.validation.successRatePercent;
    if (Math.abs(bySuccess) > EPSILON) return bySuccess;
    return left.validation.maximumDrawdownPercent - right.validation.maximumDrawdownPercent;
  })[0];
}

export function optimizeV3MarketFilters({ backtestInput, v2Optimization, grid = V3_FILTER_GRID } = {}) {
  if (!backtestInput || typeof backtestInput !== "object") throw new ResearchContractError("INVALID_V3_INPUT", "backtestInput is required");
  if (!v2Optimization || typeof v2Optimization !== "object") throw new ResearchContractError("INVALID_V2_BASELINE", "V2 optimization artifact is required");
  if (v2Optimization.status === "v2_candidate_frozen_for_holdout") {
    return Object.freeze({
      schemaVersion: 1,
      strategyCandidate: "V3_VOLUME_TREND_FILTER",
      market: backtestInput.market,
      symbol: backtestInput.symbol,
      side: backtestInput.side ?? "long",
      status: "v2_frozen_not_retested",
      reason: "V2 already passed independent validation; V3 does not retune a frozen candidate before the final holdout.",
      v2Parameters: v2Optimization.preferred?.parameters ?? null,
      periods: Object.freeze({ finalHoldoutUsedForSelection: false }),
      candidateCount: 0,
      preferred: null,
      liveOrderAllowed: false,
      privateAccountRequestAllowed: false,
    });
  }
  const parameters = v2Optimization.preferred?.parameters;
  if (!parameters) {
    return Object.freeze({
      schemaVersion: 1,
      strategyCandidate: "V3_VOLUME_TREND_FILTER",
      market: backtestInput.market,
      symbol: backtestInput.symbol,
      side: backtestInput.side ?? "long",
      status: "v3_research_hold",
      reason: "V2 produced no preferred parameter set to freeze before V3 filter research.",
      periods: Object.freeze({ finalHoldoutUsedForSelection: false }),
      candidateCount: 0,
      preferred: null,
      liveOrderAllowed: false,
      privateAccountRequestAllowed: false,
    });
  }

  const baselineDevelopment = compact(runV1Backtest({ ...backtestInput, parameters, period: developmentPeriod() }));
  const filters = buildV3FilterCandidates(grid);
  const candidates = filters.map((filter) => candidateRecord(
    filter,
    runV3FilteredBacktest({ backtestInput, parameters, filter, period: developmentPeriod() }),
  ));
  const leaders = selectDevelopmentLeaders(candidates, baselineDevelopment);
  const baselineValidation = compact(runV1Backtest({ ...backtestInput, parameters, period: validationPeriod() }));
  const evaluated = [];
  const seen = new Set();
  for (const [leaderType, leader] of Object.entries({ returnLeader: leaders.returnLeader, successLeader: leaders.successLeader })) {
    if (!leader) continue;
    const key = stableFilter(leader.filter);
    if (seen.has(key)) continue;
    seen.add(key);
    const validationResult = runV3FilteredBacktest({ backtestInput, parameters, filter: leader.filter, period: validationPeriod() });
    const validation = compact(validationResult);
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
      comparison: evaluateV3Validation({ baseline: baselineValidation, candidate: validation }),
    }));
  }
  const preferred = selectPreferred(evaluated);
  return Object.freeze({
    schemaVersion: 1,
    strategyCandidate: "V3_VOLUME_TREND_FILTER",
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
    status: preferred?.comparison.verdict === "adopt_candidate" ? "v3_candidate_frozen_for_holdout" : "v3_research_hold",
    liveOrderAllowed: false,
    privateAccountRequestAllowed: false,
  });
}
