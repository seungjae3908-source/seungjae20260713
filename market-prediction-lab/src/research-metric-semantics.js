export const SUCCESS_RATE_DEFINITION = "tp_before_sl_resolved_barriers";
export const NET_PROFITABLE_RATE_DEFINITION = "net_pnl_positive_after_all_costs";

const TP_EXIT_REASONS = new Set(["take_profit", "take_profit_gap"]);
const SL_EXIT_REASONS = new Set(["stop_loss", "stop_loss_gap", "stop_loss_same_bar"]);

export const FORWARD_PROMOTION_POLICY_V1 = Object.freeze({
  policyId: "eth-futures-long-v6-forward-shadow-v1",
  candidateId: "eth-futures-long-v6",
  frozenAt: "2026-08-09T00:40:00.000Z",
  minimumSettledTrades: 30,
  minimumElapsedDays: 28,
  minimumTpBeforeSlRate: 0.40,
  minimumProfitFactor: 1.30,
  maximumDrawdownPercent: 10,
  minimumNetReturnPercent: 0,
  minimumExpectancy: 0,
  requiredPositiveCostStressMultiplier: 1.5,
  diagnosticCostStressMultiplier: 2,
  automaticLivePromotionAllowed: false,
});

function finiteOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function drawdownFromPnls(pnls, initialCapital) {
  let equity = initialCapital;
  let peak = initialCapital;
  let maximumDrawdownPercent = 0;
  for (const pnl of pnls) {
    equity += pnl;
    peak = Math.max(peak, equity);
    maximumDrawdownPercent = Math.max(maximumDrawdownPercent, peak > 0 ? (peak - equity) / peak * 100 : 0);
  }
  return maximumDrawdownPercent;
}

export function classifyBarrierOutcome(trade) {
  const reason = String(trade?.exitReason ?? trade?.subsequentMarketResult?.exitReason ?? "");
  if (TP_EXIT_REASONS.has(reason)) return "tp";
  if (SL_EXIT_REASONS.has(reason)) return "sl";
  if (reason === "end_of_data" || reason === "timeout" || reason === "manual_end") return "censored";
  return "other";
}

export function summarizeTradeOutcomeMetrics(trades = []) {
  if (!Array.isArray(trades)) throw new TypeError("trades must be an array");
  let tpHitCount = 0;
  let slHitCount = 0;
  let censoredCount = 0;
  let otherExitCount = 0;
  let netProfitableTradeCount = 0;
  for (const trade of trades) {
    const outcome = classifyBarrierOutcome(trade);
    if (outcome === "tp") tpHitCount += 1;
    else if (outcome === "sl") slHitCount += 1;
    else if (outcome === "censored") censoredCount += 1;
    else otherExitCount += 1;
    if (Number(trade?.netPnl) > 0) netProfitableTradeCount += 1;
  }
  const barrierResolvedTradeCount = tpHitCount + slHitCount;
  return Object.freeze({
    successRateDefinition: SUCCESS_RATE_DEFINITION,
    netProfitableRateDefinition: NET_PROFITABLE_RATE_DEFINITION,
    totalTrades: trades.length,
    barrierResolvedTradeCount,
    tpHitCount,
    slHitCount,
    censoredCount,
    otherExitCount,
    tpBeforeSlRate: barrierResolvedTradeCount ? tpHitCount / barrierResolvedTradeCount : 0,
    tpBeforeSlRateAvailable: barrierResolvedTradeCount > 0,
    netProfitableTradeCount,
    netProfitableTradeRate: trades.length ? netProfitableTradeCount / trades.length : 0,
  });
}

