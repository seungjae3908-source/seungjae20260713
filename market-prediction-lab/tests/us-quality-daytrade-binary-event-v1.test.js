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
    source: "issuer-calendar",
    validUntilMs: AS_OF + 15 * 60_000,
    coverageStartMs: AS_OF - 24 * 60 * 60_000,
    coverageEndMs: AS_OF + 24 * 60 * 60_000,
    ...overrides,
  };
}

function scheduledEventEvidence(minutesFromNow, overrides = {}) {
  return {
    calendarChecked: true,
    checkedAtMs: AS_OF - 60_000,
    scheduled: true,
    verified: true,
    eventType: "EARNINGS",
    eventTimestampMs: AS_OF + minutesFromNow * 60_000,
    source: "issuer-calendar",
    validUntilMs: AS_OF + 15 * 60_000,
    coverageStartMs: AS_OF - 24 * 60 * 60_000,
    coverageEndMs: AS_OF + 24 * 60 * 60_000,
    ...overrides,
  };
}

test("binary-event gate requires a caller-versioned policy before trusting calendar coverage", () => {
  const result = evaluateQualityDaytradeBinaryEventRisk({
    asOfMs: AS_OF,
    binaryEventEvidence: noEventEvidence(),
  });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "BINARY_EVENT_POLICY_REQUIRED");
  assert.equal(result.executionAuthority, "NONE");
  assert.equal(result.liveTradingAllowed, false);
  assert.equal(result.privateApiAllowed, false);
});

test("binary-event gate fails closed when calendar evidence is missing", () => {
  const result = evaluateQualityDaytradeBinaryEventRisk({
    asOfMs: AS_OF,
    binaryEventPolicy: policy,
  });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "BINARY_EVENT_EVIDENCE_REQUIRED");
});

test("missing event provenance fields return BLOCKED_DATA instead of throwing or passing", () => {
  const missingCheckedAt = evaluateQualityDaytradeBinaryEventRisk({
    asOfMs: AS_OF,
    binaryEventEvidence: noEventEvidence({ checkedAtMs: null }),
    binaryEventPolicy: policy,
  });
  assert.equal(missingCheckedAt.status, "BLOCKED_DATA");
  assert.equal(missingCheckedAt.reason, "BINARY_EVENT_CHECKED_AT_REQUIRED");

  const missingValidity = evaluateQualityDaytradeBinaryEventRisk({
    asOfMs: AS_OF,
    binaryEventEvidence: noEventEvidence({ validUntilMs: null }),
    binaryEventPolicy: policy,
  });
  assert.equal(missingValidity.status, "BLOCKED_DATA");
  assert.equal(missingValidity.reason, "BINARY_EVENT_VALID_UNTIL_REQUIRED");

  const missingCoverage = evaluateQualityDaytradeBinaryEventRisk({
    asOfMs: AS_OF,
    binaryEventEvidence: noEventEvidence({ coverageEndMs: null }),
    binaryEventPolicy: policy,
  });
  assert.equal(missingCoverage.status, "BLOCKED_DATA");
  assert.equal(missingCoverage.reason, "BINARY_EVENT_COVERAGE_REQUIRED");

  const missingEventTimestamp = evaluateQualityDaytradeBinaryEventRisk({
    asOfMs: AS_OF,
    binaryEventEvidence: scheduledEventEvidence(90, { eventTimestampMs: null }),
    binaryEventPolicy: policy,
  });
  assert.equal(missingEventTimestamp.status, "BLOCKED_DATA");
  assert.equal(missingEventTimestamp.reason, "BINARY_EVENT_TIMESTAMP_REQUIRED");
});

test("fresh source-backed no-event calendar evidence passes only with sufficient forward coverage", () => {
  const result = evaluateQualityDaytradeBinaryEventRisk({
    asOfMs: AS_OF,
    binaryEventEvidence: noEventEvidence(),
    binaryEventPolicy: policy,
  });
  assert.equal(result.status, "PASS");
  assert.equal(result.reason, "NO_SCHEDULED_BINARY_EVENT");
  assert.equal(result.evidence.source, "issuer-calendar");
  assert.ok(result.evidence.coverageEndMs >= result.evidence.requiredCoverageEndMs);
});

test("no-event evidence without a source fails closed", () => {
  const result = evaluateQualityDaytradeBinaryEventRisk({
    asOfMs: AS_OF,
    binaryEventEvidence: noEventEvidence({ source: "" }),
    binaryEventPolicy: policy,
  });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "BINARY_EVENT_SOURCE_REQUIRED");
});

