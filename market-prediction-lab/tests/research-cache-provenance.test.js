import test from "node:test";
import assert from "node:assert/strict";
import {
  CACHE_REUSE_STATUS,
  RESEARCH_DATASET_IDENTITY_SCHEMA_VERSION,
  buildHistoricalCacheProvenance,
  buildResearchDatasetIdentity,
  buildStrategyResultCacheProvenance,
  sha256Canonical,
  validateCacheReuse,
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
