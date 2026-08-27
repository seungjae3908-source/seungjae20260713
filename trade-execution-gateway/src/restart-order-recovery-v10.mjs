const CANONICAL_PROVIDERS = Object.freeze({
  KR_STOCK: "toss",
  US_STOCK: "toss",
  CRYPTO_SPOT: "upbit",
  CRYPTO_FUTURES: "bitget",
});

const OMS_STATES = new Set([
  "CREATED",
  "RISK_ACCEPTED",
  "SUBMITTED",
  "ACCEPTED",
  "PARTIALLY_FILLED",
  "FILLED",
  "CANCELED",
  "REJECTED",
]);

const PROVIDER_STATES = new Set([
  "SUBMITTED",
  "ACCEPTED",
  "PARTIALLY_FILLED",
  "FILLED",
  "CANCELED",
  "REJECTED",
]);

const ACTIVE_PROVIDER_STATES = new Set(["SUBMITTED", "ACCEPTED", "PARTIALLY_FILLED", "FILLED"]);
const PRE_SUBMISSION_OMS_STATES = new Set(["CREATED", "RISK_ACCEPTED"]);
const TERMINAL_STATES = new Set(["FILLED", "CANCELED", "REJECTED"]);
const PROGRESS_RANK = Object.freeze({
  SUBMITTED: 1,
  ACCEPTED: 2,
  PARTIALLY_FILLED: 3,
  FILLED: 4,
});
const EPSILON = 1e-12;

export const RESTART_ORDER_RECOVERY_V10_CONTRACT = Object.freeze({
  version: "V1_0",
  authority: "CALLER_SUPPLIED_AUTHENTICATED_READ_ONLY_EVIDENCE",
  canonicalProviders: CANONICAL_PROVIDERS,
  exactAggregateOrderSnapshotRequired: true,
  exactAggregatePositionSnapshotRequired: true,
  duplicateAcknowledgementsMustBeIdempotent: true,
  conflictingDuplicateAcknowledgementsFailClosed: true,
  unknownOrderEvidenceFailsClosed: true,
  partialFillForwardProgressRequiresManualOmsReview: true,
  fillOrStateRegressionFailsClosed: true,
  untrackedProviderExposureFailsClosed: true,
  staleEvidenceFailsClosed: true,
  futureEvidenceFailsClosed: true,
  requiresV09ProtectionReconciliationForExposure: true,
  mutatesOms: false,
  automaticOrderResubmission: false,
  automaticCancelReplace: false,
  automaticProtectionResubmission: false,
  brokerNetworkReadPerformed: false,
  privateProviderRequestPerformed: false,
  realOrderSubmitted: false,
  executionAuthority: "NONE",
  newExposureAllowed: false,
  liveActivationAllowed: false,
});

function asObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function asArray(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return value;
}

function text(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function upper(value, name) {
  return text(value, name).toUpperCase();
}

function lower(value, name) {
  return text(value, name).toLowerCase();
}

function nonNegative(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new TypeError(`${name} must be a non-negative finite number`);
  }
  return number;
}

function positive(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
  return number;
}

function optionalPositive(value, name) {
  if (value == null) return null;
  return positive(value, name);
}

function instant(value, name) {
  const parsed = Date.parse(String(value ?? ""));
  if (!Number.isFinite(parsed)) throw new TypeError(`${name} must be a valid timestamp`);
  return parsed;
}

function sameNumber(left, right) {
  return Math.abs(Number(left) - Number(right)) <= EPSILON;
}

function addUnique(blockers, blocker) {
  if (!blockers.includes(blocker)) blockers.push(blocker);
}

function normalizeRefs(order, prefix) {
  return {
    brokerOrderId:
      order.brokerOrderId == null ? null : text(order.brokerOrderId, `${prefix}.brokerOrderId`),
    clientOrderId:
      order.clientOrderId == null ? null : text(order.clientOrderId, `${prefix}.clientOrderId`),
  };
}

