import { PredictionInputError } from "./contracts.js";

export const QUALITY_DAYTRADE_BINARY_EVENT_CONTRACT_VERSION = "us-quality-daytrade-binary-event-v5";

const VALID_BINARY_EVENT_TYPES = new Set([
  "EARNINGS",
  "FDA_DECISION",
  "FDA_ADCOM",
  "MATERIAL_CORPORATE_EVENT",
]);

function finiteNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new PredictionInputError(`${name} must be finite`);
  return number;
}

function normalizePolicy(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PredictionInputError("binaryEventPolicy must be an object");
  }
  const preEventBlackoutMinutes = finiteNumber(raw.preEventBlackoutMinutes, "binaryEventPolicy.preEventBlackoutMinutes");
  const postEventCooldownMinutes = finiteNumber(raw.postEventCooldownMinutes, "binaryEventPolicy.postEventCooldownMinutes");
  if (!Number.isInteger(preEventBlackoutMinutes) || preEventBlackoutMinutes < 0 || preEventBlackoutMinutes > 1_440) {
    throw new PredictionInputError("invalid binaryEventPolicy.preEventBlackoutMinutes");
  }
  if (!Number.isInteger(postEventCooldownMinutes) || postEventCooldownMinutes < 0 || postEventCooldownMinutes > 1_440) {
    throw new PredictionInputError("invalid binaryEventPolicy.postEventCooldownMinutes");
  }
  return Object.freeze({ preEventBlackoutMinutes, postEventCooldownMinutes });
}

function blocked(reason, fields = {}) {
  return Object.freeze({ status: "BLOCKED_DATA", reason, ...fields });
}

function normalizeEvent(raw, index, coverage) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return blocked("BINARY_EVENT_ITEM_INVALID", { eventIndex: index });
  }
  const eventId = String(raw.eventId ?? "").trim();
  if (!eventId) return blocked("BINARY_EVENT_ID_REQUIRED", { eventIndex: index });
  if (raw.verified !== true) return blocked("BINARY_EVENT_VERIFICATION_REQUIRED", { eventIndex: index, eventId });

  const eventType = String(raw.eventType ?? "").toUpperCase();
  if (!VALID_BINARY_EVENT_TYPES.has(eventType)) {
    return blocked("BINARY_EVENT_TYPE_UNSUPPORTED", { eventIndex: index, eventId, eventType });
  }
  if (raw.eventTimestampMs == null) {
    return blocked("BINARY_EVENT_TIMESTAMP_REQUIRED", { eventIndex: index, eventId, eventType });
  }
  const eventTimestampMs = finiteNumber(raw.eventTimestampMs, `binaryEventEvidence.events[${index}].eventTimestampMs`);
  if (eventTimestampMs < coverage.coverageStartMs || eventTimestampMs > coverage.coverageEndMs) {
    return blocked("BINARY_EVENT_TIMESTAMP_OUTSIDE_COVERAGE", {
      eventIndex: index,
      eventId,
      eventType,
      eventTimestampMs,
      coverageStartMs: coverage.coverageStartMs,
      coverageEndMs: coverage.coverageEndMs,
    });
  }

  if (raw.marketMovingTimestampMs == null) {
    return blocked("BINARY_EVENT_MARKET_MOVING_TIMESTAMP_REQUIRED", {
      eventIndex: index,
      eventId,
      eventType,
      eventTimestampMs,
    });
  }
  const marketMovingTimestampMs = finiteNumber(
    raw.marketMovingTimestampMs,
    `binaryEventEvidence.events[${index}].marketMovingTimestampMs`,
  );
  if (marketMovingTimestampMs < coverage.coverageStartMs || marketMovingTimestampMs > coverage.coverageEndMs) {
    return blocked("BINARY_EVENT_MARKET_MOVING_TIMESTAMP_OUTSIDE_COVERAGE", {
      eventIndex: index,
      eventId,
      eventType,
      eventTimestampMs,
      marketMovingTimestampMs,
      coverageStartMs: coverage.coverageStartMs,
      coverageEndMs: coverage.coverageEndMs,
    });
  }

  return Object.freeze({
    status: "READY",
    eventId,
    eventType,
    eventTimestampMs,
    marketMovingTimestampMs,
    timingBasis: "MARKET_MOVING_INFORMATION_RELEASE",
  });
}

