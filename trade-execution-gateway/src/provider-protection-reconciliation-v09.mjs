const CANONICAL_PROVIDERS = Object.freeze({
  KR_STOCK: "toss",
  US_STOCK: "toss",
  CRYPTO_SPOT: "upbit",
  CRYPTO_FUTURES: "bitget",
});

const EXPOSURE_ORDER_STATES = new Set(["SUBMITTED", "ACCEPTED", "PARTIALLY_FILLED", "FILLED"]);
const ALLOWED_ORDER_STATES = new Set([
  "SUBMITTED",
  "ACCEPTED",
  "PARTIALLY_FILLED",
  "FILLED",
  "CANCELED",
  "REJECTED",
]);
const WORKING_PROTECTION_STATE = "WORKING";
const PROTECTION_TYPES = new Set(["STOP", "STOP_LIMIT", "TRAILING_STOP"]);

export const PROTECTION_RECONCILIATION_V09_CONTRACT = Object.freeze({
  version: "V0_9",
  authority: "CALLER_SUPPLIED_AUTHENTICATED_EVIDENCE_ONLY",
  canonicalProviders: CANONICAL_PROVIDERS,
  providerNativeProtectionRequired: true,
  providerProtectionDurabilityRequired: true,
  authenticatedProtectionReadRequired: true,
  aggregateOrderSnapshotRequired: true,
  aggregatePositionSnapshotRequired: true,
  exactProtectiveOrderIdentityRequired: true,
  staleEvidenceFailsClosed: true,
  futureEvidenceFailsClosed: true,
  untrackedProviderExposureFailsClosed: true,
  brokerNetworkReadPerformed: false,
  privateProviderRequestPerformed: false,
  mutatesOms: false,
  executionAuthority: "NONE",
  liveActivationAllowed: false,
  realOrderSubmitted: false,
});

function asObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function asArray(value, name) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${name} must be an array`);
  }
  return value;
}

function text(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function positive(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
  return n;
}

function nonNegative(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new TypeError(`${name} must be a non-negative finite number`);
  }
  return n;
}

function upper(value, name) {
  return text(value, name).toUpperCase();
}

function lower(value, name) {
  return text(value, name).toLowerCase();
}

function refKey(order, prefix) {
  const brokerOrderId =
    order.brokerOrderId == null ? null : text(order.brokerOrderId, `${prefix}.brokerOrderId`);
  const clientOrderId =
    order.clientOrderId == null ? null : text(order.clientOrderId, `${prefix}.clientOrderId`);
  return { brokerOrderId, clientOrderId };
}

function isSameNumber(a, b) {
  return Object.is(Number(a), Number(b));
}

function protectionSideFor(direction) {
  return direction === "SHORT" ? "BUY" : "SELL";
}

function canonicalPositionDirection(market, direction) {
  const normalized = upper(direction, "position.direction");
  if (market === "CRYPTO_FUTURES") {
    if (normalized !== "LONG" && normalized !== "SHORT") {
      throw new TypeError("futures position.direction must be LONG or SHORT");
    }
    return normalized;
  }
  if (normalized !== "LONG") {
    throw new TypeError(`${market} position.direction must be LONG`);
  }
  return normalized;
}

function snapshotTime(snapshot, nowMs, maxSnapshotAgeMs, blockers) {
  const observedAt = text(snapshot.observedAt, "providerSnapshot.observedAt");
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs)) {
    blockers.push("PROVIDER_SNAPSHOT_TIMESTAMP_INVALID");
    return null;
  }
  if (observedMs > nowMs) {
    blockers.push("PROVIDER_SNAPSHOT_FROM_FUTURE");
  } else if (nowMs - observedMs > maxSnapshotAgeMs) {
    blockers.push("PROVIDER_SNAPSHOT_STALE");
  }
  return new Date(observedMs).toISOString();
}

function capabilityBlockers(capabilities, requiredProtectionTypes) {
  const blockers = [];
  if (capabilities.nativeProtectiveOrderSupported !== true) {
    blockers.push("NATIVE_PROTECTIVE_ORDER_NOT_SUPPORTED");
  }
  if (capabilities.providerPersistsProtectiveOrders !== true) {
    blockers.push("PROVIDER_PROTECTION_DURABILITY_NOT_PROVEN");
  }
  if (capabilities.authenticatedProtectionReadAdapterEnabled !== true) {
    blockers.push("AUTHENTICATED_PROTECTION_READ_ADAPTER_DISABLED");
  }
  const nativeTypes = Array.isArray(capabilities.nativeProtectiveOrderTypes)
    ? new Set(capabilities.nativeProtectiveOrderTypes.map((value) => upper(value, "nativeProtectiveOrderType")))
    : new Set();
  for (const requiredType of requiredProtectionTypes) {
    if (!nativeTypes.has(requiredType)) {
      blockers.push(`NATIVE_PROTECTIVE_ORDER_TYPE_UNSUPPORTED:${requiredType}`);
    }
  }
  return blockers;
}

function addUnique(blockers, blocker) {
  if (!blockers.includes(blocker)) blockers.push(blocker);
}

export function reconcileProviderProtectionSnapshotV09(input) {
  const root = asObject(input, "input");
  const market = upper(root.market, "market");
  if (!(market in CANONICAL_PROVIDERS)) {
    throw new TypeError(`unsupported market: ${market}`);
  }
  const provider = lower(root.provider, "provider");
  const canonicalProvider = CANONICAL_PROVIDERS[market];

  const nowMs =
    root.now == null
      ? Date.now()
      : typeof root.now === "number"
        ? root.now
        : Date.parse(text(root.now, "now"));
  if (!Number.isFinite(nowMs)) throw new TypeError("now is invalid");

  const maxSnapshotAgeMs =
    root.maxSnapshotAgeMs == null ? 15_000 : positive(root.maxSnapshotAgeMs, "maxSnapshotAgeMs");

  const capabilities = asObject(root.providerCapabilities, "providerCapabilities");
  const oms = asObject(root.oms, "oms");
  const snapshot = asObject(root.providerSnapshot, "providerSnapshot");

  const omsOrders = asArray(oms.orders, "oms.orders");
  const omsPositions = asArray(oms.positions, "oms.positions");
  const intents = asArray(oms.protectiveIntents, "oms.protectiveIntents");
  const providerOrders = asArray(snapshot.orders, "providerSnapshot.orders");
  const providerPositions = asArray(snapshot.positions, "providerSnapshot.positions");
  const protectiveOrders = asArray(snapshot.protectiveOrders, "providerSnapshot.protectiveOrders");

  const blockers = [];
  if (provider !== canonicalProvider) {
    blockers.push(`CANONICAL_PROVIDER_MISMATCH:${canonicalProvider}`);
  }
  if (lower(snapshot.provider, "providerSnapshot.provider") !== provider) {
    blockers.push("PROVIDER_SNAPSHOT_PROVIDER_MISMATCH");
  }
  if (upper(snapshot.market, "providerSnapshot.market") !== market) {
    blockers.push("PROVIDER_SNAPSHOT_MARKET_MISMATCH");
  }
  if (snapshot.authenticated !== true) {
    blockers.push("PROVIDER_SNAPSHOT_NOT_AUTHENTICATED");
  }
  if (upper(snapshot.source, "providerSnapshot.source") !== "PROVIDER_AUTHENTICATED_READ") {
    blockers.push("PROVIDER_SNAPSHOT_SOURCE_NOT_AUTHENTICATED_READ");
  }

  const observedAt = snapshotTime(snapshot, nowMs, maxSnapshotAgeMs, blockers);

  const requiredProtectionTypes = new Set();
  const intentByPosition = new Map();
  for (const [index, intent] of intents.entries()) {
    asObject(intent, `oms.protectiveIntents[${index}]`);
    const positionId = text(intent.positionId, `oms.protectiveIntents[${index}].positionId`);
    if (intentByPosition.has(positionId)) {
      blockers.push(`DUPLICATE_PROTECTIVE_INTENT:${positionId}`);
      continue;
    }
    const type = upper(intent.orderType, `oms.protectiveIntents[${index}].orderType`);
    if (!PROTECTION_TYPES.has(type)) {
      blockers.push(`PROTECTIVE_ORDER_TYPE_INVALID:${positionId}`);
    } else {
      requiredProtectionTypes.add(type);
    }
    intentByPosition.set(positionId, {
      positionId,
      clientProtectionId: text(
        intent.clientProtectionId,
        `oms.protectiveIntents[${index}].clientProtectionId`,
      ),
      symbol: upper(intent.symbol, `oms.protectiveIntents[${index}].symbol`),
      side: upper(intent.side, `oms.protectiveIntents[${index}].side`),
      orderType: type,
      quantity: positive(intent.quantity, `oms.protectiveIntents[${index}].quantity`),
      stopPrice:
        intent.stopPrice == null
          ? null
          : positive(intent.stopPrice, `oms.protectiveIntents[${index}].stopPrice`),
    });
  }

  blockers.push(...capabilityBlockers(capabilities, requiredProtectionTypes));

  const providerOrderByBrokerId = new Map();
  const providerOrderByClientId = new Map();
  for (const [index, order] of providerOrders.entries()) {
    asObject(order, `providerSnapshot.orders[${index}]`);
    const refs = refKey(order, `providerSnapshot.orders[${index}]`);
    const status = upper(order.status, `providerSnapshot.orders[${index}].status`);
    if (!ALLOWED_ORDER_STATES.has(status)) {
      blockers.push(`PROVIDER_ORDER_STATE_INVALID:${index}`);
      continue;
    }
    const normalized = {
      ...refs,
      symbol: upper(order.symbol, `providerSnapshot.orders[${index}].symbol`),
      status,
      filledQuantity: nonNegative(
        order.filledQuantity ?? 0,
        `providerSnapshot.orders[${index}].filledQuantity`,
      ),
    };
    if (refs.brokerOrderId) {
      if (providerOrderByBrokerId.has(refs.brokerOrderId)) {
        blockers.push(`DUPLICATE_PROVIDER_BROKER_ORDER:${refs.brokerOrderId}`);
      }
      providerOrderByBrokerId.set(refs.brokerOrderId, normalized);
    }
    if (refs.clientOrderId) {
      if (providerOrderByClientId.has(refs.clientOrderId)) {
        blockers.push(`DUPLICATE_PROVIDER_CLIENT_ORDER:${refs.clientOrderId}`);
      }
      providerOrderByClientId.set(refs.clientOrderId, normalized);
    }
  }

  const matchedProviderOrders = new Set();
  for (const [index, order] of omsOrders.entries()) {
    asObject(order, `oms.orders[${index}]`);
    const refs = refKey(order, `oms.orders[${index}]`);
    const orderId = text(order.orderId, `oms.orders[${index}].orderId`);
    const status = upper(order.status, `oms.orders[${index}].status`);
    if (!ALLOWED_ORDER_STATES.has(status)) {
      blockers.push(`OMS_ORDER_STATE_INVALID:${orderId}`);
      continue;
    }
    if (!refs.brokerOrderId && !refs.clientOrderId) {
      blockers.push(`OMS_ORDER_REFERENCE_MISSING:${orderId}`);
      continue;
    }
    const observed =
      (refs.brokerOrderId && providerOrderByBrokerId.get(refs.brokerOrderId)) ||
      (refs.clientOrderId && providerOrderByClientId.get(refs.clientOrderId));
    if (!observed) {
      blockers.push(`PROVIDER_ORDER_MISSING:${orderId}`);
      continue;
    }
    matchedProviderOrders.add(observed);
    const symbol = upper(order.symbol, `oms.orders[${index}].symbol`);
    if (symbol !== observed.symbol) blockers.push(`ORDER_SYMBOL_MISMATCH:${orderId}`);
    if (status !== observed.status) blockers.push(`ORDER_STATE_MISMATCH:${orderId}`);
    const filled = nonNegative(order.filledQuantity ?? 0, `oms.orders[${index}].filledQuantity`);
    if (!isSameNumber(filled, observed.filledQuantity)) {
      blockers.push(`ORDER_FILLED_QUANTITY_MISMATCH:${orderId}`);
    }
  }

  for (const observed of new Set([...providerOrderByBrokerId.values(), ...providerOrderByClientId.values()])) {
    if (!matchedProviderOrders.has(observed) && EXPOSURE_ORDER_STATES.has(observed.status)) {
      const ref = observed.brokerOrderId || observed.clientOrderId || observed.symbol;
      blockers.push(`UNTRACKED_PROVIDER_ORDER:${ref}`);
    }
  }

  const providerPositionByKey = new Map();
  for (const [index, position] of providerPositions.entries()) {
    asObject(position, `providerSnapshot.positions[${index}]`);
    const symbol = upper(position.symbol, `providerSnapshot.positions[${index}].symbol`);
    const direction = canonicalPositionDirection(market, position.direction);
    const quantity = positive(position.quantity, `providerSnapshot.positions[${index}].quantity`);
    const key = `${symbol}:${direction}`;
    if (providerPositionByKey.has(key)) blockers.push(`DUPLICATE_PROVIDER_POSITION:${key}`);
    providerPositionByKey.set(key, { symbol, direction, quantity });
  }

  const matchedPositionKeys = new Set();
  const normalizedOmsPositions = [];
  for (const [index, position] of omsPositions.entries()) {
    asObject(position, `oms.positions[${index}]`);
    const positionId = text(position.positionId, `oms.positions[${index}].positionId`);
    const symbol = upper(position.symbol, `oms.positions[${index}].symbol`);
    const direction = canonicalPositionDirection(market, position.direction);
    const quantity = positive(position.quantity, `oms.positions[${index}].quantity`);
    const key = `${symbol}:${direction}`;
    const observed = providerPositionByKey.get(key);
    if (!observed) {
      blockers.push(`PROVIDER_POSITION_MISSING:${positionId}`);
    } else {
      matchedPositionKeys.add(key);
      if (!isSameNumber(quantity, observed.quantity)) {
        blockers.push(`POSITION_QUANTITY_MISMATCH:${positionId}`);
      }
    }
    normalizedOmsPositions.push({ positionId, symbol, direction, quantity });
  }

  for (const [key] of providerPositionByKey) {
    if (!matchedPositionKeys.has(key)) {
      blockers.push(`UNTRACKED_PROVIDER_POSITION:${key}`);
    }
  }

  const protectionById = new Map();
  for (const [index, protection] of protectiveOrders.entries()) {
    asObject(protection, `providerSnapshot.protectiveOrders[${index}]`);
    const clientProtectionId = text(
      protection.clientProtectionId,
      `providerSnapshot.protectiveOrders[${index}].clientProtectionId`,
    );
    if (protectionById.has(clientProtectionId)) {
      blockers.push(`DUPLICATE_PROVIDER_PROTECTION:${clientProtectionId}`);
    }
    protectionById.set(clientProtectionId, {
      clientProtectionId,
      providerOrderId: text(
        protection.providerOrderId,
        `providerSnapshot.protectiveOrders[${index}].providerOrderId`,
      ),
      symbol: upper(protection.symbol, `providerSnapshot.protectiveOrders[${index}].symbol`),
      side: upper(protection.side, `providerSnapshot.protectiveOrders[${index}].side`),
      orderType: upper(
        protection.orderType,
        `providerSnapshot.protectiveOrders[${index}].orderType`,
      ),
      quantity: positive(protection.quantity, `providerSnapshot.protectiveOrders[${index}].quantity`),
      stopPrice:
        protection.stopPrice == null
          ? null
          : positive(protection.stopPrice, `providerSnapshot.protectiveOrders[${index}].stopPrice`),
      status: upper(protection.status, `providerSnapshot.protectiveOrders[${index}].status`),
      persistenceConfirmed: protection.persistenceConfirmed === true,
      serverHeld: protection.serverHeld === true,
    });
  }

  const matchedProtectionIds = new Set();
  for (const position of normalizedOmsPositions) {
    const intent = intentByPosition.get(position.positionId);
    if (!intent) {
      blockers.push(`PROTECTIVE_INTENT_MISSING:${position.positionId}`);
      continue;
    }
    if (intent.symbol !== position.symbol) {
      blockers.push(`PROTECTION_SYMBOL_MISMATCH:${position.positionId}`);
    }
    const expectedSide = protectionSideFor(position.direction);
    if (intent.side !== expectedSide) {
      blockers.push(`PROTECTION_SIDE_INVALID:${position.positionId}`);
    }
    if (!isSameNumber(intent.quantity, position.quantity)) {
      blockers.push(`PROTECTION_INTENT_QUANTITY_MISMATCH:${position.positionId}`);
    }

    const observed = protectionById.get(intent.clientProtectionId);
    if (!observed) {
      blockers.push(`PROVIDER_PROTECTION_MISSING:${position.positionId}`);
      continue;
    }
    matchedProtectionIds.add(observed.clientProtectionId);
    if (observed.symbol !== position.symbol) blockers.push(`PROVIDER_PROTECTION_SYMBOL_MISMATCH:${position.positionId}`);
    if (observed.side !== expectedSide) blockers.push(`PROVIDER_PROTECTION_SIDE_MISMATCH:${position.positionId}`);
    if (observed.orderType !== intent.orderType) blockers.push(`PROVIDER_PROTECTION_TYPE_MISMATCH:${position.positionId}`);
    if (!isSameNumber(observed.quantity, position.quantity)) blockers.push(`PROVIDER_PROTECTION_QUANTITY_MISMATCH:${position.positionId}`);
    if (!isSameNumber(observed.stopPrice, intent.stopPrice)) blockers.push(`PROVIDER_PROTECTION_STOP_MISMATCH:${position.positionId}`);
    if (observed.status !== WORKING_PROTECTION_STATE) blockers.push(`PROVIDER_PROTECTION_NOT_WORKING:${position.positionId}`);
    if (!observed.persistenceConfirmed) blockers.push(`PROVIDER_PROTECTION_PERSISTENCE_NOT_CONFIRMED:${position.positionId}`);
    if (!observed.serverHeld) blockers.push(`PROVIDER_PROTECTION_NOT_SERVER_HELD:${position.positionId}`);
  }

  for (const [protectionId] of protectionById) {
    if (!matchedProtectionIds.has(protectionId)) {
      blockers.push(`UNTRACKED_PROVIDER_PROTECTION:${protectionId}`);
    }
  }

  for (const positionId of intentByPosition.keys()) {
    if (!normalizedOmsPositions.some((position) => position.positionId === positionId)) {
      blockers.push(`ORPHAN_PROTECTIVE_INTENT:${positionId}`);
    }
  }

  const dedupedBlockers = [];
  for (const blocker of blockers) addUnique(dedupedBlockers, blocker);
  const evidenceReady = dedupedBlockers.length === 0;

  return Object.freeze({
    version: "V0_9",
    state: evidenceReady ? "RECONCILED" : "RECONCILIATION_REQUIRED",
    market,
    provider,
    canonicalProvider,
    observedAt,
    blockers: Object.freeze(dedupedBlockers),
    matched: Object.freeze({
      omsOrders: omsOrders.length,
      providerOrders: providerOrders.length,
      omsPositions: omsPositions.length,
      providerPositions: providerPositions.length,
      protectiveIntents: intents.length,
      providerProtectiveOrders: protectiveOrders.length,
    }),
    futureUnattendedLiveContractSatisfied: evidenceReady,
    futureNewExposureEvidenceReady: evidenceReady,
    newExposureAllowed: false,
    reductionOrExitAllowed: true,
    liveActivationAllowed: false,
    executionAuthority: "NONE",
    brokerNetworkReadPerformed: false,
    privateProviderRequestPerformed: false,
    realOrderSubmitted: false,
    mutatesOms: false,
  });
}
