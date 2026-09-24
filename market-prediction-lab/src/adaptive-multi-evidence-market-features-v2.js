import { sha256Canonical } from "./research-cache-provenance.js";
import { atr, ema, macd, rsi } from "./indicators.js";
import {
  ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
  buildAdaptiveMultiEvidencePointInTimeV2,
} from "./adaptive-multi-evidence-point-in-time-v2.js";
import {
  buildAdaptiveMultiEvidencePriceStructureV2,
  normalizeAdaptiveMultiEvidenceClosedCandlesV2,
} from "./adaptive-multi-evidence-price-structure-v2.js";

export const ADAPTIVE_MULTI_EVIDENCE_MARKET_FEATURES_V2_VERSION =
  "adaptive-multi-evidence-market-features-v2";

const DEFAULTS = Object.freeze({
  emaFastPeriod: 20,
  emaSlowPeriod: 50,
  slopeLookback: 5,
  adxPeriod: 14,
  atrPeriod: 14,
  donchianPeriod: 20,
  rocPeriod: 12,
  rsiPeriod: 14,
  macdFastPeriod: 12,
  macdSlowPeriod: 26,
  macdSignalPeriod: 9,
  momentumPersistenceLookback: 8,
  relativeStrengthLookback: 20,
  volumeLookback: 20,
  realizedVolatilityLookback: 20,
  rangeLookback: 10,
  abnormalZThreshold: 2,
  structurePersistenceSwings: 6,
});

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function rounded(value) {
  return Number.isFinite(value) ? Number(value.toFixed(10)) : null;
}

