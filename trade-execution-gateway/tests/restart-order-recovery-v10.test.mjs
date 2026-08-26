import assert from "node:assert/strict";
import test from "node:test";

import {
  RESTART_ORDER_RECOVERY_V10_CONTRACT,
  recoverRestartOrderStateV10,
} from "../src/restart-order-recovery-v10.mjs";

const NOW = "2026-08-26T07:10:00+09:00";

function base(overrides = {}) {
  const original = {
    now: NOW,
    market: "KR_STOCK",
    provider: "toss",
    oms: {
      orders: [{
        orderId: "oms-1",
        brokerOrderId: "broker-1",
        clientOrderId: "client-1",
        symbol: "005930",
        status: "ACCEPTED",
        quantity: 10,
        filledQuantity: 0,
      }],
      positions: [],
    },
    providerSnapshot: {
      provider: "toss",
      market: "KR_STOCK",
      authenticated: true,
      source: "PROVIDER_AUTHENTICATED_READ",
      observedAt: "2026-08-26T07:09:55+09:00",
      orders: [{
        brokerOrderId: "broker-1",
        clientOrderId: "client-1",
        symbol: "005930",
        status: "ACCEPTED",
        quantity: 10,
        filledQuantity: 0,
      }],
      positions: [],
    },
    acknowledgements: [{
      acknowledgementId: "ack-1",
      orderId: "oms-1",
      brokerOrderId: "broker-1",
      clientOrderId: "client-1",
      status: "ACCEPTED",
      filledQuantity: 0,
      observedAt: "2026-08-26T07:09:54+09:00",
    }],
  };
  return {
    ...original,
    ...overrides,
    oms: { ...original.oms, ...(overrides.oms || {}) },
    providerSnapshot: {
      ...original.providerSnapshot,
      ...(overrides.providerSnapshot || {}),
    },
    acknowledgements:
      overrides.acknowledgements === undefined
        ? original.acknowledgements
        : overrides.acknowledgements,
  };
}

test("exact authenticated restart snapshot recovers read-only and grants no execution authority", () => {
  const result = recoverRestartOrderStateV10(base());
  assert.equal(result.state, "RECOVERED_READ_ONLY");
  assert.equal(result.orderPositionRecoveryComplete, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.orderRecoveries[0].disposition, "EXACT_MATCH");
  assert.equal(result.newExposureAllowed, false);
  assert.equal(result.liveActivationAllowed, false);
  assert.equal(result.executionAuthority, "NONE");
  assert.equal(result.mutatesOms, false);
  assert.equal(result.automaticOrderResubmission, false);
  assert.equal(RESTART_ORDER_RECOVERY_V10_CONTRACT.automaticCancelReplace, false);
});

test("missing broker evidence becomes UNKNOWN and never triggers automatic resubmission", () => {
  const result = recoverRestartOrderStateV10(
    base({ providerSnapshot: { orders: [] } }),
  );
  assert.equal(result.state, "RECONCILIATION_REQUIRED");
  assert.equal(result.orderRecoveries[0].disposition, "UNKNOWN");
  assert(result.blockers.includes("BROKER_ORDER_EVIDENCE_MISSING:oms-1"));
  assert.equal(result.automaticOrderResubmission, false);
  assert.equal(result.automaticCancelReplace, false);
  assert.equal(result.realOrderSubmitted, false);
});

test("stale or unauthenticated provider snapshot fails closed", () => {
  const result = recoverRestartOrderStateV10(
    base({
      providerSnapshot: {
        authenticated: false,
        observedAt: "2026-08-26T07:00:00+09:00",
      },
    }),
  );
  assert(result.blockers.includes("PROVIDER_SNAPSHOT_NOT_AUTHENTICATED"));
  assert(result.blockers.includes("PROVIDER_SNAPSHOT_STALE"));
  assert.equal(result.orderPositionRecoveryComplete, false);
  assert.equal(result.newExposureAllowed, false);
});

test("partial-fill forward progress is evidence only and requires manual OMS review", () => {
  const result = recoverRestartOrderStateV10(
    base({
      oms: {
        orders: [{
          orderId: "oms-1",
          brokerOrderId: "broker-1",
          clientOrderId: "client-1",
          symbol: "005930",
          status: "PARTIALLY_FILLED",
          quantity: 10,
          filledQuantity: 4,
        }],
      },
      providerSnapshot: {
        orders: [{
          brokerOrderId: "broker-1",
          clientOrderId: "client-1",
          symbol: "005930",
          status: "PARTIALLY_FILLED",
          quantity: 10,
          filledQuantity: 6,
        }],
      },
      acknowledgements: [],
    }),
  );
  assert.equal(result.orderRecoveries[0].disposition, "FORWARD_PROGRESS_EVIDENCED");
  assert.equal(result.orderRecoveries[0].manualOmsApplyRequired, true);
  assert(result.blockers.includes("OMS_UPDATE_REVIEW_REQUIRED:oms-1"));
  assert.equal(result.mutatesOms, false);
});

