import test from "node:test";
import assert from "node:assert/strict";
import {
  CACHE_REUSE_STATUS,
  REFERENCE_EVIDENCE_STATUS,
  RESEARCH_COMPOSITE_DATASET_PROVENANCE_SCHEMA_VERSION,
  RESEARCH_DATASET_IDENTITY_SCHEMA_VERSION,
  RESEARCH_REFERENCE_ARTIFACT_RECEIPT_SCHEMA_VERSION,
  RESEARCH_REFERENCE_EVIDENCE_SCHEMA_VERSION,
  buildCompositeDatasetProvenance,
  buildHistoricalCacheProvenance,
  buildReferenceArtifactReceipt,
  buildReferenceEvidenceProvenance,
  buildResearchDatasetIdentity,
  buildStrategyResultCacheProvenance,
  compareReferenceEvidenceProvenance,
  sha256Canonical,
  validateCacheReuse,
  validateCompositeDatasetProvenance,
  validateReferenceArtifactReceipt,
  validateReferenceEvidenceProvenance,
  validateResearchDatasetIdentity,
} from "../src/research-cache-provenance.js";

const DAY = 24 * 60 * 60 * 1000;
const START = Date.UTC(2020, 0, 1);
const END = START + (2 * DAY);
const RESEARCH_SHA = "1".repeat(40);
const NEXT_RESEARCH_SHA = "2".repeat(40);
const SOURCE_DIGEST = "a".repeat(64);

function rows(closeOverride = null) {
  return [0, 1, 2].map((index) => ({
    timestamp: START + (index * DAY),
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: index === 2 && closeOverride != null ? closeOverride : 101 + index,
    volume: 1_000 + index,
  }));
}

function splitContract(overrides = {}) {
  return {
    version: "purged-walk-forward-v1",
    development: { start: START, end: START + DAY },
    oos: { start: START + (2 * DAY), end: END },
    purgeBars: 1,
    ...overrides,
  };
}

function identity(overrides = {}) {
  return buildResearchDatasetIdentity({
    market: "CRYPTO_FUTURES",
    symbol: "BTCUSDT",
    timeframe: "1d",
    provider: "binance-usdm-public-rest",
    providerVersion: "fapi-v1",
    sourceType: "public_rest_ohlcv",
    requestedStart: START,
    requestedEnd: END,
    actualStart: START,
    actualEnd: END,
    candleCount: 3,
    adjustmentMode: "none",
    corporateActionMode: "not_applicable",
    timezone: "UTC",
    splitContract: splitContract(),
    sourceDigest: SOURCE_DIGEST,
    researchCodeSha: RESEARCH_SHA,
    loaderVersion: "binance-futures-history-v1",
    generatedAt: "2026-08-24T07:00:00.000Z",
    missingIntervalCount: 0,
    duplicateRowCount: 0,
    dataQualityStatus: "VERIFIED",
    rows: rows(),
    ...overrides,
  });
}

function historical(identityOverrides = {}, cacheOverrides = {}) {
  return buildHistoricalCacheProvenance({
    datasetIdentity: identity(identityOverrides),
    closedCandlesOnly: true,
    duplicatesHandled: true,
    missingIntervalsDetected: true,
    ...cacheOverrides,
  });
}

function reference(overrides = {}) {
  const { artifactReceipt: receiptOverrides = {}, ...evidenceOverrides } = overrides;
  const composite = buildCompositeDatasetProvenance({
    datasetId: "futures-btc-long",
    components: {
      candles: SOURCE_DIGEST,
      funding: "b".repeat(64),
    },
  });
  const artifactReceipt = buildReferenceArtifactReceipt({
    artifactId: "9552811517",
    artifactName: "prediction-lab-train-validation-reference",
    artifactReference: "actions://9552811517",
    outerArtifactDigest: "c".repeat(64),
    createdAt: "2026-08-25T00:00:00.000Z",
    expiresAt: "2026-11-23T00:00:00.000Z",
    ...receiptOverrides,
  });
  return buildReferenceEvidenceProvenance({
    datasetId: composite.datasetId,
    datasetDigest: composite.datasetDigest,
    strategyIdentityDigest: "d".repeat(64),
    researchCodeSha: RESEARCH_SHA,
    trainingCodeSha: NEXT_RESEARCH_SHA,
    modelSha: "e".repeat(64),
    preprocessingVersion: "prediction-features-v1",
    featureOrderDigest: "f".repeat(64),
    trainSplitDigest: "1".repeat(64),
    validationSplitDigest: "2".repeat(64),
    rawArtifactDigest: "3".repeat(64),
    measuredAt: "2026-08-25T00:15:00.000Z",
    ...evidenceOverrides,
    artifactReceipt,
  });
}

