import { randomUUID } from "node:crypto";
import {
  FUTURES_MARGIN_MODES,
  MARKETS,
  ORDER_STATES,
  ORDER_TYPES,
  SAFETY_CONTRACT,
  sidesForMarket,
} from "./contracts.mjs";

export class GatewayError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

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
    return Object.freeze({
      provider,
      leverage: 1,
      marginMode: null,
      reduceOnly: false,
    });
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
  return Object.freeze({
    provider,
    leverage,
    marginMode,
    reduceOnly: input.reduceOnly === true,
  });
}

function normalizeOrderIntent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new GatewayError("INVALID_ORDER_INTENT", "order intent must be an object");
  }

  const mode = requireString(input.mode, "mode").toUpperCase();
  if (mode !== "PAPER") {
    throw new GatewayError(
      "LIVE_TRADING_DISABLED",
      "standalone gateway accepts PAPER orders only",
      403,
    );
  }

  const market = requireString(input.market, "market").toUpperCase();
  if (!MARKETS.includes(market)) {
    throw new GatewayError("UNSUPPORTED_MARKET", `unsupported market: ${market}`);
  }

  const side = requireString(input.side, "side").toUpperCase();
  if (!sidesForMarket(market).includes(side)) {
    throw new GatewayError(
      "UNSUPPORTED_SIDE",
      `${side} is not allowed for ${market}`,
    );
  }

  const orderType = requireString(input.orderType, "orderType").toUpperCase();
  if (!ORDER_TYPES.includes(orderType)) {
    throw new GatewayError("UNSUPPORTED_ORDER_TYPE", `unsupported order type: ${orderType}`);
  }

  const symbol = requireString(input.symbol, "symbol", 1, 64).toUpperCase();
  const idempotencyKey = requireString(input.idempotencyKey, "idempotencyKey", 8, 128);
  if (!/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)) {
    throw new GatewayError(
      "INVALID_IDEMPOTENCY_KEY",
      "idempotencyKey contains unsupported characters",
    );
  }

  const quantity = finitePositive(input.quantity);
  if (quantity === null) {
    throw new GatewayError("INVALID_QUANTITY", "quantity must be a positive finite number");
  }

  const limitPrice = input.limitPrice == null ? null : finitePositive(input.limitPrice);
  const referencePrice = input.referencePrice == null ? null : finitePositive(input.referencePrice);
  if (orderType === "LIMIT" && limitPrice === null) {
    throw new GatewayError("INVALID_LIMIT_PRICE", "LIMIT order requires limitPrice");
  }
  if (orderType === "MARKET" && referencePrice === null) {
    throw new GatewayError(
      "REFERENCE_PRICE_REQUIRED",
      "PAPER MARKET order requires referencePrice for bounded risk preview",
    );
  }

  const executionContext = normalizeExecutionContext(input, market);

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
    executionContext,
  });
}

function validateRisk(intent, policy) {
  const maxQuantity = finitePositive(policy?.maxQuantityByMarket?.[intent.market]);
  const maxNotional = finitePositive(policy?.maxNotionalByMarket?.[intent.market]);
  if (maxQuantity === null || maxNotional === null) {
    throw new GatewayError(
      "RISK_POLICY_NOT_CONFIGURED",
      `paper risk policy is not configured for ${intent.market}`,
      503,
    );
  }

  if (intent.quantity > maxQuantity) {
    throw new GatewayError("MAX_QUANTITY_EXCEEDED", "order quantity exceeds paper risk limit");
  }

  const riskPrice = intent.orderType === "LIMIT" ? intent.limitPrice : intent.referencePrice;
  const notional = intent.quantity * riskPrice;
  if (!Number.isFinite(notional) || notional <= 0) {
    throw new GatewayError("INVALID_NOTIONAL", "order notional is invalid");
  }
  if (notional > maxNotional) {
    throw new GatewayError("MAX_NOTIONAL_EXCEEDED", "order notional exceeds paper risk limit");
  }

  return Object.freeze({
    accepted: true,
    notional,
    riskPrice,
    maxQuantity,
    maxNotional,
    liveAuthorityGranted: false,
  });
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
    throw new GatewayError(
      "UNSAFE_ADAPTER_REJECTED",
      "standalone gateway rejects live/private/network broker adapters",
      503,
    );
  }
  for (const method of ["previewOrder", "submitOrder", "cancelOrder", "getOrder"]) {
    if (typeof adapter[method] !== "function") {
      throw new GatewayError("INVALID_ADAPTER", `broker adapter missing ${method}`, 500);
    }
  }
  return capabilities;
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

  async previewOrder(intent, risk) {
    return {
      providerId: "paper-mock",
      accepted: true,
      simulated: true,
      fillAssumption: "NONE",
      intent,
      risk,
    };
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
    if (!current) {
      throw new GatewayError("BROKER_ORDER_NOT_FOUND", "paper broker order not found", 404);
    }
    if ([ORDER_STATES.CANCELED, ORDER_STATES.FILLED].includes(current.status)) {
      return current;
    }
    const canceled = {
      ...current,
      status: ORDER_STATES.CANCELED,
      canceledAt: new Date().toISOString(),
    };
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
  #orders = new Map();
  #idempotency = new Map();

  constructor({ adapter = new PaperMockBrokerAdapter(), policy = {} } = {}) {
    assertSafeAdapter(adapter);
    this.#adapter = adapter;
    this.#policy = policy;
  }

  getSafetyState() {
    return {
      ...SAFETY_CONTRACT,
      adapter: this.#adapter.getCapabilities(),
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
      return this.#orders.get(existingId);
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
      createdAt: new Date().toISOString(),
      intent,
      risk,
    };
    this.#orders.set(orderId, created);
    this.#idempotency.set(intent.idempotencyKey, orderId);

    try {
      const brokerOrder = await this.#adapter.submitOrder(intent, risk);
      const accepted = {
        ...created,
        status: brokerOrder.status ?? ORDER_STATES.SUBMITTED,
        brokerOrderId: brokerOrder.brokerOrderId,
        broker: brokerOrder,
      };
      this.#orders.set(orderId, accepted);
      return accepted;
    } catch (error) {
      const rejected = {
        ...created,
        status: ORDER_STATES.REJECTED,
        rejectionCode: error instanceof GatewayError ? error.code : "PAPER_ADAPTER_ERROR",
      };
      this.#orders.set(orderId, rejected);
      throw error;
    }
  }

  async cancelOrder(orderId) {
    const order = this.#orders.get(orderId);
    if (!order) {
      throw new GatewayError("ORDER_NOT_FOUND", "order not found", 404);
    }
    if (!order.brokerOrderId) {
      throw new GatewayError("ORDER_NOT_CANCELABLE", "paper order has no broker id", 409);
    }
    const brokerOrder = await this.#adapter.cancelOrder(order.brokerOrderId);
    const updated = {
      ...order,
      status: brokerOrder.status,
      broker: brokerOrder,
      realOrderSubmitted: false,
      privateTradingRequestSent: false,
    };
    this.#orders.set(orderId, updated);
    return updated;
  }

  async getOrder(orderId) {
    const order = this.#orders.get(orderId);
    if (!order) {
      throw new GatewayError("ORDER_NOT_FOUND", "order not found", 404);
    }
    return order;
  }
}
