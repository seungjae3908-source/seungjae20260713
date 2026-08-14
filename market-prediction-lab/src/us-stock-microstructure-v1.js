import { createHash } from "node:crypto";
import {
  compareExecutionStageParity,
  simulateFourMarketFill,
} from "./four-market-execution-v2.js";

export const US_STOCK_MICROSTRUCTURE_ADAPTER = Object.freeze({
  id: "us-stock-toss-microstructure",
  version: "v1",
  market: "US_STOCK",
  provider: "toss",
  settlementCurrency: "USD",
});

export const US_STOCK_PHASES = Object.freeze([
  "PREMARKET",
  "REGULAR",
  "AFTER_HOURS",
  "OPENING_AUCTION",
  "CLOSING_AUCTION",
]);

const PHASE_SET = new Set(US_STOCK_PHASES);
const CONTINUOUS_PHASES = new Set(["PREMARKET", "REGULAR", "AFTER_HOURS"]);
const AUCTION_PHASES = new Set(["OPENING_AUCTION", "CLOSING_AUCTION"]);

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

function sessionParticipation(policy, phase) {
  if (phase === "PREMARKET") return policy?.premarketMaxParticipationRate;
  if (phase === "AFTER_HOURS") return policy?.afterHoursMaxParticipationRate;
  if (phase === "REGULAR") return policy?.regularMaxParticipationRate;
  return policy?.auctionMaxParticipationRate;
}

function sessionSpreadCap(policy, phase) {
  if (phase === "PREMARKET") return policy?.premarketMaxSpreadRate;
  if (phase === "AFTER_HOURS") return policy?.afterHoursMaxSpreadRate;
  if (phase === "REGULAR") return policy?.regularMaxSpreadRate;
  return null;
}

function validatePolicy(policy, blockers) {
  addBlocker(blockers, nonEmpty(policy?.version), "US_MICROSTRUCTURE_POLICY_VERSION_REQUIRED");
  addBlocker(blockers, nonEmpty(policy?.quoteSourcePolicyVersion), "US_QUOTE_SOURCE_POLICY_VERSION_REQUIRED");
  for (const field of [
    "premarketMaxParticipationRate",
    "regularMaxParticipationRate",
    "afterHoursMaxParticipationRate",
    "auctionMaxParticipationRate",
  ]) {
    addBlocker(blockers, positive(policy?.[field]) && policy[field] <= 1, `US_${field.toUpperCase()}_REQUIRED`);
  }
  for (const field of [
    "premarketMaxSpreadRate",
    "regularMaxSpreadRate",
    "afterHoursMaxSpreadRate",
  ]) {
    addBlocker(blockers, nonNegative(policy?.[field]), `US_${field.toUpperCase()}_REQUIRED`);
  }
}

function validateFreshEvidence(evidence, evaluatedAtMs, blockers, prefix) {
  addBlocker(blockers, finite(evidence?.asOfMs), `${prefix}_TIMESTAMP_REQUIRED`);
  addBlocker(blockers, positive(evidence?.maxAgeMs), `${prefix}_MAX_AGE_REQUIRED`);
  if (finite(evidence?.asOfMs)) {
    addBlocker(blockers, evidence.asOfMs <= evaluatedAtMs, `${prefix}_FUTURE_FORBIDDEN`);
    if (positive(evidence?.maxAgeMs)) {
      addBlocker(blockers, evaluatedAtMs - evidence.asOfMs <= evidence.maxAgeMs, `${prefix}_STALE_FORBIDDEN`);
    }
  }
}

