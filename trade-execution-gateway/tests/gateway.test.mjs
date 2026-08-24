import assert from "node:assert/strict";
import test from "node:test";
import {
  GatewayError,
  PaperMockBrokerAdapter,
  TradeExecutionGateway,
} from "../src/gateway.mjs";
import { SAFETY_CONTRACT } from "../src/contracts.mjs";

function policy() {
  return {
    maxQuantityByMarket: {
      KR_STOCK: 1000,
      US_STOCK: 1000,
      CRYPTO_SPOT: 1000,
      CRYPTO_FUTURES: 1000,
    },
    maxNotionalByMarket: {
      KR_STOCK: 10_000_000,
      US_STOCK: 100_000,
      CRYPTO_SPOT: 100_000_000,
      CRYPTO_FUTURES: 100_000,
    },
  };
}

function krLimit(overrides = {}) {
  return {
    mode: "PAPER",
    market: "KR_STOCK",
    symbol: "005930",
    side: "BUY",
    orderType: "LIMIT",
    quantity: 10,
    limitPrice: 70_000,
    idempotencyKey: "test-order-0001",
    ...overrides,
  };
}

test("safety contract permanently denies live/private execution in v0.1", () => {
  assert.equal(SAFETY_CONTRACT.executionMode, "PAPER_ONLY");
  assert.equal(SAFETY_CONTRACT.liveTrading, false);
  assert.equal(SAFETY_CONTRACT.realOrderEnabled, false);
  assert.equal(SAFETY_CONTRACT.privateTradingApiAllowed, false);
  assert.equal(SAFETY_CONTRACT.outboundNetwork, false);
  assert.equal(SAFETY_CONTRACT.productionIntegrated, false);
});

test("preview validates risk without submitting even a paper order", async () => {
  const adapter = new PaperMockBrokerAdapter();
  const gateway = new TradeExecutionGateway({ adapter, policy: policy() });
  const result = await gateway.previewOrder(krLimit());

  assert.equal(result.accepted, true);
  assert.equal(result.orderSubmitted, false);
  assert.equal(result.realOrderSubmitted, false);
  assert.equal(result.risk.notional, 700_000);
  assert.equal(adapter.submissionCount, 0);
});

test("live mode is rejected before adapter submission", async () => {
  const adapter = new PaperMockBrokerAdapter();
  const gateway = new TradeExecutionGateway({ adapter, policy: policy() });

  await assert.rejects(
    gateway.placeOrder(krLimit({ mode: "LIVE" })),
    (error) => error instanceof GatewayError && error.code === "LIVE_TRADING_DISABLED",
  );
  assert.equal(adapter.submissionCount, 0);
});

test("cash and futures side contracts fail closed", async () => {
  const gateway = new TradeExecutionGateway({ policy: policy() });

  await assert.rejects(
    gateway.previewOrder(krLimit({ side: "LONG" })),
    (error) => error.code === "UNSUPPORTED_SIDE",
  );

  await assert.rejects(
    gateway.previewOrder({
      ...krLimit(),
      market: "CRYPTO_FUTURES",
      symbol: "BTCUSDT",
      side: "BUY",
    }),
    (error) => error.code === "UNSUPPORTED_SIDE",
  );
});

test("missing or exceeded risk limits block paper submission", async () => {
  const adapter = new PaperMockBrokerAdapter();
  const unconfigured = new TradeExecutionGateway({ adapter, policy: {} });
  await assert.rejects(
    unconfigured.placeOrder(krLimit()),
    (error) => error.code === "RISK_POLICY_NOT_CONFIGURED",
  );

  const configured = new TradeExecutionGateway({ adapter, policy: policy() });
  await assert.rejects(
    configured.placeOrder(krLimit({ quantity: 1000, limitPrice: 70_000 })),
    (error) => error.code === "MAX_NOTIONAL_EXCEEDED",
  );
  assert.equal(adapter.submissionCount, 0);
});

test("idempotency prevents duplicate paper submissions", async () => {
  const adapter = new PaperMockBrokerAdapter();
  const gateway = new TradeExecutionGateway({ adapter, policy: policy() });

  const first = await gateway.placeOrder(krLimit());
  const second = await gateway.placeOrder(krLimit());

  assert.equal(first.orderId, second.orderId);
  assert.equal(first.brokerOrderId, second.brokerOrderId);
  assert.equal(adapter.submissionCount, 1);
  assert.equal(first.realOrderSubmitted, false);
  assert.equal(first.privateTradingRequestSent, false);
});

test("paper order can be canceled without creating live authority", async () => {
  const gateway = new TradeExecutionGateway({ policy: policy() });
  const order = await gateway.placeOrder(krLimit());
  const canceled = await gateway.cancelOrder(order.orderId);

  assert.equal(canceled.status, "CANCELED");
  assert.equal(canceled.simulated, true);
  assert.equal(canceled.realOrderSubmitted, false);
  assert.equal(canceled.privateTradingRequestSent, false);
});

test("unsafe adapter is rejected at construction", () => {
  const unsafeAdapter = {
    getCapabilities() {
      return {
        executionMode: "LIVE",
        liveTrading: true,
        privateTradingApiAllowed: true,
        outboundNetwork: true,
      };
    },
    previewOrder() {},
    submitOrder() {},
    cancelOrder() {},
    getOrder() {},
  };

  assert.throws(
    () => new TradeExecutionGateway({ adapter: unsafeAdapter, policy: policy() }),
    (error) => error instanceof GatewayError && error.code === "UNSAFE_ADAPTER_REJECTED",
  );
});
