import { ResearchContractError } from "./research-governance.js";
import {
  RESEARCH_BACKTEST_PERIOD,
  calculateV1Signal,
  runV1Backtest,
} from "./multi-market-backtest-engine.js";
import { summarizeResearchPerformance } from "./research-validation-layer.js";

const EPSILON = 1e-9;
const SLOPE_LOOKBACK = 5;
const REGIME_EMA_PERIOD = 200;
const REGIME_SLOPE_LOOKBACK = 10;
const RSI_PERIOD = 14;
const MACD_FAST = 12;
const MACD_SLOW = 26;
const MACD_SIGNAL = 9;

export const V4_FILTER_GRID = Object.freeze({
  requireRegimeAlignment: Object.freeze([false, true]),
  emaSlopeAtrMin: Object.freeze([0, 0.05, 0.1]),
  rsiDirectionalThreshold: Object.freeze([50, 55, 60]),
  macdMode: Object.freeze(["directional", "accelerating"]),
});

function mean(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function finiteNonNegative(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ResearchContractError("INVALID_V4_FILTER", `${label} must be a finite non-negative number`, { label, value });
  }
  return value;
}

function normalizeFilter(filter) {
  if (!filter || typeof filter !== "object") throw new ResearchContractError("INVALID_V4_FILTER", "V4 filter is required");
  if (typeof filter.requireRegimeAlignment !== "boolean") {
    throw new ResearchContractError("INVALID_V4_FILTER", "filter.requireRegimeAlignment must be boolean");
  }
  const rsiDirectionalThreshold = finiteNonNegative(filter.rsiDirectionalThreshold, "filter.rsiDirectionalThreshold");
  if (rsiDirectionalThreshold < 50 || rsiDirectionalThreshold > 80) {
    throw new ResearchContractError("INVALID_V4_FILTER", "filter.rsiDirectionalThreshold must be between 50 and 80");
  }
  const macdMode = String(filter.macdMode ?? "");
  if (!new Set(["directional", "accelerating"]).has(macdMode)) {
    throw new ResearchContractError("INVALID_V4_FILTER", "filter.macdMode must be directional or accelerating");
  }
  return Object.freeze({
    requireRegimeAlignment: filter.requireRegimeAlignment,
    emaSlopeAtrMin: finiteNonNegative(filter.emaSlopeAtrMin, "filter.emaSlopeAtrMin"),
    rsiDirectionalThreshold,
    macdMode,
  });
}

function stableFilter(filter) {
  return [
    filter.requireRegimeAlignment ? 1 : 0,
    filter.emaSlopeAtrMin,
    filter.rsiDirectionalThreshold,
    filter.macdMode,
  ].join(":");
}

