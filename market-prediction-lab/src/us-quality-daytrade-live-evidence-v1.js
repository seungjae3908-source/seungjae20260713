import { PredictionInputError } from "./contracts.js";
import { researchDigest } from "./research-trial-registry.js";

export const QUALITY_DAYTRADE_LIVE_EVIDENCE_VERSION = "us-quality-daytrade-live-evidence-v1";
export const QUALITY_DAYTRADE_OBSERVATION_IDENTITY_VERSION = "us-quality-daytrade-observation-identity-v1";

const VALID_SESSIONS = new Set(["PREMARKET", "REGULAR", "AFTER_HOURS"]);
const EXECUTABLE_QUOTE_KIND = "EXECUTABLE_BID_ASK";
const DEFAULT_LIVE_DATA_POLICY = Object.freeze({
  maxQuoteAgeMs: 15_000,
  maxCandleLagIntervals: 1.5,
  maxCrossSourceSkewMs: 15_000,
});

function freeze(value) {
  return Object.freeze(value);
}

function safeResult(fields) {
  return freeze({
    contractVersion: QUALITY_DAYTRADE_LIVE_EVIDENCE_VERSION,
    executionAuthority: "NONE",
    liveTradingAllowed: false,
    privateApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    ...fields,
  });
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
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

function normalizeDataPolicy(raw = {}) {
  const maxQuoteAgeMs = positiveNumber(raw.maxQuoteAgeMs ?? DEFAULT_LIVE_DATA_POLICY.maxQuoteAgeMs);
  const maxCandleLagIntervals = positiveNumber(raw.maxCandleLagIntervals ?? DEFAULT_LIVE_DATA_POLICY.maxCandleLagIntervals);
  const maxCrossSourceSkewMs = positiveNumber(raw.maxCrossSourceSkewMs ?? DEFAULT_LIVE_DATA_POLICY.maxCrossSourceSkewMs);
  if (maxQuoteAgeMs == null || maxQuoteAgeMs > 300_000) throw new PredictionInputError("invalid live dataPolicy.maxQuoteAgeMs");
  if (maxCandleLagIntervals == null || maxCandleLagIntervals > 5) throw new PredictionInputError("invalid live dataPolicy.maxCandleLagIntervals");
  if (maxCrossSourceSkewMs == null || maxCrossSourceSkewMs > 300_000) throw new PredictionInputError("invalid live dataPolicy.maxCrossSourceSkewMs");
  return freeze({ maxQuoteAgeMs, maxCandleLagIntervals, maxCrossSourceSkewMs });
}

function validateQuote(raw, asOfMs) {
  const safety = sourceSafetyBlock(raw, "QUOTE");
  if (safety) return { blocker: safety };
  if (String(raw.kind ?? "").toUpperCase() !== EXECUTABLE_QUOTE_KIND) {
    return { blocker: "EXECUTABLE_BID_ASK_PROVENANCE_REQUIRED" };
  }

  const observedAtMs = positiveNumber(raw.observedAtMs ?? raw.timestampMs);
  const bid = positiveNumber(raw.bid);
  const ask = positiveNumber(raw.ask);
  if (observedAtMs == null) return { blocker: "QUOTE_OBSERVED_AT_REQUIRED" };
  if (observedAtMs > asOfMs) return { blocker: "QUOTE_EVIDENCE_FROM_FUTURE" };
  if (bid == null || ask == null || ask < bid) return { blocker: "VALID_EXECUTABLE_BID_ASK_REQUIRED" };

  return {
    value: freeze({
      bid,
      ask,
      timestampMs: observedAtMs,
      sourceId: sourceId(raw),
    }),
  };
}

function validateCandles(raw, asOfMs) {
  const safety = sourceSafetyBlock(raw, "CANDLE");
  if (safety) return { blocker: safety };

  const session = normalizeSession(raw.session);
  if (!session) return { blocker: "CANDLE_SESSION_REQUIRED" };
  const timeframeMs = positiveNumber(raw.timeframeMs);
  const sessionStartTimestampMs = positiveNumber(raw.sessionStartTimestampMs);
  const coverageStartTimestampMs = positiveNumber(raw.coverageStartTimestampMs);
  const lastCompleteCandleTimestampMs = positiveNumber(raw.lastCompleteCandleTimestampMs);
  if (timeframeMs == null) return { blocker: "CANDLE_TIMEFRAME_REQUIRED" };
  if (sessionStartTimestampMs == null || coverageStartTimestampMs == null || lastCompleteCandleTimestampMs == null) {
    return { blocker: "CANDLE_COVERAGE_TIMESTAMPS_REQUIRED" };
  }
  if (raw.sessionCoverageComplete !== true) return { blocker: "SESSION_VWAP_COVERAGE_UNPROVEN" };
  if (lastCompleteCandleTimestampMs > asOfMs) return { blocker: "CANDLE_EVIDENCE_FROM_FUTURE" };
  if (coverageStartTimestampMs > lastCompleteCandleTimestampMs) return { blocker: "INVALID_CANDLE_COVERAGE_RANGE" };
  if (Math.abs(coverageStartTimestampMs - sessionStartTimestampMs) > timeframeMs) {
    return { blocker: "SESSION_START_VWAP_COVERAGE_INCOMPLETE" };
  }
  if (!Array.isArray(raw.candles) || raw.candles.length < 8) return { blocker: "INTRADAY_CANDLES_INSUFFICIENT" };

  const candles = [];
  let previousTimestamp = -Infinity;
  for (const [index, row] of raw.candles.entries()) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return { blocker: `CANDLE_ROW_INVALID:${index}` };
    const rowSession = normalizeSession(row.session ?? session);
    if (rowSession !== session) return { blocker: "CANDLE_SESSION_MISMATCH" };
    const timestamp = positiveNumber(row.timestamp);
    const open = positiveNumber(row.open);
    const high = positiveNumber(row.high);
    const low = positiveNumber(row.low);
    const close = positiveNumber(row.close);
    const volume = nonNegativeNumber(row.volume);
    if (timestamp == null || open == null || high == null || low == null || close == null || volume == null) {
      return { blocker: `CANDLE_ROW_FIELDS_INVALID:${index}` };
    }
    if (!(timestamp > previousTimestamp)) return { blocker: "CANDLE_TIMESTAMPS_NOT_STRICTLY_INCREASING" };
    previousTimestamp = timestamp;
    candles.push(freeze({ open, high, low, close, volume, session, timestamp }));
  }

  if (candles.at(-1).timestamp !== lastCompleteCandleTimestampMs) {
    return { blocker: "LAST_COMPLETE_CANDLE_MISMATCH" };
  }

  return {
    value: freeze({
      sourceId: sourceId(raw),
      session,
      candles: freeze(candles),
      candleEvidence: freeze({
        timeframeMs,
        sessionStartTimestampMs,
        coverageStartTimestampMs,
        lastCompleteCandleTimestampMs,
        sessionCoverageComplete: true,
      }),
    }),
  };
}