function normalizeEvidence(raw, asOfMs, policy) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.calendarChecked !== true) {
    return blocked("BINARY_EVENT_EVIDENCE_REQUIRED");
  }

  if (raw.checkedAtMs == null) return blocked("BINARY_EVENT_CHECKED_AT_REQUIRED");
  const checkedAtMs = finiteNumber(raw.checkedAtMs, "binaryEventEvidence.checkedAtMs");
  if (checkedAtMs > asOfMs) return blocked("BINARY_EVENT_EVIDENCE_IN_FUTURE", { checkedAtMs });

  const source = String(raw.source ?? "").trim();
  if (!source) return blocked("BINARY_EVENT_SOURCE_REQUIRED", { checkedAtMs });

  if (raw.validUntilMs == null) return blocked("BINARY_EVENT_VALID_UNTIL_REQUIRED", { checkedAtMs, source });
  const validUntilMs = finiteNumber(raw.validUntilMs, "binaryEventEvidence.validUntilMs");
  if (validUntilMs < checkedAtMs) return blocked("BINARY_EVENT_VALIDITY_RANGE_INVALID", { checkedAtMs, validUntilMs, source });
  if (validUntilMs < asOfMs) return blocked("BINARY_EVENT_EVIDENCE_STALE", { checkedAtMs, validUntilMs, source });

  if (raw.coverageStartMs == null || raw.coverageEndMs == null) {
    return blocked("BINARY_EVENT_COVERAGE_REQUIRED", { checkedAtMs, validUntilMs, source });
  }
  const coverageStartMs = finiteNumber(raw.coverageStartMs, "binaryEventEvidence.coverageStartMs");
  const coverageEndMs = finiteNumber(raw.coverageEndMs, "binaryEventEvidence.coverageEndMs");
  if (coverageEndMs < coverageStartMs) {
    return blocked("BINARY_EVENT_COVERAGE_RANGE_INVALID", { checkedAtMs, source, coverageStartMs, coverageEndMs });
  }
  if (raw.coverageComplete !== true) {
    return blocked("BINARY_EVENT_COVERAGE_COMPLETE_REQUIRED", { checkedAtMs, source, coverageStartMs, coverageEndMs });
  }

  const requiredCoverageStartMs = asOfMs - policy.postEventCooldownMinutes * 60_000;
  const requiredCoverageEndMs = asOfMs + policy.preEventBlackoutMinutes * 60_000;
  if (coverageStartMs > requiredCoverageStartMs) {
    return blocked("BINARY_EVENT_LOOKBACK_INSUFFICIENT", {
      checkedAtMs,
      source,
      coverageStartMs,
      coverageEndMs,
      requiredCoverageStartMs,
      requiredCoverageEndMs,
    });
  }
  if (coverageEndMs < requiredCoverageEndMs) {
    return blocked("BINARY_EVENT_COVERAGE_INSUFFICIENT", {
      checkedAtMs,
      source,
      coverageStartMs,
      coverageEndMs,
      requiredCoverageStartMs,
      requiredCoverageEndMs,
    });
  }

  if (typeof raw.scheduled !== "boolean") {
    return blocked("BINARY_EVENT_SCHEDULE_STATE_REQUIRED", { checkedAtMs, source });
  }
  if (raw.scheduledEventCount == null) {
    return blocked("BINARY_EVENT_COUNT_REQUIRED", { checkedAtMs, source });
  }
  const scheduledEventCount = finiteNumber(raw.scheduledEventCount, "binaryEventEvidence.scheduledEventCount");
  if (!Number.isInteger(scheduledEventCount) || scheduledEventCount < 0 || scheduledEventCount > 100) {
    return blocked("BINARY_EVENT_COUNT_INVALID", { checkedAtMs, source, scheduledEventCount });
  }
  if (!Array.isArray(raw.events)) {
    return blocked("BINARY_EVENT_LIST_REQUIRED", { checkedAtMs, source, scheduledEventCount });
  }
  if (raw.events.length !== scheduledEventCount) {
    return blocked("BINARY_EVENT_COUNT_MISMATCH", {
      checkedAtMs,
      source,
      scheduledEventCount,
      observedEventCount: raw.events.length,
    });
  }
  if (raw.scheduled === false && scheduledEventCount !== 0) {
    return blocked("BINARY_EVENT_SCHEDULE_COUNT_MISMATCH", { checkedAtMs, source, scheduledEventCount });
  }
  if (raw.scheduled === true && scheduledEventCount === 0) {
    return blocked("BINARY_EVENT_SCHEDULE_COUNT_MISMATCH", { checkedAtMs, source, scheduledEventCount });
  }

  const common = {
    checkedAtMs,
    source,
    validUntilMs,
    coverageComplete: true,
    coverageStartMs,
    coverageEndMs,
    requiredCoverageStartMs,
    requiredCoverageEndMs,
    scheduledEventCount,
  };

  if (raw.scheduled === false) {
    return Object.freeze({ status: "READY", scheduled: false, events: Object.freeze([]), ...common });
  }

  const normalizedEvents = [];
  const seenIds = new Set();
  for (let index = 0; index < raw.events.length; index += 1) {
    const event = normalizeEvent(raw.events[index], index, { coverageStartMs, coverageEndMs });
    if (event.status !== "READY") return event;
    if (seenIds.has(event.eventId)) {
      return blocked("BINARY_EVENT_DUPLICATE_ID", { checkedAtMs, source, eventId: event.eventId, eventIndex: index });
    }
    seenIds.add(event.eventId);
    normalizedEvents.push(event);
  }

  return Object.freeze({
    status: "READY",
    scheduled: true,
    events: Object.freeze(normalizedEvents),
    ...common,
  });
}

