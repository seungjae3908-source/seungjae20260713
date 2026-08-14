import { buildValidationFolds } from "./research-validation-layer.js";

export const AUTOMATED_RESEARCH_GROUPS = Object.freeze([
  Object.freeze({ id: "KR_STOCK_SCALPING", market: "KR_STOCK", strategyType: "SCALPING", direction: "LONG" }),
  Object.freeze({ id: "KR_STOCK_SWING", market: "KR_STOCK", strategyType: "SWING", direction: "LONG" }),
  Object.freeze({ id: "US_STOCK_SCALPING", market: "US_STOCK", strategyType: "SCALPING", direction: "LONG" }),
  Object.freeze({ id: "US_STOCK_SWING", market: "US_STOCK", strategyType: "SWING", direction: "LONG" }),
  Object.freeze({ id: "CRYPTO_SPOT_SCALPING", market: "CRYPTO_SPOT", strategyType: "SCALPING", direction: "LONG" }),
  Object.freeze({ id: "CRYPTO_SPOT_SWING", market: "CRYPTO_SPOT", strategyType: "SWING", direction: "LONG" }),
  Object.freeze({ id: "CRYPTO_FUTURES_SCALPING_LONG", market: "CRYPTO_FUTURES", strategyType: "SCALPING", direction: "LONG" }),
  Object.freeze({ id: "CRYPTO_FUTURES_SCALPING_SHORT", market: "CRYPTO_FUTURES", strategyType: "SCALPING", direction: "SHORT" }),
  Object.freeze({ id: "CRYPTO_FUTURES_SWING_LONG", market: "CRYPTO_FUTURES", strategyType: "SWING", direction: "LONG" }),
  Object.freeze({ id: "CRYPTO_FUTURES_SWING_SHORT", market: "CRYPTO_FUTURES", strategyType: "SWING", direction: "SHORT" }),
]);

export const DEFAULT_QUALITY_WEIGHTS = Object.freeze({
  oosWalkForwardWinRate: 0.20,
  costAdjustedExpectancy: 0.20,
  profitFactor: 0.15,
  maximumDrawdown: 0.15,
  walkForwardStability: 0.10,
  recentRegimePerformance: 0.10,
  tradeSampleConfidence: 0.05,
  developmentToOosDegradation: 0.05,
});

export const DEFAULT_MINIMUM_GATE = Object.freeze({
  requirePositiveExpectancy: true,
  requirePositiveOosReturn: true,
  requirePositiveCostAdjustedExpectancy: true,
  requireLeakFreeHoldout: true,
  requireSufficientCoverage: true,
  minProfitFactor: null,
  maxMaximumDrawdown: null,
  minTradeCount: null,
  minWalkForwardStability: null,
  minCoverageRatio: null,
});

export const DEFAULT_PARAMETER_BOUNDS = Object.freeze({
  emaFast: Object.freeze({ min: 5, max: 50, coarse: Object.freeze([5, 8, 12, 20, 34, 50]), fineStep: 2 }),
  emaSlow: Object.freeze({ min: 20, max: 240, coarse: Object.freeze([20, 34, 50, 80, 120, 160, 200, 240]), fineStep: 5 }),
  rsiThreshold: Object.freeze({ min: 20, max: 80, coarse: Object.freeze([25, 30, 35, 40, 50, 60, 65, 70, 75]), fineStep: 2 }),
  atrPeriod: Object.freeze({ min: 5, max: 50, coarse: Object.freeze([7, 10, 14, 20, 28, 40, 50]), fineStep: 2 }),
  atrStopMultiple: Object.freeze({ min: 0.5, max: 5, coarse: Object.freeze([0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4]), fineStep: 0.25 }),
  targetRiskMultiple: Object.freeze({ min: 0.75, max: 6, coarse: Object.freeze([1, 1.25, 1.5, 2, 2.5, 3, 4, 5]), fineStep: 0.25 }),
  volumeThreshold: Object.freeze({ min: 0, max: 10, coarse: Object.freeze([0.5, 0.75, 1, 1.25, 1.5, 2, 3, 5]), fineStep: 0.25 }),
  rvolThreshold: Object.freeze({ min: 0.5, max: 8, coarse: Object.freeze([0.75, 1, 1.25, 1.5, 2, 3, 4]), fineStep: 0.25 }),
  breakoutLookback: Object.freeze({ min: 3, max: 120, coarse: Object.freeze([5, 10, 20, 30, 50, 80, 120]), fineStep: 5 }),
  pullbackTolerance: Object.freeze({ min: 0.001, max: 0.1, coarse: Object.freeze([0.0025, 0.005, 0.01, 0.02, 0.03, 0.05, 0.08]), fineStep: 0.0025 }),
  momentumThreshold: Object.freeze({ min: -5, max: 5, coarse: Object.freeze([-2, -1, -0.5, 0, 0.5, 1, 2]), fineStep: 0.25 }),
  trendStrength: Object.freeze({ min: 0, max: 100, coarse: Object.freeze([10, 20, 30, 40, 50, 65, 80]), fineStep: 5 }),
});

