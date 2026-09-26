import { GatewayError } from "./gateway.mjs";

const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;

function positive(value, code, message) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new GatewayError(code, message);
  }
  return number;
}

function timestamp(value, name) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new GatewayError("MARKET_RULE_TIMESTAMP_INVALID", `${name} must be an ISO timestamp`);
  }
  return parsed;
}

function aligned(value, step) {
  const quotient = value / step;
  const nearest = Math.round(quotient);
  return Math.abs(quotient - nearest) <= 1e-9 * Math.max(1, Math.abs(quotient));
}

export function validateMarketRuleEvidence(intent, evidence, options = {}) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new GatewayError("MARKET_RULE_EVIDENCE_REQUIRED", "market rule evidence is required");
  }

  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const observedAtMs = timestamp(evidence.observedAt, "observedAt");
  if (observedAtMs > nowMs + 1_000) {
    throw new GatewayError("MARKET_RULE_EVIDENCE_FUTURE", "market rule evidence is from the future");
  }
  if (nowMs - observedAtMs > maxAgeMs) {
    throw new GatewayError("MARKET_RULE_EVIDENCE_STALE", "market rule evidence is stale");
  }

  const source = typeof evidence.source === "string" ? evidence.source.trim() : "";
  if (!source) {
    throw new GatewayError("MARKET_RULE_SOURCE_REQUIRED", "market rule source is required");
  }

  const market = String(evidence.market ?? "").toUpperCase();
  if (market !== intent.market) {
    throw new GatewayError("MARKET_RULE_MARKET_MISMATCH", "market rule evidence market does not match order");
  }

  const provider = String(evidence.provider ?? "").toLowerCase();
  const intendedProvider = String(intent.provider ?? "").toLowerCase();
  if (!provider || !intendedProvider || provider !== intendedProvider) {
    throw new GatewayError("MARKET_RULE_PROVIDER_MISMATCH", "market rule provider must match order provider");
  }

  const tickSize = positive(evidence.tickSize, "TICK_SIZE_REQUIRED", "positive tickSize is required");
  const lotSize = positive(evidence.lotSize, "LOT_SIZE_REQUIRED", "positive lotSize is required");
  const minNotional = positive(
    evidence.minNotional,
    "MIN_NOTIONAL_REQUIRED",
    "positive minNotional is required",
  );

  const price = intent.orderType === "LIMIT" ? intent.limitPrice : intent.referencePrice;
  if (!aligned(price, tickSize)) {
    throw new GatewayError("PRICE_TICK_MISALIGNED", "order price is not aligned to tickSize");
  }
  if (!aligned(intent.quantity, lotSize)) {
    throw new GatewayError("QUANTITY_LOT_MISALIGNED", "order quantity is not aligned to lotSize");
  }

  const notional = price * intent.quantity;
  if (!Number.isFinite(notional) || notional < minNotional) {
    throw new GatewayError("MIN_NOTIONAL_NOT_MET", "order notional is below provider minimum");
  }

  let maxLeverage = null;
  if (intent.market === "CRYPTO_FUTURES") {
    maxLeverage = positive(
      evidence.maxLeverage,
      "MAX_LEVERAGE_EVIDENCE_REQUIRED",
      "futures maxLeverage evidence is required",
    );
    if (!Number.isFinite(intent.leverage) || intent.leverage <= 0) {
      throw new GatewayError("FUTURES_LEVERAGE_REQUIRED", "futures leverage is required");
    }
    if (intent.leverage > maxLeverage) {
      throw new GatewayError("MAX_LEVERAGE_EXCEEDED", "requested leverage exceeds market rule maximum");
    }
  }

  return Object.freeze({
    accepted: true,
    source,
    provider,
    market,
    observedAt: new Date(observedAtMs).toISOString(),
    tickSize,
    lotSize,
    minNotional,
    maxLeverage,
    checkedPrice: price,
    checkedQuantity: intent.quantity,
    checkedNotional: notional,
    inventedRules: false,
    liveAuthorityGranted: false,
  });
}
