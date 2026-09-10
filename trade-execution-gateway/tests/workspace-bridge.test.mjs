import assert from "node:assert/strict";
import test from "node:test";
import { PaperMockBrokerAdapter, TradeExecutionGateway } from "../src/gateway.mjs";
import {
  placeWorkspacePaperOrder,
  previewWorkspaceOrder,
  workspaceOrderToPaperIntent,
} from "../src/workspace-bridge.mjs";

function policy() {
  return {
    maxQuantityByMarket: { KR_STOCK: 1000, US_STOCK: 1000 },
    maxNotionalByMarket: { KR_STOCK: 10_000_000, US_STOCK: 1_000_000 },
  };
}

function workspaceLimit(overrides = {}) {
  return {
    order: {
      side: "buy",
      orderType: "limit",
      quantity: 10,
      price: 70_000,
      ticker: "005930",
      displayName: "삼성전자",
      market: "KR",
      ...overrides,
    },
    idempotencyKey: "workspace-test-0001",
  };
}

test("legacy workspace KR limit shape maps to canonical PAPER intent", () => {
  const intent = workspaceOrderToPaperIntent(workspaceLimit());
  assert.deepEqual(intent, {
    mode: "PAPER",
    market: "KR_STOCK",
    symbol: "005930",
    side: "BUY",
    orderType: "LIMIT",
    quantity: 10,
    limitPrice: 70_000,
    referencePrice: null,
    idempotencyKey: "workspace-test-0001",
  });
});

test("workspace preview never submits to the paper adapter", async () => {
  const adapter = new PaperMockBrokerAdapter();
  const gateway = new TradeExecutionGateway({ adapter, policy: policy() });
  const result = await previewWorkspaceOrder(gateway, workspaceLimit());
  assert.equal(result.accepted, true);
  assert.equal(result.workspaceOrderSubmitted, false);
  assert.equal(result.realOrderSubmitted, false);
  assert.equal(result.privateTradingRequestSent, false);
  assert.equal(adapter.submissionCount, 0);
});

test("workspace US sell stays cash SELL instead of creating short semantics", () => {
  const intent = workspaceOrderToPaperIntent(workspaceLimit({
    market: "US",
    ticker: "AAPL",
    side: "sell",
    price: 210,
  }));
  assert.equal(intent.market, "US_STOCK");
  assert.equal(intent.side, "SELL");
  assert.equal(intent.symbol, "AAPL");
});

test("workspace market order requires explicit reference price and never invents one", () => {
  assert.throws(
    () => workspaceOrderToPaperIntent(workspaceLimit({ orderType: "market", price: null })),
    (error) => error.code === "WORKSPACE_REFERENCE_PRICE_REQUIRED",
  );

  const intent = workspaceOrderToPaperIntent({
    ...workspaceLimit({ orderType: "market", price: null }),
    referencePrice: 71_000,
  });
  assert.equal(intent.orderType, "MARKET");
  assert.equal(intent.limitPrice, null);
  assert.equal(intent.referencePrice, 71_000);
});

test("workspace bridge rejects unsupported markets instead of guessing", () => {
  assert.throws(
    () => workspaceOrderToPaperIntent(workspaceLimit({ market: "CRYPTO" })),
    (error) => error.code === "UNSUPPORTED_WORKSPACE_MARKET",
  );
});

test("workspace OMS paper recording requires explicit second confirmation", async () => {
  const adapter = new PaperMockBrokerAdapter();
  const gateway = new TradeExecutionGateway({ adapter, policy: policy() });

  await assert.rejects(
    placeWorkspacePaperOrder(gateway, workspaceLimit()),
    (error) => error.code === "PAPER_CONFIRMATION_REQUIRED",
  );
  assert.equal(adapter.submissionCount, 0);

  const result = await placeWorkspacePaperOrder(gateway, {
    ...workspaceLimit(),
    confirmPaper: true,
  });
  assert.equal(result.simulated, true);
  assert.equal(result.paperConfirmation, "EXPLICIT");
  assert.equal(result.realOrderSubmitted, false);
  assert.equal(result.privateTradingRequestSent, false);
  assert.equal(adapter.submissionCount, 1);
});
