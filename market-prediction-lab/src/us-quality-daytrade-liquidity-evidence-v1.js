import { PredictionInputError } from "./contracts.js";

export const QUALITY_DAYTRADE_LIQUIDITY_EVIDENCE_VERSION = "us-quality-daytrade-liquidity-evidence-v1";

const VALID_SESSIONS = new Set(["PREMARKET", "REGULAR", "AFTER_HOURS"]);
const DEFAULT_POLICY = Object.freeze({
  maxCandleLagIntervals: 1.5,
  maxRvolAgeMs: 15_000,
});

function freeze(value) {
  return Object.freeze(value);
}

function safeResult(fields) {
  return freeze({
    contractVersion: QUALITY_DAYTRADE_LIQUIDITY_EVIDENCE_VERSION,
    executionAuthority: "NONE",
    liveTradingAllowed: false,
    privateApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    ...fields,
  });
}

function finiteNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new PredictionInputError(`${name} must be finite`);
  return number;
}

function positiveNumber(value, name) {
  const number = finiteNumber(value, name);
  if (!(number > 0)) throw new PredictionInputError(`${name} must be positive`);
  return number;
}

function nonNegativeNumber(value, name) {
  const number = finiteNumber(value, name);
  if (number < 0) throw new PredictionInputError(`${name} must be non-negative`);
  return number;
}

function sourceId(raw) {
  const value = String(raw?.sourceId ?? raw?.source ?? "").trim();
  return value || null;
}

function sourceSafetyBlock(raw, prefix) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return `${prefix}_EVIDENCE_REQUIRED`;
  if (!sourceId(raw)) return `${prefix}_SOURCE_REQUIRED`;
  if (raw.pointInTime !== true) return `${prefix}_POINT_IN_TIME_UNPROVEN`;
  if (raw.publicReadOnly !== true) return `${prefix}_PUBLIC_READ_ONLY_REQUIRED`;
  if (raw.privateApiUsed !== false) return `${prefix}_PRIVATE_API_STATE_INVALID`;
  return null;
}

function normalizeSession(value) {
  const session = String(value ?? "").toUpperCase();
  return VALID_SESSIONS.has(session) ? session : null;
}

function normalizePolicy(raw = {}) {
  const maxCandleLagIntervals = positiveNumber(
    raw.maxCandleLagIntervals ?? DEFAULT_POLICY.maxCandleLagIntervals,
    "liquidityPolicy.maxCandleLagIntervals",
  );
  const maxRvolAgeMs = positiveNumber(raw.maxRvolAgeMs ?? DEFAULT_POLICY.maxRvolAgeMs, "liquidityPolicy.maxRvolAgeMs");
  if (maxCandleLagIntervals > 5) throw new PredictionInputError("invalid liquidityPolicy.maxCandleLagIntervals");
  if (maxRvolAgeMs > 300_000) throw new PredictionInputError("invalid liquidityPolicy.maxRvolAgeMs");
  return freeze({ maxCandleLagIntervals, maxRvolAgeMs });
}

