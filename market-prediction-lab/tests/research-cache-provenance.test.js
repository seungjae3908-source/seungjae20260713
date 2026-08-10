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
    requestedStartTime: Date.UTC(2020, 0, 1),
    requestedEndTime: Date.UTC(2025, 11, 31),
    dataDigest: DIGEST,
    providerManifestDigest: MANIFEST,
    candleCount: 2192,
    actualStartTime: Date.UTC(2020, 0, 1),
    actualEndTime: Date.UTC(2025, 11, 31),
    ...overrides,
  });
}

test("canonical digest is stable across object key order", () => {
  assert.equal(sha256Canonical({ b: 2, a: { y: 2, x: 1 } }), sha256Canonical({ a: { x: 1, y: 2 }, b: 2 }));
});

test("historical cache key binds provider, range and exact data digest", () => {
  const first = historical();
  const same = historical();
  const changed = historical({ dataDigest: "c".repeat(64) });
  assert.equal(first.cacheKey, same.cacheKey);
  assert.notEqual(first.cacheKey, changed.cacheKey);
  assert.equal(validateCacheReuse(first, same).reusable, true);
  assert.equal(validateCacheReuse(first, changed).reason, "cache_key_mismatch");
  assert.equal(first.guards.syntheticDataAllowed, false);
});

test("historical cache refuses reuse if quality or synthetic-data guards are weakened", () => {
  const expected = historical();
  const weakened = { ...expected, guards: { ...expected.guards, closedCandlesOnly: false } };
  assert.equal(validateCacheReuse(expected, weakened).reason, "historical_quality_guard_failed");
  const synthetic = { ...expected, guards: { ...expected.guards, syntheticDataAllowed: true } };
  assert.equal(validateCacheReuse(expected, synthetic).reason, "synthetic_data_guard_failed");
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