function normalizeOmsOrder(order, index, blockers) {
  const prefix = `oms.orders[${index}]`;
  asObject(order, prefix);
  const orderId = text(order.orderId, `${prefix}.orderId`);
  const refs = normalizeRefs(order, prefix);
  const status = upper(order.status, `${prefix}.status`);
  if (!OMS_STATES.has(status)) addUnique(blockers, `OMS_ORDER_STATE_INVALID:${orderId}`);
  const symbol = upper(order.symbol, `${prefix}.symbol`);
  const quantity = optionalPositive(order.quantity ?? order.intent?.quantity, `${prefix}.quantity`);
  const filledQuantity = nonNegative(order.filledQuantity ?? 0, `${prefix}.filledQuantity`);
  if (quantity != null && filledQuantity > quantity + EPSILON) {
    addUnique(blockers, `OMS_ORDER_OVERFILLED:${orderId}`);
  }
  if ((status === "CREATED" || status === "RISK_ACCEPTED" || status === "SUBMITTED" || status === "ACCEPTED") && filledQuantity > EPSILON) {
    addUnique(blockers, `OMS_FILL_STATE_INCONSISTENT:${orderId}`);
  }
  if (status === "PARTIALLY_FILLED" && (filledQuantity <= EPSILON || (quantity != null && filledQuantity >= quantity - EPSILON))) {
    addUnique(blockers, `OMS_PARTIAL_FILL_STATE_INCONSISTENT:${orderId}`);
  }
  if (status === "FILLED" && quantity != null && !sameNumber(filledQuantity, quantity)) {
    addUnique(blockers, `OMS_FILLED_QUANTITY_INCONSISTENT:${orderId}`);
  }
  return { orderId, ...refs, status, symbol, quantity, filledQuantity };
}

function normalizeProviderOrder(order, index, blockers) {
  const prefix = `providerSnapshot.orders[${index}]`;
  asObject(order, prefix);
  const refs = normalizeRefs(order, prefix);
  const symbol = upper(order.symbol, `${prefix}.symbol`);
  const rawStatus = upper(order.status, `${prefix}.status`);
  const status = PROVIDER_STATES.has(rawStatus) ? rawStatus : null;
  const quantity = optionalPositive(order.quantity, `${prefix}.quantity`);
  const filledQuantity = nonNegative(order.filledQuantity ?? 0, `${prefix}.filledQuantity`);
  const ref = refs.brokerOrderId || refs.clientOrderId || `${symbol}#${index}`;
  if (!refs.brokerOrderId && !refs.clientOrderId) addUnique(blockers, `PROVIDER_ORDER_REFERENCE_MISSING:${ref}`);
  if (!status) addUnique(blockers, `PROVIDER_ORDER_STATE_UNKNOWN:${ref}:${rawStatus}`);
  if (quantity != null && filledQuantity > quantity + EPSILON) addUnique(blockers, `PROVIDER_ORDER_OVERFILLED:${ref}`);
  if (status && ["SUBMITTED", "ACCEPTED"].includes(status) && filledQuantity > EPSILON) {
    addUnique(blockers, `PROVIDER_FILL_STATE_INCONSISTENT:${ref}`);
  }
  if (status === "PARTIALLY_FILLED" && (filledQuantity <= EPSILON || (quantity != null && filledQuantity >= quantity - EPSILON))) {
    addUnique(blockers, `PROVIDER_PARTIAL_FILL_STATE_INCONSISTENT:${ref}`);
  }
  if (status === "FILLED" && quantity != null && !sameNumber(filledQuantity, quantity)) {
    addUnique(blockers, `PROVIDER_FILLED_QUANTITY_INCONSISTENT:${ref}`);
  }
  return { ...refs, symbol, status, rawStatus, quantity, filledQuantity, ref };
}