function validateCandles(raw, asOfMs, policy) {
  const safety = sourceSafetyBlock(raw, "LIQUIDITY_CANDLE");
  if (safety) return { blocker: safety };

  const session = normalizeSession(raw.session);
  if (!session) return { blocker: "LIQUIDITY_CANDLE_SESSION_REQUIRED" };

  const timeframeMs = positiveNumber(raw.timeframeMs, "candleEvidence.timeframeMs");
  const sessionStartTimestampMs = positiveNumber(raw.sessionStartTimestampMs, "candleEvidence.sessionStartTimestampMs");
  const coverageStartTimestampMs = positiveNumber(raw.coverageStartTimestampMs, "candleEvidence.coverageStartTimestampMs");
  const lastCompleteCandleTimestampMs = positiveNumber(
    raw.lastCompleteCandleTimestampMs,
    "candleEvidence.lastCompleteCandleTimestampMs",
  );

  if (raw.sessionCoverageComplete !== true) return { blocker: "LIQUIDITY_SESSION_COVERAGE_UNPROVEN" };
  if (lastCompleteCandleTimestampMs > asOfMs) return { blocker: "LIQUIDITY_CANDLE_EVIDENCE_FROM_FUTURE" };
  if (coverageStartTimestampMs > lastCompleteCandleTimestampMs) return { blocker: "LIQUIDITY_CANDLE_COVERAGE_RANGE_INVALID" };
  if (Math.abs(coverageStartTimestampMs - sessionStartTimestampMs) > timeframeMs) {
    return { blocker: "LIQUIDITY_SESSION_START_COVERAGE_INCOMPLETE" };
  }

  const maxCandleAgeMs = timeframeMs * policy.maxCandleLagIntervals;
  const candleAgeMs = asOfMs - lastCompleteCandleTimestampMs;
  if (candleAgeMs > maxCandleAgeMs) {
    return { blocker: "LIQUIDITY_CANDLES_STALE", candleAgeMs, maxCandleAgeMs };
  }

  if (!Array.isArray(raw.candles) || raw.candles.length < 8) return { blocker: "LIQUIDITY_CANDLES_INSUFFICIENT" };

  let previousTimestampMs = -Infinity;
  let sessionCumulativeShareVolume = 0;
  let candleDerivedSessionDollarVolumeUsd = 0;

  for (const [index, candle] of raw.candles.entries()) {
    if (!candle || typeof candle !== "object" || Array.isArray(candle)) {
      return { blocker: `LIQUIDITY_CANDLE_ROW_INVALID:${index}` };
    }
    const rowSession = normalizeSession(candle.session ?? session);
    if (rowSession !== session) return { blocker: "LIQUIDITY_CANDLE_SESSION_MISMATCH" };

    const timestampMs = positiveNumber(candle.timestamp, `candles[${index}].timestamp`);
    const open = positiveNumber(candle.open, `candles[${index}].open`);
    const high = positiveNumber(candle.high, `candles[${index}].high`);
    const low = positiveNumber(candle.low, `candles[${index}].low`);
    const close = positiveNumber(candle.close, `candles[${index}].close`);
    const volume = nonNegativeNumber(candle.volume, `candles[${index}].volume`);

    if (!(timestampMs > previousTimestampMs)) return { blocker: "LIQUIDITY_CANDLE_TIMESTAMPS_NOT_INCREASING" };
    previousTimestampMs = timestampMs;
    if (timestampMs > lastCompleteCandleTimestampMs) return { blocker: "LIQUIDITY_INCOMPLETE_CANDLE_INCLUDED" };
    if (low > Math.min(open, close) || high < Math.max(open, close) || high < low) {
      return { blocker: `LIQUIDITY_CANDLE_OHLC_INVALID:${index}` };
    }

    if (volume > 0) {
      const typicalPriceUsd = (high + low + close) / 3;
      sessionCumulativeShareVolume += volume;
      candleDerivedSessionDollarVolumeUsd += typicalPriceUsd * volume;
    }
  }

  if (previousTimestampMs !== lastCompleteCandleTimestampMs) return { blocker: "LIQUIDITY_LAST_COMPLETE_CANDLE_MISMATCH" };
  if (!(sessionCumulativeShareVolume > 0) || !(candleDerivedSessionDollarVolumeUsd > 0)) {
    return { blocker: "LIQUIDITY_SESSION_DOLLAR_VOLUME_UNAVAILABLE" };
  }

  return {
    value: freeze({
      sourceId: sourceId(raw),
      session,
      timeframeMs,
      sessionStartTimestampMs,
      coverageStartTimestampMs,
      lastCompleteCandleTimestampMs,
      candleAgeMs,
      maxCandleAgeMs,
      sessionCumulativeShareVolume,
      candleDerivedSessionDollarVolumeUsd,
      candleDerivedAveragePriceUsd: candleDerivedSessionDollarVolumeUsd / sessionCumulativeShareVolume,
      dollarVolumeBasis: "TYPICAL_PRICE_X_COMPLETED_CANDLE_VOLUME",
    }),
  };
}

