import test from "node:test";
import assert from "node:assert/strict";
import { evaluateUsQualityDaytradePreEntry } from "../src/us-quality-daytrade-preentry-v1.js";

function tierBInput() {
  return {
    asOfMs: 8_500,
    instrument: {
      symbol: "QLTY",
      exchange: "NASDAQ",
      securityType: "COMMON_STOCK",
      priceUsd: 12,
      marketCapUsd: 2_000_000_000,
      averageDollarVolumeUsd: 30_000_000,
      floatShares: 35_000_000,
      floatEvidence: {
        sourceId: "issuer-sec-point-in-time",
        pointInTime: true,
        observedAtMs: 8_000,
        validFromMs: 1,
        validToMs: 20_000,
        shares: 35_000_000,
      },
      recentReverseSplit: false,
      listingRisk: false,
      manipulationRisk: false,
      dilutionRisk: false,
      recentOffering: false,
      goingConcernRisk: false,
    },
    universeEvidence: {
      marketCap: {
        sourceId: "issuer-sec-market-cap-pit",
        pointInTime: true,
        observedAtMs: 8_000,
        validFromMs: 1,
        validToMs: 20_000,
        marketCapUsd: 2_000_000_000,
      },
      averageDollarVolume: {
        sourceId: "historical-dollar-volume-pit",
        pointInTime: true,
        observedAtMs: 8_000,
        windowStartMs: 1,
        windowEndMs: 8_000,
        validUntilMs: 20_000,
        averageDollarVolumeUsd: 30_000_000,
      },
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
    relativeVolume: 2.5,
    catalyst: { verified: true, type: "EARNINGS" },
  };
}

function validTierBRiskEvidence() {
  return {
    pointInTime: true,
    publicReadOnly: true,
    privateApiUsed: false,
    coverageComplete: true,
    checkedAtMs: 8_000,
    windowStartMs: 1,
    windowEndMs: 7_500,
    validUntilMs: 20_000,
    riskFlags: {
      recentReverseSplit: false,
      listingRisk: false,
      manipulationRisk: false,
      dilutionRisk: false,
      recentOffering: false,
      goingConcernRisk: false,
    },
    sourceIds: {
      recentReverseSplit: "exchange-corporate-actions",
      listingRisk: "exchange-listing-status",
      manipulationRisk: "market-surveillance-public",
      dilutionRisk: "sec-filings-dilution-screen",
      recentOffering: "sec-offering-filings",
      goingConcernRisk: "sec-going-concern-screen",
    },
  };
}

test("Tier B technical candidate fails closed before liquidity when risk provenance is missing", () => {
  const input = tierBInput();
  const result = evaluateUsQualityDaytradePreEntry(input);
  assert.equal(result.technicalSetup.status, "CANDIDATE");
  assert.equal(result.technicalSetup.qualityTier, "B");
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "TIER_B_RISK_EVIDENCE_REQUIRED");
  assert.equal(result.tierBRiskProvenance.status, "BLOCKED_DATA");
  assert.equal(result.liquidity, null);
});

test("verified Tier B negative risk provenance advances to the next fail-closed gate", () => {
  const input = tierBInput();
  input.tierBRiskEvidence = validTierBRiskEvidence();
  const result = evaluateUsQualityDaytradePreEntry(input);
  assert.equal(result.technicalSetup.status, "CANDIDATE");
  assert.equal(result.tierBRiskProvenance.status, "PASS");
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "LIQUIDITY_SYMBOL_REQUIRED");
});
