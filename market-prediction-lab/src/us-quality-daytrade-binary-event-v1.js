import { PredictionInputError } from "./contracts.js";

export const QUALITY_DAYTRADE_BINARY_EVENT_CONTRACT_VERSION = "us-quality-daytrade-binary-event-v3";

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

function normalizeEvidence(raw, asOfMs, policy) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.calendarChecked !== true) {
    return Object.freeze({ status: "BLOCKED_DATA", reason: "BINARY_EVENT_EVIDENCE_REQUIRED" });
  }

  if (raw.checkedAtMs == null) {
    return Object.freeze({ status: "BLOCKED_DATA", reason: "BINARY_EVENT_CHECKED_AT_REQUIRED" });
  }
  const checkedAtMs = finiteNumber(raw.checkedAtMs, "binaryEventEvidence.checkedAtMs");
  if (checkedAtMs > asOfMs) {
    return Object.freeze({ status: "BLOCKED_DATA", reason: "BINARY_EVENT_EVIDENCE_IN_FUTURE", checkedAtMs });
  }

  const source = String(raw.source ?? "").trim();
  if (!source) {
    return Object.freeze({ status: "BLOCKED_DATA", reason: "BINARY_EVENT_SOURCE_REQUIRED", checkedAtMs });
  }

  if (raw.validUntilMs == null) {
    return Object.freeze({ status: "BLOCKED_DATA", reason: "BINARY_EVENT_VALID_UNTIL_REQUIRED", checkedAtMs, source });
  }
  const validUntilMs = finiteNumber(raw.validUntilMs, "binaryEventEvidence.validUntilMs");
  if (validUntilMs < checkedAtMs) {
    return Object.freeze({ status: "BLOCKED_DATA", reason: "BINARY_EVENT_VALIDITY_RANGE_INVALID", checkedAtMs, validUntilMs, source });
  }
  if (validUntilMs < asOfMs) {
    return Object.freeze({ status: "BLOCKED_DATA", reason: "BINARY_EVENT_EVIDENCE_STALE", checkedAtMs, validUntilMs, source });
  }

  if (raw.coverageStartMs == null || raw.coverageEndMs == null) {
    return Object.freeze({ status: "BLOCKED_DATA", reason: "BINARY_EVENT_COVERAGE_REQUIRED", checkedAtMs, validUntilMs, source });
  }
  const coverageStartMs = finiteNumber(raw.coverageStartMs, "binaryEventEvidence.coverageStartMs");
  const coverageEndMs = finiteNumber(raw.coverageEndMs, "binaryEventEvidence.coverageEndMs");
  if (coverageEndMs < coverageStartMs) {
    return Object.freeze({ status: "BLOCKED_DATA", reason: "BINARY_EVENT_COVERAGE_RANGE_INVALID", checkedAtMs, source, coverageStartMs, coverageEndMs });
  }
  if (raw.coverageComplete !== true) {
    return Object.freeze({ status: "BLOCKED_DATA", reason: "BINARY_EVENT_COVERAGE_COMPLETE_REQUIRED", checkedAtMs, source, coverageStartMs, coverageEndMs });
  }

  const requiredCoverageStartMs = asOfMs - policy.postEventCooldownMinutes * 60_000;
  const requiredCoverageEndMs = asOfMs + policy.preEventBlackoutMinutes * 60_000;
  if (coverageStartMs > requiredCoverageStartMs) {
    return Object.freeze({
      status: "BLOCKED_DATA",
      reason: "BINARY_EVENT_LOOKBACK_INSUFFICIENT",
      checkedAtMs,
      source,
      coverageStartMs,
      coverageEndMs,
      requiredCoverageStartMs,
      requiredCoverageEndMs,
    });
  }
  if (coverageEndMs < requiredCoverageEndMs) {
    return Object.freeze({
      status: "BLOCKED_DATA",
      reason: "BINARY_EVENT_COVERAGE_INSUFFICIENT",
      checkedAtMs,
      source,
      coverageStartMs,
      coverageEndMs,
      requiredCoverageStartMs,
      requiredCoverageEndMs,
    });
  }

  if (typeof raw.scheduled !== "boolean") {
    return Object.freeze({ status: "BLOCKED_DATA", reason: "BINARY_EVENT_SCHEDULE_STATE_REQUIRED", checkedAtMs, source });
  }
  if (raw.scheduled === false) {
    return Object.freeze({
      status: "READY",
      scheduled: false,
      checkedAtMs,
      source,
      validUntilMs,
      coverageComplete: true,
      coverageStartMs,
      coverageEndMs,
      requiredCoverageStartMs,
      requiredCoverageEndMs,
    });
  }

  if (raw.verified !== true) {
    return Object.freeze({ status: "BLOCKED_DATA", reason: "BINARY_EVENT_VERIFICATION_REQUIRED", checkedAtMs, source });
  }
  const eventType = String(raw.eventType ?? "").toUpperCase();
  if (!VALID_BINARY_EVENT_TYPES.has(eventType)) {
    return Object.freeze({ status: "BLOCKED_DATA", reason: "BINARY_EVENT_TYPE_UNSUPPORTED", checkedAtMs, source, eventType });
  }
  if (raw.eventTimestampMs == null) {
    return Object.freeze({ status: "BLOCKED_DATA", reason: "BINARY_EVENT_TIMESTAMP_REQUIRED", checkedAtMs, source, eventType });
  }
  const eventTimestampMs = finiteNumber(raw.eventTimestampMs, "binaryEventEvidence.eventTimestampMs");
  if (eventTimestampMs < coverageStartMs || eventTimestampMs > coverageEndMs) {
    return Object.freeze({
      status: "BLOCKED_DATA",
      reason: "BINARY_EVENT_TIMESTAMP_OUTSIDE_COVERAGE",
      checkedAtMs,
      source,
      eventType,
      eventTimestampMs,
      coverageStartMs,
      coverageEndMs,
    });
  }
  return Object.freeze({
    status: "READY",
    scheduled: true,
    checkedAtMs,
    eventType,
    eventTimestampMs,
    source,
    validUntilMs,
    coverageComplete: true,
    coverageStartMs,
    coverageEndMs,
    requiredCoverageStartMs,
    requiredCoverageEndMs,
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

  const minutesUntilEvent = (evidence.eventTimestampMs - asOfMs) / 60_000;
  if (minutesUntilEvent >= 0 && minutesUntilEvent <= policy.preEventBlackoutMinutes) {
    return safeResult({
      status: "ABSTAIN",
      reason: "BINARY_EVENT_BLACKOUT",
      evidence,
      policy,
      minutesUntilEvent,
    });
  }

  const minutesSinceEvent = -minutesUntilEvent;
  if (minutesUntilEvent < 0 && minutesSinceEvent < policy.postEventCooldownMinutes) {
    return safeResult({
      status: "ABSTAIN",
      reason: "BINARY_EVENT_COOLDOWN",
      evidence,
      policy,
      minutesSinceEvent,
    });
  }

  return safeResult({
    status: "PASS",
    reason: "OUTSIDE_BINARY_EVENT_WINDOW",
    evidence,
    policy,
    minutesUntilEvent,
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
    note: "Window values are research candidates, not validated defaults. Complete source-backed calendar coverage must span the full post-event cooldown lookback and pre-event blackout horizon.",
  });
}
