import test from "node:test";
import assert from "node:assert/strict";
import {
  appendLiteratureReplicationTrial,
  appendLiteratureStudy,
  buildLiteratureReplicationComparison,
  createGlobalAlphaLiteratureRegistry,
  createLiteratureReplicationCase,
  createLiteratureStudy,
  verifyGlobalAlphaLiteratureRegistry,
} from "../src/global-alpha-literature-registry-v1.js";

const paper = {
  studyId: "kr-cnn-2026",
  title: "Korean OHLCV CNN",
  authors: ["Researcher A"],
  venue: "Journal Fixture",
  publishedYear: 2026,
  doi: "https://doi.org/10.1234/example.5678",
  sourceUrl: "https://example.test/paper",
  market: "KR_STOCK",
  strategyFamily: "OHLCV_CNN",
  strategySummary: "20-day OHLCV image model ranked cross-sectionally.",
  formulaSummary: "top decile long minus bottom decile short",
  sample: { startDate: "2000-01-01", endDate: "2023-12-31", observationCount: 1_000_000, assetCount: 2_000 },
  reportedMetrics: { annualReturnPct: 56, sharpe: 5.48, maxDrawdownPct: -12.3, profitFactor: 2.1 },
  validation: { outOfSample: true, walkForward: false, transactionCostsIncluded: true, independentReplicationCount: 0 },
};

const identity = {
  strategyId: "kr-cnn-replication",
  strategyVersion: "v1",
  researchCodeSha: "0123456789abcdef0123456789abcdef01234567",
  datasetSnapshotHash: "dataset-kr-001",
  market: "KR_STOCK",
  timeframe: "1d",
  direction: "LONG_SHORT",
};

function trial(overrides = {}) {
  return {
    trialId: "trial-a",
    candidateId: "candidate-a",
    stage: "development",
    selectionEligible: true,
    parameterHash: "params-a",
    returnSeries: [0.02, -0.01, 0.015, 0.01, -0.005, 0.012],
    metrics: { source: "local-backtest" },
    ...overrides,
  };
}

test("unreported paper win rate remains null and is never fabricated as zero", () => {
  const study = createLiteratureStudy(paper);
  assert.equal(study.reportedMetrics.winRatePct, null);
  assert.equal(study.profitabilityProven, false);
});

test("high reported return remains literature-only and cannot prove profitability or promotion", () => {
  const study = createLiteratureStudy(paper);
  assert.equal(study.reportedMetrics.annualReturnPct, 56);
  assert.equal(study.evidenceAuthority, "LITERATURE_ONLY");
  assert.equal(study.profitabilityProven, false);
  assert.equal(study.promotionEligible, false);
  assert.equal(study.executionAuthority, "NONE");
});

test("same DOI is deduplicated even when title formatting changes", () => {
  let registry = createGlobalAlphaLiteratureRegistry();
  registry = appendLiteratureStudy(registry, paper);
  assert.throws(() => appendLiteratureStudy(registry, { ...paper, studyId: "other", title: "DIFFERENT TITLE", doi: "doi:10.1234/EXAMPLE.5678" }), /DUPLICATE_LITERATURE_SOURCE/);
  assert.equal(verifyGlobalAlphaLiteratureRegistry(registry), true);
});

test("invalid metric ranges fail closed", () => {
  assert.throws(() => createLiteratureStudy({ ...paper, reportedMetrics: { ...paper.reportedMetrics, winRatePct: 101 } }), /winRatePct/);
  assert.throws(() => createLiteratureStudy({ ...paper, reportedMetrics: { ...paper.reportedMetrics, maxDrawdownPct: 12 } }), /maxDrawdownPct/);
  assert.throws(() => createLiteratureStudy({ ...paper, reportedMetrics: { ...paper.reportedMetrics, profitFactor: -1 } }), /profitFactor/);
});

test("zero sample counts are rejected while unknown null is allowed", () => {
  assert.throws(() => createLiteratureStudy({ ...paper, sample: { ...paper.sample, observationCount: 0 } }), /positive integer/);
  const study = createLiteratureStudy({ ...paper, studyId: "unknown-n", doi: "10.1234/example.9999", sample: { ...paper.sample, observationCount: null } });
  assert.equal(study.sample.observationCount, null);
});

test("replication requires an exact immutable 40-character research code SHA", () => {
  const study = createLiteratureStudy(paper);
  assert.throws(() => createLiteratureReplicationCase({ study, experimentId: "exp-a", identity: { ...identity, researchCodeSha: "main" } }), /40-character SHA/);
});

test("new replication starts with zero local trials and null local performance", () => {
  const study = createLiteratureStudy(paper);
  const replication = createLiteratureReplicationCase({ study, experimentId: "exp-a", identity });
  assert.equal(replication.localEvidence.trialCount, 0);
  assert.equal(replication.localEvidence.annualReturnPct, null);
  assert.equal(replication.localEvidence.winRatePct, null);
  assert.equal(replication.localEvidence.profitabilityProven, false);
  assert.equal(replication.safety.orderAuthority, false);
});

test("tampered trial registry is rejected before comparison", () => {
  const study = createLiteratureStudy(paper);
  let replication = createLiteratureReplicationCase({ study, experimentId: "exp-a", identity });
  replication = appendLiteratureReplicationTrial(replication, trial());
  const tampered = { ...replication, trialRegistry: { ...replication.trialRegistry, registryDigest: "0".repeat(64) } };
  assert.throws(() => buildLiteratureReplicationComparison({ replication: tampered, selectedTrialId: "trial-a", periodsPerYear: 252 }), /TAMPERED/);
});

test("caller-supplied local metrics cannot override metrics derived from the return series", () => {
  const study = createLiteratureStudy(paper);
  let replication = createLiteratureReplicationCase({ study, experimentId: "exp-a", identity });
  replication = appendLiteratureReplicationTrial(replication, trial());
  const comparison = buildLiteratureReplicationComparison({ replication, selectedTrialId: "trial-a", periodsPerYear: 252, localMetrics: { annualReturnPct: 9999 } });
  assert.notEqual(comparison.localBacktestMetrics.annualReturnPct, 9999);
  assert.equal(comparison.profitabilityProven, false);
  assert.equal(comparison.promotionEligible, false);
});

test("comparison keeps paper metrics separate and local backtest still needs forward evidence", () => {
  const study = createLiteratureStudy(paper);
  let replication = createLiteratureReplicationCase({ study, experimentId: "exp-a", identity });
  replication = appendLiteratureReplicationTrial(replication, trial());
  const comparison = buildLiteratureReplicationComparison({ replication, selectedTrialId: "trial-a", periodsPerYear: 252 });
  assert.equal(comparison.literatureReportedMetrics.annualReturnPct, 56);
  assert.ok(Number.isFinite(comparison.localBacktestMetrics.winRatePct));
  assert.equal(comparison.status, "BACKTEST_COMPARISON_ONLY");
  assert.deepEqual(comparison.nextRequiredEvidence, ["OOS_OR_WALK_FORWARD", "FINAL_HOLDOUT", "SHADOW", "NATURAL_PAPER", "SETTLEMENT"]);
  assert.equal(comparison.safety.literatureMetricsCanProveProfitability, false);
});
