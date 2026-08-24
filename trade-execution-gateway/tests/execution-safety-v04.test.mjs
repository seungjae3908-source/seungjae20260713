import assert from "node:assert/strict";
import test from "node:test";
import { SAFETY_CONTRACT, publicContract } from "../src/contracts.mjs";
import { assessExecutionGuards } from "../src/execution-guards.mjs";
import { normalizePublicMarketDataEvidence } from "../src/market-data-evidence.mjs";
import { PaperMockBrokerAdapter, TradeExecutionGateway } from "../src/gateway.mjs";
import { buildBracketPlan, buildCancelReplacePlan, buildTrailingPlan } from "../src/order-plans.mjs";

const NOW = Date.parse("2026-08-24T10:00:00.000Z");

function dataPolicy(overrides = {}) {
  return { maxQuoteAgeMs: 2_000, maxTradeAgeMs: 2_000, maxFutureSkewMs: 100, requireTrade: true, nowMs: NOW, ...overrides };
}
function spotEvidence(overrides = {}) {
  return {
    market: "CRYPTO_SPOT", provider: "upbit", source: "UPBIT_PUBLIC_WEBSOCKET", symbol: "KRW-BTC",
    quoteObservedAt: NOW - 100, tradeObservedAt: NOW - 120, lastTradePrice: 100,
    bids: [{ price: 99.9, size: 2 }, { price: 99.8, size: 5 }],
    asks: [{ price: 100.1, size: 2 }, { price: 100.2, size: 5 }],
    ...overrides,
  };
}
function guardPolicy(overrides = {}) {
  return { marketData: dataPolicy(), maxSpreadBps: 30, maxPriceDeviationBps: 40, maxSlippageBps: 20, requireFullDepth: true, ...overrides };
}
function spotIntent(overrides = {}) {
  return { market: "CRYPTO_SPOT", symbol: "KRW-BTC", side: "BUY", orderType: "MARKET", quantity: 1, referencePrice: 100, ...overrides };
}
function paperPolicy() {
  return { maxQuantityByMarket: { KR_STOCK: 1_000 }, maxNotionalByMarket: { KR_STOCK: 100_000_000 } };
}
function krPaperOrder(overrides = {}) {
  return { mode: "PAPER", market: "KR_STOCK", symbol: "005930", side: "BUY", orderType: "LIMIT", quantity: 2, limitPrice: 70_000, idempotencyKey: "v04-default-paper-0001", ...overrides };
}

test("v0.6 preserves v0.5 paper-only and zero-private-authority safety", () => {
  assert.equal(SAFETY_CONTRACT.version, "0.6.0");
  assert.equal(SAFETY_CONTRACT.executionMode, "PAPER_ONLY");
  assert.equal(SAFETY_CONTRACT.liveTrading, false);
  assert.equal(SAFETY_CONTRACT.privateTradingApiAllowed, false);
  assert.equal(SAFETY_CONTRACT.outboundNetwork, false);
  assert.equal(SAFETY_CONTRACT.publicMarketDataOutboundDefault, false);
  const contract = publicContract();
  assert.equal(contract.executionSafety.publicWebSocketDefaultEnabled, false);
  assert.equal(contract.executionSafety.serverAttestedMarketDataAvailableOnlyWhenRuntimeEnabled, true);
  assert.equal(contract.executionSafety.liveExecutionEligibleMarketData, false);
  assert.equal(contract.persistence.automaticInterruptedOrderResubmission, false);
});

test("fresh Upbit caller-supplied public evidence remains unattested", () => {
  const evidence = normalizePublicMarketDataEvidence(spotEvidence(), dataPolicy());
  assert.equal(evidence.provider, "upbit");
  assert.equal(evidence.bestBid, 99.9);
  assert.equal(evidence.bestAsk, 100.1);
  assert.equal(evidence.callerSuppliedEvidence, true);
  assert.equal(evidence.serverAttested, false);
  assert.equal(evidence.transportObservedByGateway, false);
  assert.equal(evidence.liveExecutionEligible, false);
  assert.equal(evidence.privateApiUsed, false);
  assert.equal(evidence.outboundNetworkPerformed, false);
});

test("provider mismatch, stale quote and crossed book fail closed", () => {
  assert.throws(() => normalizePublicMarketDataEvidence(spotEvidence({ provider: "bitget" }), dataPolicy()), (error) => error.code === "PUBLIC_MARKET_DATA_PROVIDER_MISMATCH");
  assert.throws(() => normalizePublicMarketDataEvidence(spotEvidence({ quoteObservedAt: NOW - 5_000 }), dataPolicy()), (error) => error.code === "STALE_PUBLIC_QUOTE");
  assert.throws(() => normalizePublicMarketDataEvidence(spotEvidence({ bids: [{ price: 100.2, size: 1 }] }), dataPolicy()), (error) => error.code === "CROSSED_PUBLIC_BOOK");
});

