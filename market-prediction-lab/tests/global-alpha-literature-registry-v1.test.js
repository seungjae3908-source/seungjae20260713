import test from "node:test";
import assert from "node:assert/strict";
import {
  appendGlobalStrategyResearchRecord,
  appendLiteratureReplicationTrial,
  appendLiteratureStudy,
  appendStrategyEvidenceTierEntry,
  buildLiteratureReplicationComparison,
  createGlobalAlphaLiteratureRegistry,
  createGlobalStrategyResearchRecord,
  createGlobalStrategyResearchRegistry,
  createLiteratureReplicationCase,
  createLiteratureStudy,
  createResearchSourceMetadata,
  createStrategyEvidenceTierLedger,
  summarizeStrategyEvidenceTiers,
  verifyGlobalAlphaLiteratureRegistry,
  verifyGlobalStrategyResearchRecord,
  verifyGlobalStrategyResearchRegistry,
  verifyStrategyEvidenceTierLedger,
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

const sourceDefaults = {
  sourceType: "ACADEMIC_PAPER",
  publicationDate: "2026-06-15",
  assetClass: "EQUITY",
  marketsStudied: ["KR_STOCK"],
  sampleN: 1_000_000,
  tradeN: 12_345,
  timeframe: "1d",
  horizon: "20 trading days",
  strategyConcept: "cross-sectional OHLCV image ranking",
  transactionCostAssumptions: { commissionBps: 5, slippageBps: "NOT_REPORTED" },
  statedLimitations: ["survivorship treatment not reported"],
  datasetReference: { datasetId: "kr-equity-panel-v1", access: "METADATA_ONLY" },
  licenseStatus: "REVIEW_REQUIRED",
  provenanceStatus: "DOCUMENTED",
  sourceProvenance: { acquisition: "USER_SUPPLIED_METADATA", locator: "abstract-and-methods" },
  ingestionTimestamp: "2026-08-21T00:00:00Z",
  parserVersion: "paper-parser-fixture-v1",
};

function globalRecordInput(studyOverrides = {}, genomeOverrides = {}) {
  const study = { ...paper, ...studyOverrides };
  const source = { ...sourceDefaults };
  const literatureStudy = createLiteratureStudy(study);
  const metadata = createResearchSourceMetadata({ study: literatureStudy, source });
  const supported = (value, locator) => ({
    value,
    extractionStatus: "SUPPORTED",
    confidence: "HIGH",
    sourceProvenance: { researchSourceId: metadata.researchSourceId, locator },
  });
  return {
    study,
    source,
    paperGenome: {
      universe: supported("KOSPI/KOSDAQ common stocks", "methods:universe"),
      market: supported("KR_STOCK", "methods:market"),
      assetClass: supported("EQUITY", "methods:asset-class"),
      timeframe: supported("1d", "methods:input-window"),
      horizon: supported("20 trading days", "methods:target"),
      direction: supported("LONG_SHORT", "methods:portfolio"),
      features: supported(["open", "high", "low", "close", "volume"], "methods:features"),
      entryRule: supported("rank top decile at rebalance close", "methods:entry"),
      exitRule: supported("exit at next 20-day rebalance", "methods:exit"),
      costAssumptions: supported({ commissionBps: 5, slippageBps: "NOT_REPORTED" }, "methods:costs"),
      regimeAssumptions: supported("NOT_STATED", "limitations:regime"),
      parameterStructure: supported({ lookbackDays: 20, quantile: 0.1 }, "methods:parameters"),
      reportedSharpe: supported(5.48, "results:table-2"),
      ...genomeOverrides,
    },
  };
}

test("global research source identity and fingerprints are deterministic but ingestion time is not identity", () => {
  const first = createGlobalStrategyResearchRecord(globalRecordInput());
  const later = createGlobalStrategyResearchRecord({
    ...globalRecordInput(),
    source: { ...sourceDefaults, ingestionTimestamp: "2026-08-21T01:00:00Z" },
  });
  assert.equal(first.researchSourceId, later.researchSourceId);
  assert.equal(first.sourceMetadata.sourceFingerprint, later.sourceMetadata.sourceFingerprint);
  assert.notEqual(first.evidenceFingerprint, "");
  assert.equal(verifyGlobalStrategyResearchRecord(first), true);
});

test("Paper Genome keeps provenance and explicit missing evidence without inventing zero", () => {
  const record = createGlobalStrategyResearchRecord(globalRecordInput());
  assert.equal(record.paperGenome.fields.reportedProfitFactor.value, null);
  assert.equal(record.paperGenome.fields.reportedProfitFactor.extractionStatus, "NOT_REPORTED");
  assert.equal(record.paperGenome.fields.reportedProfitFactor.confidence, null);
  assert.equal(record.paperGenome.fields.reportedSharpe.value, 5.48);
  assert.match(record.paperGenome.fields.reportedSharpe.sourceProvenance.locator, /table-2/);
});

test("ambiguous extraction is preserved but cannot silently become Strategy DNA fact", () => {
  const input = globalRecordInput({}, {
    entryRule: {
      value: "possibly top decile",
      extractionStatus: "AMBIGUOUS",
      confidence: "LOW",
      sourceProvenance: {
        researchSourceId: createResearchSourceMetadata({ study: createLiteratureStudy(paper), source: sourceDefaults }).researchSourceId,
        locator: "methods:unclear-entry",
      },
    },
  });
  const record = createGlobalStrategyResearchRecord(input);
  assert.equal(record.paperGenome.fields.entryRule.value, "possibly top decile");
  assert.equal(record.paperGenome.fields.entryRule.extractionStatus, "AMBIGUOUS");
  assert.equal(record.strategyDna.components.entryLogic, null);
});

test("Paper Genome rejects cross-source provenance and unsupported fields", () => {
  const mismatched = globalRecordInput({}, {
    formula: {
      value: "rank(x)",
      extractionStatus: "SUPPORTED",
      confidence: "HIGH",
      sourceProvenance: { researchSourceId: "research-source:other", locator: "methods:formula" },
    },
  });
  assert.throws(() => createGlobalStrategyResearchRecord(mismatched), /must match researchSourceId/);
  assert.throws(() => createGlobalStrategyResearchRecord(globalRecordInput({}, { inventedMetric: { value: 1 } })), /unsupported Paper Genome fields/);
});

test("different papers with the same deterministic DNA form one family without independent-evidence credit", () => {
  let registry = createGlobalStrategyResearchRegistry();
  registry = appendGlobalStrategyResearchRecord(registry, globalRecordInput());
  registry = appendGlobalStrategyResearchRecord(registry, globalRecordInput({
    studyId: "kr-cnn-independent-publication",
    title: "A second description of Korean OHLCV CNN",
    doi: "10.1234/example.7777",
    sourceUrl: "https://example.test/second-paper",
  }));
  assert.equal(registry.records.length, 2);
  assert.equal(registry.strategyFamilies.length, 1);
  assert.equal(registry.strategyFamilies[0].paperVariantIds.length, 2);
  assert.equal(registry.strategyFamilies[0].independentEvidenceCount, null);
  assert.equal(registry.strategyFamilies[0].evidenceIndependenceStatus, "NOT_ESTABLISHED");
  assert.equal(verifyGlobalStrategyResearchRegistry(registry), true);
});

test("same canonical source cannot be renamed into a new research discovery", () => {
  let registry = createGlobalStrategyResearchRegistry();
  registry = appendGlobalStrategyResearchRecord(registry, globalRecordInput());
  const renamed = globalRecordInput({ studyId: "renamed", title: "Renamed paper", doi: "DOI:10.1234/EXAMPLE.5678" });
  assert.throws(() => appendGlobalStrategyResearchRecord(registry, renamed), /DUPLICATE_RESEARCH_SOURCE/);
});

test("global registry is fail-closed for Scanner and all execution authority", () => {
  const registry = appendGlobalStrategyResearchRecord(createGlobalStrategyResearchRegistry(), globalRecordInput());
  assert.equal(registry.safety.eligibleForScannerResearchConsideration, false);
  assert.equal(registry.safety.liveTrading, false);
  assert.equal(registry.safety.autoTrading, false);
  assert.equal(registry.safety.realOrderEnabled, false);
  assert.equal(registry.safety.privateTradingApiAllowed, false);
  assert.equal(registry.safety.actualOrders, 0);
  assert.equal(registry.safety.actualTransfers, 0);
});

test("tampering with provenance-bound genome or DNA invalidates the research record", () => {
  const record = createGlobalStrategyResearchRecord(globalRecordInput());
  const tamperedGenome = {
    ...record,
    paperGenome: {
      ...record.paperGenome,
      fields: {
        ...record.paperGenome.fields,
        reportedSharpe: { ...record.paperGenome.fields.reportedSharpe, value: 99 },
      },
    },
  };
  assert.equal(verifyGlobalStrategyResearchRecord(tamperedGenome), false);
  const tamperedDna = { ...record, strategyDna: { ...record.strategyDna, strategyDnaHash: "strategy-dna:fake" } };
  assert.equal(verifyGlobalStrategyResearchRecord(tamperedDna), false);
});

const unifiedIdentity = {
  strategyId: "kr-cnn-replication",
  strategyFamilyId: "strategy-family:kr-cnn",
  strategyVersion: "v1",
  parameterHash: "params-frozen-v1",
  researchCodeSha: "0123456789abcdef0123456789abcdef01234567",
  market: "KR_STOCK",
  direction: "LONG_SHORT",
  timeframe: "1d",
  costPolicyVersion: "kr-stock-cost-v1",
};

function tierEntry(evidenceKind, overrides = {}) {
  return {
    evidenceKind,
    sampleCount: 10,
    sourceFingerprint: `${evidenceKind.toLowerCase()}-source-v1`,
    evaluationSliceId: `${evidenceKind.toLowerCase()}-slice-v1`,
    resultStatus: "RECORDED",
    ...overrides,
  };
}

test("E1 external sample N is never added to E4 Paper or Settlement N", () => {
  let ledger = createStrategyEvidenceTierLedger({ identity: unifiedIdentity });
  ledger = appendStrategyEvidenceTierEntry(ledger, tierEntry("EXTERNAL_REPORTED_EVIDENCE", {
    sampleCount: 10_000,
    reportedMetrics: { sharpe: 1.7, hitRatePct: 61 },
  }));
  ledger = appendStrategyEvidenceTierEntry(ledger, tierEntry("OUR_NATURAL_PAPER", {
    sampleCount: 50,
    deterministicMetrics: { netReturnPct: -1.2 },
    naturalObservationAt: "2026-08-21T01:00:00Z",
    sourceRuntime: "RESEARCH_PRODUCTION_PRIMARY",
    historicalBackfill: false,
  }));
  ledger = appendStrategyEvidenceTierEntry(ledger, tierEntry("OUR_SETTLEMENT", {
    sampleCount: 40,
    deterministicMetrics: { settled: true },
    naturalObservationAt: "2026-08-21T02:00:00Z",
    sourceRuntime: "RESEARCH_PRODUCTION_PRIMARY",
    historicalBackfill: false,
  }));
  const summary = summarizeStrategyEvidenceTiers(ledger);
  assert.equal(summary.externalPaperN, 10_000);
  assert.equal(summary.ourPaperN, 50);
  assert.equal(summary.ourSettledN, 40);
  assert.equal(summary.externalAndOurSampleCountsCombined, false);
  assert.equal("canonicalPaperN" in summary, false);
});

test("external reported statistics can never populate our deterministic metrics", () => {
  const ledger = createStrategyEvidenceTierLedger({ identity: unifiedIdentity });
  assert.throws(() => appendStrategyEvidenceTierEntry(ledger, tierEntry("EXTERNAL_REPORTED_EVIDENCE", {
    deterministicMetrics: { sharpe: 9.9 },
  })), /CANNOT_POPULATE_OUR_METRICS/);
  const recorded = appendStrategyEvidenceTierEntry(ledger, tierEntry("EXTERNAL_REPORTED_EVIDENCE", {
    reportedMetrics: { sharpe: 1.7 },
  }));
  assert.equal(recorded.entries[0].reportedMetrics.sharpe, 1.7);
  assert.equal(recorded.entries[0].deterministicMetrics, null);
  assert.equal(recorded.safety.externalEvidenceCanProveProfitability, false);
});

test("our deterministic replication on lawful external raw data remains E2 historical evidence", () => {
  let ledger = createStrategyEvidenceTierLedger({ identity: unifiedIdentity });
  ledger = appendStrategyEvidenceTierEntry(ledger, tierEntry("OUR_REPLICATION_ON_EXTERNAL_DATA", {
    sampleCount: 2_500,
    deterministicMetrics: { sharpe: 0.8, computation: "DETERMINISTIC_BACKTEST" },
  }));
  assert.equal(ledger.entries[0].tier, "E2");
  assert.equal(ledger.entries[0].classification, "HISTORICAL_OUR_REPLICATION_ON_EXTERNAL_DATA");
  assert.equal(ledger.entries[0].naturalObservationAt, null);
  assert.equal(ledger.counts.ourReplicationN, 2_500);
  assert.equal(ledger.counts.ourShadowN, 0);
  assert.equal(ledger.counts.ourPaperN, 0);
});

test("Natural Shadow and Paper require the Primary runtime and forbid backfill", () => {
  const ledger = createStrategyEvidenceTierLedger({ identity: unifiedIdentity });
  assert.throws(() => appendStrategyEvidenceTierEntry(ledger, tierEntry("OUR_NATURAL_SHADOW", {
    naturalObservationAt: "2026-08-21T01:00:00Z",
    sourceRuntime: "GITHUB_ACTIONS",
    historicalBackfill: false,
  })), /PRIMARY_RUNTIME_REQUIRED/);
  assert.throws(() => appendStrategyEvidenceTierEntry(ledger, tierEntry("OUR_NATURAL_PAPER", {
    naturalObservationAt: "2026-08-21T01:00:00Z",
    sourceRuntime: "RESEARCH_PRODUCTION_PRIMARY",
    historicalBackfill: true,
  })), /HISTORICAL_BACKFILL_FORBIDDEN/);
});

test("restart replay cannot receive duplicate evidence credit", () => {
  let ledger = createStrategyEvidenceTierLedger({ identity: unifiedIdentity });
  const evidence = tierEntry("OUR_OOS", { deterministicMetrics: { status: "PASS" } });
  ledger = appendStrategyEvidenceTierEntry(ledger, evidence);
  assert.throws(() => appendStrategyEvidenceTierEntry(ledger, evidence), /DUPLICATE_EVIDENCE/);
  assert.equal(ledger.counts.ourOosN, 10);
  assert.equal(verifyStrategyEvidenceTierLedger(ledger), true);
});

test("renaming a strategy does not bypass the family/parameter evidence dedup identity", () => {
  let ledger = createStrategyEvidenceTierLedger({ identity: unifiedIdentity });
  const evidence = tierEntry("OUR_FINAL_HOLDOUT", { deterministicMetrics: { status: "FAIL" }, resultStatus: "NOT_REPLICATED", failureReason: "effect reversed" });
  ledger = appendStrategyEvidenceTierEntry(ledger, evidence);
  const renamedLedger = createStrategyEvidenceTierLedger({ identity: { ...unifiedIdentity, strategyId: "renamed-winner" } });
  assert.equal(ledger.strategyIdentity.antiRenameIdentityHash, renamedLedger.strategyIdentity.antiRenameIdentityHash);
  assert.equal(ledger.entries[0].resultStatus, "NOT_REPLICATED");
  assert.equal(ledger.entries[0].failureReason, "effect reversed");
});

test("tier ledger remains fail-closed for Scanner, profitability and all live authority", () => {
  const summary = summarizeStrategyEvidenceTiers(createStrategyEvidenceTierLedger({ identity: unifiedIdentity }));
  assert.equal(summary.profitabilityProven, false);
  assert.equal(summary.eligibleForScannerResearchConsideration, false);
  assert.equal(summary.safety.liveTrading, false);
  assert.equal(summary.safety.autoTrading, false);
  assert.equal(summary.safety.actualOrders, 0);
  assert.equal(summary.safety.actualWithdrawals, 0);
});
