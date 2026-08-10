import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHistoricalCacheProvenance,
  buildStrategyResultCacheProvenance,
  sha256Canonical,
  validateCacheReuse,
} from "../src/research-cache-provenance.js";

const SHA = "1234567890abcdef1234567890abcdef12345678";
const DIGEST = "a".repeat(64);
const MANIFEST = "b".repeat(64);

function historical(overrides = {}) {
  return buildHistoricalCacheProvenance({
    market: "CRYPTO_FUTURES",
    symbol: "BTCUSDT",
    timeframe: "1d",
    provider: "binance-vision-usdm-monthly",
    providerVersion: "vision-usdm-monthly-v1",
    requestedStartTime: Date.UTC(2020, 0, 1),
    requestedEndTime: Date.UTC(2025, 11, 31),
    adjustmentMode: "none",
    datasetDigest: DIGEST,
    providerManifestDigest: MANIFEST,
    researchCodeSha: SHA,
    candleCount: 2192,
    actualStartTime: Date.UTC(2020, 0, 1),
    actualEndTime: Date.UTC(2025, 11, 31),
    ...overrides,
  });
}

test("canonical digest is stable across object key order", () => {
  assert.equal(sha256Canonical({ b: 2, a: { y: 2, x: 1 } }), sha256Canonical({ a: { x: 1, y: 2 }, b: 2 }));
});

test("historical cache key binds full provider/data/code identity", () => {
  const first = historical();
  const same = historical();
  assert.equal(first.cacheKey, same.cacheKey);
  assert.equal(validateCacheReuse(first, same).reusable, true);
  assert.equal(first.guards.syntheticDataAllowed, false);
  assert.equal(first.identity.market, "CRYPTO_FUTURES");
  assert.equal(first.identity.providerVersion, "vision-usdm-monthly-v1");
  assert.equal(first.identity.adjustmentMode, "none");
  assert.equal(first.identity.datasetDigest, DIGEST);
  assert.equal(first.identity.researchCodeSha, SHA);
  assert.ok(first.cacheNamespace.startsWith("historical:"));

  for (const changed of [
    historical({ market: "US_STOCK" }),
    historical({ symbol: "ETHUSDT" }),
    historical({ timeframe: "4h" }),
    historical({ provider: "different-provider" }),
    historical({ providerVersion: "vision-usdm-monthly-v2" }),
    historical({ requestedStartTime: Date.UTC(2020, 0, 2) }),
    historical({ requestedEndTime: Date.UTC(2025, 11, 30) }),
    historical({ adjustmentMode: "split_adjusted" }),
    historical({ datasetDigest: "c".repeat(64) }),
    historical({ researchCodeSha: "f".repeat(40) }),
  ]) {
    assert.notEqual(first.cacheKey, changed.cacheKey);
  }
});

test("stock and crypto historical cache namespaces cannot collide", () => {
  const crypto = historical();
  const stock = historical({
    market: "US_STOCK",
    symbol: "AAPL",
    provider: "us-alpha-vantage-daily-adjusted-v1",
    providerVersion: "TIME_SERIES_DAILY_ADJUSTED",
    adjustmentMode: "adjusted_close_ratio_with_split_volume",
  });
  assert.notEqual(crypto.cacheNamespace, stock.cacheNamespace);
  assert.notEqual(crypto.cacheKey, stock.cacheKey);
});

test("historical cache refuses reuse if quality, identity, or synthetic-data guards are weakened", () => {
  const expected = historical();
  const weakened = { ...expected, guards: { ...expected.guards, closedCandlesOnly: false } };
  assert.equal(validateCacheReuse(expected, weakened).reason, "historical_quality_guard_failed");
  const synthetic = { ...expected, guards: { ...expected.guards, syntheticDataAllowed: true } };
  assert.equal(validateCacheReuse(expected, synthetic).reason, "synthetic_data_guard_failed");
  const identityWeakened = { ...expected, guards: { ...expected.guards, exactProviderVersionRequired: false } };
  assert.equal(validateCacheReuse(expected, identityWeakened).reason, "historical_identity_guard_failed");
  const otherNamespace = { ...expected, cacheNamespace: "historical:other" };
  assert.equal(validateCacheReuse(expected, otherNamespace).reason, "cache_namespace_mismatch");
});

test("historical cache requires provider version, dataset digest, adjustment mode and immutable code SHA", () => {
  assert.throws(() => historical({ providerVersion: "" }), /providerVersion is required/);
  assert.throws(() => historical({ datasetDigest: "bad" }), /datasetDigest must be a SHA-256 digest/);
  assert.throws(() => historical({ adjustmentMode: "" }), /adjustmentMode is required/);
  assert.throws(() => historical({ researchCodeSha: "bad" }), /researchCodeSha must be a 40-character commit SHA/);
});

test("strategy result cache binds code SHA, data, parameters, costs, split and direction", () => {
  const history = historical();
  const base = buildStrategyResultCacheProvenance({
    researchCodeSha: SHA,
    historicalCacheKey: history.cacheKey,
    strategyVersion: "V1",
    parameters: { fastPeriod: 20, slowPeriod: 50 },
    costModel: { entryFeeRate: 0.0006, exitFeeRate: 0.0006 },
    splitContract: { developmentEnd: "2024-12-31", oosEnd: "2025-12-31" },
    direction: "LONG",
  });
  const same = buildStrategyResultCacheProvenance({
    researchCodeSha: SHA,
    historicalCacheKey: history.cacheKey,
    strategyVersion: "V1",
    parameters: { slowPeriod: 50, fastPeriod: 20 },
    costModel: { exitFeeRate: 0.0006, entryFeeRate: 0.0006 },
    splitContract: { oosEnd: "2025-12-31", developmentEnd: "2024-12-31" },
    direction: "LONG",
  });
  assert.equal(base.cacheKey, same.cacheKey);
  assert.equal(validateCacheReuse(base, same).reusable, true);

  const changedParameter = buildStrategyResultCacheProvenance({ ...base.identity, parameters: { fastPeriod: 10, slowPeriod: 50 } });
  assert.notEqual(base.cacheKey, changedParameter.cacheKey);
  const changedSha = buildStrategyResultCacheProvenance({ ...base.identity, researchCodeSha: "f".repeat(40) });
  assert.notEqual(base.cacheKey, changedSha.cacheKey);
});

test("strategy cache refuses stale reuse even with an otherwise matching identity", () => {
  const history = historical();
  const expected = buildStrategyResultCacheProvenance({
    researchCodeSha: SHA,
    historicalCacheKey: history.cacheKey,
    strategyVersion: "V1",
    parameters: { fastPeriod: 20, slowPeriod: 50 },
    costModel: { entryFeeRate: 0.0006 },
    splitContract: { development: "2020-2024", oos: "2025" },
    direction: "SHORT",
  });
  const stale = { ...expected, guards: { ...expected.guards, staleReuseAllowed: true } };
  assert.equal(validateCacheReuse(expected, stale).reason, "stale_reuse_guard_failed");
});
