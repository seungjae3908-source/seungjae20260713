import { BITGET_ENDPOINTS } from "./bitget-public-client.js";
import { normalizeBitgetCandle } from "./bitget-candle-collector.js";
import { collectFundingRateHistory } from "./derivatives-history.js";

export const BITGET_FUNDING_COST_OWNER_VERSION =
  "bitget-funding-cost-only-owner-v1";

const MINUTE_MS = 60_000;
const PAGE_LIMIT = 200;
const MAX_MARK_PAGES = 40;

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function positive(value) {
  return finite(value) && value > 0;
}
function safeTime(value) {
  return Number.isSafeInteger(value) && value > 0;
}
function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function canonicalSymbol(value) {
  if (!nonEmpty(value)) return null;
  const symbol = value.trim().toUpperCase().replace(/[^A-Z0-9]/gu, "");
  return /^[A-Z0-9]{2,24}USDT$/u.test(symbol) ? symbol : null;
}
function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
function blocked(blockers) {
  return deepFreeze({
    schemaVersion: BITGET_FUNDING_COST_OWNER_VERSION,
    status: "BLOCKED_DATA",
    complete: false,
    fullCoverage: false,
    payments: [],
    totalFundingCost: null,
    excludedFundingCredit: null,
    blockers: [...new Set(blockers)],
    unknownIsZero: false,
    unavailableCostConvertedToZero: false,
    publicOnly: true,
    executionAuthority: "NONE",
    liveTrading: false,
    privateTradingApiAllowed: false,
  });
}
function sortedUniqueCandles(rows) {
  const map = new Map();
  for (const raw of rows) {
    const candle = normalizeBitgetCandle(raw);
    const prior = map.get(candle.timestamp);
    if (prior && JSON.stringify(prior) !== JSON.stringify(candle)) {
      throw new Error("FUNDING_MARK_CANDLE_CONFLICT");
    }
    map.set(candle.timestamp, candle);
  }
  return [...map.values()].sort((a, b) => a.timestamp - b.timestamp);
}
function fundingSidePays(direction, rate) {
  if (rate === 0) return false;
  if (direction === "LONG") return rate > 0;
  if (direction === "SHORT") return rate < 0;
  throw new Error("FUNDING_DIRECTION_INVALID");
}

