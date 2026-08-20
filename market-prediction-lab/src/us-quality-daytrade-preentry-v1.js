import { PredictionInputError } from "./contracts.js";
import { evaluateUsQualityDaytradeSetup } from "./us-quality-daytrade-research-v1.js";
import { evaluateQualityDaytradeBinaryEventRisk } from "./us-quality-daytrade-binary-event-v1.js";
import { evaluateQualityDaytradeUniverseProvenance } from "./us-quality-daytrade-universe-provenance-v1.js";
import { evaluateUsQualityDaytradeVolatility } from "./us-quality-daytrade-volatility-v1.js";

export const QUALITY_DAYTRADE_PREENTRY_CONTRACT_VERSION = "us-quality-daytrade-preentry-v3";

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

  const universeProvenance = evaluateQualityDaytradeUniverseProvenance({
    asOfMs: raw.asOfMs,
    instrument: raw.instrument,
    universeEvidence: raw.universeEvidence,
  });
  if (universeProvenance.status !== "PASS") {
    return safeResult({
      status: "BLOCKED_DATA",
      reason: universeProvenance.reason,
      universeProvenance,
      technicalSetup: null,
      volatility: null,
      binaryEventRisk: null,
      qualityTier: null,
      riskBudgetMultiplier: 0,
    });
  }

  const technicalSetup = evaluateUsQualityDaytradeSetup(raw);
  if (technicalSetup.status !== "CANDIDATE") {
    return safeResult({
      status: technicalSetup.status,
      reason: technicalSetup.reason,
      universeProvenance,
      technicalSetup,
      volatility: null,
      binaryEventRisk: null,
      qualityTier: technicalSetup.qualityTier ?? technicalSetup.universe?.tier ?? null,
      riskBudgetMultiplier: technicalSetup.riskBudgetMultiplier ?? technicalSetup.universe?.riskBudgetMultiplier ?? 0,
    });
  }

  const volatility = evaluateUsQualityDaytradeVolatility({
    asOfMs: raw.asOfMs,
    candles: raw.candles,
    candleEvidence: raw.candleEvidence,
    volatilityPolicy: raw.volatilityPolicy,
  });
  if (volatility.status !== "PASS") {
    return safeResult({
      status: "BLOCKED_DATA",
      reason: volatility.reason,
      universeProvenance,
      technicalSetup,
      volatility,
      binaryEventRisk: null,
      qualityTier: technicalSetup.qualityTier,
      riskBudgetMultiplier: technicalSetup.riskBudgetMultiplier,
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
      universeProvenance,
      technicalSetup,
      volatility,
      binaryEventRisk,
      qualityTier: technicalSetup.qualityTier,
      riskBudgetMultiplier: technicalSetup.riskBudgetMultiplier,
    });
  }

  return safeResult({
    status: "CANDIDATE",
    reason: "VWAP_FIRST_PULLBACK_REBREAK_EVENT_SAFE",
    universeProvenance,
    technicalSetup,
    volatility,
    binaryEventRisk,
    qualityTier: technicalSetup.qualityTier,
    riskBudgetMultiplier: technicalSetup.riskBudgetMultiplier,
    hardRiskCeilingPct: technicalSetup.hardRiskCeilingPct,
  });
}
