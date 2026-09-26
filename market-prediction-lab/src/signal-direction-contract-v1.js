export const SIGNAL_DIRECTIONS = Object.freeze(["BUY", "SELL", "LONG", "SHORT", "NO_TRADE", "UNKNOWN"]);
export const EXECUTION_INTENTS = Object.freeze(["ENTER", "EXIT", "REDUCE", "HOLD", "NONE"]);
export const POSITION_SIDES = Object.freeze(["LONG", "SHORT", "FLAT"]);
export const SIGNAL_LIFECYCLES = Object.freeze(["NEW", "ACTIVE", "STALE", "EXPIRED", "ENTERED_PAPER", "SETTLED", "INVALIDATED"]);

const DIRECTION_SET = new Set(SIGNAL_DIRECTIONS);
const POSITION_SET = new Set(POSITION_SIDES);
const LIFECYCLE_SET = new Set(SIGNAL_LIFECYCLES);
const CASH_MARKETS = new Set(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT"]);
const FUTURES_MARKETS = new Set(["CRYPTO_FUTURES"]);
const MARKET_DIRECTIONS = Object.freeze({
  KR_STOCK: Object.freeze(["BUY", "SELL", "NO_TRADE"]),
  US_STOCK: Object.freeze(["BUY", "SELL", "NO_TRADE"]),
  CRYPTO_SPOT: Object.freeze(["BUY", "SELL", "NO_TRADE"]),
  CRYPTO_FUTURES: Object.freeze(["LONG", "SHORT", "NO_TRADE"]),
});

function freeze(value) { return Object.freeze(value); }
function finite(value) { return typeof value === "number" && Number.isFinite(value); }

export function normalizeSignalDirection(value) {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  return DIRECTION_SET.has(normalized) ? normalized : "UNKNOWN";
}

export function normalizePositionSide(value) {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  return POSITION_SET.has(normalized) ? normalized : "FLAT";
}

export function isSignalDirectionAllowedForMarket(market, direction) {
  const normalized = normalizeSignalDirection(direction);
  return Array.isArray(MARKET_DIRECTIONS[market]) && MARKET_DIRECTIONS[market].includes(normalized);
}

export function resolveSignalLifecycle({
  lifecycle = "NEW",
  generatedAtMs,
  ttlMs,
  expiresAtMs,
  evaluatedAtMs,
  invalidated = false,
  enteredPaper = false,
  settled = false,
} = {}) {
  if (settled) return "SETTLED";
  if (invalidated) return "INVALIDATED";
  if (enteredPaper) return "ENTERED_PAPER";

  const normalized = typeof lifecycle === "string" ? lifecycle.trim().toUpperCase() : "NEW";
  const current = LIFECYCLE_SET.has(normalized) ? normalized : "INVALIDATED";
  if (["SETTLED", "INVALIDATED", "EXPIRED"].includes(current)) return current;

  const now = finite(evaluatedAtMs) ? evaluatedAtMs : null;
  const explicitExpiry = finite(expiresAtMs) ? expiresAtMs : null;
  const ttlExpiry = finite(generatedAtMs) && finite(ttlMs) && ttlMs > 0 ? generatedAtMs + ttlMs : null;
  const expiry = explicitExpiry ?? ttlExpiry;
  if (now != null && expiry != null && now >= expiry) return "EXPIRED";
  if (current === "STALE") return "STALE";
  if (current === "NEW" && now != null && finite(generatedAtMs) && now >= generatedAtMs) return "ACTIVE";
  return current;
}

function decision({ market, signalDirection, executionIntent, positionSide, nextPositionSide, reason, allowed }) {
  return freeze({
    schemaVersion: "signal-direction-contract-v1",
    market,
    signalDirection,
    executionIntent,
    positionSide,
    nextPositionSide,
    reason,
    allowed,
    liveTrading: false,
    realOrder: false,
    privateApi: false,
  });
}

export function deriveExecutionDecision({ market, direction, positionSide = "FLAT", lifecycle = "ACTIVE", reduceOnly = false } = {}) {
  const signalDirection = normalizeSignalDirection(direction);
  const currentPosition = normalizePositionSide(positionSide);
  const rawLifecycle = typeof lifecycle === "string" ? lifecycle.trim().toUpperCase() : "INVALIDATED";
  const normalizedLifecycle = LIFECYCLE_SET.has(rawLifecycle) ? rawLifecycle : "INVALIDATED";

  if (!Object.hasOwn(MARKET_DIRECTIONS, market)) {
    return decision({ market, signalDirection, executionIntent: "NONE", positionSide: currentPosition, nextPositionSide: currentPosition, reason: "MARKET_UNSUPPORTED", allowed: false });
  }
  if (["STALE", "EXPIRED", "INVALIDATED"].includes(normalizedLifecycle)) {
    return decision({ market, signalDirection, executionIntent: "NONE", positionSide: currentPosition, nextPositionSide: currentPosition, reason: `SIGNAL_${normalizedLifecycle}`, allowed: false });
  }
  if (signalDirection === "UNKNOWN") {
    return decision({ market, signalDirection, executionIntent: "NONE", positionSide: currentPosition, nextPositionSide: currentPosition, reason: "SIGNAL_DIRECTION_UNKNOWN", allowed: false });
  }
  if (!isSignalDirectionAllowedForMarket(market, signalDirection)) {
    return decision({ market, signalDirection, executionIntent: "NONE", positionSide: currentPosition, nextPositionSide: currentPosition, reason: "SIGNAL_DIRECTION_MARKET_MISMATCH", allowed: false });
  }
  if (signalDirection === "NO_TRADE") {
    return decision({ market, signalDirection, executionIntent: "NONE", positionSide: currentPosition, nextPositionSide: currentPosition, reason: "SIGNAL_NO_TRADE", allowed: true });
  }

  if (CASH_MARKETS.has(market)) {
    if (currentPosition === "SHORT") {
      return decision({ market, signalDirection, executionIntent: "NONE", positionSide: currentPosition, nextPositionSide: currentPosition, reason: "CASH_SHORT_POSITION_UNSUPPORTED", allowed: false });
    }
    if (signalDirection === "BUY") {
      if (currentPosition === "FLAT") return decision({ market, signalDirection, executionIntent: "ENTER", positionSide: currentPosition, nextPositionSide: "LONG", reason: "CASH_BUY_ENTER_LONG", allowed: true });
      return decision({ market, signalDirection, executionIntent: "HOLD", positionSide: currentPosition, nextPositionSide: "LONG", reason: "POSITION_ALREADY_LONG", allowed: true });
    }
    if (currentPosition === "FLAT") {
      return decision({ market, signalDirection, executionIntent: "NONE", positionSide: currentPosition, nextPositionSide: "FLAT", reason: "CASH_SELL_FLAT_NO_NAKED_SHORT", allowed: true });
    }
    if (reduceOnly) {
      return decision({ market, signalDirection, executionIntent: "REDUCE", positionSide: currentPosition, nextPositionSide: "LONG", reason: "CASH_SELL_REDUCE_LONG", allowed: true });
    }
    return decision({ market, signalDirection, executionIntent: "EXIT", positionSide: currentPosition, nextPositionSide: "FLAT", reason: "CASH_SELL_EXIT_LONG", allowed: true });
  }

  if (FUTURES_MARKETS.has(market)) {
    const desired = signalDirection === "LONG" ? "LONG" : "SHORT";
    if (currentPosition === "FLAT") return decision({ market, signalDirection, executionIntent: "ENTER", positionSide: currentPosition, nextPositionSide: desired, reason: `FUTURES_${signalDirection}_ENTER`, allowed: true });
    if (currentPosition === desired) return decision({ market, signalDirection, executionIntent: "HOLD", positionSide: currentPosition, nextPositionSide: desired, reason: "POSITION_ALREADY_ALIGNED", allowed: true });
    return decision({ market, signalDirection, executionIntent: "NONE", positionSide: currentPosition, nextPositionSide: currentPosition, reason: "OPPOSITE_POSITION_REQUIRES_RECONCILIATION", allowed: false });
  }

  return decision({ market, signalDirection, executionIntent: "NONE", positionSide: currentPosition, nextPositionSide: currentPosition, reason: "MARKET_UNSUPPORTED", allowed: false });
}
