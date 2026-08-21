import assert from "node:assert/strict";
import test from "node:test";

import {
  createGlobalStrategyResearchRecord,
  createLiteratureStudy,
  createResearchSourceMetadata,
} from "../src/global-alpha-literature-registry-v1.js";
import {
  buildExternalEvidenceMetaAnalysis,
  buildNormalNormalResearchUpdate,
  compareExternalStudyOverlap,
  createExternalStudyEvidence,
} from "../src/external-evidence-meta-analysis-v1.js";

function record({
  suffix,
  datasetId,
  startDate,
  endDate,
  authors = [`Author ${suffix}`],
  market = "US_STOCK",
  timeframe = "1d",
  entryRule = "rank top decile",
} = {}) {
  const study = {
    studyId: `study-${suffix}`,
    title: `Momentum Study ${suffix}`,
    authors,
    venue: "Journal Fixture",
    publishedYear: 2025,
    doi: `10.1234/meta.${suffix}`,
    sourceUrl: `https://example.test/meta-${suffix}`,
    market,
    strategyFamily: "MOMENTUM_VOLUME",
    strategySummary: "Cross-sectional momentum with volume confirmation.",
    formulaSummary: "rank 12-1 return and volume",
    sample: { startDate, endDate, observationCount: 1_000, assetCount: 500 },
    reportedMetrics: { annualReturnPct: 12, sharpe: 1.2, maxDrawdownPct: -18 },
    validation: { outOfSample: true, transactionCostsIncluded: true },
  };
  const source = {
    sourceType: "ACADEMIC_PAPER",
    publicationDate: "2025-06-01",
    assetClass: "EQUITY",
    marketsStudied: [market],
    sampleN: 1_000,
    timeframe,
    horizon: "1 month",
    strategyConcept: "momentum-volume",
    transactionCostAssumptions: { totalBps: 10 },
    statedLimitations: ["capacity not established"],
    datasetReference: { datasetId, access: "METADATA_ONLY" },
    licenseStatus: "REVIEW_REQUIRED",
    provenanceStatus: "DOCUMENTED",
    sourceProvenance: { acquisition: "USER_SUPPLIED_METADATA", locator: "paper" },
    ingestionTimestamp: "2026-08-21T00:00:00Z",
    parserVersion: "fixture-v1",
  };
  const literature = createLiteratureStudy(study);
  const metadata = createResearchSourceMetadata({ study: literature, source });
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
      market: supported(market, "methods:market"),
      assetClass: supported("EQUITY", "methods:asset"),
      timeframe: supported(timeframe, "methods:timeframe"),
      direction: supported("LONG_SHORT", "methods:direction"),
      features: supported(["momentum", "volume"], "methods:features"),
      entryRule: supported(entryRule, "methods:entry"),
      exitRule: supported("rebalance monthly", "methods:exit"),
      costAssumptions: supported({ totalBps: 10 }, "methods:costs"),
      parameterStructure: supported({ lookbackMonths: 12, skipMonths: 1 }, "methods:parameters"),
    },
  });
}

function studyEvidence(researchRecord, overrides = {}) {
  return createExternalStudyEvidence({
    researchRecord,
    effectEvidence: {
      metric: "STANDARDIZED_MONTHLY_RETURN",
      effectDefinition: "long-short standardized mean return",
      effectScale: "STANDARD_DEVIATIONS",
      estimate: 1,
      standardError: 1,
      direction: "POSITIVE",
      market: researchRecord.sourceMetadata.market,
      timeframe: researchRecord.sourceMetadata.timeframe,
      costAssumptionFingerprint: "cost-10bps-v1",
      ...overrides.effectEvidence,
    },
    independenceEvidence: overrides.independenceEvidence ?? { status: "NOT_ESTABLISHED" },
  });
}

