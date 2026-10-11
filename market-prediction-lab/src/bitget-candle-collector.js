import { BITGET_ENDPOINTS } from "./bitget-public-client.js";

const TIMEFRAME_MS = Object.freeze({
  "1m": 60_000,
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
});

const FUTURES_GRANULARITY = Object.freeze({ "1m": "1m", "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D" });
const SPOT_GRANULARITY = Object.freeze({ "1m": "1min", "15m": "15min", "1h": "1h", "4h": "4h", "1d": "1day" });

function dataError(code, message = code) { return Object.assign(new Error(message), { code }); }

function assertSymbol(symbol) {
  if (typeof symbol !== "string" || !/^[A-Z0-9\p{Script=Han}]{3,30}$/u.test(symbol)) {
    throw new TypeError("symbol must contain 3-30 uppercase letters, digits or Han characters");
  }
  return symbol;
}

function assertTimeframe(timeframe) {
  if (!TIMEFRAME_MS[timeframe]) throw new TypeError(`unsupported timeframe: ${timeframe}`);
  return timeframe;
}

function toFiniteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label} must be finite`);
  return number;
}

function toDecimalString(value, label) {
  const text = String(value ?? "").trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) {
    throw new TypeError(`${label} must be a decimal value`);
  }
  if (!Number.isFinite(Number(text))) throw new TypeError(`${label} must be finite`);
  return text;
}

export function normalizeBitgetCandle(row, index = 0) {
  const invalid = (message) => Object.assign(new TypeError(message), { code: "BITGET_HISTORY_INVALID_CANDLE" });
  if (!Array.isArray(row) || row.length < 6) throw invalid(`candle row ${index} is invalid`);
  const finite = (value, label) => {
    if (typeof value !== "number" && (typeof value !== "string"
        || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())))
      throw invalid(`${label} must be a numeric value`);
    const number = Number(value);
    if (!Number.isFinite(number)) throw invalid(`${label} must be finite`);
    return number;
  };
  const candle = {
    timestamp: finite(row[0], `row[${index}].timestamp`),
    open: finite(row[1], `row[${index}].open`),
    high: finite(row[2], `row[${index}].high`),
    low: finite(row[3], `row[${index}].low`),
    close: finite(row[4], `row[${index}].close`),
    volume: finite(row[5], `row[${index}].volume`),
    quoteVolume: row[6] === undefined ? undefined : finite(row[6], `row[${index}].quoteVolume`),
  };
  if (!Number.isSafeInteger(candle.timestamp) || candle.timestamp <= 0) throw invalid(`row[${index}].timestamp is invalid`);
  if ([candle.open, candle.high, candle.low, candle.close].some((value) => value <= 0)) {
    throw invalid(`row[${index}] prices must be positive`);
  }
  if (candle.volume < 0 || (candle.quoteVolume !== undefined && candle.quoteVolume < 0)
      || candle.high < Math.max(candle.open, candle.close)
      || candle.low > Math.min(candle.open, candle.close) || candle.high < candle.low) {
    throw invalid(`row[${index}] has invalid OHLCV relationships`);
  }
  return Object.freeze(candle);
}

function rememberCandle(byTimestamp, candle) {
  const previous = byTimestamp.get(candle.timestamp);
  if (previous && ["open", "high", "low", "close", "volume", "quoteVolume"]
    .some((key) => previous[key] !== candle[key])) throw dataError("BITGET_HISTORY_DUPLICATE_CONFLICT");
  byTimestamp.set(candle.timestamp, candle);
}

function sortAndDeduplicate(candles, seen) {
  const byTimestamp = new Map();
  for (const candle of candles) {
    rememberCandle(byTimestamp, candle);
    if (seen) rememberCandle(seen, candle);
  }
  return [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function assertCandleAlignment(candles, timeframe, intervalMs) {
  // Generic 1D / 1day are exchange-day candles, not the explicit 1Dutc
  // native-PIT endpoint. Preserve their timezone offset instead of relabeling.
  const alignmentMs = timeframe === "1d" ? TIMEFRAME_MS["1m"] : intervalMs;
  for (const candle of candles) {
    if (candle.timestamp % alignmentMs !== 0) throw dataError("BITGET_HISTORY_INVALID_CANDLE_BOUNDARY");
  }
}

function alignDown(timestamp, intervalMs) {
  return Math.floor(timestamp / intervalMs) * intervalMs;
}

export async function collectBitgetCandles({
  client,
  market,
  symbol,
  timeframe,
  startTime,
  endTime = Date.now(),
  maxCandles = 50_000,
  minCandles = 60,
  requireFullWindow = timeframe === "1m",
  allowPartialSource = false,
  productType = "usdt-futures",
  onPage,
}) {
  if (!client || typeof client.get !== "function") throw new TypeError("client.get is required");
  assertSymbol(symbol);
  assertTimeframe(timeframe);
  if (!Number.isInteger(startTime) || startTime <= 0) throw new TypeError("startTime must be a positive integer");
  if (!Number.isInteger(endTime) || endTime <= startTime) throw new TypeError("endTime must be greater than startTime");
  if (!Number.isInteger(maxCandles) || maxCandles < 2 || maxCandles > 500_000)
    throw new TypeError("maxCandles must be between 2 and 500000");
  if (typeof requireFullWindow !== "boolean")
    throw new TypeError("requireFullWindow must be boolean");
  if (typeof allowPartialSource !== "boolean" || (allowPartialSource
      && (timeframe !== "1m" || requireFullWindow !== false)))
    throw new TypeError("allowPartialSource requires explicit 1m source-only collection with requireFullWindow=false");
  if (!Number.isInteger(minCandles) || minCandles < (allowPartialSource ? 1 : 2) || minCandles > maxCandles)
    throw new TypeError(`minCandles must be ${allowPartialSource ? 1 : 2}..maxCandles`);
  if (!new Set(["CRYPTO_SPOT", "CRYPTO_FUTURES"]).has(market)) throw new TypeError("market must be CRYPTO_SPOT or CRYPTO_FUTURES");

  const intervalMs = TIMEFRAME_MS[timeframe];
  const isFutures = market === "CRYPTO_FUTURES";
  const endpoint = isFutures ? BITGET_ENDPOINTS.futuresHistoryCandles : BITGET_ENDPOINTS.spotHistoryCandles;
  const granularity = (isFutures ? FUTURES_GRANULARITY : SPOT_GRANULARITY)[timeframe];
  const pageLimit = 200;
  const all = [];
  const seen = new Map();
  const collectedAt = Date.now();
  const closedAsOfTime = Math.min(endTime, collectedAt);
  // Bitget's endTime is exclusive (candles before this timestamp). Aligning down
  // keeps page boundaries intact. The explicit bar-end check below also excludes
  // an unfinished exchange-day candle when its timezone offset is not UTC.
  let cursorEnd = alignDown(closedAsOfTime, intervalMs);
  let page = 0;
  let previousOldest = Number.POSITIVE_INFINITY;
  let reachedRequestedStart = false;

  while (cursorEnd > startTime && all.length < maxCandles) {
    const params = {
      symbol,
      granularity,
      endTime: cursorEnd,
      limit: pageLimit,
      ...(isFutures ? { productType } : {}),
    };
    const payload = await client.get(endpoint, params);
    if (!Array.isArray(payload?.data)) throw dataError("BITGET_HISTORY_INVALID_RESPONSE", "Bitget candle response data must be an array");
    if (payload.data.length > pageLimit) throw dataError("BITGET_HISTORY_INVALID_PAGE_SIZE");
    if (payload.data.length === 0) break;

    const normalizedPage = sortAndDeduplicate(payload.data.map(normalizeBitgetCandle), seen);
    assertCandleAlignment(normalizedPage, timeframe, intervalMs);
    const batch = normalizedPage.filter((candle) => candle.timestamp >= startTime && candle.timestamp < cursorEnd
      && candle.timestamp + intervalMs <= closedAsOfTime);
    const rawOldest = normalizedPage[0]?.timestamp;
    if (!Number.isFinite(rawOldest)) throw new TypeError("Bitget candle page does not contain a valid timestamp");
    if (rawOldest >= previousOldest || rawOldest >= cursorEnd) {
      throw dataError("BITGET_HISTORY_PAGINATION_STALLED", "pagination did not move backward; collection stopped to prevent an infinite loop");
    }
    if (rawOldest <= startTime) reachedRequestedStart = true;

    if (batch.length > 0) {
      all.push(...batch);
      page += 1;
      await onPage?.(Object.freeze({
        page,
        received: batch.length,
        oldest: batch[0].timestamp,
        newest: batch.at(-1).timestamp,
      }));
    }

    previousOldest = rawOldest;
    // endTime is exclusive, so using the oldest returned timestamp requests the
    // immediately preceding candle on the next page. Subtracting an interval here
    // would skip exactly one candle at every page boundary.
    cursorEnd = rawOldest;
    if (payload.data.length < pageLimit) break;
  }

  const candles = sortAndDeduplicate(all)
    .filter((candle) => candle.timestamp >= startTime && candle.timestamp + intervalMs <= closedAsOfTime)
    .slice(-maxCandles);
  const rawPageWindowTraversed = reachedRequestedStart && all.length <= maxCandles && endTime <= collectedAt;
  if (requireFullWindow && !rawPageWindowTraversed)
    throw dataError("BITGET_HISTORY_RANGE_INCOMPLETE");
  if (candles.length < minCandles) throw dataError("BITGET_HISTORY_INSUFFICIENT_CANDLES", `not enough candles collected: ${candles.length}`);
  return Object.freeze({
    schemaVersion: 1,
    provider: "bitget-public-v2",
    collectedAt,
    market,
    symbol,
    timeframe,
    productType: isFutures ? productType : undefined,
    requestedStartTime: startTime, requestedEndTime: endTime, closedAsOfTime,
    intervalMs,
    reachedRequestedStart, rawPageWindowTraversed,
    historicalSignalAvailabilityProven: false,
    historicPointInTimeContractUniverseComplete: false,
    missingMinuteNoTradeProof: false,
    exactFirstTradeTimestampProven: false,
    actualFillProven: false,
    candles: Object.freeze(candles),
  });
}

export async function collectBitgetFuturesReferenceCandles({
  client,
  priceType,
  symbol,
  timeframe,
  startTime,
  endTime = Date.now(),
  maxCandles = 50_000,
  productType = "usdt-futures",
  onPage,
}) {
  if (!client || typeof client.get !== "function") throw new TypeError("client.get is required");
  assertSymbol(symbol);
  assertTimeframe(timeframe);
  if (!new Set(["mark", "index"]).has(priceType)) throw new TypeError("priceType must be mark or index");
  if (!Number.isInteger(startTime) || startTime <= 0) throw new TypeError("startTime must be a positive integer");
  if (!Number.isInteger(endTime) || endTime <= startTime) throw new TypeError("endTime must be greater than startTime");
  if (!Number.isInteger(maxCandles) || maxCandles < 60 || maxCandles > 500_000) {
    throw new TypeError("maxCandles must be between 60 and 500000");
  }

  const intervalMs = TIMEFRAME_MS[timeframe];
  const endpoint = priceType === "mark"
    ? BITGET_ENDPOINTS.futuresHistoryMarkCandles
    : BITGET_ENDPOINTS.futuresHistoryIndexCandles;
  const granularity = FUTURES_GRANULARITY[timeframe];
  const pageLimit = 200;
  const all = [];
  const seen = new Map();
  const collectedAt = Date.now();
  const closedAsOfTime = Math.min(endTime, collectedAt);
  let cursorEnd = alignDown(closedAsOfTime, intervalMs);
  let page = 0;
  let previousOldest = Number.POSITIVE_INFINITY;

  while (cursorEnd > startTime && all.length < maxCandles) {
    const payload = await client.get(endpoint, {
      symbol,
      productType,
      granularity,
      endTime: cursorEnd,
      limit: pageLimit,
    });
    if (!Array.isArray(payload?.data)) throw dataError("BITGET_HISTORY_INVALID_RESPONSE", "Bitget reference candle response data must be an array");
    if (payload.data.length > pageLimit) throw dataError("BITGET_HISTORY_INVALID_PAGE_SIZE");
    if (payload.data.length === 0) break;

    const normalizedPage = sortAndDeduplicate(payload.data.map(normalizeBitgetCandle), seen);
    assertCandleAlignment(normalizedPage, timeframe, intervalMs);
    const batch = normalizedPage.filter((candle) => candle.timestamp >= startTime && candle.timestamp < cursorEnd
      && candle.timestamp + intervalMs <= closedAsOfTime);
    const rawOldest = normalizedPage[0]?.timestamp;
    if (!Number.isFinite(rawOldest)) throw new TypeError("Bitget reference candle page has no valid timestamp");
    if (rawOldest >= previousOldest || rawOldest >= cursorEnd) {
      throw dataError("BITGET_HISTORY_PAGINATION_STALLED", "reference candle pagination did not move backward");
    }

    if (batch.length > 0) {
      all.push(...batch);
      page += 1;
      await onPage?.(Object.freeze({
        page,
        priceType,
        received: batch.length,
        oldest: batch[0].timestamp,
        newest: batch.at(-1).timestamp,
      }));
    }
    previousOldest = rawOldest;
    cursorEnd = rawOldest;
    if (payload.data.length < pageLimit) break;
  }

  const candles = sortAndDeduplicate(all)
    .filter((candle) => candle.timestamp >= startTime && candle.timestamp + intervalMs <= closedAsOfTime)
    .slice(-maxCandles);
  if (candles.length < 60) throw new Error(`not enough ${priceType} candles collected: ${candles.length}`);
  return Object.freeze({
    schemaVersion: 1,
    provider: "bitget-public-v2",
    priceType,
    collectedAt,
    requestedStartTime: startTime, requestedEndTime: endTime, closedAsOfTime,
    market: "CRYPTO_FUTURES",
    symbol,
    timeframe,
    productType,
    candles: Object.freeze(candles),
  });
}

export async function collectBitgetFuturesContext({ client, symbol, productType = "usdt-futures" }) {
  assertSymbol(symbol);
  const common = { symbol, productType };
  const [openInterest, currentFunding, fundingHistory, symbolPrice] = await Promise.all([
    client.get(BITGET_ENDPOINTS.openInterest, common),
    client.get(BITGET_ENDPOINTS.currentFunding, common),
    client.get(BITGET_ENDPOINTS.fundingHistory, { ...common, pageSize: 100, pageNo: 1 }),
    client.get(BITGET_ENDPOINTS.symbolPrice, common),
  ]);
  const oiItem = openInterest.data?.openInterestList?.[0];
  const fundingItem = currentFunding.data?.[0];
  const priceItem = symbolPrice.data?.[0];
  const openInterestRaw = oiItem ? toDecimalString(oiItem.size, "openInterest") : null;
  const fundingRateRaw = fundingItem ? toDecimalString(fundingItem.fundingRate, "fundingRate") : null;
  const marketPriceRaw = priceItem ? toDecimalString(priceItem.price, "marketPrice") : null;
  const markPriceRaw = priceItem ? toDecimalString(priceItem.markPrice, "markPrice") : null;
  const indexPriceRaw = priceItem ? toDecimalString(priceItem.indexPrice, "indexPrice") : null;
  return Object.freeze({
    schemaVersion: 1,
    provider: "bitget-public-v2",
    collectedAt: Date.now(),
    symbol,
    productType,
    openInterest: openInterestRaw === null ? null : toFiniteNumber(openInterestRaw, "openInterest"),
    openInterestRaw,
    openInterestTimestamp: openInterest.data?.ts ? toFiniteNumber(openInterest.data.ts, "openInterestTimestamp") : null,
    fundingRate: fundingRateRaw === null ? null : toFiniteNumber(fundingRateRaw, "fundingRate"),
    fundingRateRaw,
    fundingIntervalHours: fundingItem ? toFiniteNumber(fundingItem.fundingRateInterval, "fundingRateInterval") : null,
    marketPrice: marketPriceRaw === null ? null : toFiniteNumber(marketPriceRaw, "marketPrice"),
    marketPriceRaw,
    markPrice: markPriceRaw === null ? null : toFiniteNumber(markPriceRaw, "markPrice"),
    markPriceRaw,
    indexPrice: indexPriceRaw === null ? null : toFiniteNumber(indexPriceRaw, "indexPrice"),
    indexPriceRaw,
    fundingHistory: Object.freeze((fundingHistory.data ?? []).map((item, index) => {
      const rateRaw = toDecimalString(item.fundingRate, `fundingHistory[${index}].fundingRate`);
      return Object.freeze({
        timestamp: toFiniteNumber(item.fundingTime, `fundingHistory[${index}].fundingTime`),
        rate: toFiniteNumber(rateRaw, `fundingHistory[${index}].fundingRate`),
        rateRaw,
      });
    }).sort((a, b) => a.timestamp - b.timestamp)),
  });
}

export const BITGET_TIMEFRAME_MS = TIMEFRAME_MS;
