import { GatewayError } from "./gateway.mjs";

function requireObject(value, code, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GatewayError(code, message);
  return value;
}

function text(value, name, max = 128) {
  if (typeof value !== "string") throw new GatewayError("INVALID_ORDER_PLAN", `${name} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new GatewayError("INVALID_ORDER_PLAN", `${name} is invalid`);
  return normalized;
}

function positive(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new GatewayError("INVALID_ORDER_PLAN", `${name} must be positive`);
  return number;
}

function safeBase(type) {
  return Object.freeze({
    type,
    executionMode: "PAPER_ONLY",
    executionAuthority: "NONE",
    autoSubmit: false,
    privateTradingApiAllowed: false,
    outboundNetwork: false,
    requiresExplicitConfirmation: true,
    requiresFreshRiskRevalidation: true,
    requiresFreshExecutionGuardRevalidation: true,
  });
}

export function buildCancelReplacePlan(input) {
  requireObject(input, "INVALID_CANCEL_REPLACE_PLAN", "cancel/replace input is required");
  const order = requireObject(input.order, "INVALID_CANCEL_REPLACE_PLAN", "existing Paper order is required");
  const replacement = requireObject(
    input.replacementIntent,
    "INVALID_CANCEL_REPLACE_PLAN",
    "replacement Paper intent is required",
  );
  if (order.simulated !== true || !new Set(["ACCEPTED", "PARTIALLY_FILLED"]).has(order.status)) {
    throw new GatewayError("ORDER_NOT_REPLACEABLE", "only active simulated Paper orders can be replaced", 409);
  }
  if (String(replacement.mode ?? "").toUpperCase() !== "PAPER") {
    throw new GatewayError("LIVE_TRADING_DISABLED", "replacement intent must remain PAPER", 403);
  }
  if (
    String(replacement.market ?? "").toUpperCase() !== String(order.intent?.market ?? "").toUpperCase()
    || String(replacement.symbol ?? "").toUpperCase() !== String(order.intent?.symbol ?? "").toUpperCase()
  ) {
    throw new GatewayError(
      "REPLACEMENT_IDENTITY_MISMATCH",
      "cancel/replace cannot change market or symbol identity",
    );
  }
  const replacementKey = text(replacement.idempotencyKey, "replacement idempotencyKey");
  if (replacementKey === order.intent?.idempotencyKey) {
    throw new GatewayError("REPLACEMENT_IDEMPOTENCY_REUSE", "replacement requires a new idempotency key");
  }

  return Object.freeze({
    ...safeBase("CANCEL_REPLACE_PREVIEW_V1"),
    state: "AWAITING_EXPLICIT_CANCEL_CONFIRMATION",
    orderId: text(order.orderId, "orderId"),
    replacementIntent: Object.freeze({ ...replacement }),
    steps: Object.freeze([
      "CANCEL_ORIGINAL_PAPER_ORDER",
      "VERIFY_ORIGINAL_CANCELED",
      "REVALIDATE_PUBLIC_MARKET_DATA",
      "REVALIDATE_RISK_AND_EXECUTION_GUARDS",
      "SUBMIT_REPLACEMENT_PAPER_ORDER_AFTER_CONFIRMATION",
    ]),
    automaticCancelPerformed: false,
    replacementSubmitted: false,
  });
}

export function buildBracketPlan(input) {
  requireObject(input, "INVALID_BRACKET_PLAN", "bracket input is required");
  const market = text(input.market, "market", 32).toUpperCase();
  const symbol = text(input.symbol, "symbol", 64).toUpperCase();
  const side = text(input.side, "side", 16).toUpperCase();
  if (!new Set(["BUY", "LONG", "SHORT"]).has(side)) {
    throw new GatewayError("BRACKET_SIDE_UNSUPPORTED", "bracket entry supports BUY/LONG/SHORT only");
  }
  const quantity = positive(input.quantity, "quantity");
  const entryPrice = positive(input.entryPrice, "entryPrice");
  const targetPrice = positive(input.targetPrice, "targetPrice");
  const stopPrice = positive(input.stopPrice, "stopPrice");

  if (side === "SHORT") {
    if (!(targetPrice < entryPrice && stopPrice > entryPrice)) {
      throw new GatewayError("INVALID_BRACKET_PRICES", "SHORT requires target < entry < stop");
    }
  } else if (!(stopPrice < entryPrice && targetPrice > entryPrice)) {
    throw new GatewayError("INVALID_BRACKET_PRICES", "BUY/LONG requires stop < entry < target");
  }

  return Object.freeze({
    ...safeBase("BRACKET_OCO_PREVIEW_V1"),
    market,
    symbol,
    side,
    quantity,
    entryPrice,
    targetPrice,
    stopPrice,
    childOrderState: "INACTIVE_UNTIL_ENTRY_FILLED",
    ocoMutualCancelIntent: true,
    exitIntent: "REDUCE_OR_CLOSE_POSITION_ONLY",
    childOrdersSubmitted: false,
  });
}

export function buildTrailingPlan(input) {
  requireObject(input, "INVALID_TRAILING_PLAN", "trailing input is required");
  const market = text(input.market, "market", 32).toUpperCase();
  const symbol = text(input.symbol, "symbol", 64).toUpperCase();
  const side = text(input.side, "side", 16).toUpperCase();
  if (!new Set(["BUY", "LONG", "SHORT"]).has(side)) {
    throw new GatewayError("TRAILING_SIDE_UNSUPPORTED", "trailing plan supports BUY/LONG/SHORT positions");
  }
  const activationPrice = positive(input.activationPrice, "activationPrice");
  const hasDistance = input.trailDistance != null;
  const hasPercent = input.trailPercent != null;
  if (hasDistance === hasPercent) {
    throw new GatewayError("INVALID_TRAILING_DISTANCE", "provide exactly one of trailDistance or trailPercent");
  }
  const trailDistance = hasDistance ? positive(input.trailDistance, "trailDistance") : null;
  const trailPercent = hasPercent ? positive(input.trailPercent, "trailPercent") : null;
  if (trailPercent !== null && trailPercent >= 100) {
    throw new GatewayError("INVALID_TRAILING_DISTANCE", "trailPercent must be below 100");
  }

  return Object.freeze({
    ...safeBase("TRAILING_STOP_PREVIEW_V1"),
    market,
    symbol,
    side,
    activationPrice,
    trailDistance,
    trailPercent,
    runtimeActivation: false,
    requiresFutureObservedPublicPrice: true,
    orderSubmitted: false,
  });
}