const SAFETY = Object.freeze({
  branchWrite: false,
  liveOrderAllowed: false,
  privateAccountRequestAllowed: false,
  orderSubmitted: false,
  automaticLivePromotion: false,
});

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function stableKey(parameters) {
  return JSON.stringify(Object.fromEntries(Object.entries(parameters).sort(([a], [b]) => a.localeCompare(b))));
}

function assertWeights(weights) {
  const expected = Object.keys(DEFAULT_QUALITY_WEIGHTS);
  for (const key of expected) {
    if (!Number.isFinite(weights[key]) || weights[key] < 0) throw new TypeError(`invalid quality weight: ${key}`);
  }
  const total = expected.reduce((sum, key) => sum + weights[key], 0);
  if (Math.abs(total - 1) > 1e-9) throw new RangeError(`quality weights must sum to 1; received ${total}`);
}

function normalizeBound(bound, key) {
  if (!bound || !Number.isFinite(bound.min) || !Number.isFinite(bound.max) || bound.min > bound.max) {
    throw new TypeError(`invalid parameter bound: ${key}`);
  }
  const coarse = [...new Set((bound.coarse ?? []).filter(Number.isFinite).map((value) => clamp(value, bound.min, bound.max)))].sort((a, b) => a - b);
  if (coarse.length === 0) coarse.push(bound.min, bound.max);
  return Object.freeze({ min: bound.min, max: bound.max, coarse, fineStep: Number.isFinite(bound.fineStep) && bound.fineStep > 0 ? bound.fineStep : null });
}

function addCandidate(target, seen, value, maxCandidates) {
  if (target.length >= maxCandidates) return;
  const key = stableKey(value);
  if (seen.has(key)) return;
  seen.add(key);
  target.push(Object.freeze({ ...value }));
}

export function generateParameterCandidates({ baseParameters = {}, parameterBounds = DEFAULT_PARAMETER_BOUNDS, maxCandidates = 128 } = {}) {
  if (!Number.isInteger(maxCandidates) || maxCandidates <= 0) throw new RangeError("maxCandidates must be a positive integer");
  const normalized = Object.fromEntries(Object.entries(parameterBounds).map(([key, bound]) => [key, normalizeBound(bound, key)]));
  const base = { ...baseParameters };
  for (const [key, bound] of Object.entries(normalized)) {
    if (!Number.isFinite(base[key])) base[key] = bound.coarse[Math.floor(bound.coarse.length / 2)];
    base[key] = clamp(base[key], bound.min, bound.max);
  }

  const candidates = [];
  const seen = new Set();
  addCandidate(candidates, seen, base, maxCandidates);

  // Coarse search is deliberately axis-wise and pairwise, not a full Cartesian product.
  for (const [key, bound] of Object.entries(normalized)) {
    for (const value of bound.coarse) addCandidate(candidates, seen, { ...base, [key]: value }, maxCandidates);
  }
  const keys = Object.keys(normalized);
  for (let index = 0; index < keys.length - 1 && candidates.length < maxCandidates; index += 1) {
    const first = keys[index];
    const second = keys[index + 1];
    for (const firstValue of normalized[first].coarse) {
      const secondValues = normalized[second].coarse;
      const secondValue = secondValues[Math.floor((firstValue === normalized[first].coarse[0] ? 0.25 : 0.75) * (secondValues.length - 1))];
      addCandidate(candidates, seen, { ...base, [first]: firstValue, [second]: secondValue }, maxCandidates);
    }
  }
  return Object.freeze(candidates);
}

