import { PredictionInputError } from "./contracts.js";

export const QUALITY_DAYTRADE_CONTRACT_VERSION = "us-quality-daytrade-v1";

export const DEFAULT_QUALITY_UNIVERSE = Object.freeze({
  minPriceUsd: 10,
  minMarketCapUsd: 5_000_000_000,
  minAverageDollarVolumeUsd: 50_000_000,
  maxRegularSpreadBps: 20,
  maxExtendedSpreadBps: 35,
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
    recentReverseSplit: raw.recentReverseSplit === true,
    listingRisk: raw.listingRisk === true,
    manipulationRisk: raw.manipulationRisk === true,
  });
}

export function classifyUsQualityUniverse(raw, policy = DEFAULT_QUALITY_UNIVERSE) {
  const instrument = normalizeInstrument(raw);
  const reasons = [];
  if (!instrument.symbol) reasons.push("SYMBOL_MISSING");
  if (!new Set(["NYSE", "NASDAQ"]).has(instrument.exchange)) reasons.push("EXCHANGE_NOT_ALLOWED");
  if (EXCLUDED_SECURITY_TYPES.has(instrument.securityType)) reasons.push(`SECURITY_TYPE_EXCLUDED:${instrument.securityType}`);
  if (instrument.securityType !== "COMMON_STOCK") reasons.push("COMMON_STOCK_REQUIRED");
  if (instrument.priceUsd < Number(policy.minPriceUsd)) reasons.push("PRICE_BELOW_MINIMUM");
  if (instrument.marketCapUsd < Number(policy.minMarketCapUsd)) reasons.push("MARKET_CAP_BELOW_MINIMUM");
  if (instrument.averageDollarVolumeUsd < Number(policy.minAverageDollarVolumeUsd)) reasons.push("DOLLAR_VOLUME_BELOW_MINIMUM");
  if (instrument.recentReverseSplit) reasons.push("RECENT_REVERSE_SPLIT");
  if (instrument.listingRisk) reasons.push("LISTING_RISK");
  if (instrument.manipulationRisk) reasons.push("MANIPULATION_RISK");
  return Object.freeze({
    contractVersion: QUALITY_DAYTRADE_CONTRACT_VERSION,
    eligible: reasons.length === 0,
    reasons: Object.freeze(reasons),
    instrument,
  });
}

function normalizeCandles(raw) {
  if (!Array.isArray(raw) || raw.length < 8) throw new PredictionInputError("at least 8 intraday candles are required");
  return Object.freeze(raw.map((candle, index) => {
    if (!candle || typeof candle !== "object" || Array.isArray(candle)) throw new PredictionInputError(`invalid candle at ${index}`);
    const open = positiveNumber(candle.open, `candles[${index}].open`);
    const high = positiveNumber(candle.high, `candles[${index}].high`);
    const low = positiveNumber(candle.low, `candles[${index}].low`);
    const close = positiveNumber(candle.close, `candles[${index}].close`);
    const volume = finiteNumber(candle.volume, `candles[${index}].volume`);
    if (volume < 0) throw new PredictionInputError(`candles[${index}].volume must be non-negative`);
    if (low > Math.min(open, close) || high < Math.max(open, close) || high < low) throw new PredictionInputError(`invalid OHLC at ${index}`);
    const session = String(candle.session ?? "").toUpperCase();
    if (!VALID_SESSIONS.has(session)) throw new PredictionInputError(`invalid session at ${index}`);
    return Object.freeze({ open, high, low, close, volume, session, timestamp: candle.timestamp ?? index });
  }));
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

function normalizeSetupParams(raw = {}) {
  const params = {
    minRelativeVolume: Number(raw.minRelativeVolume ?? 1.5),
    minVolumeReacceleration: Number(raw.minVolumeReacceleration ?? 1.25),
    minInitialImpulsePct: Number(raw.minInitialImpulsePct ?? 1.0),
    minPullbackPct: Number(raw.minPullbackPct ?? 0.25),
    maxPullbackPct: Number(raw.maxPullbackPct ?? 3.0),
    maxVwapUndercutBps: Number(raw.maxVwapUndercutBps ?? 20),
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
  const universe = classifyUsQualityUniverse(raw.instrument, raw.universePolicy ?? DEFAULT_QUALITY_UNIVERSE);
  if (!universe.eligible) return Object.freeze({ status: "ABSTAIN", reason: "UNIVERSE_REJECTED", universe });

  const candles = normalizeCandles(raw.candles);
  const params = normalizeSetupParams(raw.params);
  const session = candles.at(-1).session;
  if (!candles.every((candle) => candle.session === session)) {
    return Object.freeze({ status: "BLOCKED_DATA", reason: "MIXED_SESSION_CANDLES", universe, session });
  }

  const bid = raw.quote?.bid == null ? null : positiveNumber(raw.quote.bid, "quote.bid");
  const ask = raw.quote?.ask == null ? null : positiveNumber(raw.quote.ask, "quote.ask");
  if (bid == null || ask == null || ask < bid) return Object.freeze({ status: "BLOCKED_DATA", reason: "VALID_BID_ASK_REQUIRED", universe, session });
  const mid = (bid + ask) / 2;
  const spreadBps = mid > 0 ? ((ask - bid) / mid) * 10_000 : Number.POSITIVE_INFINITY;
  const maxSpreadBps = session === "REGULAR"
    ? Number(raw.universePolicy?.maxRegularSpreadBps ?? DEFAULT_QUALITY_UNIVERSE.maxRegularSpreadBps)
    : Number(raw.universePolicy?.maxExtendedSpreadBps ?? DEFAULT_QUALITY_UNIVERSE.maxExtendedSpreadBps);
  if (spreadBps > maxSpreadBps) return Object.freeze({ status: "ABSTAIN", reason: "SPREAD_TOO_WIDE", universe, session, spreadBps, maxSpreadBps });

  const relativeVolume = finiteNumber(raw.relativeVolume, "relativeVolume");
  if (relativeVolume < params.minRelativeVolume) return Object.freeze({ status: "ABSTAIN", reason: "RVOL_TOO_LOW", universe, session, relativeVolume });

  const vwap = sessionVwap(candles);
  if (!(vwap > 0)) return Object.freeze({ status: "BLOCKED_DATA", reason: "VWAP_UNAVAILABLE", universe, session });

  const last = candles.at(-1);
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
    session,
    catalystClass,
    vwap,
    spreadBps,
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

export function buildQualityDaytradeParameterGrid({ catalystDay = false } = {}) {
  const takeProfitsPct = catalystDay ? [2, 3, 4, 5, 7.5, 10] : [1, 1.5, 2, 3, 4, 5];
  const fixedStopsPct = [0.8, 1.2, 1.6, 2, 2.5, 4];
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
    catalystDay,
    combinations: Object.freeze(combinations),
    optimizationRule: "COARSE_TO_FINE_OOS_WALK_FORWARD_FINAL_HOLDOUT",
    selectionMetric: "NET_EXPECTANCY_WITH_PF_MDD_COST_STRESS",
    note: "4% fixed stop is a stress ceiling candidate, not the default stop.",
  });
}
