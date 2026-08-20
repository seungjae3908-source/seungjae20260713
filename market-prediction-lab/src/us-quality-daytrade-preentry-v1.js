import { PredictionInputError } from "./contracts.js";
import { evaluateUsQualityDaytradeSetup } from "./us-quality-daytrade-research-v1.js";
import { evaluateQualityDaytradeBinaryEventRisk } from "./us-quality-daytrade-binary-event-v1.js";

export const QUALITY_DAYTRADE_PREENTRY_CONTRACT_VERSION = "us-quality-daytrade-preentry-v1";

function safeResult(fields) {
  return Object.freeze({
    contractVersion: QUALITY_DAYTRADE_PREENTRY_CONTRACT_VERSION,
    executionAuthority: "NONE",
    liveTradingAllowed: false,
    privateApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    ...fields,
  });
}

export function evaluateUsQualityDaytradePreEntry(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PredictionInputError("quality day-trade pre-entry input must be an object");
  }

  const technicalSetup = evaluateUsQualityDaytradeSetup(raw);
  if (technicalSetup.status !== "CANDIDATE") {
    return safeResult({
      status: technicalSetup.status,
      reason: technicalSetup.reason,
      technicalSetup,
      binaryEventRisk: null,
      qualityTier: technicalSetup.qualityTier ?? technicalSetup.universe?.tier ?? null,
      riskBudgetMultiplier: technicalSetup.riskBudgetMultiplier ?? technicalSetup.universe?.riskBudgetMultiplier ?? 0,
    });
  }

  const binaryEventRisk = evaluateQualityDaytradeBinaryEventRisk({
    asOfMs: raw.asOfMs,
    binaryEventPolicy: raw.binaryEventPolicy,
    binaryEventEvidence: raw.binaryEventEvidence,
  });

  if (binaryEventRisk.status !== "PASS") {
    return safeResult({
      status: binaryEventRisk.status === "BLOCKED_DATA" ? "BLOCKED_DATA" : "ABSTAIN",
      reason: binaryEventRisk.reason,
      technicalSetup,
      binaryEventRisk,
      qualityTier: technicalSetup.qualityTier,
      riskBudgetMultiplier: technicalSetup.riskBudgetMultiplier,
    });
  }

  return safeResult({
    status: "CANDIDATE",
    reason: "VWAP_FIRST_PULLBACK_REBREAK_EVENT_SAFE",
    technicalSetup,
    binaryEventRisk,
    qualityTier: technicalSetup.qualityTier,
    riskBudgetMultiplier: technicalSetup.riskBudgetMultiplier,
    hardRiskCeilingPct: technicalSetup.hardRiskCeilingPct,
  });
}
