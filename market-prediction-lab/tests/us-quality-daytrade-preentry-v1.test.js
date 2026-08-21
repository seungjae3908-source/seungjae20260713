import test from "node:test";
import assert from "node:assert/strict";
import { evaluateUsQualityDaytradePreEntry } from "../src/us-quality-daytrade-preentry-v1.js";

function baseInput() {
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
  };
}

function noEventEvidence() {
  return {
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
  };
}

function scheduledEvidence(event) {
  return {
    ...noEventEvidence(),
    scheduled: true,
    scheduledEventCount: 1,
    events: [event],
  };
}

test("pre-entry blocks before technical evaluation when point-in-time universe evidence is missing", () => {
  const input = baseInput();
  delete input.universeEvidence;
  const result = evaluateUsQualityDaytradePreEntry(input);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "UNIVERSE_EVIDENCE_REQUIRED");
  assert.equal(result.technicalSetup, null);
  assert.equal(result.liquidity, null);
  assert.equal(result.volatility, null);
  assert.equal(result.marketContext, null);
  assert.equal(result.binaryEventRisk, null);
});

test("pre-entry rejects future market-cap provenance before technical evaluation", () => {
  const input = baseInput();
  input.universeEvidence.marketCap.observedAtMs = 9_000;
  const result = evaluateUsQualityDaytradePreEntry(input);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "MARKET_CAP_EVIDENCE_FROM_FUTURE");
  assert.equal(result.technicalSetup, null);
});

test("technical candidate is blocked when symbol-scoped liquidity evidence is missing", () => {
  const input = baseInput();
  delete input.liquidityEvidence;
  const result = evaluateUsQualityDaytradePreEntry(input);
  assert.equal(result.technicalSetup.status, "CANDIDATE");
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "LIQUIDITY_SYMBOL_REQUIRED");
  assert.equal(result.liquidity, null);
  assert.equal(result.volatility, null);
});

test("liquidity evidence from another symbol cannot promote the technical candidate", () => {
  const input = baseInput();
  input.liquidityEvidence.symbol = "TGT";
  const result = evaluateUsQualityDaytradePreEntry(input);
  assert.equal(result.technicalSetup.status, "CANDIDATE");
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "LIQUIDITY_SYMBOL_MISMATCH");
  assert.equal(result.liquidity, null);
});

test("liquidity evidence from another market session cannot promote the technical candidate", () => {
  const input = baseInput();
  input.liquidityEvidence.candleEvidence.session = "PREMARKET";
  input.liquidityEvidence.candleEvidence.candles = input.liquidityEvidence.candleEvidence.candles.map((candle) => ({
    ...candle,
    session: "PREMARKET",
  }));
  input.liquidityEvidence.relativeVolumeEvidence.session = "PREMARKET";
  const result = evaluateUsQualityDaytradePreEntry(input);
  assert.equal(result.technicalSetup.status, "CANDIDATE");
  assert.equal(result.liquidity.status, "PASS");
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "LIQUIDITY_TECHNICAL_SESSION_MISMATCH");
  assert.equal(result.volatility, null);
});

test("technical candidate is blocked when point-in-time market context evidence is missing", () => {
  const input = baseInput();
  input.binaryEventEvidence = noEventEvidence();
  delete input.marketContextEvidence;
  const result = evaluateUsQualityDaytradePreEntry(input);
  assert.equal(result.technicalSetup.status, "CANDIDATE");
  assert.equal(result.liquidity.status, "PASS");
  assert.equal(result.volatility.status, "PASS");
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "MARKET_CONTEXT_EVIDENCE_REQUIRED");
  assert.equal(result.binaryEventRisk, null);
});

test("stale sector/index regime evidence blocks candidate promotion", () => {
  const input = baseInput();
  input.binaryEventEvidence = noEventEvidence();
  input.marketContextEvidence.indexEvidence.observedAtMs = 1_000;
  const result = evaluateUsQualityDaytradePreEntry(input);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "INDEX_EVIDENCE_STALE");
});

test("technical candidate is blocked when binary-event evidence is missing", () => {
  const result = evaluateUsQualityDaytradePreEntry(baseInput());
  assert.equal(result.technicalSetup.status, "CANDIDATE");
  assert.equal(result.universeProvenance.status, "PASS");
  assert.equal(result.liquidity.status, "PASS");
  assert.equal(result.volatility.status, "PASS");
  assert.equal(result.marketContext.status, "PASS");
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "BINARY_EVENT_EVIDENCE_REQUIRED");
});