function compareOrderState(oms, provider, blockers) {
  const orderBlockers = [];
  const add = (blocker) => {
    addUnique(orderBlockers, blocker);
    addUnique(blockers, blocker);
  };

  if (oms.symbol !== provider.symbol) add(`ORDER_SYMBOL_MISMATCH:${oms.orderId}`);
  if (oms.brokerOrderId && provider.brokerOrderId && oms.brokerOrderId !== provider.brokerOrderId) {
    add(`BROKER_ORDER_ID_MISMATCH:${oms.orderId}`);
  }
  if (oms.clientOrderId && provider.clientOrderId && oms.clientOrderId !== provider.clientOrderId) {
    add(`CLIENT_ORDER_ID_MISMATCH:${oms.orderId}`);
  }

  if (!provider.status) {
    add(`ORDER_RECOVERY_UNKNOWN:${oms.orderId}`);
    return {
      orderId: oms.orderId,
      disposition: "UNKNOWN",
      omsStatus: oms.status,
      providerStatus: provider.rawStatus,
      omsFilledQuantity: oms.filledQuantity,
      providerFilledQuantity: provider.filledQuantity,
      manualOmsApplyRequired: false,
      blockers: Object.freeze(orderBlockers),
    };
  }

  if (provider.filledQuantity + EPSILON < oms.filledQuantity) {
    add(`PROVIDER_FILL_REGRESSION:${oms.orderId}`);
  }

  const quantity = oms.quantity ?? provider.quantity;
  if (quantity != null && provider.filledQuantity > quantity + EPSILON) {
    add(`PROVIDER_ORDER_OVERFILLED:${oms.orderId}`);
  }

  let forward = provider.filledQuantity > oms.filledQuantity + EPSILON;
  const omsRank = PROGRESS_RANK[oms.status] ?? null;
  const providerRank = PROGRESS_RANK[provider.status] ?? null;

  if (TERMINAL_STATES.has(oms.status)) {
    if (oms.status !== provider.status) {
      add(`TERMINAL_ORDER_STATE_CONFLICT:${oms.orderId}:${oms.status}->${provider.status}`);
    }
  } else if (TERMINAL_STATES.has(provider.status)) {
    if (provider.status === "FILLED" && provider.filledQuantity >= oms.filledQuantity - EPSILON) {
      forward = true;
    } else {
      add(`ORDER_TERMINAL_DISPOSITION_MISMATCH:${oms.orderId}:${oms.status}->${provider.status}`);
    }
  } else if (omsRank != null && providerRank != null) {
    if (providerRank < omsRank) add(`PROVIDER_STATE_REGRESSION:${oms.orderId}:${oms.status}->${provider.status}`);
    if (providerRank > omsRank) forward = true;
  } else if (oms.status !== provider.status) {
    add(`ORDER_STATE_MISMATCH:${oms.orderId}:${oms.status}->${provider.status}`);
  }

  if (forward) {
    add(`OMS_UPDATE_REVIEW_REQUIRED:${oms.orderId}`);
  } else if (oms.status !== provider.status && orderBlockers.length === 0) {
    add(`ORDER_STATE_MISMATCH:${oms.orderId}:${oms.status}->${provider.status}`);
  }

  return {
    orderId: oms.orderId,
    disposition:
      orderBlockers.length === 0
        ? "EXACT_MATCH"
        : forward && !orderBlockers.some((value) => value.includes("REGRESSION") || value.includes("CONFLICT"))
          ? "FORWARD_PROGRESS_EVIDENCED"
          : "RECONCILIATION_REQUIRED",
    omsStatus: oms.status,
    providerStatus: provider.status,
    omsFilledQuantity: oms.filledQuantity,
    providerFilledQuantity: provider.filledQuantity,
    manualOmsApplyRequired: forward,
    blockers: Object.freeze(orderBlockers),
  };
}

