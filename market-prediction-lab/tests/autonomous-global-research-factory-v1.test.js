import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAutonomousGlobalResearchLoopContract,
  createAutonomousGlobalResearchFactoryState,
  runAutonomousGlobalResearchFactoryCycle,
  verifyAutonomousGlobalResearchFactoryState,
} from "../src/autonomous-global-research-factory-v1.js";
import { buildHistoricalCacheProvenance } from "../src/research-cache-provenance.js";

const SHA = "1234567890abcdef1234567890abcdef12345678";
const DATA_DIGEST = "a".repeat(64);

function metadata() {
  return {
    title: "Size, value, and momentum in international stock returns",
    authors: ["Eugene F. Fama", "Kenneth R. French"],
    venue: "Journal of Financial Economics",
    publicationDate: "2012-09-01",
    doi: "10.1016/j.jfineco.2012.05.011",
    canonicalUrl: "https://doi.org/10.1016/j.jfineco.2012.05.011",
    sourceClass: "PEER_REVIEWED_JOURNAL",
    sourceQuality: "HIGH",
    licenseStatus: "METADATA_PUBLIC",
    provenanceStatus: "DOCUMENTED",
    assetClass: "EQUITY",
    market: "US_STOCK",
    timeframe: "1d",
    samplePeriod: { startDate: "1990-11-01", endDate: "2011-03-01" },
    reportedN: 245,
    datasetReference: { datasetId: "KEN_FRENCH_DEVELOPED_MOMENTUM", status: "PUBLIC_AUTHOR_DATA" },
    reportedMetrics: { sharpe: null },
    costAssumptions: null,
    strategyFamily: "CROSS_SECTIONAL_MOMENTUM",
    strategySummary: "Long prior winners and short prior losers",
    formulaSummary: "0.5 * Small WML + 0.5 * Big WML",
    sourceProvenance: { provider: "DOI_METADATA", locator: "doi:10.1016/j.jfineco.2012.05.011" },
    ingestedAt: "2026-08-21T06:00:00Z",
    parserVersion: "factory-fixture-v1",
  };
}

function historical() {
  return buildHistoricalCacheProvenance({
    market: "US_STOCK",
    symbol: "US_LIQUID_PIT",
    timeframe: "1d",
    provider: "PUBLIC_FIXTURE",
    providerVersion: "v1",
    requestedStartTime: 1_577_836_800_000,
    requestedEndTime: 1_609_459_200_000,
    datasetDigest: DATA_DIGEST,
    researchCodeSha: SHA,
    candleCount: 366,
    actualStartTime: 1_577_836_800_000,
    actualEndTime: 1_609_372_800_000,
  });
}

function analysis(record) {
  const supported = (value, locator) => ({ value, extractionStatus: "SUPPORTED", confidence: "HIGH", sourceProvenance: { researchSourceId: record.researchSourceId, locator } });
  return {
    paperGenome: {
      market: supported("US_STOCK", "fixture:market"),
      timeframe: supported("1d", "fixture:timeframe"),
      direction: supported("BUY", "fixture:direction"),
      features: supported(["MOMENTUM", "LIQUIDITY"], "fixture:features"),
      formula: supported("momentum(t-1) > 0", "fixture:formula"),
      entryRule: supported("lagged momentum positive", "fixture:entry"),
      exitRule: supported("lagged momentum negative", "fixture:exit"),
    },
    strategySpecification: {
      market: "US_STOCK",
      direction: "BUY",
      timeframe: "1d",
      universe: { type: "POINT_IN_TIME_LIQUID_COMMON_STOCK" },
      availableFeatures: ["MOMENTUM", "LIQUIDITY", "ATR"],
      entryFormula: { op: "GT", args: [{ op: "FEATURE", feature: "MOMENTUM", lag: 1 }, { op: "CONSTANT", value: 0 }] },
      exitFormula: { op: "LT", args: [{ op: "FEATURE", feature: "MOMENTUM", lag: 1 }, { op: "CONSTANT", value: 0 }] },
      parameters: { lookback: { value: 20, min: 5, max: 120 } },
      holdingPeriod: { maxBars: 20 },
      rebalance: { cadence: "DAILY" },
      liquidityRequirement: { status: "EXPLICIT_INPUT_REQUIRED" },
      risk: { maxLeverage: 1, supportedLeverageConstraint: 1, sizingRule: { type: "BOUNDED_NOTIONAL" } },
    },
    generationKind: "AI_PROPOSED_RESEARCH_HYPOTHESIS",
    generationReason: "dual AI bounded deterministic experiment",
    strategyFamilyId: "factory-momentum-family",
    evidenceClass: "E1_LITERATURE",
    jobInput: {
      market: "US_STOCK",
      direction: "BUY",
      strategyType: "SWING",
      universeId: "US_LIQUID_PIT",
      timeframe: "1d",
      datasetId: "public-us-pit-fixture",
      datasetDigest: DATA_DIGEST,
      costPolicy: { version: "cost-v1", provenance: "FIXTURE_ONLY" },
      splitPolicy: { version: "split-v1", finalHoldoutExcluded: true, selectionUsesFinalHoldout: false },
      decisionPolicy: { version: "decision-v1", minimumGate: {
        requirePositiveExpectancy: true,
        requirePositiveOosReturn: true,
        requirePositiveCostAdjustedExpectancy: true,
        requireLeakFreeHoldout: true,
        requireSufficientCoverage: true,
        minProfitFactor: 1.1,
        maxMaximumDrawdown: 0.25,
        minTradeCount: 30,
        minWalkForwardStability: 20,
        minCoverageRatio: 0.95,
      } },
      historicalCacheProvenance: historical(),
      dataReady: true,
    },
  };
}

