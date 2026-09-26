const KLINE_ENDPOINT = "/fapi/v1/klines";
const FUNDING_ENDPOINT = "/fapi/v1/fundingRate";
const DAY_MS = 24 * 60 * 60 * 1000;

function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label} must be finite`);
  return number;
}

function timestamp(value, label) {
  const number = finite(value, label);
  if (!Number.isInteger(number) || number <= 0) throw new TypeError(`${label} must be a positive millisecond timestamp`);
  return number;
}

function assertSymbol(symbol) {
  if (typeof symbol !== "string" || !/^[A-Z0-9]{3,30}$/u.test(symbol)) throw new TypeError("invalid Binance futures symbol");
  return symbol;
}

function normalizeKline(row, symbol, index) {
  if (!Array.isArray(row) || row.length < 6) throw new TypeError(`kline[${index}] is invalid`);
  const candle = {
    symbol,
    timestamp: timestamp(row[0], `kline[${index}].openTime`),
    open: finite(row[1], `kline[${index}].open`),
    high: finite(row[2], `kline[${index}].high`),
    low: finite(row[3], `kline[${index}].low`),
    close: finite(row[4], `kline[${index}].close`),
    volume: finite(row[5], `kline[${index}].volume`),
  };
  if ([candle.open, candle.high, candle.low, candle.close].some((value) => value <= 0)
      || candle.volume < 0
      || candle.high < Math.max(candle.open, candle.close)
      || candle.low > Math.min(candle.open, candle.close)
      || candle.high < candle.low) {
    throw new TypeError(`kline[${index}] has invalid OHLCV relationships`);
  }
  return Object.freeze({ ...candle, observedAt: candle.timestamp, isClosed: true });
}

function normalizeFunding(row, index) {
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new TypeError(`funding[${index}] is invalid`);
  return Object.freeze({
    timestamp: timestamp(row.fundingTime, `funding[${index}].fundingTime`),
    rate: finite(row.fundingRate, `funding[${index}].fundingRate`),
  });
}

function uniqueSorted(rows, valueKeys) {
  const byTimestamp = new Map();
  for (const row of rows) {
    const previous = byTimestamp.get(row.timestamp);
    if (previous && valueKeys.some((key) => previous[key] !== row[key])) {
      throw new Error(`conflicting Binance historical rows at ${row.timestamp}`);
    }
    byTimestamp.set(row.timestamp, row);
  }
  return [...byTimestamp.values()].sort((left, right) => left.timestamp - right.timestamp);
}

export class BinanceFuturesPublicClient {
  constructor({
    baseUrl = "https://fapi.binance.com",
    fetchImpl = globalThis.fetch,
    timeoutMs = 12_000,
    maxRetries = 4,
    sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
    this.baseUrl = new URL(baseUrl).toString();
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.sleepImpl = sleepImpl;
  }

  async get(path, params = {}) {
    let lastError = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const url = new URL(path, this.baseUrl);
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      timer.unref?.();
      try {
        const response = await this.fetchImpl(url, {
          method: "GET",
          headers: { accept: "application/json", "user-agent": "market-prediction-lab/0.9" },
          signal: controller.signal,
        });
        const text = await response.text();
        let payload;
        try { payload = JSON.parse(text); } catch { throw new Error(`Binance returned non-JSON data: ${text.slice(0, 160)}`); }
        if (!response.ok) {
          const retryable = response.status === 429 || response.status >= 500;
          const error = new Error(`Binance public API HTTP ${response.status}: ${payload?.msg ?? "unknown error"}`);
          error.status = response.status;
          error.code = payload?.code ?? null;
          if (retryable && attempt < this.maxRetries) {
            lastError = error;
            await this.sleepImpl(Math.min(500 * (2 ** attempt), 5_000));
            continue;
          }
          throw error;
        }
        return payload;
      } catch (error) {
        if ((error?.name === "AbortError" || error instanceof TypeError) && attempt < this.maxRetries) {
          lastError = error;
          await this.sleepImpl(Math.min(500 * (2 ** attempt), 5_000));
          continue;
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError ?? new Error("Binance public API failed after retries");
  }
}

export async function collectBinanceFuturesDailyKlines({ client, symbol, startTime, endTime, onPage }) {
  if (!client || typeof client.get !== "function") throw new TypeError("client.get is required");
  assertSymbol(symbol);
  timestamp(startTime, "startTime");
  timestamp(endTime, "endTime");
  if (endTime <= startTime) throw new RangeError("endTime must be greater than startTime");
  const rows = [];
  let cursor = startTime;
  let page = 0;
  while (cursor <= endTime) {
    const payload = await client.get(KLINE_ENDPOINT, { symbol, interval: "1d", startTime: cursor, endTime, limit: 1000 });
    if (!Array.isArray(payload)) throw new TypeError("Binance kline response must be an array");
    if (payload.length === 0) break;
    const normalized = payload.map((row, index) => normalizeKline(row, symbol, index));
    rows.push(...normalized.filter((row) => row.timestamp >= startTime && row.timestamp <= endTime));
    page += 1;
    const newest = normalized.at(-1).timestamp;
    await onPage?.(Object.freeze({ page, received: normalized.length, oldest: normalized[0].timestamp, newest }));
    const next = newest + DAY_MS;
    if (next <= cursor) throw new Error("Binance kline pagination did not move forward");
    cursor = next;
    if (payload.length < 1000) break;
  }
  const candles = uniqueSorted(rows, ["open", "high", "low", "close", "volume"]);
  if (candles.length < 60) throw new Error(`not enough Binance futures daily candles: ${candles.length}`);
  return Object.freeze({ schemaVersion: 1, provider: "binance-usdm-public-rest", symbol, timeframe: "1d", startTime, endTime, candles: Object.freeze(candles) });
}

export async function collectBinanceFuturesFundingRates({ client, symbol, startTime, endTime, onPage }) {
  if (!client || typeof client.get !== "function") throw new TypeError("client.get is required");
  assertSymbol(symbol);
  timestamp(startTime, "startTime");
  timestamp(endTime, "endTime");
  if (endTime <= startTime) throw new RangeError("endTime must be greater than startTime");
  const rows = [];
  let cursor = startTime;
  let page = 0;
  while (cursor <= endTime) {
    const payload = await client.get(FUNDING_ENDPOINT, { symbol, startTime: cursor, endTime, limit: 1000 });
    if (!Array.isArray(payload)) throw new TypeError("Binance funding response must be an array");
    if (payload.length === 0) break;
    const normalized = payload.map(normalizeFunding);
    rows.push(...normalized.filter((row) => row.timestamp >= startTime && row.timestamp <= endTime));
    page += 1;
    const newest = normalized.at(-1).timestamp;
    await onPage?.(Object.freeze({ page, received: normalized.length, oldest: normalized[0].timestamp, newest }));
    const next = newest + 1;
    if (next <= cursor) throw new Error("Binance funding pagination did not move forward");
    cursor = next;
    if (payload.length < 1000) break;
  }
  const records = uniqueSorted(rows, ["rate"]);
  if (records.length === 0) throw new Error("Binance futures funding history is empty");
  return Object.freeze({ schemaVersion: 1, provider: "binance-usdm-public-rest", symbol, startTime, endTime, records: Object.freeze(records) });
}
