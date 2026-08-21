import { PredictionInputError } from "./contracts.js";
import { evaluateUsQualityDaytradeSetup } from "./us-quality-daytrade-research-v1.js";
import { evaluateQualityDaytradeBinaryEventRisk } from "./us-quality-daytrade-binary-event-v1.js";
import { evaluateQualityDaytradeUniverseProvenance } from "./us-quality-daytrade-universe-provenance-v1.js";
import { evaluateUsQualityDaytradeTierBRiskProvenance } from "./us-quality-daytrade-tier-b-risk-provenance-v1.js";
import { evaluateUsQualityDaytradeLiquidityEvidence } from "./us-quality-daytrade-liquidity-evidence-v1.js";
import { evaluateUsQualityDaytradeVolatility } from "./us-quality-daytrade-volatility-v1.js";
import { evaluateUsQualityDaytradeMarketContext } from "./us-quality-daytrade-market-context-v1.js";

export const QUALITY_DAYTRADE_PREENTRY_CONTRACT_VERSION = "us-quality-daytrade-preentry-v6";

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

function normalizedSymbol(value) {
  return String(value ?? "").trim().toUpperCase();
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
      tierBRiskProvenance: null,
      liquidity: null,
      volatility: null,
      marketContext: null,
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
      tierBRiskProvenance: null,
      liquidity: null,
      volatility: null,
      marketContext: null,
      binaryEventRisk: null,
      qualityTier: technicalSetup.qualityTier ?? technicalSetup.universe?.tier ?? null,
      riskBudgetMultiplier: technicalSetup.riskBudgetMultiplier ?? technicalSetup.universe?.riskBudgetMultiplier ?? 0,
    });
  }

  let tierBRiskProvenance = null;
  if (technicalSetup.qualityTier === "B") {
    tierBRiskProvenance = evaluateUsQualityDaytradeTierBRiskProvenance({
      asOfMs: raw.asOfMs,
      instrument: raw.instrument,
      riskEvidence: raw.tierBRiskEvidence,
    });
    if (tierBRiskProvenance.status !== "PASS") {
      return safeResult({
        status: tierBRiskProvenance.status === "ABSTAIN" ? "ABSTAIN" : "BLOCKED_DATA",
        reason: tierBRiskProvenance.reason,
        universeProvenance,
        technicalSetup,
        tierBRiskProvenance,
        liquidity: null,
        volatility: null,
        marketContext: null,
        binaryEventRisk: null,
        qualityTier: technicalSetup.qualityTier,
        riskBudgetMultiplier: technicalSetup.riskBudgetMultiplier,
      });
    }
  }

  const instrumentSymbol = normalizedSymbol(raw.instrument?.symbol);
  const liquiditySymbol = normalizedSymbol(raw.liquidityEvidence?.symbol);
  if (!liquiditySymbol) {
    return safeResult({
      status: "BLOCKED_DATA",
      reason: "LIQUIDITY_SYMBOL_REQUIRED",
      universeProvenance,
      technicalSetup,
      tierBRiskProvenance,
      liquidity: null,
      volatility: null,
      marketContext: null,
      binaryEventRisk: null,
      qualityTier: technicalSetup.qualityTier,
      riskBudgetMultiplier: technicalSetup.riskBudgetMultiplier,
    });
  }
  if (liquiditySymbol !== instrumentSymbol) {
    return safeResult({
      status: "BLOCKED_DATA",
      reason: "LIQUIDITY_SYMBOL_MISMATCH",
      universeProvenance,
      technicalSetup,
      tierBRiskProvenance,
      liquidity: null,
      volatility: null,
      marketContext: null,
      binaryEventRisk: null,
      qualityTier: technicalSetup.qualityTier,
      riskBudgetMultiplier: technicalSetup.riskBudgetMultiplier,
    });
  }

  const liquidity = evaluateUsQualityDaytradeLiquidityEvidence({
    asOfMs: raw.asOfMs,
    candleEvidence: raw.liquidityEvidence?.candleEvidence,
    relativeVolumeEvidence: raw.liquidityEvidence?.relativeVolumeEvidence,
    liquidityPolicy: raw.liquidityEvidence?.liquidityPolicy,
  });
  if (liquidity.status !== "PASS") {
    return safeResult({
      status: "BLOCKED_DATA",
      reason: liquidity.reason,
      universeProvenance,
      technicalSetup,
      tierBRiskProvenance,
      liquidity,
      volatility: null,
      marketContext: null,
      binaryEventRisk: null,
      qualityTier: technicalSetup.qualityTier,
      riskBudgetMultiplier: technicalSetup.riskBudgetMultiplier,
    });
  }
  if (liquidity.session !== technicalSetup.session) {
    return safeResult({
      status: "BLOCKED_DATA",
      reason: "LIQUIDITY_TECHNICAL_SESSION_MISMATCH",
      universeProvenance,
      technicalSetup,
      tierBRiskProvenance,
      liquidity,
      volatility: null,
      marketContext: null,
      binaryEventRisk: null,
      qualityTier: technicalSetup.qualityTier,
      riskBudgetMultiplier: technicalSetup.riskBudgetMultiplier,
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
      tierBRiskProvenance,
      liquidity,
      volatility,
      marketContext: null,
      binaryEventRisk: null,
      qualityTier: technicalSetup.qualityTier,
      riskBudgetMultiplier: technicalSetup.riskBudgetMultiplier,
    });
  }

  const marketContext = evaluateUsQualityDaytradeMarketContext({
    asOfMs: raw.asOfMs,
    session: technicalSetup.session,
    marketContextEvidence: raw.marketContextEvidence,
  });
  if (marketContext.status !== "PASS") {
    return safeResult({
      status: "BLOCKED_DATA",
      reason: marketContext.reason,
      universeProvenance,
      technicalSetup,
      tierBRiskProvenance,
      liquidity,
      volatility,
      marketContext,
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
      tierBRiskProvenance,
      liquidity,
      volatility,
      marketContext,
      binaryEventRisk,
      qualityTier: technicalSetup.qualityTier,
      riskBudgetMultiplier: technicalSetup.riskBudgetMultiplier,
    });
  }

  return safeResult({
    status: "CANDIDATE",
    reason: "VWAP_FIRST_PULLBACK_REBREAK_LIQUID_EVENT_SAFE",
    universeProvenance,
    technicalSetup,
    tierBRiskProvenance,
    liquidity,
    volatility,
    marketContext,
    binaryEventRisk,
    qualityTier: technicalSetup.qualityTier,
    riskBudgetMultiplier: technicalSetup.riskBudgetMultiplier,
    hardRiskCeilingPct: technicalSetup.hardRiskCeilingPct,
  });
}
