import { GatewayError } from "./gateway.mjs";
import { normalizePublicMarketDataEvidence } from "./market-data-evidence.mjs";

const BUY_LIKE = new Set(["BUY", "LONG"]);
const SELL_LIKE = new Set(["SELL", "SHORT"]);

function positive(value, code, message) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new GatewayError(code, message);
  return number;
}

function nonNegative(value, code, message) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new GatewayError(code, message);
  return number;
}

function executionPolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new GatewayError("EXECUTION_GUARD_POLICY_REQUIRED", "execution guard policy is required");
  }
  if (typeof policy.requireFullDepth !== "boolean") {
    throw new GatewayError("EXECUTION_GUARD_POLICY_REQUIRED", "requireFullDepth must be explicitly configured");
  }
  return Object.freeze({
    maxSpreadBps: nonNegative(policy.maxSpreadBps, "EXECUTION_GUARD_POLICY_REQUIRED", "maxSpreadBps must be non-negative"),
    maxPriceDeviationBps: nonNegative(policy.maxPriceDeviationBps, "EXECUTION_GUARD_POLICY_REQUIRED", "maxPriceDeviationBps must be non-negative"),
    maxSlippageBps: nonNegative(policy.maxSlippageBps, "EXECUTION_GUARD_POLICY_REQUIRED", "maxSlippageBps must be non-negative"),
    requireFullDepth: policy.requireFullDepth,
    marketData: { ...(policy.marketData ?? {}), requireTrade: true },
  });
}

function orderContext(intent) {
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) throw new GatewayError("INVALID_EXECUTION_INTENT", "execution intent is required");
  const side = String(intent.side ?? "").toUpperCase();
  if (!BUY_LIKE.has(side) && !SELL_LIKE.has(side)) throw new GatewayError("INVALID_EXECUTION_SIDE", "execution guard requires BUY/SELL/LONG/SHORT");
  const orderType = String(intent.orderType ?? "").toUpperCase();
  if (!new Set(["LIMIT", "MARKET"]).has(orderType)) throw new GatewayError("INVALID_EXECUTION_ORDER_TYPE", "execution guard requires LIMIT or MARKET");
  const quantity = positive(intent.quantity, "INVALID_EXECUTION_QUANTITY", "execution quantity must be positive");
  const proposedPrice = orderType === "LIMIT"
    ? positive(intent.limitPrice, "INVALID_EXECUTION_PRICE", "LIMIT requires limitPrice")
    : positive(intent.referencePrice, "INVALID_EXECUTION_PRICE", "MARKET requires referencePrice");
  const market = String(intent.market ?? "").toUpperCase();
  const symbol = String(intent.symbol ?? "").trim().toUpperCase();
  if (!market || !symbol) throw new GatewayError("INVALID_EXECUTION_INTENT", "market and symbol are required");
  return { side, orderType, quantity, proposedPrice, market, symbol };
}

function sweepDepth(context, evidence) {
  const buyLike = BUY_LIKE.has(context.side);
  const levels = buyLike ? evidence.asks : evidence.bids;
  let remaining = context.quantity;
  let filled = 0;
  let notional = 0;
  for (const level of levels) {
    if (context.orderType === "LIMIT") {
      if (buyLike && level.price > context.proposedPrice) break;
      if (!buyLike && level.price < context.proposedPrice) break;
    }
    const take = Math.min(remaining, level.size);
    if (take <= 0) continue;
    filled += take;
    notional += take * level.price;
    remaining -= take;
    if (remaining <= 1e-12) break;
  }
  const averageFillPrice = filled > 0 ? notional / filled : null;
  const bestExecutablePrice = buyLike ? evidence.bestAsk : evidence.bestBid;
  let slippageBps = null;
  if (averageFillPrice !== null) {
    const adverse = buyLike ? (averageFillPrice - bestExecutablePrice) / bestExecutablePrice : (bestExecutablePrice - averageFillPrice) / bestExecutablePrice;
    slippageBps = Math.max(0, adverse * 10_000);
  }
  return Object.freeze({
    requestedQuantity: context.quantity,
    estimatedFillQuantity: filled,
    estimatedRemainingQuantity: Math.max(0, context.quantity - filled),
    fullDepthAvailable: remaining <= 1e-12,
    averageFillPrice,
    bestExecutablePrice,
    slippageBps,
  });
}

