import { PredictionInputError } from "./contracts.js";

export const QUALITY_DAYTRADE_TIER_B_RISK_PROVENANCE_CONTRACT_VERSION = "us-quality-daytrade-tier-b-risk-provenance-v1";

const RISK_FIELDS = Object.freeze([
  ["recentReverseSplit", "RECENT_REVERSE_SPLIT"],
  ["listingRisk", "LISTING_RISK"],
  ["manipulationRisk", "MANIPULATION_RISK"],
  ["dilutionRisk", "DILUTION_RISK"],
  ["recentOffering", "RECENT_OFFERING"],
  ["goingConcernRisk", "GOING_CONCERN_RISK"],
]);

function safeResult(fields) {
  return Object.freeze({
    contractVersion: QUALITY_DAYTRADE_TIER_B_RISK_PROVENANCE_CONTRACT_VERSION,
    executionAuthority: "NONE",
    liveTradingAllowed: false,
    privateApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    ...fields,
  });
}

function positiveEvidenceNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizedSourceId(value) {
  const sourceId = String(value ?? "").trim();
  return sourceId || null;
}

export function evaluateUsQualityDaytradeTierBRiskProvenance(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PredictionInputError("Tier B risk provenance input must be an object");
  }

  const asOfMs = positiveEvidenceNumber(raw.asOfMs);
  if (asOfMs == null) return safeResult({ status: "BLOCKED_DATA", reason: "TIER_B_RISK_ASOF_REQUIRED" });

  const instrument = raw.instrument;
  if (!instrument || typeof instrument !== "object" || Array.isArray(instrument)) {
    return safeResult({ status: "BLOCKED_DATA", reason: "TIER_B_RISK_INSTRUMENT_REQUIRED" });
  }

  const evidence = raw.riskEvidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return safeResult({ status: "BLOCKED_DATA", reason: "TIER_B_RISK_EVIDENCE_REQUIRED" });
  }
  if (evidence.pointInTime !== true) {
    return safeResult({ status: "BLOCKED_DATA", reason: "TIER_B_RISK_POINT_IN_TIME_UNPROVEN" });
  }
  if (evidence.publicReadOnly !== true || evidence.privateApiUsed === true) {
    return safeResult({ status: "BLOCKED_DATA", reason: "TIER_B_RISK_PUBLIC_READ_ONLY_REQUIRED" });
  }
  if (evidence.coverageComplete !== true) {
    return safeResult({ status: "BLOCKED_DATA", reason: "TIER_B_RISK_COVERAGE_INCOMPLETE" });
  }

  const checkedAtMs = positiveEvidenceNumber(evidence.checkedAtMs);
  if (checkedAtMs == null) return safeResult({ status: "BLOCKED_DATA", reason: "TIER_B_RISK_CHECKED_AT_REQUIRED" });
  if (checkedAtMs > asOfMs) return safeResult({ status: "BLOCKED_DATA", reason: "TIER_B_RISK_EVIDENCE_FROM_FUTURE" });

  const windowStartMs = positiveEvidenceNumber(evidence.windowStartMs);
  const windowEndMs = positiveEvidenceNumber(evidence.windowEndMs);
  if (windowStartMs == null || windowEndMs == null) {
    return safeResult({ status: "BLOCKED_DATA", reason: "TIER_B_RISK_WINDOW_REQUIRED" });
  }
  if (windowEndMs < windowStartMs || windowEndMs > asOfMs || checkedAtMs < windowEndMs) {
    return safeResult({ status: "BLOCKED_DATA", reason: "TIER_B_RISK_WINDOW_INVALID" });
  }

  const validUntilMs = positiveEvidenceNumber(evidence.validUntilMs);
  if (validUntilMs == null) return safeResult({ status: "BLOCKED_DATA", reason: "TIER_B_RISK_VALID_UNTIL_REQUIRED" });
  if (validUntilMs < asOfMs) return safeResult({ status: "BLOCKED_DATA", reason: "TIER_B_RISK_EVIDENCE_STALE" });

  const riskFlags = evidence.riskFlags;
  const sourceIds = evidence.sourceIds;
  if (!riskFlags || typeof riskFlags !== "object" || Array.isArray(riskFlags)) {
    return safeResult({ status: "BLOCKED_DATA", reason: "TIER_B_RISK_FLAGS_REQUIRED" });
  }
  if (!sourceIds || typeof sourceIds !== "object" || Array.isArray(sourceIds)) {
    return safeResult({ status: "BLOCKED_DATA", reason: "TIER_B_RISK_SOURCES_REQUIRED" });
  }

  const verifiedFlags = {};
  const verifiedSourceIds = {};
  for (const [field, reasonName] of RISK_FIELDS) {
    if (typeof instrument[field] !== "boolean") {
      return safeResult({ status: "BLOCKED_DATA", reason: `TIER_B_INSTRUMENT_${reasonName}_FLAG_REQUIRED` });
    }
    if (typeof riskFlags[field] !== "boolean") {
      return safeResult({ status: "BLOCKED_DATA", reason: `TIER_B_${reasonName}_EVIDENCE_REQUIRED` });
    }
    const sourceId = normalizedSourceId(sourceIds[field]);
    if (!sourceId) {
      return safeResult({ status: "BLOCKED_DATA", reason: `TIER_B_${reasonName}_SOURCE_REQUIRED` });
    }
    if (riskFlags[field] !== instrument[field]) {
      return safeResult({ status: "BLOCKED_DATA", reason: `TIER_B_${reasonName}_FLAG_MISMATCH` });
    }
    verifiedFlags[field] = riskFlags[field];
    verifiedSourceIds[field] = sourceId;
    if (riskFlags[field] === true) {
      return safeResult({
        status: "ABSTAIN",
        reason: `TIER_B_${reasonName}`,
        checkedAtMs,
        windowStartMs,
        windowEndMs,
        validUntilMs,
        riskFlags: Object.freeze({ ...verifiedFlags }),
        sourceIds: Object.freeze({ ...verifiedSourceIds }),
      });
    }
  }

  return safeResult({
    status: "PASS",
    reason: "TIER_B_POINT_IN_TIME_RISK_SCREEN_VERIFIED",
    checkedAtMs,
    windowStartMs,
    windowEndMs,
    validUntilMs,
    riskFlags: Object.freeze({ ...verifiedFlags }),
    sourceIds: Object.freeze({ ...verifiedSourceIds }),
  });
}