test("future and stale public trade evidence fail closed", () => {
  assert.throws(() => normalizePublicMarketDataEvidence(spotEvidence({ tradeObservedAt: NOW + 500 }), dataPolicy()), (error) => error.code === "FUTURE_PUBLIC_TRADE");
  assert.throws(() => normalizePublicMarketDataEvidence(spotEvidence({ tradeObservedAt: NOW - 5_000 }), dataPolicy()), (error) => error.code === "STALE_PUBLIC_TRADE");
});

test("execution guard passes bounded caller evidence but remains Paper decision support only", () => {
  const result = assessExecutionGuards({ intent: spotIntent(), marketData: spotEvidence(), policy: guardPolicy() });
  assert.equal(result.state, "PASS");
  assert.equal(result.blockers.length, 0);
  assert.equal(result.metrics.fullDepthAvailable, true);
  assert.equal(result.evidenceTrust, "CALLER_SUPPLIED_UNATTESTED");
  assert.equal(result.paperDecisionSupportOnly, true);
  assert.equal(result.orderSubmissionAllowed, false);
});

test("wide spread and fat-finger price deviation are explicit blockers", () => {
  const wide = assessExecutionGuards({ intent: spotIntent(), marketData: spotEvidence({ bids: [{ price: 99, size: 3 }], asks: [{ price: 101, size: 3 }] }), policy: guardPolicy({ maxSpreadBps: 50 }) });
  assert.ok(wide.blockers.includes("SPREAD_TOO_WIDE"));
  const deviated = assessExecutionGuards({ intent: spotIntent({ referencePrice: 105 }), marketData: spotEvidence(), policy: guardPolicy({ maxPriceDeviationBps: 100 }) });
  assert.ok(deviated.blockers.includes("PRICE_DEVIATION_EXCEEDED"));
});

test("insufficient public depth and slippage fail closed", () => {
  const shallow = assessExecutionGuards({ intent: spotIntent({ quantity: 10 }), marketData: spotEvidence(), policy: guardPolicy() });
  assert.ok(shallow.blockers.includes("INSUFFICIENT_PUBLIC_DEPTH"));
  const slipped = assessExecutionGuards({ intent: spotIntent({ quantity: 4 }), marketData: spotEvidence({ asks: [{ price: 100.1, size: 1 }, { price: 101, size: 5 }] }), policy: guardPolicy({ maxSlippageBps: 10, maxSpreadBps: 100 }) });
  assert.ok(slipped.blockers.includes("SLIPPAGE_TOO_HIGH"));
});

test("paper OMS supports ACCEPTED -> PARTIALLY_FILLED -> FILLED only", async () => {
  const gateway = new TradeExecutionGateway({ adapter: new PaperMockBrokerAdapter(), policy: paperPolicy() });
  const order = await gateway.placeOrder({ ...krPaperOrder(), quantity: 10, idempotencyKey: "v04-fill-test-0001" });
  const partial = await gateway.applyPaperFill(order.orderId, { quantity: 4, price: 69_900, observedAt: "2026-08-24T10:00:00.000Z" });
  assert.equal(partial.status, "PARTIALLY_FILLED");
  assert.equal(partial.filledQuantity, 4);
  assert.equal(partial.remainingQuantity, 6);
  const filled = await gateway.applyPaperFill(order.orderId, { quantity: 6, price: 70_000, observedAt: "2026-08-24T10:00:01.000Z" });
  assert.equal(filled.status, "FILLED");
  assert.equal(filled.remainingQuantity, 0);
  assert.equal(filled.actualExchangeFillEvidence, null);
});

test("paper LIMIT fills reject prices worse than the limit", async () => {
  const gateway = new TradeExecutionGateway({ policy: paperPolicy() });
  const buy = await gateway.placeOrder(krPaperOrder({ idempotencyKey: "v04-limit-buy-0001" }));
  await assert.rejects(gateway.applyPaperFill(buy.orderId, { quantity: 1, price: 70_001, observedAt: "2026-08-24T10:00:00Z" }), (error) => error.code === "PAPER_FILL_LIMIT_VIOLATION");
  const sell = await gateway.placeOrder(krPaperOrder({ side: "SELL", idempotencyKey: "v04-limit-sell-0001" }));
  await assert.rejects(gateway.applyPaperFill(sell.orderId, { quantity: 1, price: 69_999, observedAt: "2026-08-24T10:00:00Z" }), (error) => error.code === "PAPER_FILL_LIMIT_VIOLATION");
});

