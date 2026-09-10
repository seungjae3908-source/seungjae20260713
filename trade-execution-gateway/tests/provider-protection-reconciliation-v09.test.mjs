import test from "node:test";
import assert from "node:assert/strict";

import {
  PROTECTION_RECONCILIATION_V09_CONTRACT,
  reconcileProviderProtectionSnapshotV09,
} from "../src/provider-protection-reconciliation-v09.mjs";

const NOW = "2026-08-26T03:30:00+09:00";

function exactKr(overrides = {}) {
  const base = {
    now: NOW,
    market: "KR_STOCK",
    provider: "toss",
    providerCapabilities: {
      nativeProtectiveOrderSupported: true,
      nativeProtectiveOrderTypes: ["STOP"],
      providerPersistsProtectiveOrders: true,
      authenticatedProtectionReadAdapterEnabled: true,
    },
    oms: {
      orders: [
        {
          orderId: "oms-1",
          brokerOrderId: "broker-1",
          clientOrderId: "client-1",
          symbol: "005930",
          status: "FILLED",
          filledQuantity: 10,
        },
      ],
      positions: [
        {
          positionId: "position-1",
          symbol: "005930",
          direction: "LONG",
          quantity: 10,
        },
      ],
      protectiveIntents: [
        {
          positionId: "position-1",
          clientProtectionId: "protect-1",
          symbol: "005930",
          side: "SELL",
          orderType: "STOP",
          quantity: 10,
          stopPrice: 70000,
        },
      ],
    },
    providerSnapshot: {
      provider: "toss",
      market: "KR_STOCK",
      authenticated: true,
      source: "PROVIDER_AUTHENTICATED_READ",
      observedAt: "2026-08-26T03:29:55+09:00",
      orders: [
        {
          brokerOrderId: "broker-1",
          clientOrderId: "client-1",
          symbol: "005930",
          status: "FILLED",
          filledQuantity: 10,
        },
      ],
      positions: [{ symbol: "005930", direction: "LONG", quantity: 10 }],
      protectiveOrders: [
        {
          clientProtectionId: "protect-1",
          providerOrderId: "provider-stop-1",
          symbol: "005930",
          side: "SELL",
          orderType: "STOP",
          quantity: 10,
          stopPrice: 70000,
          status: "WORKING",
          persistenceConfirmed: true,
          serverHeld: true,
        },
      ],
    },
  };
  return {
    ...base,
    ...overrides,
    providerCapabilities: {
      ...base.providerCapabilities,
      ...(overrides.providerCapabilities || {}),
    },
    oms: { ...base.oms, ...(overrides.oms || {}) },
    providerSnapshot: { ...base.providerSnapshot, ...(overrides.providerSnapshot || {}) },
  };
}

test("v0.9 exact authenticated native protection reconciliation can become evidence-ready without granting live authority", () => {
  const result = reconcileProviderProtectionSnapshotV09(exactKr());
  assert.equal(result.state, "RECONCILED");
  assert.equal(result.futureUnattendedLiveContractSatisfied, true);
  assert.equal(result.futureNewExposureEvidenceReady, true);
  assert.equal(result.newExposureAllowed, false);
  assert.equal(result.liveActivationAllowed, false);
  assert.equal(result.executionAuthority, "NONE");
  assert.equal(result.brokerNetworkReadPerformed, false);
  assert.equal(result.privateProviderRequestPerformed, false);
  assert.equal(result.realOrderSubmitted, false);
  assert.equal(result.mutatesOms, false);
  assert.deepEqual(result.blockers, []);
  assert.equal(PROTECTION_RECONCILIATION_V09_CONTRACT.liveActivationAllowed, false);
});

test("stale or unauthenticated snapshots fail closed", () => {
  const stale = reconcileProviderProtectionSnapshotV09(
    exactKr({
      providerSnapshot: {
        authenticated: false,
        observedAt: "2026-08-26T03:20:00+09:00",
      },
    }),
  );
  assert.equal(stale.state, "RECONCILIATION_REQUIRED");
  assert.equal(stale.futureUnattendedLiveContractSatisfied, false);
  assert.equal(stale.newExposureAllowed, false);
  assert(stale.blockers.includes("PROVIDER_SNAPSHOT_NOT_AUTHENTICATED"));
  assert(stale.blockers.includes("PROVIDER_SNAPSHOT_STALE"));
});

test("order status and fill quantity mismatch remain reconciliation blockers", () => {
  const result = reconcileProviderProtectionSnapshotV09(
    exactKr({
      providerSnapshot: {
        orders: [
          {
            brokerOrderId: "broker-1",
            clientOrderId: "client-1",
            symbol: "005930",
            status: "PARTIALLY_FILLED",
            filledQuantity: 8,
          },
        ],
      },
    }),
  );
  assert(result.blockers.includes("ORDER_STATE_MISMATCH:oms-1"));
  assert(result.blockers.includes("ORDER_FILLED_QUANTITY_MISMATCH:oms-1"));
  assert.equal(result.futureUnattendedLiveContractSatisfied, false);
});

