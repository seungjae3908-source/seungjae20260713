import test from "node:test";
import assert from "node:assert/strict";
import {
  appendStrategyEvidenceTierEntry,
  createGlobalStrategyResearchRecord,
  createLiteratureStudy,
  createResearchSourceMetadata,
  createStrategyEvidenceTierLedger,
} from "../src/global-alpha-literature-registry-v1.js";
import {
  buildScannerStrategyEvidenceAdvisory,
  buildStrategyEvidenceReadModel,
  createCrossMarketTransferAssessment,
  verifyStrategyEvidenceReadModel,
} from "../src/strategy-evidence-read-model-v1.js";

const identity = {
  strategyId: "global-momentum-v1",
  strategyFamilyId: "strategy-family:global-momentum",
  strategyVersion: "v1",
  parameterHash: "params-v1",
  researchCodeSha: "0123456789abcdef0123456789abcdef01234567",
  market: "US_STOCK",
  direction: "LONG",
  timeframe: "1d",
  costPolicyVersion: "us-cost-v1",
};

function externalRecord(market = "US_STOCK") {
  const study = {
    studyId: `source-${market}`,
    title: `Momentum in ${market}`,
    authors: ["Researcher"],
    venue: "Journal Fixture",
    doi: `10.1234/read.${market.toLowerCase()}`,
    sourceUrl: `https://example.test/${market.toLowerCase()}`,
    market,
    strategyFamily: "GLOBAL_MOMENTUM",
    strategySummary: "Momentum hypothesis",
    sample: { startDate: "2000-01-01", endDate: "2020-12-31", observationCount: 10000 },
    reportedMetrics: { sharpe: 1.2 },
  };
  const source = {
    sourceType: "ACADEMIC_PAPER",
    publicationDate: "2021-01-01",
    assetClass: "EQUITY",
    marketsStudied: [market],
    sampleN: 10000,
    timeframe: "1d",
    horizon: "20d",
    transactionCostAssumptions: { totalBps: 10 },
    statedLimitations: ["capacity unknown"],
    datasetReference: { datasetId: `${market}-dataset` },
    licenseStatus: "REVIEW_REQUIRED",
    provenanceStatus: "DOCUMENTED",
    sourceProvenance: { locator: "paper" },
    ingestionTimestamp: "2026-08-21T00:00:00Z",
    parserVersion: "fixture-v1",
  };
  const metadata = createResearchSourceMetadata({ study: createLiteratureStudy(study), source });
  const supported = (value, locator) => ({ value, extractionStatus: "SUPPORTED", confidence: "HIGH", sourceProvenance: { researchSourceId: metadata.researchSourceId, locator } });
  return createGlobalStrategyResearchRecord({
    study,
    source,
    paperGenome: {
      market: supported(market, "methods:market"),
      timeframe: supported("1d", "methods:timeframe"),
      direction: supported("LONG", "methods:direction"),
      features: supported(["momentum"], "methods:features"),
      entryRule: supported("positive trailing return", "methods:entry"),
      exitRule: supported("rebalance", "methods:exit"),
      costAssumptions: supported({ totalBps: 10 }, "methods:cost"),
    },
  });
}

function recordIdentity(record = externalRecord()) {
  return { ...identity, strategyFamilyId: record.strategyDna.strategyFamilyId };
}

function entry(evidenceKind, overrides = {}) {
  const natural = new Set(["OUR_NATURAL_SHADOW", "OUR_NATURAL_PAPER", "OUR_SETTLEMENT"]).has(evidenceKind);
  return {
    evidenceKind,
    sampleCount: 10,
    sourceFingerprint: `${evidenceKind.toLowerCase()}-source-v1`,
    evaluationSliceId: `${evidenceKind.toLowerCase()}-slice-v1`,
    resultStatus: "RECORDED",
    ...(natural ? { naturalObservationAt: "2026-08-21T01:00:00Z", sourceRuntime: "RESEARCH_PRODUCTION_PRIMARY", historicalBackfill: false } : {}),
    ...overrides,
  };
}

test("uncollected counts and metrics remain null instead of fake zero", () => {
  const ledger = createStrategyEvidenceTierLedger({ identity });
  const readModel = buildStrategyEvidenceReadModel({ ledger });
  assert.equal(readModel.counts.ourPaperN.status, "NOT_COLLECTED");
  assert.equal(readModel.counts.ourPaperN.value, null);
  assert.equal(readModel.canonicalSettledMetrics.profitFactor.status, "NOT_COLLECTED");
  assert.equal(readModel.canonicalSettledMetrics.profitFactor.value, null);
  assert.equal(readModel.stages.finalHoldout.status, "NOT_COLLECTED");
});

test("external N and our natural Paper N are presented in separate sections", () => {
  const record = externalRecord();
  let ledger = createStrategyEvidenceTierLedger({ identity: recordIdentity(record) });
  ledger = appendStrategyEvidenceTierEntry(ledger, entry("EXTERNAL_REPORTED_EVIDENCE", { sampleCount: 10000, reportedMetrics: { sharpe: 1.2 } }));
  ledger = appendStrategyEvidenceTierEntry(ledger, entry("OUR_NATURAL_PAPER", { sampleCount: 50, deterministicMetrics: { netReturn: -0.01 } }));
  const readModel = buildStrategyEvidenceReadModel({ ledger, researchRecords: [record] });
  assert.equal(readModel.whatOtherResearchFound.externalPaperN.value, 10000);
  assert.equal(readModel.counts.ourPaperN.value, 50);
  assert.equal(readModel.externalAndOurSamplesCombined, false);
  assert.equal(readModel.externalSources[0].reportedMetrics.sharpe, 1.2);
  assert.equal(readModel.whatOurSystemVerified.stages.paper.sampleN, 50);
});

