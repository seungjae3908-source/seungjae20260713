export const PROTECTION_STATES = Object.freeze({
  UNPROTECTED: "UNPROTECTED",
  PENDING_ACK: "PENDING_ACK",
  PROTECTED: "PROTECTED",
  PROTECTION_UNKNOWN: "PROTECTION_UNKNOWN",
  RECONCILIATION_REQUIRED: "RECONCILIATION_REQUIRED",
});

export const PAPER_MOCK_PROTECTION_CAPABILITIES = Object.freeze({
  paperProtectiveOrderSimulationSupported: true,
  nativeProtectiveOrderSupported: false,
  nativeProtectiveOrderTypes: Object.freeze([]),
  providerPersistsProtectiveOrders: false,
  authenticatedProtectionReadAdapterEnabled: false,
  liveTrading: false,
  privateTradingApiAllowed: false,
  outboundNetwork: false,
});

const EXPOSED_ORDER_STATES = new Set(["PARTIALLY_FILLED", "FILLED"]);
const VALID_PROTECTION_STATES = new Set(Object.values(PROTECTION_STATES));
const EPSILON = 1e-12;

export class ServerFailureProtectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ServerFailureProtectionError";
    this.code = code;
  }
}

function text(value, name, max = 128) {
  if (typeof value !== "string") throw new ServerFailureProtectionError("PROTECTION_INPUT_INVALID", `${name} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new ServerFailureProtectionError("PROTECTION_INPUT_INVALID", `${name} is invalid`);
  return normalized;
}

function positive(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new ServerFailureProtectionError("PROTECTION_INPUT_INVALID", `${name} must be positive`);
  }
  return number;
}

function instant(value, name) {
  const parsed = Date.parse(String(value ?? ""));
  if (!Number.isFinite(parsed)) throw new ServerFailureProtectionError("PROTECTION_TIMESTAMP_INVALID", `${name} is invalid`);
  return parsed;
}

function bool(value) {
  return value === true;
}

function capabilities(raw = {}) {
  return Object.freeze({
    paperProtectiveOrderSimulationSupported: bool(raw.paperProtectiveOrderSimulationSupported),
    nativeProtectiveOrderSupported: bool(raw.nativeProtectiveOrderSupported),
    nativeProtectiveOrderTypes: Object.freeze(Array.isArray(raw.nativeProtectiveOrderTypes)
      ? [...new Set(raw.nativeProtectiveOrderTypes.map((value) => String(value).trim().toUpperCase()).filter(Boolean))]
      : []),
    providerPersistsProtectiveOrders: bool(raw.providerPersistsProtectiveOrders),
    authenticatedProtectionReadAdapterEnabled: bool(raw.authenticatedProtectionReadAdapterEnabled),
    liveTrading: bool(raw.liveTrading),
    privateTradingApiAllowed: bool(raw.privateTradingApiAllowed),
    outboundNetwork: bool(raw.outboundNetwork),
  });
}

function assertPaperEntryOrder(order) {
  if (!order || typeof order !== "object" || Array.isArray(order) || order.simulated !== true) {
    throw new ServerFailureProtectionError("PAPER_ENTRY_ORDER_REQUIRED", "a simulated Paper entry order is required");
  }
  if (order.realOrderSubmitted !== false || order.privateTradingRequestSent !== false) {
    throw new ServerFailureProtectionError("UNSAFE_ENTRY_ORDER_REJECTED", "entry order contains live/private authority");
  }
  const status = text(order.status, "entryOrder.status", 32).toUpperCase();
  if (!EXPOSED_ORDER_STATES.has(status)) {
    throw new ServerFailureProtectionError("ENTRY_EXPOSURE_NOT_ESTABLISHED", "protection intent requires a partially or fully filled entry");
  }
  const filledQuantity = positive(order.filledQuantity, "entryOrder.filledQuantity");
  return { status, filledQuantity };
}

function assertBracketIdentity(order, bracketPlan, filledQuantity) {
  if (!bracketPlan || typeof bracketPlan !== "object" || bracketPlan.type !== "BRACKET_OCO_PREVIEW_V1") {
    throw new ServerFailureProtectionError("BRACKET_PROTECTION_REQUIRED", "a BRACKET_OCO_PREVIEW_V1 plan is required");
  }
  if (bracketPlan.executionMode !== "PAPER_ONLY" || bracketPlan.executionAuthority !== "NONE" || bracketPlan.childOrdersSubmitted !== false) {
    throw new ServerFailureProtectionError("UNSAFE_BRACKET_PLAN_REJECTED", "bracket plan must remain a non-executing Paper preview");
  }
  const market = text(order.intent?.market, "entryOrder.intent.market", 32).toUpperCase();
  const symbol = text(order.intent?.symbol, "entryOrder.intent.symbol", 64).toUpperCase();
  const side = text(order.intent?.side, "entryOrder.intent.side", 16).toUpperCase();
  if (
    text(bracketPlan.market, "bracketPlan.market", 32).toUpperCase() !== market
    || text(bracketPlan.symbol, "bracketPlan.symbol", 64).toUpperCase() !== symbol
    || text(bracketPlan.side, "bracketPlan.side", 16).toUpperCase() !== side
  ) {
    throw new ServerFailureProtectionError("PROTECTION_IDENTITY_MISMATCH", "bracket protection identity does not match the filled entry");
  }
  const quantity = positive(bracketPlan.quantity, "bracketPlan.quantity");
  if (quantity > filledQuantity + EPSILON) {
    throw new ServerFailureProtectionError("PROTECTION_QUANTITY_EXCEEDS_EXPOSURE", "protection quantity cannot exceed filled exposure");
  }
  return {
    market,
    symbol,
    side,
    quantity,
    stopPrice: positive(bracketPlan.stopPrice, "bracketPlan.stopPrice"),
    targetPrice: positive(bracketPlan.targetPrice, "bracketPlan.targetPrice"),
  };
}

export function buildProtectionIntent({ entryOrder, bracketPlan, protectionIdempotencyKey, createdAt } = {}) {
  const { filledQuantity } = assertPaperEntryOrder(entryOrder);
  const identity = assertBracketIdentity(entryOrder, bracketPlan, filledQuantity);
  const idempotencyKey = text(protectionIdempotencyKey, "protectionIdempotencyKey", 128);
  if (!/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)) {
    throw new ServerFailureProtectionError("PROTECTION_IDEMPOTENCY_INVALID", "protection idempotency key contains unsupported characters");
  }
  const createdMs = instant(createdAt, "createdAt");
  return Object.freeze({
    schemaVersion: 1,
    kind: "ENTRY_PROTECTION_INTENT_V1",
    state: PROTECTION_STATES.PENDING_ACK,
    entryOrderId: text(entryOrder.orderId, "entryOrder.orderId"),
    protectionIdempotencyKey: idempotencyKey,
    market: identity.market,
    symbol: identity.symbol,
    side: identity.side,
    quantity: identity.quantity,
    stopPrice: identity.stopPrice,
    targetPrice: identity.targetPrice,
    requestedProtectionType: "STOP_MARKET_OR_PROVIDER_NATIVE_EQUIVALENT",
    createdAt: new Date(createdMs).toISOString(),
    acknowledgement: null,
    paperProtectionProven: false,
    providerNativeProtectionProven: false,
    providerPersistenceProven: false,
    executionMode: "PAPER_ONLY",
    executionAuthority: "NONE",
    automaticExecutionPerformed: false,
    privateApiUsed: false,
    realOrderSubmitted: false,
    unattendedLiveEligible: false,
  });
}

export function acknowledgePaperProtection({ intent, evidence, providerCapabilities = PAPER_MOCK_PROTECTION_CAPABILITIES } = {}) {
  if (!intent || intent.kind !== "ENTRY_PROTECTION_INTENT_V1" || !VALID_PROTECTION_STATES.has(intent.state)) {
    throw new ServerFailureProtectionError("PROTECTION_INTENT_INVALID", "protection intent is invalid");
  }
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new ServerFailureProtectionError("PROTECTION_ACK_EVIDENCE_REQUIRED", "protection acknowledgement evidence is required");
  }
  if (evidence.serverAttested === true || evidence.providerNative === true || evidence.realExchangeOrder === true) {
    throw new ServerFailureProtectionError("CALLER_PROTECTION_ATTESTATION_FORBIDDEN", "Paper evidence cannot self-assert native/server protection");
  }
  const caps = capabilities(providerCapabilities);
  if (!caps.paperProtectiveOrderSimulationSupported) {
    throw new ServerFailureProtectionError("PAPER_PROTECTION_SIMULATION_UNSUPPORTED", "adapter does not support Paper protective-order simulation");
  }
  if (evidence.simulated !== true || evidence.durable !== true || evidence.privateApiUsed === true) {
    throw new ServerFailureProtectionError("PAPER_PROTECTION_ACK_INVALID", "Paper protection acknowledgement must be durable simulated evidence with no private API");
  }
  if (text(evidence.entryOrderId, "evidence.entryOrderId") !== intent.entryOrderId) {
    throw new ServerFailureProtectionError("PROTECTION_ACK_IDENTITY_MISMATCH", "protection acknowledgement references a different entry order");
  }
  if (text(evidence.protectionIdempotencyKey, "evidence.protectionIdempotencyKey") !== intent.protectionIdempotencyKey) {
    throw new ServerFailureProtectionError("PROTECTION_ACK_IDEMPOTENCY_MISMATCH", "protection acknowledgement idempotency does not match");
  }
  const stopPrice = positive(evidence.stopPrice, "evidence.stopPrice");
  if (Math.abs(stopPrice - intent.stopPrice) > EPSILON) {
    throw new ServerFailureProtectionError("PROTECTION_ACK_STOP_MISMATCH", "acknowledged stop price does not match requested stop price");
  }
  const observedMs = instant(evidence.observedAt, "evidence.observedAt");
  const acknowledgementId = text(evidence.acknowledgementId, "evidence.acknowledgementId");
  if (intent.state === PROTECTION_STATES.PROTECTED && intent.acknowledgement?.acknowledgementId === acknowledgementId) {
    return intent;
  }
  return Object.freeze({
    ...intent,
    state: PROTECTION_STATES.PROTECTED,
    acknowledgement: Object.freeze({
      acknowledgementId,
      protectionOrderId: text(evidence.protectionOrderId, "evidence.protectionOrderId"),
      observedAt: new Date(observedMs).toISOString(),
      stopPrice,
      simulated: true,
      durable: true,
      providerNative: false,
      realExchangeOrder: false,
      privateApiUsed: false,
    }),
    paperProtectionProven: true,
    providerNativeProtectionProven: false,
    providerPersistenceProven: false,
    unattendedLiveEligible: false,
  });
}

export function recoverProtectionAfterRestart(protection) {
  if (!protection || protection.kind !== "ENTRY_PROTECTION_INTENT_V1") {
    throw new ServerFailureProtectionError("PROTECTION_INTENT_INVALID", "protection intent is invalid");
  }
  if (protection.state === PROTECTION_STATES.PENDING_ACK) {
    return Object.freeze({
      ...protection,
      state: PROTECTION_STATES.RECONCILIATION_REQUIRED,
      restartReason: "CRASH_OR_RESTART_BEFORE_PROTECTION_ACK",
      unattendedLiveEligible: false,
    });
  }
  if (protection.state === PROTECTION_STATES.PROTECTED && protection.paperProtectionProven === true) {
    return Object.freeze({ ...protection, unattendedLiveEligible: false, paperRestartContinuity: "DURABLE_LOCAL_SIMULATION_ONLY" });
  }
  return Object.freeze({
    ...protection,
    state: PROTECTION_STATES.RECONCILIATION_REQUIRED,
    restartReason: "PROTECTION_STATE_REQUIRES_EXTERNAL_RECONCILIATION",
    unattendedLiveEligible: false,
  });
}

export function reconcileProtectionEvidence({ protection, observedProtection, providerCapabilities = {}, observedAt } = {}) {
  if (!protection || protection.kind !== "ENTRY_PROTECTION_INTENT_V1") {
    throw new ServerFailureProtectionError("PROTECTION_INTENT_INVALID", "protection intent is invalid");
  }
  const caps = capabilities(providerCapabilities);
  const observedMs = instant(observedAt, "observedAt");
  if (!observedProtection) {
    return Object.freeze({
      reconciled: false,
      state: PROTECTION_STATES.RECONCILIATION_REQUIRED,
      blockers: Object.freeze(["PROTECTIVE_ORDER_EVIDENCE_REQUIRED"]),
      observedAt: new Date(observedMs).toISOString(),
      mutatesOms: false,
      brokerNetworkRead: false,
      unattendedLiveEligible: false,
    });
  }
  if (observedProtection.serverAttested === true && observedProtection.sourceAuthority !== "SERVER_AUTHENTICATED_READ_ADAPTER") {
    throw new ServerFailureProtectionError("CALLER_PROTECTION_ATTESTATION_FORBIDDEN", "caller cannot self-assert server protection evidence");
  }
  const blockers = [];
  if (text(observedProtection.entryOrderId, "observedProtection.entryOrderId") !== protection.entryOrderId) blockers.push("ENTRY_ORDER_ID_MISMATCH");
  if (Math.abs(positive(observedProtection.stopPrice, "observedProtection.stopPrice") - protection.stopPrice) > EPSILON) blockers.push("STOP_PRICE_MISMATCH");
  if (observedProtection.active !== true) blockers.push("PROTECTIVE_ORDER_NOT_ACTIVE");
  const isNativeEvidence = observedProtection.providerNative === true;
  if (isNativeEvidence) {
    if (!caps.nativeProtectiveOrderSupported) blockers.push("PROVIDER_NATIVE_PROTECTION_UNSUPPORTED");
    if (!caps.providerPersistsProtectiveOrders) blockers.push("PROVIDER_PROTECTION_DURABILITY_UNPROVEN");
    if (!caps.authenticatedProtectionReadAdapterEnabled) blockers.push("AUTHENTICATED_PROTECTION_READ_ADAPTER_DISABLED");
    if (observedProtection.sourceAuthority !== "SERVER_AUTHENTICATED_READ_ADAPTER") blockers.push("PROTECTION_EVIDENCE_AUTHORITY_INVALID");
  } else if (observedProtection.simulated !== true) {
    blockers.push("PROTECTION_EVIDENCE_NOT_SIMULATED_OR_NATIVE");
  }
  const reconciled = blockers.length === 0;
  return Object.freeze({
    reconciled,
    state: reconciled ? PROTECTION_STATES.PROTECTED : PROTECTION_STATES.PROTECTION_UNKNOWN,
    blockers: Object.freeze(blockers),
    observedAt: new Date(observedMs).toISOString(),
    providerNativeProtectionProven: reconciled && isNativeEvidence,
    providerPersistenceProven: reconciled && isNativeEvidence && caps.providerPersistsProtectiveOrders,
    mutatesOms: false,
    brokerNetworkRead: false,
    unattendedLiveEligible: false,
  });
}

function heartbeatAssessment(heartbeat, policy, nowMs) {
  const timeoutMs = positive(policy?.heartbeatTimeoutMs, "policy.heartbeatTimeoutMs");
  const maxFutureSkewMs = policy?.maxFutureSkewMs == null ? 5_000 : positive(policy.maxFutureSkewMs, "policy.maxFutureSkewMs");
  if (!heartbeat || typeof heartbeat !== "object") {
    return { fresh: false, ageMs: null, blocker: "SUPERVISOR_HEARTBEAT_MISSING" };
  }
  text(heartbeat.ownerId, "heartbeat.ownerId");
  text(heartbeat.leaseId, "heartbeat.leaseId");
  const observedMs = instant(heartbeat.observedAt, "heartbeat.observedAt");
  if (observedMs - nowMs > maxFutureSkewMs) return { fresh: false, ageMs: nowMs - observedMs, blocker: "SUPERVISOR_HEARTBEAT_FROM_FUTURE" };
  const ageMs = nowMs - observedMs;
  return ageMs <= timeoutMs
    ? { fresh: true, ageMs, blocker: null }
    : { fresh: false, ageMs, blocker: "SUPERVISOR_HEARTBEAT_STALE" };
}

export function assessUnattendedProtection({ orders = [], protections = [], heartbeat, policy, nowMs = Date.now() } = {}) {
  if (!Number.isFinite(nowMs) || nowMs <= 0) throw new ServerFailureProtectionError("PROTECTION_TIMESTAMP_INVALID", "nowMs is invalid");
  if (!Array.isArray(orders) || !Array.isArray(protections)) throw new ServerFailureProtectionError("PROTECTION_INPUT_INVALID", "orders and protections must be arrays");
  const heartbeatState = heartbeatAssessment(heartbeat, policy, nowMs);
  const blockers = [];
  if (!heartbeatState.fresh) blockers.push(heartbeatState.blocker);

  const protectionByEntry = new Map();
  const duplicateProtectionIds = new Set();
  for (const protection of protections) {
    if (!protection || protection.kind !== "ENTRY_PROTECTION_INTENT_V1") continue;
    if (protectionByEntry.has(protection.entryOrderId)) duplicateProtectionIds.add(protection.entryOrderId);
    else protectionByEntry.set(protection.entryOrderId, protection);
  }
  for (const id of duplicateProtectionIds) blockers.push(`DUPLICATE_PROTECTION_RECORD:${id}`);

  const emergencyIntents = [];
  let exposedPositions = 0;
  let protectedPositions = 0;
  for (const order of orders) {
    if (!order || typeof order !== "object" || order.simulated !== true) continue;
    const status = String(order.status ?? "").toUpperCase();
    const filledQuantity = Number(order.filledQuantity ?? 0);
    if (!EXPOSED_ORDER_STATES.has(status) || !Number.isFinite(filledQuantity) || filledQuantity <= 0 || order.positionClosed === true) continue;
    exposedPositions += 1;
    const protection = protectionByEntry.get(order.orderId);
    const protectedNow = protection?.state === PROTECTION_STATES.PROTECTED && protection.paperProtectionProven === true;
    if (protectedNow) {
      protectedPositions += 1;
      continue;
    }
    const reason = !protection
      ? "UNPROTECTED_POSITION"
      : protection.state === PROTECTION_STATES.PENDING_ACK
        ? "PROTECTION_ACK_PENDING"
        : protection.state === PROTECTION_STATES.RECONCILIATION_REQUIRED
          ? "PROTECTION_RECONCILIATION_REQUIRED"
          : "PROTECTION_UNKNOWN";
    blockers.push(`${reason}:${order.orderId}`);
    emergencyIntents.push(Object.freeze({
      type: "REDUCE_OR_CLOSE_SIMULATION_ONLY",
      entryOrderId: order.orderId,
      market: order.intent?.market ?? null,
      symbol: order.intent?.symbol ?? null,
      side: order.intent?.side ?? null,
      quantity: filledQuantity,
      reason,
      automaticExecutionPerformed: false,
      executionAuthority: "NONE",
      privateApiUsed: false,
      realOrderSubmitted: false,
    }));
  }

  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  return Object.freeze({
    paperUnattendedEntryAllowed: uniqueBlockers.length === 0,
    newEntryAllowed: uniqueBlockers.length === 0,
    unattendedLiveEligible: false,
    heartbeat: Object.freeze(heartbeatState),
    exposedPositions,
    protectedPositions,
    unprotectedPositions: exposedPositions - protectedPositions,
    blockers: uniqueBlockers,
    emergencyIntents: Object.freeze(emergencyIntents),
    automaticEmergencyExecutionPerformed: false,
    executionAuthority: "NONE",
    liveTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
  });
}

export function evaluateProviderNativeProtectionReadiness(providerCapabilities = {}) {
  const caps = capabilities(providerCapabilities);
  const blockers = [];
  if (!caps.nativeProtectiveOrderSupported) blockers.push("PROVIDER_NATIVE_PROTECTION_UNSUPPORTED");
  if (!caps.providerPersistsProtectiveOrders) blockers.push("PROVIDER_PROTECTION_DURABILITY_UNPROVEN");
  if (!caps.authenticatedProtectionReadAdapterEnabled) blockers.push("AUTHENTICATED_PROTECTION_READ_ADAPTER_DISABLED");
  if (caps.liveTrading !== false) blockers.push("LIVE_RUNTIME_MUST_REMAIN_DISABLED_DURING_VALIDATION");
  if (caps.privateTradingApiAllowed !== false) blockers.push("PRIVATE_TRADING_API_MUST_REMAIN_DISABLED_DURING_VALIDATION");
  return Object.freeze({
    structurallyReadyForFutureUnattendedLiveReview: blockers.length === 0,
    activationAllowed: false,
    unattendedLiveEligible: false,
    blockers: Object.freeze(blockers),
    executionAuthority: "NONE",
  });
}