test("expired calendar evidence fails closed instead of silently passing no-event state", () => {
  const result = evaluateQualityDaytradeBinaryEventRisk({
    asOfMs: AS_OF,
    binaryEventEvidence: noEventEvidence({ validUntilMs: AS_OF - 1 }),
    binaryEventPolicy: policy,
  });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "BINARY_EVENT_EVIDENCE_STALE");
});

test("calendar coverage must span the full caller-versioned pre-event blackout horizon", () => {
  const result = evaluateQualityDaytradeBinaryEventRisk({
    asOfMs: AS_OF,
    binaryEventEvidence: noEventEvidence({ coverageEndMs: AS_OF + 119 * 60_000 }),
    binaryEventPolicy: policy,
  });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "BINARY_EVENT_COVERAGE_INSUFFICIENT");
  assert.equal(result.requiredCoverageEndMs, AS_OF + 120 * 60_000);
});

test("invalid validity and coverage ranges fail closed", () => {
  const invalidValidity = evaluateQualityDaytradeBinaryEventRisk({
    asOfMs: AS_OF,
    binaryEventEvidence: noEventEvidence({
      checkedAtMs: AS_OF - 60_000,
      validUntilMs: AS_OF - 120_000,
    }),
    binaryEventPolicy: policy,
  });
  assert.equal(invalidValidity.status, "BLOCKED_DATA");
  assert.equal(invalidValidity.reason, "BINARY_EVENT_VALIDITY_RANGE_INVALID");

  const invalidCoverage = evaluateQualityDaytradeBinaryEventRisk({
    asOfMs: AS_OF,
    binaryEventEvidence: noEventEvidence({
      coverageStartMs: AS_OF + 60_000,
      coverageEndMs: AS_OF - 60_000,
    }),
    binaryEventPolicy: policy,
  });
  assert.equal(invalidCoverage.status, "BLOCKED_DATA");
  assert.equal(invalidCoverage.reason, "BINARY_EVENT_COVERAGE_RANGE_INVALID");
});

test("scheduled binary event still requires verified source-backed evidence", () => {
  const unverified = evaluateQualityDaytradeBinaryEventRisk({
    asOfMs: AS_OF,
    binaryEventEvidence: scheduledEventEvidence(90, { verified: false }),
    binaryEventPolicy: policy,
  });
  assert.equal(unverified.status, "BLOCKED_DATA");
  assert.equal(unverified.reason, "BINARY_EVENT_VERIFICATION_REQUIRED");

  const unsupported = evaluateQualityDaytradeBinaryEventRisk({
    asOfMs: AS_OF,
    binaryEventEvidence: scheduledEventEvidence(90, { eventType: "RUMOR" }),
    binaryEventPolicy: policy,
  });
  assert.equal(unsupported.status, "BLOCKED_DATA");
  assert.equal(unsupported.reason, "BINARY_EVENT_TYPE_UNSUPPORTED");
});

test("entry inside pre-event blackout abstains", () => {
  const result = evaluateQualityDaytradeBinaryEventRisk({
    asOfMs: AS_OF,
    binaryEventEvidence: scheduledEventEvidence(90),
    binaryEventPolicy: policy,
  });
  assert.equal(result.status, "ABSTAIN");
  assert.equal(result.reason, "BINARY_EVENT_BLACKOUT");
  assert.equal(result.minutesUntilEvent, 90);
});

test("entry inside post-event cooldown abstains", () => {
  const result = evaluateQualityDaytradeBinaryEventRisk({
    asOfMs: AS_OF,
    binaryEventEvidence: scheduledEventEvidence(-30),
    binaryEventPolicy: policy,
  });
  assert.equal(result.status, "ABSTAIN");
  assert.equal(result.reason, "BINARY_EVENT_COOLDOWN");
  assert.equal(result.minutesSinceEvent, 30);
});

test("outside blackout and cooldown window passes", () => {
  const before = evaluateQualityDaytradeBinaryEventRisk({
    asOfMs: AS_OF,
    binaryEventEvidence: scheduledEventEvidence(180),
    binaryEventPolicy: policy,
  });
  assert.equal(before.status, "PASS");
  assert.equal(before.reason, "OUTSIDE_BINARY_EVENT_WINDOW");

  const after = evaluateQualityDaytradeBinaryEventRisk({
    asOfMs: AS_OF,
    binaryEventEvidence: scheduledEventEvidence(-90),
    binaryEventPolicy: policy,
  });
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
  assert.equal(grid.optimizationRule, "RESEARCH_ONLY_COARSE_TO_FINE_OOS_WALK_FORWARD_FINAL_HOLDOUT");
});
