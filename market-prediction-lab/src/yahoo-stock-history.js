import { PredictionInputError } from "./contracts.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 12_000;

function cleanSymbol(value) {
  const symbol = String(value ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9._:-]{1,40}$/.test(symbol)) {
    throw new PredictionInputError("invalid Yahoo stock symbol", { symbol: value });
  }
  return symbol;
}

export function yahooStockProviderSymbol(market, symbol) {
  const clean = cleanSymbol(symbol);
  if (market === "KR_STOCK") {
    if (/^\d{6}\.(KS|KQ)$/.test(clean)) return clean;
    if (!/^\d{6}$/.test(clean)) {
      throw new PredictionInputError("KR_STOCK symbol must be a six-digit code or .KS/.KQ symbol", { symbol });
    }
    return `${clean}.KS`;
  }
  if (market === "US_STOCK") return clean;
  throw new PredictionInputError("Yahoo stock collector supports KR_STOCK or US_STOCK only", { market });
}

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function linkedSignal(parent, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("YAHOO_STOCK_HISTORY_TIMEOUT")), timeoutMs);
  const abort = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    },
  };
}

async function fetchJson(fetchImpl, url, signal, timeoutMs) {
  const linked = linkedSignal(signal, timeoutMs);
  try {
    const response = await fetchImpl(url, {
      redirect: "follow",
      signal: linked.signal,
      headers: {
        accept: "application/json,text/plain,*/*",
        "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      },
    });
    if (!response.ok) throw new Error(`YAHOO_STOCK_HTTP_${response.status}`);
    return await response.json();
  } finally {
    linked.clear();
  }
}

function parseCandles(result) {
  const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
  const quote = result?.indicators?.quote?.[0];
  if (!quote || !timestamps.length) return [];
  const candles = [];
  for (let index = 0; index < timestamps.length; index += 1) {
    const timestampSeconds = finite(timestamps[index]);
    const open = finite(quote.open?.[index]);
    const high = finite(quote.high?.[index]);
    const low = finite(quote.low?.[index]);
    const close = finite(quote.close?.[index]);
    const volume = finite(quote.volume?.[index]);
    if (timestampSeconds == null || !Number.isInteger(timestampSeconds) || timestampSeconds <= 0) continue;
    if (open == null || high == null || low == null || close == null || volume == null) continue;
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0) continue;
    if (high < Math.max(open, close) || low > Math.min(open, close) || high < low) continue;
    candles.push(Object.freeze({
      timestamp: timestampSeconds * 1000,
      open,
      high,
      low,
      close,
      volume,
    }));
  }
  return candles.sort((left, right) => left.timestamp - right.timestamp);
}

export async function collectYahooStockHistory(raw = {}) {
  const market = raw.market;
  const symbol = cleanSymbol(raw.symbol);
  const providerSymbol = yahooStockProviderSymbol(market, symbol);
  const endTime = Number(raw.endTime ?? Date.now());
  const startTime = Number(raw.startTime ?? endTime - 10 * 365 * DAY_MS);
  const timeoutMs = Number(raw.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const fetchImpl = raw.fetchImpl ?? fetch;
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime <= 0 || endTime <= startTime) {
    throw new PredictionInputError("Yahoo stock history period is invalid", { startTime, endTime });
  }
  if (endTime - startTime > 15 * 366 * DAY_MS) {
    throw new PredictionInputError("Yahoo stock history period exceeds research cap", { startTime, endTime });
  }
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new PredictionInputError("timeoutMs must be between 100 and 60000", { timeoutMs });
  }

  const encoded = encodeURIComponent(providerSymbol);
  const query = `period1=${Math.floor(startTime / 1000)}&period2=${Math.ceil(endTime / 1000)}&interval=1d&events=history&includeAdjustedClose=true`;
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?${query}`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encoded}?${query}`,
  ];
  const errors = [];
  for (const url of urls) {
    try {
      const payload = await fetchJson(fetchImpl, url, raw.signal, timeoutMs);
      const result = payload?.chart?.result?.[0];
      const candles = parseCandles(result);
      if (candles.length < 60) throw new Error(`YAHOO_STOCK_INSUFFICIENT_HISTORY_${candles.length}`);
      return Object.freeze({
        schemaVersion: 1,
        market,
        symbol,
        providerSymbol,
        timeframe: "1d",
        source: "yahoo-public-chart",
        collectedAt: Date.now(),
        requestedStartTime: startTime,
        requestedEndTime: endTime,
        firstTimestamp: candles[0].timestamp,
        lastTimestamp: candles.at(-1).timestamp,
        candleCount: candles.length,
        candles: Object.freeze(candles),
        liveOrderAllowed: false,
        privateAccountRequestAllowed: false,
      });
    } catch (error) {
      if (raw.signal?.aborted) throw error;
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(`YAHOO_STOCK_HISTORY_FAILED:${providerSymbol}:${errors.join("|")}`);
}
