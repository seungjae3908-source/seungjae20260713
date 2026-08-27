import assert from "node:assert/strict";
import test from "node:test";
import { PaperMockBrokerAdapter, TradeExecutionGateway } from "../src/gateway.mjs";
import { buildBracketPlan } from "../src/order-plans.mjs";
import { PROTECTION_STATES } from "../src/server-failure-protection.mjs";
import { SupervisedPaperGateway } from "../src/supervised-paper-gateway.mjs";

function riskPolicy() {
  return {
    maxQuantityByMarket: { KR_STOCK: 1000, US_STOCK: 1000, CRYPTO_SPOT: 1000, CRYPTO_FUTURES: 1000 },
    maxNotionalByMarket: { KR_STOCK: 10_000_000, US_STOCK: 100_000, CRYPTO_SPOT: 100_000_000, CRYPTO_FUTURES: 100_000 },
  };
}

function order(key = "supervised-order-0001") {
  return {
    mode: "PAPER",
    market: "KR_STOCK",
    symbol: "005930",
    side: "BUY",
    orderType: "LIMIT",
    quantity: 10,
    limitPrice: 70_000,
    idempotencyKey: key,
  };
}

function heartbeat(at = new Date().toISOString()) {
  return { ownerId: "watchdog-a", leaseId: "lease-a", observedAt: at };
}

function supervisionPolicy() {
  return { enforceNewEntryGate: true, heartbeatTimeoutMs: 5_000, maxFutureSkewMs: 1_000 };
}

function buildGateway({ initialPaperState = null, initialProtectionState = null, adapter = new PaperMockBrokerAdapter(), persisted = [] } = {}) {
  const base = new TradeExecutionGateway({ adapter, policy: riskPolicy(), initialPaperState });
  const supervised = new SupervisedPaperGateway({
    gateway: base,
    initialProtectionState,
    supervisionPolicy: supervisionPolicy(),
    persistProtectionState: async (snapshot, reason) => {
      persisted.push({ snapshot: structuredClone(snapshot), reason });
      return { saved: true };
    },
  });
  return { base, supervised, adapter, persisted };
}

test("missing supervisor heartbeat blocks new Paper entry before broker submission", async () => {
  const { supervised, adapter } = buildGateway();
  await assert.rejects(
    supervised.placeOrder(order()),
    (error) => error.code === "UNATTENDED_NEW_ENTRY_BLOCKED" && /SUPERVISOR_HEARTBEAT_MISSING/.test(error.message),
  );
  assert.equal(adapter.submissionCount, 0);
});

test("watchdog loss blocks new exposure but still permits cash SELL and futures reduce-only exits", async () => {
  const { supervised, adapter } = buildGateway();
  const cashExit = await supervised.placeOrder({
    ...order("supervised-exit-cash-0001"),
    side: "SELL",
  });
  await supervised.applyPaperFill(cashExit.orderId, { quantity: 10, price: 70_000, observedAt: new Date().toISOString() });

  const futuresExit = await supervised.placeOrder({
    mode: "PAPER",
    market: "CRYPTO_FUTURES",
    symbol: "BTCUSDT",
    side: "LONG",
    orderType: "LIMIT",
    quantity: 0.01,
    limitPrice: 100_000,
    leverage: 2,
    marginMode: "ISOLATED",
    reduceOnly: true,
    idempotencyKey: "supervised-exit-futures-0001",
  });
  await supervised.applyPaperFill(futuresExit.orderId, { quantity: 0.01, price: 100_000, observedAt: new Date().toISOString() });

  assert.equal(adapter.submissionCount, 2);
  const health = supervised.getProtectionHealth();
  assert.equal(health.newEntryAllowed, false);
  assert.ok(health.blockers.includes("SUPERVISOR_HEARTBEAT_MISSING"));
  assert.equal(health.unprotectedPositions, 0);
  assert.equal(health.emergencyIntents.length, 0);
  assert.equal(health.reductionOrdersExemptFromNewEntryGate, true);
});

test("fresh heartbeat permits first Paper entry but filled unprotected exposure blocks the next entry", async () => {
  const { supervised, adapter } = buildGateway();
  supervised.recordSupervisorHeartbeat(heartbeat());
  const first = await supervised.placeOrder(order());
  await supervised.applyPaperFill(first.orderId, { quantity: 10, price: 69_900, observedAt: new Date().toISOString() });
  const health = supervised.getProtectionHealth();
  assert.equal(health.unprotectedPositions, 1);
  assert.equal(health.newEntryAllowed, false);
  assert.equal(health.emergencyIntents[0].type, "REDUCE_OR_CLOSE_SIMULATION_ONLY");
  await assert.rejects(supervised.placeOrder(order("supervised-order-0002")), (error) => error.code === "UNATTENDED_NEW_ENTRY_BLOCKED");
  assert.equal(adapter.submissionCount, 1);
});

