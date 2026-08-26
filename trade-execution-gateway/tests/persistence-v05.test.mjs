import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FilePaperStateStore } from "../src/paper-state-store.mjs";
import { PaperMockBrokerAdapter, TradeExecutionGateway } from "../src/gateway.mjs";

function policy() {
  return {
    maxQuantityByMarket: { KR_STOCK: 100 },
    maxNotionalByMarket: { KR_STOCK: 100_000_000 },
  };
}

function intent(key = "v05-persist-order-0001") {
  return {
    mode: "PAPER",
    market: "KR_STOCK",
    symbol: "005930",
    side: "BUY",
    orderType: "LIMIT",
    quantity: 3,
    limitPrice: 70_000,
    idempotencyKey: key,
  };
}

test("v0.5 durable Paper OMS survives restart and preserves idempotency without resubmission", async () => {
  const dir = await mkdtemp(join(tmpdir(), "teg-v05-"));
  try {
    const path = join(dir, "paper-state.json");
    const store1 = new FilePaperStateStore(path);
    const adapter1 = new PaperMockBrokerAdapter();
    const gateway1 = new TradeExecutionGateway({
      adapter: adapter1,
      policy: policy(),
      initialPaperState: await store1.load(),
      persistPaperState: (snapshot, reason) => store1.save(snapshot, reason),
    });
    const placed = await gateway1.placeOrder(intent());
    assert.equal(adapter1.submissionCount, 1);

    const store2 = new FilePaperStateStore(path);
    const adapter2 = new PaperMockBrokerAdapter();
    const gateway2 = new TradeExecutionGateway({
      adapter: adapter2,
      policy: policy(),
      initialPaperState: await store2.load(),
      persistPaperState: (snapshot, reason) => store2.save(snapshot, reason),
    });
    const replay = await gateway2.placeOrder(intent());
    assert.equal(replay.orderId, placed.orderId);
    assert.equal(adapter2.submissionCount, 0);
    assert.equal(gateway2.getRecoveryState().restoredOrders, 1);

    const partial = await gateway2.applyPaperFill(placed.orderId, {
      quantity: 1,
      price: 69_900,
      observedAt: "2026-08-24T11:00:00.000Z",
    });
    assert.equal(partial.status, "PARTIALLY_FILLED");

    const store3 = new FilePaperStateStore(path);
    const gateway3 = new TradeExecutionGateway({
      adapter: new PaperMockBrokerAdapter(),
      policy: policy(),
      initialPaperState: await store3.load(),
      persistPaperState: (snapshot, reason) => store3.save(snapshot, reason),
    });
    const restored = await gateway3.getOrder(placed.orderId);
    assert.equal(restored.status, "PARTIALLY_FILLED");
    assert.equal(restored.filledQuantity, 1);
    const canceled = await gateway3.cancelOrder(placed.orderId);
    assert.equal(canceled.status, "CANCELED");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("v0.5 corrupted durable state fails closed instead of silently resetting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "teg-v05-corrupt-"));
  try {
    const path = join(dir, "paper-state.json");
    const store = new FilePaperStateStore(path);
    const gateway = new TradeExecutionGateway({
      policy: policy(),
      initialPaperState: await store.load(),
      persistPaperState: (snapshot, reason) => store.save(snapshot, reason),
    });
    await gateway.placeOrder(intent("v05-corrupt-order-0001"));
    const document = JSON.parse(await readFile(path, "utf8"));
    document.orders[0].status = "FILLED";
    await writeFile(path, JSON.stringify(document), "utf8");
    const reopened = new FilePaperStateStore(path);
    await assert.rejects(reopened.load(), (error) => error.code === "PAPER_STATE_CHECKSUM_MISMATCH");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("v0.5 unsafe restored state is rejected and interrupted orders are never auto-resubmitted", async () => {
  const unsafe = {
    schemaVersion: 1,
    mode: "PAPER_ONLY",
    orders: [{
      orderId: "teg-unsafe",
      status: "ACCEPTED",
      simulated: true,
      realOrderSubmitted: true,
      privateTradingRequestSent: false,
      intent: intent("v05-unsafe-order-0001"),
    }],
    idempotency: [["v05-unsafe-order-0001", "teg-unsafe"]],
  };
  assert.throws(
    () => new TradeExecutionGateway({ policy: policy(), initialPaperState: unsafe }),
    (error) => error.code === "UNSAFE_PAPER_STATE_REJECTED",
  );

  const interruptedIntent = intent("v05-interrupted-order-0001");
  const interrupted = {
    schemaVersion: 1,
    mode: "PAPER_ONLY",
    orders: [{
      orderId: "teg-interrupted",
      status: "RISK_ACCEPTED",
      simulated: true,
      realOrderSubmitted: false,
      privateTradingRequestSent: false,
      createdAt: "2026-08-24T11:00:00.000Z",
      intent: interruptedIntent,
      risk: { accepted: true, notional: 210_000, riskPrice: 70_000 },
    }],
    idempotency: [[interruptedIntent.idempotencyKey, "teg-interrupted"]],
  };
  const adapter = new PaperMockBrokerAdapter();
  const gateway = new TradeExecutionGateway({ adapter, policy: policy(), initialPaperState: interrupted });
  const restored = await gateway.placeOrder(interruptedIntent);
  assert.equal(restored.orderId, "teg-interrupted");
  assert.equal(restored.recoveryHold, true);
  assert.equal(adapter.submissionCount, 0);
  assert.equal(gateway.getRecoveryState().interruptedOrders, 1);
  assert.equal(gateway.getRecoveryState().automaticResubmissions, 0);
});