function backtestDependencies() {
  return {
    loadHistoricalCache: async (expected) => expected,
    runCanonicalBacktest: async () => ({ status: "COMPLETED", grossMetrics: { totalReturn: 0.2, expectancy: 3, profitFactor: 1.8, maximumDrawdown: 0.1, tradeCount: 100 } }),
    evaluateCanonicalCosts: async () => ({ status: "PASS", netMetrics: { totalReturn: 0.14, expectancy: 2, costAdjustedExpectancy: 2, profitFactor: 1.5, maximumDrawdown: 0.12, tradeCount: 100 }, costDrag: 0.06 }),
    runStatisticalFirewall: async () => ({ status: "PASS", dsr: { passed: true }, pbo: { passed: true }, realityCheck: { passed: true }, spa: { passed: true } }),
    runCanonicalOos: async () => ({ status: "PASS", metrics: { totalReturn: 0.08, expectancy: 1, costAdjustedExpectancy: 1, profitFactor: 1.3, maximumDrawdown: 0.14, tradeCount: 50 }, dataCoverage: { sufficient: true, ratio: 0.99 }, holdoutLeakDetected: false }),
    runCanonicalWalkForward: async () => ({ status: "PASS", leakFree: true, windows: [
      { totalReturn: 0.04, profitFactor: 1.3, maximumDrawdown: 0.1 },
      { totalReturn: 0.02, profitFactor: 1.2, maximumDrawdown: 0.12 },
    ] }),
    runCanonicalCostStress: async () => ({ status: "PASS", survivedMultiples: [1, 1.25, 1.5, 2] }),
    runCanonicalRegimeStress: async () => ({ status: "PASS", regimes: { bull: "PASS", bear: "PASS", range: "PASS" } }),
  };
}

function freeProviders() {
  return [
    { providerId: "free-ai-1", modelId: "open-a", billingTier: "FREE", state: "AVAILABLE", priority: 0 },
    { providerId: "free-ai-2", modelId: "open-b", billingTier: "FREE", state: "AVAILABLE", priority: 1 },
  ];
}

function dataAdapters() {
  return Object.freeze(Object.fromEntries(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"].map((market) => [market, Object.freeze({
    adapterId: `${market.toLowerCase()}-canonical-data-v1`,
    market,
    provider: "PUBLIC_FIXTURE",
    state: "AVAILABLE",
  })])));
}

function dependencies() {
  return {
    discoverResearchMetadata: async () => ({ records: [metadata()], nextCursor: "fixture-page-2" }),
    analyzeResearchRecord: async (record) => analysis(record),
    callFreeAiReviewProvider: async ({ slot }) => ({
      slot: slot.slot,
      providerId: slot.providerId,
      conclusion: "PROPOSE_DETERMINISTIC_TEST",
      mechanismOrChallenge: slot.mode === "ADVERSARIAL" ? "challenge costs and regimes" : "propose lagged momentum",
      expectedRegime: "REQUIRES_DETERMINISTIC_TEST",
      findings: ["fixture output is advisory only"],
      proposedBoundedVariants: [{ lookback: 20 }],
      deterministicResolution: "RUN_CANONICAL_COST_OOS_WF_PIPELINE",
    }),
    inspectResearchDataset: async ({ job, adapter }) => ({
      status: "READY",
      datasetId: job.datasetId,
      provider: adapter.provider,
      coverage: { start: "2020-01-01T00:00:00Z", end: "2020-12-31T00:00:00Z", observationCount: 366 },
      range: { requestedStart: "2020-01-01T00:00:00Z", requestedEnd: "2020-12-31T00:00:00Z" },
      universe: { universeId: job.universeId, pointInTime: true },
      timeframes: [job.timeframe],
      dataFingerprint: job.datasetDigest,
      quality: { status: "PASS", pointInTimeSafe: true, missingRate: 0, duplicateCount: 0 },
      asOf: "2020-12-31T00:00:00Z",
      maxSourceTimestamp: "2020-12-30T00:00:00Z",
    }),
    computeFeatureBundle: async ({ requestedFeatures, datasetInspection }) => ({
      datasetFingerprint: datasetInspection.dataFingerprint,
      sourceMaxTimestamp: datasetInspection.maxSourceTimestamp,
      features: Object.fromEntries(requestedFeatures.map((feature) => [feature, { status: "COMPUTED", lag: 1 }])),
    }),
    compileStrategySpecification: async ({ job }) => ({ status: "COMPILED", candidateIdentity: job.identity.candidateIdentityDigest }),
    backtestDependencies: backtestDependencies(),
  };
}

