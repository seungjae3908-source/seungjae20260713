import { BITGET_ENDPOINTS } from "./bitget-public-client.js";

const TIMEFRAME_MS = Object.freeze({
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
});

const FUTURES_GRANULARITY = Object.freeze({ "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D" });
const SPOT_GRANULARITY = Object.freeze({ "15m": "15min", "1h": "1h", "4h": "4h", "1d": "1day" });

function assertSymbol(symbol) {
  if (typeof symbol !== "string" || !/^[A-Z0-9]{3,30}$/.test(symbol)) {
    throw new TypeError("symbol must contain 3-30 uppercase letters or digits");
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

export function normalizeBitgetCandle(row, index = 0) {
  if (!Array.isArray(row) || row.length < 6) throw new TypeError(`candle row ${index} is invalid`);
  const candle = {
    timestamp: toFiniteNumber(row[0], `row[${index}].timestamp`),
    open: toFiniteNumber(row[1], `row[${index}].open`),
    high: toFiniteNumber(row[2], `row[${index}].high`),
    low: toFiniteNumber(row[3], `row[${index}].low`),
    close: toFiniteNumber(row[4], `row[${index}].close`),
    volume: toFiniteNumber(row[5], `row[${index}].volume`),
    quoteVolume: row[6] === undefined ? undefined : toFiniteNumber(row[6], `row[${index}].quoteVolume`),
  };
  if (!Number.isInteger(candle.timestamp) || candle.timestamp <= 0) throw new TypeError(`row[${index}].timestamp is invalid`);
  if ([candle.open, candle.high, candle.low, candle.close].some((value) => value <= 0)) {
    throw new TypeError(`row[${index}] prices must be positive`);
  }
  if (candle.volume < 0 || candle.high < Math.max(candle.open, candle.close)
      || candle.low > Math.min(candle.open, candle.close) || candle.high < candle.low) {
    throw new TypeError(`row[${index}] has invalid OHLCV relationships`);
  }
  return Object.freeze(candle);
}

function sortAndDeduplicate(candles) {
  const byTimestamp = new Map();
  for (const candle of candles) byTimestamp.set(candle.timestamp, candle);
  return [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
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
  productType = "usdt-futures",
  onPage,
}) {
  if (!client || typeof client.get !== "function") throw new TypeError("client.get is required");
  assertSymbol(symbol);
  assertTimeframe(timeframe);
  if (!Number.isInteger(startTime) || startTime <= 0) throw new TypeError("startTime must be a positive integer");
  if (!Number.isInteger(endTime) || endTime <= startTime) throw new TypeError("endTime must be greater than startTime");
  if (!Number.isInteger(maxCandles) || maxCandles < 60 || maxCandles > 500_000) {
    throw new TypeError("maxCandles must be between 60 and 500000");
  }
  if (!new Set(["CRYPTO_SPOT", "CRYPTO_FUTURES"]).has(market)) throw new TypeError("market must be CRYPTO_SPOT or CRYPTO_FUTURES");

  const intervalMs = TIMEFRAME_MS[timeframe];
  const isFutures = market === "CRYPTO_FUTURES";
  const endpoint = isFutures ? BITGET_ENDPOINTS.futuresHistoryCandles : BITGET_ENDPOINTS.spotHistoryCandles;
  const granularity = (isFutures ? FUTURES_GRANULARITY : SPOT_GRANULARITY)[timeframe];
  const pageLimit = 200;
  const all = [];
  let cursorEnd = alignDown(endTime, intervalMs);
  let page = 0;
  let previousOldest = Number.POSITIVE_INFINITY;

  while (cursorEnd > startTime && all.length < maxCandles) {
    const params = {
      symbol,
      granularity,
      endTime: cursorEnd,
      limit: pageLimit,
      ...(isFutures ? { productType } : {}),
    };
    const payload = await client.get(endpoint, params);
    if (!Array.isArray(payload.data)) throw new TypeError("Bitget candle response data must be an array");
    if (payload.data.length === 0) break;

    const batch = sortAndDeduplicate(payload.data.map(normalizeBitgetCandle))
      .filter((candle) => candle.timestamp >= startTime && candle.timestamp <= endTime);
    if (batch.length === 0) {
      const rawOldest = Math.min(...payload.data.map((row) => Number(row[0])).filter(Number.isFinite));
      if (!Number.isFinite(rawOldest) || rawOldest >= previousOldest) break;
      previousOldest = rawOldest;
      cursorEnd = rawOldest - intervalMs;
      continue;
    }

    all.push(...batch);
    page += 1;
    await onPage?.(Object.freeze({ page, received: batch.length, oldest: batch[0].timestamp, newest: batch.at(-1).timestamp }));
    const oldest = batch[0].timestamp;
    if (oldest >= previousOldest) throw new Error("pagination did not move backward; collection stopped to prevent an infinite loop");
    previousOldest = oldest;
    cursorEnd = oldest - intervalMs;
    if (payload.data.length < pageLimit) break;
  }

  const candles = sortAndDeduplicate(all)
    .filter((candle) => candle.timestamp >= startTime && candle.timestamp <= endTime)
    .slice(-maxCandles);
  if (candles.length < 60) throw new Error(`not enough candles collected: ${candles.length}`);
  return Object.freeze({
    schemaVersion: 1,
    provider: "bitget-public-v2",
    collectedAt: Date.now(),
    market,
    symbol,
    timeframe,
    productType: isFutures ? productType : undefined,
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
  return Object.freeze({
    schemaVersion: 1,
    provider: "bitget-public-v2",
    collectedAt: Date.now(),
    symbol,
    productType,
    openInterest: oiItem ? toFiniteNumber(oiItem.size, "openInterest") : null,
    openInterestTimestamp: openInterest.data?.ts ? toFiniteNumber(openInterest.data.ts, "openInterestTimestamp") : null,
    fundingRate: fundingItem ? toFiniteNumber(fundingItem.fundingRate, "fundingRate") : null,
    fundingIntervalHours: fundingItem ? toFiniteNumber(fundingItem.fundingRateInterval, "fundingRateInterval") : null,
    marketPrice: priceItem ? toFiniteNumber(priceItem.price, "marketPrice") : null,
    markPrice: priceItem ? toFiniteNumber(priceItem.markPrice, "markPrice") : null,
    indexPrice: priceItem ? toFiniteNumber(priceItem.indexPrice, "indexPrice") : null,
    fundingHistory: Object.freeze((fundingHistory.data ?? []).map((item, index) => Object.freeze({
      timestamp: toFiniteNumber(item.fundingTime, `fundingHistory[${index}].fundingTime`),
      rate: toFiniteNumber(item.fundingRate, `fundingHistory[${index}].fundingRate`),
    })).sort((a, b) => a.timestamp - b.timestamp)),
  });
}

export const BITGET_TIMEFRAME_MS = TIMEFRAME_MS;