test("same dataset and overlapping period are one dependent evidence cluster", () => {
  const left = studyEvidence(record({ suffix: "a", datasetId: "crsp-v1", startDate: "2000-01-01", endDate: "2020-12-31" }));
  const right = studyEvidence(record({ suffix: "b", datasetId: "crsp-v1", startDate: "2005-01-01", endDate: "2020-12-31" }));
  const overlap = compareExternalStudyOverlap(left, right);
  assert.equal(overlap.sameDataset, true);
  assert.equal(overlap.overlapCategory, "DUPLICATE_SAMPLE");
  assert.equal(overlap.independenceStatus, "NOT_INDEPENDENT");
  assert.equal(overlap.overlapScore, null);
  assert.equal(overlap.overlapScoreStatus, "NOT_COMPUTED_WITHOUT_CALIBRATED_WEIGHTS");

  const meta = buildExternalEvidenceMetaAnalysis([left, right]);
  assert.equal(meta.status, "NOT_COMPARABLE");
  assert.equal(meta.effectiveStudyCount, 1);
  assert.equal(meta.pooledEffect, null);
  assert.ok(meta.compatibilityReasons.includes("STUDY_OR_SAMPLE_OVERLAP_DETECTED"));
});

test("same strategy family is deduplicated as one discovery but can pool verified independent samples", () => {
  const left = studyEvidence(
    record({ suffix: "c", datasetId: "dataset-c", startDate: "1990-01-01", endDate: "1999-12-31" }),
    { independenceEvidence: { status: "VERIFIED_INDEPENDENT", provenance: "independent dataset audit c" } },
  );
  const right = studyEvidence(
    record({ suffix: "d", datasetId: "dataset-d", startDate: "2010-01-01", endDate: "2020-12-31" }),
    {
      effectEvidence: { estimate: 3, standardError: 1 },
      independenceEvidence: { status: "VERIFIED_INDEPENDENT", provenance: "independent dataset audit d" },
    },
  );
  const overlap = compareExternalStudyOverlap(left, right);
  assert.equal(overlap.overlapCategory, "STRATEGY_FAMILY_OVERLAP_ONLY");

  const meta = buildExternalEvidenceMetaAnalysis([left, right]);
  assert.equal(meta.status, "POOLED_FIXED_EFFECT");
  assert.equal(meta.studyCount, 2);
  assert.equal(meta.effectiveStudyCount, 2);
  assert.equal(meta.pooledEffect.pooledEstimate, 2);
  assert.ok(Math.abs(meta.pooledEffect.pooledStandardError - Math.sqrt(0.5)) < 1e-12);
  assert.equal(meta.pooledEffect.cochranQ, 2);
  assert.equal(meta.pooledEffect.iSquaredPct, 50);
  assert.equal(meta.pooledEffect.pValue, null);
  assert.equal(meta.pooledEffect.pValueStatus, "NOT_IMPLEMENTED");
});

test("unverified independence blocks pooling even when no sample overlap is known", () => {
  const left = studyEvidence(record({ suffix: "e", datasetId: "dataset-e", startDate: "1990-01-01", endDate: "1999-12-31" }));
  const right = studyEvidence(record({ suffix: "f", datasetId: "dataset-f", startDate: "2010-01-01", endDate: "2020-12-31" }));
  const meta = buildExternalEvidenceMetaAnalysis([left, right]);
  assert.equal(meta.status, "NOT_COMPARABLE");
  assert.ok(meta.compatibilityReasons.includes("INDEPENDENCE_NOT_VERIFIED"));
  assert.equal(meta.pooledEffect, null);
});

test("Sharpe, PF and incompatible effect scales are never blindly averaged", () => {
  const left = studyEvidence(
    record({ suffix: "g", datasetId: "dataset-g", startDate: "1990-01-01", endDate: "1999-12-31" }),
    { independenceEvidence: { status: "VERIFIED_INDEPENDENT", provenance: "audit g" } },
  );
  const right = studyEvidence(
    record({ suffix: "h", datasetId: "dataset-h", startDate: "2010-01-01", endDate: "2020-12-31" }),
    {
      effectEvidence: { metric: "SHARPE", effectDefinition: "reported Sharpe", effectScale: "RATIO" },
      independenceEvidence: { status: "VERIFIED_INDEPENDENT", provenance: "audit h" },
    },
  );
  const meta = buildExternalEvidenceMetaAnalysis([left, right]);
  assert.equal(meta.status, "NOT_COMPARABLE");
  assert.ok(meta.compatibilityReasons.includes("INCOMPATIBLE_METRIC"));
  assert.ok(meta.compatibilityReasons.includes("INCOMPATIBLE_EFFECTSCALE"));
  assert.equal(meta.reportedMetricsAggregationStatus, "NOT_AGGREGATED");
});