test("fill or state regression after restart fails closed", () => {
  const fillRegression = recoverRestartOrderStateV10(
    base({
      oms: {
        orders: [{
          orderId: "oms-1",
          brokerOrderId: "broker-1",
          clientOrderId: "client-1",
          symbol: "005930",
          status: "PARTIALLY_FILLED",
          quantity: 10,
          filledQuantity: 4,
        }],
      },
      providerSnapshot: {
        orders: [{
          brokerOrderId: "broker-1",
          clientOrderId: "client-1",
          symbol: "005930",
          status: "PARTIALLY_FILLED",
          quantity: 10,
          filledQuantity: 3,
        }],
      },
      acknowledgements: [],
    }),
  );
  assert(fillRegression.blockers.includes("PROVIDER_FILL_REGRESSION:oms-1"));

  const stateRegression = recoverRestartOrderStateV10(
    base({
      oms: {
        orders: [{
          orderId: "oms-1",
          brokerOrderId: "broker-1",
          clientOrderId: "client-1",
          symbol: "005930",
          status: "PARTIALLY_FILLED",
          quantity: 10,
          filledQuantity: 4,
        }],
      },
      providerSnapshot: {
        orders: [{
          brokerOrderId: "broker-1",
          clientOrderId: "client-1",
          symbol: "005930",
          status: "ACCEPTED",
          quantity: 10,
          filledQuantity: 0,
        }],
      },
      acknowledgements: [],
    }),
  );
  assert(stateRegression.blockers.some((value) => value.startsWith("PROVIDER_STATE_REGRESSION:oms-1")));
});

test("identical duplicate ACK is idempotent but conflicting duplicate ACK fails closed", () => {
  const duplicate = base().acknowledgements[0];
  const safe = recoverRestartOrderStateV10(
    base({ acknowledgements: [duplicate, { ...duplicate }] }),
  );
  assert.equal(safe.acknowledgementAssessment.duplicateAckCount, 1);
  assert.equal(safe.acknowledgementAssessment.conflictingAckCount, 0);
  assert.equal(safe.orderPositionRecoveryComplete, true);

  const conflict = recoverRestartOrderStateV10(
    base({
      acknowledgements: [
        duplicate,
        { ...duplicate, filledQuantity: 1 },
      ],
    }),
  );
  assert.equal(conflict.acknowledgementAssessment.conflictingAckCount, 1);
  assert(conflict.blockers.includes("ACK_CONFLICT:ack-1"));
  assert.equal(conflict.orderPositionRecoveryComplete, false);
});

test("untracked provider order or position blocks recovery; provider exposure only emits simulation emergency intent", () => {
  const result = recoverRestartOrderStateV10(
    base({
      providerSnapshot: {
        orders: [
          ...base().providerSnapshot.orders,
          {
            brokerOrderId: "broker-orphan",
            clientOrderId: "client-orphan",
            symbol: "000660",
            status: "ACCEPTED",
            quantity: 1,
            filledQuantity: 0,
          },
        ],
        positions: [{ symbol: "000660", direction: "LONG", quantity: 1 }],
      },
    }),
  );
  assert(result.blockers.includes("UNTRACKED_PROVIDER_ORDER:broker-orphan"));
  assert(result.blockers.includes("UNTRACKED_PROVIDER_POSITION:000660:LONG"));
  assert.equal(result.emergencyIntents.length, 1);
  assert.equal(result.emergencyIntents[0].type, "REDUCE_OR_CLOSE_SIMULATION_ONLY");
  assert.equal(result.emergencyIntents[0].automaticExecutionPerformed, false);
  assert.equal(result.emergencyIntents[0].executionAuthority, "NONE");
});

test("exact position recovery remains gated on the existing v0.9 protection reconciliation", () => {
  const result = recoverRestartOrderStateV10(
    base({
      oms: {
        positions: [{
          positionId: "position-1",
          symbol: "005930",
          direction: "LONG",
          quantity: 5,
        }],
      },
      providerSnapshot: {
        positions: [{ symbol: "005930", direction: "LONG", quantity: 5 }],
      },
    }),
  );
  assert.equal(result.orderPositionRecoveryComplete, true);
  assert.equal(result.state, "ORDER_POSITION_RECOVERED_PROTECTION_GATE_REQUIRED");
  assert.equal(result.requiresV09ProtectionReconciliation, true);
  assert.equal(result.nextRequiredGate, "PROVIDER_PROTECTION_RECONCILIATION_V0_9");
  assert.equal(result.newExposureAllowed, false);
});

test("provider position larger than persisted OMS position produces fail-closed simulation-only reduction intent", () => {
  const result = recoverRestartOrderStateV10(
    base({
      oms: {
        positions: [{
          positionId: "position-1",
          symbol: "005930",
          direction: "LONG",
          quantity: 5,
        }],
      },
      providerSnapshot: {
        positions: [{ symbol: "005930", direction: "LONG", quantity: 6 }],
      },
    }),
  );
  assert(result.blockers.includes("POSITION_FORWARD_EXPOSURE:position-1"));
  assert.equal(result.emergencyIntents.length, 1);
  assert.equal(result.emergencyIntents[0].observedQuantity, 6);
  assert.equal(result.realOrderSubmitted, false);
  assert.equal(result.privateProviderRequestPerformed, false);
});

test("unknown provider order status is classified as recovery UNKNOWN rather than accepted as an OMS state", () => {
  const result = recoverRestartOrderStateV10(
    base({
      providerSnapshot: {
        orders: [{
          brokerOrderId: "broker-1",
          clientOrderId: "client-1",
          symbol: "005930",
          status: "UNKNOWN",
          quantity: 10,
          filledQuantity: 0,
        }],
      },
    }),
  );
  assert(result.blockers.includes("PROVIDER_ORDER_STATE_UNKNOWN:broker-1:UNKNOWN"));
  assert(result.blockers.includes("ORDER_RECOVERY_UNKNOWN:oms-1"));
  assert.equal(result.orderRecoveries[0].disposition, "UNKNOWN");
  assert.equal(result.automaticOrderResubmission, false);
});
