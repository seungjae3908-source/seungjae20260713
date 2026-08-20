import { PredictionInputError } from "./contracts.js";

export const QUALITY_DAYTRADE_BINARY_EVENT_CONTRACT_VERSION = "us-quality-daytrade-binary-event-v1";

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

function normalizeEvidence(raw, asOfMs) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.calendarChecked !== true) {
    return Object.freeze({ status: "BLOCKED_DATA", reason: "BINARY_EVENT_EVIDENCE_REQUIRED" });
  }

  const checkedAtMs = finiteNumber(raw.checkedAtMs, "binaryEventEvidence.checkedAtMs");
  if (checkedAtMs > asOfMs) {
    return Object.freeze({ status: "BLOCKED_DATA", reason: "BINARY_EVENT_EVIDENCE_IN_FUTURE", checkedAtMs });
  }
  if (typeof raw.scheduled !== "boolean") {
    return Object.freeze({ status: "BLOCKED_DATA", reason: "BINARY_EVENT_SCHEDULE_STATE_REQUIRED", checkedAtMs });
  }
  if (raw.scheduled === false) {
    return Object.freeze({ status: "READY", scheduled: false, checkedAtMs });
  }

  if (raw.verified !== true) {
    return Object.freeze({ status: "BLOCKED_DATA", reason: "BINARY_EVENT_VERIFICATION_REQUIRED", checkedAtMs });
  }
  const eventType = String(raw.eventType ?? "").toUpperCase();
  if (!VALID_BINARY_EVENT_TYPES.has(eventType)) {
    return Object.freeze({ status: "BLOCKED_DATA", reason: "BINARY_EVENT_TYPE_UNSUPPORTED", checkedAtMs, eventType });
  }
  const eventTimestampMs = finiteNumber(raw.eventTimestampMs, "binaryEventEvidence.eventTimestampMs");
  const source = String(raw.source ?? "").trim();
  if (!source) {
    return Object.freeze({ status: "BLOCKED_DATA", reason: "BINARY_EVENT_SOURCE_REQUIRED", checkedAtMs, eventType, eventTimestampMs });
  }
  return Object.freeze({ status: "READY", scheduled: true, checkedAtMs, eventType, eventTimestampMs, source });
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
  const evidence = normalizeEvidence(raw.binaryEventEvidence, asOfMs);
  if (evidence.status !== "READY") return safeResult(evidence);
  if (!evidence.scheduled) {
    return safeResult({ status: "PASS", reason: "NO_SCHEDULED_BINARY_EVENT", evidence });
  }

  let policy;
  try {
    policy = normalizePolicy(raw.binaryEventPolicy);
  } catch (error) {
    if (error instanceof PredictionInputError && raw.binaryEventPolicy == null) {
      return safeResult({ status: "BLOCKED_DATA", reason: "BINARY_EVENT_POLICY_REQUIRED", evidence });
    }
    throw error;
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
    note: "Window values are research candidates, not validated defaults. Missing calendar evidence fails closed.",
  });
}
