import assert from "node:assert/strict";
import test from "node:test";
import {
  PROTECTION_STATES,
  PAPER_MOCK_PROTECTION_CAPABILITIES,
  ServerFailureProtectionError,
  acknowledgePaperProtection,
  assessUnattendedProtection,
  buildProtectionIntent,
  evaluateProviderNativeProtectionReadiness,
  reconcileProtectionEvidence,
  recoverProtectionAfterRestart,
} from "../src/server-failure-protection.mjs";

function entry(overrides = {}) {
  return {
    orderId: "teg-entry-1",
    status: "FILLED",
    simulated: true,
    realOrderSubmitted: false,
    privateTradingRequestSent: false,
    filledQuantity: 10,
    intent: { market: "KR_STOCK", symbol: "005930", side: "BUY" },
    ...overrides,
  };
}

function bracket(overrides = {}) {
  return {
    type: "BRACKET_OCO_PREVIEW_V1",
    executionMode: "PAPER_ONLY",
    executionAuthority: "NONE",
    childOrdersSubmitted: false,
    market: "KR_STOCK",
    symbol: "005930",
    side: "BUY",
    quantity: 10,
    entryPrice: 70_000,
    targetPrice: 75_000,
    stopPrice: 68_000,
    ...overrides,
  };
}

function intent() {
  return buildProtectionIntent({
    entryOrder: entry(),
    bracketPlan: bracket(),
    protectionIdempotencyKey: "protect:entry:1",
    createdAt: "2026-08-25T12:00:00.000Z",
  });
}

function ack(p = intent(), overrides = {}) {
  return acknowledgePaperProtection({
    intent: p,
    providerCapabilities: PAPER_MOCK_PROTECTION_CAPABILITIES,
    evidence: {
      entryOrderId: p.entryOrderId,
      protectionIdempotencyKey: p.protectionIdempotencyKey,
      acknowledgementId: "ack-1",
      protectionOrderId: "paper-stop-1",
      stopPrice: p.stopPrice,
      observedAt: "2026-08-25T12:00:01.000Z",
      simulated: true,
      durable: true,
      providerNative: false,
      realExchangeOrder: false,
      privateApiUsed: false,
      ...overrides,
    },
  });
}

const freshHeartbeat = { ownerId: "watchdog-a", leaseId: "lease-1", observedAt: "2026-08-25T12:00:04.000Z" };
const policy = { heartbeatTimeoutMs: 5_000, maxFutureSkewMs: 1_000 };
const nowMs = Date.parse("2026-08-25T12:00:05.000Z");

test("builds a Paper-only protection intent bound to exact filled exposure", () => {
  const result = intent();
  assert.equal(result.state, PROTECTION_STATES.PENDING_ACK);
  assert.equal(result.stopPrice, 68_000);
  assert.equal(result.quantity, 10);
  assert.equal(result.executionAuthority, "NONE");
  assert.equal(result.unattendedLiveEligible, false);
});

test("protection quantity or identity cannot exceed/mismatch the filled entry", () => {
  assert.throws(
    () => buildProtectionIntent({ entryOrder: entry(), bracketPlan: bracket({ quantity: 11 }), protectionIdempotencyKey: "protect:entry:1", createdAt: "2026-08-25T12:00:00Z" }),
    (error) => error instanceof ServerFailureProtectionError && error.code === "PROTECTION_QUANTITY_EXCEEDS_EXPOSURE",
  );
  assert.throws(
    () => buildProtectionIntent({ entryOrder: entry(), bracketPlan: bracket({ symbol: "000660" }), protectionIdempotencyKey: "protect:entry:1", createdAt: "2026-08-25T12:00:00Z" }),
    (error) => error.code === "PROTECTION_IDENTITY_MISMATCH",
  );
});

test("durable Paper acknowledgement protects the simulated exposure but grants no live authority", () => {
  const protectedIntent = ack();
  assert.equal(protectedIntent.state, PROTECTION_STATES.PROTECTED);
  assert.equal(protectedIntent.paperProtectionProven, true);
  assert.equal(protectedIntent.providerNativeProtectionProven, false);
  assert.equal(protectedIntent.unattendedLiveEligible, false);
});

test("caller cannot self-attest native or server protective order evidence", () => {
  assert.throws(
    () => ack(intent(), { providerNative: true, serverAttested: true }),
    (error) => error.code === "CALLER_PROTECTION_ATTESTATION_FORBIDDEN",
  );
});

