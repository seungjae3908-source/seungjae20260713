import { PredictionInputError } from "./contracts.js";

const BASE_URL = "https://api.upbit.com";
const PAGE_SIZE = 200;
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

function marketCode(symbol) {
  const clean = String(symbol ?? "").trim().toUpperCase();
  if (/^KRW-[A-Z0-9]{2,20}$/.test(clean)) return clean;
  if (/^[A-Z0-9]{2,20}$/.test(clean)) return `KRW-${clean}`;
  throw new PredictionInputError("invalid Upbit KRW spot symbol", { symbol });
}

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRow(row) {
  const timestamp = finite(row?.timestamp) ?? Date.parse(String(row?.candle_date_time_utc ?? ""));
  const open = finite(row?.opening_price);
  const high = finite(row?.high_price);
  const low = finite(row?.low_price);
  const close = finite(row?.trade_price);
  const volume = finite(row?.candle_acc_trade_volume);
  if (!Number.isFinite(timestamp) || timestamp <= 0 || open == null || high == null || low == null || close == null || volume == null) return null;
  if (open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0) return null;
  if (high < Math.max(open, close) || low > Math.min(open, close) || high < low) return null;
  return Object.freeze({ timestamp: Math.floor(timestamp), open, high, low, close, volume });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function collectUpbitSpotHistory(raw = {}) {
  const market = marketCode(raw.symbol);
  const endTime = Number(raw.endTime ?? Date.now());
  const startTime = Number(raw.startTime ?? endTime - 240 * 24 * 60 * 60 * 1000);
  const fetchImpl = raw.fetchImpl ?? fetch;
  const minIntervalMs = Number(raw.minIntervalMs ?? 120);
  const maxPages = Number(raw.maxPages ?? 40);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime <= 0 || endTime <= startTime) {
    throw new PredictionInputError("invalid Upbit history range", { startTime, endTime });
  }
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new PredictionInputError("maxPages must be 1..100");

  const byTimestamp = new Map();
  let cursor = endTime;
  let pages = 0;
  while (cursor > startTime && pages < maxPages) {
    const to = new Date(cursor).toISOString();
    const url = `${BASE_URL}/v1/candles/minutes/240?market=${encodeURIComponent(market)}&to=${encodeURIComponent(to)}&count=${PAGE_SIZE}`;
    const response = await fetchImpl(url, { headers: { accept: "application/json", "user-agent": "seungjae-prediction-lab/1.0" } });
    if (!response.ok) throw new Error(`UPBIT_HISTORY_HTTP_${response.status}`);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error("UPBIT_HISTORY_INVALID_RESPONSE");
    if (!rows.length) break;
    let oldest = Number.POSITIVE_INFINITY;
    for (const rawRow of rows) {
      const candle = parseRow(rawRow);
      if (!candle) continue;
      oldest = Math.min(oldest, candle.timestamp);
      if (candle.timestamp >= startTime && candle.timestamp < endTime) byTimestamp.set(candle.timestamp, candle);
    }
    pages += 1;
    if (!Number.isFinite(oldest)) break;
    if (oldest <= startTime) break;
    const nextCursor = oldest - 1;
    if (nextCursor >= cursor) break;
    cursor = nextCursor;
    if (minIntervalMs > 0) await sleep(minIntervalMs);
  }

  const candles = [...byTimestamp.values()].sort((left, right) => left.timestamp - right.timestamp);
  if (candles.length < 120) throw new Error(`UPBIT_HISTORY_INSUFFICIENT_${candles.length}`);
  return Object.freeze({
    schemaVersion: 1,
    market: "CRYPTO_SPOT",
    exchange: "UPBIT",
    providerMarket: market,
    symbol: market.replace(/^KRW-/, ""),
    timeframe: "4h",
    intervalMs: FOUR_HOURS_MS,
    source: "upbit-public-candles",
    requestedStartTime: startTime,
    requestedEndTime: endTime,
    pageCount: pages,
    candleCount: candles.length,
    firstTimestamp: candles[0].timestamp,
    lastTimestamp: candles.at(-1).timestamp,
    candles: Object.freeze(candles),
    liveOrderAllowed: false,
    privateAccountRequestAllowed: false,
  });
}

export { marketCode as upbitKrwMarketCode };