export function narrowPromisingCandidates(results, { topFraction = 0.2, maxSeeds = 16 } = {}) {
  if (!(topFraction > 0 && topFraction <= 1)) throw new RangeError("topFraction must be in (0, 1]");
  if (!Number.isInteger(maxSeeds) || maxSeeds <= 0) throw new RangeError("maxSeeds must be a positive integer");
  const eligible = (results ?? []).filter((result) => result && Number.isFinite(result.developmentScore) && result.parameters);
  const count = Math.min(maxSeeds, Math.max(1, Math.ceil(eligible.length * topFraction)));
  return Object.freeze(eligible
    .sort((a, b) => b.developmentScore - a.developmentScore || stableKey(a.parameters).localeCompare(stableKey(b.parameters)))
    .slice(0, count)
    .map((result) => Object.freeze({ ...result.parameters })));
}

export function generateFineCandidates({ seeds, parameterBounds = DEFAULT_PARAMETER_BOUNDS, maxCandidates = 128 } = {}) {
  if (!Array.isArray(seeds) || seeds.length === 0) return Object.freeze([]);
  if (!Number.isInteger(maxCandidates) || maxCandidates <= 0) throw new RangeError("maxCandidates must be a positive integer");
  const normalized = Object.fromEntries(Object.entries(parameterBounds).map(([key, bound]) => [key, normalizeBound(bound, key)]));
  const candidates = [];
  const seen = new Set();
  for (const seed of seeds) {
    addCandidate(candidates, seen, seed, maxCandidates);
    for (const [key, bound] of Object.entries(normalized)) {
      if (!Number.isFinite(seed[key]) || !bound.fineStep) continue;
      addCandidate(candidates, seen, { ...seed, [key]: clamp(seed[key] - bound.fineStep, bound.min, bound.max) }, maxCandidates);
      addCandidate(candidates, seen, { ...seed, [key]: clamp(seed[key] + bound.fineStep, bound.min, bound.max) }, maxCandidates);
    }
  }
  return Object.freeze(candidates);
}

export function buildLeakFreeWalkForward(records, options) {
  const folds = buildValidationFolds(records, options);
  if (folds.some((fold) => fold.leakFree !== true)) throw new Error("walk-forward leak guard failed");
  return folds;
}

export function scoreStrategyQuality({ components, weights = DEFAULT_QUALITY_WEIGHTS } = {}) {
  assertWeights(weights);
  const normalized = {
    oosWalkForwardWinRate: clamp(finite(components?.oosWalkForwardWinRate), 0, 100),
    costAdjustedExpectancy: clamp(finite(components?.costAdjustedExpectancy), 0, 100),
    profitFactor: clamp(finite(components?.profitFactor), 0, 100),
    maximumDrawdown: clamp(finite(components?.maximumDrawdown), 0, 100),
    walkForwardStability: clamp(finite(components?.walkForwardStability), 0, 100),
    recentRegimePerformance: clamp(finite(components?.recentRegimePerformance), 0, 100),
    tradeSampleConfidence: clamp(finite(components?.tradeSampleConfidence), 0, 100),
    developmentToOosDegradation: clamp(finite(components?.developmentToOosDegradation), 0, 100),
  };
  const score = Object.keys(weights).reduce((sum, key) => sum + normalized[key] * weights[key], 0);
  return Object.freeze({ qualityScore: Number(score.toFixed(6)), components: Object.freeze(normalized), weights: Object.freeze({ ...weights }) });
}

export function evaluateMinimumGate({ oosMetrics = {}, walkForwardMetrics = {}, dataCoverage = {}, holdoutLeakDetected = false, config = DEFAULT_MINIMUM_GATE } = {}) {
  const reasons = [];
  const unconfigured = [];
  if (config.requirePositiveExpectancy && !(finite(oosMetrics.expectancy, Number.NEGATIVE_INFINITY) > 0)) reasons.push("non_positive_oos_expectancy");
  if (config.requirePositiveOosReturn && !(finite(oosMetrics.totalReturn, Number.NEGATIVE_INFINITY) > 0)) reasons.push("non_positive_oos_return");
  if (config.requirePositiveCostAdjustedExpectancy && !(finite(oosMetrics.costAdjustedExpectancy ?? oosMetrics.expectancy, Number.NEGATIVE_INFINITY) > 0)) reasons.push("non_positive_cost_adjusted_expectancy");
  if (config.requireLeakFreeHoldout && holdoutLeakDetected) reasons.push("holdout_leak_detected");
  if (config.requireSufficientCoverage && dataCoverage.sufficient !== true) reasons.push("insufficient_data_coverage");

  for (const key of ["minProfitFactor", "maxMaximumDrawdown", "minTradeCount", "minWalkForwardStability", "minCoverageRatio"]) {
    if (!Number.isFinite(config[key])) unconfigured.push(key);
  }
  if (Number.isFinite(config.minProfitFactor) && !(finite(oosMetrics.profitFactor, Number.NEGATIVE_INFINITY) >= config.minProfitFactor)) reasons.push("profit_factor_below_gate");
  if (Number.isFinite(config.maxMaximumDrawdown) && !(finite(oosMetrics.maximumDrawdown, Number.POSITIVE_INFINITY) <= config.maxMaximumDrawdown)) reasons.push("maximum_drawdown_above_gate");
  if (Number.isFinite(config.minTradeCount) && !(finite(oosMetrics.tradeCount, Number.NEGATIVE_INFINITY) >= config.minTradeCount)) reasons.push("trade_count_below_gate");
  if (Number.isFinite(config.minWalkForwardStability) && !(finite(walkForwardMetrics.stabilityScore, Number.NEGATIVE_INFINITY) >= config.minWalkForwardStability)) reasons.push("walk_forward_stability_below_gate");
  if (Number.isFinite(config.minCoverageRatio) && !(finite(dataCoverage.ratio, Number.NEGATIVE_INFINITY) >= config.minCoverageRatio)) reasons.push("coverage_ratio_below_gate");

  const status = reasons.length > 0 ? "research_hold" : unconfigured.length > 0 ? "threshold_calibration_required" : "eligible_for_final_holdout";
  return Object.freeze({ passed: status === "eligible_for_final_holdout", status, reasons: Object.freeze(reasons), unconfiguredThresholds: Object.freeze(unconfigured) });
}

