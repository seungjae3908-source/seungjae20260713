import test from "node:test";
import assert from "node:assert/strict";
import {
  SCALPING_HISTORY_SCHEMA_VERSION,
  SCALPING_NORMALIZATION_VERSION,
  assertScalpingChunkIntegrity,
  buildScalpingChunkPlan,
  buildScalpingHistoryManifest,
  inspectScalpingCandles,
  scalpingDigest,
} from "../src/scalping-history-provider.js";

const M15 = 15 * 60 * 1000;

function candles(start, count) {
  return Array.from({ length: count }, (_, index) => ({
    timestamp: start + index * M15,
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100.5 + index,
    volume: 1000 + index,
    quoteVolume: 100000 + index,
  }));
}

const CACHE_CONTRACT = Object.freeze({
  providerVersion: "api-v2-history-candles",
  normalizationVersion: SCALPING_NORMALIZATION_VERSION,
  collectionCodeSha: "a".repeat(40),
  costModelDigest: "c".repeat(64),
  splitDefinition: "dev-oos-holdout-v1",
});

test("chunk plan is deterministic, newest-first and invalidates cache across provenance changes", () => {
  const input = {
    market: "CRYPTO_SPOT",
    symbol: "BTCUSDT",
    timeframe: "15m",
    requestedStart: Date.UTC(2020, 0, 1),
    requestedEnd: Date.UTC(2020, 2, 1),
    chunkCandles: 2_880,
    cacheContract: CACHE_CONTRACT,
  };
  const first = buildScalpingChunkPlan(input);
  const second = buildScalpingChunkPlan(input);
  assert.deepEqual(first, second);
  assert.ok(first.length >= 2);
  assert.ok(first[0].requestedEnd > first.at(-1).requestedEnd);
  assert.ok(first.every((chunk) => /^[0-9a-f]{64}$/u.test(chunk.cacheKey)));
  assert.equal(first[0].cacheContract.collectionCodeSha, CACHE_CONTRACT.collectionCodeSha);
  const changedCode = buildScalpingChunkPlan({ ...input, cacheContract: { ...CACHE_CONTRACT, collectionCodeSha: "b".repeat(40) } });
  const changedProvider = buildScalpingChunkPlan({ ...input, cacheContract: { ...CACHE_CONTRACT, providerVersion: "api-v2-history-candles-revision" } });
  const changedPeriod = buildScalpingChunkPlan({ ...input, requestedEnd: input.requestedEnd + M15 });
  assert.notEqual(first[0].cacheKey, changedCode[0].cacheKey);
  assert.notEqual(first[0].cacheKey, changedProvider[0].cacheKey);
  assert.notEqual(first[0].cacheKey, changedPeriod[0].cacheKey);
});

test("diagnostics measure expected/actual count, gaps, duplicates and out-of-order timestamps", () => {
  const start = Date.UTC(2026, 0, 1);
  const clean = candles(start, 100);
  const cleanReport = inspectScalpingCandles({
    market: "CRYPTO_SPOT", symbol: "BTCUSDT", timeframe: "15m",
    candles: clean, requestedStart: start, requestedEnd: start + 100 * M15,
  });
  assert.equal(cleanReport.expectedCandleCount, 100);
  assert.equal(cleanReport.actualCandleCount, 100);
  assert.equal(cleanReport.duplicateCount, 0);
  assert.equal(cleanReport.outOfOrderCount, 0);
  assert.equal(cleanReport.missingCandleCount, 0);
  assert.equal(cleanReport.gapCount, 0);
  assert.equal(cleanReport.maximumGapCandles, 0);

  const broken = [...clean.slice(0, 20), clean[19], ...clean.slice(22)];
  const brokenReport = inspectScalpingCandles({
    market: "CRYPTO_SPOT", symbol: "BTCUSDT", timeframe: "15m",
    candles: broken, requestedStart: start, requestedEnd: start + 100 * M15,
  });
  assert.ok(brokenReport.duplicateCount > 0);
  assert.ok(brokenReport.missingCandleCount > 0);
  assert.ok(brokenReport.gapCount > 0);
  assert.ok(brokenReport.maximumGapCandles > 0);
  assert.equal(brokenReport.completeChunk, false);

  const reversed = [...clean.slice(0, 20), clean[21], clean[20], ...clean.slice(22)];
  const reversedReport = inspectScalpingCandles({
    market: "CRYPTO_SPOT", symbol: "BTCUSDT", timeframe: "15m",
    candles: reversed, requestedStart: start, requestedEnd: start + 100 * M15,
  });
  assert.ok(reversedReport.outOfOrderCount > 0);
  assert.equal(reversedReport.completeChunk, false);
});

