import test from "node:test";
import assert from "node:assert/strict";
import {
  createGlobalStrategyResearchRecord,
  createLiteratureStudy,
  createResearchSourceMetadata,
} from "../src/global-alpha-literature-registry-v1.js";
import {
  createPaperReplicationAssessment,
  evaluateGlobalStrategyStatisticalFirewall,
  evaluateStrategyEconomicReality,
  globalStrategyEconomicRealityRequirements,
} from "../src/global-strategy-statistical-firewall-v1.js";

const study = {
  studyId: "replication-paper-v1",
  title: "Documented momentum replication",
  authors: ["A. Researcher"],
  venue: "Journal of Tests",
  doi: "10.1234/replication.1",
  sourceUrl: "https://example.test/replication",
  market: "US_STOCK",
  strategyFamily: "TIME_SERIES_MOMENTUM",
  strategySummary: "Long positive trailing returns",
  sample: { startDate: "2000-01-01", endDate: "2020-12-31", observationCount: 5000 },
  reportedMetrics: { sharpe: 1.1 },
};

const source = {
  sourceType: "ACADEMIC_PAPER",
  publicationDate: "2021-01-01",
  assetClass: "EQUITY",
  marketsStudied: ["US_STOCK"],
  sampleN: 5000,
  timeframe: "1d",
  horizon: "20d",
  transactionCostAssumptions: { commissionBps: 2 },
  datasetReference: { datasetId: "crsp-v1" },
  licenseStatus: "REVIEW_REQUIRED",
  provenanceStatus: "DOCUMENTED",
  sourceProvenance: { locator: "paper" },
  ingestionTimestamp: "2026-08-21T00:00:00Z",
  parserVersion: "test-v1",
};

function researchRecord() {
  const metadata = createResearchSourceMetadata({ study: createLiteratureStudy(study), source });
  const supported = (value, locator) => ({
    value,
    extractionStatus: "SUPPORTED",
    confidence: "HIGH",
    sourceProvenance: { researchSourceId: metadata.researchSourceId, locator },
  });
  return createGlobalStrategyResearchRecord({
    study,
    source,
    paperGenome: {
      market: supported("US_STOCK", "methods:market"),
      timeframe: supported("1d", "methods:timeframe"),
      direction: supported("LONG", "methods:direction"),
      features: supported(["trailing-return"], "methods:features"),
      entryRule: supported("return > 0", "methods:entry"),
      exitRule: supported("20d", "methods:exit"),
      costAssumptions: supported({ commissionBps: 2 }, "methods:cost"),
    },
  });
}

function replication(overrides = {}) {
  const record = researchRecord();
  return {
    researchRecord: record,
    replication: {
      status: "NOT_REPLICATED",
      failureReason: "effect reversed after costs",
      researchCodeSha: "0123456789abcdef0123456789abcdef01234567",
      sourceResearchId: record.researchSourceId,
      datasetFingerprint: "external-dataset:crsp-v1",
      dataProvenance: { provider: "lawful-research-fixture", pointInTime: true },
      parameterMappingStatus: "EXACT",
      metricDefinitionFingerprint: "metric:net-return-v1",
      ourReplicationSampleN: 1000,
      metrics: { netReturn: -0.02 },
      ...overrides,
    },
  };
}

test("failed paper replication is preserved and never converted into success", () => {
  const result = createPaperReplicationAssessment(replication());
  assert.equal(result.status, "NOT_REPLICATED");
  assert.equal(result.failedReplicationPreserved, true);
  assert.equal(result.metrics.netReturn, -0.02);
  assert.equal(result.paperReportedMetricsKeptSeparate, true);
  assert.equal(result.safety.promotionAuthority, false);
});

test("blocked replication cannot smuggle metrics and source mismatch fails closed", () => {
  assert.throws(() => createPaperReplicationAssessment(replication({ status: "BLOCKED_DATA", metrics: { sharpe: 99 } })), /cannot carry replication metrics/);
  assert.throws(() => createPaperReplicationAssessment(replication({ sourceResearchId: "research-source:other" })), /SOURCE_MISMATCH/);
});

test("replicated status requires deterministic metrics and exact immutable code SHA", () => {
  assert.throws(() => createPaperReplicationAssessment(replication({ status: "REPLICATED", failureReason: null, metrics: null })), /requires deterministic metrics/);
  assert.throws(() => createPaperReplicationAssessment(replication({ researchCodeSha: "short" })), /40-character SHA/);
});

