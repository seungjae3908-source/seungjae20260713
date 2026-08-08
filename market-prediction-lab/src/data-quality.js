import { createHash } from "node:crypto";
import { PredictionInputError } from "./contracts.js";
import { timeframeToMs } from "./timeframes.js";

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function stableStringify(value) {
  const normalize = (item, stack = new Set()) => {
    if (item === null || typeof item !== "object") return item;
    if (stack.has(item)) throw new TypeError("cannot stringify circular data");
    const nextStack = new Set(stack);
    nextStack.add(item);
    if (Array.isArray(item)) return item.map((entry) => normalize(entry, nextStack));
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, normalize(item[key], nextStack)]));
  };
  return JSON.stringify(normalize(value));
}

export function inspectCandleQuality(candles, { market, timeframe }) {
  if (!Array.isArray(candles)) throw new TypeError("candles must be an array");
  const interval = timeframeToMs(timeframe);
  const issues = [];
  let duplicates = 0;
  let outOfOrder = 0;
  let gaps = 0;
  let zeroVolume = 0;
  let maximumGapMs = 0;

  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    if (candle.volume === 0) zeroVolume += 1;
    if (index === 0) continue;
    const delta = candle.timestamp - candles[index - 1].timestamp;
    if (delta === 0) duplicates += 1;
    if (delta < 0) outOfOrder += 1;
    maximumGapMs = Math.max(maximumGapMs, delta);
    const dailyStockTolerance = timeframe === "1d" && (market === "KR_STOCK" || market === "US_STOCK")
      ? interval * 4.5
      : interval * 1.5;
    if (delta > dailyStockTolerance) gaps += 1;
  }

  if (duplicates > 0) issues.push({ code: "duplicate_timestamp", count: duplicates, severity: "error" });
  if (outOfOrder > 0) issues.push({ code: "out_of_order", count: outOfOrder, severity: "error" });
  if (gaps > 0) issues.push({ code: "time_gap", count: gaps, severity: "warning" });
  if (zeroVolume > 0) issues.push({ code: "zero_volume", count: zeroVolume, severity: "info" });

  return Object.freeze({
    candleCount: candles.length,
    duplicates,
    outOfOrder,
    gaps,
    zeroVolume,
    maximumGapMs,
    status: issues.some((issue) => issue.severity === "error") ? "invalid" : issues.length > 0 ? "warning" : "clean",
    issues: Object.freeze(issues.map(Object.freeze)),
  });
}

export function assertMonotonicCandles(candles) {
  for (let index = 1; index < candles.length; index += 1) {
    if (candles[index].timestamp <= candles[index - 1].timestamp) {
      throw new PredictionInputError("normalized candles must have unique ascending timestamps", { index });
    }
  }
  return candles;
}
