import test from "node:test";
import assert from "node:assert/strict";
import {
  applyUsQualityDaytradeLiveEvidence,
  buildUsQualityDaytradeLiveEvidenceBundle,
} from "../src/us-quality-daytrade-live-evidence-v1.js";

function liveEvidence(overrides = {}) {
  const candles = Array.from({ length: 8 }, (_, index) => ({
    open: 100 + index * 0.2,
    high: 100.4 + index * 0.2,
    low: 99.9 + index * 0.2,
    close: 100.3 + index * 0.2,
    volume: 100 + index * 10,
    session: "PREMARKET",
    timestamp: (index + 1) * 1_000,
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
      sessionStartTimestampMs: 1_000,
      coverageStartTimestampMs: 1_000,
      lastCompleteCandleTimestampMs: 8_000,
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

test("source-backed public intraday evidence composes a READY bundle", () => {
  const result = buildUsQualityDaytradeLiveEvidenceBundle(liveEvidence());
  assert.equal(result.status, "READY");
  assert.equal(result.reason, "SOURCE_BACKED_INTRADAY_EVIDENCE_READY");
  assert.equal(result.session, "PREMARKET");
  assert.equal(result.relativeVolume, 2);
  assert.equal(result.quote.bid, 101.68);
  assert.equal(result.quote.ask, 101.72);
  assert.equal(result.candles.length, 8);
  assert.equal(result.candleEvidence.lastCompleteCandleTimestampMs, 8_000);
  assert.equal(result.provenance.rvolBaselineSampleCount, 20);
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

test("READY bundle can be attached to the existing pre-entry input without mutation", () => {
  const bundle = buildUsQualityDaytradeLiveEvidenceBundle(liveEvidence());
  const base = Object.freeze({
    instrument: Object.freeze({ symbol: "TEST" }),
    catalyst: Object.freeze({ verified: true }),
  });
  const result = applyUsQualityDaytradeLiveEvidence(base, bundle);
  assert.equal(result.instrument.symbol, "TEST");
  assert.equal(result.relativeVolume, 2);
  assert.equal(result.quote.timestampMs, 9_500);
  assert.equal(result.liveEvidenceProvenance.quoteSourceId, "public-executable-quote-feed");
  assert.equal(base.quote, undefined);
});
