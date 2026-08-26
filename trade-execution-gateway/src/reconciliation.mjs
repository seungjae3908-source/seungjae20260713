import { ORDER_STATES } from "./contracts.mjs";
import { GatewayError } from "./gateway.mjs";

const VALID_STATES = new Set(Object.values(ORDER_STATES));

function text(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new GatewayError("RECONCILIATION_EVIDENCE_INVALID", `${name} is required`);
  }
  return value.trim();
}

export function reconcileOrderEvidence({ omsOrder, brokerOrder, provider, observedAt }) {
  const providerId = text(provider, "provider").toLowerCase();
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs)) {
    throw new GatewayError("RECONCILIATION_TIMESTAMP_INVALID", "observedAt is invalid");
  }
  if (!omsOrder || typeof omsOrder !== "object") {
    throw new GatewayError("OMS_ORDER_EVIDENCE_REQUIRED", "OMS order evidence is required");
  }

  const orderId = text(omsOrder.orderId, "omsOrder.orderId");
  const brokerOrderId = omsOrder.brokerOrderId == null ? null : text(omsOrder.brokerOrderId, "omsOrder.brokerOrderId");
  const omsStatus = text(omsOrder.status, "omsOrder.status").toUpperCase();
  if (!VALID_STATES.has(omsStatus)) {
    throw new GatewayError("OMS_ORDER_STATE_INVALID", "OMS order state is invalid");
  }

  if (!brokerOrder) {
    return Object.freeze({
      reconciled: false,
      disposition: "BROKER_EVIDENCE_MISSING",
      orderId,
      brokerOrderId,
      provider: providerId,
      observedAt: new Date(observedMs).toISOString(),
      blockers: ["BROKER_ORDER_EVIDENCE_REQUIRED"],
      mutatesOms: false,
      brokerNetworkRead: false,
    });
  }

  const observedBrokerId = text(brokerOrder.brokerOrderId, "brokerOrder.brokerOrderId");
  const brokerStatus = text(brokerOrder.status, "brokerOrder.status").toUpperCase();
  if (!VALID_STATES.has(brokerStatus)) {
    throw new GatewayError("BROKER_ORDER_STATE_INVALID", "broker order state is invalid");
  }

  const blockers = [];
  if (brokerOrderId !== observedBrokerId) blockers.push("BROKER_ORDER_ID_MISMATCH");
  if (omsStatus !== brokerStatus) blockers.push("ORDER_STATE_MISMATCH");
  if (
    [ORDER_STATES.PARTIALLY_FILLED, ORDER_STATES.FILLED].includes(brokerStatus) &&
    brokerOrder.fillEvidence == null
  ) {
    blockers.push("FILL_EVIDENCE_REQUIRED");
  }

  return Object.freeze({
    reconciled: blockers.length === 0,
    disposition: blockers.length === 0 ? "EXACT_MATCH" : "MISMATCH",
    orderId,
    brokerOrderId,
    provider: providerId,
    observedAt: new Date(observedMs).toISOString(),
    omsStatus,
    brokerStatus,
    blockers,
    mutatesOms: false,
    brokerNetworkRead: false,
  });
}