test("same dataset produces the same deterministic identity", () => {
  const first = identity();
  const second = identity({ generatedAt: "2026-08-24T08:00:00.000Z" });
  assert.equal(first.schemaVersion, RESEARCH_DATASET_IDENTITY_SCHEMA_VERSION);
  assert.equal(first.datasetDigest, second.datasetDigest);
  assert.equal(first.datasetIdentityId, second.datasetIdentityId);
  assert.equal(validateResearchDatasetIdentity(first).valid, true);
});

test("object property insertion order does not change canonical digests", () => {
  const firstRows = rows();
  const reorderedRows = firstRows.map((row) => ({ volume: row.volume, close: row.close, low: row.low, high: row.high, open: row.open, timestamp: row.timestamp }));
  const first = identity();
  const reordered = identity({
    rows: reorderedRows,
    splitContract: {
      purgeBars: 1,
      oos: { end: END, start: START + (2 * DAY) },
      development: { end: START + DAY, start: START },
      version: "purged-walk-forward-v1",
    },
  });
  assert.equal(sha256Canonical({ b: 2, a: { y: 2, x: 1 } }), sha256Canonical({ a: { x: 1, y: 2 }, b: 2 }));
  assert.equal(first.datasetDigest, reordered.datasetDigest);
  assert.equal(first.datasetIdentityId, reordered.datasetIdentityId);
});

test("symbol change produces a different identity", () => {
  assert.notEqual(identity().datasetIdentityId, identity({ symbol: "ETHUSDT" }).datasetIdentityId);
});

test("timeframe change produces a different identity", () => {
  assert.notEqual(identity().datasetIdentityId, identity({ timeframe: "4h" }).datasetIdentityId);
});

test("provider or provider version change produces a different identity", () => {
  const base = identity();
  assert.notEqual(base.datasetIdentityId, identity({ provider: "binance-vision-usdm-monthly" }).datasetIdentityId);
  assert.notEqual(base.datasetIdentityId, identity({ providerVersion: "vision-monthly-v2" }).datasetIdentityId);
});

test("loader contract change produces a different identity", () => {
  assert.notEqual(identity().datasetIdentityId, identity({ loaderVersion: "binance-futures-history-v2" }).datasetIdentityId);
});

test("requested or actual coverage change produces a different identity", () => {
  const base = identity();
  assert.notEqual(base.datasetIdentityId, identity({ requestedStart: START + 1 }).datasetIdentityId);
  assert.notEqual(base.datasetIdentityId, identity({ actualEnd: END - 1 }).datasetIdentityId);
});

test("a source data row change changes dataset and identity digests", () => {
  const base = identity();
  const changed = identity({ rows: rows(999) });
  assert.notEqual(base.datasetDigest, changed.datasetDigest);
  assert.notEqual(base.datasetIdentityId, changed.datasetIdentityId);
});

test("adjustment change produces a different identity", () => {
  assert.notEqual(identity().datasetIdentityId, identity({ adjustmentMode: "split_adjusted" }).datasetIdentityId);
});

test("research SHA change denies cache reuse", () => {
  const assessment = validateCacheReuse(historical(), historical({ researchCodeSha: NEXT_RESEARCH_SHA }));
  assert.equal(assessment.CACHE_REUSE_ALLOWED, false);
  assert.equal(assessment.CACHE_STATUS, CACHE_REUSE_STATUS.IDENTITY_MISMATCH);
});

test("split contract change denies cache reuse", () => {
  const assessment = validateCacheReuse(historical(), historical({ splitContract: splitContract({ purgeBars: 2 }) }));
  assert.equal(assessment.cacheReuseAllowed, false);
  assert.equal(assessment.cacheStatus, CACHE_REUSE_STATUS.IDENTITY_MISMATCH);
});

test("missing cache provenance fails closed as MISSING_EVIDENCE", () => {
  const expected = historical();
  for (const missing of [null, {}, { cacheType: "historical_raw" }]) {
    const assessment = validateCacheReuse(expected, missing);
    assert.equal(assessment.CACHE_REUSE_ALLOWED, false);
    assert.equal(assessment.CACHE_STATUS, CACHE_REUSE_STATUS.MISSING_EVIDENCE);
  }
});

test("stale dataset cache fails closed", () => {
  const assessment = validateCacheReuse(historical(), historical({ rows: rows(777) }));
  assert.equal(assessment.CACHE_REUSE_ALLOWED, false);
  assert.equal(assessment.CACHE_STATUS, CACHE_REUSE_STATUS.IDENTITY_MISMATCH);
});