function validateRelativeVolume(raw, asOfMs, session, lastCompleteCandleTimestampMs) {
  const safety = sourceSafetyBlock(raw, "RVOL");
  if (safety) return { blocker: safety };
  if (normalizeSession(raw.session) !== session) return { blocker: "RVOL_SESSION_MISMATCH" };
  if (raw.sameSessionPhase !== true) return { blocker: "RVOL_SAME_SESSION_PHASE_REQUIRED" };
  if (raw.lookaheadFree !== true) return { blocker: "RVOL_LOOKAHEAD_FREE_EVIDENCE_REQUIRED" };

  const observedAtMs = positiveNumber(raw.observedAtMs);
  if (observedAtMs == null) return { blocker: "RVOL_OBSERVED_AT_REQUIRED" };
  if (observedAtMs > asOfMs) return { blocker: "RVOL_EVIDENCE_FROM_FUTURE" };
  if (observedAtMs < lastCompleteCandleTimestampMs) return { blocker: "RVOL_EVIDENCE_BEHIND_CANDLES" };

  const currentCumulativeVolume = positiveNumber(raw.currentCumulativeVolume);
  const baselineAverageCumulativeVolume = positiveNumber(raw.baselineAverageCumulativeVolume);
  const baselineSampleCount = Number(raw.baselineSampleCount);
  if (currentCumulativeVolume == null || baselineAverageCumulativeVolume == null) {
    return { blocker: "RVOL_VOLUME_COMPONENTS_REQUIRED" };
  }
  if (!Number.isInteger(baselineSampleCount) || baselineSampleCount < 1) return { blocker: "RVOL_BASELINE_SAMPLE_REQUIRED" };

  const relativeVolume = currentCumulativeVolume / baselineAverageCumulativeVolume;
  const reported = raw.reportedRelativeVolume == null ? null : Number(raw.reportedRelativeVolume);
  if (reported != null && (!Number.isFinite(reported) || Math.abs(reported - relativeVolume) > 1e-9)) {
    return { blocker: "RVOL_REPORTED_VALUE_MISMATCH" };
  }

  return {
    value: freeze({
      sourceId: sourceId(raw),
      observedAtMs,
      baselineSampleCount,
      currentCumulativeVolume,
      baselineAverageCumulativeVolume,
      relativeVolume,
    }),
  };
}