export function summarizeCostStress(trades = [], { initialCapital, multiplier } = {}) {
  if (!Array.isArray(trades)) throw new TypeError("trades must be an array");
  if (!(Number.isFinite(initialCapital) && initialCapital > 0)) throw new TypeError("initialCapital must be positive");
  if (!(Number.isFinite(multiplier) && multiplier >= 1)) throw new TypeError("multiplier must be >= 1");
  const pnls = trades.map((trade) => {
    const baselineNet = finiteOrZero(trade?.netPnl);
    const baselineCost = Math.max(0, finiteOrZero(trade?.costs?.total ?? trade?.execution?.costs?.total));
    return baselineNet - baselineCost * (multiplier - 1);
  });
  const wins = pnls.filter((value) => value > 0);
  const losses = pnls.filter((value) => value < 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  const netPnl = pnls.reduce((sum, value) => sum + value, 0);
  return Object.freeze({
    multiplier,
    netPnl,
    totalReturnPercent: netPnl / initialCapital * 100,
    expectancy: mean(pnls),
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Number.POSITIVE_INFINITY : 0,
    maximumDrawdownPercent: drawdownFromPnls(pnls, initialCapital),
    netProfitableTradeRate: pnls.length ? wins.length / pnls.length : 0,
  });
}

export function buildStandardizedResearchMetrics({ trades = [], initialCapital, totalReturnPercent, profitFactor, maximumDrawdownPercent, expectancy } = {}) {
  const outcomes = summarizeTradeOutcomeMetrics(trades);
  const baselineNetPnl = trades.reduce((sum, trade) => sum + finiteOrZero(trade?.netPnl), 0);
  const resolvedTotalReturnPercent = Number.isFinite(totalReturnPercent) ? totalReturnPercent : baselineNetPnl / initialCapital * 100;
  const resolvedExpectancy = Number.isFinite(expectancy) ? expectancy : mean(trades.map((trade) => finiteOrZero(trade?.netPnl)));
  const resolvedProfitFactor = Number.isFinite(profitFactor) || profitFactor === Number.POSITIVE_INFINITY
    ? profitFactor
    : summarizeCostStress(trades, { initialCapital, multiplier: 1 }).profitFactor;
  const resolvedMdd = Number.isFinite(maximumDrawdownPercent)
    ? maximumDrawdownPercent
    : drawdownFromPnls(trades.map((trade) => finiteOrZero(trade?.netPnl)), initialCapital);
  return Object.freeze({
    schemaVersion: 1,
    successRateDefinition: outcomes.successRateDefinition,
    successRatePercent: outcomes.tpBeforeSlRate * 100,
    tpBeforeSlRatePercent: outcomes.tpBeforeSlRate * 100,
    tpBeforeSlRateAvailable: outcomes.tpBeforeSlRateAvailable,
    netProfitableRateDefinition: outcomes.netProfitableRateDefinition,
    netProfitableTradeRatePercent: outcomes.netProfitableTradeRate * 100,
    totalTrades: outcomes.totalTrades,
    barrierResolvedTradeCount: outcomes.barrierResolvedTradeCount,
    tpHitCount: outcomes.tpHitCount,
    slHitCount: outcomes.slHitCount,
    censoredCount: outcomes.censoredCount,
    otherExitCount: outcomes.otherExitCount,
    totalReturnPercent: resolvedTotalReturnPercent,
    profitFactor: resolvedProfitFactor,
    maximumDrawdownPercent: resolvedMdd,
    expectancy: resolvedExpectancy,
    costStress: Object.freeze({
      x1_5: summarizeCostStress(trades, { initialCapital, multiplier: 1.5 }),
      x2: summarizeCostStress(trades, { initialCapital, multiplier: 2 }),
    }),
  });
}

export function evaluateForwardPromotionGate({ candidateId, metrics, elapsedDays, safeguards = {}, policy = FORWARD_PROMOTION_POLICY_V1 } = {}) {
  if (!metrics || typeof metrics !== "object") throw new TypeError("metrics are required");
  if (!(Number.isFinite(elapsedDays) && elapsedDays >= 0)) throw new TypeError("elapsedDays must be non-negative");
  if (typeof candidateId !== "string" || candidateId.length === 0) throw new TypeError("candidateId is required");
  const candidateScopeMatches = candidateId === policy.candidateId;
  const checks = Object.freeze({
    candidateScope: candidateScopeMatches,
    settledTrades: metrics.totalTrades >= policy.minimumSettledTrades,
    elapsedDays: elapsedDays >= policy.minimumElapsedDays,
    tpBeforeSlRate: metrics.tpBeforeSlRateAvailable === true && metrics.tpBeforeSlRatePercent / 100 >= policy.minimumTpBeforeSlRate,
    totalReturn: metrics.totalReturnPercent > policy.minimumNetReturnPercent,
    profitFactor: (metrics.profitFactor === Number.POSITIVE_INFINITY || metrics.profitFactor >= policy.minimumProfitFactor),
    maximumDrawdown: metrics.maximumDrawdownPercent <= policy.maximumDrawdownPercent,
    expectancy: metrics.expectancy > policy.minimumExpectancy,
    costStress: metrics.costStress?.x1_5?.totalReturnPercent > 0,
    frozenCandidateOnly: safeguards.frozenCandidateOnly === true,
    noRetuningAfterHoldout: safeguards.parametersRetunedAfterHoldout === false,
    noOrders: safeguards.orderSubmitted === false,
    noPrivateAccountAccess: safeguards.privateAccountRequestAllowed === false,
    liveStillBlocked: safeguards.liveOrderAllowed === false,
  });
  const passed = Object.values(checks).every(Boolean);
  return Object.freeze({
    policyId: policy.policyId,
    policyCandidateId: policy.candidateId,
    evaluatedCandidateId: candidateId,
    passed,
    status: passed ? "promotion_candidate" : "shadow_continue",
    nextStage: passed ? "manual_review" : "paper_shadow",
    checks,
    automaticLivePromotionAllowed: false,
  });
}
