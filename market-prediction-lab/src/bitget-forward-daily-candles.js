import { normalizeBitgetCandle } from "./bitget-candle-collector.js";
import { ResearchContractError } from "./research-governance.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_ENDPOINT = "/api/v2/mix/market/history-candles";
const CURRENT_ENDPOINT = "/api/v2/mix/market/candles";
const GRANULARITY = "1Dutc";
const DEFAULT_PRODUCT_TYPE = "usdt-futures";

function utcDayStart(timestamp) {
  return Math.floor(timestamp / DAY_MS) * DAY_MS;
}

function validateAsOf(asOf) {
  if (!Number.isInteger(asOf) || asOf <= 0) throw new ResearchContractError("INVALID_FORWARD_ASOF", "forward candle asOf must be a positive integer");
  return asOf;
}

function validateSymbol(symbol) {
  if (typeof symbol !== "string" || !/^[A-Z0-9]{3,30}$/u.test(symbol)) throw new ResearchContractError("INVALID_FORWARD_SYMBOL", "forward candle symbol is invalid");
  return symbol;
}

function assertUtcDaily(candle, label) {
  if (candle.timestamp % DAY_MS !== 0) {
    throw new ResearchContractError("NON_UTC_DAILY_CANDLE", `${label} is not aligned to a UTC daily boundary`, { timestamp: candle.timestamp });
  }
  return candle;
}

function uniqueSorted(candles) {
  const byTimestamp = new Map();
  for (const candle of candles) {
    const existing = byTimestamp.get(candle.timestamp);
    if (existing && JSON.stringify(existing) !== JSON.stringify(candle)) {
      throw new ResearchContractError("FORWARD_CANDLE_CONFLICT", `conflicting forward candle at ${candle.timestamp}`);
    }
    byTimestamp.set(candle.timestamp, candle);
  }
  return [...byTimestamp.values()].sort((left, right) => left.timestamp - right.timestamp);
}

export async function collectBitgetUtcDailyForwardCandles({
  client,
  symbol = "ETHUSDT",
  productType = DEFAULT_PRODUCT_TYPE,
  asOf = Date.now(),
  lookbackDays = 180,
  minimumClosedCandles = 60,
} = {}) {
  if (!client || typeof client.get !== "function") throw new ResearchContractError("INVALID_FORWARD_CLIENT", "Bitget public client is required");
  validateSymbol(symbol);
  validateAsOf(asOf);
  if (!Number.isInteger(lookbackDays) || lookbackDays < 60 || lookbackDays > 1000) throw new ResearchContractError("INVALID_FORWARD_LOOKBACK", "forward daily lookbackDays must be between 60 and 1000");
  if (!Number.isInteger(minimumClosedCandles) || minimumClosedCandles < 1 || minimumClosedCandles > lookbackDays) throw new ResearchContractError("INVALID_FORWARD_MINIMUM", "minimumClosedCandles is invalid");

  const currentOpenTimestamp = utcDayStart(asOf);
  const startTimestamp = currentOpenTimestamp - lookbackDays * DAY_MS;
  const closed = [];
  let cursorEnd = currentOpenTimestamp;
  let previousOldest = Number.POSITIVE_INFINITY;

  while (cursorEnd > startTimestamp && closed.length < lookbackDays) {
    const remaining = Math.max(1, Math.min(200, Math.ceil((cursorEnd - startTimestamp) / DAY_MS)));
    const payload = await client.get(HISTORY_ENDPOINT, {
      symbol,
      productType,
      granularity: GRANULARITY,
      endTime: cursorEnd,
      limit: remaining,
    });
    if (!Array.isArray(payload?.data)) throw new ResearchContractError("INVALID_FORWARD_HISTORY_RESPONSE", "Bitget forward history response data must be an array");
    if (payload.data.length === 0) break;
    const page = uniqueSorted(payload.data.map((row, index) => assertUtcDaily(normalizeBitgetCandle(row, index), "history candle")))
      .filter((candle) => candle.timestamp >= startTimestamp && candle.timestamp < cursorEnd);
    const oldest = page[0]?.timestamp;
    if (!Number.isInteger(oldest)) break;
    if (oldest >= previousOldest) throw new ResearchContractError("FORWARD_PAGINATION_STALLED", "forward daily pagination did not move backward");
    closed.push(...page);
    previousOldest = oldest;
    cursorEnd = oldest;
    if (payload.data.length < remaining) break;
  }

  const closedCandles = uniqueSorted(closed).filter((candle) => candle.timestamp < currentOpenTimestamp).slice(-lookbackDays);
  if (closedCandles.length < minimumClosedCandles) {
    throw new ResearchContractError("INSUFFICIENT_FORWARD_HISTORY", `forward daily history has only ${closedCandles.length} closed candles`, {
      minimumClosedCandles,
    });
  }
  for (let index = 1; index < closedCandles.length; index += 1) {
    if (closedCandles[index].timestamp - closedCandles[index - 1].timestamp !== DAY_MS) {
      throw new ResearchContractError("MISSING_FORWARD_DAILY_CANDLE", "forward daily history contains a missing UTC candle", {
        previous: closedCandles[index - 1].timestamp,
        current: closedCandles[index].timestamp,
      });
    }
  }

  const currentPayload = await client.get(CURRENT_ENDPOINT, {
    symbol,
    productType,
    granularity: GRANULARITY,
    limit: 2,
  });
  if (!Array.isArray(currentPayload?.data)) throw new ResearchContractError("INVALID_FORWARD_CURRENT_RESPONSE", "Bitget current forward candle response data must be an array");
  const currentRows = uniqueSorted(currentPayload.data.map((row, index) => assertUtcDaily(normalizeBitgetCandle(row, index), "current candle")));
  const current = currentRows.find((candle) => candle.timestamp === currentOpenTimestamp);
  if (!current) {
    throw new ResearchContractError("CURRENT_FORWARD_CANDLE_MISSING", "current UTC daily candle is not available", { currentOpenTimestamp });
  }
  const previousClosed = closedCandles.at(-1);
  if (!previousClosed || current.timestamp - previousClosed.timestamp !== DAY_MS) {
    throw new ResearchContractError("FORWARD_CURRENT_GAP", "current UTC daily candle does not directly follow the latest closed candle", {
      previousClosed: previousClosed?.timestamp ?? null,
      current: current.timestamp,
    });
  }

  return Object.freeze({
    schemaVersion: 1,
    provider: "bitget-public-v2",
    market: "CRYPTO_FUTURES",
    symbol,
    timeframe: "1d",
    timezone: "UTC",
    granularity: GRANULARITY,
    collectedAt: asOf,
    closedCandleCount: closedCandles.length,
    currentOpenTimestamp,
    candles: Object.freeze([
      ...closedCandles.map((candle) => Object.freeze({ ...candle, observedAt: candle.timestamp })),
      Object.freeze({ ...current, observedAt: asOf }),
    ]),
  });
}
