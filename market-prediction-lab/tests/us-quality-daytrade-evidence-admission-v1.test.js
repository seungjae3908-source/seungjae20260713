import test from "node:test";
import assert from "node:assert/strict";
import {
  admitUsQualityDaytradeEvidence,
  createUsQualityDaytradeEvidenceLedger,
} from "../src/us-quality-daytrade-evidence-admission-v1.js";
import { buildUsQualityDaytradeLiveEvidenceBundle } from "../src/us-quality-daytrade-live-evidence-v1.js";

function liveBundle(overrides = {}) {
  const candles = Array.from({ length: 8 }, (_, index) => ({
    open: 100 + index * 0.2,
    high: 100.4 + index * 0.2,
    low: 99.9 + index * 0.2,
    close: 100.3 + index * 0.2,
    volume: 100 + index * 10,
    session: "REGULAR",
    timestamp: (index + 2) * 1_000,
  }));
  return buildUsQualityDaytradeLiveEvidenceBundle({
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
      session: "REGULAR",
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
  });
}

function strategyIdentity() {
  return {
    strategyId: "US_QUALITY_DAYTRADE_A",
    strategyVersion: "us-quality-daytrade-trial-registry-v1",
    parameterHash: "parameter-hash-demo",
    researchCodeSha: "1".repeat(40),
  };
}

function admit({ ledger, bundle = liveBundle(), symbol = "COIN", workflowFamily, artifactLineageDigest }) {
  return admitUsQualityDaytradeEvidence({
    ledger,
    strategyIdentity: strategyIdentity(),
    symbol,
    bundle,
    workflowFamily,
    artifactLineageDigest,
  });
}

test("Research Production and GitHub observations are admitted once globally", () => {
  const empty = createUsQualityDaytradeEvidenceLedger();
  const primary = admit({
    ledger: empty,
    workflowFamily: "RESEARCH_PRODUCTION",
    artifactLineageDigest: "a".repeat(64),
  });
  assert.equal(primary.status, "EVIDENCE_ACCEPTED");
  assert.equal(primary.sampleCountDelta, 1);
  assert.equal(primary.canonicalSampleAccepted, true);
  assert.equal(primary.ledger.records.length, 1);

  const audit = admit({
    ledger: primary.ledger,
    workflowFamily: "GITHUB_ACTIONS",
    artifactLineageDigest: "b".repeat(64),
  });
  assert.equal(audit.status, "DUPLICATE_ACCEPTED_ONCE");
  assert.equal(audit.sampleCountDelta, 0);
  assert.equal(audit.canonicalSampleAccepted, false);
  assert.equal(audit.evidenceId, primary.evidenceId);
  assert.equal(audit.ledger.records.length, 1);
  assert.equal(audit.ledger.records[0].sources.length, 2);
  assert.equal(audit.duplicateCountingAllowed, false);
  assert.equal(audit.selectionEligible, false);
  assert.equal(audit.executionAuthority, "NONE");
  assert.equal(audit.liveTradingAllowed, false);
  assert.equal(audit.privateApiAllowed, false);
  assert.equal(audit.orderAuthority, false);
});

test("GitHub Actions cannot seed a canonical sample before Research Production", () => {
  const empty = createUsQualityDaytradeEvidenceLedger();
  const auditFirst = admit({
    ledger: empty,
    workflowFamily: "GITHUB_ACTIONS",
    artifactLineageDigest: "b".repeat(64),
  });
  assert.equal(auditFirst.status, "BLOCKED_DATA");
  assert.equal(auditFirst.reason, "RESEARCH_PRODUCTION_PRIMARY_EVIDENCE_REQUIRED");
  assert.equal(auditFirst.sampleCountDelta, 0);
  assert.equal(auditFirst.canonicalSampleAccepted, false);
  assert.equal(auditFirst.auditOnly, true);
  assert.equal(auditFirst.primaryRuntime, "RESEARCH_PRODUCTION");
  assert.equal(auditFirst.ledger, empty);
  assert.equal(auditFirst.ledger.records.length, 0);
  assert.equal(auditFirst.ledger.duplicateAttempts.length, 0);

  const primary = admit({
    ledger: auditFirst.ledger,
    workflowFamily: "RESEARCH_PRODUCTION",
    artifactLineageDigest: "a".repeat(64),
  });
  assert.equal(primary.status, "EVIDENCE_ACCEPTED");
  assert.equal(primary.sampleCountDelta, 1);
  assert.equal(primary.ledger.records.length, 1);
});

test("same numeric observation on another symbol is a distinct canonical sample", () => {
  const empty = createUsQualityDaytradeEvidenceLedger();
  const coin = admit({
    ledger: empty,
    symbol: "COIN",
    workflowFamily: "RESEARCH_PRODUCTION",
    artifactLineageDigest: "a".repeat(64),
  });
  const mstr = admit({
    ledger: coin.ledger,
    symbol: "MSTR",
    workflowFamily: "RESEARCH_PRODUCTION",
    artifactLineageDigest: "a".repeat(64),
  });
  assert.equal(mstr.status, "EVIDENCE_ACCEPTED");
  assert.equal(mstr.sampleCountDelta, 1);
  assert.notEqual(mstr.evidenceId, coin.evidenceId);
  assert.equal(mstr.ledger.records.length, 2);
});

test("genuinely changed executable quote is a new observation", () => {
  const empty = createUsQualityDaytradeEvidenceLedger();
  const first = admit({
    ledger: empty,
    workflowFamily: "RESEARCH_PRODUCTION",
    artifactLineageDigest: "a".repeat(64),
  });
  const changed = liveBundle({
    quoteEvidence: {
      sourceId: "public-executable-quote-feed",
      pointInTime: true,
      publicReadOnly: true,
      privateApiUsed: false,
      kind: "EXECUTABLE_BID_ASK",
      observedAtMs: 9_700,
      bid: 101.70,
      ask: 101.74,
    },
  });
  const second = admit({
    ledger: first.ledger,
    bundle: changed,
    workflowFamily: "RESEARCH_PRODUCTION",
    artifactLineageDigest: "a".repeat(64),
  });
  assert.equal(second.status, "EVIDENCE_ACCEPTED");
  assert.equal(second.sampleCountDelta, 1);
  assert.notEqual(second.evidenceId, first.evidenceId);
  assert.equal(second.ledger.records.length, 2);
});

test("non-READY evidence fails closed without touching the ledger", () => {
  const ledger = createUsQualityDaytradeEvidenceLedger();
  const result = admitUsQualityDaytradeEvidence({
    ledger,
    strategyIdentity: strategyIdentity(),
    symbol: "COIN",
    bundle: { status: "BLOCKED_DATA", reason: "EXECUTABLE_BID_ASK_PROVENANCE_REQUIRED" },
    workflowFamily: "RESEARCH_PRODUCTION",
    artifactLineageDigest: "a".repeat(64),
  });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "READY_SOURCE_BACKED_LIVE_EVIDENCE_REQUIRED");
  assert.equal(result.sampleCountDelta, 0);
  assert.equal(result.duplicateCountingAllowed, false);
  assert.equal(ledger.records.length, 0);
});
