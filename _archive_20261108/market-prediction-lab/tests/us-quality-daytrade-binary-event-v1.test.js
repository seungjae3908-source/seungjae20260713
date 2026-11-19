import test from "node:test";
import assert from "node:assert/strict";
import {
  buildQualityDaytradeBinaryEventWindowGrid,
  evaluateQualityDaytradeBinaryEventRisk,
} from "../src/us-quality-daytrade-binary-event-v1.js";

const AS_OF = Date.UTC(2026, 7, 20, 13, 0, 0);
const policy = Object.freeze({ preEventBlackoutMinutes: 120, postEventCooldownMinutes: 60 });

function noEventEvidence(overrides = {}) {
  return {
    calendarChecked: true,
    checkedAtMs: AS_OF - 60_000,
    scheduled: false,
    scheduledEventCount: 0,
    events: [],
    source: "issuer-calendar",
    validUntilMs: AS_OF + 15 * 60_000,
    coverageComplete: true,
    coverageStartMs: AS_OF - 24 * 60 * 60_000,
    coverageEndMs: AS_OF + 24 * 60 * 60_000,
    ...overrides,
  };
}

function eventAt(minutesFromNow, overrides = {}) {
  const timestamp = AS_OF + minutesFromNow * 60_000;
  return {
    eventId: `event-${minutesFromNow}`,
    verified: true,
    eventType: "EARNINGS",
    eventTimestampMs: timestamp,
    marketMovingTimestampMs: timestamp,
    ...overrides,
  };
}

function scheduledEventEvidence(minutesFromNow, { event: eventOverrides = {}, ...envelopeOverrides } = {}) {
  const event = eventAt(minutesFromNow, eventOverrides);
  return {
    ...noEventEvidence(),
    scheduled: true,
    scheduledEventCount: 1,
    events: [event],
    ...envelopeOverrides,
  };
}

test("binary-event gate requires a caller-versioned policy before trusting calendar coverage", () => {
  const result = evaluateQualityDaytradeBinaryEventRisk({ asOfMs: AS_OF, binaryEventEvidence: noEventEvidence() });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "BINARY_EVENT_POLICY_REQUIRED");
  assert.equal(result.executionAuthority, "NONE");
  assert.equal(result.liveTradingAllowed, false);
  assert.equal(result.privateApiAllowed, false);
});

test("binary-event gate fails closed when calendar evidence is missing", () => {
  const result = evaluateQualityDaytradeBinaryEventRisk({ asOfMs: AS_OF, binaryEventPolicy: policy });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "BINARY_EVENT_EVIDENCE_REQUIRED");
});

test("missing event provenance fields return BLOCKED_DATA instead of throwing or passing", () => {
  const missingCheckedAt = evaluateQualityDaytradeBinaryEventRisk({ asOfMs: AS_OF, binaryEventEvidence: noEventEvidence({ checkedAtMs: null }), binaryEventPolicy: policy });
  assert.equal(missingCheckedAt.reason, "BINARY_EVENT_CHECKED_AT_REQUIRED");

  const missingValidity = evaluateQualityDaytradeBinaryEventRisk({ asOfMs: AS_OF, binaryEventEvidence: noEventEvidence({ validUntilMs: null }), binaryEventPolicy: policy });
  assert.equal(missingValidity.reason, "BINARY_EVENT_VALID_UNTIL_REQUIRED");

  const missingCoverage = evaluateQualityDaytradeBinaryEventRisk({ asOfMs: AS_OF, binaryEventEvidence: noEventEvidence({ coverageEndMs: null }), binaryEventPolicy: policy });
  assert.equal(missingCoverage.reason, "BINARY_EVENT_COVERAGE_REQUIRED");

  const missingEventTimestamp = evaluateQualityDaytradeBinaryEventRisk({ asOfMs: AS_OF, binaryEventEvidence: scheduledEventEvidence(90, { event: { eventTimestampMs: null } }), binaryEventPolicy: policy });
  assert.equal(missingEventTimestamp.reason, "BINARY_EVENT_TIMESTAMP_REQUIRED");

  const missingMarketMovingTimestamp = evaluateQualityDaytradeBinaryEventRisk({ asOfMs: AS_OF, binaryEventEvidence: scheduledEventEvidence(90, { event: { marketMovingTimestampMs: null } }), binaryEventPolicy: policy });
  assert.equal(missingMarketMovingTimestamp.status, "BLOCKED_DATA");
  assert.equal(missingMarketMovingTimestamp.reason, "BINARY_EVENT_MARKET_MOVING_TIMESTAMP_REQUIRED");
});

