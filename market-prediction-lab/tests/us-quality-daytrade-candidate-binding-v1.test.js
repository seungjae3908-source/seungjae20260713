import test from "node:test";
import assert from "node:assert/strict";
import { buildUsQualityDaytradeLiveEvidenceBundle } from "../src/us-quality-daytrade-live-evidence-v1.js";
import { bindUsQualityDaytradeCandidateToLiveEvidence } from "../src/us-quality-daytrade-candidate-binding-v1.js";

function candles(session = "REGULAR") {
  return [
    { open: 100.0, high: 100.8, low: 99.9, close: 100.6, volume: 100, session, timestamp: 1_000 },
    { open: 100.6, high: 102.0, low: 100.5, close: 101.8, volume: 130, session, timestamp: 2_000 },
    { open: 101.8, high: 104.0, low: 101.7, close: 103.8, volume: 160, session, timestamp: 3_000 },
    { open: 103.8, high: 103.9, low: 103.1, close: 103.3, volume: 90, session, timestamp: 4_000 },
    { open: 103.3, high: 103.5, low: 102.9, close: 103.0, volume: 85, session, timestamp: 5_000 },
    { open: 103.0, high: 103.6, low: 103.0, close: 103.5, volume: 100, session, timestamp: 6_000 },
    { open: 103.5, high: 103.9, low: 103.3, close: 103.8, volume: 110, session, timestamp: 7_000 },
    { open: 103.8, high: 104.6, low: 103.5, close: 104.5, volume: 250, session, timestamp: 8_000 },
  ];
}

function liveBundle(session = "REGULAR") {
  const rows = candles(session);
  return buildUsQualityDaytradeLiveEvidenceBundle({
    asOfMs: 8_500,
    quoteEvidence: {
      sourceId: "public-executable-quote-feed",
      pointInTime: true,
      publicReadOnly: true,
      privateApiUsed: false,
      kind: "EXECUTABLE_BID_ASK",
      observedAtMs: 8_000,
      bid: 104.45,
      ask: 104.55,
    },
    candleEvidence: {
      sourceId: "public-intraday-candle-feed",
      pointInTime: true,
      publicReadOnly: true,
      privateApiUsed: false,
      session,
      timeframeMs: 1_000,
      sessionStartTimestampMs: 1_000,
      coverageStartTimestampMs: 1_000,
      lastCompleteCandleTimestampMs: 8_000,
      sessionCoverageComplete: true,
      candles: rows,
    },
    relativeVolumeEvidence: {
      sourceId: "public-rvol-same-phase",
      pointInTime: true,
      publicReadOnly: true,
      privateApiUsed: false,
      session,
      sameSessionPhase: true,
      lookaheadFree: true,
      observedAtMs: 8_000,
      currentCumulativeVolume: 1_100,
      baselineAverageCumulativeVolume: 500,
      baselineSampleCount: 20,
      reportedRelativeVolume: 2.2,
    },
  });
}

function vwap(rows) {
  let numerator = 0;
  let denominator = 0;
  for (const candle of rows) {
    const typical = (candle.high + candle.low + candle.close) / 3;
    numerator += typical * candle.volume;
    denominator += candle.volume;
  }
  return numerator / denominator;
}

function strategyIdentity() {
  return {
    strategyId: "US_QUALITY_DAYTRADE_A",
    strategyVersion: "us-quality-daytrade-trial-registry-v1",
    parameterHash: "candidate-binding-parameter-hash",
    researchCodeSha: "8f50b40ac3c9020d87220ac4bd9353908b316885",
  };
}

function preEntryCandidate(bundle = liveBundle()) {
  const mid = (bundle.quote.bid + bundle.quote.ask) / 2;
  return {
    status: "CANDIDATE",
    qualityTier: "A",
    riskBudgetMultiplier: 1,
    catalystEvidence: { status: "PASS" },
    binaryEventRisk: { status: "PASS" },
    technicalSetup: {
      status: "CANDIDATE",
      qualityTier: "A",
      riskBudgetMultiplier: 1,
      session: bundle.session,
      spreadBps: ((bundle.quote.ask - bundle.quote.bid) / mid) * 10_000,
      quoteAgeMs: bundle.asOfMs - bundle.quote.timestampMs,
      candleAgeMs: bundle.asOfMs - bundle.candleEvidence.lastCompleteCandleTimestampMs,
      relativeVolume: bundle.relativeVolume,
      vwap: vwap(bundle.candles),
      universe: {
        instrument: { symbol: "MRK" },
      },
    },
  };
}