function positionDirection(market, value, name) {
  const direction = upper(value, name);
  if (market === "CRYPTO_FUTURES") {
    if (!["LONG", "SHORT"].includes(direction)) throw new TypeError(`${name} must be LONG or SHORT`);
    return direction;
  }
  if (direction !== "LONG") throw new TypeError(`${name} must be LONG for ${market}`);
  return direction;
}

function normalizePositions({ market, omsPositions, providerPositions, blockers }) {
  const providerByKey = new Map();
  for (const [index, raw] of providerPositions.entries()) {
    const prefix = `providerSnapshot.positions[${index}]`;
    const position = asObject(raw, prefix);
    const symbol = upper(position.symbol, `${prefix}.symbol`);
    const direction = positionDirection(market, position.direction, `${prefix}.direction`);
    const quantity = positive(position.quantity, `${prefix}.quantity`);
    const key = `${symbol}:${direction}`;
    if (providerByKey.has(key)) addUnique(blockers, `DUPLICATE_PROVIDER_POSITION:${key}`);
    providerByKey.set(key, { symbol, direction, quantity, key });
  }

  const matched = new Set();
  const recoveries = [];
  for (const [index, raw] of omsPositions.entries()) {
    const prefix = `oms.positions[${index}]`;
    const position = asObject(raw, prefix);
    const positionId = text(position.positionId, `${prefix}.positionId`);
    const symbol = upper(position.symbol, `${prefix}.symbol`);
    const direction = positionDirection(market, position.direction, `${prefix}.direction`);
    const quantity = positive(position.quantity, `${prefix}.quantity`);
    const key = `${symbol}:${direction}`;
    const observed = providerByKey.get(key);
    const local = [];
    if (!observed) {
      const blocker = `PROVIDER_POSITION_MISSING:${positionId}`;
      addUnique(local, blocker);
      addUnique(blockers, blocker);
    } else {
      matched.add(key);
      if (observed.quantity > quantity + EPSILON) {
        const blocker = `POSITION_FORWARD_EXPOSURE:${positionId}`;
        addUnique(local, blocker);
        addUnique(blockers, blocker);
      } else if (observed.quantity + EPSILON < quantity) {
        const blocker = `POSITION_REDUCTION_OR_REGRESSION_UNAPPLIED:${positionId}`;
        addUnique(local, blocker);
        addUnique(blockers, blocker);
      }
    }
    recoveries.push(Object.freeze({
      positionId,
      symbol,
      direction,
      omsQuantity: quantity,
      providerQuantity: observed?.quantity ?? null,
      disposition: local.length === 0 ? "EXACT_MATCH" : "RECONCILIATION_REQUIRED",
      blockers: Object.freeze(local),
    }));
  }

  const untracked = [];
  for (const [key, observed] of providerByKey) {
    if (!matched.has(key)) {
      const blocker = `UNTRACKED_PROVIDER_POSITION:${key}`;
      addUnique(blockers, blocker);
      untracked.push(observed);
    }
  }

  return { recoveries: Object.freeze(recoveries), untracked };
}

function ackFingerprint(ack) {
  return JSON.stringify([
    ack.orderId,
    ack.brokerOrderId,
    ack.clientOrderId,
    ack.status,
    ack.filledQuantity,
  ]);
}