function validateEvidenceClock({ asOfMs, quote, candles, rvol, dataPolicy }) {
  const quoteAgeMs = asOfMs - quote.timestampMs;
  if (quoteAgeMs > dataPolicy.maxQuoteAgeMs) {
    return { blocker: "LIVE_QUOTE_STALE", quoteAgeMs };
  }
  const rvolAgeMs = asOfMs - rvol.observedAtMs;
  if (rvolAgeMs > dataPolicy.maxQuoteAgeMs) {
    return { blocker: "LIVE_RVOL_STALE", rvolAgeMs };
  }
  const maxCandleAgeMs = candles.candleEvidence.timeframeMs * dataPolicy.maxCandleLagIntervals;
  const candleAgeMs = asOfMs - candles.candleEvidence.lastCompleteCandleTimestampMs;
  if (candleAgeMs > maxCandleAgeMs) {
    return { blocker: "LIVE_CANDLES_STALE", candleAgeMs, maxCandleAgeMs };
  }
  const quoteRvolSkewMs = Math.abs(quote.timestampMs - rvol.observedAtMs);
  if (quoteRvolSkewMs > dataPolicy.maxCrossSourceSkewMs) {
    return { blocker: "LIVE_EVIDENCE_CLOCK_SKEW_TOO_WIDE", quoteRvolSkewMs };
  }
  return { quoteAgeMs, rvolAgeMs, candleAgeMs, maxCandleAgeMs, quoteRvolSkewMs };
}

function immutableSha(value, name) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(normalized)) throw new PredictionInputError(`${name} must be an immutable 40-char SHA`);
  return normalized;
}

function requiredIdentityString(value, name) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new PredictionInputError(`${name} is required`);
  return normalized;
}