test("fresh source-backed no-event calendar evidence passes only with complete two-sided coverage", () => {
  const result = evaluateQualityDaytradeBinaryEventRisk({ asOfMs: AS_OF, binaryEventEvidence: noEventEvidence(), binaryEventPolicy: policy });
  assert.equal(result.status, "PASS");
  assert.equal(result.reason, "NO_SCHEDULED_BINARY_EVENT");
  assert.equal(result.evidence.source, "issuer-calendar");
  assert.equal(result.evidence.coverageComplete, true);
  assert.equal(result.evidence.scheduledEventCount, 0);
  assert.deepEqual(result.evidence.events, []);
  assert.ok(result.evidence.coverageStartMs <= result.evidence.requiredCoverageStartMs);
  assert.ok(result.evidence.coverageEndMs >= result.evidence.requiredCoverageEndMs);
});

test("complete calendar evidence must enumerate events and attest the exact event count", () => {
  const missingCount = evaluateQualityDaytradeBinaryEventRisk({
    asOfMs: AS_OF,
    binaryEventPolicy: policy,
    binaryEventEvidence: { ...noEventEvidence(), scheduledEventCount: null },
  });
  assert.equal(missingCount.reason, "BINARY_EVENT_COUNT_REQUIRED");

  const missingList = evaluateQualityDaytradeBinaryEventRisk({
    asOfMs: AS_OF,
    binaryEventPolicy: policy,
    binaryEventEvidence: { ...noEventEvidence(), events: null },
  });
  assert.equal(missingList.reason, "BINARY_EVENT_LIST_REQUIRED");

  const mismatch = evaluateQualityDaytradeBinaryEventRisk({
    asOfMs: AS_OF,
    binaryEventPolicy: policy,
    binaryEventEvidence: { ...noEventEvidence(), scheduled: true, scheduledEventCount: 2, events: [eventAt(180)] },
  });
  assert.equal(mismatch.reason, "BINARY_EVENT_COUNT_MISMATCH");
});

test("schedule state must agree with the attested event count", () => {
  const falseWithEvent = evaluateQualityDaytradeBinaryEventRisk({
    asOfMs: AS_OF,
    binaryEventPolicy: policy,
    binaryEventEvidence: { ...noEventEvidence(), scheduledEventCount: 1, events: [eventAt(180)] },
  });
  assert.equal(falseWithEvent.reason, "BINARY_EVENT_SCHEDULE_COUNT_MISMATCH");

  const trueWithoutEvent = evaluateQualityDaytradeBinaryEventRisk({
    asOfMs: AS_OF,
    binaryEventPolicy: policy,
    binaryEventEvidence: { ...noEventEvidence(), scheduled: true },
  });
  assert.equal(trueWithoutEvent.reason, "BINARY_EVENT_SCHEDULE_COUNT_MISMATCH");
});

test("duplicate event IDs fail closed so one event cannot masquerade as two calendar rows", () => {
  const duplicate = eventAt(180, { eventId: "same-event" });
  const result = evaluateQualityDaytradeBinaryEventRisk({
    asOfMs: AS_OF,
    binaryEventPolicy: policy,
    binaryEventEvidence: {
      ...noEventEvidence(),
      scheduled: true,
      scheduledEventCount: 2,
      events: [duplicate, { ...eventAt(240), eventId: "same-event" }],
    },
  });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "BINARY_EVENT_DUPLICATE_ID");
});

test("incomplete calendar coverage cannot prove a safe no-event state", () => {
  const result = evaluateQualityDaytradeBinaryEventRisk({ asOfMs: AS_OF, binaryEventEvidence: noEventEvidence({ coverageComplete: false }), binaryEventPolicy: policy });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "BINARY_EVENT_COVERAGE_COMPLETE_REQUIRED");
});