test("valid exact cache is reusable even when generatedAt differs", () => {
  const expected = historical();
  const actual = historical({ generatedAt: "2026-08-24T09:00:00.000Z" });
  assert.equal(expected.cacheKey, actual.cacheKey);
  assert.deepEqual(validateCacheReuse(expected, actual), {
    reusable: true,
    reason: null,
    cacheReuseAllowed: true,
    cacheStatus: CACHE_REUSE_STATUS.EXACT_IDENTITY_MATCH,
    CACHE_REUSE_ALLOWED: true,
    CACHE_STATUS: CACHE_REUSE_STATUS.EXACT_IDENTITY_MATCH,
  });
});

test("malformed cache record fails closed without throwing", () => {
  const expected = historical();
  const malformed = { ...expected, datasetIdentity: { ...expected.datasetIdentity, provider: null } };
  assert.doesNotThrow(() => validateCacheReuse(expected, malformed));
  const assessment = validateCacheReuse(expected, malformed);
  assert.equal(assessment.CACHE_REUSE_ALLOWED, false);
  assert.equal(assessment.CACHE_STATUS, CACHE_REUSE_STATUS.MISSING_EVIDENCE);
});

test("missing provider, coverage, digest, or research SHA evidence fails closed", () => {
  const expected = historical();
  for (const field of ["provider", "actualStart", "datasetDigest", "researchCodeSha"]) {
    const incompleteIdentity = { ...expected.datasetIdentity, [field]: undefined };
    const incomplete = { ...expected, datasetIdentity: incompleteIdentity, identity: incompleteIdentity };
    const assessment = validateCacheReuse(expected, incomplete);
    assert.equal(assessment.CACHE_REUSE_ALLOWED, false, field);
    assert.equal(assessment.CACHE_STATUS, CACHE_REUSE_STATUS.MISSING_EVIDENCE, field);
  }
});

test("tampered cache identity digest fails closed as IDENTITY_MISMATCH", () => {
  const expected = historical();
  const tamperedIdentity = { ...expected.datasetIdentity, datasetDigest: "f".repeat(64) };
  const tampered = { ...expected, datasetIdentity: tamperedIdentity, identity: tamperedIdentity };
  const assessment = validateCacheReuse(expected, tampered);
  assert.equal(assessment.CACHE_REUSE_ALLOWED, false);
  assert.equal(assessment.CACHE_STATUS, CACHE_REUSE_STATUS.IDENTITY_MISMATCH);
});

test("missing optional quality evidence remains null instead of becoming zero", () => {
  const result = identity({ missingIntervalCount: undefined, duplicateRowCount: undefined, dataQualityStatus: undefined });
  assert.equal(result.missingIntervalCount, null);
  assert.equal(result.duplicateRowCount, null);
  assert.equal(result.dataQualityStatus, CACHE_REUSE_STATUS.MISSING_EVIDENCE);
});

test("strategy result cache carries canonical dataset lineage", () => {
  const history = historical();
  const base = buildStrategyResultCacheProvenance({
    historicalCacheProvenance: history,
    researchCodeSha: RESEARCH_SHA,
    strategyVersion: "V1",
    parameters: { slow: 50, fast: 20 },
    costModel: { exitFeeRate: 0.0006, entryFeeRate: 0.0006 },
    splitContract: splitContract(),
    direction: "LONG",
  });
  const same = buildStrategyResultCacheProvenance({
    historicalCacheProvenance: history,
    researchCodeSha: RESEARCH_SHA,
    strategyVersion: "V1",
    parameters: { fast: 20, slow: 50 },
    costModel: { entryFeeRate: 0.0006, exitFeeRate: 0.0006 },
    splitContract: { purgeBars: 1, version: "purged-walk-forward-v1", oos: { end: END, start: START + (2 * DAY) }, development: { end: START + DAY, start: START } },
    direction: "LONG",
  });
  assert.equal(base.identity.datasetIdentityId, history.datasetIdentity.datasetIdentityId);
  assert.equal(base.identity.datasetDigest, history.datasetIdentity.datasetDigest);
  assert.equal(validateCacheReuse(base, same).CACHE_REUSE_ALLOWED, true);
});

test("composite dataset provenance is deterministic and binds every component digest", () => {
  const components = { funding: "b".repeat(64), candles: SOURCE_DIGEST };
  const first = buildCompositeDatasetProvenance({ datasetId: "futures-btc-long", components });
  const reordered = buildCompositeDatasetProvenance({ datasetId: "futures-btc-long", components: { candles: SOURCE_DIGEST, funding: "b".repeat(64) } });
  assert.equal(first.schemaVersion, RESEARCH_COMPOSITE_DATASET_PROVENANCE_SCHEMA_VERSION);
  assert.equal(first.datasetDigest, reordered.datasetDigest);
  assert.equal(first.componentCount, 2);
  assert.deepEqual(components, { funding: "b".repeat(64), candles: SOURCE_DIGEST });
  assert.equal(Object.isFrozen(first), true);
  assert.equal(validateCompositeDatasetProvenance(first).valid, true);
  assert.notEqual(first.datasetDigest, buildCompositeDatasetProvenance({ datasetId: "futures-btc-long", components: { candles: SOURCE_DIGEST, funding: "9".repeat(64) } }).datasetDigest);
});