function validateContinuousEvidence({ phase, evidence, policy, evaluatedAtMs }, blockers) {
  const quote = evidence?.quoteEvidence;
  addBlocker(blockers, quote?.available === true, "US_QUOTE_EVIDENCE_REQUIRED");
  addBlocker(blockers, quote?.sourceVerified === true, "US_QUOTE_SOURCE_NOT_VERIFIED");
  addBlocker(blockers, nonEmpty(quote?.source), "US_QUOTE_SOURCE_REQUIRED");
  addBlocker(blockers, positive(quote?.bid), "US_VALID_BID_REQUIRED");
  addBlocker(blockers, positive(quote?.ask), "US_VALID_ASK_REQUIRED");
  if (positive(quote?.bid) && positive(quote?.ask)) {
    addBlocker(blockers, quote.bid <= quote.ask, "US_CROSSED_QUOTE_FORBIDDEN");
    const mid = (quote.bid + quote.ask) / 2;
    const spreadRate = (quote.ask - quote.bid) / mid;
    const maxSpreadRate = sessionSpreadCap(policy, phase);
    if (nonNegative(maxSpreadRate)) addBlocker(blockers, spreadRate <= maxSpreadRate, "US_SESSION_SPREAD_TOO_WIDE");
  }
  validateFreshEvidence(quote, evaluatedAtMs, blockers, "US_QUOTE");

  addBlocker(blockers, nonNegative(evidence?.observedVolume), "US_OBSERVED_VOLUME_REQUIRED");
  addBlocker(blockers, evidence?.observedVolumeEvidenceReady === true, "US_OBSERVED_VOLUME_EVIDENCE_REQUIRED");

  if (phase === "PREMARKET" || phase === "AFTER_HOURS") {
    addBlocker(blockers, evidence?.extendedHoursEligible === true, "US_EXTENDED_HOURS_NOT_ELIGIBLE");
    addBlocker(blockers, quote?.extendedHoursVerified === true, "US_EXTENDED_HOURS_QUOTE_NOT_VERIFIED");
  }
}

function validateAuctionEvidence({ phase, evidence, evaluatedAtMs }, blockers) {
  const auction = evidence?.auctionEvidence;
  addBlocker(blockers, auction?.available === true, "US_AUCTION_EVIDENCE_REQUIRED");
  addBlocker(blockers, auction?.sourceVerified === true, "US_AUCTION_SOURCE_NOT_VERIFIED");
  addBlocker(blockers, nonEmpty(auction?.source), "US_AUCTION_SOURCE_REQUIRED");
  addBlocker(blockers, auction?.phase === phase, "US_AUCTION_PHASE_MISMATCH");
  addBlocker(blockers, positive(auction?.indicativePrice), "US_AUCTION_PRICE_REQUIRED");
  addBlocker(blockers, nonNegative(auction?.executableQuantity), "US_AUCTION_EXECUTABLE_QUANTITY_REQUIRED");
  validateFreshEvidence(auction, evaluatedAtMs, blockers, "US_AUCTION");
}