test("paper overfill and fill-after-terminal are rejected", async () => {
  const gateway = new TradeExecutionGateway({ policy: paperPolicy() });
  const order = await gateway.placeOrder(krPaperOrder({ idempotencyKey: "v04-fill-test-0002" }));
  await assert.rejects(gateway.applyPaperFill(order.orderId, { quantity: 3, price: 70_000, observedAt: "2026-08-24T10:00:00Z" }), (error) => error.code === "PAPER_OVERFILL_REJECTED");
  await gateway.applyPaperFill(order.orderId, { quantity: 2, price: 70_000, observedAt: "2026-08-24T10:00:00Z" });
  await assert.rejects(gateway.applyPaperFill(order.orderId, { quantity: 1, price: 70_000, observedAt: "2026-08-24T10:00:01Z" }), (error) => error.code === "INVALID_PAPER_FILL_TRANSITION");
  await assert.rejects(gateway.cancelOrder(order.orderId), (error) => error.code === "ORDER_NOT_CANCELABLE");
});

test("cancel/replace is planning-only and preserves exact order identity", async () => {
  const gateway = new TradeExecutionGateway({ policy: paperPolicy() });
  const order = await gateway.placeOrder(krPaperOrder({ idempotencyKey: "v04-replace-old-0001" }));
  const plan = buildCancelReplacePlan({ order, replacementIntent: { ...order.intent, limitPrice: 69_900, idempotencyKey: "v04-replace-new-0001" } });
  assert.equal(plan.executionAuthority, "NONE");
  assert.equal(plan.automaticCancelPerformed, false);
  assert.equal(plan.replacementSubmitted, false);
  assert.equal(plan.requiresExplicitConfirmation, true);
});

test("cancel/replace cannot flip side or exceed remaining partial quantity", async () => {
  const gateway = new TradeExecutionGateway({ policy: paperPolicy() });
  const order = await gateway.placeOrder(krPaperOrder({ quantity: 5, idempotencyKey: "v04-replace-partial-old-0001" }));
  const partial = await gateway.applyPaperFill(order.orderId, { quantity: 2, price: 70_000, observedAt: "2026-08-24T10:00:00Z" });
  assert.throws(() => buildCancelReplacePlan({ order: partial, replacementIntent: { ...partial.intent, side: "SELL", quantity: 3, idempotencyKey: "v04-replace-side-new-0001" } }), (error) => error.code === "REPLACEMENT_SIDE_MISMATCH");
  assert.throws(() => buildCancelReplacePlan({ order: partial, replacementIntent: { ...partial.intent, quantity: 4, idempotencyKey: "v04-replace-too-large-0001" } }), (error) => error.code === "REPLACEMENT_QUANTITY_EXCEEDS_REMAINING");
  const valid = buildCancelReplacePlan({ order: partial, replacementIntent: { ...partial.intent, quantity: 3, limitPrice: 69_900, idempotencyKey: "v04-replace-valid-new-0001" } });
  assert.equal(valid.originalFilledQuantity, 2);
  assert.equal(valid.originalRemainingQuantity, 3);
  assert.equal(valid.replacementQuantity, 3);
});

test("bracket OCO validates long and short price geometry without submitting children", () => {
  const longPlan = buildBracketPlan({ market: "CRYPTO_FUTURES", symbol: "BTCUSDT", side: "LONG", quantity: 0.01, entryPrice: 100_000, targetPrice: 104_000, stopPrice: 98_000 });
  assert.equal(longPlan.childOrderState, "INACTIVE_UNTIL_ENTRY_FILLED");
  assert.equal(longPlan.childOrdersSubmitted, false);
  assert.equal(longPlan.ocoMutualCancelIntent, true);
  assert.throws(() => buildBracketPlan({ market: "CRYPTO_FUTURES", symbol: "BTCUSDT", side: "SHORT", quantity: 0.01, entryPrice: 100_000, targetPrice: 104_000, stopPrice: 98_000 }), (error) => error.code === "INVALID_BRACKET_PRICES");
});

test("trailing stop remains an inactive plan requiring future public prices", () => {
  const plan = buildTrailingPlan({ market: "CRYPTO_SPOT", symbol: "KRW-BTC", side: "BUY", activationPrice: 105_000_000, trailPercent: 1.5 });
  assert.equal(plan.runtimeActivation, false);
  assert.equal(plan.requiresFutureObservedPublicPrice, true);
  assert.equal(plan.orderSubmitted, false);
  assert.equal(plan.executionAuthority, "NONE");
});