test("raw external sample total remains E1 and never becomes our canonical N", () => {
  const only = studyEvidence(record({ suffix: "i", datasetId: "dataset-i", startDate: "2000-01-01", endDate: "2020-12-31" }));
  const meta = buildExternalEvidenceMetaAnalysis([only]);
  assert.equal(meta.status, "INSUFFICIENT_EVIDENCE");
  assert.equal(meta.rawReportedSampleN, 1_000);
  assert.equal(meta.effectiveSampleN, null);
  assert.equal(meta.safety.evidenceTier, "E1");
  assert.equal(meta.safety.externalSampleCanBecomePaperSample, false);
  assert.equal(meta.profitabilityProven, false);
});

test("unsupported random-effects request is explicit NOT_IMPLEMENTED", () => {
  const only = studyEvidence(record({ suffix: "j", datasetId: "dataset-j", startDate: "2000-01-01", endDate: "2020-12-31" }));
  const meta = buildExternalEvidenceMetaAnalysis([only], { model: "RANDOM_EFFECTS" });
  assert.equal(meta.status, "NOT_IMPLEMENTED");
  assert.equal(meta.pooledEffect, null);
});

test("normal-normal Bayesian research update runs only on compatible explicit inputs", () => {
  const left = studyEvidence(
    record({ suffix: "k", datasetId: "dataset-k", startDate: "1990-01-01", endDate: "1999-12-31" }),
    { independenceEvidence: { status: "VERIFIED_INDEPENDENT", provenance: "audit k" } },
  );
  const right = studyEvidence(
    record({ suffix: "l", datasetId: "dataset-l", startDate: "2010-01-01", endDate: "2020-12-31" }),
    {
      effectEvidence: { estimate: 3, standardError: 1 },
      independenceEvidence: { status: "VERIFIED_INDEPENDENT", provenance: "audit l" },
    },
  );
  const meta = buildExternalEvidenceMetaAnalysis([left, right]);
  const update = buildNormalNormalResearchUpdate({
    externalMetaAnalysis: meta,
    ourReplication: {
      tier: "E2",
      effectDefinition: meta.effectDefinition,
      effectScale: meta.effectScale,
      estimate: 1,
      standardError: 1,
    },
  });
  assert.equal(update.status, "RESEARCH_PRIOR_UPDATED_NORMAL_NORMAL");
  assert.ok(Math.abs(update.posterior.mean - (5 / 3)) < 1e-12);
  assert.ok(Math.abs(update.posterior.standardError - Math.sqrt(1 / 3)) < 1e-12);
  assert.equal(update.posteriorProbability, null);
  assert.equal(update.profitabilityProven, false);
  assert.equal(update.naturalEvidenceRemainsAuthoritative, true);
});

test("negative Natural evidence prevents an external Bayesian prior from overriding current reality", () => {
  const update = buildNormalNormalResearchUpdate({
    externalMetaAnalysis: { status: "POOLED_FIXED_EFFECT" },
    ourReplication: { tier: "E2" },
    naturalEvidenceStatus: "REJECTED",
  });
  assert.equal(update.status, "BAYESIAN_UPDATE_NOT_APPLICABLE");
  assert.equal(update.reason, "NATURAL_EVIDENCE_CONTRADICTS_EXTERNAL_PRIOR");
  assert.equal(update.posterior, null);
  assert.equal(update.safety.bayesianPriorCanOverrideNaturalEvidence, false);
});
