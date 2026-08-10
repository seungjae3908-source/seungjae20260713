import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTOMATED_RESEARCH_GROUPS,
  DEFAULT_PARAMETER_BOUNDS,
  assertFinalHoldoutIsolation,
  auditHistoricalProviderCapabilities,
  buildAutomatedResearchContract,
  buildLeakFreeWalkForward,
  buildTopStrategyArtifact,
  computeWalkForwardStability,
  evaluateMinimumGate,
  generateFineCandidates,
  generateParameterCandidates,
  narrowPromisingCandidates,
  rankStrategiesByGroup,
  scoreStrategyQuality,
} from "../src/automated-research-orchestrator.js";

const SHA = "1234567890abcdef1234567890abcdef12345678";

function metrics(overrides = {}) {
  return {
    totalReturn: 0.12,
    winRate: 0.58,
    expectancy: 18,
    costAdjustedExpectancy: 15,
    profitFactor: 1.7,
    maximumDrawdown: 0.08,
    tradeCount: 120,
    averageWin: 42,
    averageLoss: 26,
    ...overrides,
  };
}

test("all ten market/strategy/direction ranking groups are isolated", () => {
  assert.equal(AUTOMATED_RESEARCH_GROUPS.length, 10);
  assert.deepEqual(AUTOMATED_RESEARCH_GROUPS.map((group) => group.id), [
    "KR_STOCK_SCALPING",
    "KR_STOCK_SWING",
    "US_STOCK_SCALPING",
    "US_STOCK_SWING",
    "CRYPTO_SPOT_SCALPING",
    "CRYPTO_SPOT_SWING",
    "CRYPTO_FUTURES_SCALPING_LONG",
    "CRYPTO_FUTURES_SCALPING_SHORT",
    "CRYPTO_FUTURES_SWING_LONG",
    "CRYPTO_FUTURES_SWING_SHORT",
  ]);
  assert.ok(AUTOMATED_RESEARCH_GROUPS.filter((group) => group.market !== "CRYPTO_FUTURES").every((group) => group.direction === "LONG"));
});

test("bounded candidate generation is deterministic and never explodes into a Cartesian product", () => {
  const options = {
    baseParameters: { emaFast: 12, emaSlow: 50, rsiThreshold: 40 },
    parameterBounds: {
      emaFast: DEFAULT_PARAMETER_BOUNDS.emaFast,
      emaSlow: DEFAULT_PARAMETER_BOUNDS.emaSlow,
      rsiThreshold: DEFAULT_PARAMETER_BOUNDS.rsiThreshold,
      atrPeriod: DEFAULT_PARAMETER_BOUNDS.atrPeriod,
    },
    maxCandidates: 40,
  };
  const first = generateParameterCandidates(options);
  const second = generateParameterCandidates(options);
  assert.deepEqual(first, second);
  assert.ok(first.length > 1);
  assert.ok(first.length <= 40);
  assert.equal(new Set(first.map((candidate) => JSON.stringify(candidate))).size, first.length);
});

test("coarse results narrow deterministically before bounded fine search", () => {
  const coarse = generateParameterCandidates({
    baseParameters: { emaFast: 12, emaSlow: 50 },
    parameterBounds: { emaFast: DEFAULT_PARAMETER_BOUNDS.emaFast, emaSlow: DEFAULT_PARAMETER_BOUNDS.emaSlow },
    maxCandidates: 24,
  });
  const results = coarse.map((parameters, index) => ({ parameters, developmentScore: index % 5 }));
  const seeds = narrowPromisingCandidates(results, { topFraction: 0.25, maxSeeds: 4 });
  const fine = generateFineCandidates({ seeds, parameterBounds: { emaFast: DEFAULT_PARAMETER_BOUNDS.emaFast, emaSlow: DEFAULT_PARAMETER_BOUNDS.emaSlow }, maxCandidates: 20 });
  assert.ok(seeds.length <= 4);
  assert.ok(fine.length <= 20);
  assert.ok(fine.length >= seeds.length);
});

test("quality score follows configured weights rather than raw return ranking", () => {
  const result = scoreStrategyQuality({
    components: {
      oosWalkForwardWinRate: 70,
      costAdjustedExpectancy: 80,
      profitFactor: 75,
      maximumDrawdown: 85,
      walkForwardStability: 90,
      recentRegimePerformance: 60,
      tradeSampleConfidence: 95,
      developmentToOosDegradation: 70,
    },
  });
  assert.equal(result.qualityScore, 78.5);
  assert.equal(Object.values(result.weights).reduce((sum, value) => sum + value, 0), 1);
});