function validateRelativeVolume(raw, asOfMs, session, completedShareVolume, lastCompleteCandleTimestampMs, policy) {
  const safety = sourceSafetyBlock(raw, "LIQUIDITY_RVOL");
  if (safety) return { blocker: safety };
  if (normalizeSession(raw.session) !== session) return { blocker: "LIQUIDITY_RVOL_SESSION_MISMATCH" };
  if (raw.sameSessionPhase !== true) return { blocker: "LIQUIDITY_RVOL_SAME_SESSION_PHASE_REQUIRED" };
  if (raw.lookaheadFree !== true) return { blocker: "LIQUIDITY_RVOL_LOOKAHEAD_FREE_REQUIRED" };

  const observedAtMs = positiveNumber(raw.observedAtMs, "relativeVolumeEvidence.observedAtMs");
  if (observedAtMs > asOfMs) return { blocker: "LIQUIDITY_RVOL_EVIDENCE_FROM_FUTURE" };
  if (observedAtMs < lastCompleteCandleTimestampMs) return { blocker: "LIQUIDITY_RVOL_BEHIND_COMPLETED_CANDLES" };
  const rvolAgeMs = asOfMs - observedAtMs;
  if (rvolAgeMs > policy.maxRvolAgeMs) return { blocker: "LIQUIDITY_RVOL_STALE", rvolAgeMs };

  const currentCumulativeVolume = positiveNumber(
    raw.currentCumulativeVolume,
    "relativeVolumeEvidence.currentCumulativeVolume",
  );
  if (currentCumulativeVolume < completedShareVolume) {
    return {
      blocker: "LIQUIDITY_RVOL_CUMULATIVE_VOLUME_BEHIND_CANDLES",
      currentCumulativeVolume,
      completedShareVolume,
    };
  }

  return {
    value: freeze({
      sourceId: sourceId(raw),
      observedAtMs,
      rvolAgeMs,
      currentCumulativeVolume,
    }),
  };
}

export function evaluateUsQualityDaytradeLiquidityEvidence(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PredictionInputError("quality day-trade liquidity evidence input must be an object");
  }

  let asOfMs;
  try {
    asOfMs = positiveNumber(raw.asOfMs, "asOfMs");
  } catch {
    return safeResult({ status: "BLOCKED_DATA", reason: "LIQUIDITY_ASOF_REQUIRED" });
  }

  const policy = normalizePolicy(raw.liquidityPolicy);

  let candles;
  try {
    candles = validateCandles(raw.candleEvidence, asOfMs, policy);
  } catch (error) {
    if (error instanceof PredictionInputError) return safeResult({ status: "BLOCKED_DATA", reason: "LIQUIDITY_CANDLE_FIELDS_INVALID" });
    throw error;
  }
  if (candles.blocker) return safeResult({ status: "BLOCKED_DATA", reason: candles.blocker, ...candles });

  let rvol;
  try {
    rvol = validateRelativeVolume(
      raw.relativeVolumeEvidence,
      asOfMs,
      candles.value.session,
      candles.value.sessionCumulativeShareVolume,
      candles.value.lastCompleteCandleTimestampMs,
      policy,
    );
  } catch (error) {
    if (error instanceof PredictionInputError) return safeResult({ status: "BLOCKED_DATA", reason: "LIQUIDITY_RVOL_FIELDS_INVALID" });
    throw error;
  }
  if (rvol.blocker) return safeResult({ status: "BLOCKED_DATA", reason: rvol.blocker, ...rvol });

  return safeResult({
    status: "PASS",
    reason: "POINT_IN_TIME_SESSION_DOLLAR_VOLUME_READY",
    asOfMs,
    session: candles.value.session,
    sessionCumulativeShareVolume: candles.value.sessionCumulativeShareVolume,
    candleDerivedSessionDollarVolumeUsd: candles.value.candleDerivedSessionDollarVolumeUsd,
    candleDerivedAveragePriceUsd: candles.value.candleDerivedAveragePriceUsd,
    dollarVolumeBasis: candles.value.dollarVolumeBasis,
    completedThroughMs: candles.value.lastCompleteCandleTimestampMs,
    rvolObservedAtMs: rvol.value.observedAtMs,
    rvolCurrentCumulativeVolume: rvol.value.currentCumulativeVolume,
    policy,
    provenance: freeze({
      candleSourceId: candles.value.sourceId,
      relativeVolumeSourceId: rvol.value.sourceId,
      pointInTime: true,
      publicReadOnly: true,
      privateApiUsed: false,
    }),
  });
}