test("no-event evidence without a source fails closed", () => {
  const result = evaluateQualityDaytradeBinaryEventRisk({ asOfMs: AS_OF, binaryEventEvidence: noEventEvidence({ source: "" }), binaryEventPolicy: policy });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "BINARY_EVENT_SOURCE_REQUIRED");
});

test("expired calendar evidence fails closed instead of silently passing no-event state", () => {
  const result = evaluateQualityDaytradeBinaryEventRisk({ asOfMs: AS_OF, binaryEventEvidence: noEventEvidence({ validUntilMs: AS_OF - 1 }), binaryEventPolicy: policy });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "BINARY_EVENT_EVIDENCE_STALE");
});

test("calendar coverage must span the full caller-versioned pre-event blackout horizon", () => {
  const result = evaluateQualityDaytradeBinaryEventRisk({ asOfMs: AS_OF, binaryEventEvidence: noEventEvidence({ coverageEndMs: AS_OF + 119 * 60_000 }), binaryEventPolicy: policy });
  assert.equal(result.reason, "BINARY_EVENT_COVERAGE_INSUFFICIENT");
  assert.equal(result.requiredCoverageEndMs, AS_OF + 120 * 60_000);
});

test("calendar coverage must also span the full post-event cooldown lookback", () => {
  const result = evaluateQualityDaytradeBinaryEventRisk({ asOfMs: AS_OF, binaryEventEvidence: noEventEvidence({ coverageStartMs: AS_OF - 59 * 60_000 }), binaryEventPolicy: policy });
  assert.equal(result.reason, "BINARY_EVENT_LOOKBACK_INSUFFICIENT");
  assert.equal(result.requiredCoverageStartMs, AS_OF - 60 * 60_000);
});

test("invalid validity and coverage ranges fail closed", () => {
  const invalidValidity = evaluateQualityDaytradeBinaryEventRisk({ asOfMs: AS_OF, binaryEventEvidence: noEventEvidence({ checkedAtMs: AS_OF - 60_000, validUntilMs: AS_OF - 120_000 }), binaryEventPolicy: policy });
  assert.equal(invalidValidity.reason, "BINARY_EVENT_VALIDITY_RANGE_INVALID");

  const invalidCoverage = evaluateQualityDaytradeBinaryEventRisk({ asOfMs: AS_OF, binaryEventEvidence: noEventEvidence({ coverageStartMs: AS_OF + 60_000, coverageEndMs: AS_OF - 60_000 }), binaryEventPolicy: policy });
  assert.equal(invalidCoverage.reason, "BINARY_EVENT_COVERAGE_RANGE_INVALID");
});

test("scheduled binary event still requires verified source-backed evidence", () => {
  const unverified = evaluateQualityDaytradeBinaryEventRisk({ asOfMs: AS_OF, binaryEventEvidence: scheduledEventEvidence(90, { event: { verified: false } }), binaryEventPolicy: policy });
  assert.equal(unverified.reason, "BINARY_EVENT_VERIFICATION_REQUIRED");

  const unsupported = evaluateQualityDaytradeBinaryEventRisk({ asOfMs: AS_OF, binaryEventEvidence: scheduledEventEvidence(90, { event: { eventType: "RUMOR" } }), binaryEventPolicy: policy });
  assert.equal(unsupported.reason, "BINARY_EVENT_TYPE_UNSUPPORTED");
});

test("scheduled event and market-moving timestamps must be inside complete calendar coverage", () => {
  const eventOutside = evaluateQualityDaytradeBinaryEventRisk({ asOfMs: AS_OF, binaryEventEvidence: scheduledEventEvidence(180, { coverageEndMs: AS_OF + 150 * 60_000 }), binaryEventPolicy: policy });
  assert.equal(eventOutside.reason, "BINARY_EVENT_TIMESTAMP_OUTSIDE_COVERAGE");

  const marketMovingOutside = evaluateQualityDaytradeBinaryEventRisk({ asOfMs: AS_OF, binaryEventEvidence: scheduledEventEvidence(90, { event: { marketMovingTimestampMs: AS_OF + 25 * 60 * 60_000 } }), binaryEventPolicy: policy });
  assert.equal(marketMovingOutside.reason, "BINARY_EVENT_MARKET_MOVING_TIMESTAMP_OUTSIDE_COVERAGE");
});

