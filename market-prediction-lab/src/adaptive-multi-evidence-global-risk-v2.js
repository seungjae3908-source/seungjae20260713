import { sha256Canonical } from "./research-cache-provenance.js";
import { ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID } from "./adaptive-multi-evidence-point-in-time-v2.js";
import { ADAPTIVE_MULTI_EVIDENCE_COST_LIQUIDITY_V2_VERSION } from "./adaptive-multi-evidence-cost-liquidity-v2.js";
import {
  ADAPTIVE_MULTI_EVIDENCE_STRATEGY_PORTFOLIO_V2_VERSION,
  verifyAdaptiveMultiEvidenceStrategyPortfolioV2,
} from "./adaptive-multi-evidence-strategy-portfolio-v2.js";

export const ADAPTIVE_MULTI_EVIDENCE_GLOBAL_RISK_V2_VERSION =
  "adaptive-multi-evidence-global-risk-v2";

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function timestamp(value) {
  const parsed = typeof value === "number" ? value : Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function safety() {
  return {
    vetoAuthority: true,
    strategyCanOverrideVeto: false,
    aiCanOverrideVeto: false,
    riskCheckCanPlaceOrder: false,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: "NONE",
  };
}

function result({ status, decision, reasons, checks, capacity, riskBudget, derivatives }) {
  const core = { status, decision, reasons: unique(reasons), checks, capacity, riskBudget, derivatives };
  return deepFreeze({
    schemaVersion: ADAPTIVE_MULTI_EVIDENCE_GLOBAL_RISK_V2_VERSION,
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    ...core,
    riskEvidenceId: `adaptive-v2-global-risk:${sha256Canonical(core)}`,
    globalRiskGate: status === "GLOBAL_RISK_PASS"
      ? { state: "PASS", evidenceId: `adaptive-v2-global-risk:${sha256Canonical(core)}`, reason: null }
      : { state: status === "BLOCKED_DATA" ? "UNKNOWN" : "FAIL", evidenceId: null,
        reason: unique(reasons).join("|") },
    economicSampleCredit: 0,
    profitabilityProven: false,
    decisionAuthority: "GLOBAL_RISK_VETO_ONLY",
    ...safety(),
  });
}

function blocked(reasons) {
  return result({
    status: "BLOCKED_DATA",
    decision: "BLOCKED",
    reasons,
    checks: [],
    capacity: null,
    riskBudget: null,
    derivatives: { status: "UNKNOWN", directionalAuthority: false },
  });
}

function policy(raw) {
  const ratios = [
    "maximumPerTradeRiskPct", "maximumDailyLossPct", "maximumMarketExposurePct",
    "maximumAssetClassExposurePct", "maximumSectorExposurePct", "maximumDirectionalExposurePct",
    "maximumCorrelation", "maximumAccountLeverage", "minimumMarginHeadroomPct",
    "minimumLiquidationDistancePct", "maximumSpreadBps", "maximumSlippageBps",
  ];
  const normalized = Object.fromEntries(ratios.map((key) => [key, finite(raw?.[key])]));
  normalized.maximumConsecutiveLosses = raw?.maximumConsecutiveLosses;
  normalized.maximumOpenPositions = raw?.maximumOpenPositions;
  normalized.maximumSnapshotAgeMs = raw?.maximumSnapshotAgeMs;
  if (ratios.some((key) => normalized[key] == null || normalized[key] < 0)
      || !Number.isSafeInteger(normalized.maximumConsecutiveLosses) || normalized.maximumConsecutiveLosses < 0
      || !Number.isSafeInteger(normalized.maximumOpenPositions) || normalized.maximumOpenPositions <= 0
      || !Number.isSafeInteger(normalized.maximumSnapshotAgeMs) || normalized.maximumSnapshotAgeMs <= 0) {
    throw new Error("V2_GLOBAL_RISK_POLICY_INVALID");
  }
  return normalized;
}

function check(name, state, value, limit, reason = null) {
  return { name, state, value, limit, reason: state === "PASS" ? null : reason };
}

function snapshot(raw, decisionTime, maximumAgeMs) {
  const observedAt = timestamp(raw?.observedAt);
  const at = timestamp(decisionTime);
  const validProvenance = text(raw?.sourceId) && /^[0-9a-f]{64}$/iu.test(text(raw?.sourceDigest) ?? "")
    && raw?.paperAccount === true && raw?.privateApiUsed === false;
  if (!observedAt || !at || observedAt > at || at - observedAt > maximumAgeMs || !validProvenance) return null;
  const numeric = [
    "equity", "dailyNetPnl", "consecutiveLosses", "openPositions", "marketExposure",
    "assetClassExposure", "directionalExposure", "accountLeverage", "marginHeadroomPct",
  ];
  if (numeric.some((key) => finite(raw?.[key]) == null)) return null;
  if (raw.sectorApplicable === true && finite(raw.sectorExposure) == null) return null;
  return { ...raw, observedAt: new Date(observedAt).toISOString() };
}

function derivativesEvidence(raw, context, maximumAgeMs) {
  if (context.market !== "CRYPTO_FUTURES") {
    return { status: "NOT_APPLICABLE", fundingBps: null, basisBps: null, openInterest: null,
      positionTier: null, liquidationDistancePct: null, directionalAuthority: false };
  }
  const at = timestamp(context.decisionTime);
  const observedAt = timestamp(raw?.observedAt);
  const valid = observedAt && at && observedAt <= at && at - observedAt <= maximumAgeMs
    && raw?.market === context.market && raw?.symbol === context.symbol
    && finite(raw?.fundingBps) != null && finite(raw?.basisBps) != null
    && finite(raw?.openInterest) != null && raw.openInterest >= 0
    && text(raw?.positionTier) && finite(raw?.liquidationDistancePct) != null
    && text(raw?.sourceId) && /^[0-9a-f]{64}$/iu.test(text(raw?.sourceDigest) ?? "")
    && raw?.publicMarketData === true && raw?.privateApiUsed === false;
  return valid
    ? { status: "AVAILABLE", fundingBps: raw.fundingBps, basisBps: raw.basisBps,
      openInterest: raw.openInterest, positionTier: raw.positionTier,
      liquidationDistancePct: raw.liquidationDistancePct, observedAt: new Date(observedAt).toISOString(),
      sourceId: raw.sourceId, sourceDigest: raw.sourceDigest, directionalAuthority: false }
    : { status: "UNKNOWN", fundingBps: null, basisBps: null, openInterest: null,
      positionTier: null, liquidationDistancePct: null, directionalAuthority: false };
}

export function buildAdaptiveMultiEvidenceGlobalRiskV2(input = {}) {
  const blockers = [];
  if (input.portfolio?.schemaVersion !== ADAPTIVE_MULTI_EVIDENCE_STRATEGY_PORTFOLIO_V2_VERSION
      || !verifyAdaptiveMultiEvidenceStrategyPortfolioV2(input.portfolio)) blockers.push("V2_GLOBAL_RISK_PORTFOLIO_INVALID");
  if (input.costLiquidity?.schemaVersion !== ADAPTIVE_MULTI_EVIDENCE_COST_LIQUIDITY_V2_VERSION
      || input.costLiquidity?.lineageId !== ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID
      || input.costLiquidity?.executionAuthority !== "NONE") blockers.push("V2_GLOBAL_RISK_COST_LIQUIDITY_INVALID");
  if (input.executionAuthority != null && input.executionAuthority !== "NONE") blockers.push("V2_GLOBAL_RISK_EXECUTION_AUTHORITY_FORBIDDEN");
  let limits;
  try { limits = policy(input.policy); } catch (error) { blockers.push(error.message); }
  if (blockers.length > 0) return blocked(blockers);

  const market = text(input.market)?.toUpperCase();
  const symbol = text(input.symbol)?.toUpperCase();
  const decisionTime = text(input.decisionTime);
  const account = snapshot(input.accountSnapshot, decisionTime, limits.maximumSnapshotAgeMs);
  if (!market || !symbol || !timestamp(decisionTime) || !account || !(account.equity > 0)) {
    return blocked(["V2_GLOBAL_RISK_ACCOUNT_OR_IDENTITY_EVIDENCE_INVALID"]);
  }
  if (input.costLiquidity.cost?.market !== market || input.costLiquidity.cost?.symbol !== symbol
      || input.costLiquidity.cost?.decisionTime !== decisionTime) {
    return blocked(["V2_GLOBAL_RISK_COST_IDENTITY_MISMATCH"]);
  }
  const requestedRiskBudget = finite(input.requestedRiskBudget);
  if (!(requestedRiskBudget > 0)) return blocked(["V2_GLOBAL_RISK_REQUESTED_RISK_BUDGET_INVALID"]);
  const riskPct = requestedRiskBudget / account.equity;
  const dailyLossPct = Math.max(0, -account.dailyNetPnl) / account.equity;
  const marketExposurePct = account.marketExposure / account.equity;
  const assetClassExposurePct = account.assetClassExposure / account.equity;
  const sectorExposurePct = account.sectorApplicable ? account.sectorExposure / account.equity : null;
  const directionalExposurePct = account.directionalExposure / account.equity;
  const maxPairCorrelation = Math.max(0, ...input.portfolio.portfolio.pairwise.map((item) => item.returnCorrelation));
  const spreadBps = input.costLiquidity.liquidity?.spreadBps;
  const slippageBps = input.costLiquidity.cost?.components?.slippageBps?.conservativeBps;
  const derivatives = derivativesEvidence(input.derivativesEvidence, { market, symbol, decisionTime }, limits.maximumSnapshotAgeMs);
  const checks = [
    check("PER_TRADE_RISK", riskPct <= limits.maximumPerTradeRiskPct ? "PASS" : "FAIL", riskPct,
      limits.maximumPerTradeRiskPct, "PER_TRADE_RISK_LIMIT_EXCEEDED"),
    check("DAILY_LOSS", dailyLossPct <= limits.maximumDailyLossPct ? "PASS" : "FAIL", dailyLossPct,
      limits.maximumDailyLossPct, "DAILY_LOSS_LIMIT_EXCEEDED"),
    check("CONSECUTIVE_LOSSES", account.consecutiveLosses < limits.maximumConsecutiveLosses ? "PASS" : "FAIL",
      account.consecutiveLosses, limits.maximumConsecutiveLosses, "CONSECUTIVE_LOSS_LIMIT_REACHED"),
    check("MAX_POSITIONS", account.openPositions < limits.maximumOpenPositions ? "PASS" : "FAIL",
      account.openPositions, limits.maximumOpenPositions, "MAX_POSITIONS_REACHED"),
    check("MARKET_EXPOSURE", marketExposurePct <= limits.maximumMarketExposurePct ? "PASS" : "FAIL",
      marketExposurePct, limits.maximumMarketExposurePct, "MARKET_EXPOSURE_LIMIT_EXCEEDED"),
    check("ASSET_CLASS_EXPOSURE", assetClassExposurePct <= limits.maximumAssetClassExposurePct ? "PASS" : "FAIL",
      assetClassExposurePct, limits.maximumAssetClassExposurePct, "ASSET_CLASS_EXPOSURE_LIMIT_EXCEEDED"),
    check("SECTOR_EXPOSURE", account.sectorApplicable === true
      ? (sectorExposurePct <= limits.maximumSectorExposurePct ? "PASS" : "FAIL") : "PASS",
      sectorExposurePct, limits.maximumSectorExposurePct, "SECTOR_EXPOSURE_LIMIT_EXCEEDED"),
    check("DIRECTIONAL_CONCENTRATION", directionalExposurePct <= limits.maximumDirectionalExposurePct ? "PASS" : "FAIL",
      directionalExposurePct, limits.maximumDirectionalExposurePct, "DIRECTIONAL_CONCENTRATION_LIMIT_EXCEEDED"),
    check("CORRELATION_CONCENTRATION", maxPairCorrelation <= limits.maximumCorrelation ? "PASS" : "FAIL",
      maxPairCorrelation, limits.maximumCorrelation, "CORRELATION_CONCENTRATION_LIMIT_EXCEEDED"),
    check("LEVERAGE", account.accountLeverage <= limits.maximumAccountLeverage ? "PASS" : "FAIL",
      account.accountLeverage, limits.maximumAccountLeverage, "LEVERAGE_LIMIT_EXCEEDED"),
    check("MARGIN", account.marginHeadroomPct >= limits.minimumMarginHeadroomPct ? "PASS" : "FAIL",
      account.marginHeadroomPct, limits.minimumMarginHeadroomPct, "MARGIN_HEADROOM_INSUFFICIENT"),
    check("LIQUIDATION_DISTANCE", market !== "CRYPTO_FUTURES"
      ? "PASS" : derivatives.status === "AVAILABLE" && derivatives.liquidationDistancePct >= limits.minimumLiquidationDistancePct ? "PASS" : "FAIL",
      derivatives.liquidationDistancePct, limits.minimumLiquidationDistancePct, "LIQUIDATION_DISTANCE_INSUFFICIENT_OR_UNKNOWN"),
    check("SPREAD", finite(spreadBps) != null && spreadBps <= limits.maximumSpreadBps ? "PASS" : "FAIL",
      spreadBps ?? null, limits.maximumSpreadBps, "SPREAD_LIMIT_EXCEEDED_OR_UNKNOWN"),
    check("SLIPPAGE", finite(slippageBps) != null && slippageBps <= limits.maximumSlippageBps ? "PASS" : "FAIL",
      slippageBps ?? null, limits.maximumSlippageBps, "SLIPPAGE_LIMIT_EXCEEDED_OR_UNKNOWN"),
    check("PROVIDER_HEALTH", input.providerHealth?.status === "HEALTHY"
      && input.providerHealth?.publicOnly === true && input.providerHealth?.privateApiUsed === false ? "PASS" : "FAIL",
      input.providerHealth?.status ?? null, "HEALTHY", "PROVIDER_OUTAGE_OR_PRIVATE_ACCESS"),
    check("STRATEGY_HEALTH", input.strategyHealth?.status === "HEALTHY"
      && text(input.strategyHealth?.evidenceId) ? "PASS" : "FAIL",
      input.strategyHealth?.status ?? null, "HEALTHY", "STRATEGY_HEALTH_NOT_PROVEN"),
    check("POSITION_ACCOUNT_MATCH", input.positionAccountReconciliation?.matches === true
      && text(input.positionAccountReconciliation?.evidenceId) ? "PASS" : "FAIL",
      input.positionAccountReconciliation?.matches ?? null, true, "POSITION_ACCOUNT_MISMATCH"),
    check("DERIVATIVES_EVIDENCE", market !== "CRYPTO_FUTURES" || derivatives.status === "AVAILABLE" ? "PASS" : "FAIL",
      derivatives.status, market === "CRYPTO_FUTURES" ? "AVAILABLE" : "NOT_APPLICABLE", "DERIVATIVES_EVIDENCE_UNKNOWN"),
  ];
  if (input.costLiquidity.status !== "COST_LIQUIDITY_GATE_PASS") {
    checks.push(check("COST_LIQUIDITY_UPSTREAM", "FAIL", input.costLiquidity.status,
      "COST_LIQUIDITY_GATE_PASS", "UPSTREAM_COST_LIQUIDITY_VETO"));
  }
  const failures = checks.filter((item) => item.state !== "PASS");
  const maximumRiskAmount = account.equity * limits.maximumPerTradeRiskPct;
  const capacity = {
    remainingPositionSlots: Math.max(0, limits.maximumOpenPositions - account.openPositions),
    remainingMarketExposure: Math.max(0, account.equity * limits.maximumMarketExposurePct - account.marketExposure),
    remainingAssetClassExposure: Math.max(0, account.equity * limits.maximumAssetClassExposurePct - account.assetClassExposure),
    remainingSectorExposure: account.sectorApplicable
      ? Math.max(0, account.equity * limits.maximumSectorExposurePct - account.sectorExposure) : null,
    remainingDirectionalExposure: Math.max(0, account.equity * limits.maximumDirectionalExposurePct - account.directionalExposure),
  };
  return result({
    status: failures.length === 0 ? "GLOBAL_RISK_PASS" : "NO_TRADE",
    decision: failures.length === 0 ? input.costLiquidity.decision : "NO_TRADE",
    reasons: failures.length === 0 ? ["ALL_GLOBAL_RISK_CHECKS_PASS"] : failures.map((item) => item.reason),
    checks,
    capacity,
    riskBudget: {
      requested: requestedRiskBudget,
      maximum: maximumRiskAmount,
      approved: failures.length === 0 ? requestedRiskBudget : 0,
      quantityDerived: false,
    },
    derivatives,
  });
}
