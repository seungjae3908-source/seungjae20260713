import { GatewayError } from "./gateway.mjs";

const PROVIDER_BY_MARKET = Object.freeze({
  CRYPTO_SPOT: "upbit",
  CRYPTO_FUTURES: "bitget",
});

const SOURCES_BY_PROVIDER = Object.freeze({
  upbit: Object.freeze(["UPBIT_PUBLIC_WEBSOCKET", "UPBIT_PUBLIC_REST"]),
  bitget: Object.freeze(["BITGET_PUBLIC_WEBSOCKET", "BITGET_PUBLIC_REST"]),
});

function requireObject(value, code, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GatewayError(code, message);
  }
  return value;
}

function requireText(value, name, max = 128) {
  if (typeof value !== "string") {
    throw new GatewayError("INVALID_PUBLIC_MARKET_DATA", `${name} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new GatewayError("INVALID_PUBLIC_MARKET_DATA", `${name} is invalid`);
  }
  return normalized;
}

function positive(value, code, message) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new GatewayError(code, message);
  return number;
}

function nonNegative(value, code, message) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new GatewayError(code, message);
  return number;
}

function timestampMs(value, code, message) {
  const parsed = typeof value === "number" ? value : Date.parse(String(value));
  if (!Number.isFinite(parsed) || parsed <= 0) throw new GatewayError(code, message);
  return parsed;
}

function normalizeDepth(levels, side) {
  if (!Array.isArray(levels) || levels.length === 0 || levels.length > 50) {
    throw new GatewayError("INVALID_PUBLIC_DEPTH", `${side} depth must contain 1-50 levels`);
  }

  let previous = null;
  return Object.freeze(levels.map((raw, index) => {
    requireObject(raw, "INVALID_PUBLIC_DEPTH", `${side} depth level must be an object`);
    const price = positive(raw.price, "INVALID_PUBLIC_DEPTH_PRICE", `${side} depth price must be positive`);
    const size = positive(raw.size, "INVALID_PUBLIC_DEPTH_SIZE", `${side} depth size must be positive`);

    if (previous !== null) {
      const ordered = side === "bids" ? price < previous : price > previous;
      if (!ordered) {
        throw new GatewayError(
          "UNORDERED_PUBLIC_DEPTH",
          `${side} depth must be strictly ${side === "bids" ? "descending" : "ascending"}`,
        );
      }
    }
    previous = price;
    return Object.freeze({ level: index + 1, price, size });
  }));
}

function requireAgePolicy(policy) {
  requireObject(policy, "MARKET_DATA_POLICY_NOT_CONFIGURED", "public market data policy is required");
  return {
    maxQuoteAgeMs: positive(
      policy.maxQuoteAgeMs,
      "MARKET_DATA_POLICY_NOT_CONFIGURED",
      "maxQuoteAgeMs must be positive",
    ),
    maxTradeAgeMs: positive(
      policy.maxTradeAgeMs,
      "MARKET_DATA_POLICY_NOT_CONFIGURED",
      "maxTradeAgeMs must be positive",
    ),
    maxFutureSkewMs: nonNegative(
      policy.maxFutureSkewMs,
      "MARKET_DATA_POLICY_NOT_CONFIGURED",
      "maxFutureSkewMs must be non-negative",
    ),
    requireTrade: policy.requireTrade === true,
    nowMs: policy.nowMs == null
      ? Date.now()
      : positive(policy.nowMs, "INVALID_MARKET_DATA_CLOCK", "nowMs must be positive"),
  };
}

export function normalizePublicMarketDataEvidence(input, policy) {
  requireObject(input, "PUBLIC_MARKET_DATA_REQUIRED", "public market data evidence is required");
  const agePolicy = requireAgePolicy(policy);

  const market = requireText(input.market, "market", 32).toUpperCase();
  const expectedProvider = PROVIDER_BY_MARKET[market];
  if (!expectedProvider) {
    throw new GatewayError(
      "PUBLIC_MARKET_DATA_MARKET_UNSUPPORTED",
      "v0.4 public execution evidence supports crypto spot/futures only",
    );
  }

  const provider = requireText(input.provider, "provider", 32).toLowerCase();
  if (provider !== expectedProvider) {
    throw new GatewayError(
      "PUBLIC_MARKET_DATA_PROVIDER_MISMATCH",
      `${market} public evidence requires ${expectedProvider}`,
    );
  }

  const source = requireText(input.source, "source", 48).toUpperCase();
  if (!SOURCES_BY_PROVIDER[provider].includes(source)) {
    throw new GatewayError(
      "PUBLIC_MARKET_DATA_SOURCE_INVALID",
      `${provider} evidence must identify an approved public REST/WebSocket source`,
    );
  }

  const symbol = requireText(input.symbol, "symbol", 64).toUpperCase();
  const bids = normalizeDepth(input.bids, "bids");
  const asks = normalizeDepth(input.asks, "asks");
  const bestBid = bids[0].price;
  const bestAsk = asks[0].price;
  if (bestBid >= bestAsk) {
    throw new GatewayError("CROSSED_PUBLIC_BOOK", "best bid must remain below best ask");
  }

  const quoteObservedAtMs = timestampMs(
    input.quoteObservedAt,
    "INVALID_PUBLIC_QUOTE_TIMESTAMP",
    "quoteObservedAt must be a valid timestamp",
  );
  if (quoteObservedAtMs > agePolicy.nowMs + agePolicy.maxFutureSkewMs) {
    throw new GatewayError("FUTURE_PUBLIC_QUOTE", "public quote timestamp is in the future");
  }
  const quoteAgeMs = Math.max(0, agePolicy.nowMs - quoteObservedAtMs);
  if (quoteAgeMs > agePolicy.maxQuoteAgeMs) {
    throw new GatewayError("STALE_PUBLIC_QUOTE", "public orderbook evidence is stale");
  }

  const hasTradePrice = input.lastTradePrice != null;
  const hasTradeTime = input.tradeObservedAt != null;
  if (hasTradePrice !== hasTradeTime) {
    throw new GatewayError(
      "INCOMPLETE_PUBLIC_TRADE_EVIDENCE",
      "lastTradePrice and tradeObservedAt must be supplied together",
    );
  }
  if (agePolicy.requireTrade && !hasTradePrice) {
    throw new GatewayError("PUBLIC_TRADE_EVIDENCE_REQUIRED", "fresh public trade evidence is required");
  }

  let lastTradePrice = null;
  let tradeObservedAtMs = null;
  let tradeAgeMs = null;
  if (hasTradePrice) {
    lastTradePrice = positive(
      input.lastTradePrice,
      "INVALID_PUBLIC_TRADE_PRICE",
      "lastTradePrice must be positive",
    );
    tradeObservedAtMs = timestampMs(
      input.tradeObservedAt,
      "INVALID_PUBLIC_TRADE_TIMESTAMP",
      "tradeObservedAt must be a valid timestamp",
    );
    if (tradeObservedAtMs > agePolicy.nowMs + agePolicy.maxFutureSkewMs) {
      throw new GatewayError("FUTURE_PUBLIC_TRADE", "public trade timestamp is in the future");
    }
    tradeAgeMs = Math.max(0, agePolicy.nowMs - tradeObservedAtMs);
    if (tradeAgeMs > agePolicy.maxTradeAgeMs) {
      throw new GatewayError("STALE_PUBLIC_TRADE", "public trade evidence is stale");
    }
  }

  const midPrice = (bestBid + bestAsk) / 2;
  return Object.freeze({
    evidenceVersion: "PUBLIC_EXECUTION_MARKET_DATA_V1",
    authority: "CALLER_SUPPLIED_PUBLIC_EVIDENCE",
    callerSuppliedEvidence: true,
    serverAttested: false,
    transportObservedByGateway: false,
    liveExecutionEligible: false,
    market,
    provider,
    source,
    symbol,
    quoteObservedAt: new Date(quoteObservedAtMs).toISOString(),
    quoteAgeMs,
    tradeObservedAt: tradeObservedAtMs === null ? null : new Date(tradeObservedAtMs).toISOString(),
    tradeAgeMs,
    lastTradePrice,
    bids,
    asks,
    bestBid,
    bestAsk,
    midPrice,
    spread: bestAsk - bestBid,
    providerSequence: input.providerSequence ?? null,
    providerChecksum: input.providerChecksum ?? null,
    outboundNetworkPerformed: false,
    privateApiUsed: false,
  });
}
