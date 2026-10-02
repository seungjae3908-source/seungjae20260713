import { PredictionInputError } from "./contracts.js";

export const QUALITY_DAYTRADE_VOLATILITY_VERSION = "us-quality-daytrade-volatility-v1";

const DEFAULT_VOLATILITY_POLICY = Object.freeze({
  atrLookback: 14,
  minCandles: 8,
});

function freeze(value) {
  return Object.freeze(value);
}

function safeResult(fields) {
  return freeze({
    contractVersion: QUALITY_DAYTRADE_VOLATILITY_VERSION,
    executionAuthority: "NONE",
    liveTradingAllowed: false,
    privateApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    ...fields,
  });
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveNumber(value) {
  const number = finiteNumber(value);
  return number != null && number > 0 ? number : null;
}

function normalizePolicy(raw = {}) {
  const atrLookback = Number(raw.atrLookback ?? DEFAULT_VOLATILITY_POLICY.atrLookback);
  const minCandles = Number(raw.minCandles ?? DEFAULT_VOLATILITY_POLICY.minCandles);
  if (!Number.isInteger(atrLookback) || atrLookback < 2 || atrLookback > 50) {
    throw new PredictionInputError("invalid volatilityPolicy.atrLookback");
  }
  if (!Number.isInteger(minCandles) || minCandles < 2 || minCandles > 50) {
    throw new PredictionInputError("invalid volatilityPolicy.minCandles");
  }
  return freeze({ atrLookback, minCandles });
}

function normalizeCandles(raw, minCandles) {
  if (!Array.isArray(raw) || raw.length < minCandles) {
    return { blocker: "VOLATILITY_CANDLES_INSUFFICIENT" };
  }

  const candles = [];
  let previousTimestamp = -Infinity;
  let session = null;
  for (const [index, row] of raw.entries()) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      return { blocker: `VOLATILITY_CANDLE_INVALID:${index}` };
    }
    const open = positiveNumber(row.open);
    const high = positiveNumber(row.high);
    const low = positiveNumber(row.low);
    const close = positiveNumber(row.close);
    const timestamp = positiveNumber(row.timestamp);
    const rowSession = String(row.session ?? "").toUpperCase();
    if (open == null || high == null || low == null || close == null || timestamp == null) {
      return { blocker: `VOLATILITY_CANDLE_FIELDS_INVALID:${index}` };
    }
    if (low > Math.min(open, close) || high < Math.max(open, close) || high < low) {
      return { blocker: `VOLATILITY_CANDLE_OHLC_INVALID:${index}` };
    }
    if (!(timestamp > previousTimestamp)) return { blocker: "VOLATILITY_CANDLE_TIMESTAMPS_NOT_INCREASING" };
    if (!rowSession) return { blocker: "VOLATILITY_SESSION_REQUIRED" };
    if (session == null) session = rowSession;
    else if (rowSession !== session) return { blocker: "VOLATILITY_SESSION_MISMATCH" };
    previousTimestamp = timestamp;
    candles.push(freeze({ open, high, low, close, timestamp, session: rowSession }));
  }
  return { value: freeze(candles), session };
}

function trueRanges(candles) {
  return candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low;
    const previousClose = candles[index - 1].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
  });
}

function computeRealizedVolatilityPct(candles) {
  let squaredLogReturnSum = 0;
  for (let index = 1; index < candles.length; index += 1) {
    const logReturn = Math.log(candles[index].close / candles[index - 1].close);
    squaredLogReturnSum += logReturn * logReturn;
  }
  return Math.sqrt(squaredLogReturnSum) * 100;
}

export function evaluateUsQualityDaytradeVolatility(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PredictionInputError("quality day-trade volatility input must be an object");
  }

  const asOfMs = positiveNumber(raw.asOfMs);
  if (asOfMs == null) return safeResult({ status: "BLOCKED_DATA", reason: "VOLATILITY_ASOF_REQUIRED" });
  const policy = normalizePolicy(raw.volatilityPolicy);
  const normalized = normalizeCandles(raw.candles, policy.minCandles);
  if (normalized.blocker) return safeResult({ status: "BLOCKED_DATA", reason: normalized.blocker });

  const candleEvidence = raw.candleEvidence;
  if (!candleEvidence || typeof candleEvidence !== "object" || Array.isArray(candleEvidence)) {
    return safeResult({ status: "BLOCKED_DATA", reason: "VOLATILITY_CANDLE_EVIDENCE_REQUIRED" });
  }
  if (candleEvidence.sessionCoverageComplete !== true) {
    return safeResult({ status: "BLOCKED_DATA", reason: "VOLATILITY_SESSION_COVERAGE_UNPROVEN" });
  }
  const lastCompleteCandleTimestampMs = positiveNumber(candleEvidence.lastCompleteCandleTimestampMs);
  if (lastCompleteCandleTimestampMs == null) {
    return safeResult({ status: "BLOCKED_DATA", reason: "VOLATILITY_LAST_COMPLETE_CANDLE_REQUIRED" });
  }
  if (lastCompleteCandleTimestampMs > asOfMs) {
    return safeResult({ status: "BLOCKED_DATA", reason: "VOLATILITY_EVIDENCE_FROM_FUTURE" });
  }
  if (normalized.value.at(-1).timestamp !== lastCompleteCandleTimestampMs) {
    return safeResult({ status: "BLOCKED_DATA", reason: "VOLATILITY_LAST_COMPLETE_CANDLE_MISMATCH" });
  }

  const ranges = trueRanges(normalized.value);
  const atrLookbackUsed = Math.min(policy.atrLookback, ranges.length);
  const atrWindow = ranges.slice(-atrLookbackUsed);
  const atrUsd = atrWindow.reduce((sum, value) => sum + value, 0) / atrWindow.length;
  const lastClose = normalized.value.at(-1).close;
  const atrPct = (atrUsd / lastClose) * 100;
  const realizedVolatilityPct = computeRealizedVolatilityPct(normalized.value);
  const sessionHigh = Math.max(...normalized.value.map((candle) => candle.high));
  const sessionLow = Math.min(...normalized.value.map((candle) => candle.low));
  const sessionRangePct = ((sessionHigh - sessionLow) / normalized.value[0].open) * 100;

  if (![atrUsd, atrPct, realizedVolatilityPct, sessionRangePct].every(Number.isFinite)) {
    return safeResult({ status: "BLOCKED_DATA", reason: "VOLATILITY_METRIC_UNCOMPUTABLE" });
  }

  return safeResult({
    status: "PASS",
    reason: "POINT_IN_TIME_INTRADAY_VOLATILITY_COMPUTED",
    session: normalized.session,
    asOfMs,
    lastCompleteCandleTimestampMs,
    candleCount: normalized.value.length,
    atrLookbackRequested: policy.atrLookback,
    atrLookbackUsed,
    atrUsd,
    atrPct,
    realizedVolatilityPct,
    sessionRangePct,
    atrMethod: "SIMPLE_TRUE_RANGE_WINDOW",
    realizedVolatilityMethod: "SQRT_SUM_LOG_RETURN_SQUARES_NOT_ANNUALIZED",
    lookaheadFree: true,
    pointInTime: true,
  });
}