function mean(values) {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function standardDeviation(values) {
  const average = mean(values);
  if (average == null || values.length === 0) return null;
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

function positiveInteger(value, fallback, maximum) {
  const candidate = value ?? fallback;
  return Number.isInteger(candidate) && candidate > 0 && candidate <= maximum ? candidate : null;
}

function positiveNumber(value, fallback, maximum) {
  const candidate = value ?? fallback;
  return Number.isFinite(candidate) && candidate > 0 && candidate <= maximum ? candidate : null;
}

function normalizeOptions(raw, blockers) {
  const options = {
    emaFastPeriod: positiveInteger(raw?.emaFastPeriod, DEFAULTS.emaFastPeriod, 200),
    emaSlowPeriod: positiveInteger(raw?.emaSlowPeriod, DEFAULTS.emaSlowPeriod, 500),
    slopeLookback: positiveInteger(raw?.slopeLookback, DEFAULTS.slopeLookback, 100),
    adxPeriod: positiveInteger(raw?.adxPeriod, DEFAULTS.adxPeriod, 100),
    atrPeriod: positiveInteger(raw?.atrPeriod, DEFAULTS.atrPeriod, 100),
    donchianPeriod: positiveInteger(raw?.donchianPeriod, DEFAULTS.donchianPeriod, 500),
    rocPeriod: positiveInteger(raw?.rocPeriod, DEFAULTS.rocPeriod, 500),
    rsiPeriod: positiveInteger(raw?.rsiPeriod, DEFAULTS.rsiPeriod, 100),
    macdFastPeriod: positiveInteger(raw?.macdFastPeriod, DEFAULTS.macdFastPeriod, 200),
    macdSlowPeriod: positiveInteger(raw?.macdSlowPeriod, DEFAULTS.macdSlowPeriod, 500),
    macdSignalPeriod: positiveInteger(raw?.macdSignalPeriod, DEFAULTS.macdSignalPeriod, 100),
    momentumPersistenceLookback: positiveInteger(
      raw?.momentumPersistenceLookback,
      DEFAULTS.momentumPersistenceLookback,
      200,
    ),
    relativeStrengthLookback: positiveInteger(
      raw?.relativeStrengthLookback,
      DEFAULTS.relativeStrengthLookback,
      500,
    ),
    volumeLookback: positiveInteger(raw?.volumeLookback, DEFAULTS.volumeLookback, 500),
    realizedVolatilityLookback: positiveInteger(
      raw?.realizedVolatilityLookback,
      DEFAULTS.realizedVolatilityLookback,
      500,
    ),
    rangeLookback: positiveInteger(raw?.rangeLookback, DEFAULTS.rangeLookback, 500),
    abnormalZThreshold: positiveNumber(raw?.abnormalZThreshold, DEFAULTS.abnormalZThreshold, 10),
    structurePersistenceSwings: positiveInteger(
      raw?.structurePersistenceSwings,
      DEFAULTS.structurePersistenceSwings,
      100,
    ),
  };
  for (const [key, value] of Object.entries(options)) {
    if (value == null) blockers.push(`V2_MARKET_FEATURES_${key.replace(/[A-Z]/gu, (item) => `_${item}`).toUpperCase()}_INVALID`);
  }
  if (options.emaFastPeriod != null && options.emaSlowPeriod != null
      && options.emaFastPeriod >= options.emaSlowPeriod) {
    blockers.push("V2_MARKET_FEATURES_EMA_PERIOD_ORDER_INVALID");
  }
  if (options.macdFastPeriod != null && options.macdSlowPeriod != null
      && options.macdFastPeriod >= options.macdSlowPeriod) {
    blockers.push("V2_MARKET_FEATURES_MACD_PERIOD_ORDER_INVALID");
  }
  return options;
}

function failure(blockers, missingEvidence = [], excluded = {}) {
  return deepFreeze({
    schemaVersion: ADAPTIVE_MULTI_EVIDENCE_MARKET_FEATURES_V2_VERSION,
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    status: "BLOCKED_DATA",
    features: null,
    evidence: null,
    blockers: unique(blockers),
    missingEvidence: unique(missingEvidence),
    excluded: {
      futureOrUnavailable: excluded.futureOrUnavailable ?? 0,
      unclosed: excluded.unclosed ?? 0,
    },
    independenceStatus: "NOT_YET_PROVEN",
    independentVoteCredit: 0,
    economicSampleCredit: 0,
    executionAuthority: "NONE",
  });
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

function rateOfChange(values, period, index = values.length - 1) {
  if (index < period || values[index - period] === 0) return null;
  return (values[index] / values[index - period]) - 1;
}

function linearSlope(values) {
  if (values.length < 2) return null;
  const xMean = (values.length - 1) / 2;
  const yMean = mean(values);
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < values.length; index += 1) {
    numerator += (index - xMean) * (values[index] - yMean);
    denominator += (index - xMean) ** 2;
  }
  return denominator > 0 ? numerator / denominator : null;
}

function pearson(left, right) {
  if (left.length !== right.length || left.length < 2) return null;
  const leftMean = mean(left);
  const rightMean = mean(right);
  const leftDeviation = left.map((value) => value - leftMean);
  const rightDeviation = right.map((value) => value - rightMean);
  const denominator = Math.sqrt(
    leftDeviation.reduce((sum, value) => sum + value ** 2, 0)
    * rightDeviation.reduce((sum, value) => sum + value ** 2, 0),
  );
  if (denominator === 0) return null;
  return leftDeviation.reduce((sum, value, index) => sum + value * rightDeviation[index], 0) / denominator;
}

function zScore(value, baseline) {
  const deviation = standardDeviation(baseline);
  return deviation > 0 ? (value - mean(baseline)) / deviation : null;
}

function adxFeatures(candles, period) {
  const trueRange = [];
  const plusMovement = [];
  const minusMovement = [];
  for (let index = 1; index < candles.length; index += 1) {
    const current = candles[index];
    const previous = candles[index - 1];
    const upward = current.high - previous.high;
    const downward = previous.low - current.low;
    trueRange.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close),
    ));
    plusMovement.push(upward > downward && upward > 0 ? upward : 0);
    minusMovement.push(downward > upward && downward > 0 ? downward : 0);
  }

  let smoothedRange = trueRange.slice(0, period).reduce((sum, value) => sum + value, 0);
  let smoothedPlus = plusMovement.slice(0, period).reduce((sum, value) => sum + value, 0);
  let smoothedMinus = minusMovement.slice(0, period).reduce((sum, value) => sum + value, 0);
  const directional = [];
  for (let index = period - 1; index < trueRange.length; index += 1) {
    if (index >= period) {
      smoothedRange = smoothedRange - (smoothedRange / period) + trueRange[index];
      smoothedPlus = smoothedPlus - (smoothedPlus / period) + plusMovement[index];
      smoothedMinus = smoothedMinus - (smoothedMinus / period) + minusMovement[index];
    }
    const plusDi = smoothedRange > 0 ? 100 * smoothedPlus / smoothedRange : 0;
    const minusDi = smoothedRange > 0 ? 100 * smoothedMinus / smoothedRange : 0;
    const total = plusDi + minusDi;
    directional.push({
      plusDi,
      minusDi,
      dx: total > 0 ? 100 * Math.abs(plusDi - minusDi) / total : 0,
    });
  }

  if (directional.length < period) return null;
  let adx = mean(directional.slice(0, period).map((item) => item.dx));
  for (let index = period; index < directional.length; index += 1) {
    adx = ((adx * (period - 1)) + directional[index].dx) / period;
  }
  const latest = directional.at(-1);
  return {
    adx: rounded(adx),
    plusDi: rounded(latest.plusDi),
    minusDi: rounded(latest.minusDi),
    direction: latest.plusDi > latest.minusDi ? "UP" : latest.minusDi > latest.plusDi ? "DOWN" : "FLAT",
  };
}