test("raw pre-entry candidate cannot bind without READY source-backed live evidence", () => {
  const result = bindUsQualityDaytradeCandidateToLiveEvidence({
    preEntryResult: preEntryCandidate(),
    bundle: null,
    strategyIdentity: strategyIdentity(),
    symbol: "MRK",
  });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "READY_SOURCE_BACKED_LIVE_EVIDENCE_REQUIRED");
  assert.equal(result.candidateBound, false);
  assert.equal(result.profitabilityEligible, false);
  assert.equal(result.executionAuthority, "NONE");
});

test("matching READY source evidence binds one candidate without execution or profitability authority", () => {
  const bundle = liveBundle();
  assert.equal(bundle.status, "READY");
  const result = bindUsQualityDaytradeCandidateToLiveEvidence({
    preEntryResult: preEntryCandidate(bundle),
    bundle,
    strategyIdentity: strategyIdentity(),
    symbol: "mrk",
  });
  assert.equal(result.status, "BOUND_CANDIDATE");
  assert.equal(result.reason, "SOURCE_BOUND_PRE_ENTRY_CANDIDATE");
  assert.equal(result.candidateBound, true);
  assert.equal(result.symbol, "MRK");
  assert.equal(result.qualityTier, "A");
  assert.equal(result.session, "REGULAR");
  assert.match(result.evidenceId, /^[0-9a-f]{64}$/u);
  assert.equal(result.observationDigest, bundle.provenance.observationDigest);
  assert.equal(result.duplicateCountingAllowed, false);
  assert.equal(result.profitabilityEligible, false);
  assert.equal(result.selectionEligible, false);
  assert.equal(result.executionAuthority, "NONE");
  assert.equal(result.liveTradingAllowed, false);
  assert.equal(result.privateApiAllowed, false);
  assert.equal(result.orderAuthority, false);
});

test("source evidence cannot be attached to a different symbol or session", () => {
  const bundle = liveBundle();
  const wrongSymbol = bindUsQualityDaytradeCandidateToLiveEvidence({
    preEntryResult: preEntryCandidate(bundle),
    bundle,
    strategyIdentity: strategyIdentity(),
    symbol: "TGT",
  });
  assert.equal(wrongSymbol.status, "BLOCKED_DATA");
  assert.equal(wrongSymbol.reason, "CANDIDATE_SYMBOL_MISMATCH");

  const preEntry = preEntryCandidate(bundle);
  preEntry.technicalSetup = { ...preEntry.technicalSetup, session: "PREMARKET" };
  const wrongSession = bindUsQualityDaytradeCandidateToLiveEvidence({
    preEntryResult: preEntry,
    bundle,
    strategyIdentity: strategyIdentity(),
    symbol: "MRK",
  });
  assert.equal(wrongSession.status, "BLOCKED_DATA");
  assert.equal(wrongSession.reason, "LIVE_EVIDENCE_SESSION_MISMATCH");
});

test("quote, candle, RVOL or VWAP drift between raw candidate and source evidence fails closed", () => {
  const bundle = liveBundle();
  const cases = [
    ["spreadBps", 1, "LIVE_EVIDENCE_SPREAD_MISMATCH"],
    ["quoteAgeMs", 1, "LIVE_EVIDENCE_QUOTE_AGE_MISMATCH"],
    ["candleAgeMs", 1, "LIVE_EVIDENCE_CANDLE_AGE_MISMATCH"],
    ["relativeVolume", 0.1, "LIVE_EVIDENCE_RVOL_MISMATCH"],
    ["vwap", 0.1, "LIVE_EVIDENCE_VWAP_MISMATCH"],
  ];
  for (const [field, delta, expectedReason] of cases) {
    const preEntry = preEntryCandidate(bundle);
    preEntry.technicalSetup = {
      ...preEntry.technicalSetup,
      [field]: preEntry.technicalSetup[field] + delta,
    };
    const result = bindUsQualityDaytradeCandidateToLiveEvidence({
      preEntryResult: preEntry,
      bundle,
      strategyIdentity: strategyIdentity(),
      symbol: "MRK",
    });
    assert.equal(result.status, "BLOCKED_DATA");
    assert.equal(result.reason, expectedReason);
    assert.equal(result.candidateBound, false);
  }
});

test("candidate binding requires the pre-entry provenance gates to have passed", () => {
  const bundle = liveBundle();
  const preEntry = preEntryCandidate(bundle);
  preEntry.catalystEvidence = { status: "BLOCKED_DATA" };
  const result = bindUsQualityDaytradeCandidateToLiveEvidence({
    preEntryResult: preEntry,
    bundle,
    strategyIdentity: strategyIdentity(),
    symbol: "MRK",
  });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "PRE_ENTRY_PROVENANCE_GATES_NOT_PASSED");
});
