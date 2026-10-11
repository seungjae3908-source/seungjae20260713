import { PredictionInputError } from "./contracts.js";

const BASE_URL = "https://api.upbit.com";
const PAGE_SIZE = 200;
const TIMEFRAMES = Object.freeze({
  "1m": Object.freeze({unit:1,intervalMs:60_000}),
  "1d": Object.freeze({unit:null,intervalMs:86_400_000}),
  "4h": Object.freeze({ unit: 240, intervalMs: 4 * 60 * 60 * 1000 }),
  "60m": Object.freeze({ unit: 60, intervalMs: 60 * 60 * 1000 }),
});

function dataError(code) { return Object.assign(new Error(code), { code }); }

function marketCode(symbol) {
  const clean = String(symbol ?? "").trim().toUpperCase();
  if (/^KRW-[A-Z0-9]{1,20}$/.test(clean)) return clean;
  if (/^[A-Z0-9]{1,20}$/.test(clean)) return `KRW-${clean}`;
  throw new PredictionInputError("invalid Upbit KRW spot symbol", { symbol });
}

function finite(value) {
  if (typeof value !== "number" && (typeof value !== "string"
      || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim()))) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function parseUtcBoundary(value) {
  if (typeof value !== "string") return Number.NaN;
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?[zZ]?$/u.test(text)) return Number.NaN;
  const timestamp = Date.parse(/[zZ]$/u.test(text) ? text : `${text}Z`);
  // Date.parse normalizes impossible dates such as February 30. Do not allow
  // that normalization to manufacture a provider candle boundary.
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 19) !== text.slice(0, 19)) return Number.NaN;
  return timestamp;
}
function parseRow(row, intervalMs) {
  // Upbit's timestamp is the last trade time, never the candle start time.
  const timestamp = parseUtcBoundary(row?.candle_date_time_utc);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp % intervalMs !== 0)
    throw dataError("UPBIT_HISTORY_INVALID_CANDLE_BOUNDARY");
  const open = finite(row?.opening_price); const high = finite(row?.high_price); const low = finite(row?.low_price); const close = finite(row?.trade_price); const volume = finite(row?.candle_acc_trade_volume);
  const quoteVolume = row?.candle_acc_trade_price === undefined ? null : finite(row.candle_acc_trade_price);
  if (open == null || high == null || low == null || close == null || volume == null
      || (row?.candle_acc_trade_price !== undefined && quoteVolume == null))
    throw dataError("UPBIT_HISTORY_INVALID_OHLCV");
  if (open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0 || (quoteVolume != null && quoteVolume < 0)
      || high < Math.max(open, close) || low > Math.min(open, close) || high < low)
    throw dataError("UPBIT_HISTORY_INVALID_OHLCV");
  return Object.freeze({ timestamp, open, high, low, close, volume, quoteVolume });
}
function rememberCandle(byTimestamp, candle) {
  const previous = byTimestamp.get(candle.timestamp);
  if (previous && ["open", "high", "low", "close", "volume", "quoteVolume"]
    .some((key) => previous[key] !== candle[key])) throw dataError("UPBIT_HISTORY_DUPLICATE_CONFLICT");
  byTimestamp.set(candle.timestamp, candle);
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export async function collectUpbitSpotHistory(raw = {}) {
  const market = marketCode(raw.symbol);
  const timeframe = String(raw.timeframe ?? "4h").trim();
  const timeframeConfig = TIMEFRAMES[timeframe];
  if (!timeframeConfig) throw new PredictionInputError("unsupported Upbit history timeframe", { timeframe });
  const collectedAt = Date.now();
  const endTime = Number(raw.endTime ?? collectedAt);
  const startTime = Number(raw.startTime ?? endTime - 240 * 24 * 60 * 60 * 1000);
  const fetchImpl = raw.fetchImpl ?? fetch;
  const minIntervalMs = Number(raw.minIntervalMs ?? 120);
  const maxPages = Number(raw.maxPages ?? 40);
  const timeoutMs = Number(raw.timeoutMs ?? 12_000);
  const minCandles = Number(raw.minCandles ?? 120);
  const requireFullWindow = raw.requireFullWindow ?? (timeframe === "1m");
  const allowPartialSource = raw.allowPartialSource ?? false;
  if (typeof requireFullWindow !== "boolean") throw new PredictionInputError("requireFullWindow must be boolean");
  if (typeof allowPartialSource !== "boolean" || (allowPartialSource
      && (timeframe !== "1m" || requireFullWindow !== false)))
    throw new PredictionInputError("allowPartialSource requires explicit 1m source-only collection with requireFullWindow=false");
  if (!Number.isInteger(minCandles) || minCandles < (timeframe === "1d" || allowPartialSource ? 1 : 2) || minCandles > 20_000) throw new PredictionInputError("minCandles invalid for timeframe", {minCandles});
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime <= 0 || endTime <= startTime) throw new PredictionInputError("invalid Upbit history range", { startTime, endTime });
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new PredictionInputError("maxPages must be 1..100");
  if (!Number.isInteger(minIntervalMs) || minIntervalMs < 0 || minIntervalMs > 10_000) throw new PredictionInputError("minIntervalMs must be 0..10000");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw new PredictionInputError("timeoutMs must be 100..60000");
  const closedAsOfTime = Math.min(endTime, collectedAt);
  const closedEndTime = Math.floor(closedAsOfTime / timeframeConfig.intervalMs) * timeframeConfig.intervalMs;
  const byTimestamp = new Map(); const seen = new Map(); let cursor = closedEndTime; let pages = 0; let reachedRequestedStart = false;
  while (cursor > startTime && pages < maxPages) {
    const to = new Date(cursor).toISOString();
    const venuePath = timeframe === "1d" ? "/v1/candles/days"
      : `/v1/candles/minutes/${timeframeConfig.unit}`;
    const url = `${BASE_URL}${venuePath}?market=${encodeURIComponent(market)}&to=${encodeURIComponent(to)}&count=${PAGE_SIZE}`;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = raw.signal ? AbortSignal.any([raw.signal, timeoutSignal]) : timeoutSignal;
    let rows;
    try {
      const response = await fetchImpl(url, { signal, headers: { accept: "application/json", "user-agent": "seungjae-prediction-lab/1.0" } });
      if (!response.ok) throw Object.assign(dataError(`UPBIT_HISTORY_HTTP_${response.status}`), { status: response.status });
      try {
        rows = await response.json();
      } catch (error) {
        if (error instanceof SyntaxError) throw dataError("UPBIT_HISTORY_INVALID_RESPONSE");
        throw error;
      }
    } catch (error) {
      if (timeoutSignal.aborted) throw Object.assign(new Error("request timeout: UPBIT_HISTORY_TIMEOUT", { cause: error }), { code: "UPBIT_HISTORY_TIMEOUT" });
      throw error;
    }
    if (!Array.isArray(rows)) throw dataError("UPBIT_HISTORY_INVALID_RESPONSE");
    if (rows.length > PAGE_SIZE) throw dataError("UPBIT_HISTORY_INVALID_PAGE_SIZE");
    if (!rows.length) break;
    let oldest = Number.POSITIVE_INFINITY;
    for (const rawRow of rows) {
      // A native all-name PIT price intake cannot trust a response for
      // another pair, or a response omitting its provider identity.
      if ((raw.requireMarketIdentity === true && rawRow?.market !== market)
          || (rawRow?.market !== undefined && rawRow.market !== market)) {
        throw dataError("UPBIT_HISTORY_MARKET_IDENTITY_UNVERIFIED");
      }
      const candle = parseRow(rawRow, timeframeConfig.intervalMs);
      rememberCandle(seen, candle);
      oldest = Math.min(oldest, candle.timestamp);
      if (candle.timestamp >= startTime && candle.timestamp + timeframeConfig.intervalMs <= closedAsOfTime)
        rememberCandle(byTimestamp, candle);
    }
    pages += 1;
    if (!Number.isFinite(oldest)) throw dataError("UPBIT_HISTORY_PAGE_TIMESTAMP_MISSING");
    if (oldest >= cursor) throw dataError("UPBIT_HISTORY_PAGINATION_STALLED");
    if (oldest <= startTime) { reachedRequestedStart = true; break; }
    // `to` is exclusive. Reuse the oldest boundary without inventing a gap.
    cursor = oldest; if (minIntervalMs > 0) await sleep(minIntervalMs);
  }
  const candles = [...byTimestamp.values()].sort((left, right) => left.timestamp - right.timestamp);
  const rawPageWindowTraversed = reachedRequestedStart && endTime <= collectedAt;
  if (requireFullWindow && !rawPageWindowTraversed) throw dataError("UPBIT_HISTORY_RANGE_INCOMPLETE");
  if (candles.length < minCandles) throw dataError(`UPBIT_HISTORY_INSUFFICIENT_${candles.length}`);
  return Object.freeze({ schemaVersion: 1, market: "CRYPTO_SPOT", exchange: "UPBIT", providerMarket: market, symbol: market.replace(/^KRW-/, ""), timeframe, intervalMs: timeframeConfig.intervalMs, source: "upbit-public-candles", collectedAt, requestedStartTime: startTime, requestedEndTime: endTime, closedAsOfTime, pageCount: pages, reachedRequestedStart, rawPageWindowTraversed, historicalSignalAvailabilityProven: false, historicPointInTimeListingComplete: false, missingMinuteNoTradeProof: false, exactFirstTradeTimestampProven: false, actualFillProven: false, candleCount: candles.length, firstTimestamp: candles[0].timestamp, lastTimestamp: candles.at(-1).timestamp, candles: Object.freeze(candles), liveOrderAllowed: false, privateAccountRequestAllowed: false });
}

export { marketCode as upbitKrwMarketCode };
