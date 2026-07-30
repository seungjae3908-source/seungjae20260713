import { BITGET_TIMEFRAME_MS, normalizeBitgetCandle } from "./bitget-candle-collector.js";
import { normalizeFundingRateRecord } from "./derivatives-history.js";

const GRANULARITY = Object.freeze({ "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D" });
const ENDPOINTS = Object.freeze({
  mark: "/api/v2/mix/market/history-mark-candles",
  index: "/api/v2/mix/market/history-index-candles",
});

function assertSymbol(symbol) {
  if (typeof symbol !== "string" || !/^[A-Z0-9]{3,30}$/.test(symbol)) throw new TypeError("invalid symbol");
}

function alignDown(timestamp, intervalMs) {
  return Math.floor(timestamp / intervalMs) * intervalMs;
}

function uniqueSorted(candles) {
  const byTimestamp = new Map();
  for (const candle of candles) {
    const existing = byTimestamp.get(candle.timestamp);
    if (existing && ["open", "high", "low", "close"].some((key) => existing[key] !== candle[key])) {
      throw new Error(`conflicting derived candle at ${candle.timestamp}`);
    }
    byTimestamp.set(candle.timestamp, candle);
  }
  return [...byTimestamp.values()].sort((left, right) => left.timestamp - right.timestamp);
}

export async function collectBitgetDerivedCandles({
  client,
  kind,
  symbol,
  timeframe,
  startTime,
  endTime = Date.now(),
  productType = "usdt-futures",
  maxCandles = 50000,
  onPage,
}) {
  if (!client || typeof client.get !== "function") throw new TypeError("client.get is required");
  if (!Object.hasOwn(ENDPOINTS, kind)) throw new TypeError("kind must be mark or index");
  assertSymbol(symbol);
  const intervalMs = BITGET_TIMEFRAME_MS[timeframe];
  if (!intervalMs || !GRANULARITY[timeframe]) throw new TypeError("unsupported timeframe");
  if (!Number.isInteger(startTime) || startTime <= 0) throw new TypeError("startTime must be positive");
  if (!Number.isInteger(endTime) || endTime <= startTime) throw new TypeError("endTime must be greater than startTime");
  if (!Number.isInteger(maxCandles) || maxCandles < 60 || maxCandles > 500000) throw new TypeError("maxCandles is invalid");

  const all = [];
  let cursorEnd = alignDown(endTime, intervalMs);
  let previousOldest = Number.POSITIVE_INFINITY;
  let page = 0;
  const pageLimit = 200;

  while (cursorEnd > startTime && all.length < maxCandles) {
    const payload = await client.get(ENDPOINTS[kind], {
      symbol,
      productType,
      granularity: GRANULARITY[timeframe],
      endTime: cursorEnd,
      limit: pageLimit,
    });
    if (!Array.isArray(payload.data)) throw new TypeError(`Bitget ${kind} candle data must be an array`);
    if (payload.data.length === 0) break;
    const normalized = uniqueSorted(payload.data.map(normalizeBitgetCandle));
    const oldest = normalized[0]?.timestamp;
    if (!Number.isFinite(oldest)) throw new TypeError(`${kind} candle page has no valid timestamp`);
    if (oldest >= previousOldest) throw new Error(`${kind} candle pagination did not move backward`);
    const batch = normalized.filter((candle) => candle.timestamp >= startTime && candle.timestamp < cursorEnd);
    all.push(...batch);
    page += 1;
    await onPage?.(Object.freeze({ kind, page, received: batch.length, oldest, newest: batch.at(-1)?.timestamp ?? null }));
    previousOldest = oldest;
    cursorEnd = oldest;
    if (payload.data.length < pageLimit) break;
  }

  const candles = uniqueSorted(all)
    .filter((candle) => candle.timestamp >= startTime && candle.timestamp < alignDown(endTime, intervalMs))
    .slice(-maxCandles);
  if (candles.length < 60) throw new Error(`not enough ${kind} candles collected: ${candles.length}`);
  return Object.freeze({
    schemaVersion: 1,
    provider: "bitget-public-v2",
    kind,
    symbol,
    timeframe,
    productType,
    collectedAt: Date.now(),
    candles: Object.freeze(candles),
  });
}

