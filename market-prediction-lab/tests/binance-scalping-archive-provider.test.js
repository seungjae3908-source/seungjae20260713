import test from "node:test";
import assert from "node:assert/strict";
import {
  inspectBinanceScalpingCandles,
  inspectBinanceScalpingFunding,
  binanceScalpingDigest,
} from "../src/binance-scalping-archive-provider.js";

const M15 = 15 * 60 * 1000;
const H8 = 8 * 60 * 60 * 1000;

test("Binance 15m candle gate excludes open boundary and fails closed on gaps", () => {
  const start = Date.UTC(2020, 0, 1);
  const end = start + 5 * M15;
  const mk = (timestamp) => ({ timestamp, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 });
  const complete = inspectBinanceScalpingCandles({
    requestedStart: start,
    requestedEnd: end,
    candles: [0, 1, 2, 3, 4, 5].map((i) => mk(start + i * M15)),
  });
  assert.equal(complete.expectedCandleCount, 5);
  assert.equal(complete.actualCandleCount, 5);
  assert.equal(complete.openBoundaryCandleExcluded, true);
  assert.equal(complete.status, "DATA_READY");

  const gap = inspectBinanceScalpingCandles({
    requestedStart: start,
    requestedEnd: end,
    candles: [0, 1, 3, 4].map((i) => mk(start + i * M15)),
  });
  assert.equal(gap.status, "BLOCKED_DATA");
  assert.equal(gap.gapCount, 1);
  assert.equal(gap.missingCandleCount, 1);
});

test("Binance funding gate uses observed interval and rejects incomplete edge coverage", () => {
  const start = Date.UTC(2020, 0, 1);
  const end = start + 4 * H8;
  const complete = inspectBinanceScalpingFunding({
    requestedStart: start,
    requestedEnd: end,
    records: [0, 1, 2, 3, 4].map((i) => ({ timestamp: start + i * H8, rate: i % 2 ? -0.00005 : 0.0001 })),
  });
  assert.equal(complete.status, "DATA_READY");
  assert.equal(complete.fundingMissingIntervals, 0);
  assert.equal(complete.fundingDuplicateCount, 0);
  assert.equal(complete.medianObservedIntervalMs, H8);

  const partial = inspectBinanceScalpingFunding({
    requestedStart: start,
    requestedEnd: end,
    records: [2, 3, 4].map((i) => ({ timestamp: start + i * H8, rate: 0.0001 })),
  });
  assert.equal(partial.status, "BLOCKED_DATA");
  assert.equal(partial.reachesStart, false);
});

test("Binance scalping digests are deterministic and venue provenance changes the digest", () => {
  const base = { providerBoundary: "SAME_VENUE_BINANCE_USDM", priceVenue: "BINANCE_USDM", fundingVenue: "BINANCE_USDM" };
  assert.equal(binanceScalpingDigest(base), binanceScalpingDigest({ fundingVenue: "BINANCE_USDM", priceVenue: "BINANCE_USDM", providerBoundary: "SAME_VENUE_BINANCE_USDM" }));
  assert.notEqual(binanceScalpingDigest(base), binanceScalpingDigest({ ...base, fundingVenue: "BITGET" }));
});