export function buildUsStockMicrostructureContext({
  executionContext,
  phase,
  policy,
  evidence,
  evaluatedAtMs,
} = {}) {
  if (!executionContext || executionContext.schemaVersion !== 2) throw new TypeError("valid four-market execution context is required");
  if (executionContext.market !== "US_STOCK") throw new Error("US_STOCK_EXECUTION_CONTEXT_REQUIRED");
  if (executionContext.provider !== "toss") throw new Error("US_STOCK_TOSS_AUTHORITY_REQUIRED");
  if (!finite(evaluatedAtMs)) throw new TypeError("evaluatedAtMs is required");

  const blockers = [];
  addBlocker(blockers, executionContext.status === "READY", "BASE_EXECUTION_CONTEXT_NOT_READY");
  addBlocker(blockers, PHASE_SET.has(phase), "US_MARKET_PHASE_REQUIRED");
  addBlocker(blockers, evidence?.provider === "toss", "US_CANONICAL_PROVIDER_MISMATCH");
  addBlocker(blockers, evidence?.publicOnly === true, "US_PUBLIC_EVIDENCE_REQUIRED");
  addBlocker(blockers, evidence?.dataQuality === "READY", "US_DATA_QUALITY_NOT_READY");
  addBlocker(blockers, evidence?.tradingStatus === "TRADABLE", "US_TRADING_NOT_AVAILABLE");
  addBlocker(blockers, evidence?.session?.phase === phase, "US_SESSION_PHASE_MISMATCH");
  addBlocker(blockers, nonEmpty(evidence?.session?.version), "US_SESSION_VERSION_REQUIRED");
  validateFreshEvidence(evidence, evaluatedAtMs, blockers, "US_MARKET_EVIDENCE");
  validatePolicy(policy, blockers);

  addBlocker(blockers, evidence?.haltEvidence?.known === true, "US_HALT_EVIDENCE_REQUIRED");
  if (evidence?.haltEvidence?.known === true) {
    addBlocker(blockers, evidence.haltEvidence.active !== true, "US_TRADING_HALT_ACTIVE");
  }

  if (CONTINUOUS_PHASES.has(phase)) {
    validateContinuousEvidence({ phase, evidence, policy, evaluatedAtMs }, blockers);
  }
  if (AUCTION_PHASES.has(phase)) {
    validateAuctionEvidence({ phase, evidence, evaluatedAtMs }, blockers);
  }

  const parityPayload = Object.freeze({
    schemaVersion: 1,
    adapterId: US_STOCK_MICROSTRUCTURE_ADAPTER.id,
    adapterVersion: US_STOCK_MICROSTRUCTURE_ADAPTER.version,
    policyVersion: policy?.version ?? null,
    quoteSourcePolicyVersion: policy?.quoteSourcePolicyVersion ?? null,
    premarketMaxParticipationRate: policy?.premarketMaxParticipationRate ?? null,
    regularMaxParticipationRate: policy?.regularMaxParticipationRate ?? null,
    afterHoursMaxParticipationRate: policy?.afterHoursMaxParticipationRate ?? null,
    auctionMaxParticipationRate: policy?.auctionMaxParticipationRate ?? null,
    premarketMaxSpreadRate: policy?.premarketMaxSpreadRate ?? null,
    regularMaxSpreadRate: policy?.regularMaxSpreadRate ?? null,
    afterHoursMaxSpreadRate: policy?.afterHoursMaxSpreadRate ?? null,
  });
  const parityFingerprint = createHash("sha256").update(stableSerialize(parityPayload)).digest("hex");

  return Object.freeze({
    schemaVersion: 1,
    status: blockers.length === 0 ? "READY" : "BLOCKED",
    blockers: Object.freeze([...new Set(blockers)]),
    market: "US_STOCK",
    provider: "toss",
    phase,
    executionContext,
    policy: Object.freeze({ ...(policy ?? {}) }),
    parityPayload,
    parityFingerprint,
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

function capQuantity({ requestedQuantity, availableQuantity, allowPartialFill }) {
  if (!positive(requestedQuantity)) throw new TypeError("positive requestedQuantity is required");
  if (!nonNegative(availableQuantity)) return Object.freeze({ status: "BLOCKED", reason: "US_EXECUTABLE_QUANTITY_REQUIRED" });
  const capped = Math.min(requestedQuantity, availableQuantity);
  if (capped <= 0) return Object.freeze({ status: "PENDING", reason: "US_NO_EXECUTABLE_CAPACITY" });
  if (capped < requestedQuantity && allowPartialFill !== true) {
    return Object.freeze({ status: "PENDING", reason: "US_PARTIAL_FILL_FORBIDDEN" });
  }
  return Object.freeze({ status: "READY", quantity: capped, partial: capped < requestedQuantity });
}

function quoteForAuction(auction) {
  return Object.freeze({
    bid: auction.indicativePrice,
    ask: auction.indicativePrice,
    last: auction.indicativePrice,
    asOfMs: auction.asOfMs,
    maxAgeMs: auction.maxAgeMs,
  });
}

function withAdapterEnvelope(result, context, requestedQuantity, microstructurePartial) {
  const filledQuantity = result.filledQuantity ?? 0;
  const unfilledQuantity = Math.max(0, requestedQuantity - filledQuantity);
  const finalStatus = result.status === "FILLED" && unfilledQuantity > Number.EPSILON ? "PARTIALLY_FILLED" : result.status;
  return Object.freeze({
    ...result,
    status: finalStatus,
    requestedQuantity,
    filledQuantity,
    unfilledQuantity,
    microstructurePartial: microstructurePartial || unfilledQuantity > Number.EPSILON,
    microstructureAdapter: US_STOCK_MICROSTRUCTURE_ADAPTER,
    microstructureParityFingerprint: context.parityFingerprint,
    orderSubmitted: false,
    exchangeRequestSent: false,
    privateTradingRequestSent: false,
    liveExecution: false,
  });
}

export function simulateUsStockMicrostructureFill({
  context,
  order,
  quote = null,
  depth = null,
} = {}) {
  if (!context || context.schemaVersion !== 1 || context.market !== "US_STOCK") {
    throw new TypeError("valid US stock microstructure context is required");
  }
  if (context.status !== "READY") {
    return Object.freeze({
      status: "BLOCKED",
      reason: "US_MICROSTRUCTURE_CONTEXT_NOT_READY",
      blockers: context.blockers,
      orderSubmitted: false,
      exchangeRequestSent: false,
    });
  }
  if (!positive(order?.quantity)) throw new TypeError("positive simulated quantity is required");

  const evidence = context.executionContext?.dataEvidence ?? null;
  const allowPartialFill = context.executionContext.executionPolicy?.allowPartialFill === true;
  let availableQuantity;
  let effectiveQuote = quote;

  if (CONTINUOUS_PHASES.has(context.phase)) {
    const rate = sessionParticipation(context.policy, context.phase);
    availableQuantity = (evidence?.observedVolume ?? 0) * rate;
    if (!effectiveQuote) effectiveQuote = evidence?.quoteEvidence ?? null;
  } else {
    if (order.type === "STOP_MARKET") {
      return Object.freeze({ status: "BLOCKED", reason: "US_STOP_MARKET_FORBIDDEN_DURING_AUCTION", orderSubmitted: false, exchangeRequestSent: false });
    }
    const auction = evidence?.auctionEvidence;
    availableQuantity = (auction?.executableQuantity ?? 0) * sessionParticipation(context.policy, context.phase);
    effectiveQuote = quoteForAuction(auction);
  }

  const capacity = capQuantity({ requestedQuantity: order.quantity, availableQuantity, allowPartialFill });
  if (capacity.status !== "READY") {
    return Object.freeze({ ...capacity, orderSubmitted: false, exchangeRequestSent: false });
  }

  const cappedOrder = Object.freeze({ ...order, quantity: capacity.quantity });
  const result = simulateFourMarketFill({
    context: context.executionContext,
    order: cappedOrder,
    quote: effectiveQuote,
    depth,
  });
  if (!["FILLED", "PARTIALLY_FILLED"].includes(result.status)) {
    return Object.freeze({ ...result, orderSubmitted: false, exchangeRequestSent: false });
  }
  return withAdapterEnvelope(result, context, order.quantity, capacity.partial);
}

export function compareUsStockMicrostructureParity(contexts = []) {
  if (!Array.isArray(contexts) || contexts.length < 2) throw new TypeError("at least two US microstructure contexts are required");
  for (const context of contexts) {
    if (!context || context.schemaVersion !== 1 || context.market !== "US_STOCK") throw new TypeError("valid US microstructure contexts are required");
  }
  const coreParity = compareExecutionStageParity(contexts.map((context) => context.executionContext));
  const reference = contexts[0].parityFingerprint;
  const mismatchedStages = contexts.filter((context) => context.parityFingerprint !== reference).map((context) => context.executionContext.stage);
  const blockedStages = contexts.filter((context) => context.status !== "READY").map((context) => context.executionContext.stage);
  const comparable = coreParity.backtestPaperShadowComparable && mismatchedStages.length === 0 && blockedStages.length === 0;
  return Object.freeze({
    status: comparable ? "READY" : "PERFORMANCE_COMPARISON_BLOCKED",
    reason: comparable ? null : "US_MICROSTRUCTURE_POLICY_MISMATCH",
    coreParity,
    mismatchedStages: Object.freeze(mismatchedStages),
    blockedStages: Object.freeze(blockedStages),
    microstructureParityFingerprint: mismatchedStages.length === 0 ? reference : null,
    backtestPaperShadowComparable: comparable,
    livePromotionAllowed: false,
  });
}