test("reference artifact receipt separates outer upload evidence from raw reference bytes", () => {
  const receipt = buildReferenceArtifactReceipt({
    artifactId: "9552811517",
    artifactName: "prediction-lab-train-validation-reference",
    artifactReference: "actions://9552811517",
    outerArtifactDigest: "c".repeat(64),
    createdAt: "2026-08-25T00:00:00.000Z",
    expiresAt: "2026-11-23T00:00:00.000Z",
  });
  assert.equal(receipt.schemaVersion, RESEARCH_REFERENCE_ARTIFACT_RECEIPT_SCHEMA_VERSION);
  assert.equal(validateReferenceArtifactReceipt(receipt, { now: "2026-08-25T01:00:00.000Z" }).valid, true);
  assert.equal(validateReferenceArtifactReceipt(receipt, { now: "2026-11-23T00:00:00.000Z" }).status, REFERENCE_EVIDENCE_STATUS.REFERENCE_EXPIRED);
  assert.equal(Object.isFrozen(receipt), true);
});

test("reference evidence binds dataset, strategy, code, model, preprocessing, splits, raw artifact and receipt", () => {
  const provenance = reference();
  assert.equal(provenance.schemaVersion, RESEARCH_REFERENCE_EVIDENCE_SCHEMA_VERSION);
  assert.equal(provenance.trainingCodeSha, NEXT_RESEARCH_SHA);
  assert.equal(provenance.preprocessingVersion, "prediction-features-v1");
  assert.equal(provenance.rawArtifactDigest, "3".repeat(64));
  assert.equal(provenance.artifactReceipt.outerArtifactDigest, "c".repeat(64));
  assert.notEqual(provenance.rawArtifactDigest, provenance.artifactReceipt.outerArtifactDigest);
  assert.equal(validateReferenceEvidenceProvenance(provenance, { now: "2026-08-25T01:00:00.000Z" }).valid, true);
  assert.equal(Object.isFrozen(provenance), true);
  assert.equal(Object.isFrozen(provenance.artifactReceipt), true);
});

test("reference evidence tampering and missing evidence fail closed", () => {
  const provenance = reference();
  const tampered = { ...provenance, trainSplitDigest: "4".repeat(64) };
  const tamperedAssessment = validateReferenceEvidenceProvenance(tampered, { now: "2026-08-25T01:00:00.000Z" });
  assert.equal(tamperedAssessment.valid, false);
  assert.equal(tamperedAssessment.status, REFERENCE_EVIDENCE_STATUS.IDENTITY_MISMATCH);

  const missing = { ...provenance, preprocessingVersion: undefined };
  const missingAssessment = validateReferenceEvidenceProvenance(missing, { now: "2026-08-25T01:00:00.000Z" });
  assert.equal(missingAssessment.valid, false);
  assert.equal(missingAssessment.status, REFERENCE_EVIDENCE_STATUS.MISSING_EVIDENCE);
});

test("another model or split cannot reuse reference evidence", () => {
  const expected = reference();
  const otherModel = reference({ modelSha: "9".repeat(64) });
  const otherSplit = reference({ validationSplitDigest: "8".repeat(64) });
  assert.deepEqual(compareReferenceEvidenceProvenance(expected, expected, { now: "2026-08-25T01:00:00.000Z" }), {
    match: true,
    status: REFERENCE_EVIDENCE_STATUS.EXACT_IDENTITY_MATCH,
    reason: null,
  });
  assert.equal(compareReferenceEvidenceProvenance(expected, otherModel, { now: "2026-08-25T01:00:00.000Z" }).status, REFERENCE_EVIDENCE_STATUS.IDENTITY_MISMATCH);
  assert.equal(compareReferenceEvidenceProvenance(expected, otherSplit, { now: "2026-08-25T01:00:00.000Z" }).status, REFERENCE_EVIDENCE_STATUS.IDENTITY_MISMATCH);
});

test("reference expiry fails closed without reconstructing missing evidence", () => {
  const provenance = reference();
  const assessment = validateReferenceEvidenceProvenance(provenance, { now: "2026-12-01T00:00:00.000Z" });
  assert.equal(assessment.valid, false);
  assert.equal(assessment.status, REFERENCE_EVIDENCE_STATUS.REFERENCE_EXPIRED);
});