export function buildV4FilterCandidates(grid = V4_FILTER_GRID) {
  if (!grid || typeof grid !== "object") throw new ResearchContractError("INVALID_V4_GRID", "V4 filter grid is required");
  const candidates = [];
  for (const requireRegimeAlignment of grid.requireRegimeAlignment ?? []) {
    for (const emaSlopeAtrMin of grid.emaSlopeAtrMin ?? []) {
      for (const rsiDirectionalThreshold of grid.rsiDirectionalThreshold ?? []) {
        for (const macdMode of grid.macdMode ?? []) {
          candidates.push(normalizeFilter({ requireRegimeAlignment, emaSlopeAtrMin, rsiDirectionalThreshold, macdMode }));
        }
      }
    }
  }
  const unique = new Map(candidates.map((filter) => [stableFilter(filter), filter]));
  if (unique.size === 0 || unique.size > 64) {
    throw new ResearchContractError("INVALID_V4_GRID", "V4 filter grid must contain between 1 and 64 unique candidates", { candidateCount: unique.size });
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

function rsiSeries(values, period = RSI_PERIOD) {
  const result = new Array(values.length).fill(null);
  if (values.length <= period) return result;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const delta = values[index] - values[index - 1];
    gains += Math.max(delta, 0);
    losses += Math.max(-delta, 0);
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  const resolve = () => averageLoss === 0 ? (averageGain === 0 ? 50 : 100) : 100 - (100 / (1 + averageGain / averageLoss));
  result[period] = resolve();
  for (let index = period + 1; index < values.length; index += 1) {
    const delta = values[index] - values[index - 1];
    averageGain = ((averageGain * (period - 1)) + Math.max(delta, 0)) / period;
    averageLoss = ((averageLoss * (period - 1)) + Math.max(-delta, 0)) / period;
    result[index] = resolve();
  }
  return result;
}

function macdHistogramSeries(values) {
  const fast = emaSeries(values, MACD_FAST);
  const slow = emaSeries(values, MACD_SLOW);
  const macd = new Array(values.length).fill(null);
  for (let index = MACD_SLOW - 1; index < values.length; index += 1) {
    if (Number.isFinite(fast[index]) && Number.isFinite(slow[index])) macd[index] = fast[index] - slow[index];
  }
  const available = [];
  const indexes = [];
  for (let index = 0; index < macd.length; index += 1) {
    if (Number.isFinite(macd[index])) {
      available.push(macd[index]);
      indexes.push(index);
    }
  }
  const signalCompact = emaSeries(available, MACD_SIGNAL);
  const histogram = new Array(values.length).fill(null);
  for (let compactIndex = 0; compactIndex < indexes.length; compactIndex += 1) {
    const fullIndex = indexes[compactIndex];
    if (Number.isFinite(signalCompact[compactIndex])) histogram[fullIndex] = macd[fullIndex] - signalCompact[compactIndex];
  }
  return histogram;
}

function buildIndicators(candles, parameters) {
  const closes = candles.map((candle) => candle.close);
  return Object.freeze({
    fast: Object.freeze(emaSeries(closes, parameters.fastPeriod)),
    slow: Object.freeze(emaSeries(closes, parameters.slowPeriod)),
    atr: Object.freeze(atrSeries(candles, parameters.atrPeriod)),
    regime: Object.freeze(emaSeries(closes, REGIME_EMA_PERIOD)),
    rsi: Object.freeze(rsiSeries(closes, RSI_PERIOD)),
    macdHistogram: Object.freeze(macdHistogramSeries(closes)),
  });
}

export function calculateV4SignalFeatures({ side, candles, indicators, index }) {
  if (!new Set(["long", "short"]).has(side)) throw new ResearchContractError("INVALID_V4_SIDE", "side must be long or short");
  if (!Array.isArray(candles) || !indicators || !Number.isInteger(index) || index < 0 || index >= candles.length) {
    throw new ResearchContractError("INVALID_V4_FEATURE_INPUT", "candles, indicators and a valid index are required");
  }
  const historyNeeded = Math.max(SLOPE_LOOKBACK, REGIME_SLOPE_LOOKBACK, REGIME_EMA_PERIOD, MACD_SLOW + MACD_SIGNAL);
  if (index < historyNeeded) return null;
  const fastNow = indicators.fast[index];
  const fastPast = indicators.fast[index - SLOPE_LOOKBACK];
  const atrNow = indicators.atr[index];
  const regimeNow = indicators.regime[index];
  const regimePast = indicators.regime[index - REGIME_SLOPE_LOOKBACK];
  const rsiNow = indicators.rsi[index];
  const macdNow = indicators.macdHistogram[index];
  const macdPrevious = indicators.macdHistogram[index - 1];
  const close = candles[index].close;
  if (![fastNow, fastPast, atrNow, regimeNow, regimePast, rsiNow, macdNow, macdPrevious, close].every(Number.isFinite) || atrNow <= 0) return null;
  const direction = side === "long" ? 1 : -1;
  const emaSlopeAtr = direction * (fastNow - fastPast) / (atrNow * SLOPE_LOOKBACK);
  const regimeAligned = side === "long"
    ? close > regimeNow && regimeNow > regimePast
    : close < regimeNow && regimeNow < regimePast;
  const directionalRsi = side === "long" ? rsiNow : 100 - rsiNow;
  const directionalMacd = direction * macdNow;
  const macdAcceleration = direction * (macdNow - macdPrevious);
  return Object.freeze({
    emaSlopeAtr,
    regimeAligned,
    rsi: rsiNow,
    directionalRsi,
    macdHistogram: macdNow,
    directionalMacd,
    macdAcceleration,
    usesOnlyClosedHistoryThroughSignal: true,
  });
}

function passesFilter(features, filter) {
  if (!features) return false;
  if (filter.requireRegimeAlignment && !features.regimeAligned) return false;
  if (features.emaSlopeAtr + EPSILON < filter.emaSlopeAtrMin) return false;
  if (features.directionalRsi + EPSILON < filter.rsiDirectionalThreshold) return false;
  if (features.directionalMacd <= EPSILON) return false;
  if (filter.macdMode === "accelerating" && features.macdAcceleration <= EPSILON) return false;
  return true;
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

function cloneTradeAsV4(trade, filter) {
  return Object.freeze({ ...trade, strategy: "v4_ema_atr_regime_momentum", strategyVersion: "V4", entryFilter: filter });
}

function firstIndexAfter(candles, timestamp, startIndex) {
  let index = Math.max(0, startIndex);
  while (index < candles.length && candles[index].timestamp <= timestamp) index += 1;
  return index;
}

export function runV4FilteredBacktest({ backtestInput, parameters, filter, period } = {}) {
  if (!backtestInput || typeof backtestInput !== "object") throw new ResearchContractError("INVALID_V4_INPUT", "backtestInput is required");
  if (!parameters || typeof parameters !== "object") throw new ResearchContractError("INVALID_V4_PARAMETERS", "frozen V2 parameters are required");
  const normalizedFilter = normalizeFilter(filter);
  const normalizedPeriod = period ?? developmentPeriod();
  if (normalizedPeriod.includeFinalHoldout === true || normalizedPeriod.endTime >= RESEARCH_BACKTEST_PERIOD.finalHoldoutStartTime) {
    throw new ResearchContractError("V4_HOLDOUT_LOCKED", "V4 selection cannot use the 2026 final holdout");
  }
  const candles = [...(backtestInput.candles ?? [])]
    .filter((candle) => candle.timestamp <= normalizedPeriod.endTime)
    .sort((left, right) => left.timestamp - right.timestamp);
  if (candles.length === 0) throw new ResearchContractError("INVALID_V4_CANDLES", "V4 requires historical candles");
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
    const features = calculateV4SignalFeatures({ side, candles, indicators, index });
    if (!passesFilter(features, normalizedFilter)) {
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
      throw new ResearchContractError("V4_ENGINE_DIVERGENCE", "V4 filter signal did not match the reused V1 execution engine", {
        expectedSignalTime: candle.timestamp,
        actualSignalTime: trade?.signalTime ?? null,
      });
    }
    const v4Trade = cloneTradeAsV4(trade, normalizedFilter);
    trades.push(v4Trade);
    equity = v4Trade.equityAfter;
    index = firstIndexAfter(candles, v4Trade.exitTime, index + 1);
  }

  const performance = summarizeResearchPerformance(trades, { initialCapital });
  const metrics = compactPerformance(performance, initialCapital);
  return Object.freeze({
    ok: true,
    mode: "backtest-only",
    strategy: "v4_ema_atr_regime_momentum",
    strategyVersion: "V4",
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
      regimeUsesEma200AndPastSlopeOnly: true,
      momentumUsesClosedRsiAndMacdOnly: true,
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

export function evaluateV4Validation({ baseline, candidate }) {
  if (!baseline || !candidate) throw new ResearchContractError("INVALID_V4_VALIDATION", "baseline and candidate metrics are required");
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

export function optimizeV4MomentumRegime({ backtestInput, v2Optimization, grid } = {}) {
  if (!backtestInput || typeof backtestInput !== "object") throw new ResearchContractError("INVALID_V4_INPUT", "backtestInput is required");
  if (!v2Optimization || typeof v2Optimization !== "object") throw new ResearchContractError("INVALID_V4_V2", "v2Optimization is required");
  if (v2Optimization.periods?.finalHoldoutUsedForSelection === true) {
    throw new ResearchContractError("V4_TAINTED_V2", "V4 cannot build on a V2 result that used final holdout data");
  }
  if (v2Optimization.status === "v2_candidate_frozen_for_holdout") {
    return Object.freeze({
      schemaVersion: 1,
      strategyCandidate: "V4_REGIME_MOMENTUM_FILTER",
      market: backtestInput.market,
      symbol: backtestInput.symbol,
      side: backtestInput.side ?? "long",
      status: "v2_frozen_not_retested",
      reason: "V2 already passed independent validation; V4 does not retune a frozen BTC candidate before the final holdout.",
      v2Parameters: v2Optimization.preferred?.parameters ?? null,
      periods: Object.freeze({ finalHoldoutUsedForSelection: false }),
      candidateCount: 0,
      preferred: null,
      liveOrderAllowed: false,
      privateAccountRequestAllowed: false,
    });
  }
  const parameters = v2Optimization.preferred?.parameters;
  if (!parameters) throw new ResearchContractError("MISSING_V4_BASE_PARAMETERS", "V4 requires the preferred V2 parameters as the frozen baseline");
  const baselineDevelopment = compact(runV1Backtest({ ...backtestInput, parameters, period: developmentPeriod() }));
  const baselineValidation = compact(runV1Backtest({ ...backtestInput, parameters, period: validationPeriod() }));
  const candidates = buildV4FilterCandidates(grid).map((filter) => candidateRecord(
    filter,
    runV4FilteredBacktest({ backtestInput, parameters, filter, period: developmentPeriod() }),
  ));
  const leaders = selectDevelopmentLeaders(candidates, baselineDevelopment);
  const evaluated = [];
  const seen = new Set();
  for (const [leaderType, leader] of Object.entries({ returnLeader: leaders.returnLeader, successLeader: leaders.successLeader })) {
    if (!leader) continue;
    const key = stableFilter(leader.filter);
    if (seen.has(key)) continue;
    seen.add(key);
    const validation = compact(runV4FilteredBacktest({ backtestInput, parameters, filter: leader.filter, period: validationPeriod() }));
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
      comparison: evaluateV4Validation({ baseline: baselineValidation, candidate: validation }),
    }));
  }
  const preferred = selectPreferred(evaluated);
  return Object.freeze({
    schemaVersion: 1,
    strategyCandidate: "V4_REGIME_MOMENTUM_FILTER",
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
    status: preferred?.comparison.verdict === "adopt_candidate" ? "v4_candidate_frozen_for_holdout" : "v4_research_hold",
    liveOrderAllowed: false,
    privateAccountRequestAllowed: false,
  });
}