test("position quantity mismatch and untracked provider exposure fail closed", () => {
  const result = reconcileProviderProtectionSnapshotV09(
    exactKr({
      providerSnapshot: {
        positions: [
          { symbol: "005930", direction: "LONG", quantity: 9 },
          { symbol: "000660", direction: "LONG", quantity: 1 },
        ],
      },
    }),
  );
  assert(result.blockers.includes("POSITION_QUANTITY_MISMATCH:position-1"));
  assert(result.blockers.includes("UNTRACKED_PROVIDER_POSITION:000660:LONG"));
  assert.equal(result.newExposureAllowed, false);
});

test("missing, mismatched, or terminal protective order never counts as durable protection", () => {
  const missing = reconcileProviderProtectionSnapshotV09(
    exactKr({ providerSnapshot: { protectiveOrders: [] } }),
  );
  assert(missing.blockers.includes("PROVIDER_PROTECTION_MISSING:position-1"));

  const terminal = reconcileProviderProtectionSnapshotV09(
    exactKr({
      providerSnapshot: {
        protectiveOrders: [
          {
            clientProtectionId: "protect-1",
            providerOrderId: "provider-stop-1",
            symbol: "005930",
            side: "SELL",
            orderType: "STOP",
            quantity: 9,
            stopPrice: 69000,
            status: "CANCELED",
            persistenceConfirmed: false,
            serverHeld: false,
          },
        ],
      },
    }),
  );
  assert(terminal.blockers.includes("PROVIDER_PROTECTION_QUANTITY_MISMATCH:position-1"));
  assert(terminal.blockers.includes("PROVIDER_PROTECTION_STOP_MISMATCH:position-1"));
  assert(terminal.blockers.includes("PROVIDER_PROTECTION_NOT_WORKING:position-1"));
  assert(terminal.blockers.includes("PROVIDER_PROTECTION_PERSISTENCE_NOT_CONFIRMED:position-1"));
  assert(terminal.blockers.includes("PROVIDER_PROTECTION_NOT_SERVER_HELD:position-1"));
  assert.equal(terminal.futureUnattendedLiveContractSatisfied, false);
});

test("canonical provider mismatch fails closed even if supplied evidence is internally consistent", () => {
  const result = reconcileProviderProtectionSnapshotV09(
    exactKr({
      provider: "kiwoom",
      providerSnapshot: { provider: "kiwoom" },
    }),
  );
  assert(result.blockers.includes("CANONICAL_PROVIDER_MISMATCH:toss"));
  assert.equal(result.liveActivationAllowed, false);
});

test("futures short requires a BUY protective order and reconciles exact provider exposure", () => {
  const result = reconcileProviderProtectionSnapshotV09({
    now: NOW,
    market: "CRYPTO_FUTURES",
    provider: "bitget",
    providerCapabilities: {
      nativeProtectiveOrderSupported: true,
      nativeProtectiveOrderTypes: ["STOP"],
      providerPersistsProtectiveOrders: true,
      authenticatedProtectionReadAdapterEnabled: true,
    },
    oms: {
      orders: [],
      positions: [{ positionId: "short-1", symbol: "BTCUSDT", direction: "SHORT", quantity: 0.01 }],
      protectiveIntents: [
        {
          positionId: "short-1",
          clientProtectionId: "protect-short-1",
          symbol: "BTCUSDT",
          side: "BUY",
          orderType: "STOP",
          quantity: 0.01,
          stopPrice: 70000,
        },
      ],
    },
    providerSnapshot: {
      provider: "bitget",
      market: "CRYPTO_FUTURES",
      authenticated: true,
      source: "PROVIDER_AUTHENTICATED_READ",
      observedAt: "2026-08-26T03:29:59+09:00",
      orders: [],
      positions: [{ symbol: "BTCUSDT", direction: "SHORT", quantity: 0.01 }],
      protectiveOrders: [
        {
          clientProtectionId: "protect-short-1",
          providerOrderId: "stop-short-1",
          symbol: "BTCUSDT",
          side: "BUY",
          orderType: "STOP",
          quantity: 0.01,
          stopPrice: 70000,
          status: "WORKING",
          persistenceConfirmed: true,
          serverHeld: true,
        },
      ],
    },
  });
  assert.equal(result.state, "RECONCILED");
  assert.equal(result.newExposureAllowed, false);
  assert.equal(result.reductionOrExitAllowed, true);
});

test("disabled native-protection capabilities remain ineligible even with perfect snapshots", () => {
  const result = reconcileProviderProtectionSnapshotV09(
    exactKr({
      providerCapabilities: {
        nativeProtectiveOrderSupported: false,
        nativeProtectiveOrderTypes: [],
        providerPersistsProtectiveOrders: false,
        authenticatedProtectionReadAdapterEnabled: false,
      },
    }),
  );
  assert(result.blockers.includes("NATIVE_PROTECTIVE_ORDER_NOT_SUPPORTED"));
  assert(result.blockers.includes("PROVIDER_PROTECTION_DURABILITY_NOT_PROVEN"));
  assert(result.blockers.includes("AUTHENTICATED_PROTECTION_READ_ADAPTER_DISABLED"));
  assert(result.blockers.includes("NATIVE_PROTECTIVE_ORDER_TYPE_UNSUPPORTED:STOP"));
  assert.equal(result.futureUnattendedLiveContractSatisfied, false);
  assert.equal(result.realOrderSubmitted, false);
});
