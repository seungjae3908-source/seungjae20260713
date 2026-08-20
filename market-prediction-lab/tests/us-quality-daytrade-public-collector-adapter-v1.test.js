import test from "node:test";
import assert from "node:assert/strict";
import {
  admitUsQualityDaytradePublicCollectorObservation,
} from "../src/us-quality-daytrade-public-collector-adapter-v1.js";
import { createUsQualityDaytradeEvidenceLedger } from "../src/us-quality-daytrade-evidence-admission-v1.js";

function candles() {
  return Array.from({ length: 8 }, (_, index) => ({
    open: 100 + index * 0.2,
    high: 100.4 + index * 0.2,
    low: 99.9 + index * 0.2,
    close: 100.3 + index * 0.2,
    volume: 100 + index * 10,
    session: "REGULAR",
    timestamp: (index + 2) * 1_000,
  }));
}

function strategyIdentity() {
  return {
    strategyId: "US_QUALITY_DAYTRADE_A",
    strategyVersion: "us-quality-daytrade-trial-registry-v1",
    parameterHash: "parameter-hash-demo",
    researchCodeSha: "1".repeat(40),
  };
}

function validInput(overrides = {}) {
  return {
    ledger: createUsQualityDaytradeEvidenceLedger(),
    strategyIdentity: strategyIdentity(),
    symbol: "COIN",
    workflowFamily: "RESEARCH_PRODUCTION",
    artifactLineageDigest: "a".repeat(64),
    asOfMs: 10_000,
    collectorProof: {
      sourceId: "public-us-stock-intraday-collector",
      publicReadOnly: true,
      privateApiUsed: false,
      liveTradingAllowed: false,
      orderAuthority: false,
      quoteSemantics: "EXECUTABLE_BID_ASK",
      syntheticBidAsk: false,
      referencePriceUsedAsBidAsk: false,
    },
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
      session: "REGULAR",
      timeframeMs: 1_000,
      sessionStartTimestampMs: 2_000,
      coverageStartTimestampMs: 2_000,
      lastCompleteCandleTimestampMs: 9_000,
      sessionCoverageComplete: true,
      candles: candles(),
    },
    relativeVolumeEvidence: {
      sourceId: "public-rvol-same-phase",
      pointInTime: true,
      publicReadOnly: true,
      privateApiUsed: false,
      session: "REGULAR",
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

test("reference-only public collector cannot be promoted into executable quote evidence", () => {
  const input = validInput({
    collectorProof: {
      sourceId: "yahoo-public-chart",
      publicReadOnly: true,
      privateApiUsed: false,
      liveTradingAllowed: false,
      orderAuthority: false,
      quoteSemantics: "REFERENCE_PRICE",
      syntheticBidAsk: false,
      referencePriceUsedAsBidAsk: true,
    },
  });
  const result = admitUsQualityDaytradePublicCollectorObservation(input);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "PUBLIC_COLLECTOR_EXECUTABLE_QUOTE_CONTRACT_REQUIRED");
  assert.equal(result.sampleCountDelta, 0);
  assert.equal(result.ledger.records.length, 0);
  assert.equal(result.liveTradingAllowed, false);
  assert.equal(result.privateApiAllowed, false);
  assert.equal(result.orderAuthority, false);
});

test("synthetic bid ask remains blocked even when the caller labels it executable", () => {
  const input = validInput({
    collectorProof: {
      sourceId: "unsafe-reference-price-adapter",
      publicReadOnly: true,
      privateApiUsed: false,
      liveTradingAllowed: false,
      orderAuthority: false,
      quoteSemantics: "EXECUTABLE_BID_ASK",
      syntheticBidAsk: true,
      referencePriceUsedAsBidAsk: true,
    },
  });
  const result = admitUsQualityDaytradePublicCollectorObservation(input);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "PUBLIC_COLLECTOR_SYNTHETIC_BID_ASK_FORBIDDEN");
  assert.equal(result.sampleCountDelta, 0);
  assert.equal(result.ledger.records.length, 0);
});

test("source-backed public executable evidence is admitted once", () => {
  const first = admitUsQualityDaytradePublicCollectorObservation(validInput());
  assert.equal(first.status, "EVIDENCE_ACCEPTED");
  assert.equal(first.sampleCountDelta, 1);
  assert.equal(first.canonicalSampleAccepted, true);
  assert.equal(first.ledger.records.length, 1);
  assert.equal(first.collector.quoteSemantics, "EXECUTABLE_BID_ASK");
  assert.equal(first.executionAuthority, "NONE");
  assert.equal(first.liveTradingAllowed, false);

  const audit = admitUsQualityDaytradePublicCollectorObservation(validInput({
    ledger: first.ledger,
    workflowFamily: "GITHUB_ACTIONS",
    artifactLineageDigest: "b".repeat(64),
  }));
  assert.equal(audit.status, "DUPLICATE_ACCEPTED_ONCE");
  assert.equal(audit.sampleCountDelta, 0);
  assert.equal(audit.canonicalSampleAccepted, false);
  assert.equal(audit.ledger.records.length, 1);
  assert.equal(audit.ledger.records[0].sources.length, 2);
  assert.equal(audit.duplicateCountingAllowed, false);
});

test("live evidence blockers propagate without touching the global ledger", () => {
  const input = validInput({
    quoteEvidence: {
      sourceId: "public-reference-price-feed",
      pointInTime: true,
      publicReadOnly: true,
      privateApiUsed: false,
      kind: "REFERENCE_PRICE",
      observedAtMs: 9_500,
      bid: 101.68,
      ask: 101.72,
    },
  });
  const result = admitUsQualityDaytradePublicCollectorObservation(input);
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "EXECUTABLE_BID_ASK_PROVENANCE_REQUIRED");
  assert.equal(result.liveEvidenceReason, "EXECUTABLE_BID_ASK_PROVENANCE_REQUIRED");
  assert.equal(result.sampleCountDelta, 0);
  assert.equal(result.ledger.records.length, 0);
});
