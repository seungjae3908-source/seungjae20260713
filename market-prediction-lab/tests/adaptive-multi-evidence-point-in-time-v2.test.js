import assert from "node:assert/strict";
import test from "node:test";
import {
  ADAPTIVE_MULTI_EVIDENCE_POINT_IN_TIME_VERSION,
  ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
  buildAdaptiveMultiEvidenceDecisionSnapshotV2,
  buildAdaptiveMultiEvidencePointInTimeV2,
} from "../src/adaptive-multi-evidence-point-in-time-v2.js";

const DECISION_TIME = "2026-09-14T00:03:00.000Z";

function input(overrides = {}) {
  return {
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    family: "NEWS",
    market: "US_STOCK",
    symbol: "TEST",
    timeframe: "15m",
    side: "LONG",
    sourceId: "news-provider:item-1",
    originalSourceId: "wire-service:item-1",
    sourceType: "NEWS",
    sourceUrl: "https://example.com/item-1",
    documentId: null,
    eventTime: "2026-09-14T00:00:00.000Z",
    publishedAt: "2026-09-14T00:01:00.000Z",
    availableAt: "2026-09-14T00:01:30.000Z",
    observedAt: "2026-09-14T00:02:00.000Z",
    decisionTime: DECISION_TIME,
    contentDigest: "a".repeat(64),
    facts: ["Issuer published a filing."],
    inferences: ["Event risk needs specialist review."],
    uncertainty: ["Price-direction impact is unknown."],
    synthetic: false,
    replay: false,
    backfill: false,
    manualEconomicCredit: false,
    liveTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: "NONE",
    ...overrides,
  };
}

test("V2 point-in-time evidence freezes five clocks without V1 or execution authority", () => {
  const result = buildAdaptiveMultiEvidencePointInTimeV2(input());
  assert.equal(result.status, "ADMISSIBLE");
  assert.equal(result.evidence.schemaVersion, ADAPTIVE_MULTI_EVIDENCE_POINT_IN_TIME_VERSION);
  assert.equal(result.evidence.lineageId, "ADAPTIVE_MULTI_EVIDENCE_V2");
  assert.deepEqual(result.evidence.identity.temporal, {
    eventTime: "2026-09-14T00:00:00.000Z",
    publishedAt: "2026-09-14T00:01:00.000Z",
    availableAt: "2026-09-14T00:01:30.000Z",
    observedAt: "2026-09-14T00:02:00.000Z",
    decisionTime: DECISION_TIME,
  });
  assert.match(result.evidenceId, /^adaptive-v2-evidence:[0-9a-f]{64}$/u);
  assert.equal(result.economicSampleCredit, 0);
  assert.equal(result.evidence.v1EconomicIdentityMutable, false);
  assert.equal(result.evidence.executionAuthority, "NONE");
  assert.equal(result.evidence.independenceStatus, "NOT_YET_PROVEN");
});

test("future news is unavailable to an earlier decision", () => {
  const result = buildAdaptiveMultiEvidencePointInTimeV2(input({
    availableAt: "2026-09-14T00:04:00.000Z",
    observedAt: "2026-09-14T00:04:30.000Z",
  }));
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.evidence, null);
  assert.ok(result.blockers.includes("POINT_IN_TIME_EVIDENCE_UNAVAILABLE_AT_DECISION"));
  assert.ok(result.blockers.includes("POINT_IN_TIME_EVIDENCE_UNOBSERVED_AT_DECISION"));
});

test("future disclosure is unavailable to an earlier decision", () => {
  const result = buildAdaptiveMultiEvidencePointInTimeV2(input({
    family: "DISCLOSURE",
    sourceType: "SEC_FILING",
    sourceUrl: null,
    documentId: "sec-accession-1",
    availableAt: "2026-09-14T00:03:01.000Z",
    observedAt: "2026-09-14T00:03:02.000Z",
  }));
  assert.equal(result.status, "BLOCKED_DATA");
  assert.ok(result.blockers.includes("POINT_IN_TIME_EVIDENCE_UNAVAILABLE_AT_DECISION"));
});

test("missing availability never becomes a zero or an admissible item", () => {
  const result = buildAdaptiveMultiEvidencePointInTimeV2(input({ availableAt: null }));
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.evidenceId, null);
  assert.ok(result.blockers.includes("POINT_IN_TIME_AVAILABLE_AT_REQUIRED"));
  assert.ok(result.missingEvidence.includes("availableAt"));
});