function fundingAtOrBefore(records, timestamp) {
  let low = 0;
  let high = records.length - 1;
  let answer = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (records[middle].timestamp <= timestamp) {
      answer = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return answer;
}

function zScore(values) {
  if (values.length < 5) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const scale = Math.sqrt(variance);
  return scale > 1e-12 ? (values.at(-1) - mean) / scale : 0;
}

export function createTemporalMarketStructureProvider({
  fundingHistory = [],
  markCandles = [],
  indexCandles = [],
  fundingMaxAgeMs = 12 * 60 * 60 * 1000,
} = {}) {
  const funding = fundingHistory.map(normalizeFundingRateRecord).sort((left, right) => left.timestamp - right.timestamp);
  const mark = new Map(uniqueSorted(markCandles.map((candle, index) => normalizeBitgetCandle([
    candle.timestamp, candle.open, candle.high, candle.low, candle.close, candle.volume ?? 0, candle.quoteVolume ?? 0,
  ], index))).map((candle) => [candle.timestamp, candle]));
  const index = new Map(uniqueSorted(indexCandles.map((candle, rowIndex) => normalizeBitgetCandle([
    candle.timestamp, candle.open, candle.high, candle.low, candle.close, candle.volume ?? 0, candle.quoteVolume ?? 0,
  ], rowIndex))).map((candle) => [candle.timestamp, candle]));

  return ({ anchorTimestamp, history }) => {
    if (!Number.isInteger(anchorTimestamp) || anchorTimestamp <= 0) throw new TypeError("anchorTimestamp must be positive");
    if (!Array.isArray(history) || history.at(-1)?.timestamp !== anchorTimestamp) throw new TypeError("history must end at anchorTimestamp");
    const derivativesFeatures = {};
    const availability = {
      fundingKnown: false,
      fundingTimestamp: null,
      markKnown: false,
      indexKnown: false,
      structureTimestamp: null,
    };

    const fundingIndex = fundingAtOrBefore(funding, anchorTimestamp);
    if (fundingIndex >= 0) {
      const current = funding[fundingIndex];
      if (anchorTimestamp - current.timestamp <= fundingMaxAgeMs) {
        derivativesFeatures.fundingRate = current.rate;
        derivativesFeatures.fundingRateChange = fundingIndex >= 1 ? current.rate - funding[fundingIndex - 1].rate : 0;
        derivativesFeatures.fundingRateZScore = zScore(funding.slice(Math.max(0, fundingIndex - 19), fundingIndex + 1).map((row) => row.rate));
        availability.fundingKnown = true;
        availability.fundingTimestamp = current.timestamp;
      }
    }

    const marketClose = history.at(-1).close;
    const markRow = mark.get(anchorTimestamp);
    const indexRow = index.get(anchorTimestamp);
    if (markRow) availability.markKnown = true;
    if (indexRow) availability.indexKnown = true;
    if (markRow && indexRow && markRow.close > 0 && indexRow.close > 0 && marketClose > 0) {
      derivativesFeatures.markPremium = (markRow.close / indexRow.close) - 1;
      derivativesFeatures.marketMarkSpread = (marketClose / markRow.close) - 1;
      derivativesFeatures.basisRate = (marketClose / indexRow.close) - 1;
      availability.structureTimestamp = anchorTimestamp;
    }

    return Object.freeze({
      derivativesFeatures: Object.freeze(derivativesFeatures),
      featureAvailability: Object.freeze(availability),
    });
  };
}

export function summarizeStructureCoverage(records) {
  const total = records.length;
  const funding = records.filter((record) => record.featureAvailability?.fundingKnown).length;
  const structure = records.filter((record) => record.featureAvailability?.structureTimestamp).length;
  return Object.freeze({
    total,
    funding,
    structure,
    fundingCoverage: total === 0 ? 0 : funding / total,
    structureCoverage: total === 0 ? 0 : structure / total,
  });
}
