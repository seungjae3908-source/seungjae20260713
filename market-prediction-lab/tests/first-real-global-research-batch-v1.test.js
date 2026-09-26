import assert from "node:assert/strict";
import test from "node:test";

import {
  appendGlobalStrategyResearchRecord,
  verifyGlobalStrategyResearchRegistry,
} from "../src/global-alpha-literature-registry-v1.js";
import {
  auditFirstRealGlobalResearchDedup,
  buildFirstRealGlobalResearchBatch,
  firstRealGlobalResearchSourceSpecs,
} from "../src/first-real-global-research-batch-v1.js";

test("ingests three real peer-reviewed studies with provenance-bound genomes and DNA", () => {
  const batch = buildFirstRealGlobalResearchBatch();
  assert.equal(verifyGlobalStrategyResearchRegistry(batch.registry), true);
  assert.equal(batch.counts.realExternalSourcesIngested, 3);
  assert.equal(batch.counts.paperGenomeRealRecords, 3);
  assert.equal(batch.counts.strategyDnaRealRecords, 3);
  assert.equal(batch.registry.strategyFamilies.length, 3);
  assert.deepEqual(batch.registry.records.map((record) => record.literatureStudy.doi).sort(), [
    "10.1016/j.jfineco.2012.05.011",
    "10.1093/rfs/hhj020",
    "10.1111/j.1540-6261.1992.tb04681.x",
  ]);
  assert.ok(batch.registry.records.every((record) => record.sourceMetadata.sourceType === "PEER_REVIEWED_JOURNAL"));
  assert.ok(batch.registry.records.every((record) => record.sourceMetadata.sourceFingerprint.length === 64));
  assert.ok(batch.registry.records.every((record) => record.paperGenome.paperGenomeDigest.length === 64));
  assert.ok(batch.registry.records.every((record) => record.strategyDna.strategyDnaHash.startsWith("strategy-dna:")));
});

test("keeps the heterogeneous studies separate and computes a conservative dependence count", () => {
  const batch = buildFirstRealGlobalResearchBatch();
  assert.equal(batch.metaAnalysis.status, "NOT_COMPARABLE");
  assert.equal(batch.metaAnalysis.studyCount, 3);
  assert.equal(batch.metaAnalysis.effectiveStudyCount, 1);
  assert.equal(batch.metaAnalysis.reportedMetricsAggregationStatus, "NOT_AGGREGATED");
  assert.ok(batch.metaAnalysis.compatibilityReasons.includes("INCOMPATIBLE_STRATEGY_FAMILY"));
  assert.ok(batch.metaAnalysis.compatibilityReasons.includes("INDEPENDENCE_NOT_VERIFIED"));
  assert.equal(batch.metaAnalysis.pairwiseOverlap.length, 3);
  assert.equal(batch.metaAnalysis.safety.metaAnalysisCanProveProfitability, false);
});

test("records strict E1 separation and zero E2/E3/E4 before replication", () => {
  const batch = buildFirstRealGlobalResearchBatch();
  assert.deepEqual(batch.evidenceSeparation, {
    e1EvidenceSeparated: true,
    externalMetricsCanBecomeOurMetrics: false,
    externalSampleCanBecomeOurSample: false,
    e1Records: 3,
    e2Records: 0,
    e3Records: 0,
    e4Records: 0,
  });
  assert.equal(batch.counts.externalPaperN, 245);
  assert.equal(batch.counts.e2ReplicationN, 0);
  assert.equal(batch.counts.e3NaturalShadowN, 0);
  assert.equal(batch.counts.e4NaturalPaperN, 0);
  assert.equal(batch.safety.eligibleForScannerResearchConsideration, false);
  assert.equal(batch.safety.executionAuthority, "NONE");
});

test("prevents the same DOI from being ingested twice", () => {
  const audit = auditFirstRealGlobalResearchDedup();
  assert.equal(audit.ingestionAttempts, 4);
  assert.equal(audit.acceptedSources, 3);
  assert.equal(audit.duplicatePreventedCount, 1);
  assert.equal(audit.duplicateRejected, true);
  assert.match(audit.rejectionReason, /^DUPLICATE_RESEARCH_SOURCE:/);

  const batch = buildFirstRealGlobalResearchBatch();
  const spec = firstRealGlobalResearchSourceSpecs()[0];
  const record = batch.registry.records[0];
  assert.throws(() => appendGlobalStrategyResearchRecord(batch.registry, {
    study: spec.study,
    source: { ...spec.source, ingestionTimestamp: batch.ingestionTimestamp },
    paperGenome: Object.fromEntries(Object.entries(record.paperGenome.fields).filter(([, field]) => field.extractionStatus !== "NOT_REPORTED")),
  }), /DUPLICATE_RESEARCH_SOURCE|sourceProvenance/);
});

test("uses immutable fingerprints for the two official external archives without redistributing raw data", () => {
  const batch = buildFirstRealGlobalResearchBatch();
  assert.equal(batch.sourceArchives.frenchMomentumArchiveSha256, "2bee31ed74c88f01bc8c8b33327c2a8506901d1f95a3785b3237f84cfcd25109");
  assert.equal(batch.sourceArchives.frenchSixPortfolioArchiveSha256, "75f6548f9a5de5ee90d7836fe2ae2deef38525fccb67304724cdfd135575f6ee");
  assert.equal(batch.sourceArchives.rawArchivesCommitted, false);
});