function structurePersistence(pivots, limit) {
  const classified = pivots.filter((pivot) => pivot.classification !== "UNCLASSIFIED").slice(-limit);
  const bullish = classified.filter((pivot) => ["HH", "HL"].includes(pivot.classification)).length;
  const bearish = classified.filter((pivot) => ["LH", "LL"].includes(pivot.classification)).length;
  return {
    observedSwingCount: classified.length,
    bullishPersistenceRatio: classified.length > 0 ? rounded(bullish / classified.length) : null,
    bearishPersistenceRatio: classified.length > 0 ? rounded(bearish / classified.length) : null,
  };
}

function multiTimeframeFeatures(items, decisionTime, currentTrend, blockers, missingEvidence) {
  if (items == null || (Array.isArray(items) && items.length === 0)) {
    missingEvidence.push("higherTimeframeEvidence");
    return { status: "MISSING", alignment: null, timeframes: [] };
  }
  if (!Array.isArray(items)) {
    blockers.push("V2_MARKET_FEATURES_HIGHER_TIMEFRAME_EVIDENCE_ARRAY_REQUIRED");
    return { status: "INVALID", alignment: null, timeframes: [] };
  }
  const timeframes = [];
  for (const item of items) {
    const priceEvidence = item?.evidence?.priceStructure;
    if (item?.status !== "READY_FOR_SPECIALIST_RESEARCH_ONLY"
        || item?.lineageId !== ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID
        || priceEvidence?.status !== "ADMISSIBLE"
        || priceEvidence?.evidence?.identity?.temporal?.decisionTime !== decisionTime
        || item?.executionAuthority !== "NONE") {
      blockers.push("V2_MARKET_FEATURES_HIGHER_TIMEFRAME_EVIDENCE_NOT_ADMISSIBLE");
      continue;
    }
    timeframes.push({
      timeframe: priceEvidence.evidence.identity.timeframe,
      trend: item.features.priceStructure.trend,
      evidenceId: priceEvidence.evidenceId,
    });
  }
  const aligned = ["BULLISH", "BEARISH"].includes(currentTrend)
    && timeframes.length > 0
    && timeframes.every((item) => item.trend === currentTrend);
  return {
    status: blockers.length > 0 ? "INVALID" : "AVAILABLE",
    alignment: aligned ? `ALIGNED_${currentTrend}` : "MIXED_OR_UNALIGNED",
    timeframes,
  };
}

