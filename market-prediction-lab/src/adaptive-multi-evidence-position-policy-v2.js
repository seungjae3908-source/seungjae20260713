import { sha256Canonical } from "./research-cache-provenance.js";
import { ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID } from "./adaptive-multi-evidence-point-in-time-v2.js";
import { ADAPTIVE_MULTI_EVIDENCE_COST_LIQUIDITY_V2_VERSION } from "./adaptive-multi-evidence-cost-liquidity-v2.js";
import { ADAPTIVE_MULTI_EVIDENCE_GLOBAL_RISK_V2_VERSION } from "./adaptive-multi-evidence-global-risk-v2.js";
import {
  ADAPTIVE_MULTI_EVIDENCE_STRATEGY_PORTFOLIO_V2_VERSION,
  verifyAdaptiveMultiEvidenceStrategyPortfolioV2,
} from "./adaptive-multi-evidence-strategy-portfolio-v2.js";

export const ADAPTIVE_MULTI_EVIDENCE_POSITION_POLICY_V2_VERSION =
  "adaptive-multi-evidence-position-policy-v2";

export const ADAPTIVE_V2_SCALE_IN_TRIGGERS = Object.freeze([
  "BREAKOUT_CONFIRMATION",
  "SUCCESSFUL_RETEST",
  "PULLBACK_CONTINUATION",
  "HIGHER_TIMEFRAME_CONFIRMATION",
]);

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

function positive(value) {
  const number = finite(value);
  return number != null && number > 0 ? number : null;
}