test("source-backed complete no-event evidence preserves candidate status with point-in-time liquidity, volatility and market context", () => {
  const input = baseInput();
  input.binaryEventEvidence = noEventEvidence();
  const result = evaluateUsQualityDaytradePreEntry(input);
  assert.equal(result.status, "CANDIDATE");
  assert.equal(result.reason, "VWAP_FIRST_PULLBACK_REBREAK_LIQUID_EVENT_SAFE");
  assert.equal(result.universeProvenance.status, "PASS");
  assert.equal(result.liquidity.status, "PASS");
  assert.equal(result.liquidity.session, "REGULAR");
  assert.equal(result.liquidity.sessionCumulativeShareVolume, 1_025);
  assert.ok(result.liquidity.candleDerivedSessionDollarVolumeUsd > 0);
  assert.equal(result.liquidity.dollarVolumeBasis, "TYPICAL_PRICE_X_COMPLETED_CANDLE_VOLUME");
  assert.equal(result.volatility.status, "PASS");
  assert.equal(result.volatility.atrLookbackUsed, 8);
  assert.ok(result.volatility.atrPct > 0);
  assert.ok(result.volatility.realizedVolatilityPct > 0);
  assert.equal(result.volatility.lookaheadFree, true);
  assert.equal(result.marketContext.status, "PASS");
  assert.equal(result.marketContext.marketRegime, "RISK_OFF");
  assert.equal(result.marketContext.sectorRegime, "OUTPERFORMING");
  assert.equal(result.marketContext.timeOfDayBucket, "REGULAR_OPENING_30");
  assert.equal(result.binaryEventRisk.status, "PASS");
});

test("verified near earnings event inside complete calendar coverage blocks the otherwise-valid setup", () => {
  const input = baseInput();
  const releaseTimestampMs = 8_500 + 60 * 60_000;
  input.binaryEventEvidence = scheduledEvidence({
    eventId: "earnings-release",
    verified: true,
    eventType: "EARNINGS",
    eventTimestampMs: releaseTimestampMs,
    marketMovingTimestampMs: releaseTimestampMs,
  });
  const result = evaluateUsQualityDaytradePreEntry(input);
  assert.equal(result.status, "ABSTAIN");
  assert.equal(result.reason, "BINARY_EVENT_BLACKOUT");
});

test("later earnings call cannot hide an earlier market-moving release", () => {
  const input = baseInput();
  input.binaryEventPolicy = { preEventBlackoutMinutes: 30, postEventCooldownMinutes: 60 };
  input.binaryEventEvidence = scheduledEvidence({
    eventId: "earnings-release-and-call",
    verified: true,
    eventType: "EARNINGS",
    eventTimestampMs: 8_500 + 120 * 60_000,
    marketMovingTimestampMs: 8_500 + 20 * 60_000,
  });
  const result = evaluateUsQualityDaytradePreEntry(input);
  assert.equal(result.status, "ABSTAIN");
  assert.equal(result.reason, "BINARY_EVENT_BLACKOUT");
  assert.equal(result.binaryEventRisk.minutesUntilEvent, 20);
});

test("another near binary event cannot be hidden by supplying only a later safe event", () => {
  const input = baseInput();
  input.binaryEventEvidence = {
    ...noEventEvidence(),
    scheduled: true,
    scheduledEventCount: 2,
    events: [
      {
        eventId: "earnings-later",
        verified: true,
        eventType: "EARNINGS",
        eventTimestampMs: 8_500 + 240 * 60_000,
        marketMovingTimestampMs: 8_500 + 240 * 60_000,
      },
      {
        eventId: "fda-near",
        verified: true,
        eventType: "FDA_DECISION",
        eventTimestampMs: 8_500 + 30 * 60_000,
        marketMovingTimestampMs: 8_500 + 30 * 60_000,
      },
    ],
  };
  const result = evaluateUsQualityDaytradePreEntry(input);
  assert.equal(result.status, "ABSTAIN");
  assert.equal(result.reason, "BINARY_EVENT_BLACKOUT");
  assert.equal(result.binaryEventRisk.blockingEvent.eventId, "fda-near");
});