test("duplicate Paper acknowledgement is idempotent", () => {
  const first = ack();
  const second = acknowledgePaperProtection({
    intent: first,
    providerCapabilities: PAPER_MOCK_PROTECTION_CAPABILITIES,
    evidence: {
      entryOrderId: first.entryOrderId,
      protectionIdempotencyKey: first.protectionIdempotencyKey,
      acknowledgementId: "ack-1",
      protectionOrderId: "paper-stop-1",
      stopPrice: first.stopPrice,
      observedAt: "2026-08-25T12:00:02.000Z",
      simulated: true,
      durable: true,
      privateApiUsed: false,
    },
  });
  assert.equal(second, first);
});

test("crash after fill but before protection acknowledgement requires reconciliation", () => {
  const recovered = recoverProtectionAfterRestart(intent());
  assert.equal(recovered.state, PROTECTION_STATES.RECONCILIATION_REQUIRED);
  assert.equal(recovered.restartReason, "CRASH_OR_RESTART_BEFORE_PROTECTION_ACK");
});

test("unprotected exposure blocks new unattended entries and emits simulation-only emergency intent", () => {
  const result = assessUnattendedProtection({ orders: [entry()], protections: [], heartbeat: freshHeartbeat, policy, nowMs });
  assert.equal(result.newEntryAllowed, false);
  assert.equal(result.unprotectedPositions, 1);
  assert.ok(result.blockers.includes("UNPROTECTED_POSITION:teg-entry-1"));
  assert.equal(result.emergencyIntents.length, 1);
  assert.equal(result.emergencyIntents[0].type, "REDUCE_OR_CLOSE_SIMULATION_ONLY");
  assert.equal(result.emergencyIntents[0].automaticExecutionPerformed, false);
});

test("fresh heartbeat plus durable Paper protection allows Paper unattended gating only", () => {
  const result = assessUnattendedProtection({ orders: [entry()], protections: [ack()], heartbeat: freshHeartbeat, policy, nowMs });
  assert.equal(result.paperUnattendedEntryAllowed, true);
  assert.equal(result.newEntryAllowed, true);
  assert.equal(result.unattendedLiveEligible, false);
  assert.equal(result.emergencyIntents.length, 0);
});

test("stale heartbeat blocks new entries even when exposure is protected", () => {
  const result = assessUnattendedProtection({
    orders: [entry()],
    protections: [ack()],
    heartbeat: { ownerId: "watchdog-a", leaseId: "lease-1", observedAt: "2026-08-25T11:59:50.000Z" },
    policy,
    nowMs,
  });
  assert.equal(result.newEntryAllowed, false);
  assert.ok(result.blockers.includes("SUPERVISOR_HEARTBEAT_STALE"));
  assert.equal(result.emergencyIntents.length, 0);
});

test("native protection remains ineligible until durable support and authenticated reconciliation exist", () => {
  const readiness = evaluateProviderNativeProtectionReadiness({
    nativeProtectiveOrderSupported: false,
    providerPersistsProtectiveOrders: false,
    authenticatedProtectionReadAdapterEnabled: false,
    liveTrading: false,
    privateTradingApiAllowed: false,
  });
  assert.equal(readiness.structurallyReadyForFutureUnattendedLiveReview, false);
  assert.equal(readiness.activationAllowed, false);
  assert.ok(readiness.blockers.includes("PROVIDER_NATIVE_PROTECTION_UNSUPPORTED"));

  const reconciled = reconcileProtectionEvidence({
    protection: recoverProtectionAfterRestart(intent()),
    observedProtection: {
      entryOrderId: "teg-entry-1",
      stopPrice: 68_000,
      active: true,
      providerNative: true,
      sourceAuthority: "SERVER_AUTHENTICATED_READ_ADAPTER",
    },
    providerCapabilities: {
      nativeProtectiveOrderSupported: true,
      providerPersistsProtectiveOrders: true,
      authenticatedProtectionReadAdapterEnabled: false,
      liveTrading: false,
      privateTradingApiAllowed: false,
    },
    observedAt: "2026-08-25T12:00:05.000Z",
  });
  assert.equal(reconciled.reconciled, false);
  assert.ok(reconciled.blockers.includes("AUTHENTICATED_PROTECTION_READ_ADAPTER_DISABLED"));
  assert.equal(reconciled.unattendedLiveEligible, false);
});
