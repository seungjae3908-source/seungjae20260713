import { PredictionInputError } from "./contracts.js";

export const QUALITY_DAYTRADE_CONTRACT_VERSION = "us-quality-daytrade-v3";

export const DEFAULT_QUALITY_UNIVERSE = Object.freeze({
  tierA: Object.freeze({
    minPriceUsd: 10,
    minMarketCapUsd: 5_000_000_000,
    minAverageDollarVolumeUsd: 50_000_000,
    maxRegularSpreadBps: 20,
    maxExtendedSpreadBps: 35,
    riskBudgetMultiplier: 1,
  }),
  tierB: Object.freeze({
    minPriceUsd: 8,
    minMarketCapUsd: 1_000_000_000,
    maxMarketCapUsd: 5_000_000_000,
    minAverageDollarVolumeUsd: 20_000_000,
    minFloatShares: 20_000_000,
    maxRegularSpreadBps: 30,
    maxExtendedSpreadBps: 50,
    riskBudgetMultiplier: 0.5,
  }),
});

export const DEFAULT_QUALITY_DATA_POLICY = Object.freeze({
  maxQuoteAgeMs: 15_000,
  maxCandleLagIntervals: 1.5,
});

const EXCLUDED_SECURITY_TYPES = new Set([
  "OTC",
  "PENNY_STOCK",
  "MICROCAP",
  "SPAC",
  "WARRANT",
  "RIGHT",
  "LEVERAGED_ETF",
  "INVERSE_ETF",
]);

const VALID_SESSIONS = new Set(["PREMARKET", "REGULAR", "AFTER_HOURS"]);
const VALID_QUALITY_TIERS = new Set(["A", "B"]);

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

function optionalPositiveNumber(value, name) {
  if (value == null) return null;
  return positiveNumber(value, name);
}