test("insufficient statistical evidence produces null results rather than fake statistics", () => {
  const result = evaluateGlobalStrategyStatisticalFirewall({
    trials: [{ trialId: "one", returnSeries: [0.01] }],
    selectedTrialId: "one",
  });
  assert.equal(result.status, "INSUFFICIENT_EVIDENCE");
  assert.equal(result.trialCount, 1);
  assert.equal(result.dsr.result, null);
  assert.equal(result.pbo.result, null);
  assert.equal(result.realityCheckAndSpa.result, null);
  assert.equal(result.decision.status, "THRESHOLDS_NOT_APPLIED");
});

test("statistical firewall reuses DSR PBO Reality Check and SPA with empirical policies", () => {
  const n = 16;
  const trials = [
    { trialId: "strong", returnSeries: Array.from({ length: n }, (_, i) => 0.01 + (i % 4) * 0.0003) },
    { trialId: "noise", returnSeries: Array.from({ length: n }, (_, i) => i % 2 ? 0.0002 : -0.0002) },
    { trialId: "weak", returnSeries: Array.from({ length: n }, (_, i) => 0.001 + (i % 3) * 0.0001) },
  ];
  const result = evaluateGlobalStrategyStatisticalFirewall({
    trials,
    selectedTrialId: "strong",
    benchmarkReturns: Array(n).fill(0),
    blockCount: 8,
    realityCheckPolicy: { status: "empirically_calibrated", bootstrapIterations: 200, blockLength: 2, seed: 11, alpha: 0.05 },
    decisionPolicy: { status: "empirically_calibrated", maxPbo: 0.5, minDsrProbability: 0.5, alpha: 0.05 },
  });
  assert.equal(result.status, "EVIDENCE_READY");
  assert.equal(result.trialCount, 3);
  assert.equal(result.dsr.result.method, "DEFLATED_SHARPE_RATIO");
  assert.equal(result.pbo.result.method, "CSCV_PBO");
  assert.equal(result.realityCheckAndSpa.result.status, "EVIDENCE_READY");
  assert.equal(result.dataSnoopingDisclosure.userSuppliedTrialCountAccepted, false);
  assert.equal(result.safety.scannerAuthority, false);
});

function cost(valueBps, source = "fixture") {
  return { status: "MEASURED", valueBps, sourceProvenance: { source } };
}

test("missing Korean stock tax evidence blocks economic reality instead of assuming zero", () => {
  const result = evaluateStrategyEconomicReality({
    market: "KR_STOCK",
    direction: "LONG",
    costPolicyVersion: "kr-cost-v1",
    costs: { commission: cost(1), spread: cost(2), slippage: cost(3), liquidityImpact: cost(4) },
  });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.deepEqual(result.missingDimensions, ["tax"]);
  assert.equal(result.totalExpectedCostBps, null);
  assert.match(result.blockers[0], /MISSING_TAX/);
});

test("explicit measured zero is preserved and complete market costs are summed", () => {
  const result = evaluateStrategyEconomicReality({
    market: "KR_STOCK",
    direction: "LONG",
    costPolicyVersion: "kr-cost-v1",
    costs: { commission: cost(1), spread: cost(2), slippage: cost(3), tax: cost(0), liquidityImpact: cost(4) },
  });
  assert.equal(result.status, "ECONOMIC_EVIDENCE_READY");
  assert.equal(result.costs.tax.valueBps, 0);
  assert.equal(result.totalExpectedCostBps, 10);
  assert.equal(result.marketNormalization.normalizedAway, false);
});

test("US stock short borrow and futures funding remain market-specific blockers", () => {
  const us = evaluateStrategyEconomicReality({
    market: "US_STOCK",
    direction: "SHORT",
    costPolicyVersion: "us-short-v1",
    costs: { commission: cost(1), spread: cost(1), slippage: cost(1), tax: cost(1), fx: cost(1), liquidityImpact: cost(1) },
  });
  assert.deepEqual(us.missingDimensions, ["borrow"]);
  const futures = evaluateStrategyEconomicReality({
    market: "CRYPTO_FUTURES",
    direction: "LONG",
    costPolicyVersion: "futures-v1",
    costs: { commission: cost(1), spread: cost(1), slippage: cost(1), liquidityImpact: cost(1) },
  });
  assert.deepEqual(futures.missingDimensions, ["funding"]);
  assert.equal(futures.marketNormalization.crossMarketComparisonAllowed, false);
  assert.equal(futures.safety.actualOrders, 0);
});

test("economic requirements expose four isolated market contracts", () => {
  const requirements = globalStrategyEconomicRealityRequirements();
  assert.deepEqual(Object.keys(requirements).sort(), ["CRYPTO_FUTURES", "CRYPTO_SPOT", "KR_STOCK", "US_STOCK"]);
  assert.equal(requirements.KR_STOCK.includes("tax"), true);
  assert.equal(requirements.CRYPTO_FUTURES.includes("funding"), true);
});