function input(overrides = {}) {
  return {
    cycleAt: "2026-08-21T06:00:00Z",
    evidenceObservationTimestamp: "2020-12-31T00:00:00Z",
    researchCodeSha: SHA,
    freeAiProviders: freeProviders(),
    dataAdapters: dataAdapters(),
    featureVersion: "factory-features-v1",
    resources: { activeWorkers: 0, cpuPercent: 10, memoryUsedMb: 100, freeDiskMb: 10_000 },
    loopContract: { maxDiscoveriesPerCycle: 4, maxJobsPerCycle: 1 },
    activationReadiness: { ready: false, blockers: ["CONTRACT_FIXTURE_ONLY"] },
    ...overrides,
  };
}

test("one bounded factory cycle connects discovery through freeze without opening Holdout", async () => {
  const result = await runAutonomousGlobalResearchFactoryCycle(createAutonomousGlobalResearchFactoryState(), input(), dependencies());
  assert.equal(verifyAutonomousGlobalResearchFactoryState(result.state), true);
  assert.equal(result.discoveries[0].status, "DISCOVERED");
  assert.equal(result.state.registry.records.length, 1);
  assert.equal(result.reviews[0].status, "AI_REVIEW_AGREE");
  assert.equal(result.reviews[0].preservedReviewOutputs.length, 4);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.jobs[0].status, "QUEUED");
  assert.equal(result.results[0].status, "FROZEN_ELIGIBLE");
  assert.equal(result.freezes[0].FROZEN_RESEARCH_CANDIDATE, true);
  assert.equal(result.finalHoldoutRequests.length, 0);
  assert.equal(result.state.evidenceLedger.records.length, 1);
  assert.equal(result.status.evidenceAccounting.externalStudyCount, 1);
  assert.equal(result.status.evidenceAccounting.externalObservationN, 245);
  assert.equal(result.status.evidenceAccounting.ourHoldoutN, 0);
  assert.equal(result.status.AUTONOMOUS_RESEARCH_FACTORY_ACTIVE, false);
  assert.equal(result.status.AI1Status, "AVAILABLE");
  assert.equal(result.status.AI2Status, "AVAILABLE");
  assert.equal(result.status.completedJobs, 1);
  assert.equal(result.status.failedJobs, 0);
  assert.equal(result.runtimeReadiness.AUTONOMOUS_RESEARCH_FACTORY_RUNTIME_READY, true);
  assert.equal(result.runtimeReadiness.AUTONOMOUS_RESEARCH_FACTORY_ACTIVE, false);
  assert.equal(result.safety.LIVE_TRADING, false);
});

test("a replayed discovery cannot create a second trial or evidence sample", async () => {
  const first = await runAutonomousGlobalResearchFactoryCycle(createAutonomousGlobalResearchFactoryState(), input(), dependencies());
  const replay = await runAutonomousGlobalResearchFactoryCycle(first.state, input({ cycleAt: "2026-08-21T06:05:00Z" }), dependencies());
  assert.equal(replay.discoveries[0].status, "ALREADY_KNOWN");
  assert.equal(replay.jobs.length, 0);
  assert.equal(replay.results.length, 0);
  assert.equal(replay.state.registry.records.length, 1);
  assert.equal(replay.state.evidenceLedger.records.length, 1);
});

test("one missing free provider stops before formula generation and queueing", async () => {
  const result = await runAutonomousGlobalResearchFactoryCycle(createAutonomousGlobalResearchFactoryState(), input({ freeAiProviders: freeProviders().slice(0, 1) }), dependencies());
  assert.equal(result.reviews[0].status, "AI_REVIEW_INCOMPLETE");
  assert.equal(result.candidates.length, 0);
  assert.equal(result.jobs.length, 0);
  assert.equal(result.results.length, 0);
  assert.equal(result.status.dualAiReviewStatus, "AI_REVIEW_INCOMPLETE");
  assert.equal(result.state.runtime.waitingForAi[Object.keys(result.state.runtime.waitingForAi)[0]].state, "WAITING_FOR_AI");
  assert.equal(result.state.runtime.waitingForAi[Object.keys(result.state.runtime.waitingForAi)[0]].retryDisposition, "RETRY_LATER");
  assert.equal(result.runtimeReadiness.AUTONOMOUS_RESEARCH_FACTORY_RUNTIME_READY, false);
});

test("24x7 loop contract is bounded and never activates timer or server", () => {
  const contract = buildAutonomousGlobalResearchLoopContract({ cadenceMs: 60_000, maxDiscoveriesPerCycle: 8, maxJobsPerCycle: 2 });
  assert.equal(contract.serviceMode, "ALWAYS_ON_24X7");
  assert.equal(contract.cycleFunction, "runAutonomousGlobalResearchFactoryCycle");
  assert.equal(contract.timerActivationRequested, false);
  assert.equal(contract.serverActivationRequested, false);
  assert.equal(contract.safety.REAL_ORDER_ENABLED, false);
  assert.throws(() => buildAutonomousGlobalResearchLoopContract({ maxDiscoveriesPerCycle: 65 }), /between 1 and 64/);
});
