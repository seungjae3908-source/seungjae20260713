import test from "node:test";
import assert from "node:assert/strict";
import { evaluateUsQualityDaytradePreEntry } from "../src/us-quality-daytrade-preentry-v1.js";

function validRawTechnicalCandidate() {
  const candles = [
    { open: 100.0, high: 100.8, low: 99.9, close: 100.6, volume: 100, session: "REGULAR", timestamp: 1 },
    { open: 100.6, high: 102.0, low: 100.5, close: 101.8, volume: 130, session: "REGULAR", timestamp: 2 },
    { open: 101.8, high: 104.0, low: 101.7, close: 103.8, volume: 160, session: "REGULAR", timestamp: 3 },
    { open: 103.8, high: 103.9, low: 103.1, close: 103.3, volume: 90, session: "REGULAR", timestamp: 4 },
    { open: 103.3, high: 103.5, low: 102.9, close: 103.0, volume: 85, session: "REGULAR", timestamp: 5 },
    { open: 103.0, high: 103.6, low: 103.0, close: 103.5, volume: 100, session: "REGULAR", timestamp: 6 },
    { open: 103.5, high: 103.9, low: 103.3, close: 103.8, volume: 110, session: "REGULAR", timestamp: 7 },
    { open: 103.8, high: 104.6, low: 103.5, close: 104.5, volume: 250, session: "REGULAR", timestamp: 8 },
  ];

  return {
    instrument: {
      symbol: "MRK",
      exchange: "NYSE",
      securityType: "COMMON_STOCK",
      priceUsd: 150,
      marketCapUsd: 350_000_000_000,
      averageDollarVolumeUsd: 900_000_000,
      floatShares: 2_000_000_000,
      recentReverseSplit: false,
      listingRisk: false,
      manipulationRisk: false,
      dilutionRisk: false,
      recentOffering: false,
      goingConcernRisk: false,
    },
    universeEvidence: {
      listing: {
        sourceId: "exchange-listing-pit",
        pointInTime: true,
        publicReadOnly: true,
        privateApiUsed: false,
        symbol: "MRK",
        exchange: "NYSE",
        securityType: "COMMON_STOCK",
        observedAtMs: 8_000,
        validFromMs: 1,
        validToMs: 20_000,
      },
      price: {
        sourceId: "public-price-pit",
        pointInTime: true,
        publicReadOnly: true,
        privateApiUsed: false,
        symbol: "MRK",
        priceUsd: 150,
        observedAtMs: 8_000,
        validUntilMs: 20_000,
      },
      marketCap: {
        sourceId: "issuer-sec-market-cap-pit",
        pointInTime: true,
        observedAtMs: 8_000,
        validFromMs: 1,
        validToMs: 20_000,
        marketCapUsd: 350_000_000_000,
      },
      averageDollarVolume: {
        sourceId: "historical-dollar-volume-pit",
        pointInTime: true,
        observedAtMs: 8_000,
        windowStartMs: 1,
        windowEndMs: 8_000,
        validUntilMs: 20_000,
        averageDollarVolumeUsd: 900_000_000,
      },
    },
    candles,
    candleEvidence: {
      timeframeMs: 10_000,
      sessionStartTimestampMs: 1,
      coverageStartTimestampMs: 1,
      lastCompleteCandleTimestampMs: 8,
      sessionCoverageComplete: true,
    },
    liquidityEvidence: {
      symbol: "MRK",
      candleEvidence: {
        sourceId: "public-session-candles",
        pointInTime: true,
        publicReadOnly: true,
        privateApiUsed: false,
        session: "REGULAR",
        timeframeMs: 10_000,
        sessionStartTimestampMs: 1,
        coverageStartTimestampMs: 1,
        lastCompleteCandleTimestampMs: 8,
        sessionCoverageComplete: true,
        candles,
      },
      relativeVolumeEvidence: {
        sourceId: "public-rvol-same-phase",
        pointInTime: true,
        publicReadOnly: true,
        privateApiUsed: false,
        session: "REGULAR",
        sameSessionPhase: true,
        lookaheadFree: true,
        observedAtMs: 8_000,
        currentCumulativeVolume: 1_100,
      },
    },
    quote: { bid: 104.45, ask: 104.55, timestampMs: 8_000 },
    asOfMs: 8_500,
    relativeVolume: 2.2,
    catalyst: { verified: true, type: "EARNINGS" },
    catalystEvidence: {
      publicReadOnly: true,
      privateApiUsed: false,
      symbol: "MRK",
      sourceId: "public-news-catalyst-pit",
      coverageComplete: true,
      checkedAtMs: 8_000,
      validUntilMs: 20_000,
      coverageStartMs: -86_391_500,
      coverageEndMs: 8_500,
      catalystCount: 0,
      catalysts: [],
    },
    marketContextEvidence: {
      pointInTime: true,
      sourceId: "public-market-context-pit",
      marketTimezone: "America/New_York",
      session: "REGULAR",
      checkedAtMs: 8_000,
      validUntilMs: 20_000,
      sessionStartMs: 1,
      sessionEndMs: 23_400_001,
      maxBenchmarkAgeMs: 5_000,
      maxBenchmarkSkewMs: 2_000,
      indexEvidence: {
        sourceId: "spy-pit",
        symbol: "SPY",
        pointInTime: true,
        observedAtMs: 8_000,
        returnPct: -0.4,
      },
      sectorEvidence: {
        sourceId: "xlv-pit",
        symbol: "XLV",
        pointInTime: true,
        observedAtMs: 8_000,
        returnPct: 0.2,
      },
    },
    binaryEventPolicy: { preEventBlackoutMinutes: 120, postEventCooldownMinutes: 60 },
    binaryEventEvidence: {
      calendarChecked: true,
      checkedAtMs: 7_500,
      scheduled: false,
      scheduledEventCount: 0,
      events: [],
      source: "issuer-calendar",
      validUntilMs: 68_500,
      coverageComplete: true,
      coverageStartMs: -86_391_500,
      coverageEndMs: 86_408_500,
    },
  };
}

test("raw technical candidate is explicitly non-entry-ready and non-Paper-admissible", () => {
  const result = evaluateUsQualityDaytradePreEntry(validRawTechnicalCandidate());
  assert.equal(result.status, "CANDIDATE");
  assert.equal(result.entryReady, false);
  assert.equal(result.paperAdmissible, false);
  assert.equal(result.candidateBound, false);
  assert.equal(result.sourceBoundAdmissionRequired, true);
  assert.equal(result.selectionEligible, false);
  assert.equal(result.orderAuthority, false);
  assert.equal(result.executionAuthority, "NONE");
});

test("caller-supplied READY-looking token cannot self-promote direct pre-entry to ENTRY_READY", () => {
  const raw = validRawTechnicalCandidate();
  raw.sourceBoundAdmission = {
    status: "READY",
    symbol: "MRK",
    observationDigest: "f".repeat(64),
  };
  const result = evaluateUsQualityDaytradePreEntry(raw);
  assert.equal(result.status, "CANDIDATE");
  assert.equal(result.entryReady, false);
  assert.equal(result.paperAdmissible, false);
  assert.equal(result.candidateBound, false);
  assert.equal(result.orderAuthority, false);
});