function assessAcknowledgements({ acknowledgements, omsById, nowMs, blockers }) {
  const byAckId = new Map();
  let duplicateAckCount = 0;
  let conflictingAckCount = 0;

  for (const [index, raw] of acknowledgements.entries()) {
    const prefix = `acknowledgements[${index}]`;
    const ack = asObject(raw, prefix);
    const acknowledgementId = text(ack.acknowledgementId, `${prefix}.acknowledgementId`);
    const orderId = text(ack.orderId, `${prefix}.orderId`);
    const refs = normalizeRefs(ack, prefix);
    const rawStatus = upper(ack.status, `${prefix}.status`);
    const status = PROVIDER_STATES.has(rawStatus) ? rawStatus : null;
    const filledQuantity = nonNegative(ack.filledQuantity ?? 0, `${prefix}.filledQuantity`);
    const observedMs = instant(ack.observedAt, `${prefix}.observedAt`);
    if (observedMs > nowMs) addUnique(blockers, `ACK_FROM_FUTURE:${acknowledgementId}`);
    if (!status) addUnique(blockers, `ACK_STATE_UNKNOWN:${acknowledgementId}:${rawStatus}`);

    const normalized = {
      acknowledgementId,
      orderId,
      ...refs,
      status: status ?? rawStatus,
      filledQuantity,
    };
    const fingerprint = ackFingerprint(normalized);
    const previous = byAckId.get(acknowledgementId);
    if (previous) {
      if (previous.fingerprint === fingerprint) {
        duplicateAckCount += 1;
      } else {
        conflictingAckCount += 1;
        addUnique(blockers, `ACK_CONFLICT:${acknowledgementId}`);
      }
      continue;
    }
    byAckId.set(acknowledgementId, { fingerprint, normalized });

    const oms = omsById.get(orderId);
    if (!oms) {
      addUnique(blockers, `ACK_REFERENCES_UNKNOWN_OMS_ORDER:${acknowledgementId}:${orderId}`);
      continue;
    }
    if (oms.brokerOrderId && refs.brokerOrderId && oms.brokerOrderId !== refs.brokerOrderId) {
      addUnique(blockers, `ACK_BROKER_ORDER_ID_MISMATCH:${acknowledgementId}`);
    }
    if (oms.clientOrderId && refs.clientOrderId && oms.clientOrderId !== refs.clientOrderId) {
      addUnique(blockers, `ACK_CLIENT_ORDER_ID_MISMATCH:${acknowledgementId}`);
    }
    if (filledQuantity + EPSILON < oms.filledQuantity) {
      addUnique(blockers, `ACK_FILL_REGRESSION:${acknowledgementId}`);
    }
  }

  return Object.freeze({
    uniqueAckCount: byAckId.size,
    duplicateAckCount,
    conflictingAckCount,
    idempotentDuplicateAckOnly: conflictingAckCount === 0,
  });
}

function emergencyIntent(market, position, reason) {
  return Object.freeze({
    type: "REDUCE_OR_CLOSE_SIMULATION_ONLY",
    market,
    symbol: position.symbol,
    direction: position.direction,
    observedQuantity: position.quantity,
    reason,
    automaticExecutionPerformed: false,
    realOrderSubmitted: false,
    privateProviderRequestPerformed: false,
    executionAuthority: "NONE",
  });
}