export function assertFinalHoldoutIsolation({ selectionUsesHoldout, selectedCandidateId, holdoutCandidateId, retunedAfterHoldout = false } = {}) {
  if (selectionUsesHoldout !== false) throw new Error("final holdout cannot be used for strategy selection");
  if (!selectedCandidateId || selectedCandidateId !== holdoutCandidateId) throw new Error("final holdout must evaluate the frozen selected candidate");
  if (retunedAfterHoldout) throw new Error("retuning after final holdout is forbidden");
  return Object.freeze({ leakFree: true, frozenCandidate: true, retuningAllowed: false });
}

export function computeWalkForwardStability(windows = []) {
  const valid = windows.filter((window) => Number.isFinite(window?.totalReturn) && Number.isFinite(window?.profitFactor) && Number.isFinite(window?.maximumDrawdown));
  if (valid.length === 0) return Object.freeze({ windowCount: 0, profitableWindowsRatio: null, medianReturn: null, medianProfitFactor: null, worstWindowMaximumDrawdown: null, performanceDispersion: null, stabilityScore: null });
  const median = (values) => {
    const ordered = [...values].sort((a, b) => a - b);
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
  };
  const returns = valid.map((window) => window.totalReturn);
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / returns.length;
  const profitableWindowsRatio = valid.filter((window) => window.totalReturn > 0).length / valid.length;
  const dispersion = Math.sqrt(variance);
  const stabilityScore = clamp((profitableWindowsRatio * 70) + (clamp(1 - dispersion, 0, 1) * 30), 0, 100);
  return Object.freeze({
    windowCount: valid.length,
    profitableWindowsRatio,
    medianReturn: median(returns),
    medianProfitFactor: median(valid.map((window) => window.profitFactor)),
    worstWindowMaximumDrawdown: Math.max(...valid.map((window) => window.maximumDrawdown)),
    performanceDispersion: dispersion,
    stabilityScore: Number(stabilityScore.toFixed(6)),
  });
}

export function auditHistoricalProviderCapabilities(providers = {}) {
  const required = ["CRYPTO_SPOT", "CRYPTO_FUTURES", "US_STOCK", "KR_STOCK"];
  return Object.freeze(Object.fromEntries(required.map((market) => {
    const provider = providers[market];
    const ready = provider?.publicHistoricalOhlcv === true && provider?.closedCandlesOnly === true && provider?.coverageRecorded === true && provider?.duplicatesHandled === true && provider?.missingIntervalsDetected === true;
    return [market, Object.freeze({
      status: ready ? "ready" : "blocked_provider",
      source: provider?.source ?? null,
      publicHistoricalOhlcv: provider?.publicHistoricalOhlcv === true,
      closedCandlesOnly: provider?.closedCandlesOnly === true,
      coverageRecorded: provider?.coverageRecorded === true,
      duplicatesHandled: provider?.duplicatesHandled === true,
      missingIntervalsDetected: provider?.missingIntervalsDetected === true,
      corporateActions: market.endsWith("STOCK") ? (provider?.corporateActions ?? "not_verified") : "not_applicable",
      fakeHistoricalDataAllowed: false,
    })];
  })));
}

