import { GatewayError } from "./gateway.mjs";

const WORKSPACE_MARKET_MAP = Object.freeze({
  KR: "KR_STOCK",
  US: "US_STOCK",
});

const WORKSPACE_SIDE_MAP = Object.freeze({
  buy: "BUY",
  sell: "SELL",
});

const WORKSPACE_ORDER_TYPE_MAP = Object.freeze({
  limit: "LIMIT",
  market: "MARKET",
});

function positiveFinite(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function requiredText(value, name, max = 128) {
  if (typeof value !== "string") {
    throw new GatewayError("INVALID_WORKSPACE_ORDER", `${name} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new GatewayError("INVALID_WORKSPACE_ORDER", `${name} is invalid`);
  }
  return normalized;
}

function bridgePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new GatewayError("INVALID_WORKSPACE_ORDER", "workspace payload must be an object");
  }
  const order = payload.order ?? payload;
  if (!order || typeof order !== "object" || Array.isArray(order)) {
    throw new GatewayError("INVALID_WORKSPACE_ORDER", "workspace order must be an object");
  }
  return { payload, order };
}

export function workspaceOrderToPaperIntent(payload) {
  const { payload: envelope, order } = bridgePayload(payload);

  const workspaceMarket = requiredText(order.market, "market", 16).toUpperCase();
  const market = WORKSPACE_MARKET_MAP[workspaceMarket];
  if (!market) {
    throw new GatewayError(
      "UNSUPPORTED_WORKSPACE_MARKET",
      `workspace market ${workspaceMarket} is not supported by the isolated stock bridge`,
    );
  }

  const rawSide = requiredText(order.side, "side", 16).toLowerCase();
  const side = WORKSPACE_SIDE_MAP[rawSide];
  if (!side) {
    throw new GatewayError("UNSUPPORTED_WORKSPACE_SIDE", `unsupported workspace side: ${rawSide}`);
  }

  const rawOrderType = requiredText(order.orderType, "orderType", 16).toLowerCase();
  const orderType = WORKSPACE_ORDER_TYPE_MAP[rawOrderType];
  if (!orderType) {
    throw new GatewayError(
      "UNSUPPORTED_WORKSPACE_ORDER_TYPE",
      `unsupported workspace order type: ${rawOrderType}`,
    );
  }

  const quantity = positiveFinite(order.quantity);
  if (quantity === null) {
    throw new GatewayError("INVALID_WORKSPACE_QUANTITY", "workspace quantity must be positive");
  }

  const symbol = requiredText(order.ticker, "ticker", 64).toUpperCase();
  const idempotencyKey = requiredText(envelope.idempotencyKey, "idempotencyKey", 128);
  if (idempotencyKey.length < 8 || !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)) {
    throw new GatewayError(
      "INVALID_WORKSPACE_IDEMPOTENCY_KEY",
      "workspace idempotencyKey must be 8-128 safe characters",
    );
  }

  const limitPrice = orderType === "LIMIT" ? positiveFinite(order.price) : null;
  if (orderType === "LIMIT" && limitPrice === null) {
    throw new GatewayError("INVALID_WORKSPACE_LIMIT_PRICE", "workspace LIMIT order requires price");
  }

  const referencePrice = orderType === "MARKET" ? positiveFinite(envelope.referencePrice) : null;
  if (orderType === "MARKET" && referencePrice === null) {
    throw new GatewayError(
      "WORKSPACE_REFERENCE_PRICE_REQUIRED",
      "workspace MARKET order requires explicit current referencePrice; the bridge never invents market price",
    );
  }

  return Object.freeze({
    mode: "PAPER",
    market,
    symbol,
    side,
    orderType,
    quantity,
    limitPrice,
    referencePrice,
    idempotencyKey,
  });
}

export async function previewWorkspaceOrder(gateway, payload) {
  if (!gateway || typeof gateway.previewOrder !== "function") {
    throw new GatewayError("INVALID_GATEWAY", "workspace bridge requires TradeExecutionGateway", 500);
  }
  const intent = workspaceOrderToPaperIntent(payload);
  const preview = await gateway.previewOrder(intent);
  return {
    ...preview,
    source: "AI_TRADING_WORKSPACE_V1",
    workspaceOrderSubmitted: false,
    realOrderSubmitted: false,
    privateTradingRequestSent: false,
  };
}

export async function placeWorkspacePaperOrder(gateway, payload) {
  if (!gateway || typeof gateway.placeOrder !== "function") {
    throw new GatewayError("INVALID_GATEWAY", "workspace bridge requires TradeExecutionGateway", 500);
  }
  const { payload: envelope } = bridgePayload(payload);
  if (envelope.confirmPaper !== true) {
    throw new GatewayError(
      "PAPER_CONFIRMATION_REQUIRED",
      "workspace OMS recording requires explicit confirmPaper=true",
      409,
    );
  }

  const intent = workspaceOrderToPaperIntent(payload);
  const result = await gateway.placeOrder(intent);
  return {
    ...result,
    source: "AI_TRADING_WORKSPACE_V1",
    paperConfirmation: "EXPLICIT",
    realOrderSubmitted: false,
    privateTradingRequestSent: false,
  };
}