export function recoverRestartOrderStateV10(input) {
  const root = asObject(input, "input");
  const market = upper(root.market, "market");
  const canonicalProvider = CANONICAL_PROVIDERS[market];
  if (!canonicalProvider) throw new TypeError(`unsupported market: ${market}`);
  const provider = lower(root.provider, "provider");
  const nowMs =
    root.now == null
      ? Date.now()
      : typeof root.now === "number"
        ? root.now
        : instant(root.now, "now");
  if (!Number.isFinite(nowMs) || nowMs <= 0) throw new TypeError("now is invalid");
  const maxSnapshotAgeMs =
    root.maxSnapshotAgeMs == null ? 15_000 : positive(root.maxSnapshotAgeMs, "maxSnapshotAgeMs");

  const oms = asObject(root.oms, "oms");
  const snapshot = asObject(root.providerSnapshot, "providerSnapshot");
  const omsOrdersRaw = asArray(oms.orders, "oms.orders");
  const omsPositions = asArray(oms.positions, "oms.positions");
  const providerOrdersRaw = asArray(snapshot.orders, "providerSnapshot.orders");
  const providerPositions = asArray(snapshot.positions, "providerSnapshot.positions");
  const acknowledgements = root.acknowledgements == null
    ? []
    : asArray(root.acknowledgements, "acknowledgements");

  const blockers = [];
  if (provider !== canonicalProvider) addUnique(blockers, `CANONICAL_PROVIDER_MISMATCH:${canonicalProvider}`);
  if (lower(snapshot.provider, "providerSnapshot.provider") !== provider) {
    addUnique(blockers, "PROVIDER_SNAPSHOT_PROVIDER_MISMATCH");
  }
  if (upper(snapshot.market, "providerSnapshot.market") !== market) {
    addUnique(blockers, "PROVIDER_SNAPSHOT_MARKET_MISMATCH");
  }
  if (snapshot.authenticated !== true) addUnique(blockers, "PROVIDER_SNAPSHOT_NOT_AUTHENTICATED");
  if (upper(snapshot.source, "providerSnapshot.source") !== "PROVIDER_AUTHENTICATED_READ") {
    addUnique(blockers, "PROVIDER_SNAPSHOT_SOURCE_NOT_AUTHENTICATED_READ");
  }
  const observedMs = instant(snapshot.observedAt, "providerSnapshot.observedAt");
  if (observedMs > nowMs) addUnique(blockers, "PROVIDER_SNAPSHOT_FROM_FUTURE");
  else if (nowMs - observedMs > maxSnapshotAgeMs) addUnique(blockers, "PROVIDER_SNAPSHOT_STALE");

  const omsOrders = omsOrdersRaw.map((order, index) => normalizeOmsOrder(order, index, blockers));
  const omsById = new Map();
  for (const order of omsOrders) {
    if (omsById.has(order.orderId)) addUnique(blockers, `DUPLICATE_OMS_ORDER_ID:${order.orderId}`);
    omsById.set(order.orderId, order);
  }

  const providerOrders = providerOrdersRaw.map((order, index) =>
    normalizeProviderOrder(order, index, blockers),
  );
  const providerByBroker = new Map();
  const providerByClient = new Map();
  for (const order of providerOrders) {
    if (order.brokerOrderId) {
      if (providerByBroker.has(order.brokerOrderId)) {
        addUnique(blockers, `DUPLICATE_PROVIDER_BROKER_ORDER:${order.brokerOrderId}`);
      }
      providerByBroker.set(order.brokerOrderId, order);
    }
    if (order.clientOrderId) {
      if (providerByClient.has(order.clientOrderId)) {
        addUnique(blockers, `DUPLICATE_PROVIDER_CLIENT_ORDER:${order.clientOrderId}`);
      }
      providerByClient.set(order.clientOrderId, order);
    }
  }

  const matchedProviderOrders = new Set();
  const orderRecoveries = [];
  for (const omsOrder of omsOrders) {
    const observed =
      (omsOrder.brokerOrderId && providerByBroker.get(omsOrder.brokerOrderId)) ||
      (omsOrder.clientOrderId && providerByClient.get(omsOrder.clientOrderId));

    if (!observed) {
      if (PRE_SUBMISSION_OMS_STATES.has(omsOrder.status)) {
        orderRecoveries.push(Object.freeze({
          orderId: omsOrder.orderId,
          disposition: "LOCAL_PRE_SUBMISSION_ONLY",
          omsStatus: omsOrder.status,
          providerStatus: null,
          omsFilledQuantity: omsOrder.filledQuantity,
          providerFilledQuantity: null,
          manualOmsApplyRequired: false,
          blockers: Object.freeze([]),
        }));
      } else {
        const blocker = `BROKER_ORDER_EVIDENCE_MISSING:${omsOrder.orderId}`;
        addUnique(blockers, blocker);
        orderRecoveries.push(Object.freeze({
          orderId: omsOrder.orderId,
          disposition: "UNKNOWN",
          omsStatus: omsOrder.status,
          providerStatus: null,
          omsFilledQuantity: omsOrder.filledQuantity,
          providerFilledQuantity: null,
          manualOmsApplyRequired: false,
          blockers: Object.freeze([blocker]),
        }));
      }
      continue;
    }

    matchedProviderOrders.add(observed);
    if (PRE_SUBMISSION_OMS_STATES.has(omsOrder.status)) {
      const blocker = `UNEXPECTED_PROVIDER_ORDER_FOR_LOCAL_PRE_SUBMISSION:${omsOrder.orderId}`;
      addUnique(blockers, blocker);
      orderRecoveries.push(Object.freeze({
        orderId: omsOrder.orderId,
        disposition: "RECONCILIATION_REQUIRED",
        omsStatus: omsOrder.status,
        providerStatus: observed.status ?? observed.rawStatus,
        omsFilledQuantity: omsOrder.filledQuantity,
        providerFilledQuantity: observed.filledQuantity,
        manualOmsApplyRequired: true,
        blockers: Object.freeze([blocker]),
      }));
      continue;
    }

    orderRecoveries.push(Object.freeze(compareOrderState(omsOrder, observed, blockers)));
  }

  for (const providerOrder of providerOrders) {
    if (!matchedProviderOrders.has(providerOrder) && providerOrder.status && ACTIVE_PROVIDER_STATES.has(providerOrder.status)) {
      addUnique(blockers, `UNTRACKED_PROVIDER_ORDER:${providerOrder.ref}`);
    }
  }

  const positionAssessment = normalizePositions({
    market,
    omsPositions,
    providerPositions,
    blockers,
  });

  const acknowledgementAssessment = assessAcknowledgements({
    acknowledgements,
    omsById,
    nowMs,
    blockers,
  });

  const emergencyIntents = [];
  for (const position of positionAssessment.untracked) {
    emergencyIntents.push(emergencyIntent(market, position, `UNTRACKED_PROVIDER_POSITION:${position.key}`));
  }
  for (const recovery of positionAssessment.recoveries) {
    if (recovery.providerQuantity != null && recovery.providerQuantity > recovery.omsQuantity + EPSILON) {
      emergencyIntents.push(emergencyIntent(
        market,
        {
          symbol: recovery.symbol,
          direction: recovery.direction,
          quantity: recovery.providerQuantity,
        },
        `POSITION_FORWARD_EXPOSURE:${recovery.positionId}`,
      ));
    }
  }

  const manualOmsApplyRequired = orderRecoveries.some((order) => order.manualOmsApplyRequired);
  const exposureObserved = omsPositions.length > 0 || providerPositions.length > 0;
  const orderPositionRecoveryComplete = blockers.length === 0;
  const state = orderPositionRecoveryComplete
    ? exposureObserved
      ? "ORDER_POSITION_RECOVERED_PROTECTION_GATE_REQUIRED"
      : "RECOVERED_READ_ONLY"
    : "RECONCILIATION_REQUIRED";

  return Object.freeze({
    version: "V1_0",
    state,
    market,
    provider,
    observedAt: new Date(observedMs).toISOString(),
    snapshotAuthenticated: snapshot.authenticated === true,
    orderPositionRecoveryComplete,
    manualOmsApplyRequired,
    requiresV09ProtectionReconciliation: exposureObserved,
    nextRequiredGate: exposureObserved ? "PROVIDER_PROTECTION_RECONCILIATION_V0_9" : null,
    orderRecoveries: Object.freeze(orderRecoveries),
    positionRecoveries: positionAssessment.recoveries,
    acknowledgementAssessment,
    blockers: Object.freeze(blockers),
    emergencyIntents: Object.freeze(emergencyIntents),
    mutatesOms: false,
    automaticOrderResubmission: false,
    automaticCancelReplace: false,
    automaticProtectionResubmission: false,
    brokerNetworkReadPerformed: false,
    privateProviderRequestPerformed: false,
    realOrderSubmitted: false,
    executionAuthority: "NONE",
    newExposureAllowed: false,
    liveActivationAllowed: false,
  });
}