test("durable protection acknowledgement re-enables Paper entries without granting live authority", async () => {
  const { supervised, persisted } = buildGateway();
  supervised.recordSupervisorHeartbeat(heartbeat());
  const first = await supervised.placeOrder(order());
  const filled = await supervised.applyPaperFill(first.orderId, { quantity: 10, price: 69_900, observedAt: new Date().toISOString() });
  const bracket = buildBracketPlan({
    market: "KR_STOCK",
    symbol: "005930",
    side: "BUY",
    quantity: 10,
    entryPrice: filled.averageFillPrice,
    targetPrice: 75_000,
    stopPrice: 68_000,
  });
  const intent = await supervised.registerProtectionIntent(first.orderId, {
    bracketPlan: bracket,
    protectionIdempotencyKey: `protect:${first.orderId}`,
    createdAt: new Date().toISOString(),
  });
  assert.equal(intent.state, PROTECTION_STATES.PENDING_ACK);
  const protectedIntent = await supervised.acknowledgeProtection(first.orderId, {
    entryOrderId: first.orderId,
    protectionIdempotencyKey: intent.protectionIdempotencyKey,
    acknowledgementId: "ack-paper-stop-1",
    protectionOrderId: "paper-stop-1",
    stopPrice: 68_000,
    observedAt: new Date().toISOString(),
    simulated: true,
    durable: true,
    privateApiUsed: false,
  });
  assert.equal(protectedIntent.state, PROTECTION_STATES.PROTECTED);
  const health = supervised.getProtectionHealth();
  assert.equal(health.newEntryAllowed, true);
  assert.equal(health.unattendedLiveEligible, false);
  assert.equal(health.automaticEmergencyExecutionPerformed, false);
  assert.equal(persisted.length, 2);
  const second = await supervised.placeOrder(order("supervised-order-0002"));
  assert.ok(second.orderId);
});

test("restart between filled entry and protection acknowledgement forces reconciliation and never resubmits", async () => {
  const firstSession = buildGateway();
  firstSession.supervised.recordSupervisorHeartbeat(heartbeat());
  const first = await firstSession.supervised.placeOrder(order());
  const filled = await firstSession.supervised.applyPaperFill(first.orderId, { quantity: 10, price: 69_900, observedAt: new Date().toISOString() });
  const bracket = buildBracketPlan({
    market: "KR_STOCK",
    symbol: "005930",
    side: "BUY",
    quantity: 10,
    entryPrice: filled.averageFillPrice,
    targetPrice: 75_000,
    stopPrice: 68_000,
  });
  await firstSession.supervised.registerProtectionIntent(first.orderId, {
    bracketPlan: bracket,
    protectionIdempotencyKey: `protect:${first.orderId}`,
    createdAt: new Date().toISOString(),
  });

  const paperState = firstSession.base.exportPaperState();
  const protectionState = firstSession.supervised.exportProtectionState();
  const restartAdapter = new PaperMockBrokerAdapter();
  const restarted = buildGateway({ initialPaperState: paperState, initialProtectionState: protectionState, adapter: restartAdapter });
  restarted.supervised.recordSupervisorHeartbeat(heartbeat());
  const restored = await restarted.supervised.getOrder(first.orderId);
  assert.equal(restored.serverFailureProtection.state, PROTECTION_STATES.RECONCILIATION_REQUIRED);
  assert.equal(restored.serverFailureProtection.restartReason, "CRASH_OR_RESTART_BEFORE_PROTECTION_ACK");
  const health = restarted.supervised.getProtectionHealth();
  assert.equal(health.newEntryAllowed, false);
  assert.ok(health.blockers.includes(`PROTECTION_RECONCILIATION_REQUIRED:${first.orderId}`));
  assert.equal(restarted.supervised.getRecoveryState().automaticProtectionResubmissions, 0);
  assert.equal(restartAdapter.submissionCount, 0);
});

test("protection state idempotency conflict fails closed on restore", () => {
  const unsafeSnapshot = {
    schemaVersion: 1,
    mode: "PAPER_PROTECTION_ONLY",
    protections: [
      {
        schemaVersion: 1,
        kind: "ENTRY_PROTECTION_INTENT_V1",
        state: PROTECTION_STATES.PENDING_ACK,
        entryOrderId: "a",
        protectionIdempotencyKey: "same-key",
        market: "KR_STOCK",
        symbol: "005930",
        side: "BUY",
        quantity: 1,
        stopPrice: 1,
        targetPrice: 2,
        executionMode: "PAPER_ONLY",
        executionAuthority: "NONE",
        privateApiUsed: false,
        realOrderSubmitted: false,
        unattendedLiveEligible: false,
      },
      {
        schemaVersion: 1,
        kind: "ENTRY_PROTECTION_INTENT_V1",
        state: PROTECTION_STATES.PENDING_ACK,
        entryOrderId: "b",
        protectionIdempotencyKey: "same-key",
        market: "KR_STOCK",
        symbol: "000660",
        side: "BUY",
        quantity: 1,
        stopPrice: 1,
        targetPrice: 2,
        executionMode: "PAPER_ONLY",
        executionAuthority: "NONE",
        privateApiUsed: false,
        realOrderSubmitted: false,
        unattendedLiveEligible: false,
      },
    ],
  };
  assert.throws(
    () => buildGateway({ initialProtectionState: unsafeSnapshot }),
    (error) => error.code === "PROTECTION_STATE_IDEMPOTENCY_CONFLICT",
  );
});
