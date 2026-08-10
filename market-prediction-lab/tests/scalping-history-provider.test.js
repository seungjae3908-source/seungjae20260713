import test from "node:test";
import assert from "node:assert/strict";
import {
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
  }));
}

test("chunk plan is deterministic, newest-first and bounded", () => {
  const input = {
    market: "CRYPTO_SPOT",
    symbol: "BTCUSDT",
    timeframe: "15m",
    requestedStart: Date.UTC(2020, 0, 1),
    requestedEnd: Date.UTC(2020, 2, 1),
    chunkCandles: 2_880,
  };
  const first = buildScalpingChunkPlan(input);
  const second = buildScalpingChunkPlan(input);
  assert.deepEqual(first, second);
  assert.ok(first.length >= 2);
  assert.ok(first[0].requestedEnd > first.at(-1).requestedEnd);
  assert.ok(first.every((chunk) => /^[0-9a-f]{64}$/u.test(chunk.cacheKey)));
});

test("diagnostics detect gaps, duplicates and reversed timestamps", () => {
  const start = Date.UTC(2026, 0, 1);
  const clean = candles(start, 100);
  const cleanReport = inspectScalpingCandles({
    market: "CRYPTO_SPOT", symbol: "BTCUSDT", timeframe: "15m",
    candles: clean, requestedStart: start, requestedEnd: start + 100 * M15,
  });
  assert.equal(cleanReport.duplicateCount, 0);
  assert.equal(cleanReport.reversedCount, 0);
  assert.equal(cleanReport.missingCandleCount, 0);

  const broken = [...clean.slice(0, 20), clean[19], ...clean.slice(22)];
  const brokenReport = inspectScalpingCandles({
    market: "CRYPTO_SPOT", symbol: "BTCUSDT", timeframe: "15m",
    candles: broken, requestedStart: start, requestedEnd: start + 100 * M15,
  });
  assert.ok(brokenReport.duplicateCount > 0);
  assert.ok(brokenReport.missingCandleCount > 0);
  assert.equal(brokenReport.completeChunk, false);
});

test("manifest is blocked_data when any historical chunk is unavailable", () => {
  const start = Date.UTC(2020, 0, 1);
  const manifest = buildScalpingHistoryManifest({
    market: "CRYPTO_FUTURES",
    symbol: "BTCUSDT",
    timeframe: "15m",
    requestedStart: start,
    requestedEnd: start + 2 * 2_880 * M15,
    chunkSummaries: [
      { status: "ready", cacheKey: "a", requestedStart: start + 2_880 * M15, requestedEnd: start + 2 * 2_880 * M15, actualStart: start + 2_880 * M15, actualEnd: start + 2 * 2_880 * M15 - M15, rawDataDigest: "r", normalizedDataDigest: "n", diagnostics: { missingCandleCount: 0, duplicateCount: 0, reversedCount: 0 } },
      { status: "blocked_data", cacheKey: "b", requestedStart: start, requestedEnd: start + 2_880 * M15, actualStart: null, actualEnd: null, rawDataDigest: null, normalizedDataDigest: null, diagnostics: { reason: "provider_chunk_unavailable_or_invalid" } },
    ],
  });
  assert.equal(manifest.status, "blocked_data");
  assert.equal(manifest.blockedChunkCount, 1);
  assert.equal(manifest.syntheticDataUsed, false);
  assert.equal(manifest.privateApiUsed, false);
  assert.equal(manifest.orderSubmitted, false);
  assert.ok(/^[0-9a-f]{64}$/u.test(manifest.manifestDigest));
});

test("cache integrity detects raw or normalized corruption", () => {
  const rawCandles = candles(Date.UTC(2026, 0, 1), 100);
  const normalizedCandles = rawCandles.map((candle) => ({ ...candle, market: "CRYPTO_SPOT", symbol: "BTCUSDT", timeframe: "15m", observedAt: candle.timestamp, isClosed: true }));
  const chunk = {
    status: "ready",
    provider: "bitget-public-v2",
    market: "CRYPTO_SPOT",
    symbol: "BTCUSDT",
    timeframe: "15m",
    rawCandles,
    normalizedCandles,
    rawDataDigest: scalpingDigest({ provider: "bitget-public-v2", market: "CRYPTO_SPOT", symbol: "BTCUSDT", timeframe: "15m", candles: rawCandles }),
    normalizedDataDigest: scalpingDigest({ market: "CRYPTO_SPOT", symbol: "BTCUSDT", timeframe: "15m", candles: normalizedCandles }),
  };
  assert.equal(assertScalpingChunkIntegrity(chunk), true);
  assert.throws(() => assertScalpingChunkIntegrity({ ...chunk, rawDataDigest: "0".repeat(64) }), /SCALPING_RAW_CACHE_CORRUPTION/);
  assert.throws(() => assertScalpingChunkIntegrity({ ...chunk, normalizedDataDigest: "0".repeat(64) }), /SCALPING_NORMALIZED_CACHE_CORRUPTION/);
});
