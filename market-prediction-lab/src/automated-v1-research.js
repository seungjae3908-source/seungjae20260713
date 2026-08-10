import {
  RESEARCH_BACKTEST_PERIOD,
  V1_DEFAULT_PARAMETERS,
  runV1Backtest,
} from "./multi-market-backtest-engine.js";
import {
  buildLeakFreeWalkForward,
  computeWalkForwardStability,
  evaluateMinimumGate,
  generateFineCandidates,
  generateParameterCandidates,
  narrowPromisingCandidates,
  scoreStrategyQuality,
} from "./automated-research-orchestrator.js";

const TIMEFRAME_MS = Object.freeze({
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
});

export const V1_AUTOMATION_PARAMETER_BOUNDS = Object.freeze({
  fastPeriod: Object.freeze({ min: 5, max: 40, coarse: Object.freeze([8, 10, 12, 20, 30, 40]), fineStep: 2 }),
  slowPeriod: Object.freeze({ min: 20, max: 200, coarse: Object.freeze([30, 50, 80, 120, 160, 200]), fineStep: 5 }),
  atrPeriod: Object.freeze({ min: 7, max: 40, coarse: Object.freeze([10, 14, 20, 28, 40]), fineStep: 2 }),
  pullbackTolerancePct: Object.freeze({ min: 0.1, max: 3, coarse: Object.freeze([0.25, 0.5, 0.75, 1, 1.5, 2, 3]), fineStep: 0.25 }),
  stopAtrMultiple: Object.freeze({ min: 0.75, max: 4, coarse: Object.freeze([1, 1.25, 1.5, 2, 2.5, 3, 4]), fineStep: 0.25 }),
  targetRiskMultiple: Object.freeze({ min: 1, max: 5, coarse: Object.freeze([1.5, 2, 2.5, 3, 4, 5]), fineStep: 0.25 }),
});

const SAFETY = Object.freeze({
  branchWrite: false,
  liveOrderAllowed: false,
  privateAccountRequestAllowed: false,
  orderSubmitted: false,
  selectionUsesFinalHoldout: false,
  finalHoldoutRetuningAllowed: false,
});

function validParameters(parameters) {
  return Number.isInteger(parameters.fastPeriod)
    && Number.isInteger(parameters.slowPeriod)
    && Number.isInteger(parameters.atrPeriod)
    && parameters.slowPeriod > parameters.fastPeriod;
}

function compact(result) {
  return Object.freeze({
    totalReturn: result.totalReturnPercent / 100,
    winRate: result.successRatePercent / 100,
    expectancy: result.expectancy,
    costAdjustedExpectancy: result.expectancy,
    profitFactor: result.profitFactor,
    maximumDrawdown: result.maximumDrawdownPercent / 100,
    tradeCount: result.totalTrades,
    averageWin: result.averageWin,
    averageLoss: result.averageLoss,
    maximumConsecutiveLosses: result.maximumConsecutiveLosses,
    sharpe: result.tradeSharpe,
    turnover: result.turnover,
    costImpact: result.totalExecutionCost,
  });
}