export async function collectBitgetFundingCostOnlyHistory({
  client,
  symbol,
  direction,
  quantity,
  startTime,
  endTime,
  productType = "usdt-futures",
  collectFundingHistory = collectFundingRateHistory,
  now = Date.now,
} = {}) {
  if (!client || typeof client.get !== "function") throw new TypeError("client.get is required");
  const normalizedSymbol = canonicalSymbol(symbol);
  if (!normalizedSymbol) return blocked(["FUNDING_SYMBOL_REQUIRED"]);
  if (!["LONG", "SHORT"].includes(direction)) return blocked(["FUNDING_DIRECTION_REQUIRED"]);
  if (!positive(quantity)) return blocked(["FUNDING_QUANTITY_REQUIRED"]);
  if (!safeTime(startTime) || !safeTime(endTime) || endTime <= startTime) {
    return blocked(["FUNDING_HOLDING_PERIOD_INVALID"]);
  }
  if (typeof collectFundingHistory !== "function" || typeof now !== "function") {
    throw new TypeError("funding history dependencies are required");
  }

  const funding = await collectFundingHistory({
    client,
    symbol: normalizedSymbol,
    startTime,
    endTime,
    productType,
    maxPages: 200,
    now,
  });
  if (funding?.exhausted !== true || !Array.isArray(funding?.records)) {
    return blocked(["FUNDING_HISTORY_INCOMPLETE"]);
  }

  const records = funding.records
    .filter((row) => safeTime(row?.timestamp) && finite(row?.rate))
    .sort((a, b) => a.timestamp - b.timestamp);
  if (records.length !== funding.records.length) {
    return blocked(["FUNDING_HISTORY_RECORD_INVALID"]);
  }
  for (let index = 1; index < records.length; index += 1) {
    if (records[index].timestamp <= records[index - 1].timestamp) {
      return blocked(["FUNDING_HISTORY_ORDER_INVALID"]);
    }
  }

  if (records.length === 0) {
    const collectedAtMs = now();
    if (!safeTime(collectedAtMs) || collectedAtMs < endTime) {
      return blocked(["FUNDING_COLLECTION_TIME_INVALID"]);
    }
    return deepFreeze({
      schemaVersion: BITGET_FUNDING_COST_OWNER_VERSION,
      status: "PRESENT",
      complete: true,
      fullCoverage: true,
      symbol: normalizedSymbol,
      direction,
      quantity,
      startTime,
      endTime,
      collectedAtMs,
      fundingEventCount: 0,
      markCandleCount: 0,
      payments: [],
      totalFundingCost: 0,
      excludedFundingCredit: 0,
      costOnlyPolicy: "PAYMENTS_COUNT_AS_COST; RECEIPTS_EXCLUDED_FROM_PROFIT",
      markPricePolicy: "EXACT_FUNDING_MINUTE_MARK_CANDLE_OPEN",
      blockers: [],
      unknownIsZero: false,
      unavailableCostConvertedToZero: false,
      publicOnly: true,
      executionAuthority: "NONE",
      liveTrading: false,
      privateTradingApiAllowed: false,
    });
  }

  const targetTimes = new Set(records.map((row) => row.timestamp));
  for (const timestamp of targetTimes) {
    if (timestamp % MINUTE_MS !== 0) {
      return blocked(["FUNDING_TIME_NOT_MINUTE_ALIGNED"]);
    }
  }

  const exactMarkCandles = new Map();
  let cursorEnd = Math.max(...targetTimes) + MINUTE_MS;
  let previousOldest = Number.POSITIVE_INFINITY;

  for (let page = 0; page < MAX_MARK_PAGES && exactMarkCandles.size < targetTimes.size; page += 1) {
    const payload = await client.get(BITGET_ENDPOINTS.futuresHistoryMarkCandles, {
      symbol: normalizedSymbol,
      productType,
      granularity: "1m",
      endTime: cursorEnd,
      limit: PAGE_LIMIT,
    });
    if (String(payload?.code ?? "") !== "00000" || !Array.isArray(payload?.data)) {
      return blocked(["FUNDING_MARK_HISTORY_INVALID"]);
    }
    if (payload.data.length === 0) break;

    const candles = sortedUniqueCandles(payload.data);
    const oldest = candles[0]?.timestamp;
    if (!safeTime(oldest)) return blocked(["FUNDING_MARK_HISTORY_TIMESTAMP_INVALID"]);
    if (oldest >= previousOldest) return blocked(["FUNDING_MARK_HISTORY_PAGINATION_STALLED"]);
    previousOldest = oldest;

    for (const candle of candles) {
      if (targetTimes.has(candle.timestamp)) exactMarkCandles.set(candle.timestamp, candle);
    }
    if (oldest <= Math.min(...targetTimes)) break;
    cursorEnd = oldest;
    if (payload.data.length < PAGE_LIMIT) break;
  }

  const missing = [...targetTimes].filter((timestamp) => !exactMarkCandles.has(timestamp));
  if (missing.length > 0) {
    return blocked(["FUNDING_MARK_PRICE_EVIDENCE_MISSING"]);
  }

  let totalFundingCost = 0;
  let excludedFundingCredit = 0;
  const payments = records.map((row) => {
    const candle = exactMarkCandles.get(row.timestamp);
    const markPrice = candle?.open;
    if (!positive(markPrice)) throw new Error("FUNDING_MARK_PRICE_INVALID");
    const positionValue = quantity * markPrice;
    const pays = fundingSidePays(direction, row.rate);
    const magnitude = positionValue * Math.abs(row.rate);
    const amount = pays ? magnitude : 0;
    const excludedCredit = pays ? 0 : magnitude;
    totalFundingCost += amount;
    excludedFundingCredit += excludedCredit;
    return Object.freeze({
      asOfMs: row.timestamp,
      amount,
      source: "BITGET_PUBLIC_FUNDING_RATE_X_EXACT_1M_MARK_OPEN",
      provenance: `bitget-public-v2:history-fund-rate+history-mark-candles:1m:${normalizedSymbol}`,
      version: BITGET_FUNDING_COST_OWNER_VERSION,
      fundingRate: row.rate,
      fundingRateRaw: row.rateRaw,
      markPrice,
      positionValue,
      payer: pays,
      receiptCreditExcluded: excludedCredit,
    });
  });

  const collectedAtMs = now();
  if (!safeTime(collectedAtMs) || collectedAtMs < endTime) {
    return blocked(["FUNDING_COLLECTION_TIME_INVALID"]);
  }

  return deepFreeze({
    schemaVersion: BITGET_FUNDING_COST_OWNER_VERSION,
    status: "PRESENT",
    complete: true,
    fullCoverage: true,
    symbol: normalizedSymbol,
    direction,
    quantity,
    startTime,
    endTime,
    collectedAtMs,
    fundingEventCount: records.length,
    markCandleCount: exactMarkCandles.size,
    payments,
    totalFundingCost,
    excludedFundingCredit,
    costOnlyPolicy: "PAYMENTS_COUNT_AS_COST; RECEIPTS_EXCLUDED_FROM_PROFIT",
    markPricePolicy: "EXACT_FUNDING_MINUTE_MARK_CANDLE_OPEN",
    blockers: [],
    unknownIsZero: false,
    unavailableCostConvertedToZero: false,
    publicOnly: true,
    executionAuthority: "NONE",
    liveTrading: false,
    privateTradingApiAllowed: false,
  });
}