function benchmarkFeatures(input, decisionTime, options, blockers, missingEvidence) {
  if (input.benchmark == null) {
    missingEvidence.push("benchmark");
    return { result: null, candles: null, relativeStrengthRoc: null };
  }
  const result = buildAdaptiveMultiEvidencePriceStructureV2(input.benchmark);
  if (result.status !== "READY_FOR_SPECIALIST_RESEARCH_ONLY"
      || result.decisionTime !== decisionTime
      || input.benchmark.timeframe !== input.timeframe
      || result.executionAuthority !== "NONE") {
    blockers.push("V2_MARKET_FEATURES_BENCHMARK_EVIDENCE_NOT_ADMISSIBLE");
    return { result, candles: null, relativeStrengthRoc: null };
  }
  const localBlockers = [];
  const localMissing = [];
  const normalized = normalizeAdaptiveMultiEvidenceClosedCandlesV2(
    input.benchmark.candles,
    decisionTime,
    localBlockers,
    localMissing,
  );
  if (localBlockers.length > 0 || normalized.candles.length <= options.relativeStrengthLookback) {
    blockers.push(...localBlockers, "V2_MARKET_FEATURES_BENCHMARK_HISTORY_INSUFFICIENT");
    missingEvidence.push(...localMissing);
    return { result, candles: null, relativeStrengthRoc: null };
  }
  return { result, candles: normalized.candles, relativeStrengthRoc: null };
}

function evidenceInput(input, family, temporal, contentDigest, facts, inferences, uncertainty) {
  return {
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    family,
    market: input.market,
    symbol: input.symbol,
    timeframe: input.timeframe,
    side: input.side,
    sourceId: input.source?.sourceId,
    originalSourceId: input.source?.originalSourceId,
    sourceType: input.source?.sourceType,
    sourceUrl: input.source?.sourceUrl,
    documentId: input.source?.documentId,
    eventTime: temporal.eventTime,
    publishedAt: temporal.publishedAt,
    availableAt: temporal.availableAt,
    observedAt: temporal.observedAt,
    decisionTime: temporal.decisionTime,
    contentDigest,
    facts,
    inferences,
    uncertainty,
    synthetic: false,
    replay: false,
    backfill: false,
    manualEconomicCredit: false,
    liveTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: "NONE",
  };
}

function metricFacts(prefix, value) {
  return Object.entries(value).map(([key, item]) => {
    const rendered = item != null && typeof item === "object" ? JSON.stringify(item) : item ?? "UNKNOWN";
    return `${prefix}.${key}=${rendered}`;
  });
}