function optionalPositiveEvidenceNumber(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizeFloatEvidence(raw) {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return Object.freeze({ invalidShape: true });
  const sourceId = String(raw.sourceId ?? raw.source ?? "").trim();
  return Object.freeze({
    invalidShape: false,
    sourceId: sourceId || null,
    pointInTime: raw.pointInTime === true,
    observedAtMs: optionalPositiveEvidenceNumber(raw.observedAtMs),
    validFromMs: optionalPositiveEvidenceNumber(raw.validFromMs),
    validToMs: optionalPositiveEvidenceNumber(raw.validToMs),
    shares: optionalPositiveEvidenceNumber(raw.shares),
  });
}

function normalizeInstrument(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PredictionInputError("instrument must be an object");
  const exchange = String(raw.exchange ?? "").toUpperCase();
  const securityType = String(raw.securityType ?? "COMMON_STOCK").toUpperCase();
  return Object.freeze({
    symbol: String(raw.symbol ?? "").toUpperCase(),
    exchange,
    securityType,
    priceUsd: positiveNumber(raw.priceUsd, "instrument.priceUsd"),
    marketCapUsd: positiveNumber(raw.marketCapUsd, "instrument.marketCapUsd"),
    averageDollarVolumeUsd: positiveNumber(raw.averageDollarVolumeUsd, "instrument.averageDollarVolumeUsd"),
    floatShares: optionalPositiveNumber(raw.floatShares, "instrument.floatShares"),
    floatEvidence: normalizeFloatEvidence(raw.floatEvidence),
    recentReverseSplit: raw.recentReverseSplit === true,
    listingRisk: raw.listingRisk === true,
    manipulationRisk: raw.manipulationRisk === true,
    dilutionRisk: raw.dilutionRisk === true,
    recentOffering: raw.recentOffering === true,
    goingConcernRisk: raw.goingConcernRisk === true,
  });
}

function normalizeUniversePolicy(raw = DEFAULT_QUALITY_UNIVERSE) {
  const tierA = { ...DEFAULT_QUALITY_UNIVERSE.tierA, ...(raw?.tierA ?? {}) };
  const tierB = { ...DEFAULT_QUALITY_UNIVERSE.tierB, ...(raw?.tierB ?? {}) };

  for (const [tierName, tier] of [["tierA", tierA], ["tierB", tierB]]) {
    for (const field of ["minPriceUsd", "minMarketCapUsd", "minAverageDollarVolumeUsd", "maxRegularSpreadBps", "maxExtendedSpreadBps", "riskBudgetMultiplier"]) {
      if (!Number.isFinite(Number(tier[field])) || Number(tier[field]) <= 0) throw new PredictionInputError(`invalid universePolicy.${tierName}.${field}`);
    }
  }
  if (!Number.isFinite(Number(tierB.maxMarketCapUsd)) || Number(tierB.maxMarketCapUsd) <= Number(tierB.minMarketCapUsd)) {
    throw new PredictionInputError("invalid universePolicy.tierB.maxMarketCapUsd");
  }
  if (!Number.isFinite(Number(tierB.minFloatShares)) || Number(tierB.minFloatShares) <= 0) {
    throw new PredictionInputError("invalid universePolicy.tierB.minFloatShares");
  }
  if (Number(tierB.maxMarketCapUsd) > Number(tierA.minMarketCapUsd)) {
    throw new PredictionInputError("tierB max market cap cannot exceed tierA minimum market cap");
  }
  return Object.freeze({ tierA: Object.freeze(tierA), tierB: Object.freeze(tierB) });
}

function validateTierBFloatEvidence(instrument, evaluationAsOfMs, reasons) {
  if (instrument.floatShares == null) {
    reasons.push("FLOAT_EVIDENCE_REQUIRED_FOR_TIER_B");
    return;
  }

  const evidence = instrument.floatEvidence;
  if (evidence == null || evidence.invalidShape) {
    reasons.push("FLOAT_PROVENANCE_REQUIRED_FOR_TIER_B");
    return;
  }
  if (!evidence.sourceId) reasons.push("FLOAT_SOURCE_REQUIRED_FOR_TIER_B");
  if (!evidence.pointInTime) reasons.push("FLOAT_POINT_IN_TIME_UNPROVEN");
  if (evidence.shares == null) reasons.push("FLOAT_EVIDENCE_SHARES_REQUIRED");
  else if (evidence.shares !== instrument.floatShares) reasons.push("FLOAT_EVIDENCE_SHARES_MISMATCH");

  const asOfMs = optionalPositiveEvidenceNumber(evaluationAsOfMs);
  if (asOfMs == null) {
    reasons.push("FLOAT_ASOF_REQUIRED_FOR_TIER_B");
    return;
  }
  if (evidence.observedAtMs == null) reasons.push("FLOAT_OBSERVED_AT_REQUIRED");
  else if (evidence.observedAtMs > asOfMs) reasons.push("FLOAT_EVIDENCE_FROM_FUTURE");

  if (evidence.validFromMs == null || evidence.validToMs == null) {
    reasons.push("FLOAT_COVERAGE_REQUIRED_FOR_TIER_B");
  } else if (evidence.validToMs < evidence.validFromMs || evidence.validFromMs > asOfMs || evidence.validToMs < asOfMs) {
    reasons.push("FLOAT_EVIDENCE_COVERAGE_MISMATCH");
  }
}

export function classifyUsQualityUniverse(raw, policy = DEFAULT_QUALITY_UNIVERSE, asOfMs = raw?.asOfMs) {
  const instrument = normalizeInstrument(raw);
  const normalizedPolicy = normalizeUniversePolicy(policy);
  const reasons = [];

  if (!instrument.symbol) reasons.push("SYMBOL_MISSING");
  if (!new Set(["NYSE", "NASDAQ"]).has(instrument.exchange)) reasons.push("EXCHANGE_NOT_ALLOWED");
  if (EXCLUDED_SECURITY_TYPES.has(instrument.securityType)) reasons.push(`SECURITY_TYPE_EXCLUDED:${instrument.securityType}`);
  if (instrument.securityType !== "COMMON_STOCK") reasons.push("COMMON_STOCK_REQUIRED");
  if (instrument.recentReverseSplit) reasons.push("RECENT_REVERSE_SPLIT");
  if (instrument.listingRisk) reasons.push("LISTING_RISK");
  if (instrument.manipulationRisk) reasons.push("MANIPULATION_RISK");

  let tier = null;
  if (reasons.length === 0) {
    const a = normalizedPolicy.tierA;
    const meetsTierA = instrument.priceUsd >= Number(a.minPriceUsd)
      && instrument.marketCapUsd >= Number(a.minMarketCapUsd)
      && instrument.averageDollarVolumeUsd >= Number(a.minAverageDollarVolumeUsd);

    if (meetsTierA) {
      tier = "A";
    } else if (instrument.marketCapUsd < Number(a.minMarketCapUsd)) {
      const b = normalizedPolicy.tierB;
      if (instrument.priceUsd < Number(b.minPriceUsd)) reasons.push("PRICE_BELOW_TIER_B_MINIMUM");
      if (instrument.marketCapUsd < Number(b.minMarketCapUsd)) reasons.push("MARKET_CAP_BELOW_TIER_B_MINIMUM");
      if (instrument.marketCapUsd >= Number(b.maxMarketCapUsd)) reasons.push("MARKET_CAP_ABOVE_TIER_B_MAXIMUM");
      if (instrument.averageDollarVolumeUsd < Number(b.minAverageDollarVolumeUsd)) reasons.push("DOLLAR_VOLUME_BELOW_TIER_B_MINIMUM");
      validateTierBFloatEvidence(instrument, asOfMs, reasons);
      if (instrument.floatShares != null && instrument.floatShares < Number(b.minFloatShares)) reasons.push("FLOAT_BELOW_TIER_B_MINIMUM");
      if (instrument.dilutionRisk) reasons.push("DILUTION_RISK");
      if (instrument.recentOffering) reasons.push("RECENT_OFFERING");
      if (instrument.goingConcernRisk) reasons.push("GOING_CONCERN_RISK");
      if (reasons.length === 0) tier = "B";
    } else {
      if (instrument.priceUsd < Number(a.minPriceUsd)) reasons.push("PRICE_BELOW_TIER_A_MINIMUM");
      if (instrument.averageDollarVolumeUsd < Number(a.minAverageDollarVolumeUsd)) reasons.push("DOLLAR_VOLUME_BELOW_TIER_A_MINIMUM");
    }
  }

  const tierPolicy = tier == null ? null : normalizedPolicy[tier === "A" ? "tierA" : "tierB"];
  return Object.freeze({
    contractVersion: QUALITY_DAYTRADE_CONTRACT_VERSION,
    eligible: reasons.length === 0 && tier != null,
    tier,
    riskBudgetMultiplier: tierPolicy == null ? 0 : Number(tierPolicy.riskBudgetMultiplier),
    reasons: Object.freeze(reasons),
    instrument,
    policy: normalizedPolicy,
  });
}

function normalizeCandles(raw) {
  if (!Array.isArray(raw) || raw.length < 8) throw new PredictionInputError("at least 8 intraday candles are required");
  const candles = raw.map((candle, index) => {
    if (!candle || typeof candle !== "object" || Array.isArray(candle)) throw new PredictionInputError(`invalid candle at ${index}`);
    const open = positiveNumber(candle.open, `candles[${index}].open`);
    const high = positiveNumber(candle.high, `candles[${index}].high`);
    const low = positiveNumber(candle.low, `candles[${index}].low`);
    const close = positiveNumber(candle.close, `candles[${index}].close`);
    const volume = finiteNumber(candle.volume, `candles[${index}].volume`);
    const timestamp = finiteNumber(candle.timestamp, `candles[${index}].timestamp`);
    if (volume < 0) throw new PredictionInputError(`candles[${index}].volume must be non-negative`);
    if (low > Math.min(open, close) || high < Math.max(open, close) || high < low) throw new PredictionInputError(`invalid OHLC at ${index}`);
    const session = String(candle.session ?? "").toUpperCase();
    if (!VALID_SESSIONS.has(session)) throw new PredictionInputError(`invalid session at ${index}`);
    return Object.freeze({ open, high, low, close, volume, session, timestamp });
  });
  for (let index = 1; index < candles.length; index += 1) {
    if (!(candles[index].timestamp > candles[index - 1].timestamp)) {
      throw new PredictionInputError("candle timestamps must be strictly increasing");
    }
  }
  return Object.freeze(candles);
}

function normalizeDataPolicy(raw = {}) {
  const maxQuoteAgeMs = finiteNumber(raw.maxQuoteAgeMs ?? DEFAULT_QUALITY_DATA_POLICY.maxQuoteAgeMs, "dataPolicy.maxQuoteAgeMs");
  const maxCandleLagIntervals = finiteNumber(
    raw.maxCandleLagIntervals ?? DEFAULT_QUALITY_DATA_POLICY.maxCandleLagIntervals,
    "dataPolicy.maxCandleLagIntervals",
  );
  if (!(maxQuoteAgeMs > 0) || maxQuoteAgeMs > 300_000) throw new PredictionInputError("invalid dataPolicy.maxQuoteAgeMs");
  if (!(maxCandleLagIntervals > 0) || maxCandleLagIntervals > 5) throw new PredictionInputError("invalid dataPolicy.maxCandleLagIntervals");
  return Object.freeze({ maxQuoteAgeMs, maxCandleLagIntervals });
}

function normalizeCandleEvidence(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const timeframeMs = positiveNumber(raw.timeframeMs, "candleEvidence.timeframeMs");
  if (timeframeMs > 86_400_000) throw new PredictionInputError("invalid candleEvidence.timeframeMs");
  return Object.freeze({
    timeframeMs,
    sessionStartTimestampMs: finiteNumber(raw.sessionStartTimestampMs, "candleEvidence.sessionStartTimestampMs"),
    coverageStartTimestampMs: finiteNumber(raw.coverageStartTimestampMs, "candleEvidence.coverageStartTimestampMs"),
    lastCompleteCandleTimestampMs: finiteNumber(raw.lastCompleteCandleTimestampMs, "candleEvidence.lastCompleteCandleTimestampMs"),
    sessionCoverageComplete: raw.sessionCoverageComplete === true,
  });
}

function sessionVwap(candles) {
  let numerator = 0;
  let denominator = 0;
  for (const candle of candles) {
    if (!(candle.volume > 0)) continue;
    const typical = (candle.high + candle.low + candle.close) / 3;
    numerator += typical * candle.volume;
    denominator += candle.volume;
  }
  return denominator > 0 ? numerator / denominator : null;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function highestHigh(candles) {
  return candles.reduce((highest, candle) => Math.max(highest, candle.high), -Infinity);
}

function normalizeSetupParams(raw = {}, qualityTier = "A") {
  if (!VALID_QUALITY_TIERS.has(qualityTier)) throw new PredictionInputError("invalid quality tier");
  const tierB = qualityTier === "B";
  const params = {
    minRelativeVolume: Number(raw.minRelativeVolume ?? (tierB ? 2.0 : 1.5)),
    minVolumeReacceleration: Number(raw.minVolumeReacceleration ?? (tierB ? 1.5 : 1.25)),
    minInitialImpulsePct: Number(raw.minInitialImpulsePct ?? (tierB ? 1.5 : 1.0)),
    minPullbackPct: Number(raw.minPullbackPct ?? (tierB ? 0.4 : 0.25)),
    maxPullbackPct: Number(raw.maxPullbackPct ?? (tierB ? 4.0 : 3.0)),
    maxVwapUndercutBps: Number(raw.maxVwapUndercutBps ?? (tierB ? 15 : 20)),
    breakoutLookback: Number(raw.breakoutLookback ?? 3),
  };
  for (const name of ["minRelativeVolume", "minVolumeReacceleration", "minInitialImpulsePct", "minPullbackPct", "maxPullbackPct"]) {
    if (!Number.isFinite(params[name]) || params[name] <= 0) throw new PredictionInputError(`invalid ${name}`);
  }
  if (!Number.isFinite(params.maxVwapUndercutBps) || params.maxVwapUndercutBps < 0 || params.maxVwapUndercutBps > 500) throw new PredictionInputError("invalid maxVwapUndercutBps");
  if (!Number.isInteger(params.breakoutLookback) || params.breakoutLookback < 2 || params.breakoutLookback > 20) throw new PredictionInputError("invalid breakoutLookback");
  if (params.maxPullbackPct <= params.minPullbackPct) throw new PredictionInputError("maxPullbackPct must exceed minPullbackPct");
  return Object.freeze(params);
}

export function evaluateUsQualityDaytradeSetup(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PredictionInputError("quality day-trade input must be an object");
  const universe = classifyUsQualityUniverse(raw.instrument, raw.universePolicy ?? DEFAULT_QUALITY_UNIVERSE, raw.asOfMs);
  if (!universe.eligible) return Object.freeze({ status: "ABSTAIN", reason: "UNIVERSE_REJECTED", universe });

  const candles = normalizeCandles(raw.candles);
  const params = normalizeSetupParams(raw.params, universe.tier);
  const dataPolicy = normalizeDataPolicy(raw.dataPolicy);
  const session = candles.at(-1).session;
  if (!candles.every((candle) => candle.session === session)) {
    return Object.freeze({ status: "BLOCKED_DATA", reason: "MIXED_SESSION_CANDLES", universe, session });
  }

  const bid = raw.quote?.bid == null ? null : positiveNumber(raw.quote.bid, "quote.bid");
  const ask = raw.quote?.ask == null ? null : positiveNumber(raw.quote.ask, "quote.ask");
  if (bid == null || ask == null || ask < bid) return Object.freeze({ status: "BLOCKED_DATA", reason: "VALID_BID_ASK_REQUIRED", universe, session });

  const asOfMs = raw.asOfMs == null ? null : finiteNumber(raw.asOfMs, "asOfMs");
  const quoteTimestampMs = raw.quote?.timestampMs == null ? null : finiteNumber(raw.quote.timestampMs, "quote.timestampMs");
  if (asOfMs == null || quoteTimestampMs == null) {
    return Object.freeze({ status: "BLOCKED_DATA", reason: "QUOTE_FRESHNESS_EVIDENCE_REQUIRED", universe, session });
  }
  if (quoteTimestampMs > asOfMs) {
    return Object.freeze({ status: "BLOCKED_DATA", reason: "QUOTE_TIMESTAMP_IN_FUTURE", universe, session, asOfMs, quoteTimestampMs });
  }
  const quoteAgeMs = asOfMs - quoteTimestampMs;
  if (quoteAgeMs > dataPolicy.maxQuoteAgeMs) {
    return Object.freeze({
      status: "BLOCKED_DATA",
      reason: "STALE_QUOTE",
      universe,
      session,
      quoteAgeMs,
      maxQuoteAgeMs: dataPolicy.maxQuoteAgeMs,
    });
  }

  const last = candles.at(-1);
  const candleEvidence = normalizeCandleEvidence(raw.candleEvidence);
  if (candleEvidence == null) {
    return Object.freeze({ status: "BLOCKED_DATA", reason: "CANDLE_FRESHNESS_EVIDENCE_REQUIRED", universe, session, quoteAgeMs });
  }
  if (!candleEvidence.sessionCoverageComplete) {
    return Object.freeze({ status: "BLOCKED_DATA", reason: "SESSION_VWAP_COVERAGE_UNPROVEN", universe, session, quoteAgeMs });
  }
  if (candleEvidence.coverageStartTimestampMs > candleEvidence.lastCompleteCandleTimestampMs) {
    return Object.freeze({ status: "BLOCKED_DATA", reason: "INVALID_CANDLE_COVERAGE_RANGE", universe, session, quoteAgeMs });
  }
  if (Math.abs(candleEvidence.coverageStartTimestampMs - candleEvidence.sessionStartTimestampMs) > candleEvidence.timeframeMs) {
    return Object.freeze({
      status: "BLOCKED_DATA",
      reason: "SESSION_START_VWAP_COVERAGE_INCOMPLETE",
      universe,
      session,
      quoteAgeMs,
      sessionStartTimestampMs: candleEvidence.sessionStartTimestampMs,
      coverageStartTimestampMs: candleEvidence.coverageStartTimestampMs,
      timeframeMs: candleEvidence.timeframeMs,
    });
  }
  if (candleEvidence.lastCompleteCandleTimestampMs !== last.timestamp) {
    return Object.freeze({
      status: "BLOCKED_DATA",
      reason: "LAST_COMPLETE_CANDLE_MISMATCH",
      universe,
      session,
      quoteAgeMs,
      lastCandleTimestampMs: last.timestamp,
      lastCompleteCandleTimestampMs: candleEvidence.lastCompleteCandleTimestampMs,
    });
  }
  if (candleEvidence.lastCompleteCandleTimestampMs > asOfMs) {
    return Object.freeze({ status: "BLOCKED_DATA", reason: "CANDLE_TIMESTAMP_IN_FUTURE", universe, session, quoteAgeMs });
  }
  const candleAgeMs = asOfMs - candleEvidence.lastCompleteCandleTimestampMs;
  const maxCandleAgeMs = candleEvidence.timeframeMs * dataPolicy.maxCandleLagIntervals;
  if (candleAgeMs > maxCandleAgeMs) {
    return Object.freeze({
      status: "BLOCKED_DATA",
      reason: "STALE_CANDLES",
      universe,
      session,
      quoteAgeMs,
      candleAgeMs,
      maxCandleAgeMs,
      timeframeMs: candleEvidence.timeframeMs,
    });
  }

  const mid = (bid + ask) / 2;
  const spreadBps = mid > 0 ? ((ask - bid) / mid) * 10_000 : Number.POSITIVE_INFINITY;
  const tierPolicy = universe.policy[universe.tier === "A" ? "tierA" : "tierB"];
  const maxSpreadBps = session === "REGULAR"
    ? Number(tierPolicy.maxRegularSpreadBps)
    : Number(tierPolicy.maxExtendedSpreadBps);
  if (spreadBps > maxSpreadBps) return Object.freeze({ status: "ABSTAIN", reason: "SPREAD_TOO_WIDE", universe, session, spreadBps, maxSpreadBps, quoteAgeMs, candleAgeMs });

  const relativeVolume = finiteNumber(raw.relativeVolume, "relativeVolume");
  if (relativeVolume < params.minRelativeVolume) return Object.freeze({ status: "ABSTAIN", reason: "RVOL_TOO_LOW", universe, session, relativeVolume, quoteAgeMs, candleAgeMs });

  const vwap = sessionVwap(candles);
  if (!(vwap > 0)) return Object.freeze({ status: "BLOCKED_DATA", reason: "VWAP_UNAVAILABLE", universe, session });

  const previous = candles.at(-2);
  const first = candles[0];
  const impulseCandidates = candles.slice(0, -2);
  let impulseHighIndex = 0;
  for (let index = 1; index < impulseCandidates.length; index += 1) {
    if (impulseCandidates[index].high >= impulseCandidates[impulseHighIndex].high) impulseHighIndex = index;
  }
  const impulseHigh = impulseCandidates[impulseHighIndex].high;
  const impulsePct = ((impulseHigh / first.open) - 1) * 100;
  const pullbackWindow = candles.slice(impulseHighIndex + 1, -1);
  if (!pullbackWindow.length) {
    return Object.freeze({
      status: "ABSTAIN",
      reason: "FIRST_PULLBACK_NOT_OBSERVED",
      contractVersion: QUALITY_DAYTRADE_CONTRACT_VERSION,
      universe,
      session,
      vwap,
      spreadBps,
      quoteAgeMs,
      candleAgeMs,
      relativeVolume,
      executionAuthority: "NONE",
      liveTradingAllowed: false,
      privateApiAllowed: false,
    });
  }
  const pullbackLow = Math.min(...pullbackWindow.map((candle) => candle.low));
  const pullbackPct = ((impulseHigh - pullbackLow) / impulseHigh) * 100;
  const lookback = candles.slice(Math.max(0, candles.length - 1 - params.breakoutLookback), -1);
  const rebreakLevel = highestHigh(lookback);
  const priorVolumes = candles.slice(Math.max(0, candles.length - 6), -1).map((candle) => candle.volume);
  const baselineVolume = average(priorVolumes);
  const volumeReacceleration = baselineVolume != null && baselineVolume > 0 ? last.volume / baselineVolume : null;
  const higherLow = last.low > previous.low;
  const vwapHold = pullbackLow >= vwap * (1 - params.maxVwapUndercutBps / 10_000) && last.close >= vwap;
  const rebreak = last.close > rebreakLevel;
  const volumePass = volumeReacceleration != null && volumeReacceleration >= params.minVolumeReacceleration;
  const pullbackPass = pullbackPct >= params.minPullbackPct && pullbackPct <= params.maxPullbackPct;
  const impulsePass = impulsePct >= params.minInitialImpulsePct;
  const catalystClass = raw.catalyst?.verified === true ? "VERIFIED_CATALYST" : "NO_VERIFIED_CATALYST";

  const checks = Object.freeze({
    impulsePass,
    pullbackPass,
    higherLow,
    vwapHold,
    rebreak,
    volumePass,
  });
  const qualifies = Object.values(checks).every(Boolean);
  return Object.freeze({
    status: qualifies ? "CANDIDATE" : "ABSTAIN",
    reason: qualifies ? "VWAP_FIRST_PULLBACK_REBREAK" : "SETUP_NOT_COMPLETE",
    contractVersion: QUALITY_DAYTRADE_CONTRACT_VERSION,
    universe,
    qualityTier: universe.tier,
    riskBudgetMultiplier: universe.riskBudgetMultiplier,
    hardRiskCeilingPct: 4,
    session,
    catalystClass,
    vwap,
    spreadBps,
    quoteAgeMs,
    candleAgeMs,
    maxCandleAgeMs,
    relativeVolume,
    impulsePct,
    pullbackPct,
    rebreakLevel,
    volumeReacceleration,
    checks,
    executionAuthority: "NONE",
    liveTradingAllowed: false,
    privateApiAllowed: false,
  });
}

export function buildQualityDaytradeParameterGrid({ catalystDay = false, qualityTier = "A" } = {}) {
  const tier = String(qualityTier).toUpperCase();
  if (!VALID_QUALITY_TIERS.has(tier)) throw new PredictionInputError("qualityTier must be A or B");
  const takeProfitsPct = tier === "B"
    ? (catalystDay ? [2, 3, 4, 5, 7.5, 10] : [1.5, 2, 3, 4, 5, 7.5])
    : (catalystDay ? [2, 3, 4, 5, 7.5, 10] : [1, 1.5, 2, 3, 4, 5]);
  const fixedStopsPct = tier === "B" ? [1, 1.5, 2, 2.5, 3, 4] : [0.8, 1.2, 1.6, 2, 2.5, 4];
  const timeStopsMinutes = [15, 30, 60, 90];
  const exitModes = ["FIXED", "VWAP_OR_FIXED", "BREAKEVEN_TRAIL"];
  const combinations = [];
  for (const takeProfitPct of takeProfitsPct)
    for (const fixedStopPct of fixedStopsPct)
      for (const timeStopMinutes of timeStopsMinutes)
        for (const exitMode of exitModes)
          combinations.push(Object.freeze({ takeProfitPct, fixedStopPct, timeStopMinutes, exitMode }));
  return Object.freeze({
    contractVersion: QUALITY_DAYTRADE_CONTRACT_VERSION,
    qualityTier: tier,
    riskBudgetMultiplier: tier === "B" ? DEFAULT_QUALITY_UNIVERSE.tierB.riskBudgetMultiplier : DEFAULT_QUALITY_UNIVERSE.tierA.riskBudgetMultiplier,
    catalystDay,
    combinations: Object.freeze(combinations),
    optimizationRule: "COARSE_TO_FINE_OOS_WALK_FORWARD_FINAL_HOLDOUT",
    selectionMetric: "NET_EXPECTANCY_WITH_PF_MDD_COST_STRESS",
    note: tier === "B"
      ? "Quality small-cap Tier B uses half risk budget; 4% is a hard research ceiling, not a default stop."
      : "4% fixed stop is a stress ceiling candidate, not the default stop.",
  });
}