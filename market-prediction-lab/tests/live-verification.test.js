import test from "node:test";
import assert from "node:assert/strict";
import { buildBitgetLiveQualityReport, runBitgetLiveVerification } from "../src/live-verification.js";

function candles(count = 672, start = 1_700_000_000_000) {
  return Array.from({ length: count }, (_, index) => ({
    timestamp: start + index * 15 * 60 * 1000,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 10,
  }));
}

const completeContext = Object.freeze({
  openInterest: 100,
  fundingRate: 0.0001,
  fundingIntervalHours: 8,
  marketPrice: 100,
  markPrice: 100,
  indexPrice: 100,
  fundingHistory: [],
});

test("live report passes a complete seven-day futures snapshot", () => {
  const items = candles();
  const requestedStartTime = items[0].timestamp;
  const requestedEndTime = requestedStartTime + 672 * 15 * 60 * 1000;
  const report = buildBitgetLiveQualityReport({
    snapshot: {
      provider: "bitget-public-v2",
      market: "CRYPTO_FUTURES",
      symbol: "BTCUSDT",
      timeframe: "15m",
      candles: items,
    },
    context: completeContext,
    requestedStartTime,
    requestedEndTime,
  });
  assert.equal(report.status, "pass");
  assert.equal(report.coverageRatio, 1);
  assert.deepEqual(report.blockers, []);
});

test("live report fails low coverage and incomplete futures context", () => {
  const items = candles(100);
  const requestedStartTime = items[0].timestamp;
  const requestedEndTime = requestedStartTime + 672 * 15 * 60 * 1000;
  const report = buildBitgetLiveQualityReport({
    snapshot: {
      provider: "bitget-public-v2",
      market: "CRYPTO_FUTURES",
      symbol: "BTCUSDT",
      timeframe: "15m",
      candles: items,
    },
    context: {},
    requestedStartTime,
    requestedEndTime,
  });
  assert.equal(report.status, "fail");
  assert.ok(report.blockers.includes("insufficient_time_coverage"));
  assert.ok(report.blockers.includes("futures_context_incomplete"));
});

test("live runner supports injected collectors and produces a passing report", async () => {
  const now = 1_700_000_000_000;
  const requestedStartTime = now - 24 * 60 * 60 * 1000;
  const items = candles(96, requestedStartTime);
  const result = await runBitgetLiveVerification({
    client: {},
    days: 1,
    now,
    collectCandles: async () => ({
      provider: "bitget-public-v2",
      market: "CRYPTO_FUTURES",
      symbol: "BTCUSDT",
      timeframe: "15m",
      candles: items,
    }),
    collectContext: async () => completeContext,
  });
  assert.equal(result.report.status, "pass");
});