export function buildAdaptiveMultiEvidenceMarketFeaturesV2(input = {}) {
  const blockers = [];
  const missingEvidence = [];
  if (input.lineageId !== ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID) {
    blockers.push(input.lineageId ? "V1_OR_FOREIGN_LINEAGE_CONTAMINATION_FORBIDDEN" : "V2_LINEAGE_ID_REQUIRED");
  }
  const options = normalizeOptions(input.options, blockers);
  const structureResult = buildAdaptiveMultiEvidencePriceStructureV2({
    ...input,
    options: input.priceStructureOptions,
  });
  if (structureResult.status !== "READY_FOR_SPECIALIST_RESEARCH_ONLY") {
    blockers.push("V2_MARKET_FEATURES_PRICE_STRUCTURE_EVIDENCE_REQUIRED", ...structureResult.blockers);
    missingEvidence.push(...structureResult.missingEvidence);
  }
  if (blockers.length > 0) {
    return failure(blockers, missingEvidence, structureResult.excluded);
  }

  const decisionTime = structureResult.decisionTime;
  const normalizedBlockers = [];
  const normalizedMissing = [];
  const normalized = normalizeAdaptiveMultiEvidenceClosedCandlesV2(
    input.candles,
    decisionTime,
    normalizedBlockers,
    normalizedMissing,
  );
  blockers.push(...normalizedBlockers);
  missingEvidence.push(...normalizedMissing);
  const candles = normalized.candles;
  const minimumBars = Math.max(
    options.emaSlowPeriod + options.slopeLookback,
    options.adxPeriod * 2 + 1,
    options.atrPeriod + 1,
    options.donchianPeriod + 1,
    options.rocPeriod + 2,
    options.rsiPeriod + 1,
    options.macdSlowPeriod + options.macdSignalPeriod,
    options.momentumPersistenceLookback + 1,
    options.relativeStrengthLookback + 1,
    options.volumeLookback * 2 + 1,
    options.realizedVolatilityLookback + 1,
    options.rangeLookback * 2 + 1,
  );
  if (candles.length < minimumBars) {
    blockers.push("V2_MARKET_FEATURES_INSUFFICIENT_CLOSED_BARS");
    missingEvidence.push("minimumClosedCandleHistory");
  }

  const benchmark = benchmarkFeatures(input, decisionTime, options, blockers, missingEvidence);
  const currentStructure = structureResult.features.priceStructure.trend;
  const multiTimeframe = multiTimeframeFeatures(
    input.higherTimeframeEvidence,
    decisionTime,
    currentStructure,
    blockers,
    missingEvidence,
  );
  if (blockers.length > 0) return failure(blockers, missingEvidence, normalized.excluded);

  const closes = candles.map((candle) => candle.close);
  const volumes = candles.map((candle) => candle.volume);
  const ranges = trueRanges(candles);
  const latest = candles.at(-1);
  const latestClose = latest.close;
  const emaFast = ema(closes, options.emaFastPeriod);
  const emaSlow = ema(closes, options.emaSlowPeriod);
  const olderEmaFast = ema(closes.slice(0, -options.slopeLookback), options.emaFastPeriod);
  const olderEmaSlow = ema(closes.slice(0, -options.slopeLookback), options.emaSlowPeriod);
  const adx = adxFeatures(candles, options.adxPeriod);
  if (!adx) return failure(["V2_MARKET_FEATURES_ADX_UNAVAILABLE"], ["adxHistory"], normalized.excluded);
  const donchianWindow = candles.slice(-(options.donchianPeriod + 1), -1);
  const donchianUpper = Math.max(...donchianWindow.map((candle) => candle.high));
  const donchianLower = Math.min(...donchianWindow.map((candle) => candle.low));
  const persistence = structurePersistence(
    structureResult.features.pivots,
    options.structurePersistenceSwings,
  );
  const trend = {
    emaFast: rounded(emaFast),
    emaSlow: rounded(emaSlow),
    emaDirection: emaFast > emaSlow ? "UP" : emaFast < emaSlow ? "DOWN" : "FLAT",
    emaFastSlopePctPerBar: rounded((emaFast - olderEmaFast) / olderEmaFast / options.slopeLookback),
    emaSlowSlopePctPerBar: rounded((emaSlow - olderEmaSlow) / olderEmaSlow / options.slopeLookback),
    priceVsEmaFastPct: rounded((latestClose - emaFast) / emaFast),
    priceVsEmaSlowPct: rounded((latestClose - emaSlow) / emaSlow),
    adx: adx.adx,
    plusDi: adx.plusDi,
    minusDi: adx.minusDi,
    adxDirection: adx.direction,
    donchianUpper: rounded(donchianUpper),
    donchianLower: rounded(donchianLower),
    donchianPosition: donchianUpper > donchianLower
      ? rounded((latestClose - donchianLower) / (donchianUpper - donchianLower))
      : null,
    structureTrend: currentStructure,
    ...persistence,
    multiTimeframeStatus: multiTimeframe.status,
    multiTimeframeAlignment: multiTimeframe.alignment,
    higherTimeframes: multiTimeframe.timeframes,
  };

  const macdValue = macd(
    closes,
    options.macdFastPeriod,
    options.macdSlowPeriod,
    options.macdSignalPeriod,
  );
  const oneBarReturns = closes.slice(-options.momentumPersistenceLookback - 1).slice(1)
    .map((close, index) => (close / closes.slice(-options.momentumPersistenceLookback - 1)[index]) - 1);
  const positiveReturns = oneBarReturns.filter((value) => value > 0).length;
  const assetRelativeRoc = rateOfChange(closes, options.relativeStrengthLookback);
  const benchmarkRelativeRoc = benchmark.candles
    ? rateOfChange(benchmark.candles.map((candle) => candle.close), options.relativeStrengthLookback)
    : null;
  const momentum = {
    roc: rounded(rateOfChange(closes, options.rocPeriod)),
    rsi: rounded(rsi(closes, options.rsiPeriod)),
    macd: rounded(macdValue.macd),
    macdSignal: rounded(macdValue.signal),
    macdHistogramPct: rounded(macdValue.histogram / latestClose),
    positiveReturnRatio: rounded(positiveReturns / oneBarReturns.length),
    negativeReturnRatio: rounded(oneBarReturns.filter((value) => value < 0).length / oneBarReturns.length),
    momentumAcceleration: rounded(
      rateOfChange(closes, options.rocPeriod)
      - rateOfChange(closes, options.rocPeriod, closes.length - 2),
    ),
    relativeStrengthRoc: benchmarkRelativeRoc == null
      ? null
      : rounded(assetRelativeRoc - benchmarkRelativeRoc),
    benchmarkEvidenceId: benchmark.result?.evidence?.priceStructure?.evidenceId ?? null,
  };

  const priorVolumes = volumes.slice(-(options.volumeLookback + 1), -1);
  const earlierVolumes = volumes.slice(-(options.volumeLookback * 2 + 1), -(options.volumeLookback + 1));
  const volumeChanges = [];
  const priceReturns = [];
  const participationCandles = candles.slice(-options.volumeLookback - 1);
  for (let index = 1; index < participationCandles.length; index += 1) {
    const previous = participationCandles[index - 1];
    const current = participationCandles[index];
    priceReturns.push((current.close / previous.close) - 1);
    volumeChanges.push(previous.volume === 0 ? 0 : (current.volume / previous.volume) - 1);
  }
  const relativeVolume = mean(priorVolumes) > 0 ? latest.volume / mean(priorVolumes) : null;
  const signedVolumeTotal = participationCandles.slice(1).reduce((sum, candle, index) => {
    const prior = participationCandles[index];
    return sum + Math.sign(candle.close - prior.close) * candle.volume;
  }, 0);
  const participatingVolume = participationCandles.slice(1)
    .reduce((sum, candle) => sum + candle.volume, 0);
  const signedVolumeBalance = participatingVolume > 0 ? signedVolumeTotal / participatingVolume : null;
  const currentRoc = rateOfChange(closes, options.rocPeriod);
  const pattern = structureResult.features.pattern;
  const volumeZ = zScore(latest.volume, priorVolumes);
  const volume = {
    relativeVolume: rounded(relativeVolume),
    baselineStatus: mean(priorVolumes) > 0 ? "AVAILABLE" : "ZERO_BASELINE",
    recentToPriorVolumeRatio: mean(earlierVolumes) > 0 ? rounded(mean(priorVolumes) / mean(earlierVolumes)) : null,
    participationState: relativeVolume == null ? "UNKNOWN"
      : relativeVolume > 1 ? "EXPANSION" : relativeVolume < 1 ? "CONTRACTION" : "NEUTRAL",
    breakoutDirection: pattern.breakoutDirection,
    breakoutParticipation: pattern.breakoutDirection == null || relativeVolume == null
      ? null
      : relativeVolume >= 1,
    priceVolumeCorrelation: rounded(pearson(priceReturns, volumeChanges)),
    signedVolumeBalance: rounded(signedVolumeBalance),
    priceVolumeDisagreement: signedVolumeBalance == null
      ? null
      : currentRoc === 0 || signedVolumeBalance === 0 ? false
      : Math.sign(currentRoc) !== Math.sign(signedVolumeBalance),
    abnormalVolumeZScore: rounded(volumeZ),
    abnormalVolume: volumeZ == null ? null : Math.abs(volumeZ) >= options.abnormalZThreshold,
  };

  const logReturns = [];
  for (let index = closes.length - options.realizedVolatilityLookback; index < closes.length; index += 1) {
    logReturns.push(Math.log(closes[index] / closes[index - 1]));
  }
  const recentRanges = ranges.slice(-options.rangeLookback);
  const priorRanges = ranges.slice(-options.rangeLookback * 2, -options.rangeLookback);
  const gaps = candles.slice(-options.realizedVolatilityLookback).map((candle, index, recent) => {
    const absoluteIndex = candles.length - recent.length + index;
    const previous = candles[absoluteIndex - 1];
    return previous ? (candle.open - previous.close) / previous.close : 0;
  });
  const latestRangeZ = zScore(ranges.at(-1), ranges.slice(-(options.rangeLookback + 1), -1));
  const atrValue = atr(candles, options.atrPeriod);
  const volatility = {
    atr: rounded(atrValue),
    atrPct: rounded(atrValue / latestClose),
    realizedVolatility: rounded(standardDeviation(logReturns)),
    realizedVolatilityConvention: "UNANNUALIZED_LOG_RETURN_STDDEV",
    recentToPriorRangeRatio: mean(priorRanges) > 0 ? rounded(mean(recentRanges) / mean(priorRanges)) : null,
    rangeState: mean(priorRanges) === 0 ? "UNKNOWN"
      : mean(recentRanges) > mean(priorRanges) ? "EXPANSION" : "COMPRESSION",
    latestGapPct: rounded(gaps.at(-1)),
    maximumAbsoluteGapPct: rounded(Math.max(...gaps.map(Math.abs))),
    abnormalRangeZScore: rounded(latestRangeZ),
    abnormalVolatility: latestRangeZ == null ? null : Math.abs(latestRangeZ) >= options.abnormalZThreshold,
    stopPolicy: "NO_AUTOMATIC_TIGHTER_STOP",
  };
  const priceAction = {
    structureTrend: structureResult.features.priceStructure.trend,
    latestHighClassification: structureResult.features.priceStructure.latestHighClassification,
    latestLowClassification: structureResult.features.priceStructure.latestLowClassification,
    structureEvent: structureResult.features.priceStructure.structureEvent,
    structureEventDirection: structureResult.features.priceStructure.structureEventDirection,
    structureTransition: structureResult.features.priceStructure.structureTransition ?? "NONE",
    candlestickPatterns: [...(structureResult.features.candle.namedPatterns ?? [])],
    latestSwingLegDirection: structureResult.features.pattern.latestSwingLegDirection ?? null,
    latestSwingLegAtr: structureResult.features.pattern.latestSwingLegAtr ?? null,
    priorSwingLegAtr: structureResult.features.pattern.priorSwingLegAtr ?? null,
    swingRetracementRatio: structureResult.features.pattern.swingRetracementRatio ?? null,
    swingSequence: [...(structureResult.features.pattern.swingSequence ?? [])],
    breakoutDirection: structureResult.features.pattern.breakoutDirection ?? null,
    breakoutDistanceAtr: structureResult.features.pattern.breakoutDistanceAtr ?? null,
    retestHold: structureResult.features.pattern.retestHold ?? null,
    priceStructureEvidenceId: structureResult.evidence.priceStructure.evidenceId,
    candleEvidenceId: structureResult.evidence.candle.evidenceId,
    patternEvidenceId: structureResult.evidence.pattern.evidenceId,
    authority: "CONTEXT_ONLY_NO_INDEPENDENT_VOTE",
  };

  const contentDigest = sha256Canonical({
    sourceContentDigest: structureResult.contentDigest,
    benchmarkEvidenceId: momentum.benchmarkEvidenceId,
    higherTimeframeEvidenceIds: multiTimeframe.timeframes.map((item) => item.evidenceId),
    options,
  });
  const temporal = structureResult.evidence.priceStructure.evidence.identity.temporal;
  const sharedUncertainty = [
    "All four families are derived from correlated market-tape inputs and are not independent votes.",
    "No probability, expected value, confidence, sizing, stop, or execution authority is produced.",
  ];
  const evidence = {
    trend: buildAdaptiveMultiEvidencePointInTimeV2(evidenceInput(
      input,
      "TREND",
      temporal,
      contentDigest,
      metricFacts("trend", trend),
      [`trendDirection=${trend.emaDirection}`, `multiTimeframe=${trend.multiTimeframeAlignment ?? "UNKNOWN"}`],
      [...sharedUncertainty, "EMA, ADX, Donchian, structure, MACD, ROC, and RSI may be correlated."],
    )),
    momentum: buildAdaptiveMultiEvidencePointInTimeV2(evidenceInput(
      input,
      "MOMENTUM",
      temporal,
      contentDigest,
      metricFacts("momentum", momentum),
      [`momentumRoc=${momentum.roc}`, `momentumAcceleration=${momentum.momentumAcceleration}`],
      [...sharedUncertainty, "Momentum cannot override risk, cost, liquidity, event, identity, freshness, or regime gates."],
    )),
    volume: buildAdaptiveMultiEvidencePointInTimeV2(evidenceInput(
      input,
      "VOLUME",
      temporal,
      contentDigest,
      metricFacts("volume", volume),
      [`participationState=${volume.participationState}`, `breakoutParticipation=${volume.breakoutParticipation ?? "UNKNOWN"}`],
      [...sharedUncertainty, "Volume is participation evidence only; unavailable provider volume is never fabricated."],
    )),
    volatility: buildAdaptiveMultiEvidencePointInTimeV2(evidenceInput(
      input,
      "VOLATILITY",
      temporal,
      contentDigest,
      metricFacts("volatility", volatility),
      [`rangeState=${volatility.rangeState}`, `abnormalVolatility=${volatility.abnormalVolatility ?? "UNKNOWN"}`],
      [...sharedUncertainty, "High volatility does not imply a tighter stop; any sizing decision remains downstream."],
    )),
  };
  const evidenceBlockers = Object.values(evidence).flatMap((item) => item.blockers ?? []);
  if (evidenceBlockers.length > 0) return failure(evidenceBlockers, missingEvidence, normalized.excluded);

  const correlationGroup = `SHARED_MARKET_TAPE:${input.market}:${String(input.symbol).toUpperCase()}:${input.timeframe}`;
  return deepFreeze({
    schemaVersion: ADAPTIVE_MULTI_EVIDENCE_MARKET_FEATURES_V2_VERSION,
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    status: missingEvidence.length > 0
      ? "PARTIAL_FOR_SPECIALIST_RESEARCH_ONLY"
      : "READY_FOR_SPECIALIST_RESEARCH_ONLY",
    qualityStatus: missingEvidence.length > 0 ? "MISSING_OPTIONAL_CONTEXT" : "COMPLETE_INPUT_CONTEXT",
    decisionTime,
    contentDigest,
    acceptedClosedCandleCount: candles.length,
    excluded: normalized.excluded,
    missingEvidence: unique(missingEvidence),
    features: { trend, momentum, volume, volatility, priceAction },
    evidence,
    correlationGroups: {
      trend: correlationGroup,
      momentum: correlationGroup,
      volume: correlationGroup,
      volatility: correlationGroup,
      priceAction: correlationGroup,
    },
    independenceStatus: "NOT_YET_PROVEN",
    independentVoteCredit: 0,
    decisionAuthority: "EVIDENCE_ONLY",
    momentumOverrideAuthority: "NONE",
    volatilitySizingAuthority: "NONE",
    priceActionAuthority: "CONTEXT_ONLY_NO_INDEPENDENT_VOTE",
    economicSampleCredit: 0,
    v1EconomicIdentityMutable: false,
    frozenV1Contamination: 0,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: "NONE",
  });
}