test("manifest is BLOCKED_DATA when any historical chunk is unavailable", () => {
  const start = Date.UTC(2020, 0, 1);
  const manifest = buildScalpingHistoryManifest({
    market: "CRYPTO_FUTURES",
    symbol: "BTCUSDT",
    timeframe: "15m",
    requestedStart: start,
    requestedEnd: start + 2 * 2_880 * M15,
    cacheContract: CACHE_CONTRACT,
    chunkSummaries: [
      { status: "ready", cacheKey: "a", cacheContract: CACHE_CONTRACT, requestedStart: start + 2_880 * M15, requestedEnd: start + 2 * 2_880 * M15, actualStart: start + 2_880 * M15, actualEnd: start + 2 * 2_880 * M15 - M15, rawDataDigest: "r", normalizedDataDigest: "n", diagnostics: { actualCandleCount: 2880, missingCandleCount: 0, gapCount: 0, maximumGapCandles: 0, maximumGapMs: 0, duplicateCount: 0, outOfOrderCount: 0 } },
      { status: "blocked_data", cacheKey: "b", cacheContract: CACHE_CONTRACT, requestedStart: start, requestedEnd: start + 2_880 * M15, actualStart: null, actualEnd: null, rawDataDigest: null, normalizedDataDigest: null, diagnostics: { reason: "provider_chunk_unavailable_or_invalid" } },
    ],
  });
  assert.equal(manifest.status, "BLOCKED_DATA");
  assert.equal(manifest.blockedChunkCount, 1);
  assert.equal(manifest.syntheticDataUsed, false);
  assert.equal(manifest.interpolationUsed, false);
  assert.equal(manifest.privateApiUsed, false);
  assert.equal(manifest.orderSubmitted, false);
  assert.equal(manifest.collectionCodeSHA, CACHE_CONTRACT.collectionCodeSha);
  assert.equal(manifest.cacheSchemaVersion, SCALPING_HISTORY_SCHEMA_VERSION);
  assert.ok(/^[0-9a-f]{64}$/u.test(manifest.manifestDigest));
});

test("complete one-provider manifest is DATA_READY and records provider boundary semantics", () => {
  const start = Date.UTC(2025, 0, 1);
  const raw = candles(start, 200);
  const normalized = raw.map((candle) => ({ ...candle, market: "CRYPTO_SPOT", symbol: "BTCUSDT", timeframe: "15m", observedAt: candle.timestamp, isClosed: true }));
  const rawDigest = scalpingDigest({ provider: "bitget-public-v2", market: "CRYPTO_SPOT", symbol: "BTCUSDT", timeframe: "15m", candles: raw });
  const normalizedDigest = scalpingDigest({ normalizationVersion: SCALPING_NORMALIZATION_VERSION, market: "CRYPTO_SPOT", symbol: "BTCUSDT", timeframe: "15m", candles: normalized });
  const manifest = buildScalpingHistoryManifest({
    market: "CRYPTO_SPOT",
    symbol: "BTCUSDT",
    timeframe: "15m",
    requestedStart: start,
    requestedEnd: start + 200 * M15,
    cacheContract: CACHE_CONTRACT,
    chunkSummaries: [{
      status: "ready", cacheKey: "k", cacheContract: CACHE_CONTRACT,
      requestedStart: start, requestedEnd: start + 200 * M15,
      actualStart: start, actualEnd: start + 199 * M15,
      rawDataDigest: rawDigest, normalizedDataDigest: normalizedDigest,
      diagnostics: { actualCandleCount: 200, missingCandleCount: 0, gapCount: 0, maximumGapCandles: 0, maximumGapMs: 0, duplicateCount: 0, outOfOrderCount: 0 },
    }],
  });
  assert.equal(manifest.status, "DATA_READY");
  assert.equal(manifest.expectedCandleCount, 200);
  assert.equal(manifest.actualCandleCount, 200);
  assert.equal(manifest.providerBoundary.status, "verified_single_provider_contract");
  assert.equal(manifest.providerBoundary.crossProviderConcatenationUsed, false);
  assert.equal(manifest.semantics.missingCandlePolicy, "fail_closed_no_interpolation");
});

test("cache integrity detects raw/normalized corruption and forbids synthetic/interpolated substitution", () => {
  const rawCandles = candles(Date.UTC(2026, 0, 1), 100);
  const normalizedCandles = rawCandles.map((candle) => ({ ...candle, market: "CRYPTO_SPOT", symbol: "BTCUSDT", timeframe: "15m", observedAt: candle.timestamp, isClosed: true }));
  const chunk = {
    schemaVersion: SCALPING_HISTORY_SCHEMA_VERSION,
    status: "ready",
    cacheContract: CACHE_CONTRACT,
    provider: "bitget-public-v2",
    market: "CRYPTO_SPOT",
    symbol: "BTCUSDT",
    timeframe: "15m",
    rawCandles,
    normalizedCandles,
    syntheticDataUsed: false,
    interpolationUsed: false,
    rawDataDigest: scalpingDigest({ provider: "bitget-public-v2", market: "CRYPTO_SPOT", symbol: "BTCUSDT", timeframe: "15m", candles: rawCandles }),
    normalizedDataDigest: scalpingDigest({ normalizationVersion: SCALPING_NORMALIZATION_VERSION, market: "CRYPTO_SPOT", symbol: "BTCUSDT", timeframe: "15m", candles: normalizedCandles }),
  };
  assert.equal(assertScalpingChunkIntegrity(chunk), true);
  assert.throws(() => assertScalpingChunkIntegrity({ ...chunk, rawDataDigest: "0".repeat(64) }), /SCALPING_RAW_CACHE_CORRUPTION/);
  assert.throws(() => assertScalpingChunkIntegrity({ ...chunk, normalizedDataDigest: "0".repeat(64) }), /SCALPING_NORMALIZED_CACHE_CORRUPTION/);
  assert.throws(() => assertScalpingChunkIntegrity({ ...chunk, syntheticDataUsed: true }), /SCALPING_SYNTHETIC_OR_INTERPOLATED_CACHE_FORBIDDEN/);
  assert.throws(() => assertScalpingChunkIntegrity({ ...chunk, interpolationUsed: true }), /SCALPING_SYNTHETIC_OR_INTERPOLATED_CACHE_FORBIDDEN/);
});
