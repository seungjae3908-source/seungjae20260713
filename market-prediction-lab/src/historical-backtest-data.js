import { ResearchContractError } from "./research-governance.js";

export const HISTORICAL_V1_CRYPTO_SPECS = Object.freeze([
  Object.freeze({ id: "bitget-btcusdt-spot-1d", provider: "bitget-public-v2", market: "CRYPTO_SPOT", exchangeSymbol: "BTCUSDT", researchSymbol: "USDT-BTC", timeframe: "1d" }),
  Object.freeze({ id: "bitget-ethusdt-spot-1d", provider: "bitget-public-v2", market: "CRYPTO_SPOT", exchangeSymbol: "ETHUSDT", researchSymbol: "USDT-ETH", timeframe: "1d" }),
  Object.freeze({ id: "binance-btcusdt-futures-1d", provider: "binance-usdm-public-rest", market: "CRYPTO_FUTURES", exchangeSymbol: "BTCUSDT", researchSymbol: "BTCUSDT", timeframe: "1d" }),
  Object.freeze({ id: "binance-ethusdt-futures-1d", provider: "binance-usdm-public-rest", market: "CRYPTO_FUTURES", exchangeSymbol: "ETHUSDT", researchSymbol: "ETHUSDT", timeframe: "1d" }),
]);

// Conservative baseline assumptions for the target Bitget execution venue.
// These are explicit research assumptions, not claims that every historical
// account tier paid these exact rates on every date. Futures price/funding
// backfill may come from Binance when Bitget does not expose the full period;
// those results are labelled as cross-venue proxy research.
export const BITGET_STANDARD_TAKER_RESEARCH_COSTS = Object.freeze({
  CRYPTO_SPOT: Object.freeze({
    entryFeeRate: 0.001,
    exitFeeRate: 0.001,
    taxRate: 0,
    slippageRate: 0.0002,
    spreadRate: 0.0002,
    latencyBars: 0,
    latencyDriftRate: 0,
  }),
  CRYPTO_FUTURES: Object.freeze({
    entryFeeRate: 0.0006,
    exitFeeRate: 0.0006,
    taxRate: 0,
    slippageRate: 0.0002,
    spreadRate: 0.0002,
    latencyBars: 0,
    latencyDriftRate: 0,
  }),
});

export function toResearchCandles(spec, collected) {
  if (!spec || typeof spec !== "object") throw new ResearchContractError("INVALID_DATA_SPEC", "historical data spec is required");
  if (!collected || !Array.isArray(collected.candles)) throw new ResearchContractError("INVALID_COLLECTED_DATA", "collected candles are required");
  return Object.freeze(collected.candles.map((candle, index) => {
    if (!Number.isInteger(candle?.timestamp) || candle.timestamp <= 0) {
      throw new ResearchContractError("INVALID_TIMESTAMP", `collected candle ${index} timestamp is invalid`);
    }
    return Object.freeze({
      symbol: spec.researchSymbol,
      timestamp: candle.timestamp,
      observedAt: candle.timestamp,
      isClosed: true,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume ?? 0,
    });
  }));
}

export function summarizeHistoricalCoverage({
  spec,
  candles,
  requestedStartTime,
  requestedEndTime,
  asOfTime = requestedEndTime,
  expectedIntervalMs = 24 * 60 * 60 * 1000,
}) {
  if (!Number.isInteger(asOfTime) || asOfTime <= 0) throw new ResearchContractError("INVALID_AS_OF", "asOfTime must be a positive integer");
  if (!Number.isInteger(expectedIntervalMs) || expectedIntervalMs <= 0) throw new ResearchContractError("INVALID_INTERVAL", "expectedIntervalMs must be a positive integer");
  const effectiveRequestedEnd = Math.min(requestedEndTime, asOfTime);
  if (!Array.isArray(candles) || candles.length === 0) {
    return Object.freeze({
      id: spec?.id ?? null,
      status: "blocked_no_data",
      requestedStartTime,
      requestedEndTime,
      effectiveRequestedEnd,
      asOfTime,
      actualStartTime: null,
      actualEndTime: null,
      candleCount: 0,
      fullRequestedRange: false,
      coverageThroughAsOf: false,
      missingRequestedStart: true,
      missingRequestedEnd: true,
    });
  }
  const ordered = [...candles].sort((a, b) => a.timestamp - b.timestamp);
  const actualStartTime = ordered[0].timestamp;
  const actualEndTime = ordered.at(-1).timestamp;
  const missingRequestedStart = actualStartTime > requestedStartTime + expectedIntervalMs;
  // A daily provider can legitimately be one still-forming bar behind the wall
  // clock. Two intervals allow venue session offsets without calling complete
  // closed-bar history "partial" just because the current bar is open.
  const missingRequestedEnd = actualEndTime < effectiveRequestedEnd - (2 * expectedIntervalMs);
  const coverageThroughAsOf = !missingRequestedStart && !missingRequestedEnd;
  const fullRequestedRange = requestedEndTime <= asOfTime && coverageThroughAsOf;
  return Object.freeze({
    id: spec?.id ?? null,
    status: coverageThroughAsOf ? "coverage_through_asof" : "partial_coverage",
    requestedStartTime,
    requestedEndTime,
    effectiveRequestedEnd,
    asOfTime,
    actualStartTime,
    actualEndTime,
    candleCount: ordered.length,
    fullRequestedRange,
    coverageThroughAsOf,
    missingRequestedStart,
    missingRequestedEnd,
  });
}

export function buildCryptoV1Cases({ spec, candles, fundingRates = [], initialCapital = 1_000_000, period }) {
  if (!HISTORICAL_V1_CRYPTO_SPECS.some((candidate) => candidate.id === spec?.id)) {
    throw new ResearchContractError("UNKNOWN_DATA_SPEC", `unsupported historical spec: ${spec?.id}`);
  }
  const common = Object.freeze({
    market: spec.market,
    symbol: spec.researchSymbol,
    timeframe: spec.timeframe,
    initialCapital,
    candles,
    period,
    costModel: BITGET_STANDARD_TAKER_RESEARCH_COSTS[spec.market],
    riskModel: Object.freeze({ riskPerTrade: 0.01, maximumCapitalFraction: 1, leverage: 1 }),
  });
  if (spec.market === "CRYPTO_SPOT") {
    return Object.freeze([Object.freeze({ id: `${spec.id}-long`, side: "long", ...common })]);
  }
  return Object.freeze([
    Object.freeze({ id: `${spec.id}-long`, side: "long", fundingRates, ...common }),
    Object.freeze({ id: `${spec.id}-short`, side: "short", fundingRates, ...common }),
  ]);
}

export function buildBlockedStockProviderReport() {
  return Object.freeze([
    Object.freeze({
      market: "KR_STOCK",
      status: "blocked_provider_not_integrated",
      reason: "A reproducible no-secret historical provider with delisted/universe safeguards is not integrated yet; no synthetic returns are allowed.",
    }),
    Object.freeze({
      market: "US_STOCK",
      status: "blocked_provider_not_integrated",
      reason: "A reproducible no-secret historical provider with corporate-action and delisted/universe safeguards is not integrated yet; no synthetic returns are allowed.",
    }),
  ]);
}
