import { GatewayError } from "./gateway.mjs";
import { validateMarketRuleEvidence } from "./market-rules.mjs";
import { evaluatePortfolioRisk } from "./portfolio-risk.mjs";

const PROVIDERS = Object.freeze({
  CRYPTO_SPOT: "upbit",
  CRYPTO_FUTURES: "bitget",
});

const SIDES = Object.freeze({
  CRYPTO_SPOT: new Set(["BUY", "SELL"]),
  CRYPTO_FUTURES: new Set(["LONG", "SHORT"]),
});

function text(value, name, max = 128) {
  if (typeof value !== "string") {
    throw new GatewayError("INVALID_COIN_ORDER", `${name} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new GatewayError("INVALID_COIN_ORDER", `${name} is invalid`);
  }
  return normalized;
}

function positive(value, code, message) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new GatewayError(code, message);
  return number;
}

export function coinOrderToPaperIntent(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new GatewayError("INVALID_COIN_ORDER", "coin order payload must be an object");
  }
  const order = payload.order;
  if (!order || typeof order !== "object" || Array.isArray(order)) {
    throw new GatewayError("INVALID_COIN_ORDER", "coin order is required");
  }

  const market = text(order.market, "market", 32).toUpperCase();
  if (!(market in PROVIDERS)) {
    throw new GatewayError("UNSUPPORTED_COIN_MARKET", `unsupported coin market: ${market}`);
  }

  const provider = text(payload.provider, "provider", 32).toLowerCase();
  if (provider !== PROVIDERS[market]) {
    throw new GatewayError(
      "CANONICAL_PROVIDER_MISMATCH",
      `${market} requires canonical provider ${PROVIDERS[market]}`,
    );
  }

  const side = text(order.side, "side", 16).toUpperCase();
  if (!SIDES[market].has(side)) {
    throw new GatewayError("UNSUPPORTED_COIN_SIDE", `${side} is not allowed for ${market}`);
  }

  const orderType = text(order.orderType, "orderType", 16).toUpperCase();
  if (!["LIMIT", "MARKET"].includes(orderType)) {
    throw new GatewayError("UNSUPPORTED_COIN_ORDER_TYPE", `unsupported order type: ${orderType}`);
  }

  const symbol = text(order.symbol, "symbol", 64).toUpperCase();
  const quantity = positive(order.quantity, "INVALID_COIN_QUANTITY", "coin quantity must be positive");
  const idempotencyKey = text(payload.idempotencyKey, "idempotencyKey", 128);
  if (idempotencyKey.length < 8 || !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)) {
    throw new GatewayError("INVALID_COIN_IDEMPOTENCY_KEY", "coin idempotencyKey is invalid");
  }

  const limitPrice = orderType === "LIMIT"
    ? positive(order.price, "INVALID_COIN_LIMIT_PRICE", "LIMIT coin order requires price")
    : null;
  const referencePrice = orderType === "MARKET"
    ? positive(payload.referencePrice, "COIN_REFERENCE_PRICE_REQUIRED", "MARKET coin order requires referencePrice")
    : null;

  let leverage = 1;
  let marginMode = null;
  let reduceOnly = false;
  if (market === "CRYPTO_FUTURES") {
    leverage = positive(payload.leverage, "FUTURES_LEVERAGE_REQUIRED", "futures leverage is required");
    marginMode = text(payload.marginMode, "marginMode", 16).toUpperCase();
    if (!["ISOLATED", "CROSS"].includes(marginMode)) {
      throw new GatewayError("UNSUPPORTED_MARGIN_MODE", `unsupported margin mode: ${marginMode}`);
    }
    if (payload.reduceOnly != null && typeof payload.reduceOnly !== "boolean") {
      throw new GatewayError("INVALID_REDUCE_ONLY", "reduceOnly must be boolean");
    }
    reduceOnly = payload.reduceOnly === true;
  } else if (payload.leverage != null && Number(payload.leverage) !== 1) {
    throw new GatewayError("SPOT_LEVERAGE_NOT_ALLOWED", "crypto spot does not accept leverage");
  }

  return Object.freeze({
    mode: "PAPER",
    market,
    provider,
    symbol,
    side,
    orderType,
    quantity,
    limitPrice,
    referencePrice,
    leverage,
    marginMode,
    reduceOnly,
    ...(market === "CRYPTO_FUTURES" && reduceOnly !== true && payload.capitalValuationEvidence != null
      ? { capitalValuationEvidence: payload.capitalValuationEvidence }
      : {}),
    idempotencyKey,
  });
}

export function preflightCoinOrder(payload, options = {}) {
  const intent = coinOrderToPaperIntent(payload);
  const marketRules = validateMarketRuleEvidence(intent, payload.marketRules, options);
  const portfolioRisk = evaluatePortfolioRisk(
    {
      intent,
      orderNotional: marketRules.checkedNotional,
      snapshot: payload.portfolioSnapshot,
      policy: payload.portfolioPolicy,
      killSwitch: payload.killSwitch,
    },
    options,
  );
  return Object.freeze({
    accepted: true,
    source: "COIN_TRADING_WORKSPACE_V1",
    intent,
    marketRules,
    portfolioRisk,
    orderSubmitted: false,
    realOrderSubmitted: false,
    privateTradingRequestSent: false,
  });
}

export async function previewCoinPaperOrder(gateway, payload, options = {}) {
  if (!gateway || typeof gateway.previewOrder !== "function") {
    throw new GatewayError("INVALID_GATEWAY", "coin bridge requires TradeExecutionGateway", 500);
  }
  const preflight = preflightCoinOrder(payload, options);
  const gatewayPreview = await gateway.previewOrder(preflight.intent);
  return {
    ...preflight,
    gatewayPreview,
    orderSubmitted: false,
    realOrderSubmitted: false,
    privateTradingRequestSent: false,
  };
}

export async function placeCoinPaperOrder(gateway, payload, options = {}) {
  if (!gateway || typeof gateway.placeOrder !== "function") {
    throw new GatewayError("INVALID_GATEWAY", "coin bridge requires TradeExecutionGateway", 500);
  }
  if (payload?.confirmPaper !== true) {
    throw new GatewayError(
      "PAPER_CONFIRMATION_REQUIRED",
      "coin OMS recording requires explicit confirmPaper=true",
      409,
    );
  }
  const preflight = preflightCoinOrder(payload, options);
  const result = await gateway.placeOrder(preflight.intent);
  return {
    ...result,
    source: "COIN_TRADING_WORKSPACE_V1",
    marketRules: preflight.marketRules,
    portfolioRisk: preflight.portfolioRisk,
    paperConfirmation: "EXPLICIT",
    realOrderSubmitted: false,
    privateTradingRequestSent: false,
  };
}
