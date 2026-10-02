import test from "node:test";
import assert from "node:assert/strict";
import { evaluateUsQualityDaytradeMarketContext } from "../src/us-quality-daytrade-market-context-v1.js";

function baseInput() {
  return {
    asOfMs: 1_800_000,
    session: "REGULAR",
    marketContextEvidence: {
      pointInTime: true,
      sourceId: "public-market-context",
      marketTimezone: "America/New_York",
      session: "REGULAR",
      checkedAtMs: 1_790_000,
      validUntilMs: 1_860_000,
      sessionStartMs: 0,
      sessionEndMs: 23_400_000,
      maxBenchmarkAgeMs: 60_000,
      maxBenchmarkSkewMs: 30_000,
      indexEvidence: {
        sourceId: "spy-point-in-time",
        symbol: "SPY",
        pointInTime: true,
        observedAtMs: 1_790_000,
        returnPct: -0.6,
      },
      sectorEvidence: {
        sourceId: "xlv-point-in-time",
        symbol: "XLV",
        pointInTime: true,
        observedAtMs: 1_795_000,
        returnPct: 0.2,
      },
    },
  };
}

test("market context classifies point-in-time index, sector relative strength, and time of day", () => {
  const result = evaluateUsQualityDaytradeMarketContext(baseInput());
  assert.equal(result.status, "PASS");
  assert.equal(result.marketRegime, "RISK_OFF");
  assert.equal(result.sectorRegime, "OUTPERFORMING");
  assert.equal(result.sectorRelativeReturnPct, 0.8);
  assert.equal(result.timeOfDayBucket, "REGULAR_EARLY_30_120");
  assert.equal(result.pointInTime, true);
});

test("market context fails closed when benchmark evidence is stale", () => {
  const input = baseInput();
  input.marketContextEvidence.indexEvidence.observedAtMs = 1_700_000;
  const result = evaluateUsQualityDaytradeMarketContext(input);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "INDEX_EVIDENCE_STALE");
});

test("market context fails closed on index-sector clock skew", () => {
  const input = baseInput();
  input.marketContextEvidence.indexEvidence.observedAtMs = 1_740_000;
  input.marketContextEvidence.sectorEvidence.observedAtMs = 1_795_000;
  input.marketContextEvidence.maxBenchmarkAgeMs = 120_000;
  const result = evaluateUsQualityDaytradeMarketContext(input);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "MARKET_CONTEXT_BENCHMARK_CLOCK_SKEW_TOO_WIDE");
});

test("market context fails closed when session identity does not match", () => {
  const input = baseInput();
  input.marketContextEvidence.session = "PREMARKET";
  const result = evaluateUsQualityDaytradeMarketContext(input);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "MARKET_CONTEXT_SESSION_MISMATCH");
});

test("extended sessions remain separate time-of-day regimes", () => {
  const input = baseInput();
  input.session = "AFTER_HOURS";
  input.marketContextEvidence.session = "AFTER_HOURS";
  const result = evaluateUsQualityDaytradeMarketContext(input);
  assert.equal(result.status, "PASS");
  assert.equal(result.timeOfDayBucket, "AFTER_HOURS");
  assert.equal(result.minutesFromSessionOpen, null);
});
