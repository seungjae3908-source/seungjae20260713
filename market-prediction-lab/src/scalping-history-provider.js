import { createHash } from "node:crypto";
import { BITGET_TIMEFRAME_MS, collectBitgetCandles } from "./bitget-candle-collector.js";

export const SCALPING_HISTORY_SCHEMA_VERSION = 3;
export const SCALPING_NORMALIZATION_VERSION = 1;
export const SCALPING_PROVIDER = "bitget-public-v2";
export const SCALPING_TIMEFRAME = "15m";
export const DEFAULT_SCALPING_CHUNK_CANDLES = 2_880; // 30 days of 15m candles.

export const BITGET_SCALPING_SEMANTICS = Object.freeze({
  status: "verified_from_official_api_contract",
  timestamp: "candle_start_unix_ms",
  timezone: "unix_timestamp_utc",
  priceDefinition: "market_trade_ohlc",
  volumeUnit: "base_currency",
  quoteVolumeUnit: "quote_currency",
  spotMarketType: "SPOT",
  futuresMarketType: "USDT-FUTURES",
  futuresContractDefinition: "USDT-margined perpetual/futures productType=usdt-futures as requested by collector",
  missingCandlePolicy: "fail_closed_no_interpolation",
  duplicatePolicy: "fail_closed",
  outOfOrderPolicy: "fail_closed",
  expectedCandleCountPolicy: "count_only_intervals_with_close_time_lte_requested_end",
  openBoundaryCandleExcluded: true,
});

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function scalpingDigest(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function assertMarket(market) {
  if (!new Set(["CRYPTO_SPOT", "CRYPTO_FUTURES"]).has(market)) throw new TypeError(`unsupported scalping market: ${market}`);
  return market;
}

function assertSymbol(symbol) {
  if (typeof symbol !== "string" || !/^[A-Z0-9]{3,30}$/.test(symbol)) throw new TypeError("invalid scalping symbol");
  return symbol;
}

function expectedClosedCandleCount(requestedStart, requestedEnd, intervalMs) {
  // Candle timestamps are open-times. A candle is eligible only when its close-time
  // (timestamp + interval) is <= requestedEnd. This intentionally excludes a candle
  // that has opened but has not closed at the research cutoff.
  return Math.max(0, Math.floor((requestedEnd - requestedStart) / intervalMs));
}

function cacheContractDefaults(input = {}) {
  return Object.freeze({
    providerVersion: input.providerVersion ?? "api-v2-history-candles",
    normalizationVersion: input.normalizationVersion ?? SCALPING_NORMALIZATION_VERSION,
    collectionCodeSha: input.collectionCodeSha ?? "UNSPECIFIED_FOR_UNIT_TEST",
    costModelDigest: input.costModelDigest ?? "not_applicable_to_data_collection",
    splitDefinition: input.splitDefinition ?? "development-oos-final-holdout-v1",
  });
}

export function buildScalpingChunkPlan({
  market,
  symbol,
  timeframe = SCALPING_TIMEFRAME,
  requestedStart,
  requestedEnd,
  chunkCandles = DEFAULT_SCALPING_CHUNK_CANDLES,
  cacheContract,
} = {}) {
  assertMarket(market);
  assertSymbol(symbol);
  const intervalMs = BITGET_TIMEFRAME_MS[timeframe];
  if (!intervalMs) throw new TypeError(`unsupported timeframe: ${timeframe}`);
  if (!Number.isSafeInteger(requestedStart) || !Number.isSafeInteger(requestedEnd) || requestedStart >= requestedEnd) throw new TypeError("invalid requested period");
  if (!Number.isInteger(chunkCandles) || chunkCandles < 200 || chunkCandles > 20_000) throw new RangeError("chunkCandles must be between 200 and 20000");
  const contract = cacheContractDefaults(cacheContract);
  const chunkSpan = chunkCandles * intervalMs;
  const chunks = [];
  let end = Math.floor(requestedEnd / intervalMs) * intervalMs;
  let index = 0;
  while (end > requestedStart) {
    const start = Math.max(requestedStart, end - chunkSpan);
    const cacheKeyPayload = {
      schemaVersion: SCALPING_HISTORY_SCHEMA_VERSION,
      provider: SCALPING_PROVIDER,
      market,
      symbol,
      timeframe,
      requestedStart: start,
      requestedEnd: end,
      ...contract,
    };
    chunks.push(Object.freeze({
      index,
      market,
      symbol,
      timeframe,
      requestedStart: start,
      requestedEnd: end,
      cacheContract: contract,
      cacheKey: scalpingDigest(cacheKeyPayload),
    }));
    end = start;
    index += 1;
  }
  return Object.freeze(chunks); // newest -> oldest for resumable provider-bound discovery.
}

function normalizeForResearch(market, symbol, timeframe, candles) {
  return candles.map((candle) => Object.freeze({
    market,
    symbol,
    timeframe,
    timestamp: candle.timestamp,
    observedAt: candle.timestamp,
    isClosed: true,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume ?? 0,
    quoteVolume: candle.quoteVolume ?? null,
  }));
}

export function inspectScalpingCandles({ market, symbol, timeframe = SCALPING_TIMEFRAME, candles, requestedStart, requestedEnd } = {}) {
  assertMarket(market);
  assertSymbol(symbol);
  const intervalMs = BITGET_TIMEFRAME_MS[timeframe];
  if (!intervalMs) throw new TypeError(`unsupported timeframe: ${timeframe}`);
  if (!Array.isArray(candles)) throw new TypeError("candles must be an array");
  let duplicateCount = 0;
  let reversedCount = 0;
  let missingCandleCount = 0;
  let maximumGapCandles = 0;
  let maximumGapMs = 0;
  const gaps = [];
  const seen = new Set();
  let previous = null;
  for (const candle of candles) {
    if (!Number.isSafeInteger(candle?.timestamp)) throw new TypeError("invalid candle timestamp");
    if (seen.has(candle.timestamp)) duplicateCount += 1;
    seen.add(candle.timestamp);
    if (previous != null) {
      if (candle.timestamp < previous) reversedCount += 1;
      const delta = candle.timestamp - previous;
      if (delta > intervalMs) {
        const missing = Math.max(0, Math.round(delta / intervalMs) - 1);
        missingCandleCount += missing;
        maximumGapCandles = Math.max(maximumGapCandles, missing);
        maximumGapMs = Math.max(maximumGapMs, delta - intervalMs);
        gaps.push(Object.freeze({ after: previous, before: candle.timestamp, missingCandleCount: missing, gapMs: delta - intervalMs }));
      }
    }
    previous = candle.timestamp;
  }
  const actualStart = candles[0]?.timestamp ?? null;
  const actualEnd = candles.at(-1)?.timestamp ?? null;
  const expectedCandleCount = expectedClosedCandleCount(requestedStart, requestedEnd, intervalMs);
  const reachesStart = actualStart != null && actualStart <= requestedStart + intervalMs;
  const reachesEnd = actualEnd != null && actualEnd + intervalMs <= requestedEnd + intervalMs && actualEnd >= requestedEnd - (2 * intervalMs);
  return Object.freeze({
    actualStart,
    actualEnd,
    expectedCandleCount,
    expectedCandleCountPolicy: BITGET_SCALPING_SEMANTICS.expectedCandleCountPolicy,
    openBoundaryCandleExcluded: true,
    actualCandleCount: candles.length,
    candleCount: candles.length,
    duplicateCount,
    outOfOrderCount: reversedCount,
    reversedCount,
    missingCandleCount,
    gapCount: gaps.length,
    maximumGapCandles,
    maximumGapMs,
    gaps: Object.freeze(gaps),
    reachesStart,
    reachesEnd,
    validOrdering: reversedCount === 0,
    validUniqueness: duplicateCount === 0,
    completeChunk: candles.length > 0 && reversedCount === 0 && duplicateCount === 0 && missingCandleCount === 0 && reachesStart && reachesEnd,
  });
}

export async function collectScalpingChunk({ client, chunk, productType = "usdt-futures" } = {}) {
  if (!chunk || typeof chunk !== "object") throw new TypeError("chunk is required");
  try {
    const collected = await collectBitgetCandles({
      client,
      market: chunk.market,
      symbol: chunk.symbol,
      timeframe: chunk.timeframe,
      startTime: chunk.requestedStart,
      endTime: chunk.requestedEnd,
      maxCandles: DEFAULT_SCALPING_CHUNK_CANDLES + 64,
      productType,
    });
    const rawCandles = [...collected.candles];
    const diagnostics = inspectScalpingCandles({ ...chunk, candles: rawCandles });
    const normalizedCandles = normalizeForResearch(chunk.market, chunk.symbol, chunk.timeframe, rawCandles);
    const rawDataDigest = scalpingDigest({ provider: collected.provider, market: chunk.market, symbol: chunk.symbol, timeframe: chunk.timeframe, candles: rawCandles });
    const normalizedDataDigest = scalpingDigest({ normalizationVersion: SCALPING_NORMALIZATION_VERSION, market: chunk.market, symbol: chunk.symbol, timeframe: chunk.timeframe, candles: normalizedCandles });
    return Object.freeze({
      schemaVersion: SCALPING_HISTORY_SCHEMA_VERSION,
      status: diagnostics.completeChunk ? "ready" : "blocked_data",
      cacheKey: chunk.cacheKey,
      cacheContract: chunk.cacheContract ?? cacheContractDefaults(),
      provider: collected.provider,
      providerVersion: "api-v2-history-candles",
      providerApi: chunk.market === "CRYPTO_SPOT" ? "/api/v2/spot/market/history-candles" : "/api/v2/mix/market/history-candles",
      market: chunk.market,
      symbol: chunk.symbol,
      timeframe: chunk.timeframe,
      requestedStart: chunk.requestedStart,
      requestedEnd: chunk.requestedEnd,
      actualStart: diagnostics.actualStart,
      actualEnd: diagnostics.actualEnd,
      rawDataDigest,
      normalizedDataDigest,
      diagnostics,
      semantics: BITGET_SCALPING_SEMANTICS,
      rawCandles: Object.freeze(rawCandles),
      normalizedCandles: Object.freeze(normalizedCandles),
      syntheticDataUsed: false,
      interpolationUsed: false,
      privateApiUsed: false,
      orderSubmitted: false,
    });
  } catch (error) {
    return Object.freeze({
      schemaVersion: SCALPING_HISTORY_SCHEMA_VERSION,
      status: "blocked_data",
      cacheKey: chunk.cacheKey,
      cacheContract: chunk.cacheContract ?? cacheContractDefaults(),
      provider: SCALPING_PROVIDER,
      providerVersion: "api-v2-history-candles",
      providerApi: chunk.market === "CRYPTO_SPOT" ? "/api/v2/spot/market/history-candles" : "/api/v2/mix/market/history-candles",
      market: chunk.market,
      symbol: chunk.symbol,
      timeframe: chunk.timeframe,
      requestedStart: chunk.requestedStart,
      requestedEnd: chunk.requestedEnd,
      actualStart: null,
      actualEnd: null,
      rawDataDigest: null,
      normalizedDataDigest: null,
      diagnostics: Object.freeze({ reason: "provider_chunk_unavailable_or_invalid", message: String(error?.message ?? error).slice(0, 1000) }),
      semantics: BITGET_SCALPING_SEMANTICS,
      rawCandles: Object.freeze([]),
      normalizedCandles: Object.freeze([]),
      syntheticDataUsed: false,
      interpolationUsed: false,
      privateApiUsed: false,
      orderSubmitted: false,
    });
  }
}

export function assertScalpingChunkIntegrity(chunk) {
  if (!chunk || chunk.status !== "ready") throw new Error("SCALPING_CHUNK_NOT_READY");
  const expectedRaw = scalpingDigest({ provider: chunk.provider, market: chunk.market, symbol: chunk.symbol, timeframe: chunk.timeframe, candles: chunk.rawCandles });
  const normalizationVersion = chunk.cacheContract?.normalizationVersion ?? chunk.normalizationVersion ?? SCALPING_NORMALIZATION_VERSION;
  const expectedNormalized = scalpingDigest({ normalizationVersion, market: chunk.market, symbol: chunk.symbol, timeframe: chunk.timeframe, candles: chunk.normalizedCandles });
  if (expectedRaw !== chunk.rawDataDigest) throw new Error("SCALPING_RAW_CACHE_CORRUPTION");
  if (expectedNormalized !== chunk.normalizedDataDigest) {
    // Backward-compatible integrity check for pre-v2 unit fixtures only.
    const legacy = scalpingDigest({ market: chunk.market, symbol: chunk.symbol, timeframe: chunk.timeframe, candles: chunk.normalizedCandles });
    if (legacy !== chunk.normalizedDataDigest) throw new Error("SCALPING_NORMALIZED_CACHE_CORRUPTION");
  }
  if (chunk.syntheticDataUsed === true || chunk.interpolationUsed === true) throw new Error("SCALPING_SYNTHETIC_OR_INTERPOLATED_CACHE_FORBIDDEN");
  return true;
}

export function buildScalpingHistoryManifest({ market, symbol, timeframe = SCALPING_TIMEFRAME, requestedStart, requestedEnd, chunkSummaries, cacheContract } = {}) {
  assertMarket(market);
  assertSymbol(symbol);
  if (!Array.isArray(chunkSummaries)) throw new TypeError("chunkSummaries must be an array");
  const intervalMs = BITGET_TIMEFRAME_MS[timeframe];
  const ready = chunkSummaries.filter((chunk) => chunk.status === "ready");
  const blocked = chunkSummaries.filter((chunk) => chunk.status !== "ready");
  const actualStarts = ready.map((chunk) => chunk.actualStart).filter(Number.isSafeInteger);
  const actualEnds = ready.map((chunk) => chunk.actualEnd).filter(Number.isSafeInteger);
  const actualCandleCount = ready.reduce((sum, chunk) => sum + (chunk.diagnostics?.actualCandleCount ?? chunk.diagnostics?.candleCount ?? 0), 0);
  const expectedCandleCount = expectedClosedCandleCount(requestedStart, requestedEnd, intervalMs);
  const totalMissingCandles = ready.reduce((sum, chunk) => sum + (chunk.diagnostics?.missingCandleCount ?? 0), 0);
  const gapCount = ready.reduce((sum, chunk) => sum + (chunk.diagnostics?.gapCount ?? chunk.diagnostics?.gaps?.length ?? 0), 0);
  const maximumGapCandles = ready.reduce((max, chunk) => Math.max(max, chunk.diagnostics?.maximumGapCandles ?? 0), 0);
  const maximumGapMs = ready.reduce((max, chunk) => Math.max(max, chunk.diagnostics?.maximumGapMs ?? 0), 0);
  const duplicateCount = ready.reduce((sum, chunk) => sum + (chunk.diagnostics?.duplicateCount ?? 0), 0);
  const reversedCount = ready.reduce((sum, chunk) => sum + (chunk.diagnostics?.outOfOrderCount ?? chunk.diagnostics?.reversedCount ?? 0), 0);
  const allChunksReady = chunkSummaries.length > 0 && blocked.length === 0;
  const contract = cacheContractDefaults(cacheContract ?? ready[0]?.cacheContract);
  const actualFirstCandle = actualStarts.length ? Math.min(...actualStarts) : null;
  const actualLastCandle = actualEnds.length ? Math.max(...actualEnds) : null;
  const semanticsVerified = BITGET_SCALPING_SEMANTICS.status === "verified_from_official_api_contract";
  const countMatchesClosedBoundary = actualCandleCount === expectedCandleCount;
  const status = allChunksReady && semanticsVerified && countMatchesClosedBoundary
    ? "DATA_READY"
    : allChunksReady && semanticsVerified
      ? "BLOCKED_DATA"
      : allChunksReady ? "BLOCKED_PROVIDER_BOUNDARY" : "BLOCKED_DATA";
  const manifest = {
    schemaVersion: SCALPING_HISTORY_SCHEMA_VERSION,
    cacheSchemaVersion: SCALPING_HISTORY_SCHEMA_VERSION,
    normalizationVersion: SCALPING_NORMALIZATION_VERSION,
    status,
    provider: SCALPING_PROVIDER,
    providerVersion: "api-v2-history-candles",
    providerApi: market === "CRYPTO_SPOT" ? "/api/v2/spot/market/history-candles" : "/api/v2/mix/market/history-candles",
    market,
    symbol,
    timeframe,
    requestedStart,
    requestedEnd,
    requestedPeriod: Object.freeze({ start: requestedStart, end: requestedEnd }),
    actualFirstCandle,
    actualLastCandle,
    actualAvailablePeriod: Object.freeze({ start: actualFirstCandle, end: actualLastCandle }),
    expectedCandleCount,
    expectedCandleCountPolicy: BITGET_SCALPING_SEMANTICS.expectedCandleCountPolicy,
    openBoundaryCandleExcluded: true,
    countMatchesClosedBoundary,
    actualCandleCount,
    missingCandleCount: totalMissingCandles,
    gapCount,
    maximumGap: Object.freeze({ candles: maximumGapCandles, milliseconds: maximumGapMs }),
    duplicateCount,
    outOfOrderCount: reversedCount,
    chunkCount: chunkSummaries.length,
    readyChunkCount: ready.length,
    blockedChunkCount: blocked.length,
    missingCandleStatistics: Object.freeze({ totalMissingCandles, chunksWithGaps: ready.filter((chunk) => (chunk.diagnostics?.missingCandleCount ?? 0) > 0).length }),
    duplicateCandleCount: duplicateCount,
    reversedTimestampCount: reversedCount,
    providerBoundary: Object.freeze({
      status: semanticsVerified ? "verified_single_provider_contract" : "unverified",
      segments: Object.freeze([{ provider: SCALPING_PROVIDER, providerVersion: "api-v2-history-candles", start: actualFirstCandle, end: actualLastCandle }]),
      crossProviderConcatenationUsed: false,
    }),
    semantics: BITGET_SCALPING_SEMANTICS,
    cacheContract: contract,
    collectionCodeSHA: contract.collectionCodeSha,
    rawDigest: scalpingDigest(ready.map((chunk) => chunk.rawDataDigest)),
    normalizedDigest: scalpingDigest(ready.map((chunk) => chunk.normalizedDataDigest)),
    chunks: Object.freeze(chunkSummaries.map((chunk) => Object.freeze({
      cacheKey: chunk.cacheKey,
      status: chunk.status,
      requestedStart: chunk.requestedStart,
      requestedEnd: chunk.requestedEnd,
      actualStart: chunk.actualStart,
      actualEnd: chunk.actualEnd,
      rawDataDigest: chunk.rawDataDigest,
      normalizedDataDigest: chunk.normalizedDataDigest,
      diagnostics: chunk.diagnostics,
    }))),
    syntheticDataUsed: false,
    interpolationUsed: false,
    privateApiUsed: false,
    orderSubmitted: false,
    resumable: true,
    deterministicCache: true,
    rateLimitBackoff: "BitgetPublicClient",
  };
  return Object.freeze({ ...manifest, manifestDigest: scalpingDigest(manifest) });
}