export function buildUsQualityDaytradeLiveEvidenceBundle(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PredictionInputError("quality day-trade live evidence input must be an object");
  }
  const asOfMs = positiveNumber(raw.asOfMs);
  if (asOfMs == null) return safeResult({ status: "BLOCKED_DATA", reason: "LIVE_EVIDENCE_ASOF_REQUIRED" });
  const dataPolicy = normalizeDataPolicy(raw.dataPolicy);

  const quote = validateQuote(raw.quoteEvidence, asOfMs);
  if (quote.blocker) return safeResult({ status: "BLOCKED_DATA", reason: quote.blocker });

  const candles = validateCandles(raw.candleEvidence, asOfMs);
  if (candles.blocker) return safeResult({ status: "BLOCKED_DATA", reason: candles.blocker });

  const rvol = validateRelativeVolume(
    raw.relativeVolumeEvidence,
    asOfMs,
    candles.value.session,
    candles.value.candleEvidence.lastCompleteCandleTimestampMs,
  );
  if (rvol.blocker) return safeResult({ status: "BLOCKED_DATA", reason: rvol.blocker });

  const clock = validateEvidenceClock({
    asOfMs,
    quote: quote.value,
    candles: candles.value,
    rvol: rvol.value,
    dataPolicy,
  });
  if (clock.blocker) return safeResult({ status: "BLOCKED_DATA", reason: clock.blocker, ...clock });

  const candleDigest = researchDigest(candles.value.candles);
  const observationDigest = researchDigest({
    market: "US_STOCK",
    session: candles.value.session,
    quote: {
      sourceId: quote.value.sourceId,
      timestampMs: quote.value.timestampMs,
      bid: quote.value.bid,
      ask: quote.value.ask,
    },
    candles: {
      sourceId: candles.value.sourceId,
      timeframeMs: candles.value.candleEvidence.timeframeMs,
      lastCompleteCandleTimestampMs: candles.value.candleEvidence.lastCompleteCandleTimestampMs,
      candleDigest,
    },
    relativeVolume: {
      sourceId: rvol.value.sourceId,
      observedAtMs: rvol.value.observedAtMs,
      currentCumulativeVolume: rvol.value.currentCumulativeVolume,
      baselineAverageCumulativeVolume: rvol.value.baselineAverageCumulativeVolume,
      baselineSampleCount: rvol.value.baselineSampleCount,
    },
  });

  return safeResult({
    status: "READY",
    reason: "SOURCE_BACKED_INTRADAY_EVIDENCE_READY",
    asOfMs,
    quote: quote.value,
    candles: candles.value.candles,
    candleEvidence: candles.value.candleEvidence,
    relativeVolume: rvol.value.relativeVolume,
    relativeVolumeObservedAtMs: rvol.value.observedAtMs,
    session: candles.value.session,
    dataPolicy,
    evidenceClock: freeze(clock),
    provenance: freeze({
      quoteSourceId: quote.value.sourceId,
      candleSourceId: candles.value.sourceId,
      relativeVolumeSourceId: rvol.value.sourceId,
      rvolBaselineSampleCount: rvol.value.baselineSampleCount,
      candleDigest,
      observationDigest,
      publicReadOnly: true,
      privateApiUsed: false,
    }),
  });
}

export function buildUsQualityDaytradeObservationIdentity({ strategyIdentity, bundle } = {}) {
  if (!bundle || bundle.status !== "READY" || !bundle.provenance?.observationDigest) {
    throw new PredictionInputError("READY live evidence bundle with observationDigest is required");
  }
  if (!strategyIdentity || typeof strategyIdentity !== "object" || Array.isArray(strategyIdentity)) {
    throw new PredictionInputError("strategyIdentity is required");
  }
  const normalizedIdentity = freeze({
    strategyId: requiredIdentityString(strategyIdentity.strategyId, "strategyIdentity.strategyId"),
    strategyVersion: requiredIdentityString(strategyIdentity.strategyVersion, "strategyIdentity.strategyVersion"),
    parameterHash: requiredIdentityString(strategyIdentity.parameterHash, "strategyIdentity.parameterHash"),
    researchCodeSha: immutableSha(strategyIdentity.researchCodeSha, "strategyIdentity.researchCodeSha"),
    market: "US_STOCK",
    direction: "LONG",
  });
  const evidenceId = researchDigest({
    producer: "US_QUALITY_DAYTRADE",
    strategyIdentity: normalizedIdentity,
    observationDigest: bundle.provenance.observationDigest,
  });
  return freeze({
    contractVersion: QUALITY_DAYTRADE_OBSERVATION_IDENTITY_VERSION,
    strategyIdentity: normalizedIdentity,
    observationDigest: bundle.provenance.observationDigest,
    evidenceId,
    duplicateCountingAllowed: false,
    selectionEligible: false,
    executionAuthority: "NONE",
    liveTradingAllowed: false,
    privateApiAllowed: false,
  });
}

export function applyUsQualityDaytradeLiveEvidence(baseInput, bundle) {
  if (!baseInput || typeof baseInput !== "object" || Array.isArray(baseInput)) {
    throw new PredictionInputError("quality day-trade base input must be an object");
  }
  if (!bundle || bundle.status !== "READY") {
    return safeResult({ status: "BLOCKED_DATA", reason: bundle?.reason ?? "LIVE_EVIDENCE_BUNDLE_REQUIRED" });
  }
  return freeze({
    ...baseInput,
    asOfMs: bundle.asOfMs,
    quote: bundle.quote,
    candles: bundle.candles,
    candleEvidence: bundle.candleEvidence,
    relativeVolume: bundle.relativeVolume,
    relativeVolumeObservedAtMs: bundle.relativeVolumeObservedAtMs,
    liveEvidenceProvenance: bundle.provenance,
  });
}