export function rankStrategiesByGroup(candidates, { topN = 10 } = {}) {
  if (!Number.isInteger(topN) || topN <= 0) throw new RangeError("topN must be a positive integer");
  const grouped = Object.fromEntries(AUTOMATED_RESEARCH_GROUPS.map((group) => [group.id, []]));
  for (const candidate of candidates ?? []) {
    if (!grouped[candidate?.rankingGroup]) continue;
    if (candidate.researchStatus !== "holdout_passed" || !Number.isFinite(candidate.qualityScore)) continue;
    grouped[candidate.rankingGroup].push(candidate);
  }
  return Object.freeze(Object.fromEntries(Object.entries(grouped).map(([group, values]) => [group, Object.freeze(values
    .sort((a, b) => b.qualityScore - a.qualityScore || (b.confidenceScore ?? 0) - (a.confidenceScore ?? 0) || String(a.strategyVersion).localeCompare(String(b.strategyVersion)))
    .slice(0, topN))])));
}

export function buildTopStrategyArtifact(input) {
  const required = ["market", "strategyType", "direction", "strategyVersion", "parameters", "dataStart", "dataEnd", "developmentMetrics", "oosMetrics", "walkForwardMetrics", "holdoutMetrics", "regimePerformance", "costModel", "dataCoverage", "researchStatus", "researchCodeSha", "generatedAt"];
  for (const key of required) {
    if (input?.[key] == null) throw new TypeError(`missing artifact field: ${key}`);
  }
  if (!/^[0-9a-f]{40}$/i.test(input.researchCodeSha)) throw new TypeError("researchCodeSha must be an immutable 40-character commit SHA");
  const metrics = input.holdoutMetrics ?? input.oosMetrics;
  return Object.freeze({
    market: input.market,
    strategyType: input.strategyType,
    direction: input.direction,
    strategyVersion: input.strategyVersion,
    parameters: Object.freeze({ ...input.parameters }),
    dataStart: input.dataStart,
    dataEnd: input.dataEnd,
    developmentMetrics: input.developmentMetrics,
    oosMetrics: input.oosMetrics,
    walkForwardMetrics: input.walkForwardMetrics,
    holdoutMetrics: input.holdoutMetrics,
    totalReturn: metrics.totalReturn ?? null,
    winRate: metrics.winRate ?? null,
    expectancy: metrics.expectancy ?? null,
    profitFactor: metrics.profitFactor ?? null,
    maximumDrawdown: metrics.maximumDrawdown ?? null,
    tradeCount: metrics.tradeCount ?? metrics.sampleCount ?? null,
    averageWin: metrics.averageWin ?? null,
    averageLoss: metrics.averageLoss ?? null,
    confidence: input.confidence ?? null,
    qualityScore: input.qualityScore ?? null,
    regimePerformance: input.regimePerformance,
    costModel: input.costModel,
    dataCoverage: input.dataCoverage,
    researchStatus: input.researchStatus,
    researchCodeSha: input.researchCodeSha,
    generatedAt: input.generatedAt,
    selectionUsesHoldout: false,
    finalHoldoutRetuningAllowed: false,
    ...SAFETY,
  });
}

export function buildAutomatedResearchContract({ researchCodeSha, generatedAt = new Date().toISOString(), providers = {} } = {}) {
  if (!/^[0-9a-f]{40}$/i.test(researchCodeSha ?? "")) throw new TypeError("researchCodeSha must be an immutable 40-character commit SHA");
  return Object.freeze({
    schemaVersion: 1,
    researchCodeSha,
    generatedAt,
    developmentStart: "2020-01-01",
    latestHistoricalEnd: "latest_available_closed_candle",
    groups: AUTOMATED_RESEARCH_GROUPS,
    qualityWeights: DEFAULT_QUALITY_WEIGHTS,
    minimumGate: DEFAULT_MINIMUM_GATE,
    providerCapabilities: auditHistoricalProviderCapabilities(providers),
    candidateSearch: Object.freeze({ method: "bounded_coarse_narrow_fine", cartesianProductAllowed: false, deterministic: true }),
    finalHoldout: Object.freeze({ selectionUsesHoldout: false, retuningAfterHoldoutAllowed: false, failureStatus: "research_hold" }),
    promotion: Object.freeze({ path: Object.freeze(["research", "review", "shadow", "approval"]), automaticLivePromotion: false }),
    artifactSafety: SAFETY,
  });
}
