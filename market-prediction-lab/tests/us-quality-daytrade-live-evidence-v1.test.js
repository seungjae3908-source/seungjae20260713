import test from "node:test";
import assert from "node:assert/strict";
import {
  applyUsQualityDaytradeLiveEvidence,
  buildUsQualityDaytradeLiveEvidenceBundle,
  buildUsQualityDaytradeObservationIdentity,
} from "../src/us-quality-daytrade-live-evidence-v1.js";

function liveEvidence(overrides = {}) {
  const candles = Array.from({ length: 8 }, (_, index) => ({
    open: 100 + index * 0.2,
    high: 100.4 + index * 0.2,
    low: 99.9 + index * 0.2,
    close: 100.3 + index * 0.2,
    volume: 100 + index * 10,
    session: "PREMARKET",
    timestamp: (index + 2) * 1_000,
  }));

  return {
    asOfMs: 10_000,
    quoteEvidence: {
      sourceId: "public-executable-quote-feed",
      pointInTime: true,
      publicReadOnly: true,
      privateApiUsed: false,
      kind: "EXECUTABLE_BID_ASK",
      observedAtMs: 9_500,
      bid: 101.68,
      ask: 101.72,
    },
    candleEvidence: {
      sourceId: "public-intraday-candle-feed",
      pointInTime: true,
      publicReadOnly: true,
      privateApiUsed: false,
      session: "PREMARKET",
      timeframeMs: 1_000,
      sessionStartTimestampMs: 2_000,
      coverageStartTimestampMs: 2_000,
      lastCompleteCandleTimestampMs: 9_000,
      sessionCoverageComplete: true,
      candles,
    },
    relativeVolumeEvidence: {
      sourceId: "public-rvol-same-phase",
      pointInTime: true,
      publicReadOnly: true,
      privateApiUsed: false,
      session: "PREMARKET",
      sameSessionPhase: true,
      lookaheadFree: true,
      observedAtMs: 9_000,
      currentCumulativeVolume: 2_000,
      baselineAverageCumulativeVolume: 1_000,
      baselineSampleCount: 20,
      reportedRelativeVolume: 2,
    },
    ...overrides,
  };
}

function strategyIdentity() {
  return {
    strategyId: "US_QUALITY_DAYTRADE_A",
    strategyVersion: "us-quality-daytrade-trial-registry-v1",
    parameterHash: "parameter-hash-demo",
    researchCodeSha: "8f50b40ac3c9020d87220ac4bd9353908b316885",
  };
}

test("source-backed public intraday evidence composes a READY bundle", () => {
  const result = buildUsQualityDaytradeLiveEvidenceBundle(liveEvidence());
  assert.equal(result.status, "READY");
  assert.equal(result.reason, "SOURCE_BACKED_INTRADAY_EVIDENCE_READY");
  assert.equal(result.session, "PREMARKET");
  assert.equal(result.relativeVolume, 2);
  assert.equal(result.relativeVolumeObservedAtMs, 9_000);
  assert.equal(result.quote.bid, 101.68);
  assert.equal(result.quote.ask, 101.72);
  assert.equal(result.candles.length, 8);
  assert.equal(result.candleEvidence.lastCompleteCandleTimestampMs, 9_000);
  assert.equal(result.provenance.rvolBaselineSampleCount, 20);
  assert.match(result.provenance.observationDigest, /^[0-9a-f]{64}$/u);
  assert.equal(result.evidenceClock.quoteRvolSkewMs, 500);
  assert.equal(result.executionAuthority, "NONE");
  assert.equal(result.liveTradingAllowed, false);
  assert.equal(result.privateApiAllowed, false);
  assert.equal(result.provenance.privateApiUsed, false);
});

test("reference-only price cannot masquerade as executable bid/ask evidence", () => {
  const input = liveEvidence();
  input.quoteEvidence = {
    ...input.quoteEvidence,
    kind: "REFERENCE_ONLY",
    regularMarketPrice: 101.7,
  };
  delete input.quoteEvidence.bid;
  delete input.quoteEvidence.ask;
  const result = buildUsQualityDaytradeLiveEvidenceBundle(input);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "EXECUTABLE_BID_ASK_PROVENANCE_REQUIRED");
});

test("private or non-public quote evidence fails closed", () => {
  const input = liveEvidence();
  input.quoteEvidence.publicReadOnly = false;
  const result = buildUsQualityDaytradeLiveEvidenceBundle(input);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "QUOTE_PUBLIC_READ_ONLY_REQUIRED");
});

test("future quote evidence fails closed", () => {
  const input = liveEvidence();
  input.quoteEvidence.observedAtMs = 11_000;
  const result = buildUsQualityDaytradeLiveEvidenceBundle(input);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "QUOTE_EVIDENCE_FROM_FUTURE");
});

test("RVOL must compare the same session phase without lookahead", () => {
  const input = liveEvidence();
  input.relativeVolumeEvidence.sameSessionPhase = false;
  const result = buildUsQualityDaytradeLiveEvidenceBundle(input);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "RVOL_SAME_SESSION_PHASE_REQUIRED");

  input.relativeVolumeEvidence.sameSessionPhase = true;
  input.relativeVolumeEvidence.lookaheadFree = false;
  const lookaheadResult = buildUsQualityDaytradeLiveEvidenceBundle(input);
  assert.equal(lookaheadResult.status, "BLOCKED_DATA");
  assert.equal(lookaheadResult.reason, "RVOL_LOOKAHEAD_FREE_EVIDENCE_REQUIRED");
});

