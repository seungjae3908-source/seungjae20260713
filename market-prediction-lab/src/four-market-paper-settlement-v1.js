import {
  buildFourMarketExecutionContext,
  simulateFourMarketFill,
} from "./four-market-execution-v2.js";

const SETTLED_MINIMUM_SAMPLE_SIZE = 30;

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function positive(value) {
  return finite(value) && value > 0;
}

function nonNegative(value) {
  return finite(value) && value >= 0;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function entryDirection(sample) {
  return sample?.identity?.executionDirection;
}

function closingDirection(direction) {
  if (direction === "BUY") return "SELL_EXIT";
  if (direction === "LONG") return "SHORT";
  if (direction === "SHORT") return "LONG";
  throw new Error("PAPER_SETTLEMENT_ENTRY_DIRECTION_UNSUPPORTED");
}

function directionSign(direction) {
  return direction === "BUY" || direction === "LONG" ? 1 : -1;
}

function strategyIdentity(sample) {
  const identity = sample.identity;
  return Object.freeze({
    strategyId: identity.strategyId,
    strategyVersion: identity.strategyVersion,
    parameterHash: identity.parameterHash,
    researchCodeSha: identity.researchCodeSha,
  });
}

function safetyEnvelope() {
  return Object.freeze({
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    productionMutationAllowed: false,
    profitabilityClaimAllowed: false,
  });
}

function validateOpenSample(sample) {
  if (!sample || sample.schemaVersion !== 1 || sample.status !== "OPEN") throw new Error("PAPER_OPEN_SAMPLE_REQUIRED");
  if (!nonEmpty(sample.paperSampleId)) throw new Error("PAPER_SAMPLE_ID_REQUIRED");
  if (!sample.fill || !["FILLED", "PARTIALLY_FILLED"].includes(sample.fill.status)) throw new Error("PAPER_ENTRY_FILL_REQUIRED");
  if (!positive(sample.fill.fillPrice) || !positive(sample.fill.filledQuantity) || !positive(sample.fill.notional)) throw new Error("PAPER_ENTRY_FILL_INVALID");
  if (!nonNegative(sample.fill.costs?.immediateCost)) throw new Error("PAPER_ENTRY_COST_INVALID");
  if (sample.orderSubmitted !== false || sample.exchangeRequestSent !== false || sample.liveOrderAllowed !== false) {
    throw new Error("PAPER_OPEN_SAMPLE_SAFETY_VIOLATION");
  }
  closingDirection(entryDirection(sample));
}

function validateFunding(sample, funding) {
  const futures = sample.identity.market === "CRYPTO_FUTURES";
  if (!funding || funding.complete !== true || !Array.isArray(funding.payments)) {
    throw new Error("PAPER_FUNDING_EVIDENCE_INCOMPLETE");
  }
  if (!futures && funding.payments.length > 0) throw new Error("PAPER_NON_FUTURES_FUNDING_FORBIDDEN");

  let totalCost = 0;
  for (const payment of funding.payments) {
    if (!finite(payment?.asOfMs) || payment.asOfMs < sample.identity.evaluatedAtMs || payment.asOfMs > funding.evaluatedAtMs) {
      throw new Error("PAPER_FUNDING_TIMESTAMP_INVALID");
    }
    if (!finite(payment?.amount) || !nonEmpty(payment?.source) || !nonEmpty(payment?.provenance) || !nonEmpty(payment?.version)) {
      throw new Error("PAPER_FUNDING_PAYMENT_INVALID");
    }
    totalCost += payment.amount;
  }
  return totalCost;
}

function calculateExcursions(sample, bars, evaluatedAtMs) {
  if (!Array.isArray(bars)) throw new TypeError("path bars are required");
  const start = sample.identity.evaluatedAtMs;
  const entry = sample.fill.fillPrice;
  const sign = directionSign(entryDirection(sample));
  let mfe = null;
  let mae = null;
  let usableBars = 0;
  let rejectedFutureBars = 0;
  for (const bar of bars) {
    if (!finite(bar?.timestampMs)) continue;
    if (bar.timestampMs <= start) continue;
    if (bar.timestampMs > evaluatedAtMs) {
      rejectedFutureBars += 1;
      continue;
    }
    if (!positive(bar.high) || !positive(bar.low) || bar.high < bar.low) continue;
    const favorablePrice = sign > 0 ? bar.high : bar.low;
    const adversePrice = sign > 0 ? bar.low : bar.high;
    const favorable = ((favorablePrice - entry) / entry) * sign * 100;
    const adverse = ((adversePrice - entry) / entry) * sign * 100;
    mfe = mfe == null ? favorable : Math.max(mfe, favorable);
    mae = mae == null ? adverse : Math.min(mae, adverse);
    usableBars += 1;
  }
  return Object.freeze({ mfePercent: mfe, maePercent: mae, usableBars, rejectedFutureBars });
}

function blocked(sample, status, blockers, extra = {}) {
  return Object.freeze({
    schemaVersion: 1,
    paperSampleId: sample.paperSampleId,
    market: sample.identity.market,
    strategyId: sample.identity.strategyId,
    strategyVersion: sample.identity.strategyVersion,
    researchCodeSha: sample.identity.researchCodeSha,
    status,
    blockers: Object.freeze([...blockers]),
    ...extra,
    ...safetyEnvelope(),
  });
}

export function settleFourMarketPaperSample({
  sample,
  exitExecution,
  exitOrderType = "MARKET",
  exitBar = null,
  exitQuote = null,
  exitDepth = null,
  pathBars = [],
  fundingEvidence,
  evaluatedAtMs,
} = {}) {
  validateOpenSample(sample);
  if (!finite(evaluatedAtMs) || evaluatedAtMs <= sample.identity.evaluatedAtMs) throw new Error("PAPER_SETTLEMENT_TIME_INVALID");
  if (!exitExecution || typeof exitExecution !== "object") throw new TypeError("exit execution input is required");

  const closeDirection = closingDirection(entryDirection(sample));
  const context = buildFourMarketExecutionContext({
    ...exitExecution,
    market: sample.identity.market,
    stage: "PAPER",
    style: sample.identity.style,
    timeframe: sample.identity.timeframe,
    horizon: sample.identity.horizon,
    direction: closeDirection,
    strategyIdentity: strategyIdentity(sample),
    evaluatedAtMs,
  });

  if (context.status !== "READY") return blocked(sample, "BLOCKED", context.blockers, { exitContextStatus: context.status });
  if (context.costPolicy.version !== sample.profitEvidence.costPolicyId) {
    return blocked(sample, "BLOCKED", ["PAPER_COST_POLICY_VERSION_MISMATCH"], { exitContextStatus: context.status });
  }

  const quantity = sample.fill.filledQuantity;
  const exitFill = simulateFourMarketFill({
    context,
    order: Object.freeze({ type: exitOrderType, quantity, direction: closeDirection }),
    bar: exitBar,
    quote: exitQuote,
    depth: exitDepth,
  });
  if (exitFill.status === "PENDING") return blocked(sample, "PENDING_EXIT", [exitFill.reason ?? "EXIT_PENDING"], { exitFill });
  if (exitFill.status !== "FILLED") {
    return blocked(sample, "BLOCKED", [exitFill.reason ?? "FULL_EXIT_FILL_REQUIRED"], { exitFill });
  }
  if (Math.abs(exitFill.filledQuantity - quantity) > Number.EPSILON) {
    return blocked(sample, "BLOCKED", ["FULL_EXIT_FILL_REQUIRED"], { exitFill });
  }

  const fundingCost = validateFunding(sample, { ...fundingEvidence, evaluatedAtMs });
  const sign = directionSign(entryDirection(sample));
  const grossPnl = (exitFill.fillPrice - sample.fill.fillPrice) * quantity * sign;
  const entryCost = sample.fill.costs.immediateCost;
  const exitCost = exitFill.costs.immediateCost;
  const netPnl = grossPnl - entryCost - exitCost - fundingCost;
  const entryNotional = sample.fill.notional;
  const grossReturnPercent = (grossPnl / entryNotional) * 100;
  const netReturnPercent = (netPnl / entryNotional) * 100;
  const outcome = netPnl > 0 ? "WIN" : netPnl < 0 ? "LOSS" : "NEUTRAL";
  const excursions = calculateExcursions(sample, pathBars, evaluatedAtMs);

  return Object.freeze({
    schemaVersion: 1,
    paperSampleId: sample.paperSampleId,
    market: sample.identity.market,
    strategyId: sample.identity.strategyId,
    strategyVersion: sample.identity.strategyVersion,
    researchCodeSha: sample.identity.researchCodeSha,
    parameterHash: sample.identity.parameterHash,
    signalDirection: sample.identity.signalDirection,
    entryDirection: entryDirection(sample),
    closeDirection,
    status: "SETTLED",
    outcome,
    entryEvaluatedAtMs: sample.identity.evaluatedAtMs,
    settledAtMs: evaluatedAtMs,
    holdingMs: evaluatedAtMs - sample.identity.evaluatedAtMs,
    quantity,
    entryFillPrice: sample.fill.fillPrice,
    exitFillPrice: exitFill.fillPrice,
    entryNotional,
    grossPnl,
    entryCost,
    exitCost,
    fundingCost,
    totalExplicitCost: entryCost + exitCost + fundingCost,
    netPnl,
    grossReturnPercent,
    netReturnPercent,
    mfePercent: excursions.mfePercent,
    maePercent: excursions.maePercent,
    usablePathBars: excursions.usableBars,
    rejectedFuturePathBars: excursions.rejectedFutureBars,
    entryParityFingerprint: sample.parityFingerprint,
    exitParityFingerprint: context.parityFingerprint,
    costPolicyVersion: context.costPolicy.version,
    exitFill: Object.freeze({ ...exitFill }),
    blockers: Object.freeze([]),
    ...safetyEnvelope(),
  });
}

function maxDrawdownFromReturns(returns) {
  let equity = 1;
  let peak = 1;
  let worst = 0;
  for (const value of returns) {
    equity *= 1 + value / 100;
    peak = Math.max(peak, equity);
    worst = Math.min(worst, ((equity - peak) / peak) * 100);
  }
  return worst * -1;
}

export function summarizeSettledPaperSamples(settlements = [], minimumSampleSize = SETTLED_MINIMUM_SAMPLE_SIZE) {
  if (!Array.isArray(settlements)) throw new TypeError("settlements array is required");
  if (!Number.isInteger(minimumSampleSize) || minimumSampleSize <= 0) throw new TypeError("minimumSampleSize must be positive");
  const completed = settlements.filter((item) => item?.status === "SETTLED");
  const ids = new Set();
  for (const item of completed) {
    if (!nonEmpty(item.paperSampleId) || ids.has(item.paperSampleId)) throw new Error("PAPER_SETTLEMENT_DUPLICATE_SAMPLE");
    ids.add(item.paperSampleId);
    if (!finite(item.netPnl) || !finite(item.netReturnPercent)) throw new Error("PAPER_SETTLEMENT_METRIC_INVALID");
    if (item.orderSubmitted !== false || item.exchangeRequestSent !== false || item.liveOrderAllowed !== false) throw new Error("PAPER_SETTLEMENT_SAFETY_VIOLATION");
  }
  const returns = completed.map((item) => item.netReturnPercent);
  const wins = completed.filter((item) => item.netPnl > 0);
  const losses = completed.filter((item) => item.netPnl < 0);
  const gains = wins.reduce((sum, item) => sum + item.netPnl, 0);
  const lossAbs = Math.abs(losses.reduce((sum, item) => sum + item.netPnl, 0));
  const sampleSize = completed.length;
  return Object.freeze({
    schemaVersion: 1,
    sampleStatus: sampleSize >= minimumSampleSize ? "READY" : "INSUFFICIENT_SAMPLE",
    minimumSampleSize,
    sampleSize,
    wins: wins.length,
    losses: losses.length,
    neutrals: completed.filter((item) => item.netPnl === 0).length,
    hitRate: sampleSize ? wins.length / sampleSize : null,
    averageNetReturnPercent: sampleSize ? returns.reduce((a, b) => a + b, 0) / sampleSize : null,
    totalNetPnl: sampleSize ? completed.reduce((sum, item) => sum + item.netPnl, 0) : null,
    expectancyNetPnl: sampleSize ? completed.reduce((sum, item) => sum + item.netPnl, 0) / sampleSize : null,
    profitFactor: lossAbs > 0 ? gains / lossAbs : gains > 0 ? null : 0,
    maxDrawdownPercent: sampleSize ? maxDrawdownFromReturns(returns) : null,
    profitabilityClaimAllowed: false,
    promotionEvidenceReady: sampleSize >= minimumSampleSize,
    simulatedOnly: true,
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
  });
}

export const FOUR_MARKET_PAPER_SETTLEMENT_MINIMUM_SAMPLE_SIZE = SETTLED_MINIMUM_SAMPLE_SIZE;
