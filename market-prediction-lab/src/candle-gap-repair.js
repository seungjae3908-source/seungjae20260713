import { BITGET_ENDPOINTS } from "./bitget-public-client.js";
import { BITGET_TIMEFRAME_MS, normalizeBitgetCandle } from "./bitget-candle-collector.js";

const FUTURES_GRANULARITY = Object.freeze({ "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D" });
const SPOT_GRANULARITY = Object.freeze({ "15m": "15min", "1h": "1h", "4h": "4h", "1d": "1day" });

function validateCandle(candle, index) {
  if (!candle || typeof candle !== "object" || Array.isArray(candle)) {
    throw new TypeError(`candles[${index}] must be an object`);
  }
  for (const key of ["timestamp", "open", "high", "low", "close", "volume"]) {
    if (typeof candle[key] !== "number" || !Number.isFinite(candle[key])) {
      throw new TypeError(`candles[${index}].${key} must be finite`);
    }
  }
  if (!Number.isInteger(candle.timestamp) || candle.timestamp <= 0) {
    throw new TypeError(`candles[${index}].timestamp is invalid`);
  }
  if ([candle.open, candle.high, candle.low, candle.close].some((value) => value <= 0)
      || candle.volume < 0 || candle.high < Math.max(candle.open, candle.close)
      || candle.low > Math.min(candle.open, candle.close) || candle.high < candle.low) {
    throw new TypeError(`candles[${index}] has invalid OHLCV relationships`);
  }
  return candle;
}

function validateOrderedCandles(candles) {
  if (!Array.isArray(candles)) throw new TypeError("candles must be an array");
  const validated = candles.map(validateCandle);
  for (let index = 1; index < validated.length; index += 1) {
    if (validated[index].timestamp <= validated[index - 1].timestamp) {
      throw new Error(`candles must have unique ascending timestamps at index ${index}`);
    }
  }
  return validated;
}

function materiallyEqual(left, right) {
  return ["open", "high", "low", "close", "volume", "quoteVolume"]
    .every((key) => left[key] === right[key] || (left[key] === undefined && right[key] === undefined));
}

function sortAndDeduplicateResponse(candles) {
  const byTimestamp = new Map();
  for (const candle of candles) {
    const existing = byTimestamp.get(candle.timestamp);
    if (existing && !materiallyEqual(existing, candle)) {
      throw new Error(`Bitget returned conflicting candles at ${candle.timestamp}`);
    }
    byTimestamp.set(candle.timestamp, candle);
  }
  return [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function requestSpec(market, timeframe, productType) {
  const intervalMs = BITGET_TIMEFRAME_MS[timeframe];
  if (!intervalMs) throw new TypeError(`unsupported timeframe: ${timeframe}`);
  if (market === "CRYPTO_FUTURES") {
    return Object.freeze({
      endpoint: BITGET_ENDPOINTS.futuresHistoryCandles,
      granularity: FUTURES_GRANULARITY[timeframe],
      intervalMs,
      productType,
    });
  }
  if (market === "CRYPTO_SPOT") {
    return Object.freeze({
      endpoint: BITGET_ENDPOINTS.spotHistoryCandles,
      granularity: SPOT_GRANULARITY[timeframe],
      intervalMs,
      productType: undefined,
    });
  }
  throw new TypeError("market must be CRYPTO_SPOT or CRYPTO_FUTURES");
}

export function findCandleGaps(candles, intervalMs) {
  if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
    throw new TypeError("intervalMs must be a positive integer");
  }
  const ordered = validateOrderedCandles(candles);
  const gaps = [];
  let missingCandleCount = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    const previousTimestamp = ordered[index - 1].timestamp;
    const nextTimestamp = ordered[index].timestamp;
    const delta = nextTimestamp - previousTimestamp;
    if (delta === intervalMs) continue;
    if (delta % intervalMs !== 0) {
      throw new Error(`candle timestamps are not aligned to timeframe at index ${index}`);
    }
    const missingCount = (delta / intervalMs) - 1;
    if (missingCount <= 0) continue;
    gaps.push(Object.freeze({
      previousTimestamp,
      nextTimestamp,
      firstMissingTimestamp: previousTimestamp + intervalMs,
      lastMissingTimestamp: nextTimestamp - intervalMs,
      missingCount,
    }));
    missingCandleCount += missingCount;
  }
  return Object.freeze({
    gapCount: gaps.length,
    missingCandleCount,
    gaps: Object.freeze(gaps),
  });
}