function safeResult(fields) {
  return Object.freeze({
    contractVersion: QUALITY_DAYTRADE_BINARY_EVENT_CONTRACT_VERSION,
    executionAuthority: "NONE",
    liveTradingAllowed: false,
    privateApiAllowed: false,
    ...fields,
  });
}

export function evaluateQualityDaytradeBinaryEventRisk(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PredictionInputError("binary event risk input must be an object");
  }
  const asOfMs = finiteNumber(raw.asOfMs, "asOfMs");

  let policy;
  try {
    policy = normalizePolicy(raw.binaryEventPolicy);
  } catch (error) {
    if (error instanceof PredictionInputError && raw.binaryEventPolicy == null) {
      return safeResult({ status: "BLOCKED_DATA", reason: "BINARY_EVENT_POLICY_REQUIRED" });
    }
    throw error;
  }

  const evidence = normalizeEvidence(raw.binaryEventEvidence, asOfMs, policy);
  if (evidence.status !== "READY") return safeResult({ ...evidence, policy });
  if (!evidence.scheduled) {
    return safeResult({ status: "PASS", reason: "NO_SCHEDULED_BINARY_EVENT", evidence, policy });
  }

  const evaluated = evidence.events.map((event) => {
    const minutesUntilEvent = (event.marketMovingTimestampMs - asOfMs) / 60_000;
    return Object.freeze({
      event,
      minutesUntilEvent,
      minutesSinceEvent: -minutesUntilEvent,
      distanceMinutes: Math.abs(minutesUntilEvent),
    });
  });

  const blackout = evaluated
    .filter((row) => row.minutesUntilEvent >= 0 && row.minutesUntilEvent <= policy.preEventBlackoutMinutes)
    .sort((a, b) => a.minutesUntilEvent - b.minutesUntilEvent)[0];
  if (blackout) {
    return safeResult({
      status: "ABSTAIN",
      reason: "BINARY_EVENT_BLACKOUT",
      evidence,
      policy,
      blockingEvent: blackout.event,
      minutesUntilEvent: blackout.minutesUntilEvent,
    });
  }

  const cooldown = evaluated
    .filter((row) => row.minutesUntilEvent < 0 && row.minutesSinceEvent < policy.postEventCooldownMinutes)
    .sort((a, b) => a.minutesSinceEvent - b.minutesSinceEvent)[0];
  if (cooldown) {
    return safeResult({
      status: "ABSTAIN",
      reason: "BINARY_EVENT_COOLDOWN",
      evidence,
      policy,
      blockingEvent: cooldown.event,
      minutesSinceEvent: cooldown.minutesSinceEvent,
    });
  }

  const nearestEvent = [...evaluated].sort((a, b) => a.distanceMinutes - b.distanceMinutes)[0] ?? null;
  return safeResult({
    status: "PASS",
    reason: "OUTSIDE_BINARY_EVENT_WINDOW",
    evidence,
    policy,
    nearestEvent: nearestEvent?.event ?? null,
    minutesUntilEvent: nearestEvent?.minutesUntilEvent ?? null,
  });
}

export function buildQualityDaytradeBinaryEventWindowGrid() {
  const preEventBlackoutMinutes = [30, 60, 120, 240];
  const postEventCooldownMinutes = [15, 30, 60, 120];
  const combinations = [];
  for (const preMinutes of preEventBlackoutMinutes) {
    for (const postMinutes of postEventCooldownMinutes) {
      combinations.push(Object.freeze({
        preEventBlackoutMinutes: preMinutes,
        postEventCooldownMinutes: postMinutes,
      }));
    }
  }
  return Object.freeze({
    contractVersion: QUALITY_DAYTRADE_BINARY_EVENT_CONTRACT_VERSION,
    combinations: Object.freeze(combinations),
    optimizationRule: "RESEARCH_ONLY_COARSE_TO_FINE_OOS_WALK_FORWARD_FINAL_HOLDOUT",
    selectionMetric: "NET_EXPECTANCY_WITH_PF_MDD_GAP_SLIPPAGE_STRESS",
    note: "Window values are research candidates, not validated defaults. Complete source-backed calendar coverage must enumerate every scheduled event in the covered interval with an exact attested count and unique event IDs; risk timing uses each event's earliest market-moving information-release timestamp rather than a later descriptive conference-call time.",
  });
}