test("read model rejects family and cross-market identity drift", () => {
  const record = externalRecord();
  const wrongFamilyLedger = createStrategyEvidenceTierLedger({ identity: { ...identity, strategyFamilyId: "strategy-family:other" } });
  assert.throws(() => buildStrategyEvidenceReadModel({ ledger: wrongFamilyLedger, researchRecords: [record] }), /FAMILY_ID_MISMATCH/);
  const krRecord = externalRecord("KR_STOCK");
  const ledger = createStrategyEvidenceTierLedger({ identity: { ...identity, strategyFamilyId: krRecord.strategyDna.strategyFamilyId } });
  assert.throws(() => buildStrategyEvidenceReadModel({ ledger, researchRecords: [krRecord] }), /CROSS_MARKET_EVIDENCE_REQUIRES_TRANSFER/);
});

test("explicit settled numeric zero stays zero while missing metrics stay missing", () => {
  let ledger = createStrategyEvidenceTierLedger({ identity });
  ledger = appendStrategyEvidenceTierEntry(ledger, entry("OUR_SETTLEMENT", {
    sampleCount: 12,
    deterministicMetrics: { netReturn: 0, profitFactor: 1.1 },
  }));
  const readModel = buildStrategyEvidenceReadModel({ ledger });
  assert.equal(readModel.canonicalSettledMetrics.netReturn.status, "RECORDED");
  assert.equal(readModel.canonicalSettledMetrics.netReturn.value, 0);
  assert.equal(readModel.canonicalSettledMetrics.profitFactor.value, 1.1);
  assert.equal(readModel.canonicalSettledMetrics.expectedValue.status, "MISSING");
  assert.equal(readModel.canonicalSettledMetrics.expectedValue.value, null);
});

test("Scanner advisory preserves one identity, false eligibility, and NO_TRADE", () => {
  let ledger = createStrategyEvidenceTierLedger({ identity });
  ledger = appendStrategyEvidenceTierEntry(ledger, entry("OUR_OOS", { deterministicMetrics: { status: "PASS" } }));
  const readModel = buildStrategyEvidenceReadModel({ ledger, advisory: { statisticalStatus: "EVIDENCE_READY", strategyHealth: "WATCH" } });
  const scanner = buildScannerStrategyEvidenceAdvisory(readModel);
  for (const field of ["strategyId", "strategyFamilyId", "strategyVersion", "parameterHash", "researchCodeSha", "market", "direction", "timeframe", "costPolicyVersion"]) {
    assert.equal(scanner[field], readModel.strategyIdentity[field], field);
  }
  assert.equal(scanner.eligibleForScannerResearchConsideration, false);
  assert.equal(scanner.noTradePreserved, true);
  assert.equal(scanner.existingDataHealthQuantProfitRiskGatesRequired, true);
  assert.equal(scanner.safety.executionAuthority, "NONE");
  assert.equal(verifyStrategyEvidenceReadModel(readModel), true);
  assert.throws(() => buildScannerStrategyEvidenceAdvisory({ ...readModel, eligibleForScannerResearchConsideration: true }), /READ_MODEL_INVALID/);
});

test("cross-market transfer without target replication remains NOT_VALIDATED", () => {
  const result = createCrossMarketTransferAssessment({
    sourceIdentity: identity,
    targetIdentity: { ...identity, market: "KR_STOCK" },
  });
  assert.equal(result.originalMarket, "US_STOCK");
  assert.equal(result.targetMarket, "KR_STOCK");
  assert.equal(result.transferStatus, "NOT_VALIDATED");
  assert.equal(result.transferEvidence, null);
  assert.equal(result.safety.targetMarketQualified, false);
});

test("recorded cross-market replication remains review-only and cannot auto-qualify", () => {
  const result = createCrossMarketTransferAssessment({
    sourceIdentity: identity,
    targetIdentity: { ...identity, market: "KR_STOCK" },
    transferEvidence: {
      originalMarket: "US_STOCK",
      targetMarket: "KR_STOCK",
      datasetFingerprint: "kr-point-in-time-v1",
      researchCodeSha: identity.researchCodeSha,
      costPolicyVersion: "kr-cost-v1",
      resultStatus: "REPLICATED",
    },
  });
  assert.equal(result.transferStatus, "TARGET_MARKET_REPLICATION_RECORDED_REVIEW_ONLY");
  assert.equal(result.transferEvidence.resultStatus, "REPLICATED");
  assert.match(result.transferEvidence.evidenceFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(result.safety.scannerEligible, false);
  assert.equal(result.safety.promotionEligible, false);
});

test("read model recomputes counts from immutable entries instead of trusting a count field", () => {
  let ledger = createStrategyEvidenceTierLedger({ identity });
  ledger = appendStrategyEvidenceTierEntry(ledger, entry("OUR_NATURAL_PAPER", { sampleCount: 7, deterministicMetrics: { netReturn: 0 } }));
  const readModel = buildStrategyEvidenceReadModel({ ledger: { ...ledger, counts: { ...ledger.counts, ourPaperN: 999 } } });
  assert.equal(readModel.counts.ourPaperN.value, 7);
  assert.notEqual(readModel.counts.ourPaperN.value, 999);
});
