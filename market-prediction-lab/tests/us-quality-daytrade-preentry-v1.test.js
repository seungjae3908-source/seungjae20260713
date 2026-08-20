import test from "node:test";
import assert from "node:assert/strict";
import { evaluateUsQualityDaytradePreEntry } from "../src/us-quality-daytrade-preentry-v1.js";

function baseInput() {
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
    candles: [
      { open: 100.0, high: 100.8, low: 99.9, close: 100.6, volume: 100, session: "REGULAR", timestamp: 1 },
      { open: 100.6, high: 102.0, low: 100.5, close: 101.8, volume: 130, session: "REGULAR", timestamp: 2 },
      { open: 101.8, high: 104.0, low: 101.7, close: 103.8, volume: 160, session: "REGULAR", timestamp: 3 },
      { open: 103.8, high: 103.9, low: 103.1, close: 103.3, volume: 90, session: "REGULAR", timestamp: 4 },
      { open: 103.3, high: 103.5, low: 102.9, close: 103.0, volume: 85, session: "REGULAR", timestamp: 5 },
      { open: 103.0, high: 103.6, low: 103.0, close: 103.5, volume: 100, session: "REGULAR", timestamp: 6 },
      { open: 103.5, high: 103.9, low: 103.3, close: 103.8, volume: 110, session: "REGULAR", timestamp: 7 },
      { open: 103.8, high: 104.6, low: 103.5, close: 104.5, volume: 250, session: "REGULAR", timestamp: 8 },
    ],
    candleEvidence: {
      timeframeMs: 10_000,
      sessionStartTimestampMs: 1,
      coverageStartTimestampMs: 1,
      lastCompleteCandleTimestampMs: 8,
      sessionCoverageComplete: true,
    },
    quote: { bid: 104.45, ask: 104.55, timestampMs: 8_000 },
    asOfMs: 8_500,
    relativeVolume: 2.2,
    catalyst: { verified: true, type: "EARNINGS" },
    binaryEventPolicy: { preEventBlackoutMinutes: 120, postEventCooldownMinutes: 60 },
  };
}

function noEventEvidence() {
  return {
    calendarChecked: true,
    checkedAtMs: 7_500,
    scheduled: false,
    source: "issuer-calendar",
    validUntilMs: 68_500,
    coverageComplete: true,
    coverageStartMs: -86_391_500,
    coverageEndMs: 86_408_500,
  };
}

test("technical candidate is blocked when binary-event evidence is missing", () => {
  const result = evaluateUsQualityDaytradePreEntry(baseInput());
  assert.equal(result.technicalSetup.status, "CANDIDATE");
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "BINARY_EVENT_EVIDENCE_REQUIRED");
});

test("source-backed complete no-event evidence preserves candidate status", () => {
  const input = baseInput();
  input.binaryEventEvidence = noEventEvidence();
  const result = evaluateUsQualityDaytradePreEntry(input);
  assert.equal(result.status, "CANDIDATE");
  assert.equal(result.reason, "VWAP_FIRST_PULLBACK_REBREAK_EVENT_SAFE");
  assert.equal(result.binaryEventRisk.status, "PASS");
});

test("verified near earnings event inside complete calendar coverage blocks the otherwise-valid setup", () => {
  const input = baseInput();
  input.binaryEventEvidence = {
    ...noEventEvidence(),
    scheduled: true,
    verified: true,
    eventType: "EARNINGS",
    eventTimestampMs: 8_500 + 60 * 60_000,
  };
  const result = evaluateUsQualityDaytradePreEntry(input);
  assert.equal(result.status, "ABSTAIN");
  assert.equal(result.reason, "BINARY_EVENT_BLACKOUT");
});
