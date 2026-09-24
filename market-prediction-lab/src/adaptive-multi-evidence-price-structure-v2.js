import { sha256Canonical } from "./research-cache-provenance.js";
import {
  ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
  buildAdaptiveMultiEvidencePointInTimeV2,
} from "./adaptive-multi-evidence-point-in-time-v2.js";

export const ADAPTIVE_MULTI_EVIDENCE_PRICE_STRUCTURE_V2_VERSION =
  "adaptive-multi-evidence-price-structure-v2";

const DEFAULTS = Object.freeze({
  atrPeriod: 14,
  volumeLookback: 20,
  pivotLeftBars: 2,
  pivotRightBars: 2,
  equalityTolerance: 0.0015,
  retestToleranceAtr: 0.25,
  compressionLookback: 5,
});

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function failure(blockers, missingEvidence = [], excluded = {}) {
  return deepFreeze({
    schemaVersion: ADAPTIVE_MULTI_EVIDENCE_PRICE_STRUCTURE_V2_VERSION,
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    status: "BLOCKED_DATA",
    features: null,
    evidence: null,
    blockers: unique(blockers),
    missingEvidence: unique(missingEvidence),
    excluded: { futureOrUnavailable: excluded.futureOrUnavailable ?? 0, unclosed: excluded.unclosed ?? 0 },
    independenceStatus: "NOT_YET_PROVEN",
    independentVoteCredit: 0,
    economicSampleCredit: 0,
    executionAuthority: "NONE",
  });
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function iso(value) {
  const parsed = typeof value === "number" ? value : Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? new Date(parsed).toISOString() : null;
}

function finite(value) {
  if (value == null || typeof value === "boolean"
      || (typeof value === "string" && value.trim() === "")) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveInteger(value, fallback, maximum) {
  const candidate = value ?? fallback;
  return Number.isInteger(candidate) && candidate > 0 && candidate <= maximum ? candidate : null;
}

function nonNegative(value, fallback, maximum) {
  const candidate = value ?? fallback;
  return Number.isFinite(candidate) && candidate >= 0 && candidate <= maximum ? candidate : null;
}

function rounded(value) {
  return Number.isFinite(value) ? Number(value.toFixed(10)) : null;
}

function constantCase(value) {
  return value.replace(/[A-Z]/gu, (character) => `_${character}`).toUpperCase();
}

function mean(values) {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function normalizeOptions(raw, blockers) {
  const options = {
    atrPeriod: positiveInteger(raw?.atrPeriod, DEFAULTS.atrPeriod, 100),
    volumeLookback: positiveInteger(raw?.volumeLookback, DEFAULTS.volumeLookback, 500),
    pivotLeftBars: positiveInteger(raw?.pivotLeftBars, DEFAULTS.pivotLeftBars, 20),
    pivotRightBars: positiveInteger(raw?.pivotRightBars, DEFAULTS.pivotRightBars, 20),
    equalityTolerance: nonNegative(raw?.equalityTolerance, DEFAULTS.equalityTolerance, 0.1),
    retestToleranceAtr: nonNegative(raw?.retestToleranceAtr, DEFAULTS.retestToleranceAtr, 3),
    compressionLookback: positiveInteger(raw?.compressionLookback, DEFAULTS.compressionLookback, 100),
  };
  for (const [key, value] of Object.entries(options)) {
    if (value == null) blockers.push(`V2_PRICE_STRUCTURE_${key.toUpperCase()}_INVALID`);
  }
  return options;
}

export function normalizeAdaptiveMultiEvidenceClosedCandlesV2(
  rawCandles,
  decisionTime,
  blockers = [],
  missingEvidence = [],
) {
  if (!Array.isArray(rawCandles)) {
    blockers.push("V2_PRICE_STRUCTURE_CANDLES_ARRAY_REQUIRED");
    missingEvidence.push("candles");
    return { candles: [], excluded: { futureOrUnavailable: 0, unclosed: 0 } };
  }
  const accepted = [];
  const excluded = { futureOrUnavailable: 0, unclosed: 0 };
  const decisionMs = Date.parse(decisionTime);

  rawCandles.forEach((raw, index) => {
    if (raw?.isClosed !== true) {
      excluded.unclosed += 1;
      return;
    }
    const temporal = {
      eventTime: iso(raw.eventTime),
      publishedAt: iso(raw.publishedAt),
      availableAt: iso(raw.availableAt),
      observedAt: iso(raw.observedAt),
    };
    const knownTimes = Object.values(temporal).filter(Boolean).map((value) => Date.parse(value));
    if (knownTimes.some((value) => value > decisionMs)) {
      excluded.futureOrUnavailable += 1;
      return;
    }
    const missing = Object.entries(temporal).filter(([, value]) => !value).map(([key]) => key);
    if (missing.length > 0) {
      blockers.push(...missing.map((key) => `V2_PRICE_STRUCTURE_CANDLE_${constantCase(key)}_REQUIRED`));
      missingEvidence.push(...missing.map((key) => `candles[${index}].${key}`));
      return;
    }
    const times = Object.fromEntries(Object.entries(temporal).map(([key, value]) => [key, Date.parse(value)]));
    if (times.eventTime > times.publishedAt) blockers.push("V2_PRICE_STRUCTURE_EVENT_AFTER_PUBLICATION");
    if (times.publishedAt > times.availableAt) blockers.push("V2_PRICE_STRUCTURE_PUBLICATION_AFTER_AVAILABILITY");
    if (times.availableAt > times.observedAt) blockers.push("V2_PRICE_STRUCTURE_AVAILABILITY_AFTER_OBSERVATION");

    const candle = {
      ...temporal,
      open: finite(raw.open),
      high: finite(raw.high),
      low: finite(raw.low),
      close: finite(raw.close),
      volume: finite(raw.volume),
    };
    const prices = [candle.open, candle.high, candle.low, candle.close];
    if (prices.some((value) => value == null || value <= 0)) {
      blockers.push("V2_PRICE_STRUCTURE_CANDLE_PRICE_INVALID");
      return;
    }
    if (candle.volume == null || candle.volume < 0) {
      blockers.push("V2_PRICE_STRUCTURE_CANDLE_VOLUME_INVALID");
      return;
    }
    if (candle.high < Math.max(candle.open, candle.close)
        || candle.low > Math.min(candle.open, candle.close)
        || candle.high < candle.low) {
      blockers.push("V2_PRICE_STRUCTURE_CANDLE_OHLC_RELATIONSHIP_INVALID");
      return;
    }
    accepted.push(candle);
  });

  accepted.sort((left, right) => Date.parse(left.eventTime) - Date.parse(right.eventTime));
  const timestamps = new Set();
  for (const candle of accepted) {
    if (timestamps.has(candle.eventTime)) blockers.push("V2_PRICE_STRUCTURE_DUPLICATE_CANDLE_TIME");
    timestamps.add(candle.eventTime);
  }
  return { candles: accepted, excluded };
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

function atrAt(ranges, index, period) {
  if (index + 1 < period) return null;
  return mean(ranges.slice(index - period + 1, index + 1));
}

function relativeDifference(left, right) {
  return Math.abs(left - right) / Math.max(Math.abs(left), Math.abs(right), Number.EPSILON);
}

function detectConfirmedPivots(candles, options) {
  const pivots = [];
  let previousHigh = null;
  let previousLow = null;
  const { pivotLeftBars: left, pivotRightBars: right, equalityTolerance } = options;

  for (let index = left; index < candles.length - right; index += 1) {
    const candidate = candles[index];
    const leftWindow = candles.slice(index - left, index);
    const rightWindow = candles.slice(index + 1, index + right + 1);
    const high = leftWindow.every((item) => item.high < candidate.high)
      && rightWindow.every((item) => item.high <= candidate.high);
    const low = leftWindow.every((item) => item.low > candidate.low)
      && rightWindow.every((item) => item.low >= candidate.low);

    if (high) {
      const classification = previousHigh == null
        ? "UNCLASSIFIED"
        : relativeDifference(candidate.high, previousHigh.price) <= equalityTolerance
          ? "EH"
          : candidate.high > previousHigh.price ? "HH" : "LH";
      previousHigh = {
        kind: "HIGH",
        index,
        eventTime: candidate.eventTime,
        price: candidate.high,
        confirmedIndex: index + right,
        confirmedAt: candles[index + right].eventTime,
        classification,
      };
      pivots.push(previousHigh);
    }
    if (low) {
      const classification = previousLow == null
        ? "UNCLASSIFIED"
        : relativeDifference(candidate.low, previousLow.price) <= equalityTolerance
          ? "EL"
          : candidate.low > previousLow.price ? "HL" : "LL";
      previousLow = {
        kind: "LOW",
        index,
        eventTime: candidate.eventTime,
        price: candidate.low,
        confirmedIndex: index + right,
        confirmedAt: candles[index + right].eventTime,
        classification,
      };
      pivots.push(previousLow);
    }
  }
  return pivots.sort((leftPivot, rightPivot) => leftPivot.index - rightPivot.index
    || leftPivot.kind.localeCompare(rightPivot.kind));
}

function marketStructure(pivots) {
  const latestHigh = [...pivots].reverse().find((pivot) => pivot.kind === "HIGH") ?? null;
  const latestLow = [...pivots].reverse().find((pivot) => pivot.kind === "LOW") ?? null;
  if (!latestHigh || !latestLow) return { trend: "INSUFFICIENT", latestHigh, latestLow };
  const bullishHigh = ["HH", "EH"].includes(latestHigh.classification);
  const bullishLow = ["HL", "EL"].includes(latestLow.classification);
  const bearishHigh = ["LH", "EH"].includes(latestHigh.classification);
  const bearishLow = ["LL", "EL"].includes(latestLow.classification);
  const trend = bullishHigh && bullishLow ? "BULLISH"
    : bearishHigh && bearishLow ? "BEARISH" : "MIXED";
  return { trend, latestHigh, latestLow };
}

function latestLevelBefore(pivots, kind, index) {
  return [...pivots].reverse().find((pivot) => pivot.kind === kind && pivot.confirmedIndex < index) ?? null;
}

function classifyStructureTransition(direction, priorTrend) {
  if (direction === "UP") {
    if (priorTrend === "BULLISH") return "BOS_UP";
    if (priorTrend === "BEARISH") return "CHOCH_UP";
    return "BREAK_UP";
  }
  if (direction === "DOWN") {
    if (priorTrend === "BEARISH") return "BOS_DOWN";
    if (priorTrend === "BULLISH") return "CHOCH_DOWN";
    return "BREAK_DOWN";
  }
  return "NONE";
}

function breakoutLifecycle(candles, pivots, ranges, options) {
  let active = null;
  for (let index = 1; index < candles.length; index += 1) {
    const candle = candles[index];
    const previous = candles[index - 1];
    const atr = atrAt(ranges, index, options.atrPeriod);
    if (!atr || atr <= 0) continue;

    if (active?.status === "BREAKOUT_UNRETESTED" && index > active.breakoutIndex) {
      const tolerance = options.retestToleranceAtr * atr;
      const touched = active.direction === "UP"
        ? candle.low <= active.level + tolerance
        : candle.high >= active.level - tolerance;
      const failed = active.direction === "UP"
        ? candle.close < active.level - tolerance
        : candle.close > active.level + tolerance;
      if (failed) {
        active = {
          ...active,
          status: "FAILED_BREAKOUT",
          resolvedIndex: index,
          retestDepthAtr: rounded(Math.abs(candle.close - active.level) / atr),
          retestHold: false,
          failedBreakoutDistanceAtr: rounded(Math.abs(candle.close - active.level) / atr),
        };
      } else if (touched) {
        active = {
          ...active,
          status: "RETEST_HELD",
          resolvedIndex: index,
          retestDepthAtr: rounded(Math.abs((active.direction === "UP" ? candle.low : candle.high) - active.level) / atr),
          retestHold: true,
          failedBreakoutDistanceAtr: null,
        };
      }
    }

    const resistance = latestLevelBefore(pivots, "HIGH", index);
    const support = latestLevelBefore(pivots, "LOW", index);
    const upBreak = resistance && previous.close <= resistance.price && candle.close > resistance.price;
    const downBreak = support && previous.close >= support.price && candle.close < support.price;
    if (upBreak || downBreak) {
      const direction = upBreak ? "UP" : "DOWN";
      const level = upBreak ? resistance.price : support.price;
      const priorStructure = marketStructure(
        pivots.filter((pivot) => pivot.confirmedIndex < index),
      );
      active = {
        status: "BREAKOUT_UNRETESTED",
        direction,
        priorStructureTrend: priorStructure.trend,
        structureTransition: classifyStructureTransition(direction, priorStructure.trend),
        level: rounded(level),
        levelPivotTime: upBreak ? resistance.eventTime : support.eventTime,
        breakoutIndex: index,
        breakoutTime: candle.eventTime,
        breakoutDistanceAtr: rounded(Math.abs(candle.close - level) / atr),
        resolvedIndex: null,
        retestDepthAtr: null,
        retestHold: null,
        failedBreakoutDistanceAtr: null,
      };
    }
  }
  if (!active) return null;
  return { ...active, barsSinceBreakout: candles.length - 1 - active.breakoutIndex };
}

function slope(pivots, kind, atr) {
  const matching = pivots.filter((pivot) => pivot.kind === kind).slice(-2);
  if (matching.length < 2 || !atr || atr <= 0) return null;
  const [left, right] = matching;
  return rounded((right.price - left.price) / Math.max(1, right.index - left.index) / atr);
}

function ratioOfWindows(values, lookback) {
  if (values.length < lookback * 2) return null;
  const recent = mean(values.slice(-lookback));
  const prior = mean(values.slice(-lookback * 2, -lookback));
  return prior > 0 ? rounded(recent / prior) : null;
}

function candlePatternLabels(candles) {
  const latest = candles.at(-1);
  const previous = candles.at(-2);
  if (!latest) return [];
  const labels = [];
  const range = latest.high - latest.low;
  const body = Math.abs(latest.close - latest.open);
  const upperWick = latest.high - Math.max(latest.open, latest.close);
  const lowerWick = Math.min(latest.open, latest.close) - latest.low;
  const bullish = latest.close > latest.open;
  const bearish = latest.close < latest.open;

  if (previous) {
    const previousBullish = previous.close > previous.open;
    const previousBearish = previous.close < previous.open;
    const bullishEngulfing = bullish && previousBearish
      && latest.open <= previous.close && latest.close >= previous.open;
    const bearishEngulfing = bearish && previousBullish
      && latest.open >= previous.close && latest.close <= previous.open;
    if (bullishEngulfing) labels.push("BULLISH_ENGULFING");
    if (bearishEngulfing) labels.push("BEARISH_ENGULFING");
    if (latest.high < previous.high && latest.low > previous.low) labels.push("INSIDE_BAR");
  }

  if (range > 0 && body / range <= 0.35) {
    if (lowerWick >= Math.max(body * 2, upperWick * 1.5)) labels.push("BULLISH_PIN_BAR");
    if (upperWick >= Math.max(body * 2, lowerWick * 1.5)) labels.push("BEARISH_PIN_BAR");
  }
  return labels.sort();
}

function waveFeatures(pivots, atr) {
  const ordered = pivots
    .filter((pivot) => pivot.classification !== "UNCLASSIFIED")
    .slice(-4);
  const legs = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const left = ordered[index - 1];
    const right = ordered[index];
    if (left.kind === right.kind) continue;
    legs.push({
      from: left.classification,
      to: right.classification,
      direction: right.price > left.price ? "UP" : right.price < left.price ? "DOWN" : "FLAT",
      amplitudeAtr: atr > 0 ? rounded(Math.abs(right.price - left.price) / atr) : null,
      bars: Math.max(1, right.index - left.index),
    });
  }
  const latestLeg = legs.at(-1) ?? null;
  const priorLeg = legs.at(-2) ?? null;
  return {
    swingSequence: ordered.map((pivot) => pivot.classification),
    latestSwingLegDirection: latestLeg?.direction ?? null,
    latestSwingLegAtr: latestLeg?.amplitudeAtr ?? null,
    priorSwingLegAtr: priorLeg?.amplitudeAtr ?? null,
    swingRetracementRatio: latestLeg?.amplitudeAtr != null
      && priorLeg?.amplitudeAtr != null
      && priorLeg.amplitudeAtr > 0
      ? rounded(latestLeg.amplitudeAtr / priorLeg.amplitudeAtr)
      : null,
  };
}

function candleFeatures(candles, atr, support, resistance, options) {
  const latest = candles.at(-1);
  const previous = candles.at(-2);
  const range = latest.high - latest.low;
  const body = Math.abs(latest.close - latest.open);
  const upperWick = latest.high - Math.max(latest.open, latest.close);
  const lowerWick = Math.min(latest.open, latest.close) - latest.low;
  const volumeBaseline = mean(candles.slice(-(options.volumeLookback + 1), -1).map((item) => item.volume));
  return {
    namedPatterns: candlePatternLabels(candles),
    eventTime: latest.eventTime,
    direction: latest.close > latest.open ? "UP" : latest.close < latest.open ? "DOWN" : "FLAT",
    bodySize: rounded(body),
    range: rounded(range),
    bodyRangeRatio: range > 0 ? rounded(body / range) : null,
    upperWickRatio: range > 0 ? rounded(upperWick / range) : null,
    lowerWickRatio: range > 0 ? rounded(lowerWick / range) : null,
    closeLocation: range > 0 ? rounded((latest.close - latest.low) / range) : null,
    gapPct: previous ? rounded((latest.open - previous.close) / previous.close) : null,
    rangeAtrRatio: atr > 0 ? rounded(range / atr) : null,
    relativeVolume: volumeBaseline > 0 ? rounded(latest.volume / volumeBaseline) : null,
    supportDistanceAtr: support && atr > 0 ? rounded((latest.close - support.price) / atr) : null,
    resistanceDistanceAtr: resistance && atr > 0 ? rounded((resistance.price - latest.close) / atr) : null,
  };
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
    ...temporal,
    decisionTime: input.decisionTime,
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
  return Object.entries(value).map(([key, item]) => `${prefix}.${key}=${item ?? "UNKNOWN"}`);
}

export function buildAdaptiveMultiEvidencePriceStructureV2(input = {}) {
  const blockers = [];
  const missingEvidence = [];
  if (input.lineageId !== ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID) {
    blockers.push(input.lineageId ? "V1_OR_FOREIGN_LINEAGE_CONTAMINATION_FORBIDDEN" : "V2_LINEAGE_ID_REQUIRED");
  }
  const decisionTime = iso(input.decisionTime);
  if (!decisionTime) {
    blockers.push("V2_PRICE_STRUCTURE_DECISION_TIME_REQUIRED");
    missingEvidence.push("decisionTime");
  }
  const options = normalizeOptions(input.options, blockers);
  if (!decisionTime) return failure(blockers, missingEvidence);

  const normalized = normalizeAdaptiveMultiEvidenceClosedCandlesV2(
    input.candles,
    decisionTime,
    blockers,
    missingEvidence,
  );
  const candles = normalized.candles;
  const minimumBars = options.atrPeriod == null || options.volumeLookback == null
    || options.pivotLeftBars == null || options.pivotRightBars == null
    || options.compressionLookback == null
    ? Number.POSITIVE_INFINITY
    : Math.max(
      options.atrPeriod,
      options.volumeLookback + 1,
      options.pivotLeftBars + options.pivotRightBars + 3,
      options.compressionLookback * 2,
    );
  if (candles.length < minimumBars) {
    blockers.push("V2_PRICE_STRUCTURE_INSUFFICIENT_CLOSED_BARS");
    missingEvidence.push("minimumClosedCandleHistory");
  }
  if (blockers.length > 0) return failure(blockers, missingEvidence, normalized.excluded);

  const ranges = trueRanges(candles);
  const atr = atrAt(ranges, candles.length - 1, options.atrPeriod);
  if (!atr || atr <= 0) return failure(["V2_PRICE_STRUCTURE_ATR_UNAVAILABLE"], ["positiveAtr"], normalized.excluded);
  const pivots = detectConfirmedPivots(candles, options);
  const structure = marketStructure(pivots);
  const support = structure.latestLow;
  const resistance = structure.latestHigh;
  const latestCandle = candleFeatures(candles, atr, support, resistance, options);
  const lifecycle = breakoutLifecycle(candles, pivots, ranges, options);
  const wave = waveFeatures(pivots, atr);
  const pattern = {
    namedPattern: lifecycle?.status ?? "NONE",
    structureTransition: lifecycle?.structureTransition ?? "NONE",
    priorStructureTrend: lifecycle?.priorStructureTrend ?? null,
    ...wave,
    swingHighSlopeAtrPerBar: slope(pivots, "HIGH", atr),
    swingLowSlopeAtrPerBar: slope(pivots, "LOW", atr),
    compressionRatio: ratioOfWindows(ranges, options.compressionLookback),
    volumeContractionRatio: ratioOfWindows(candles.map((candle) => candle.volume), options.compressionLookback),
    breakoutDirection: lifecycle?.direction ?? null,
    breakoutDistanceAtr: lifecycle?.breakoutDistanceAtr ?? null,
    barsSinceBreakout: lifecycle?.barsSinceBreakout ?? null,
    retestDepthAtr: lifecycle?.retestDepthAtr ?? null,
    retestHold: lifecycle?.retestHold ?? null,
    failedBreakoutDistanceAtr: lifecycle?.failedBreakoutDistanceAtr ?? null,
  };
  const priceStructure = {
    trend: structure.trend,
    confirmedPivotCount: pivots.length,
    latestHighClassification: structure.latestHigh?.classification ?? null,
    latestLowClassification: structure.latestLow?.classification ?? null,
    resistance: rounded(resistance?.price),
    support: rounded(support?.price),
    distanceFromResistanceAtr: latestCandle.resistanceDistanceAtr,
    distanceFromSupportAtr: latestCandle.supportDistanceAtr,
    structureEvent: lifecycle?.status ?? "NONE",
    structureEventDirection: lifecycle?.direction ?? null,
    structureTransition: lifecycle?.structureTransition ?? "NONE",
  };
  const contentDigest = sha256Canonical({
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    market: input.market,
    symbol: input.symbol,
    timeframe: input.timeframe,
    source: input.source,
    candles,
  });
  const last = candles.at(-1);
  const temporal = {
    eventTime: last.eventTime,
    publishedAt: candles.map((item) => item.publishedAt).sort().at(-1),
    availableAt: candles.map((item) => item.availableAt).sort().at(-1),
    observedAt: candles.map((item) => item.observedAt).sort().at(-1),
  };
  const sharedUncertainty = [
    "All features derive from one OHLCV source and are not independent votes.",
    "Confirmed pivots lag by the configured right-side confirmation bars.",
    "Candlestick, wave, BOS, and CHOCH labels are deterministic descriptors from the same OHLCV source, not independent votes.",
    "No price-direction probability or trade authorization is produced.",
  ];
  const priceEvidence = buildAdaptiveMultiEvidencePointInTimeV2(evidenceInput(
    input,
    "PRICE_STRUCTURE",
    temporal,
    contentDigest,
    metricFacts("priceStructure", priceStructure),
    [
      `structureContext=${structure.trend}`,
      `structureEvent=${lifecycle?.status ?? "NONE"}`,
      `structureTransition=${lifecycle?.structureTransition ?? "NONE"}`,
    ],
    sharedUncertainty,
  ));
  const candleEvidence = buildAdaptiveMultiEvidencePointInTimeV2(evidenceInput(
    input,
    "CANDLE",
    temporal,
    contentDigest,
    metricFacts("candle", latestCandle),
    [
      `latestCandleDirection=${latestCandle.direction}`,
      `candlestickPatterns=${latestCandle.namedPatterns.join("|") || "NONE"}`,
      `trendContext=${structure.trend}`,
    ],
    sharedUncertainty,
  ));
  const patternEvidence = buildAdaptiveMultiEvidencePointInTimeV2(evidenceInput(
    input,
    "PATTERN",
    temporal,
    contentDigest,
    metricFacts("pattern", pattern),
    [
      `numericPatternState=${pattern.namedPattern}`,
      `structureTransition=${pattern.structureTransition}`,
      `swingSequence=${pattern.swingSequence.join(">") || "NONE"}`,
      "Pattern names are deterministic descriptors only.",
    ],
    sharedUncertainty,
  ));
  const evidence = { priceStructure: priceEvidence, candle: candleEvidence, pattern: patternEvidence };
  const evidenceBlockers = Object.values(evidence).flatMap((item) => item.blockers ?? []);
  if (evidenceBlockers.length > 0) return failure(evidenceBlockers, [], normalized.excluded);

  return deepFreeze({
    schemaVersion: ADAPTIVE_MULTI_EVIDENCE_PRICE_STRUCTURE_V2_VERSION,
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    status: "READY_FOR_SPECIALIST_RESEARCH_ONLY",
    decisionTime,
    contentDigest,
    acceptedClosedCandleCount: candles.length,
    excluded: normalized.excluded,
    features: { priceStructure, candle: latestCandle, pattern, pivots },
    evidence,
    correlationGroup: `SHARED_OHLCV:${input.market}:${text(input.symbol)?.toUpperCase()}:${input.timeframe}`,
    independenceStatus: "NOT_YET_PROVEN",
    independentVoteCredit: 0,
    decisionAuthority: "EVIDENCE_ONLY",
    economicSampleCredit: 0,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: "NONE",
  });
}