function floorToLot(quantity, lotSize) {
  const units = Math.floor((quantity + Number.EPSILON) / lotSize);
  return Number((units * lotSize).toPrecision(15));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function safety() {
  return {
    researchAndPaperSimulationOnly: true,
    mayPlaceOrder: false,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: "NONE",
  };
}

function result({ status, decision, reasons, identity, sizing, scaleIn, exits, executionSimulation, audit }) {
  const core = {
    status,
    decision,
    reasons: unique(reasons),
    identity,
    sizing,
    scaleIn,
    exits,
    executionSimulation,
    audit,
  };
  return deepFreeze({
    schemaVersion: ADAPTIVE_MULTI_EVIDENCE_POSITION_POLICY_V2_VERSION,
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    ...core,
    positionPolicyEvidenceId: `adaptive-v2-position-policy:${sha256Canonical(core)}`,
    economicSampleCredit: 0,
    profitabilityProven: false,
    frozenV1Contamination: 0,
    decisionAuthority: "POSITION_POLICY_RESEARCH_GATE_ONLY",
    ...safety(),
  });
}

function blocked(reasons) {
  return result({
    status: "BLOCKED_DATA",
    decision: "BLOCKED",
    reasons,
    identity: null,
    sizing: null,
    scaleIn: null,
    exits: null,
    executionSimulation: "NO_TRADE",
    audit: null,
  });
}

function noTrade(reasons, context = {}) {
  return result({
    status: "NO_TRADE",
    decision: "NO_TRADE",
    reasons,
    identity: context.identity ?? null,
    sizing: context.sizing ?? null,
    scaleIn: context.scaleIn ?? null,
    exits: context.exits ?? null,
    executionSimulation: "NO_TRADE",
    audit: context.audit ?? null,
  });
}

function normalizePolicy(raw, direction, entryPrice) {
  const stopPrice = positive(raw?.hardStopPrice);
  const invalidationPrice = positive(raw?.logicalInvalidationPrice);
  const tp1 = positive(raw?.takeProfit1Price);
  const tp2 = positive(raw?.takeProfit2Price);
  const trailingActivation = positive(raw?.trailingActivationPrice);
  const trailingDistance = positive(raw?.trailingDistance);
  const lotSize = positive(raw?.lotSize);
  const maximumPositionNotional = positive(raw?.maximumPositionNotional);
  const tp1Fraction = finite(raw?.takeProfit1Fraction);
  const tp2Fraction = finite(raw?.takeProfit2Fraction);
  const timeStopBars = raw?.timeStopBars;
  const evidenceId = text(raw?.validatedPolicyEvidenceId);
  const policyId = text(raw?.policyId);
  const validNumbers = stopPrice && invalidationPrice && tp1 && tp2 && trailingActivation
    && trailingDistance && lotSize && maximumPositionNotional
    && tp1Fraction > 0 && tp2Fraction > 0 && tp1Fraction + tp2Fraction <= 1
    && Number.isSafeInteger(timeStopBars) && timeStopBars > 0;
  const directionValid = direction === "LONG"
    ? stopPrice < entryPrice && invalidationPrice === stopPrice
      && entryPrice < tp1 && tp1 < tp2 && entryPrice < trailingActivation
    : stopPrice > entryPrice && invalidationPrice === stopPrice
      && entryPrice > tp1 && tp1 > tp2 && entryPrice > trailingActivation;
  if (!validNumbers || !directionValid || !evidenceId || !policyId
      || raw?.strategyInvalidationExitEnabled !== true || raw?.eventRiskExitEnabled !== true
      || raw?.universalFixedPercentExit === true) return null;
  return {
    policyId,
    validatedPolicyEvidenceId: evidenceId,
    logicalInvalidationPrice: invalidationPrice,
    hardStopPrice: stopPrice,
    takeProfit1Price: tp1,
    takeProfit2Price: tp2,
    takeProfit1Fraction: tp1Fraction,
    takeProfit2Fraction: tp2Fraction,
    trailingActivationPrice: trailingActivation,
    trailingDistance,
    timeStopBars,
    strategyInvalidationExitEnabled: true,
    eventRiskExitEnabled: true,
    lotSize,
    maximumPositionNotional,
    universalFixedPercentExit: false,
  };
}

function normalizeScaleIn(raw, context) {
  if (raw == null) return { requested: false, status: "NOT_REQUESTED", addedQuantity: 0, reasons: [] };
  const reasons = [];
  const trigger = text(raw.trigger)?.toUpperCase();
  const position = raw.currentPaperPosition;
  if (!ADAPTIVE_V2_SCALE_IN_TRIGGERS.includes(trigger)) reasons.push("SCALE_IN_TRIGGER_NOT_VALIDATED");
  if (!text(raw.confirmationEvidenceId)) reasons.push("SCALE_IN_CONFIRMATION_EVIDENCE_REQUIRED");
  if (position?.paperPosition !== true || position?.market !== context.market
      || position?.symbol !== context.symbol || position?.strategyIdentity !== context.strategyIdentity
      || position?.direction !== context.direction) reasons.push("SCALE_IN_POSITION_IDENTITY_INVALID");
  if (positive(position?.originalRiskBudget) !== context.approvedRiskBudget
      || positive(position?.originalHardStopPrice) !== context.stopPrice) {
    reasons.push("SCALE_IN_ORIGINAL_RISK_OR_STOP_MISMATCH");
  }
  if (finite(position?.unrealizedPnl) == null || position.unrealizedPnl < 0) {
    reasons.push(context.market === "CRYPTO_FUTURES"
      ? "CRYPTO_FUTURES_LOSS_AVERAGING_FORBIDDEN" : "LOSS_RECOVERY_AVERAGING_FORBIDDEN");
  }
  const currentQuantity = positive(position?.quantity);
  const remainingRiskBudget = positive(raw.remainingRiskBudget);
  if (!currentQuantity || !remainingRiskBudget || remainingRiskBudget > context.approvedRiskBudget) {
    reasons.push("SCALE_IN_REMAINING_RISK_INVALID");
  }
  return {
    requested: true,
    status: reasons.length === 0 ? "ELIGIBLE" : "REJECTED",
    trigger,
    confirmationEvidenceId: text(raw.confirmationEvidenceId),
    currentQuantity: currentQuantity ?? null,
    remainingRiskBudget: remainingRiskBudget ?? null,
    reasons,
  };
}

function executionSimulation(participation, raw) {
  const marketMaximum = finite(raw?.marketSimMaximumParticipation);
  const limitMaximum = finite(raw?.limitSimMaximumParticipation);
  const splitMaximum = finite(raw?.splitSimMaximumParticipation);
  if (!(marketMaximum > 0) || !(limitMaximum >= marketMaximum)
      || !(splitMaximum >= limitMaximum) || splitMaximum > 1) return null;
  if (participation <= marketMaximum) return "MARKET_SIM";
  if (participation <= limitMaximum) return "LIMIT_SIM";
  if (participation <= splitMaximum) return "SPLIT_SIM";
  return "NO_TRADE";
}

export function buildAdaptiveMultiEvidencePositionPolicyV2(input = {}) {
  const blockers = [];
  if (input.portfolio?.schemaVersion !== ADAPTIVE_MULTI_EVIDENCE_STRATEGY_PORTFOLIO_V2_VERSION
      || !verifyAdaptiveMultiEvidenceStrategyPortfolioV2(input.portfolio)
      || input.portfolio?.frozenV1Contamination !== 0
      || input.portfolio?.executionAuthority !== "NONE") blockers.push("V2_POSITION_PORTFOLIO_INVALID");
  if (input.globalRisk?.schemaVersion !== ADAPTIVE_MULTI_EVIDENCE_GLOBAL_RISK_V2_VERSION
      || input.globalRisk?.lineageId !== ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID
      || input.globalRisk?.executionAuthority !== "NONE"
      || !text(input.globalRisk?.riskEvidenceId)) blockers.push("V2_POSITION_GLOBAL_RISK_INVALID");
  if (input.costLiquidity?.schemaVersion !== ADAPTIVE_MULTI_EVIDENCE_COST_LIQUIDITY_V2_VERSION
      || input.costLiquidity?.lineageId !== ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID
      || input.costLiquidity?.executionAuthority !== "NONE") blockers.push("V2_POSITION_COST_LIQUIDITY_INVALID");
  if (input.executionAuthority != null && input.executionAuthority !== "NONE") {
    blockers.push("V2_POSITION_EXECUTION_AUTHORITY_FORBIDDEN");
  }
  if (blockers.length > 0) return blocked(blockers);

  const market = text(input.market)?.toUpperCase();
  const symbol = text(input.symbol)?.toUpperCase();
  const strategyIdentity = text(input.strategyIdentity);
  const direction = ["BUY", "LONG"].includes(input.globalRisk.decision) ? "LONG"
    : ["SELL", "SHORT"].includes(input.globalRisk.decision) ? "SHORT" : null;
  const entryPrice = positive(input.entryPrice);
  const member = input.portfolio.portfolio.members.find((item) => item.candidateId === strategyIdentity);
  if (!market || !symbol || !strategyIdentity || !direction || !entryPrice || !member
      || ![input.globalRisk.decision, direction].includes(member.side)
      || input.costLiquidity.cost?.market !== market || input.costLiquidity.cost?.symbol !== symbol
      || input.costLiquidity.cost?.strategyIdentity !== strategyIdentity
      || input.globalRisk.status !== "GLOBAL_RISK_PASS"
      || input.costLiquidity.status !== "COST_LIQUIDITY_GATE_PASS") {
    return blocked(["V2_POSITION_UPSTREAM_OR_IDENTITY_INVALID"]);
  }
  const resolvedPolicy = normalizePolicy(input.validatedPolicy, direction, entryPrice);
  if (!resolvedPolicy) return blocked(["V2_POSITION_VALIDATED_POLICY_INVALID"]);
  const approvedRiskBudget = positive(input.globalRisk.riskBudget?.approved);
  const conservativeCostBps = finite(input.costLiquidity.cost?.conservativeBps);
  const admittedDepth = positive(input.costLiquidity.liquidity?.visibleDepthNotional);
  const admittedOrderNotional = positive(input.costLiquidity.liquidity?.orderNotional);
  if (!approvedRiskBudget || conservativeCostBps == null || conservativeCostBps < 0
      || !admittedDepth || !admittedOrderNotional) {
    return blocked(["V2_POSITION_RISK_COST_OR_LIQUIDITY_EVIDENCE_INCOMPLETE"]);
  }

  const identity = {
    portfolioId: input.portfolio.portfolio.portfolioId,
    strategyIdentity,
    market,
    symbol,
    direction,
    decisionTime: input.costLiquidity.cost.decisionTime,
  };
  const stopDistance = Math.abs(entryPrice - resolvedPolicy.hardStopPrice);
  const costPerUnit = entryPrice * conservativeCostBps / 10_000;
  const scale = normalizeScaleIn(input.scaleIn, {
    market, symbol, strategyIdentity, direction, approvedRiskBudget,
    stopPrice: resolvedPolicy.hardStopPrice,
  });
  if (scale.status === "REJECTED") {
    return noTrade(scale.reasons, { identity, scaleIn: scale, exits: resolvedPolicy });
  }
  const availableRisk = scale.requested ? scale.remainingRiskBudget : approvedRiskBudget;
  const stopOnlyQuantity = floorToLot(availableRisk / stopDistance, resolvedPolicy.lotSize);
  const costAdjustedQuantity = floorToLot(availableRisk / (stopDistance + costPerUnit), resolvedPolicy.lotSize);
  const addedQuantity = costAdjustedQuantity;
  const currentQuantity = scale.requested ? scale.currentQuantity : 0;
  const totalQuantity = Number((currentQuantity + addedQuantity).toPrecision(15));
  const addedNotional = addedQuantity * entryPrice;
  const totalNotional = totalQuantity * entryPrice;
  const addedRiskAtStopWithCost = addedQuantity * (stopDistance + costPerUnit);
  const currentRiskAtStop = scale.requested ? approvedRiskBudget - scale.remainingRiskBudget : 0;
  const totalRiskAtStopWithCost = currentRiskAtStop + addedRiskAtStopWithCost;
  const capacityValues = [
    input.globalRisk.capacity?.remainingMarketExposure,
    input.globalRisk.capacity?.remainingAssetClassExposure,
    input.globalRisk.capacity?.remainingSectorExposure,
    input.globalRisk.capacity?.remainingDirectionalExposure,
  ].filter((value) => positive(value) != null);
  const globalIncrementalCapacity = Math.min(...capacityValues, Number.POSITIVE_INFINITY);
  const participation = addedNotional / admittedDepth;
  const simulation = executionSimulation(participation, input.executionSimulationPolicy);
  if (!simulation) return blocked(["V2_POSITION_EXECUTION_SIMULATION_POLICY_INVALID"]);
  const violations = [
    addedQuantity > 0 ? null : "DERIVED_QUANTITY_BELOW_LOT_SIZE",
    totalNotional <= resolvedPolicy.maximumPositionNotional ? null : "POSITION_NOTIONAL_LIMIT_EXCEEDED",
    addedNotional <= globalIncrementalCapacity ? null : "GLOBAL_INCREMENTAL_CAPACITY_EXCEEDED",
    addedNotional <= admittedOrderNotional ? null : "COST_LIQUIDITY_ADMITTED_NOTIONAL_EXCEEDED",
    totalRiskAtStopWithCost <= approvedRiskBudget + 1e-9 ? null : "ORIGINAL_RISK_BUDGET_EXCEEDED",
    simulation !== "NO_TRADE" ? null : "EXECUTION_SIMULATION_PARTICIPATION_EXCEEDED",
  ].filter(Boolean);
  const sizing = {
    order: Object.freeze([
      "LOGICAL_INVALIDATION_AND_STOP", "STOP_DISTANCE", "PERMITTED_ACCOUNT_RISK",
      "DERIVE_QUANTITY", "TOTAL_EXPOSURE", "LIQUIDITY_AND_FULL_COST", "APPROVE_OR_REJECT",
    ]),
    logicalInvalidationPrice: resolvedPolicy.logicalInvalidationPrice,
    hardStopPrice: resolvedPolicy.hardStopPrice,
    stopMovedForSize: false,
    stopDistance,
    approvedRiskBudget,
    conservativeCostBps,
    stopOnlyQuantity,
    costAdjustedQuantity,
    addedQuantity,
    totalQuantity,
    addedNotional,
    totalNotional,
    addedRiskAtStopWithCost,
    totalRiskAtStopWithCost,
    liquidityParticipation: participation,
  };
  const scaleIn = { ...scale, addedQuantity, totalQuantity, originalRiskBudgetPreserved: violations.length === 0 };
  const audit = {
    globalRiskEvidenceId: input.globalRisk.riskEvidenceId,
    costEvidenceDigest: input.costLiquidity.evidenceDigest,
    frozenPortfolioDigest: input.portfolio.portfolio.portfolioDigest,
    logicalStopChosenBeforeQuantity: true,
    perfectFillAssumed: false,
  };
  if (violations.length > 0) return noTrade(violations, { identity, sizing, scaleIn, exits: resolvedPolicy, audit });
  return result({
    status: "POSITION_POLICY_READY",
    decision: input.globalRisk.decision,
    reasons: ["STOP_FIRST_RISK_DERIVED_POSITION_POLICY_PASS"],
    identity,
    sizing,
    scaleIn,
    exits: {
      hardStop: resolvedPolicy.hardStopPrice,
      takeProfit1: { price: resolvedPolicy.takeProfit1Price, fraction: resolvedPolicy.takeProfit1Fraction },
      takeProfit2: { price: resolvedPolicy.takeProfit2Price, fraction: resolvedPolicy.takeProfit2Fraction },
      partialExit: true,
      trailingStop: { activationPrice: resolvedPolicy.trailingActivationPrice,
        distance: resolvedPolicy.trailingDistance },
      timeStopBars: resolvedPolicy.timeStopBars,
      strategyInvalidationExit: true,
      eventRiskExit: true,
      universalFixedPercentExit: false,
      validatedPolicyEvidenceId: resolvedPolicy.validatedPolicyEvidenceId,
    },
    executionSimulation: simulation,
    audit,
  });
}
