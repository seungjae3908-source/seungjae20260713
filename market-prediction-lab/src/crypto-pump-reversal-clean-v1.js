import { createHash } from "node:crypto";

export const CRYPTO_PUMP_REVERSAL_SHORT_CLEAN_V1 = "CRYPTO_PUMP_REVERSAL_SHORT_CLEAN_V1";
export const CRYPTO_PUMP_REVERSAL_FAMILY = "EVENT_SPECIALIST";
export const CRYPTO_PUMP_REVERSAL_VERSION = "pump-reversal-clean-v1";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const CRYPTO_PUMP_REVERSAL_CLEAN_V1_RULES = Object.freeze({
  market: "CRYPTO_FUTURES",
  direction: "SHORT",
  signalTimeframe: "1H",
  stopMonitoringTimeframe: "1m",
  profileLookbackDays: 30,
  minimumHistoryDays: 180,
  minimumAverageDailyQuoteVolumeUsd: 2_000_000,
  maximumAverageDailyQuoteVolumeUsd: 30_000_000,
  dailyVolatilityMetric: "MEAN_INTRADAY_RANGE_OVER_OPEN",
  maximumAverageDailyRangePercent: 7.5,
  extremeMoveMetric: "DAILY_CLOSE_OVER_OPEN_GTE_50_PERCENT",
  maximumExtremeMoveFrequencyPercent: 0.3,
  minimumPump24hPercent: 25,
  volumePercentileLookbackHours: 168,
  minimumCurrentHourVolumePercentile: 0.5,
  maximumBtc30dReturnPercent: 30,
  blockedBtc30dBelowPercent: 0,
  blockedBtc7dAbovePercent: 3,
  cooldownHours: 24,
  stopAdversePercent: 25,
  timeExitHours: 72,
  sameBarEntryAllowed: false,
  performanceBasedUniverseExclusionAllowed: false,
  fundingAsDirectionalFilterAllowed: false,
  executionAuthority: "NONE",
  liveOrderAllowed: false,
});

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function digest(value) {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

export const CRYPTO_PUMP_REVERSAL_CLEAN_V1_PARAMETER_HASH =
  digest(CRYPTO_PUMP_REVERSAL_CLEAN_V1_RULES);

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function positive(value) {
  return finite(value) && value > 0;
}

function unique(values) {
  return [...new Set(values)];
}

function normalizeCandles(candles, durationMs, observedAtMs, label) {
  if (!Array.isArray(candles)) throw new TypeError(`${label} candles must be an array`);
  const byTime = new Map();
  for (const candle of candles) {
    const timestampMs = Number(candle?.timestampMs ?? candle?.timestamp);
    const open = Number(candle?.open);
    const high = Number(candle?.high);
    const low = Number(candle?.low);
    const close = Number(candle?.close);
    const quoteVolume = Number(candle?.quoteVolume);
    if (![timestampMs, open, high, low, close].every(finite)
      || timestampMs <= 0 || !positive(open) || !positive(high) || !positive(low) || !positive(close)
      || high < low || open > high || open < low || close > high || close < low) {
      throw new Error(`${label}_CANDLE_INVALID`);
    }
    if (timestampMs + durationMs > observedAtMs) continue;
    if (byTime.has(timestampMs)) throw new Error(`${label}_CANDLE_DUPLICATE`);
    byTime.set(timestampMs, {
      timestampMs,
      open,
      high,
      low,
      close,
      quoteVolume: finite(quoteVolume) && quoteVolume >= 0 ? quoteVolume : null,
    });
  }
  return [...byTime.values()].sort((left, right) => left.timestampMs - right.timestampMs);
}

function contiguousTail(candles, count, durationMs) {
  if (candles.length < count) return null;
  const tail = candles.slice(-count);
  for (let index = 1; index < tail.length; index += 1) {
    if (tail[index].timestampMs - tail[index - 1].timestampMs !== durationMs) return null;
  }
  return tail;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentChange(from, to) {
  return ((to / from) - 1) * 100;
}

export function buildPumpReversalPointInTimeProfile({
  symbol,
  observedAtMs,
  dailyCandles,
  tradingStatus,
  liquidityReady,
} = {}) {
  if (typeof symbol !== "string" || !symbol.trim()) throw new TypeError("symbol is required");
  if (!positive(observedAtMs)) throw new TypeError("observedAtMs is required");

  const blockers = [];
  const closed = normalizeCandles(dailyCandles, DAY_MS, observedAtMs, "PIT_DAILY");
  const first = closed[0] ?? null;
  const historyDays = first ? (observedAtMs - first.timestampMs) / DAY_MS : 0;
  if (historyDays < CRYPTO_PUMP_REVERSAL_CLEAN_V1_RULES.minimumHistoryDays) {
    blockers.push("PIT_HISTORY_LT_180D");
  }

  const recent = closed.slice(-CRYPTO_PUMP_REVERSAL_CLEAN_V1_RULES.profileLookbackDays);
  if (recent.length < CRYPTO_PUMP_REVERSAL_CLEAN_V1_RULES.profileLookbackDays) {
    blockers.push("PIT_PROFILE_WINDOW_INSUFFICIENT");
  }

  const quoteVolumes = recent.map((candle) => candle.quoteVolume);
  if (quoteVolumes.some((value) => !finite(value))) blockers.push("PIT_DAILY_QUOTE_VOLUME_REQUIRED");
  const averageDailyQuoteVolumeUsd = quoteVolumes.every(finite) && quoteVolumes.length > 0
    ? mean(quoteVolumes)
    : null;
  if (finite(averageDailyQuoteVolumeUsd)
    && (averageDailyQuoteVolumeUsd < CRYPTO_PUMP_REVERSAL_CLEAN_V1_RULES.minimumAverageDailyQuoteVolumeUsd
      || averageDailyQuoteVolumeUsd > CRYPTO_PUMP_REVERSAL_CLEAN_V1_RULES.maximumAverageDailyQuoteVolumeUsd)) {
    blockers.push("PIT_AVERAGE_DAILY_QUOTE_VOLUME_OUT_OF_RANGE");
  }

  const ranges = recent.map((candle) => ((candle.high - candle.low) / candle.open) * 100);
  const averageDailyRangePercent = ranges.length ? mean(ranges) : null;
  if (finite(averageDailyRangePercent)
    && averageDailyRangePercent > CRYPTO_PUMP_REVERSAL_CLEAN_V1_RULES.maximumAverageDailyRangePercent) {
    blockers.push("PIT_DAILY_VOLATILITY_TOO_HIGH");
  }

  const extremeCount = closed.filter(
    (candle) => percentChange(candle.open, candle.close) >= 50,
  ).length;
  const extremeMoveFrequencyPercent = closed.length > 0
    ? (extremeCount / closed.length) * 100
    : null;
  if (finite(extremeMoveFrequencyPercent)
    && extremeMoveFrequencyPercent > CRYPTO_PUMP_REVERSAL_CLEAN_V1_RULES.maximumExtremeMoveFrequencyPercent) {
    blockers.push("PIT_EXTREME_MOVE_FREQUENCY_TOO_HIGH");
  }

  if (tradingStatus !== "TRADABLE") blockers.push("PIT_CONTRACT_NOT_TRADABLE");
  if (liquidityReady !== true) blockers.push("PIT_FUTURES_LIQUIDITY_NOT_READY");

  return deepFreeze({
    schemaVersion: "crypto-pump-reversal-pit-profile-v1",
    strategyId: CRYPTO_PUMP_REVERSAL_SHORT_CLEAN_V1,
    parameterHash: CRYPTO_PUMP_REVERSAL_CLEAN_V1_PARAMETER_HASH,
    symbol: symbol.trim().toUpperCase(),
    observedAtMs,
    dataCutoffRule: "ONLY_CANDLES_CLOSED_AT_OR_BEFORE_OBSERVED_AT",
    performanceBasedExclusionUsed: false,
    profileLookbackDays: CRYPTO_PUMP_REVERSAL_CLEAN_V1_RULES.profileLookbackDays,
    historyDays,
    closedDailyBars: closed.length,
    averageDailyQuoteVolumeUsd,
    averageDailyRangePercent,
    extremeMoveCount: extremeCount,
    extremeMoveFrequencyPercent,
    tradingStatus,
    liquidityReady: liquidityReady === true,
    eligible: blockers.length === 0,
    blockers: unique(blockers),
    executionAuthority: "NONE",
    liveOrderAllowed: false,
    profitabilityClaimAllowed: false,
  });
}

function btcRegime(btcDailyCandles, observedAtMs) {
  const closed = normalizeCandles(btcDailyCandles, DAY_MS, observedAtMs, "BTC_DAILY");
  const tail = contiguousTail(closed, 31, DAY_MS);
  if (!tail) {
    return {
      ready: false,
      blockers: ["BTC_30D_CONTIGUOUS_HISTORY_REQUIRED"],
      btc30dReturnPercent: null,
      btc7dReturnPercent: null,
    };
  }
  const latest = tail.at(-1);
  const btc30dReturnPercent = percentChange(tail[0].close, latest.close);
  const btc7dReturnPercent = percentChange(tail.at(-8).close, latest.close);
  return { ready: true, blockers: [], btc30dReturnPercent, btc7dReturnPercent };
}

function currentVolumePercentile(current, baseline) {
  if (!finite(current) || !Array.isArray(baseline) || baseline.length === 0 || baseline.some((value) => !finite(value))) {
    return null;
  }
  return baseline.filter((value) => value <= current).length / baseline.length;
}

export function evaluatePumpReversalCleanV1({
  symbol,
  observedAtMs,
  profile,
  hourlyCandles,
  btcDailyCandles,
  lastEntryAtMs = null,
} = {}) {
  if (typeof symbol !== "string" || !symbol.trim()) throw new TypeError("symbol is required");
  if (!positive(observedAtMs)) throw new TypeError("observedAtMs is required");

  const normalizedSymbol = symbol.trim().toUpperCase();
  const blockers = [];
  if (!profile || profile.strategyId !== CRYPTO_PUMP_REVERSAL_SHORT_CLEAN_V1
    || profile.parameterHash !== CRYPTO_PUMP_REVERSAL_CLEAN_V1_PARAMETER_HASH
    || profile.symbol !== normalizedSymbol
    || profile.observedAtMs > observedAtMs) {
    blockers.push("PIT_PROFILE_IDENTITY_REQUIRED");
  } else if (profile.eligible !== true) {
    blockers.push(...(profile.blockers ?? ["PIT_PROFILE_NOT_ELIGIBLE"]));
  }

  const closedHourly = normalizeCandles(hourlyCandles, HOUR_MS, observedAtMs, "SIGNAL_1H");
  const requiredHours = CRYPTO_PUMP_REVERSAL_CLEAN_V1_RULES.volumePercentileLookbackHours + 1;
  const hourlyWindow = contiguousTail(closedHourly, requiredHours, HOUR_MS);
  let pump24hPercent = null;
  let currentHourVolumePercentile = null;
  let sourceBarTimestampMs = null;
  let signalConfirmedAtMs = null;

  if (!hourlyWindow) {
    blockers.push("SIGNAL_169H_CONTIGUOUS_HISTORY_REQUIRED");
  } else {
    const latest = hourlyWindow.at(-1);
    sourceBarTimestampMs = latest.timestampMs;
    signalConfirmedAtMs = latest.timestampMs + HOUR_MS;
    const twentyFourHoursAgo = hourlyWindow.at(-25);
    pump24hPercent = percentChange(twentyFourHoursAgo.close, latest.close);
    const baselineVolumes = hourlyWindow.slice(0, -1).map((candle) => candle.quoteVolume);
    currentHourVolumePercentile = currentVolumePercentile(latest.quoteVolume, baselineVolumes);
    if (currentHourVolumePercentile == null) blockers.push("SIGNAL_1H_QUOTE_VOLUME_REQUIRED");
    if (pump24hPercent < CRYPTO_PUMP_REVERSAL_CLEAN_V1_RULES.minimumPump24hPercent) {
      blockers.push("PUMP_24H_LT_25_PERCENT");
    }
    if (finite(currentHourVolumePercentile)
      && currentHourVolumePercentile < CRYPTO_PUMP_REVERSAL_CLEAN_V1_RULES.minimumCurrentHourVolumePercentile) {
      blockers.push("CURRENT_1H_VOLUME_PERCENTILE_LT_50");
    }
  }

  const regime = btcRegime(btcDailyCandles, observedAtMs);
  blockers.push(...regime.blockers);
  if (finite(regime.btc30dReturnPercent)
    && regime.btc30dReturnPercent >= CRYPTO_PUMP_REVERSAL_CLEAN_V1_RULES.maximumBtc30dReturnPercent) {
    blockers.push("BTC_30D_GTE_30_PERCENT");
  }
  if (finite(regime.btc30dReturnPercent)
    && finite(regime.btc7dReturnPercent)
    && regime.btc30dReturnPercent < CRYPTO_PUMP_REVERSAL_CLEAN_V1_RULES.blockedBtc30dBelowPercent
    && regime.btc7dReturnPercent > CRYPTO_PUMP_REVERSAL_CLEAN_V1_RULES.blockedBtc7dAbovePercent) {
    blockers.push("BTC_BEAR_REBOUND_REGIME_BLOCK");
  }

  if (lastEntryAtMs != null) {
    if (!finite(lastEntryAtMs) || lastEntryAtMs > observedAtMs) blockers.push("COOLDOWN_TIMESTAMP_INVALID");
    else if (observedAtMs - lastEntryAtMs < CRYPTO_PUMP_REVERSAL_CLEAN_V1_RULES.cooldownHours * HOUR_MS) {
      blockers.push("SYMBOL_24H_REENTRY_COOLDOWN");
    }
  }

  const uniqueBlockers = unique(blockers);
  const ready = uniqueBlockers.length === 0 && finite(signalConfirmedAtMs);
  const signalId = ready
    ? digest({
      strategyId: CRYPTO_PUMP_REVERSAL_SHORT_CLEAN_V1,
      parameterHash: CRYPTO_PUMP_REVERSAL_CLEAN_V1_PARAMETER_HASH,
      symbol: normalizedSymbol,
      sourceBarTimestampMs,
    })
    : null;

  return deepFreeze({
    schemaVersion: "crypto-pump-reversal-clean-signal-v1",
    decision: ready ? "PAPER_RESEARCH_SIGNAL" : "NO_TRADE",
    eligibleForProspectiveResearchSample: ready,
    canonicalProfitAdmissionEligible: false,
    profitabilityProven: false,
    profitabilityClaimAllowed: false,
    strategyId: CRYPTO_PUMP_REVERSAL_SHORT_CLEAN_V1,
    strategyFamily: CRYPTO_PUMP_REVERSAL_FAMILY,
    strategyVersion: CRYPTO_PUMP_REVERSAL_VERSION,
    parameterHash: CRYPTO_PUMP_REVERSAL_CLEAN_V1_PARAMETER_HASH,
    market: "CRYPTO_FUTURES",
    direction: "SHORT",
    symbol: normalizedSymbol,
    signalId,
    sourceBarTimestampMs,
    signalConfirmedAtMs,
    nextBarOpenTimestampMs: signalConfirmedAtMs,
    pump24hPercent,
    currentHourVolumePercentile,
    btc30dReturnPercent: regime.btc30dReturnPercent,
    btc7dReturnPercent: regime.btc7dReturnPercent,
    blockers: uniqueBlockers,
    executionAuthority: "NONE",
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
  });
}

export function openPumpProspectiveResearchPosition({
  signal,
  nextHourCandle,
} = {}) {
  if (!signal || signal.schemaVersion !== "crypto-pump-reversal-clean-signal-v1"
    || signal.eligibleForProspectiveResearchSample !== true
    || signal.canonicalProfitAdmissionEligible !== false
    || signal.direction !== "SHORT") {
    throw new Error("PUMP_RESEARCH_SIGNAL_REQUIRED");
  }
  const entryTimestampMs = Number(nextHourCandle?.timestampMs ?? nextHourCandle?.timestamp);
  const entryPrice = Number(nextHourCandle?.open);
  if (!positive(entryTimestampMs) || !positive(entryPrice)) throw new Error("PUMP_NEXT_BAR_OPEN_REQUIRED");
  if (entryTimestampMs !== signal.nextBarOpenTimestampMs) throw new Error("PUMP_NEXT_BAR_TIMESTAMP_MISMATCH");
  if (entryTimestampMs === signal.sourceBarTimestampMs) throw new Error("PUMP_SAME_BAR_ENTRY_FORBIDDEN");

  const stopPrice = entryPrice * (1 + CRYPTO_PUMP_REVERSAL_CLEAN_V1_RULES.stopAdversePercent / 100);
  const timeExitAtMs = entryTimestampMs + CRYPTO_PUMP_REVERSAL_CLEAN_V1_RULES.timeExitHours * HOUR_MS;
  return deepFreeze({
    schemaVersion: "crypto-pump-reversal-prospective-position-v1",
    sampleClass: "PROSPECTIVE_RESEARCH_PAPER",
    canonicalProfitAdmissionEligible: false,
    profitabilityProven: false,
    profitabilityClaimAllowed: false,
    strategyId: signal.strategyId,
    strategyVersion: signal.strategyVersion,
    parameterHash: signal.parameterHash,
    signalId: signal.signalId,
    market: "CRYPTO_FUTURES",
    symbol: signal.symbol,
    direction: "SHORT",
    entryTimestampMs,
    entryPrice,
    stopPrice,
    timeExitAtMs,
    stopMonitoringTimeframe: "1m",
    status: "OPEN",
    executionAuthority: "NONE",
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
  });
}

export function detectPumpProspectiveExit({
  position,
  minuteCandles,
  observedAtMs,
} = {}) {
  if (!position || position.schemaVersion !== "crypto-pump-reversal-prospective-position-v1"
    || position.status !== "OPEN") throw new Error("PUMP_OPEN_RESEARCH_POSITION_REQUIRED");
  if (!positive(observedAtMs) || observedAtMs < position.entryTimestampMs) throw new Error("PUMP_EXIT_OBSERVED_AT_INVALID");

  const minutes = normalizeCandles(minuteCandles, 60_000, observedAtMs, "PUMP_EXIT_1M")
    .filter((candle) => candle.timestampMs >= position.entryTimestampMs);

  for (const candle of minutes) {
    if (candle.timestampMs >= position.timeExitAtMs) {
      return deepFreeze({
        status: "EXIT_TRIGGERED",
        reason: "TIME_EXIT_72H",
        triggerTimestampMs: candle.timestampMs,
        referenceExitPrice: candle.open,
        settlementReady: false,
        settlementBlocker: "CANONICAL_FULL_COST_SETTLEMENT_REQUIRED",
        executionAuthority: "NONE",
        profitabilityClaimAllowed: false,
      });
    }
    if (candle.high >= position.stopPrice) {
      return deepFreeze({
        status: "EXIT_TRIGGERED",
        reason: "STOP_25_PERCENT",
        triggerTimestampMs: candle.timestampMs,
        // A gap above the stop must not be filled optimistically at the stop.
        referenceExitPrice: Math.max(position.stopPrice, candle.open),
        settlementReady: false,
        settlementBlocker: "CANONICAL_FULL_COST_SETTLEMENT_REQUIRED",
        executionAuthority: "NONE",
        profitabilityClaimAllowed: false,
      });
    }
  }

  return deepFreeze({
    status: "OPEN",
    reason: null,
    triggerTimestampMs: null,
    referenceExitPrice: null,
    settlementReady: false,
    settlementBlocker: "CANONICAL_FULL_COST_SETTLEMENT_REQUIRED",
    executionAuthority: "NONE",
    profitabilityClaimAllowed: false,
  });
}

export function pumpReversalCleanV1Contract() {
  return deepFreeze({
    schemaVersion: "crypto-pump-reversal-clean-contract-v1",
    strategyId: CRYPTO_PUMP_REVERSAL_SHORT_CLEAN_V1,
    strategyFamily: CRYPTO_PUMP_REVERSAL_FAMILY,
    strategyVersion: CRYPTO_PUMP_REVERSAL_VERSION,
    parameterHash: CRYPTO_PUMP_REVERSAL_CLEAN_V1_PARAMETER_HASH,
    rules: CRYPTO_PUMP_REVERSAL_CLEAN_V1_RULES,
    bootstrapPolicy: {
      prospectiveResearchSampleBeforeProfitAdmission: true,
      fabricatedExpectedEdgeAllowed: false,
      fabricatedSampleSizeAllowed: false,
      canonicalProfitAdmissionBeforeObservedCalibration: false,
      profitabilityProven: false,
      currentValidatedChampion: "NONE",
    },
    executionAuthority: "NONE",
    liveOrderAllowed: false,
    privateTradingApiAllowed: false,
  });
}
