import test from "node:test";
import assert from "node:assert/strict";
import {
  buildQualityDaytradeBinaryEventWindowGrid,
  evaluateQualityDaytradeBinaryEventRisk,
} from "../src/us-quality-daytrade-binary-event-v1.js";

const AS_OF = Date.UTC(2026, 7, 20, 13, 0, 0);

function noEventEvidence(overrides = {}) {
  return {
    calendarChecked: true,
    checkedAtMs: AS_OF - 60_000,
    scheduled: false,
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
    ...overrides,
  };
}

const policy = Object.freeze({ preEventBlackoutMinutes: 120, postEventCooldownMinutes: 60 });

test("binary-event gate fails closed when calendar evidence is missing", () => {
  const result = evaluateQualityDaytradeBinaryEventRisk({ asOfMs: AS_OF });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "BINARY_EVENT_EVIDENCE_REQUIRED");
  assert.equal(result.executionAuthority, "NONE");
  assert.equal(result.liveTradingAllowed, false);
  assert.equal(result.privateApiAllowed, false);
});

test("verified no-event calendar evidence passes without inventing a policy", () => {
  const result = evaluateQualityDaytradeBinaryEventRisk({
    asOfMs: AS_OF,
    binaryEventEvidence: noEventEvidence(),
  });
  assert.equal(result.status, "PASS");
  assert.equal(result.reason, "NO_SCHEDULED_BINARY_EVENT");
});

test("scheduled binary event requires a caller-versioned policy", () => {
  const result = evaluateQualityDaytradeBinaryEventRisk({
    asOfMs: AS_OF,
    binaryEventEvidence: scheduledEventEvidence(90),
  });
  assert.equal(result.status, "BLOCKED_DATA");
  assert.equal(result.reason, "BINARY_EVENT_POLICY_REQUIRED");
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

test("unverified or unsupported scheduled event evidence fails closed", () => {
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

test("binary-event search grid exposes research candidates, not a hidden default", () => {
  const grid = buildQualityDaytradeBinaryEventWindowGrid();
  assert.equal(grid.combinations.length, 16);
  assert.ok(grid.combinations.some((row) => row.preEventBlackoutMinutes === 30 && row.postEventCooldownMinutes === 15));
  assert.ok(grid.combinations.some((row) => row.preEventBlackoutMinutes === 240 && row.postEventCooldownMinutes === 120));
  assert.match(grid.note, /research candidates/i);
  assert.match(grid.note, /fails closed/i);
  assert.equal(grid.optimizationRule, "RESEARCH_ONLY_COARSE_TO_FINE_OOS_WALK_FORWARD_FINAL_HOLDOUT");
});