test("entry inside pre-event blackout abstains", () => {
  const result = evaluateQualityDaytradeBinaryEventRisk({ asOfMs: AS_OF, binaryEventEvidence: scheduledEventEvidence(90), binaryEventPolicy: policy });
  assert.equal(result.status, "ABSTAIN");
  assert.equal(result.reason, "BINARY_EVENT_BLACKOUT");
  assert.equal(result.minutesUntilEvent, 90);
  assert.equal(result.blockingEvent.eventId, "event-90");
});

test("entry inside post-event cooldown abstains", () => {
  const result = evaluateQualityDaytradeBinaryEventRisk({ asOfMs: AS_OF, binaryEventEvidence: scheduledEventEvidence(-30), binaryEventPolicy: policy });
  assert.equal(result.status, "ABSTAIN");
  assert.equal(result.reason, "BINARY_EVENT_COOLDOWN");
  assert.equal(result.minutesSinceEvent, 30);
});

test("earnings blackout anchors to market-moving release, not a later conference call", () => {
  const result = evaluateQualityDaytradeBinaryEventRisk({
    asOfMs: AS_OF,
    binaryEventPolicy: { preEventBlackoutMinutes: 30, postEventCooldownMinutes: 60 },
    binaryEventEvidence: scheduledEventEvidence(120, {
      event: {
        eventTimestampMs: AS_OF + 120 * 60_000,
        marketMovingTimestampMs: AS_OF + 20 * 60_000,
      },
    }),
  });
  assert.equal(result.status, "ABSTAIN");
  assert.equal(result.reason, "BINARY_EVENT_BLACKOUT");
  assert.equal(result.minutesUntilEvent, 20);
  assert.equal(result.blockingEvent.timingBasis, "MARKET_MOVING_INFORMATION_RELEASE");
});

test("complete multi-event evidence blocks on the nearest risky event instead of inspecting only one row", () => {
  const result = evaluateQualityDaytradeBinaryEventRisk({
    asOfMs: AS_OF,
    binaryEventPolicy: policy,
    binaryEventEvidence: {
      ...noEventEvidence(),
      scheduled: true,
      scheduledEventCount: 2,
      events: [
        eventAt(300, { eventId: "earnings-later" }),
        eventAt(45, { eventId: "fda-near", eventType: "FDA_DECISION" }),
      ],
    },
  });
  assert.equal(result.status, "ABSTAIN");
  assert.equal(result.reason, "BINARY_EVENT_BLACKOUT");
  assert.equal(result.blockingEvent.eventId, "fda-near");
  assert.equal(result.minutesUntilEvent, 45);
});

test("outside blackout and cooldown window passes", () => {
  const before = evaluateQualityDaytradeBinaryEventRisk({ asOfMs: AS_OF, binaryEventEvidence: scheduledEventEvidence(180), binaryEventPolicy: policy });
  assert.equal(before.status, "PASS");
  assert.equal(before.reason, "OUTSIDE_BINARY_EVENT_WINDOW");

  const after = evaluateQualityDaytradeBinaryEventRisk({ asOfMs: AS_OF, binaryEventEvidence: scheduledEventEvidence(-90), binaryEventPolicy: policy });
  assert.equal(after.status, "PASS");
  assert.equal(after.reason, "OUTSIDE_BINARY_EVENT_WINDOW");
});

test("binary-event search grid exposes research candidates, not a hidden default", () => {
  const grid = buildQualityDaytradeBinaryEventWindowGrid();
  assert.equal(grid.combinations.length, 16);
  assert.ok(grid.combinations.some((row) => row.preEventBlackoutMinutes === 30 && row.postEventCooldownMinutes === 15));
  assert.ok(grid.combinations.some((row) => row.preEventBlackoutMinutes === 240 && row.postEventCooldownMinutes === 120));
  assert.match(grid.note, /research candidates/i);
  assert.match(grid.note, /coverage/i);
  assert.match(grid.note, /every scheduled event/i);
  assert.match(grid.note, /market-moving/i);
  assert.equal(grid.optimizationRule, "RESEARCH_ONLY_COARSE_TO_FINE_OOS_WALK_FORWARD_FINAL_HOLDOUT");
});