function mergeRecoveredCandles(base, recovered) {
  const merged = new Map(validateOrderedCandles(base).map((candle) => [candle.timestamp, candle]));
  for (const candle of sortAndDeduplicateResponse(recovered)) {
    const existing = merged.get(candle.timestamp);
    if (existing && !materiallyEqual(existing, candle)) {
      const error = new Error(`recovered candle conflicts with existing candle at ${candle.timestamp}`);
      error.details = { timestamp: candle.timestamp, existing, recovered: candle };
      throw error;
    }
    if (!existing) merged.set(candle.timestamp, candle);
  }
  return [...merged.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function chunkGap(gap, intervalMs, maxMissingPerRequest = 196) {
  const chunks = [];
  let first = gap.firstMissingTimestamp;
  while (first <= gap.lastMissingTimestamp) {
    const remaining = Math.floor((gap.lastMissingTimestamp - first) / intervalMs) + 1;
    const count = Math.min(remaining, maxMissingPerRequest);
    const last = first + ((count - 1) * intervalMs);
    chunks.push(Object.freeze({
      firstMissingTimestamp: first,
      lastMissingTimestamp: last,
      missingCount: count,
    }));
    first = last + intervalMs;
  }
  return chunks;
}

export async function repairBitgetCandleGaps({
  client,
  market,
  symbol,
  timeframe,
  candles,
  productType = "usdt-futures",
  maxPasses = 2,
  onAttempt,
}) {
  if (!client || typeof client.get !== "function") throw new TypeError("client.get is required");
  if (typeof symbol !== "string" || !/^[A-Z0-9]{3,30}$/.test(symbol)) throw new TypeError("invalid symbol");
  if (!Number.isInteger(maxPasses) || maxPasses < 1 || maxPasses > 5) {
    throw new TypeError("maxPasses must be between 1 and 5");
  }

  const spec = requestSpec(market, timeframe, productType);
  const original = validateOrderedCandles(candles);
  const initial = findCandleGaps(original, spec.intervalMs);
  let current = original;
  let currentReport = initial;
  const attempts = [];

  for (let pass = 1; pass <= maxPasses && currentReport.gapCount > 0; pass += 1) {
    const recovered = [];
    for (const gap of currentReport.gaps) {
      for (const chunk of chunkGap(gap, spec.intervalMs)) {
        const params = {
          symbol,
          granularity: spec.granularity,
          startTime: chunk.firstMissingTimestamp - spec.intervalMs,
          endTime: chunk.lastMissingTimestamp + (2 * spec.intervalMs),
          limit: Math.min(200, chunk.missingCount + 4),
          ...(spec.productType ? { productType: spec.productType } : {}),
        };
        const payload = await client.get(spec.endpoint, params);
        if (!Array.isArray(payload.data)) {
          throw new TypeError("Bitget gap repair response data must be an array");
        }
        const responseCandles = sortAndDeduplicateResponse(payload.data.map(normalizeBitgetCandle));
        const mergeCandidates = responseCandles.filter((candle) =>
          candle.timestamp >= chunk.firstMissingTimestamp - spec.intervalMs
          && candle.timestamp <= chunk.lastMissingTimestamp + spec.intervalMs);
        const missingCandidates = responseCandles.filter((candle) =>
          candle.timestamp >= chunk.firstMissingTimestamp
          && candle.timestamp <= chunk.lastMissingTimestamp);
        recovered.push(...mergeCandidates);
        const attempt = Object.freeze({ pass, ...chunk, received: missingCandidates.length });
        attempts.push(attempt);
        await onAttempt?.(attempt);
      }
    }

    const beforeMissing = currentReport.missingCandleCount;
    current = mergeRecoveredCandles(current, recovered);
    currentReport = findCandleGaps(current, spec.intervalMs);
    if (currentReport.missingCandleCount >= beforeMissing) break;
  }

  return Object.freeze({
    candles: Object.freeze(current),
    initialGapCount: initial.gapCount,
    initialMissingCandleCount: initial.missingCandleCount,
    repairedCandleCount: current.length - original.length,
    remainingGapCount: currentReport.gapCount,
    remainingMissingCandleCount: currentReport.missingCandleCount,
    unresolvedGaps: currentReport.gaps,
    attempts: Object.freeze(attempts),
  });
}
