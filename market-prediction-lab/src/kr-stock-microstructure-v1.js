import { createHash } from "node:crypto";
import {
  compareExecutionStageParity,
  simulateFourMarketFill,
} from "./four-market-execution-v2.js";

export const KR_STOCK_SESSION_PHASES = Object.freeze([
  "CONTINUOUS",
  "OPENING_AUCTION",
  "CLOSING_AUCTION",
  "VI_AUCTION",
]);

export const KR_STOCK_TRADING_STATUSES = Object.freeze([
  "TRADABLE",
  "HALTED",
  "SUSPENDED",
]);

export const KR_STOCK_LIMIT_STATES = Object.freeze([
  "NORMAL",
  "UPPER_LOCKED",
  "LOWER_LOCKED",
]);

const SESSION_PHASE_SET = new Set(KR_STOCK_SESSION_PHASES);
const TRADING_STATUS_SET = new Set(KR_STOCK_TRADING_STATUSES);
const LIMIT_STATE_SET = new Set(KR_STOCK_LIMIT_STATES);

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function positive(value) {
  return finite(value) && value > 0;
}

function nonNegative(value) {
  return finite(value) && value >= 0;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function addBlocker(blockers, condition, code) {
  if (!condition) blockers.push(code);
}

function freshTimestamp(asOfMs, maxAgeMs, evaluatedAtMs) {
  return finite(asOfMs)
    && positive(maxAgeMs)
    && asOfMs <= evaluatedAtMs
    && evaluatedAtMs - asOfMs <= maxAgeMs;
}

function tickAligned(price, tickSize) {
  if (!positive(price) || !positive(tickSize)) return false;
  const ratio = price / tickSize;
  return Math.abs(ratio - Math.round(ratio)) <= 1e-9 * Math.max(1, Math.abs(ratio));
}

function roundAdverseToTick(price, side, tickSize) {
  if (!positive(price) || !positive(tickSize)) return null;
  const ratio = price / tickSize;
  const rounded = side === "BUY" ? Math.ceil(ratio - 1e-12) : Math.floor(ratio + 1e-12);
  return rounded * tickSize;
}

function validatePolicy(policy, blockers) {
  addBlocker(blockers, nonEmptyString(policy?.version), "KR_MICROSTRUCTURE_POLICY_VERSION_REQUIRED");
  addBlocker(blockers, nonEmptyString(policy?.tickPolicyVersion), "KR_TICK_POLICY_VERSION_REQUIRED");
  addBlocker(blockers, nonEmptyString(policy?.priceLimitPolicyVersion), "KR_PRICE_LIMIT_POLICY_VERSION_REQUIRED");
  addBlocker(blockers, nonEmptyString(policy?.auctionPolicyVersion), "KR_AUCTION_POLICY_VERSION_REQUIRED");
  addBlocker(blockers, nonEmptyString(policy?.viPolicyVersion), "KR_VI_POLICY_VERSION_REQUIRED");
  addBlocker(blockers, nonEmptyString(policy?.volumeParticipationPolicyVersion), "KR_VOLUME_PARTICIPATION_POLICY_VERSION_REQUIRED");
  addBlocker(blockers, positive(policy?.maxEvidenceAgeMs), "KR_MAX_EVIDENCE_AGE_REQUIRED");
  addBlocker(blockers,
    positive(policy?.maxBarVolumeParticipationRate) && policy.maxBarVolumeParticipationRate <= 1,
    "KR_MAX_BAR_VOLUME_PARTICIPATION_REQUIRED");
  addBlocker(blockers, policy?.adverseTickRounding === true, "KR_ADVERSE_TICK_ROUNDING_REQUIRED");
  addBlocker(blockers, typeof policy?.auctionFillAllowed === "boolean", "KR_AUCTION_FILL_POLICY_REQUIRED");
}

function validatePriceLimitEvidence(evidence, blockers) {
  addBlocker(blockers, positive(evidence?.referencePrice), "KR_REFERENCE_PRICE_REQUIRED");
  addBlocker(blockers, positive(evidence?.lowerLimitPrice), "KR_LOWER_PRICE_LIMIT_REQUIRED");
  addBlocker(blockers, positive(evidence?.upperLimitPrice), "KR_UPPER_PRICE_LIMIT_REQUIRED");
  addBlocker(blockers,
    positive(evidence?.lowerLimitPrice)
      && positive(evidence?.referencePrice)
      && positive(evidence?.upperLimitPrice)
      && evidence.lowerLimitPrice < evidence.referencePrice
      && evidence.referencePrice < evidence.upperLimitPrice,
    "KR_PRICE_LIMIT_RANGE_INVALID");
  addBlocker(blockers, nonEmptyString(evidence?.priceLimitEvidenceVersion), "KR_PRICE_LIMIT_EVIDENCE_VERSION_REQUIRED");
}

function validateAuctionEvidence(evidence, policy, evaluatedAtMs, blockers) {
  const auction = evidence?.auctionEvidence;
  addBlocker(blockers, policy?.auctionFillAllowed === true, "KR_AUCTION_FILL_NOT_ALLOWED_BY_POLICY");
  addBlocker(blockers, auction?.available === true, "KR_AUCTION_EVIDENCE_REQUIRED");
  addBlocker(blockers, positive(auction?.indicativePrice), "KR_AUCTION_PRICE_REQUIRED");
  addBlocker(blockers, nonNegative(auction?.executableQuantity), "KR_AUCTION_EXECUTABLE_QTY_REQUIRED");
  addBlocker(blockers,
    freshTimestamp(auction?.asOfMs, auction?.maxAgeMs, evaluatedAtMs),
    "KR_AUCTION_EVIDENCE_STALE_OR_FUTURE");
}

function validateVolumeEvidence(evidence, evaluatedAtMs, blockers) {
  const volume = evidence?.volumeEvidence;
  addBlocker(blockers, volume?.available === true, "KR_VOLUME_EVIDENCE_REQUIRED");
  addBlocker(blockers, nonNegative(volume?.barVolume), "KR_BAR_VOLUME_REQUIRED");
  addBlocker(blockers,
    freshTimestamp(volume?.asOfMs, volume?.maxAgeMs, evaluatedAtMs),
    "KR_VOLUME_EVIDENCE_STALE_OR_FUTURE");
}

function validateMicrostructureEvidence(evidence, policy, evaluatedAtMs, blockers) {
  addBlocker(blockers, evidence?.provider === "toss", "KR_CANONICAL_PROVIDER_MISMATCH");
  addBlocker(blockers, TRADING_STATUS_SET.has(evidence?.tradingStatus), "KR_TRADING_STATUS_REQUIRED");
  addBlocker(blockers, evidence?.tradingStatus === "TRADABLE", "KR_TRADING_NOT_TRADABLE");
  addBlocker(blockers, SESSION_PHASE_SET.has(evidence?.sessionPhase), "KR_SESSION_PHASE_REQUIRED");
  addBlocker(blockers, positive(evidence?.tickSize), "KR_TICK_SIZE_REQUIRED");
  addBlocker(blockers,
    freshTimestamp(evidence?.asOfMs, policy?.maxEvidenceAgeMs, evaluatedAtMs),
    "KR_MICROSTRUCTURE_EVIDENCE_STALE_OR_FUTURE");
  addBlocker(blockers, ["CLEAR", "ACTIVE"].includes(evidence?.viState), "KR_VI_STATE_REQUIRED");
  addBlocker(blockers, LIMIT_STATE_SET.has(evidence?.limitState), "KR_LIMIT_STATE_REQUIRED");
  validatePriceLimitEvidence(evidence, blockers);
  validateVolumeEvidence(evidence, evaluatedAtMs, blockers);

  if (evidence?.viState === "ACTIVE") {
    addBlocker(blockers, evidence?.sessionPhase === "VI_AUCTION", "KR_VI_REQUIRES_VI_AUCTION_PHASE");
  }
  if (evidence?.sessionPhase === "VI_AUCTION") {
    addBlocker(blockers, evidence?.viState === "ACTIVE", "KR_VI_AUCTION_REQUIRES_ACTIVE_VI");
  }
  if (evidence?.sessionPhase !== "CONTINUOUS") {
    validateAuctionEvidence(evidence, policy, evaluatedAtMs, blockers);
  }

  if (["UPPER_LOCKED", "LOWER_LOCKED"].includes(evidence?.limitState)) {
    addBlocker(blockers, nonNegative(evidence?.limitExecutableQuantity), "KR_LIMIT_LOCK_EXECUTABLE_QTY_REQUIRED");
  }
}

export function buildKrStockMicrostructureContext({
  baseContext,
  microstructurePolicy,
  microstructureEvidence,
  evaluatedAtMs,
} = {}) {
  if (!baseContext || baseContext.schemaVersion !== 2) throw new TypeError("valid four-market execution context is required");
  if (baseContext.market !== "KR_STOCK") throw new TypeError("KR_STOCK execution context is required");
  if (!finite(evaluatedAtMs)) throw new TypeError("evaluatedAtMs is required");

  const blockers = [];
  addBlocker(blockers, baseContext.status === "READY", "BASE_EXECUTION_CONTEXT_NOT_READY");
  addBlocker(blockers, evaluatedAtMs === baseContext.evaluatedAtMs, "KR_EVALUATION_TIME_MISMATCH");
  validatePolicy(microstructurePolicy, blockers);
  validateMicrostructureEvidence(microstructureEvidence, microstructurePolicy, evaluatedAtMs, blockers);

  const parityPayload = Object.freeze({
    schemaVersion: 1,
    baseParityFingerprint: baseContext.parityFingerprint,
    microstructurePolicyVersion: microstructurePolicy?.version ?? null,
    tickPolicyVersion: microstructurePolicy?.tickPolicyVersion ?? null,
    priceLimitPolicyVersion: microstructurePolicy?.priceLimitPolicyVersion ?? null,
    auctionPolicyVersion: microstructurePolicy?.auctionPolicyVersion ?? null,
    viPolicyVersion: microstructurePolicy?.viPolicyVersion ?? null,
    volumeParticipationPolicyVersion: microstructurePolicy?.volumeParticipationPolicyVersion ?? null,
    maxEvidenceAgeMs: microstructurePolicy?.maxEvidenceAgeMs ?? null,
    maxBarVolumeParticipationRate: microstructurePolicy?.maxBarVolumeParticipationRate ?? null,
    adverseTickRounding: microstructurePolicy?.adverseTickRounding ?? null,
    auctionFillAllowed: microstructurePolicy?.auctionFillAllowed ?? null,
  });
  const microstructureFingerprint = createHash("sha256").update(stableSerialize(parityPayload)).digest("hex");

  return Object.freeze({
    schemaVersion: 1,
    market: "KR_STOCK",
    stage: baseContext.stage,
    status: blockers.length === 0 ? "READY" : "BLOCKED",
    blockers: Object.freeze([...new Set(blockers)]),
    baseContext,
    microstructurePolicy: Object.freeze({ ...(microstructurePolicy ?? {}) }),
    microstructureEvidence: Object.freeze({ ...(microstructureEvidence ?? {}) }),
    parityPayload,
    microstructureFingerprint,
    evaluatedAtMs,
    safety: Object.freeze({
      simulationOnly: true,
      liveExecutionAllowed: false,
      privateAccountRequestAllowed: false,
      privateTradingRequestAllowed: false,
      orderSubmissionAllowed: false,
      branchWriteAllowed: false,
      productionMutationAllowed: false,
    }),
  });
}

export function compareKrStockMicrostructureParity(contexts = []) {
  if (!Array.isArray(contexts) || contexts.length < 2) throw new TypeError("at least two KR microstructure contexts are required");
  if (contexts.some((context) => !context || context.schemaVersion !== 1 || context.market !== "KR_STOCK")) {
    throw new TypeError("valid KR microstructure contexts are required");
  }

  const baseParity = compareExecutionStageParity(contexts.map((context) => context.baseContext));
  const reference = contexts[0];
  const blockedStages = contexts.filter((context) => context.status !== "READY").map((context) => context.stage);
  const mismatchedStages = contexts
    .filter((context) => context.microstructureFingerprint !== reference.microstructureFingerprint)
    .map((context) => context.stage);
  const mismatchFields = [...new Set(contexts.slice(1).flatMap((context) =>
    Object.keys(reference.parityPayload)
      .filter((field) => stableSerialize(reference.parityPayload[field]) !== stableSerialize(context.parityPayload[field]))
  ))].sort();

  const comparable = baseParity.status === "READY" && blockedStages.length === 0 && mismatchedStages.length === 0;
  return Object.freeze({
    status: comparable ? "READY" : "PERFORMANCE_COMPARISON_BLOCKED",
    reason: comparable ? null : "KR_MICROSTRUCTURE_POLICY_MISMATCH",
    baseParityStatus: baseParity.status,
    blockedStages: Object.freeze(blockedStages),
    mismatchedStages: Object.freeze(mismatchedStages),
    mismatchFields: Object.freeze(mismatchFields),
    microstructureFingerprint: comparable ? reference.microstructureFingerprint : null,
    backtestPaperShadowComparable: comparable,
    livePromotionAllowed: false,
  });
}

function validateOrderPriceAgainstMicrostructure(order, context) {
  const evidence = context.microstructureEvidence;
  const prices = [order?.limitPrice, order?.stopPrice].filter((value) => value != null);
  for (const price of prices) {
    if (!positive(price)) return "KR_ORDER_PRICE_INVALID";
    if (!tickAligned(price, evidence.tickSize)) return "KR_ORDER_PRICE_NOT_TICK_ALIGNED";
    if (price < evidence.lowerLimitPrice || price > evidence.upperLimitPrice) return "KR_ORDER_PRICE_OUTSIDE_LIMITS";
  }
  return null;
}

function volumeCapacity(context) {
  return context.microstructureEvidence.volumeEvidence.barVolume
    * context.microstructurePolicy.maxBarVolumeParticipationRate;
}

function limitLockCapacity(context) {
  const evidence = context.microstructureEvidence;
  if (evidence.limitState === "NORMAL") return Number.POSITIVE_INFINITY;
  return evidence.limitExecutableQuantity;
}

function applyQuantityCaps({ context, order, candidateQuantity }) {
  const capacity = Math.min(candidateQuantity, volumeCapacity(context), limitLockCapacity(context));
  const filledQuantity = Math.max(0, capacity);
  const partial = filledQuantity + Number.EPSILON < order.quantity;
  if (filledQuantity <= 0) {
    return Object.freeze({ status: "PENDING", reason: "KR_NO_EXECUTABLE_CAPACITY", filledQuantity: 0, partial: false });
  }
  if (partial && context.baseContext.executionPolicy.allowPartialFill !== true) {
    return Object.freeze({ status: "PENDING", reason: "KR_PARTIAL_FILL_FORBIDDEN", filledQuantity: 0, partial: true });
  }
  return Object.freeze({ status: partial ? "PARTIALLY_FILLED" : "FILLED", reason: null, filledQuantity, partial });
}

function recomputeCosts(context, side, fillPrice, filledQuantity, partial) {
  const rates = context.baseContext.costPolicy;
  const notional = fillPrice * filledQuantity;
  const commission = notional * rates.commissionRate;
  const tax = side === "SELL" ? notional * rates.taxRate : 0;
  const partialFillImpact = partial ? notional * rates.partialFillImpactRate : 0;
  return Object.freeze({
    notional,
    commission,
    tax,
    partialFillImpact,
    immediateCost: commission + tax + partialFillImpact,
  });
}

function priceWithinLimits(price, evidence) {
  return positive(price) && price >= evidence.lowerLimitPrice && price <= evidence.upperLimitPrice;
}

function simulateAuctionFill({ context, order }) {
  const evidence = context.microstructureEvidence;
  const auction = evidence.auctionEvidence;
  if (order.type === "STOP_MARKET") {
    return Object.freeze({ status: "BLOCKED", reason: "KR_STOP_MARKET_AUCTION_UNSUPPORTED", orderSubmitted: false, exchangeRequestSent: false });
  }

  const side = order.direction === "BUY" ? "BUY" : "SELL";
  if (order.type === "LIMIT") {
    const executable = side === "BUY" ? auction.indicativePrice <= order.limitPrice : auction.indicativePrice >= order.limitPrice;
    if (!executable) return Object.freeze({ status: "PENDING", reason: "KR_AUCTION_LIMIT_NOT_EXECUTABLE", orderSubmitted: false, exchangeRequestSent: false });
  }

  const rates = context.baseContext.costPolicy;
  const adverseRate = order.type === "LIMIT" ? 0 : rates.slippageRate + rates.latencyRate + rates.liquidityImpactRate;
  const rawPrice = side === "BUY" ? auction.indicativePrice * (1 + adverseRate) : auction.indicativePrice * (1 - adverseRate);
  const fillPrice = roundAdverseToTick(rawPrice, side, evidence.tickSize);
  if (!priceWithinLimits(fillPrice, evidence)) {
    return Object.freeze({ status: "BLOCKED", reason: "KR_AUCTION_FILL_OUTSIDE_PRICE_LIMITS", orderSubmitted: false, exchangeRequestSent: false });
  }

  const quantity = applyQuantityCaps({
    context,
    order,
    candidateQuantity: Math.min(order.quantity, auction.executableQuantity),
  });
  if (!["FILLED", "PARTIALLY_FILLED"].includes(quantity.status)) {
    return Object.freeze({ ...quantity, orderSubmitted: false, exchangeRequestSent: false });
  }

  const costs = recomputeCosts(context, side, fillPrice, quantity.filledQuantity, quantity.partial);
  return Object.freeze({
    status: quantity.status,
    market: "KR_STOCK",
    stage: context.stage,
    direction: order.direction,
    side,
    orderType: order.type,
    fillModel: "KR_AUCTION_SINGLE_PRICE",
    sessionPhase: evidence.sessionPhase,
    requestedQuantity: order.quantity,
    filledQuantity: quantity.filledQuantity,
    unfilledQuantity: order.quantity - quantity.filledQuantity,
    fillPrice,
    notional: costs.notional,
    costs: Object.freeze({
      commission: costs.commission,
      tax: costs.tax,
      partialFillImpact: costs.partialFillImpact,
      immediateCost: costs.immediateCost,
      fundingRatePerInterval: 0,
    }),
    microstructureFingerprint: context.microstructureFingerprint,
    orderSubmitted: false,
    exchangeRequestSent: false,
    privateTradingRequestSent: false,
    liveExecution: false,
  });
}

export function simulateKrStockMicrostructureFill({ context, order, bar = null, quote = null, depth = null } = {}) {
  if (!context || context.schemaVersion !== 1 || context.market !== "KR_STOCK") {
    throw new TypeError("valid KR microstructure context is required");
  }
  if (context.status !== "READY") {
    return Object.freeze({ status: "BLOCKED", reason: "KR_MICROSTRUCTURE_CONTEXT_NOT_READY", blockers: context.blockers, orderSubmitted: false, exchangeRequestSent: false });
  }

  const priceError = validateOrderPriceAgainstMicrostructure(order, context);
  if (priceError) return Object.freeze({ status: "BLOCKED", reason: priceError, orderSubmitted: false, exchangeRequestSent: false });

  if (context.microstructureEvidence.sessionPhase !== "CONTINUOUS") {
    return simulateAuctionFill({ context, order });
  }

  const baseFill = simulateFourMarketFill({ context: context.baseContext, order, bar, quote, depth });
  if (!["FILLED", "PARTIALLY_FILLED"].includes(baseFill.status)) return baseFill;

  const fillPrice = roundAdverseToTick(baseFill.fillPrice, baseFill.side, context.microstructureEvidence.tickSize);
  if (!priceWithinLimits(fillPrice, context.microstructureEvidence)) {
    return Object.freeze({ status: "BLOCKED", reason: "KR_FILL_OUTSIDE_PRICE_LIMITS", orderSubmitted: false, exchangeRequestSent: false });
  }

  const quantity = applyQuantityCaps({ context, order, candidateQuantity: baseFill.filledQuantity });
  if (!["FILLED", "PARTIALLY_FILLED"].includes(quantity.status)) {
    return Object.freeze({ ...quantity, orderSubmitted: false, exchangeRequestSent: false });
  }

  const costs = recomputeCosts(context, baseFill.side, fillPrice, quantity.filledQuantity, quantity.partial);
  return Object.freeze({
    ...baseFill,
    status: quantity.status,
    fillPrice,
    requestedQuantity: order.quantity,
    filledQuantity: quantity.filledQuantity,
    unfilledQuantity: order.quantity - quantity.filledQuantity,
    notional: costs.notional,
    costs: Object.freeze({
      commission: costs.commission,
      tax: costs.tax,
      partialFillImpact: costs.partialFillImpact,
      immediateCost: costs.immediateCost,
      fundingRatePerInterval: 0,
    }),
    microstructureFingerprint: context.microstructureFingerprint,
    krMicrostructureApplied: true,
    orderSubmitted: false,
    exchangeRequestSent: false,
    privateTradingRequestSent: false,
    liveExecution: false,
  });
}
