import { randomUUID } from "node:crypto";
import {
  FUTURES_MARGIN_MODES,
  MARKETS,
  ORDER_STATES,
  ORDER_TYPES,
  SAFETY_CONTRACT,
  sidesForMarket,
} from "./contracts.mjs";
import { applyPaperFillTransition, PaperLifecycleError } from "./order-lifecycle.mjs";
import {
  KrwValuationEvidenceError,
  normalizeCapitalValuationEvidence,
} from "./krw-valuation-evidence-v11.mjs";

export class GatewayError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

const RECOVERY_HOLD_STATES = new Set([
  ORDER_STATES.CREATED,
  ORDER_STATES.RISK_ACCEPTED,
  ORDER_STATES.SUBMITTED,
]);

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function requireString(value, name, min = 1, max = 128) {
  if (typeof value !== "string") {
    throw new GatewayError("INVALID_ORDER_INTENT", `${name} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) {
    throw new GatewayError("INVALID_ORDER_INTENT", `${name} length is invalid`);
  }
  return normalized;
}

function optionalProvider(value) {
  if (value == null) return null;
  return requireString(value, "provider", 1, 64).toLowerCase();
}

function normalizeExecutionContext(input, market) {
  const provider = optionalProvider(input.provider);
  if (market !== "CRYPTO_FUTURES") {
    if (input.leverage != null && Number(input.leverage) !== 1) {
      throw new GatewayError("LEVERAGE_NOT_ALLOWED", `${market} does not accept leveraged order intent`);
    }
    if (input.marginMode != null) {
      throw new GatewayError("MARGIN_MODE_NOT_ALLOWED", `${market} does not accept margin mode`);
    }
    if (input.reduceOnly === true) {
      throw new GatewayError("REDUCE_ONLY_NOT_ALLOWED", `${market} does not accept reduceOnly`);
    }
    return Object.freeze({ provider, leverage: 1, marginMode: null, reduceOnly: false });
  }

  const leverage = finitePositive(input.leverage);
  if (leverage === null) {
    throw new GatewayError("FUTURES_LEVERAGE_REQUIRED", "CRYPTO_FUTURES requires positive leverage");
  }
  const marginMode = requireString(input.marginMode, "marginMode", 4, 16).toUpperCase();
  if (!FUTURES_MARGIN_MODES.includes(marginMode)) {
    throw new GatewayError("UNSUPPORTED_MARGIN_MODE", `unsupported margin mode: ${marginMode}`);
  }
  if (input.reduceOnly != null && typeof input.reduceOnly !== "boolean") {
    throw new GatewayError("INVALID_REDUCE_ONLY", "reduceOnly must be boolean when provided");
  }
  return Object.freeze({ provider, leverage, marginMode, reduceOnly: input.reduceOnly === true });
}

function needsForeignCapitalValuation(market, side, executionContext) {
  if (market === "US_STOCK") return side !== "SELL";
  if (market === "CRYPTO_FUTURES") return executionContext.reduceOnly !== true;
  return false;
}

function normalizeOrderIntent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new GatewayError("INVALID_ORDER_INTENT", "order intent must be an object");
  }

  const mode = requireString(input.mode, "mode").toUpperCase();
  if (mode !== "PAPER") {
    throw new GatewayError("LIVE_TRADING_DISABLED", "standalone gateway accepts PAPER orders only", 403);
  }

  const market = requireString(input.market, "market").toUpperCase();
  if (!MARKETS.includes(market)) throw new GatewayError("UNSUPPORTED_MARKET", `unsupported market: ${market}`);

  const side = requireString(input.side, "side").toUpperCase();
  if (!sidesForMarket(market).includes(side)) {
    throw new GatewayError("UNSUPPORTED_SIDE", `${side} is not allowed for ${market}`);
  }

  const orderType = requireString(input.orderType, "orderType").toUpperCase();
  if (!ORDER_TYPES.includes(orderType)) throw new GatewayError("UNSUPPORTED_ORDER_TYPE", `unsupported order type: ${orderType}`);

  const symbol = requireString(input.symbol, "symbol", 1, 64).toUpperCase();
  const idempotencyKey = requireString(input.idempotencyKey, "idempotencyKey", 8, 128);
  if (!/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)) {
    throw new GatewayError("INVALID_IDEMPOTENCY_KEY", "idempotencyKey contains unsupported characters");
  }

  const quantity = finitePositive(input.quantity);
  if (quantity === null) throw new GatewayError("INVALID_QUANTITY", "quantity must be a positive finite number");

  const limitPrice = input.limitPrice == null ? null : finitePositive(input.limitPrice);
  const referencePrice = input.referencePrice == null ? null : finitePositive(input.referencePrice);
  if (orderType === "LIMIT" && limitPrice === null) throw new GatewayError("INVALID_LIMIT_PRICE", "LIMIT order requires limitPrice");
  if (orderType === "MARKET" && referencePrice === null) {
    throw new GatewayError("REFERENCE_PRICE_REQUIRED", "PAPER MARKET order requires referencePrice for bounded risk preview");
  }

  const executionContext = normalizeExecutionContext(input, market);
  let capitalValuationEvidence = null;
  if (
    needsForeignCapitalValuation(market, side, executionContext)
    && input.capitalValuationEvidence != null
  ) {
    try {
      capitalValuationEvidence = normalizeCapitalValuationEvidence(
        input.capitalValuationEvidence,
        { market, symbol },
      );
    } catch (error) {
      if (error instanceof KrwValuationEvidenceError) {
        throw new GatewayError(error.code, error.message, error.statusCode);
      }
      throw error;
    }
  }

  return Object.freeze({
    mode,
    market,
    side,
    orderType,
    symbol,
    idempotencyKey,
    quantity,
    limitPrice,
    referencePrice,
    ...(capitalValuationEvidence == null ? {} : { capitalValuationEvidence }),
    executionContext,
  });
}

function validateRisk(intent, policy) {
  const maxQuantity = finitePositive(policy?.maxQuantityByMarket?.[intent.market]);
  const maxNotional = finitePositive(policy?.maxNotionalByMarket?.[intent.market]);
  if (maxQuantity === null || maxNotional === null) {
    throw new GatewayError("RISK_POLICY_NOT_CONFIGURED", `paper risk policy is not configured for ${intent.market}`, 503);
  }
  if (intent.quantity > maxQuantity) throw new GatewayError("MAX_QUANTITY_EXCEEDED", "order quantity exceeds paper risk limit");

  const riskPrice = intent.orderType === "LIMIT" ? intent.limitPrice : intent.referencePrice;
  const notional = intent.quantity * riskPrice;
  if (!Number.isFinite(notional) || notional <= 0) throw new GatewayError("INVALID_NOTIONAL", "order notional is invalid");
  if (notional > maxNotional) throw new GatewayError("MAX_NOTIONAL_EXCEEDED", "order notional exceeds paper risk limit");

  return Object.freeze({ accepted: true, notional, riskPrice, maxQuantity, maxNotional, liveAuthorityGranted: false });
}

function assertSafeAdapter(adapter) {
  if (!adapter || typeof adapter.getCapabilities !== "function") {
    throw new GatewayError("INVALID_ADAPTER", "broker adapter is missing capabilities", 500);
  }
  const capabilities = adapter.getCapabilities();
  if (
    !capabilities ||
    capabilities.executionMode !== "PAPER_ONLY" ||
    capabilities.liveTrading === true ||
    capabilities.privateTradingApiAllowed === true ||
    capabilities.outboundNetwork === true
  ) {
    throw new GatewayError("UNSAFE_ADAPTER_REJECTED", "standalone gateway rejects live/private/network broker adapters", 503);
  }
  for (const method of ["previewOrder", "submitOrder", "cancelOrder", "getOrder"]) {
    if (typeof adapter[method] !== "function") throw new GatewayError("INVALID_ADAPTER", `broker adapter missing ${method}`, 500);
  }
  return capabilities;
}

function safeRestoredOrder(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new GatewayError("PAPER_STATE_ORDER_INVALID", "restored paper order must be an object", 503);
  }
  if (
    raw.simulated !== true ||
    raw.realOrderSubmitted !== false ||
    raw.privateTradingRequestSent !== false ||
    String(raw.intent?.mode ?? "").toUpperCase() !== "PAPER"
  ) {
    throw new GatewayError("UNSAFE_PAPER_STATE_REJECTED", "restored state contains non-Paper execution authority", 503);
  }
  if (typeof raw.orderId !== "string" || !raw.orderId || typeof raw.intent?.idempotencyKey !== "string" || !raw.intent.idempotencyKey) {
    throw new GatewayError("PAPER_STATE_ORDER_INVALID", "restored paper order identity is invalid", 503);
  }
  const cloned = structuredClone(raw);
  if (RECOVERY_HOLD_STATES.has(cloned.status)) {
    cloned.recoveryHold = true;
    cloned.recoveryReason = "INTERRUPTED_BEFORE_DURABLE_ACCEPT";
  }
  return cloned;
}

function restorePaperState(snapshot) {
  if (snapshot == null) return { orders: new Map(), idempotency: new Map(), restoredOrders: 0, interruptedOrders: 0 };
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || snapshot.schemaVersion !== 1 || snapshot.mode !== "PAPER_ONLY") {
    throw new GatewayError("PAPER_STATE_SCHEMA_MISMATCH", "restored paper state schema is unsupported", 503);
  }
  if (!Array.isArray(snapshot.orders) || !Array.isArray(snapshot.idempotency)) {
    throw new GatewayError("PAPER_STATE_INVALID", "restored paper state must include orders and idempotency arrays", 503);
  }

  const orders = new Map();
  let interruptedOrders = 0;
  for (const raw of snapshot.orders) {
    const order = safeRestoredOrder(raw);
    if (orders.has(order.orderId)) throw new GatewayError("PAPER_STATE_ORDER_ID_CONFLICT", "duplicate restored order id", 503);
    if (order.recoveryHold === true) interruptedOrders += 1;
    orders.set(order.orderId, order);
  }

  const idempotency = new Map();
  const mappedOrders = new Set();
  for (const entry of snapshot.idempotency) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new GatewayError("PAPER_STATE_IDEMPOTENCY_INVALID", "invalid restored idempotency entry", 503);
    const [key, orderId] = entry;
    const order = orders.get(orderId);
    if (
      typeof key !== "string" || !key || !order || order.intent.idempotencyKey !== key ||
      idempotency.has(key) || mappedOrders.has(orderId)
    ) {
      throw new GatewayError("PAPER_STATE_IDEMPOTENCY_CONFLICT", "restored idempotency state is inconsistent", 503);
    }
    idempotency.set(key, orderId);
    mappedOrders.add(orderId);
  }
  if (mappedOrders.size !== orders.size) {
    throw new GatewayError("PAPER_STATE_IDEMPOTENCY_INCOMPLETE", "every restored order must have durable idempotency mapping", 503);
  }

  return { orders, idempotency, restoredOrders: orders.size, interruptedOrders };
}

export class PaperMockBrokerAdapter {
  #orders = new Map();
  #submissionCount = 0;

  get submissionCount() {
    return this.#submissionCount;
  }

  getCapabilities() {
    return {
      providerId: "paper-mock",
      executionMode: "PAPER_ONLY",
      liveTrading: false,
      privateTradingApiAllowed: false,
      outboundNetwork: false,
      persistence: "MEMORY_ONLY",
    };
  }

  restoreFromOmsOrders(orders) {
    for (const order of orders ?? []) {
      if (!order || order.simulated !== true || order.realOrderSubmitted !== false || order.privateTradingRequestSent !== false) {
        throw new GatewayError("UNSAFE_PAPER_STATE_REJECTED", "paper adapter refused unsafe restored order", 503);
      }
      if (!order.brokerOrderId || order.recoveryHold === true) continue;
      const brokerOrder = order.broker && typeof order.broker === "object"
        ? structuredClone(order.broker)
        : {
            brokerOrderId: order.brokerOrderId,
            status: order.status,
            simulated: true,
            fillEvidence: null,
            submittedAt: order.createdAt ?? null,
            intent: structuredClone(order.intent),
          };
      brokerOrder.brokerOrderId = order.brokerOrderId;
      brokerOrder.simulated = true;
      this.#orders.set(order.brokerOrderId, brokerOrder);
    }
  }

  async previewOrder(intent, risk) {
    return { providerId: "paper-mock", accepted: true, simulated: true, fillAssumption: "NONE", intent, risk };
  }

  async submitOrder(intent) {
    this.#submissionCount += 1;
    const brokerOrderId = `paper-${randomUUID()}`;
    const brokerOrder = {
      brokerOrderId,
      status: ORDER_STATES.ACCEPTED,
      simulated: true,
      fillEvidence: null,
      submittedAt: new Date().toISOString(),
      intent,
    };
    this.#orders.set(brokerOrderId, brokerOrder);
    return brokerOrder;
  }

  async cancelOrder(brokerOrderId) {
    const current = this.#orders.get(brokerOrderId);
    if (!current) throw new GatewayError("BROKER_ORDER_NOT_FOUND", "paper broker order not found", 404);
    if ([ORDER_STATES.CANCELED, ORDER_STATES.FILLED].includes(current.status)) return current;
    const canceled = { ...current, status: ORDER_STATES.CANCELED, canceledAt: new Date().toISOString() };
    this.#orders.set(brokerOrderId, canceled);
    return canceled;
  }

  async getOrder(brokerOrderId) {
    return this.#orders.get(brokerOrderId) ?? null;
  }
}

export class TradeExecutionGateway {
  #adapter;
  #policy;
  #orders;
  #idempotency;
  #persistPaperState;
  #recovery;

  constructor({
    adapter = new PaperMockBrokerAdapter(),
    policy = {},
    initialPaperState = null,
    persistPaperState = null,
  } = {}) {
    assertSafeAdapter(adapter);
    if (persistPaperState != null && typeof persistPaperState !== "function") {
      throw new GatewayError("PAPER_STATE_PERSISTENCE_INVALID", "persistPaperState must be a function", 500);
    }
    const restored = restorePaperState(initialPaperState);
    this.#adapter = adapter;
    this.#policy = policy;
    this.#orders = restored.orders;
    this.#idempotency = restored.idempotency;
    this.#persistPaperState = persistPaperState;
    this.#recovery = {
      restoredOrders: restored.restoredOrders,
      interruptedOrders: restored.interruptedOrders,
      automaticResubmissions: 0,
      persistenceEnabled: persistPaperState != null,
    };
    if (typeof adapter.restoreFromOmsOrders === "function") {
      adapter.restoreFromOmsOrders([...this.#orders.values()]);
    }
  }

  exportPaperState() {
    return {
      schemaVersion: 1,
      mode: "PAPER_ONLY",
      orders: [...this.#orders.values()].map((order) => structuredClone(order)),
      idempotency: [...this.#idempotency.entries()].map((entry) => [...entry]),
    };
  }

  getRecoveryState() {
    return Object.freeze({ ...this.#recovery, automaticResubmissions: 0 });
  }

  async #persist(reason) {
    if (!this.#persistPaperState) return null;
    try {
      return await this.#persistPaperState(this.exportPaperState(), reason);
    } catch (error) {
      throw new GatewayError(
        "PAPER_STATE_PERSIST_FAILED",
        `durable Paper state persistence failed: ${error?.code ?? error?.message ?? "unknown"}`,
        503,
      );
    }
  }

  getSafetyState() {
    return {
      ...SAFETY_CONTRACT,
      adapter: this.#adapter.getCapabilities(),
      persistenceEnabled: this.#persistPaperState != null,
      recovery: this.getRecoveryState(),
      riskConfiguredMarkets: MARKETS.filter(
        (market) =>
          finitePositive(this.#policy?.maxQuantityByMarket?.[market]) !== null &&
          finitePositive(this.#policy?.maxNotionalByMarket?.[market]) !== null,
      ),
    };
  }

  async previewOrder(input) {
    const intent = normalizeOrderIntent(input);
    const risk = validateRisk(intent, this.#policy);
    const adapterPreview = await this.#adapter.previewOrder(intent, risk);
    return {
      accepted: true,
      mode: "PAPER",
      intent,
      risk,
      adapterPreview,
      orderSubmitted: false,
      realOrderSubmitted: false,
    };
  }

  async placeOrder(input) {
    const intent = normalizeOrderIntent(input);
    const existingId = this.#idempotency.get(intent.idempotencyKey);
    if (existingId) {
      const existing = this.#orders.get(existingId);
      if (!existing) throw new GatewayError("PAPER_STATE_IDEMPOTENCY_CONFLICT", "idempotency mapping references a missing order", 503);
      return existing;
    }

    const risk = validateRisk(intent, this.#policy);
    assertSafeAdapter(this.#adapter);

    const orderId = `teg-${randomUUID()}`;
    const created = {
      orderId,
      status: ORDER_STATES.RISK_ACCEPTED,
      simulated: true,
      realOrderSubmitted: false,
      privateTradingRequestSent: false,
      recoveryHold: false,
      createdAt: new Date().toISOString(),
      intent,
      risk,
    };
    this.#orders.set(orderId, created);
    this.#idempotency.set(intent.idempotencyKey, orderId);
    await this.#persist("ORDER_CREATED_BEFORE_ADAPTER");

    try {
      const brokerOrder = await this.#adapter.submitOrder(intent, risk);
      const accepted = {
        ...created,
        status: brokerOrder.status ?? ORDER_STATES.SUBMITTED,
        brokerOrderId: brokerOrder.brokerOrderId,
        broker: brokerOrder,
        filledQuantity: 0,
        remainingQuantity: intent.quantity,
        averageFillPrice: null,
        paperFillEvidence: [],
      };
      this.#orders.set(orderId, accepted);
      await this.#persist("ORDER_ACCEPTED");
      return accepted;
    } catch (error) {
      if (error instanceof GatewayError && error.code === "PAPER_STATE_PERSIST_FAILED") throw error;
      const rejected = {
        ...created,
        status: ORDER_STATES.REJECTED,
        rejectionCode: error instanceof GatewayError ? error.code : "PAPER_ADAPTER_ERROR",
      };
      this.#orders.set(orderId, rejected);
      await this.#persist("ORDER_REJECTED");
      throw error;
    }
  }

  async applyPaperFill(orderId, fill) {
    const order = this.#orders.get(orderId);
    if (!order) throw new GatewayError("ORDER_NOT_FOUND", "order not found", 404);
    if (order.recoveryHold === true) {
      throw new GatewayError("RECOVERY_HOLD_REQUIRES_REVIEW", "interrupted Paper order requires reconciliation before mutation", 409);
    }
    try {
      const updated = applyPaperFillTransition(order, fill);
      this.#orders.set(orderId, updated);
      await this.#persist("PAPER_FILL_APPLIED");
      return updated;
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      if (error instanceof PaperLifecycleError) throw new GatewayError(error.code, error.message, 409);
      throw error;
    }
  }

  async cancelOrder(orderId) {
    const order = this.#orders.get(orderId);
    if (!order) throw new GatewayError("ORDER_NOT_FOUND", "order not found", 404);
    if (order.recoveryHold === true) {
      throw new GatewayError("RECOVERY_HOLD_REQUIRES_REVIEW", "interrupted Paper order requires reconciliation before cancellation", 409);
    }
    if (order.status === ORDER_STATES.CANCELED) return order;
    if ([ORDER_STATES.FILLED, ORDER_STATES.REJECTED].includes(order.status)) {
      throw new GatewayError("ORDER_NOT_CANCELABLE", `paper order is already ${order.status}`, 409);
    }
    if (!order.brokerOrderId) throw new GatewayError("ORDER_NOT_CANCELABLE", "paper order has no broker id", 409);
    const brokerOrder = await this.#adapter.cancelOrder(order.brokerOrderId);
    const updated = {
      ...order,
      status: brokerOrder.status,
      broker: brokerOrder,
      realOrderSubmitted: false,
      privateTradingRequestSent: false,
    };
    this.#orders.set(orderId, updated);
    await this.#persist("PAPER_ORDER_CANCELED");
    return updated;
  }

  async getOrder(orderId) {
    const order = this.#orders.get(orderId);
    if (!order) throw new GatewayError("ORDER_NOT_FOUND", "order not found", 404);
    return order;
  }
}