function finitePf(value) {
  return value === Number.POSITIVE_INFINITY ? Number.MAX_SAFE_INTEGER : Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function developmentComparator(left, right) {
  const leftPositive = left.metrics.expectancy > 0 && left.metrics.totalReturn > 0 ? 1 : 0;
  const rightPositive = right.metrics.expectancy > 0 && right.metrics.totalReturn > 0 ? 1 : 0;
  return rightPositive - leftPositive
    || finitePf(right.metrics.profitFactor) - finitePf(left.metrics.profitFactor)
    || right.metrics.totalReturn - left.metrics.totalReturn
    || left.metrics.maximumDrawdown - right.metrics.maximumDrawdown
    || right.metrics.tradeCount - left.metrics.tradeCount
    || left.id.localeCompare(right.id);
}

function rankDevelopment(rows) {
  const ordered = [...rows].sort(developmentComparator);
  return Object.freeze(ordered.map((row, index) => Object.freeze({
    ...row,
    developmentScore: ordered.length - index,
  })));
}

function period(startTime, endTime) {
  return Object.freeze({ startTime, endTime, includeFinalHoldout: false });
}

function execute(input, parameters, researchPeriod) {
  const result = runV1Backtest({ ...input, parameters, period: researchPeriod });
  if (result.orderSubmitted !== false || result.privateAccountRequestAllowed !== false || result.safeguards?.liveOrderAllowed !== false) {
    throw new Error("existing V1 engine violated research-only safety contract");
  }
  return result;
}

function candidateId(parameters) {
  return `v1:${Object.entries(parameters).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join(";")}`;
}

function evaluateDevelopment(input, parametersList) {
  return rankDevelopment(parametersList.filter(validParameters).map((parameters) => {
    const result = execute(input, parameters, period(RESEARCH_BACKTEST_PERIOD.startTime, RESEARCH_BACKTEST_PERIOD.developmentEndTime));
    return Object.freeze({ id: candidateId(parameters), parameters, metrics: compact(result) });
  }));
}

function percentileScores(values, { lowerIsBetter = false } = {}) {
  const finiteValues = values.map((value) => value === Number.POSITIVE_INFINITY ? Number.MAX_SAFE_INTEGER : value);
  const ordered = [...finiteValues].sort((a, b) => a - b);
  return finiteValues.map((value) => {
    if (!Number.isFinite(value)) return 0;
    const first = ordered.findIndex((candidate) => candidate >= value);
    const last = ordered.length - 1 - [...ordered].reverse().findIndex((candidate) => candidate <= value);
    const rank = (first + last) / 2;
    const percentile = ordered.length <= 1 ? 100 : rank / (ordered.length - 1) * 100;
    return lowerIsBetter ? 100 - percentile : percentile;
  });
}

function walkForwardDefaults(timeframe, candleCount) {
  const intervalMs = TIMEFRAME_MS[timeframe];
  if (!intervalMs) throw new TypeError(`unsupported automated V1 timeframe: ${timeframe}`);
  const barsPerDay = Math.max(1, Math.round((24 * 60 * 60 * 1000) / intervalMs));
  const trainSize = 365 * barsPerDay;
  const validationSize = 90 * barsPerDay;
  const testSize = 90 * barsPerDay;
  const stepSize = 90 * barsPerDay;
  if (candleCount < trainSize + validationSize + testSize) {
    const unit = Math.max(20, Math.floor(candleCount / 8));
    return Object.freeze({ trainSize: unit * 4, validationSize: unit, testSize: unit, stepSize: unit, embargoMs: intervalMs });
  }
  return Object.freeze({ trainSize, validationSize, testSize, stepSize, embargoMs: intervalMs });
}

function buildWalkForwardWindows(input, options) {
  const intervalMs = TIMEFRAME_MS[input.timeframe];
  const preHoldout = input.candles
    .filter((candle) => candle.timestamp < RESEARCH_BACKTEST_PERIOD.finalHoldoutStartTime)
    .map((candle, index) => Object.freeze({
      id: index,
      anchorTimestamp: candle.timestamp,
      futureEndTimestamp: candle.timestamp + intervalMs,
    }));
  const folds = buildLeakFreeWalkForward(preHoldout, options ?? walkForwardDefaults(input.timeframe, preHoldout.length));
  return folds.map((fold, index) => Object.freeze({
    index,
    startTime: fold.walkForwardTest[0].anchorTimestamp,
    endTime: fold.walkForwardTest.at(-1).anchorTimestamp,
    leakFree: fold.leakFree,
  }));
}

function evaluateWalkForward(input, parameters, windows, maxWalkForwardWindows) {
  const selected = windows.slice(-maxWalkForwardWindows);
  const metrics = selected.map((window) => {
    const result = execute(input, parameters, period(window.startTime, window.endTime));
    const summary = compact(result);
    return Object.freeze({
      window: window.index,
      startTime: window.startTime,
      endTime: window.endTime,
      leakFree: window.leakFree,
      ...summary,
    });
  });
  return Object.freeze({ windows: Object.freeze(metrics), stability: computeWalkForwardStability(metrics) });
}

function degradationComponent(development, oos) {
  if (!(development.totalReturn > 0)) return 0;
  const degradation = Math.max(0, (development.totalReturn - oos.totalReturn) / Math.abs(development.totalReturn));
  return Math.max(0, Math.min(100, (1 - Math.min(1, degradation)) * 100));
}

function applyQualityScores(rows) {
  if (rows.length === 0) return Object.freeze([]);
  const expectancyPercentiles = percentileScores(rows.map((row) => row.oosMetrics.expectancy));
  const pfPercentiles = percentileScores(rows.map((row) => row.oosMetrics.profitFactor));
  const drawdownPercentiles = percentileScores(rows.map((row) => row.oosMetrics.maximumDrawdown), { lowerIsBetter: true });
  const tradePercentiles = percentileScores(rows.map((row) => row.oosMetrics.tradeCount));
  const recentReturnPercentiles = percentileScores(rows.map((row) => row.walkForward.windows.at(-1)?.totalReturn ?? Number.NEGATIVE_INFINITY));
  return Object.freeze(rows.map((row, index) => {
    const profitableWindowsRatio = row.walkForward.stability.profitableWindowsRatio ?? 0;
    const components = {
      oosWalkForwardWinRate: ((row.oosMetrics.winRate * 100) + (profitableWindowsRatio * 100)) / 2,
      costAdjustedExpectancy: expectancyPercentiles[index],
      profitFactor: pfPercentiles[index],
      maximumDrawdown: drawdownPercentiles[index],
      walkForwardStability: row.walkForward.stability.stabilityScore ?? 0,
      recentRegimePerformance: recentReturnPercentiles[index],
      tradeSampleConfidence: tradePercentiles[index],
      developmentToOosDegradation: degradationComponent(row.developmentMetrics, row.oosMetrics),
    };
    const quality = scoreStrategyQuality({ components });
    return Object.freeze({ ...row, qualityScore: quality.qualityScore, qualityComponents: quality.components });
  }));
}

export function runAutomatedV1Research({
  backtestInput,
  parameterBounds = V1_AUTOMATION_PARAMETER_BOUNDS,
  maxCoarseCandidates = 96,
  maxFineCandidates = 96,
  developmentSeeds = 12,
  oosCandidates = 12,
  maxWalkForwardWindows = 8,
  walkForwardOptions,
  minimumGateConfig,
} = {}) {
  if (!backtestInput || typeof backtestInput !== "object") throw new TypeError("backtestInput is required");
  if (!Array.isArray(backtestInput.candles) || backtestInput.candles.length === 0) throw new TypeError("real historical candles are required");
  if (backtestInput.period !== undefined) throw new TypeError("automated research owns the period split; caller period is not allowed");
  if (!Number.isInteger(developmentSeeds) || developmentSeeds <= 0) throw new RangeError("developmentSeeds must be positive");
  if (!Number.isInteger(oosCandidates) || oosCandidates <= 0) throw new RangeError("oosCandidates must be positive");
  if (!Number.isInteger(maxWalkForwardWindows) || maxWalkForwardWindows <= 0) throw new RangeError("maxWalkForwardWindows must be positive");

  const coarse = generateParameterCandidates({
    baseParameters: V1_DEFAULT_PARAMETERS,
    parameterBounds,
    maxCandidates: maxCoarseCandidates,
  }).filter(validParameters);
  const coarseDevelopment = evaluateDevelopment(backtestInput, coarse);
  const seeds = narrowPromisingCandidates(coarseDevelopment, { topFraction: 1, maxSeeds: developmentSeeds });
  const fine = generateFineCandidates({ seeds, parameterBounds, maxCandidates: maxFineCandidates }).filter(validParameters);
  const combinedById = new Map();
  for (const row of [...coarseDevelopment, ...evaluateDevelopment(backtestInput, fine)]) combinedById.set(row.id, row);
  const development = rankDevelopment([...combinedById.values()]);
  const frozenForOos = development.slice(0, oosCandidates);
  const windows = buildWalkForwardWindows(backtestInput, walkForwardOptions);

  const evaluated = frozenForOos.map((candidate) => {
    const oosResult = execute(backtestInput, candidate.parameters, period(RESEARCH_BACKTEST_PERIOD.validationStartTime, RESEARCH_BACKTEST_PERIOD.validationEndTime));
    const oosMetrics = compact(oosResult);
    const walkForward = evaluateWalkForward(backtestInput, candidate.parameters, windows, maxWalkForwardWindows);
    const gate = evaluateMinimumGate({
      oosMetrics,
      walkForwardMetrics: walkForward.stability,
      dataCoverage: backtestInput.dataCoverage ?? { sufficient: false, ratio: null },
      holdoutLeakDetected: false,
      ...(minimumGateConfig ? { config: minimumGateConfig } : {}),
    });
    return Object.freeze({
      id: candidate.id,
      parameters: candidate.parameters,
      developmentMetrics: candidate.metrics,
      oosMetrics,
      walkForward,
      gate,
      researchStatus: gate.status,
    });
  });

  const scored = applyQualityScores(evaluated).sort((left, right) => right.qualityScore - left.qualityScore || left.id.localeCompare(right.id));
  return Object.freeze({
    schemaVersion: 1,
    mode: "automated-v1-research",
    market: backtestInput.market,
    symbol: backtestInput.symbol,
    side: backtestInput.side ?? "long",
    timeframe: backtestInput.timeframe,
    period: Object.freeze({
      developmentStart: RESEARCH_BACKTEST_PERIOD.startTime,
      developmentEnd: RESEARCH_BACKTEST_PERIOD.developmentEndTime,
      oosStart: RESEARCH_BACKTEST_PERIOD.validationStartTime,
      oosEnd: RESEARCH_BACKTEST_PERIOD.validationEndTime,
      finalHoldoutStart: RESEARCH_BACKTEST_PERIOD.finalHoldoutStartTime,
    }),
    candidateCounts: Object.freeze({ coarse: coarse.length, fine: fine.length, development: development.length, oos: scored.length }),
    candidates: Object.freeze(scored),
    finalHoldoutStatus: "locked_pending_frozen_candidate_one_shot",
    ...SAFETY,
  });
}