test("reported RVOL cannot disagree with source volume components", () => {
  const input = liveEvidence();
  input.relativeVolumeEvidence.reportedRelativeVolume = 3;
  const result = buildUsQualityDaytradeLiveEvidenceBundle(input);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "RVOL_REPORTED_VALUE_MISMATCH");
});

test("stale RVOL fails closed even when quote is still fresh", () => {
  const input = liveEvidence({
    dataPolicy: {
      maxQuoteAgeMs: 750,
      maxCandleLagIntervals: 1.5,
      maxCrossSourceSkewMs: 15_000,
    },
  });
  const result = buildUsQualityDaytradeLiveEvidenceBundle(input);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "LIVE_RVOL_STALE");
  assert.equal(result.rvolAgeMs, 1_000);
});

test("cross-source quote/RVOL clock skew fails closed", () => {
  const input = liveEvidence({
    dataPolicy: {
      maxQuoteAgeMs: 15_000,
      maxCandleLagIntervals: 1.5,
      maxCrossSourceSkewMs: 400,
    },
  });
  const result = buildUsQualityDaytradeLiveEvidenceBundle(input);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "LIVE_EVIDENCE_CLOCK_SKEW_TOO_WIDE");
  assert.equal(result.quoteRvolSkewMs, 500);
});

test("candle session mismatch fails closed instead of relabeling VWAP coverage", () => {
  const input = liveEvidence();
  input.candleEvidence.candles[3] = {
    ...input.candleEvidence.candles[3],
    session: "REGULAR",
  };
  const result = buildUsQualityDaytradeLiveEvidenceBundle(input);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "CANDLE_SESSION_MISMATCH");
});

test("same strategy, symbol, and market observation gets one deterministic evidence id", () => {
  const first = buildUsQualityDaytradeLiveEvidenceBundle(liveEvidence());
  const second = buildUsQualityDaytradeLiveEvidenceBundle(liveEvidence());
  const firstIdentity = buildUsQualityDaytradeObservationIdentity({ strategyIdentity: strategyIdentity(), bundle: first, symbol: "COIN" });
  const secondIdentity = buildUsQualityDaytradeObservationIdentity({ strategyIdentity: strategyIdentity(), bundle: second, symbol: "coin" });
  assert.equal(first.provenance.observationDigest, second.provenance.observationDigest);
  assert.equal(firstIdentity.evidenceId, secondIdentity.evidenceId);
  assert.equal(firstIdentity.symbol, "COIN");
  assert.equal(firstIdentity.duplicateCountingAllowed, false);
  assert.equal(firstIdentity.selectionEligible, false);
  assert.equal(firstIdentity.executionAuthority, "NONE");
});

test("same numeric observation on a different symbol cannot collide", () => {
  const bundle = buildUsQualityDaytradeLiveEvidenceBundle(liveEvidence());
  const coin = buildUsQualityDaytradeObservationIdentity({ strategyIdentity: strategyIdentity(), bundle, symbol: "COIN" });
  const mstr = buildUsQualityDaytradeObservationIdentity({ strategyIdentity: strategyIdentity(), bundle, symbol: "MSTR" });
  assert.notEqual(coin.evidenceId, mstr.evidenceId);
});

test("a genuinely different executable quote produces a different observation identity", () => {
  const first = buildUsQualityDaytradeLiveEvidenceBundle(liveEvidence());
  const changedInput = liveEvidence();
  changedInput.quoteEvidence.bid = 101.70;
  changedInput.quoteEvidence.ask = 101.74;
  const second = buildUsQualityDaytradeLiveEvidenceBundle(changedInput);
  const firstIdentity = buildUsQualityDaytradeObservationIdentity({ strategyIdentity: strategyIdentity(), bundle: first, symbol: "COIN" });
  const secondIdentity = buildUsQualityDaytradeObservationIdentity({ strategyIdentity: strategyIdentity(), bundle: second, symbol: "COIN" });
  assert.notEqual(first.provenance.observationDigest, second.provenance.observationDigest);
  assert.notEqual(firstIdentity.evidenceId, secondIdentity.evidenceId);
});

test("observation identity requires an explicit symbol", () => {
  const bundle = buildUsQualityDaytradeLiveEvidenceBundle(liveEvidence());
  assert.throws(
    () => buildUsQualityDaytradeObservationIdentity({ strategyIdentity: strategyIdentity(), bundle }),
    /symbol is required/,
  );
});

test("READY bundle can be attached to the existing pre-entry input without mutation", () => {
  const bundle = buildUsQualityDaytradeLiveEvidenceBundle(liveEvidence());
  const base = Object.freeze({
    instrument: Object.freeze({ symbol: "TEST" }),
    catalyst: Object.freeze({ verified: true }),
  });
  const result = applyUsQualityDaytradeLiveEvidence(base, bundle);
  assert.equal(result.instrument.symbol, "TEST");
  assert.equal(result.relativeVolume, 2);
  assert.equal(result.relativeVolumeObservedAtMs, 9_000);
  assert.equal(result.quote.timestampMs, 9_500);
  assert.equal(result.liveEvidenceProvenance.quoteSourceId, "public-executable-quote-feed");
  assert.match(result.liveEvidenceProvenance.observationDigest, /^[0-9a-f]{64}$/u);
  assert.equal(base.quote, undefined);
});