test("minimum gate stays calibration-required instead of inventing numeric PF/MDD/sample thresholds", () => {
  const result = evaluateMinimumGate({
    oosMetrics: metrics(),
    walkForwardMetrics: { stabilityScore: 80 },
    dataCoverage: { sufficient: true, ratio: 0.99 },
    holdoutLeakDetected: false,
  });
  assert.equal(result.status, "threshold_calibration_required");
  assert.equal(result.passed, false);
  assert.ok(result.unconfiguredThresholds.includes("minProfitFactor"));
  assert.ok(result.unconfiguredThresholds.includes("maxMaximumDrawdown"));
  assert.ok(result.unconfiguredThresholds.includes("minTradeCount"));
});

test("minimum gate rejects negative OOS/cost performance before final holdout", () => {
  const result = evaluateMinimumGate({
    oosMetrics: metrics({ totalReturn: -0.01, expectancy: -1, costAdjustedExpectancy: -2 }),
    walkForwardMetrics: { stabilityScore: 80 },
    dataCoverage: { sufficient: true, ratio: 1 },
    config: {
      requirePositiveExpectancy: true,
      requirePositiveOosReturn: true,
      requirePositiveCostAdjustedExpectancy: true,
      requireLeakFreeHoldout: true,
      requireSufficientCoverage: true,
      minProfitFactor: 1,
      maxMaximumDrawdown: 0.5,
      minTradeCount: 10,
      minWalkForwardStability: 50,
      minCoverageRatio: 0.9,
    },
  });
  assert.equal(result.status, "research_hold");
  assert.ok(result.reasons.includes("non_positive_oos_return"));
  assert.ok(result.reasons.includes("non_positive_oos_expectancy"));
  assert.ok(result.reasons.includes("non_positive_cost_adjusted_expectancy"));
});

test("final holdout accepts only the frozen selected candidate and forbids retuning", () => {
  const safe = assertFinalHoldoutIsolation({ selectionUsesHoldout: false, selectedCandidateId: "swing-v23", holdoutCandidateId: "swing-v23" });
  assert.equal(safe.leakFree, true);
  assert.equal(safe.retuningAllowed, false);
  assert.throws(() => assertFinalHoldoutIsolation({ selectionUsesHoldout: true, selectedCandidateId: "a", holdoutCandidateId: "a" }), /cannot be used/);
  assert.throws(() => assertFinalHoldoutIsolation({ selectionUsesHoldout: false, selectedCandidateId: "a", holdoutCandidateId: "b" }), /frozen selected candidate/);
  assert.throws(() => assertFinalHoldoutIsolation({ selectionUsesHoldout: false, selectedCandidateId: "a", holdoutCandidateId: "a", retunedAfterHoldout: true }), /forbidden/);
});

test("existing purged walk-forward implementation is reused and remains deterministic/leak-free", () => {
  const records = Array.from({ length: 100 }, (_, index) => ({ id: index, anchorTimestamp: index * 10, futureEndTimestamp: index * 10 + 15 }));
  const options = { trainSize: 24, validationSize: 8, testSize: 8, stepSize: 8, embargoMs: 5 };
  const first = buildLeakFreeWalkForward(records, options);
  const second = buildLeakFreeWalkForward([...records].reverse(), options);
  assert.deepEqual(first, second);
  assert.ok(first.length > 1);
  assert.ok(first.every((fold) => fold.leakFree));
});

test("walk-forward stability records profitable ratio, medians, worst MDD and dispersion", () => {
  const result = computeWalkForwardStability([
    { totalReturn: 0.1, profitFactor: 1.5, maximumDrawdown: 0.08 },
    { totalReturn: 0.04, profitFactor: 1.3, maximumDrawdown: 0.12 },
    { totalReturn: -0.02, profitFactor: 0.9, maximumDrawdown: 0.18 },
  ]);
  assert.equal(result.windowCount, 3);
  assert.equal(result.profitableWindowsRatio, 2 / 3);
  assert.equal(result.medianReturn, 0.04);
  assert.equal(result.medianProfitFactor, 1.3);
  assert.equal(result.worstWindowMaximumDrawdown, 0.18);
  assert.ok(result.stabilityScore > 0 && result.stabilityScore <= 100);
});