function assessNormalized(context, evidence, guardPolicy, evidenceTrust) {
  if (context.market !== evidence.market || context.symbol !== evidence.symbol) {
    throw new GatewayError("EXECUTION_EVIDENCE_IDENTITY_MISMATCH", "public market evidence must match exact market and symbol");
  }
  const spreadBps = ((evidence.bestAsk - evidence.bestBid) / evidence.midPrice) * 10_000;
  const priceDeviationBps = Math.abs(context.proposedPrice - evidence.midPrice) / evidence.midPrice * 10_000;
  const depth = sweepDepth(context, evidence);
  const blockers = [];
  if (spreadBps > guardPolicy.maxSpreadBps) blockers.push("SPREAD_TOO_WIDE");
  if (priceDeviationBps > guardPolicy.maxPriceDeviationBps) blockers.push("PRICE_DEVIATION_EXCEEDED");
  if (depth.estimatedFillQuantity <= 0) blockers.push("NO_EXECUTABLE_PUBLIC_DEPTH");
  if (guardPolicy.requireFullDepth && !depth.fullDepthAvailable) blockers.push("INSUFFICIENT_PUBLIC_DEPTH");
  if (depth.slippageBps !== null && depth.slippageBps > guardPolicy.maxSlippageBps) blockers.push("SLIPPAGE_TOO_HIGH");
  return Object.freeze({
    state: blockers.length === 0 ? "PASS" : "BLOCKED",
    blockers: Object.freeze(blockers),
    publicEvidence: evidence,
    evidenceTrust,
    paperDecisionSupportOnly: true,
    metrics: Object.freeze({ spreadBps, priceDeviationBps, ...depth }),
    thresholds: guardPolicy,
    orderSubmissionAllowed: false,
    liveAuthorityGranted: false,
    privateTradingRequestAllowed: false,
  });
}

function revalidateAttestedEvidence(evidence, marketDataPolicy) {
  if (
    !evidence ||
    evidence.serverAttested !== true ||
    evidence.transportObservedByGateway !== true ||
    evidence.callerSuppliedEvidence !== false ||
    evidence.liveExecutionEligible !== false
  ) {
    throw new GatewayError("SERVER_ATTESTED_PUBLIC_EVIDENCE_REQUIRED", "runtime execution guard requires gateway-observed public market data");
  }
  const normalized = normalizePublicMarketDataEvidence({
    market: evidence.market,
    provider: evidence.provider,
    source: evidence.source,
    symbol: evidence.symbol,
    quoteObservedAt: evidence.quoteObservedAt,
    tradeObservedAt: evidence.tradeObservedAt,
    lastTradePrice: evidence.lastTradePrice,
    bids: evidence.bids,
    asks: evidence.asks,
    providerSequence: evidence.providerSequence,
    providerChecksum: evidence.providerChecksum,
  }, marketDataPolicy);
  return Object.freeze({
    ...normalized,
    authority: evidence.authority,
    callerSuppliedEvidence: false,
    serverAttested: true,
    transportObservedByGateway: true,
    paperDecisionSupportEligible: true,
    liveExecutionEligible: false,
    outboundNetworkPerformed: true,
    privateApiUsed: false,
    transport: evidence.transport ?? null,
  });
}

export function assessExecutionGuards({ intent, marketData, policy }) {
  const guardPolicy = executionPolicy(policy);
  const context = orderContext(intent);
  const evidence = normalizePublicMarketDataEvidence(marketData, guardPolicy.marketData);
  return assessNormalized(context, evidence, guardPolicy, "CALLER_SUPPLIED_UNATTESTED");
}

export function assessAttestedExecutionGuards({ intent, evidence, policy }) {
  const guardPolicy = executionPolicy(policy);
  const context = orderContext(intent);
  const attested = revalidateAttestedEvidence(evidence, guardPolicy.marketData);
  return assessNormalized(context, attested, guardPolicy, "GATEWAY_TRANSPORT_OBSERVED_PUBLIC");
}
