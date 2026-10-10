import { PredictionInputError } from "./contracts.js";

const BASE_URL = "https://api.upbit.com";
const PAGE_SIZE = 200;
const TIMEFRAMES = Object.freeze({
  "1m": Object.freeze({unit:1,intervalMs:60_000}),
  "1d": Object.freeze({unit:null,intervalMs:86_400_000}),
  "4h": Object.freeze({ unit: 240, intervalMs: 4 * 60 * 60 * 1000 }),
  "60m": Object.freeze({ unit: 60, intervalMs: 60 * 60 * 1000 }),
});

function marketCode(symbol) {
  const clean = String(symbol ?? "").trim().toUpperCase();
  if (/^KRW-[A-Z0-9]{1,20}$/.test(clean)) return clean;
  if (/^[A-Z0-9]{1,20}$/.test(clean)) return `KRW-${clean}`;
  throw new PredictionInputError("invalid Upbit KRW spot symbol", { symbol });
}

function finite(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
function parseUtcBoundary(value) { const text = String(value ?? "").trim(); if (!text) return Number.NaN; return Date.parse(/[zZ]|[+-]\d\d:\d\d$/u.test(text) ? text : `${text}Z`); }
function parseRow(row) {
  const candleBoundary = parseUtcBoundary(row?.candle_date_time_utc);
  const timestamp = Number.isFinite(candleBoundary) ? candleBoundary : finite(row?.timestamp);
  const open = finite(row?.opening_price); const high = finite(row?.high_price); const low = finite(row?.low_price); const close = finite(row?.trade_price); const volume = finite(row?.candle_acc_trade_volume); const quoteVolume = finite(row?.candle_acc_trade_price);
  if (!Number.isFinite(timestamp) || timestamp <= 0 || open == null || high == null || low == null || close == null || volume == null) return null;
  if (open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0) return null;
  if (high < Math.max(open, close) || low > Math.min(open, close) || high < low) return null;
  return Object.freeze({ timestamp: Math.floor(timestamp), open, high, low, close, volume, quoteVolume: quoteVolume != null && quoteVolume >= 0 ? quoteVolume : null });
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export async function collectUpbitSpotHistory(raw = {}) {
  const market = marketCode(raw.symbol);
  const timeframe = String(raw.timeframe ?? "4h").trim();
  const timeframeConfig = TIMEFRAMES[timeframe];
  if (!timeframeConfig) throw new PredictionInputError("unsupported Upbit history timeframe", { timeframe });
  const endTime = Number(raw.endTime ?? Date.now());
  const startTime = Number(raw.startTime ?? endTime - 240 * 24 * 60 * 60 * 1000);
  const fetchImpl = raw.fetchImpl ?? fetch;
  const minIntervalMs = Number(raw.minIntervalMs ?? 120);
  const maxPages = Number(raw.maxPages ?? 40);
  const minCandles = Number(raw.minCandles ?? 120);
  const requireFullWindow = raw.requireFullWindow ?? (timeframe === "1m");
  if (!Number.isInteger(minCandles) || minCandles < (timeframe === "1d" ? 1 : 2) || minCandles > 20_000) throw new PredictionInputError("minCandles invalid for timeframe", {minCandles});
  if (typeof requireFullWindow !== "boolean") throw new PredictionInputError("requireFullWindow must be boolean");
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime <= 0 || endTime <= startTime) throw new PredictionInputError("invalid Upbit history range", { startTime, endTime });
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new PredictionInputError("maxPages must be 1..100");
  const byTimestamp = new Map(); let cursor = endTime; let pages = 0; let reachedRequestedStart = false;
  while (cursor > startTime && pages < maxPages) {
    const to = new Date(cursor).toISOString();
    const venuePath = timeframe === "1d" ? "/v1/candles/days"
      : `/v1/candles/minutes/${timeframeConfig.unit}`;
    const url = `${BASE_URL}${venuePath}?market=${encodeURIComponent(market)}&to=${encodeURIComponent(to)}&count=${PAGE_SIZE}`;
    const response = await fetchImpl(url, { signal: raw.signal, headers: { accept: "application/json", "user-agent": "seungjae-prediction-lab/1.0" } });
    if (!response.ok) throw Object.assign(new Error(`UPBIT_HISTORY_HTTP_${response.status}`), { status: response.status });
    const rows = await response.json(); if (!Array.isArray(rows)) throw new Error("UPBIT_HISTORY_INVALID_RESPONSE"); if (!rows.length) break;
    let oldest = Number.POSITIVE_INFINITY;
    for (const rawRow of rows) {
      // A native all-name PIT price intake cannot trust a response for
      // another pair, or a response omitting its provider identity.
      if (raw.requireMarketIdentity === true && rawRow?.market !== market) {
        throw new Error("UPBIT_HISTORY_MARKET_IDENTITY_UNVERIFIED");
      }
      const candle = parseRow(rawRow);
      if (!candle) continue;
      oldest = Math.min(oldest, candle.timestamp);
      if (candle.timestamp >= startTime && candle.timestamp < endTime)
        byTimestamp.set(candle.timestamp, candle);
    }
    pages += 1;
    if (!Number.isFinite(oldest)) throw new Error("UPBIT_HISTORY_PAGE_TIMESTAMP_MISSING");
    if (oldest <= startTime) { reachedRequestedStart = true; break; }
    const nextCursor = oldest - 1; if (nextCursor >= cursor) break; cursor = nextCursor; if (minIntervalMs > 0) await sleep(minIntervalMs);
  }
  const candles = [...byTimestamp.values()].sort((left, right) => left.timestamp - right.timestamp);
  if (requireFullWindow && !reachedRequestedStart) throw new Error("UPBIT_HISTORY_RANGE_INCOMPLETE");
  if (candles.length < minCandles) throw new Error(`UPBIT_HISTORY_INSUFFICIENT_${candles.length}`);
  return Object.freeze({ schemaVersion: 1, market: "CRYPTO_SPOT", exchange: "UPBIT", providerMarket: market, symbol: market.replace(/^KRW-/, ""), timeframe, intervalMs: timeframeConfig.intervalMs, source: "upbit-public-candles", requestedStartTime: startTime, requestedEndTime: endTime, pageCount: pages, reachedRequestedStart, rawPageWindowTraversed: reachedRequestedStart, historicalSignalAvailabilityProven: false, historicPointInTimeListingComplete: false, missingMinuteNoTradeProof: false, exactFirstTradeTimestampProven: false, actualFillProven: false, candleCount: candles.length, firstTimestamp: candles[0].timestamp, lastTimestamp: candles.at(-1).timestamp, candles: Object.freeze(candles), liveOrderAllowed: false, privateAccountRequestAllowed: false });
}

export { marketCode as upbitKrwMarketCode };
