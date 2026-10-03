import { BITGET_ENDPOINTS } from "./bitget-public-client.js";
import { normalizeBitgetCandle } from "./bitget-candle-collector.js";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const MAX_PATH_MS = 73 * HOUR_MS;

function text(value) {
  return String(value ?? "").trim();
}

function positiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(code);
  return value;
}

function assertSymbol(symbol) {
  if (typeof symbol !== "string" || !/^[A-Z0-9]{3,30}$/u.test(symbol)) {
    throw new Error("PUMP_EXECUTION_SYMBOL_INVALID");
  }
  return symbol;
}

function payloadRows(payload, code) {
  if (text(payload?.code) !== "00000" || !Array.isArray(payload?.data)) {
    throw new Error(code);
  }
  return payload.data;
}

function sortAndDeduplicate(rows) {
  const byTimestamp = new Map();
  for (const row of rows) {
    const existing = byTimestamp.get(row.timestamp);
    if (existing && JSON.stringify(existing) !== JSON.stringify(row)) {
      throw new Error("PUMP_EXECUTION_DUPLICATE_CANDLE_CONFLICT");
    }
    byTimestamp.set(row.timestamp, row);
  }
  return [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function alignDown(timestamp, intervalMs) {
  return Math.floor(timestamp / intervalMs) * intervalMs;
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
}

export async function collectPumpNextBarOpenReferenceV1({
  client,
  symbol,
  expectedOpenAtMs,
  observedAtMs = Date.now(),
  productType = "USDT-FUTURES",
} = {}) {
  if (!client || typeof client.get !== "function") throw new TypeError("client.get is required");
  assertSymbol(symbol);
  positiveInteger(expectedOpenAtMs, "PUMP_NEXT_BAR_EXPECTED_TIME_INVALID");
  positiveInteger(observedAtMs, "PUMP_NEXT_BAR_OBSERVED_TIME_INVALID");
  if (observedAtMs < expectedOpenAtMs) throw new Error("PUMP_NEXT_BAR_NOT_STARTED");

  // If the whole next 1H bar has already elapsed, taking its historical open now
  // would be backfill rather than a prospective entry reference.
  if (observedAtMs >= expectedOpenAtMs + HOUR_MS) {
    return freeze({
      status: "MISSED",
      blocker: "PUMP_NEXT_BAR_CAPTURE_WINDOW_EXPIRED",
      symbol,
      expectedOpenAtMs,
      observedAtMs,
      entryReferencePrice: null,
      actualExchangeFillClaim: false,
      publicOnly: true,
      executionAuthority: "NONE",
    });
  }

  const payload = await client.get("/api/v2/mix/market/candles", {
    symbol,
    productType,
    granularity: "1H",
    limit: 3,
  });
  const candles = sortAndDeduplicate(
    payloadRows(payload, "PUMP_NEXT_BAR_CANDLES_INVALID").map(normalizeBitgetCandle),
  );
  const exact = candles.find((candle) => candle.timestamp === expectedOpenAtMs);
  if (!exact) {
    return freeze({
      status: "BLOCKED_DATA",
      blocker: "PUMP_NEXT_BAR_EXACT_OPEN_NOT_AVAILABLE",
      symbol,
      expectedOpenAtMs,
      observedAtMs,
      entryReferencePrice: null,
      actualExchangeFillClaim: false,
      publicOnly: true,
      executionAuthority: "NONE",
    });
  }

  return freeze({
    schemaVersion: "crypto-pump-reversal-next-bar-open-reference-v1",
    status: "READY",
    provider: "bitget-public-v2",
    market: "CRYPTO_FUTURES",
    symbol,
    expectedOpenAtMs,
    observedAtMs,
    sourceCandleTimestampMs: exact.timestamp,
    entryReferencePrice: exact.open,
    captureDelayMs: observedAtMs - expectedOpenAtMs,
    exactBarOpenTimestampMatch: true,
    actualExchangeFillClaim: false,
    fillModel: "NEXT_BAR_OPEN_REFERENCE_ONLY",
    publicOnly: true,
    privateRequestCount: 0,
    executionAuthority: "NONE",
    liveOrderAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
  });
}

export async function collectPumpClosedOneMinutePathV1({
  client,
  symbol,
  startTime,
  endTime = Date.now(),
  productType = "usdt-futures",
  maxCandles = 5_000,
} = {}) {
  if (!client || typeof client.get !== "function") throw new TypeError("client.get is required");
  assertSymbol(symbol);
  positiveInteger(startTime, "PUMP_1M_START_INVALID");
  positiveInteger(endTime, "PUMP_1M_END_INVALID");
  if (endTime <= startTime) throw new Error("PUMP_1M_RANGE_INVALID");
  if (endTime - startTime > MAX_PATH_MS) throw new Error("PUMP_1M_RANGE_EXCEEDS_73H");
  if (!Number.isSafeInteger(maxCandles) || maxCandles < 1 || maxCandles > 5_000) {
    throw new Error("PUMP_1M_MAX_CANDLES_INVALID");
  }

  const closedEnd = alignDown(endTime, MINUTE_MS);
  if (closedEnd <= startTime) {
    return freeze({
      schemaVersion: "crypto-pump-reversal-closed-1m-path-v1",
      status: "READY",
      provider: "bitget-public-v2",
      market: "CRYPTO_FUTURES",
      symbol,
      startTime,
      endTime,
      closedThroughMs: closedEnd,
      candles: [],
      publicOnly: true,
      executionAuthority: "NONE",
    });
  }

  const pageLimit = 200;
  const all = [];
  let cursorEnd = closedEnd;
  let previousOldest = Number.POSITIVE_INFINITY;

  while (cursorEnd > startTime && all.length < maxCandles) {
    const payload = await client.get(BITGET_ENDPOINTS.futuresHistoryCandles, {
      symbol,
      productType,
      granularity: "1m",
      endTime: cursorEnd,
      limit: pageLimit,
    });
    const rows = payloadRows(payload, "PUMP_1M_CANDLES_INVALID");
    if (rows.length === 0) break;
    const page = sortAndDeduplicate(rows.map(normalizeBitgetCandle));
    const oldest = page[0]?.timestamp;
    if (!Number.isSafeInteger(oldest)) throw new Error("PUMP_1M_OLDEST_TIMESTAMP_INVALID");
    if (oldest >= previousOldest) throw new Error("PUMP_1M_PAGINATION_DID_NOT_MOVE_BACKWARD");
    all.push(...page.filter((candle) => candle.timestamp >= startTime && candle.timestamp < cursorEnd));
    previousOldest = oldest;
    cursorEnd = oldest;
    if (rows.length < pageLimit) break;
  }

  const candles = sortAndDeduplicate(all)
    .filter((candle) => candle.timestamp >= startTime && candle.timestamp < closedEnd)
    .slice(-maxCandles);

  for (let index = 1; index < candles.length; index += 1) {
    if (candles[index].timestamp - candles[index - 1].timestamp !== MINUTE_MS) {
      throw new Error("PUMP_1M_PATH_GAP");
    }
  }
  if (candles.length > 0) {
    const expectedFirst = alignDown(startTime, MINUTE_MS);
    if (candles[0].timestamp > expectedFirst + MINUTE_MS) {
      throw new Error("PUMP_1M_PATH_START_GAP");
    }
  }

  return freeze({
    schemaVersion: "crypto-pump-reversal-closed-1m-path-v1",
    status: "READY",
    provider: "bitget-public-v2",
    market: "CRYPTO_FUTURES",
    symbol,
    startTime,
    endTime,
    closedThroughMs: closedEnd,
    candles: candles.map((candle) => Object.freeze({
      timestampMs: candle.timestamp,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      quoteVolume: candle.quoteVolume ?? null,
    })),
    publicOnly: true,
    privateRequestCount: 0,
    executionAuthority: "NONE",
    liveOrderAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
  });
}