test("provider audit blocks incomplete markets and never permits fake historical data", () => {
  const result = auditHistoricalProviderCapabilities({
    CRYPTO_FUTURES: {
      source: "public-test-provider",
      publicHistoricalOhlcv: true,
      closedCandlesOnly: true,
      coverageRecorded: true,
      duplicatesHandled: true,
      missingIntervalsDetected: true,
    },
  });
  assert.equal(result.CRYPTO_FUTURES.status, "ready");
  assert.equal(result.CRYPTO_SPOT.status, "blocked_provider");
  assert.equal(result.US_STOCK.status, "blocked_provider");
  assert.equal(result.KR_STOCK.status, "blocked_provider");
  assert.ok(Object.values(result).every((provider) => provider.fakeHistoricalDataAllowed === false));
});

test("ranking keeps groups separate, caps top 10 and excludes research_hold candidates", () => {
  const candidates = Array.from({ length: 14 }, (_, index) => ({
    rankingGroup: "CRYPTO_FUTURES_SWING_LONG",
    strategyVersion: `swing-v${index}`,
    qualityScore: 50 + index,
    confidenceScore: index,
    researchStatus: index === 13 ? "research_hold" : "holdout_passed",
  }));
  candidates.push({ rankingGroup: "KR_STOCK_SWING", strategyVersion: "kr-v1", qualityScore: 88, researchStatus: "holdout_passed" });
  const ranked = rankStrategiesByGroup(candidates);
  assert.equal(ranked.CRYPTO_FUTURES_SWING_LONG.length, 10);
  assert.equal(ranked.CRYPTO_FUTURES_SWING_LONG[0].strategyVersion, "swing-v12");
  assert.equal(ranked.KR_STOCK_SWING.length, 1);
  assert.equal(ranked.US_STOCK_SWING.length, 0);
});

test("top strategy artifact contains immutable provenance and hard safety flags", () => {
  const artifact = buildTopStrategyArtifact({
    market: "CRYPTO_FUTURES",
    strategyType: "SWING",
    direction: "LONG",
    strategyVersion: "swing-v23",
    parameters: { emaFast: 12, emaSlow: 50 },
    dataStart: "2020-01-01T00:00:00.000Z",
    dataEnd: "2026-08-09T00:00:00.000Z",
    developmentMetrics: metrics({ totalReturn: 0.3 }),
    oosMetrics: metrics({ totalReturn: 0.15 }),
    walkForwardMetrics: { stabilityScore: 82 },
    holdoutMetrics: metrics({ totalReturn: 0.09, winRate: 0.638 }),
    confidence: "A",
    qualityScore: 84,
    regimePerformance: { bull: "passed", range: "passed" },
    costModel: { fee: true, slippage: true, spread: true, latency: true, funding: true },
    dataCoverage: { sufficient: true, ratio: 0.99 },
    researchStatus: "holdout_passed",
    researchCodeSha: SHA,
    generatedAt: "2026-08-10T05:30:00.000Z",
  });
  assert.equal(artifact.totalReturn, 0.09);
  assert.equal(artifact.winRate, 0.638);
  assert.equal(artifact.researchCodeSha, SHA);
  assert.equal(artifact.selectionUsesHoldout, false);
  assert.equal(artifact.finalHoldoutRetuningAllowed, false);
  assert.equal(artifact.branchWrite, false);
  assert.equal(artifact.liveOrderAllowed, false);
  assert.equal(artifact.privateAccountRequestAllowed, false);
  assert.equal(artifact.orderSubmitted, false);
});

test("research contract fixes the 2020 baseline, bounded search, ten groups and no-live safety", () => {
  const contract = buildAutomatedResearchContract({ researchCodeSha: SHA, generatedAt: "2026-08-10T05:30:00.000Z" });
  assert.equal(contract.developmentStart, "2020-01-01");
  assert.equal(contract.groups.length, 10);
  assert.equal(contract.candidateSearch.cartesianProductAllowed, false);
  assert.equal(contract.finalHoldout.selectionUsesHoldout, false);
  assert.equal(contract.finalHoldout.retuningAfterHoldoutAllowed, false);
  assert.equal(contract.artifactSafety.liveOrderAllowed, false);
  assert.equal(contract.artifactSafety.privateAccountRequestAllowed, false);
  assert.equal(contract.artifactSafety.orderSubmitted, false);
});