test("temporal ordering fails closed", () => {
  const result = buildAdaptiveMultiEvidencePointInTimeV2(input({
    publishedAt: "2026-09-14T00:02:00.000Z",
    availableAt: "2026-09-14T00:01:00.000Z",
  }));
  assert.equal(result.status, "BLOCKED_DATA");
  assert.ok(result.blockers.includes("POINT_IN_TIME_PUBLICATION_AFTER_AVAILABILITY"));
});

test("V1 and foreign lineages cannot enter the V2 snapshot", () => {
  const result = buildAdaptiveMultiEvidencePointInTimeV2(input({ lineageId: "FROZEN_CHALLENGER_V1" }));
  assert.equal(result.status, "BLOCKED_DATA");
  assert.ok(result.blockers.includes("V1_OR_FOREIGN_LINEAGE_CONTAMINATION_FORBIDDEN"));
  assert.equal(result.economicSampleCredit, 0);
});

test("synthetic, replay, backfill, manual credit, probability, EV, and confidence fail closed", () => {
  const result = buildAdaptiveMultiEvidencePointInTimeV2(input({
    synthetic: true,
    replay: true,
    backfill: true,
    manualEconomicCredit: true,
    probability: 0.78,
    expectedValue: 1.2,
    confidence: 0.9,
  }));
  assert.equal(result.status, "BLOCKED_DATA");
  for (const blocker of [
    "POINT_IN_TIME_SYNTHETIC_PROVENANCE_FORBIDDEN",
    "POINT_IN_TIME_REPLAY_CREDIT_FORBIDDEN",
    "POINT_IN_TIME_BACKFILL_CREDIT_FORBIDDEN",
    "POINT_IN_TIME_MANUAL_ECONOMIC_CREDIT_FORBIDDEN",
    "UNVALIDATED_PROBABILITY_FORBIDDEN",
    "UNVALIDATED_EXPECTED_VALUE_FORBIDDEN",
    "UNVALIDATED_CONFIDENCE_FORBIDDEN",
  ]) assert.ok(result.blockers.includes(blocker), blocker);
});

test("identity is deterministic and temporal identity changes are immutable", () => {
  const first = buildAdaptiveMultiEvidencePointInTimeV2(input());
  const same = buildAdaptiveMultiEvidencePointInTimeV2(input());
  const changed = buildAdaptiveMultiEvidencePointInTimeV2(input({ observedAt: "2026-09-14T00:02:01.000Z" }));
  assert.equal(first.evidenceId, same.evidenceId);
  assert.notEqual(first.evidenceId, changed.evidenceId);
  assert.throws(() => { first.evidence.identity.market = "KR_STOCK"; }, TypeError);
});

test("decision snapshot accepts only exact-time V2 evidence and blocks duplicates", () => {
  const first = buildAdaptiveMultiEvidencePointInTimeV2(input());
  const ready = buildAdaptiveMultiEvidenceDecisionSnapshotV2({ decisionTime: DECISION_TIME, evidence: [first] });
  assert.equal(ready.status, "READY_FOR_SPECIALIST_RESEARCH_ONLY");
  assert.equal(ready.snapshot.evidenceCount, 1);
  assert.equal(ready.snapshot.independenceStatus, "NOT_YET_PROVEN");
  assert.equal(ready.snapshot.metaDecisionAuthority, "NONE");
  assert.equal(ready.snapshot.economicSampleCredit, 0);

  const duplicate = buildAdaptiveMultiEvidenceDecisionSnapshotV2({
    decisionTime: DECISION_TIME,
    evidence: [first, first],
  });
  assert.equal(duplicate.status, "BLOCKED_DATA");
  assert.ok(duplicate.blockers.includes("V2_DECISION_DUPLICATE_EVIDENCE_ID"));

  const wrongTime = buildAdaptiveMultiEvidenceDecisionSnapshotV2({
    decisionTime: "2026-09-14T00:04:00.000Z",
    evidence: [first],
  });
  assert.equal(wrongTime.status, "BLOCKED_DATA");
  assert.ok(wrongTime.blockers.includes("V2_DECISION_TIME_IDENTITY_MISMATCH"));
});
