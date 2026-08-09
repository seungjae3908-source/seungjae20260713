import { inspectCandleQuality } from "./data-quality.js";
import { timeframeToMs } from "./timeframes.js";

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

export function buildBitgetLiveQualityReport({ snapshot, context = null, requestedStartTime, requestedEndTime }) {
  if (!snapshot || !Array.isArray(snapshot.candles) || snapshot.candles.length < 60) {
    throw new TypeError("snapshot with at least 60 candles is required");
  }
  const { market, symbol, timeframe, candles } = snapshot;
  const intervalMs = timeframeToMs(timeframe);
  const quality = inspectCandleQuality(candles, { market, timeframe });
  const firstTimestamp = candles[0].timestamp;
  const lastTimestamp = candles.at(-1).timestamp;
  const expectedSlots = Math.max(1, Math.floor((requestedEndTime - requestedStartTime) / intervalMs));
  const coverageRatio = Math.min(1, candles.length / expectedSlots);
  const latestLagMs = Math.max(0, requestedEndTime - lastTimestamp);
  const contextHealth = market !== "CRYPTO_FUTURES"
    ? { status: "not_applicable", missing: [] }
    : (() => {
        const missing = [];
        if (!Number.isFinite(context?.openInterest)) missing.push("open_interest");
        if (!Number.isFinite(context?.fundingRate)) missing.push("funding_rate");
        if (!Number.isFinite(context?.markPrice)) missing.push("mark_price");
        if (!Number.isFinite(context?.indexPrice)) missing.push("index_price");
        return { status: missing.length === 0 ? "complete" : "partial", missing };
      })();
  const blockers = [];
  if (quality.status === "invalid") blockers.push("invalid_candle_order_or_duplicates");
  if (coverageRatio < 0.9) blockers.push("insufficient_time_coverage");
  if (latestLagMs > intervalMs * 3) blockers.push("latest_candle_too_old");
  if (market === "CRYPTO_FUTURES" && contextHealth.status !== "complete") {
    blockers.push("futures_context_incomplete");
  }
  return Object.freeze({
    schemaVersion: 1,
    generatedAt: Date.now(),
    provider: snapshot.provider,
    market,
    symbol,
    timeframe,
    requestedStartTime,
    requestedEndTime,
    firstTimestamp,
    lastTimestamp,
    expectedSlots,
    candleCount: candles.length,
    coverageRatio: Math.round(coverageRatio * 1e6) / 1e6,
    latestLagMs,
    quality,
    contextHealth,
    contextSnapshot: context ? {
      openInterest: finiteOrNull(context.openInterest),
      fundingRate: finiteOrNull(context.fundingRate),
      fundingIntervalHours: finiteOrNull(context.fundingIntervalHours),
      marketPrice: finiteOrNull(context.marketPrice),
      markPrice: finiteOrNull(context.markPrice),
      indexPrice: finiteOrNull(context.indexPrice),
      fundingHistoryCount: Array.isArray(context.fundingHistory) ? context.fundingHistory.length : 0,
    } : null,
    status: blockers.length === 0 ? (quality.status === "clean" ? "pass" : "pass_with_warnings") : "fail",
    blockers: Object.freeze(blockers),
  });
}

export async function runBitgetLiveVerification({
  client,
  collectCandles,
  collectContext,
  market = "CRYPTO_FUTURES",
  symbol = "BTCUSDT",
  timeframe = "15m",
  days = 7,
  now = Date.now(),
}) {
  if (!Number.isFinite(days) || days <= 0 || days > 31) {
    throw new TypeError("days must be greater than 0 and at most 31");
  }
  if (typeof collectCandles !== "function") throw new TypeError("collectCandles must be a function");
  if (market === "CRYPTO_FUTURES" && typeof collectContext !== "function") {
    throw new TypeError("collectContext must be a function for futures verification");
  }
  const requestedEndTime = Math.floor(now);
  const requestedStartTime = requestedEndTime - Math.floor(days * 24 * 60 * 60 * 1000);
  const snapshot = await collectCandles({
    client, market, symbol, timeframe, startTime: requestedStartTime, endTime: requestedEndTime,
  });
  const context = market === "CRYPTO_FUTURES" ? await collectContext({ client, symbol }) : null;
  const report = buildBitgetLiveQualityReport({ snapshot, context, requestedStartTime, requestedEndTime });
  return Object.freeze({ snapshot, context, report });
}
