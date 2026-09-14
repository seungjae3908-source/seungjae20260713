import { sha256Canonical } from "./research-cache-provenance.js";
import { ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID } from "./adaptive-multi-evidence-point-in-time-v2.js";
import { ADAPTIVE_MULTI_EVIDENCE_MARKET_FEATURES_V2_VERSION } from "./adaptive-multi-evidence-market-features-v2.js";

export const ADAPTIVE_MULTI_EVIDENCE_REGIME_ROUTER_V2_VERSION =
  "adaptive-multi-evidence-regime-router-v2";

export const ADAPTIVE_MULTI_EVIDENCE_REGIMES_V2 = Object.freeze([
  "STRONG_TREND_UP",
  "TREND_UP",
  "RANGE",
  "TREND_DOWN",
  "STRONG_TREND_DOWN",
  "VOLATILITY_COMPRESSION",
  "HIGH_VOLATILITY",
  "PANIC_DISLOCATION",
  "UNKNOWN",
]);

const DEFAULTS = Object.freeze({
  trendAdxMinimum: 20,
  strongTrendAdxMinimum: 35,
  rangeAdxMaximum: 18,
  compressionRangeRatioMaximum: 0.8,
  highVolatilityAtrPctMinimum: 0.05,
  highVolatilityRangeRatioMinimum: 1.8,
  panicGapPctMinimum: 0.06,
  panicRangeZMinimum: 3,
  panicVolumeZMinimum: 3,
});

const TREND_ROUTES = Object.freeze(["BREAKOUT", "MOMENTUM", "TREND_FOLLOWING"]);
const RANGE_ROUTES = Object.freeze(["MEAN_REVERSION", "RANGE", "VWAP_DEVIATION"]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positive(value, fallback) {
  const candidate = value ?? fallback;
  return finite(candidate) != null && candidate > 0 ? candidate : null;
}

function normalizeOptions(raw, blockers) {
  const options = Object.fromEntries(
    Object.entries(DEFAULTS).map(([key, fallback]) => [key, positive(raw?.[key], fallback)]),
  );
  for (const [key, value] of Object.entries(options)) {
    if (value == null) blockers.push(`V2_REGIME_${key.replace(/[A-Z]/gu, (item) => `_${item}`).toUpperCase()}_INVALID`);
  }
  if (options.rangeAdxMaximum != null && options.trendAdxMinimum != null
      && options.rangeAdxMaximum >= options.trendAdxMinimum) {
    blockers.push("V2_REGIME_ADX_THRESHOLDS_NOT_ORDERED");
  }
  if (options.trendAdxMinimum != null && options.strongTrendAdxMinimum != null
      && options.trendAdxMinimum >= options.strongTrendAdxMinimum) {
    blockers.push("V2_REGIME_STRONG_ADX_THRESHOLD_NOT_ORDERED");
  }
  return options;
}

function failure(blockers, missingEvidence = []) {
  return deepFreeze({
    schemaVersion: ADAPTIVE_MULTI_EVIDENCE_REGIME_ROUTER_V2_VERSION,
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    status: "BLOCKED_DATA",
    regime: "UNKNOWN",
    directionalRegime: "UNKNOWN",
    volatilityRegime: "UNKNOWN",
    multiTimeframeAlignment: "UNKNOWN",
    routing: {
      allowedStrategyFamilies: [],
      entryPolicy: "FAIL_CLOSED_NO_TRADE",
      higherTimeframeAction: "INSUFFICIENT_CONTEXT",
    },
    blockers: unique(blockers),
    missingEvidence: unique(missingEvidence),
    independentVoteCredit: 0,
    economicSampleCredit: 0,
    decisionAuthority: "NONE",
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: "NONE",
  });
}

function direction(value) {
  if (["UP", "BULLISH"].includes(value)) return "UP";
  if (["DOWN", "BEARISH"].includes(value)) return "DOWN";
  return "NEUTRAL";
}

function multiTimeframeAlignment(trend) {
  if (trend?.multiTimeframeStatus !== "AVAILABLE" || !Array.isArray(trend.higherTimeframes)
      || trend.higherTimeframes.length === 0) return "UNKNOWN";
  const current = direction(trend.emaDirection);
  if (current === "NEUTRAL") return "NEUTRAL";
  const contexts = trend.higherTimeframes.map((item) => direction(item?.trend));
  if (contexts.every((item) => item === current)) return "ALIGNED";
  if (contexts.some((item) => item !== "NEUTRAL" && item !== current)) return "CONFLICT";
  return "NEUTRAL";
}

function directionalRegime(trend, options) {
  const adx = finite(trend?.adx);
  if (adx == null) return "UNKNOWN";
  const emaDirection = direction(trend.emaDirection);
  const adxDirection = direction(trend.adxDirection);
  const structureDirection = direction(trend.structureTrend);
  const fastSlope = finite(trend.emaFastSlopePctPerBar);
  const slowSlope = finite(trend.emaSlowSlopePctPerBar);
  const upAgreement = [emaDirection, adxDirection, structureDirection].filter((item) => item === "UP").length;
  const downAgreement = [emaDirection, adxDirection, structureDirection].filter((item) => item === "DOWN").length;
  const strongUp = adx >= options.strongTrendAdxMinimum && upAgreement === 3
    && fastSlope > 0 && slowSlope > 0;
  const strongDown = adx >= options.strongTrendAdxMinimum && downAgreement === 3
    && fastSlope < 0 && slowSlope < 0;
  if (strongUp) return "STRONG_TREND_UP";
  if (strongDown) return "STRONG_TREND_DOWN";
  if (adx >= options.trendAdxMinimum && upAgreement >= 2) return "TREND_UP";
  if (adx >= options.trendAdxMinimum && downAgreement >= 2) return "TREND_DOWN";
  if (adx <= options.rangeAdxMaximum && ["MIXED", "INSUFFICIENT"].includes(trend.structureTrend)) return "RANGE";
  return "UNKNOWN";
}

function volatilityRegime(volatility, volume, options) {
  const atrPct = finite(volatility?.atrPct);
  const rangeRatio = finite(volatility?.recentToPriorRangeRatio);
  const gap = finite(volatility?.latestGapPct);
  const rangeZ = finite(volatility?.abnormalRangeZScore);
  const volumeZ = finite(volume?.abnormalVolumeZScore);
  if (atrPct == null || rangeRatio == null) return "UNKNOWN";
  const dislocation = volatility.abnormalVolatility === true
    && (Math.abs(gap ?? 0) >= options.panicGapPctMinimum
      || Math.abs(rangeZ ?? 0) >= options.panicRangeZMinimum)
    && (volume?.abnormalVolume === true || Math.abs(volumeZ ?? 0) >= options.panicVolumeZMinimum);
  if (dislocation) return "PANIC_DISLOCATION";
  if (volatility.abnormalVolatility === true
      || atrPct >= options.highVolatilityAtrPctMinimum
      || rangeRatio >= options.highVolatilityRangeRatioMinimum) return "HIGH_VOLATILITY";
  if (volatility.rangeState === "COMPRESSION"
      && rangeRatio <= options.compressionRangeRatioMaximum) return "VOLATILITY_COMPRESSION";
  return "NEUTRAL";
}

function routing(regime, alignment) {
  let allowedStrategyFamilies = [];
  let entryPolicy = "FAIL_CLOSED_NO_TRADE";
  if (["STRONG_TREND_UP", "TREND_UP", "TREND_DOWN", "STRONG_TREND_DOWN"].includes(regime)) {
    allowedStrategyFamilies = TREND_ROUTES;
    entryPolicy = "VALIDATED_STRATEGIES_ONLY";
  } else if (regime === "RANGE") {
    allowedStrategyFamilies = RANGE_ROUTES;
    entryPolicy = "VALIDATED_STRATEGIES_ONLY";
  } else if (regime === "VOLATILITY_COMPRESSION") {
    allowedStrategyFamilies = ["BREAKOUT_WATCH"];
    entryPolicy = "WATCH_ONLY_NO_ENTRY_AUTHORITY";
  } else if (regime === "HIGH_VOLATILITY") {
    entryPolicy = "VOLATILITY_ADAPTED_POLICY_REQUIRED";
  } else if (regime === "PANIC_DISLOCATION") {
    entryPolicy = "SUPPRESS_NEW_ENTRY";
  }
  const higherTimeframeAction = alignment === "CONFLICT"
    ? "DOWNSTREAM_REVIEW_NOT_AUTOMATIC_VETO"
    : alignment === "UNKNOWN" ? "INSUFFICIENT_CONTEXT" : "CONTEXT_RECORDED";
  return { allowedStrategyFamilies, entryPolicy, higherTimeframeAction };
}

export function buildAdaptiveMultiEvidenceRegimeRouterV2({ marketFeatures, options: rawOptions } = {}) {
  const blockers = [];
  const missingEvidence = [];
  const options = normalizeOptions(rawOptions, blockers);
  if (marketFeatures?.schemaVersion !== ADAPTIVE_MULTI_EVIDENCE_MARKET_FEATURES_V2_VERSION
      || marketFeatures?.lineageId !== ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID) {
    blockers.push(marketFeatures?.lineageId
      ? "V1_OR_FOREIGN_LINEAGE_CONTAMINATION_FORBIDDEN"
      : "V2_REGIME_MARKET_FEATURES_REQUIRED");
  }
  if (!["READY_FOR_SPECIALIST_RESEARCH_ONLY", "PARTIAL_FOR_SPECIALIST_RESEARCH_ONLY"].includes(marketFeatures?.status)
      || !marketFeatures?.features) blockers.push("V2_REGIME_ADMISSIBLE_MARKET_FEATURES_REQUIRED");
  if (marketFeatures?.executionAuthority !== "NONE") blockers.push("V2_REGIME_EXECUTION_AUTHORITY_FORBIDDEN");
  const evidence = Object.values(marketFeatures?.evidence ?? {});
  if (evidence.length !== 4 || evidence.some((item) => item?.status !== "ADMISSIBLE"
      || item?.evidence?.lineageId !== ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID
      || item?.executionAuthority !== "NONE")) blockers.push("V2_REGIME_SOURCE_EVIDENCE_NOT_ADMISSIBLE");
  if (!marketFeatures?.decisionTime) missingEvidence.push("decisionTime");
  if (blockers.length > 0 || missingEvidence.length > 0) return failure(blockers, missingEvidence);

  const trend = marketFeatures.features.trend;
  const volatility = marketFeatures.features.volatility;
  const volume = marketFeatures.features.volume;
  const directional = directionalRegime(trend, options);
  const volatilityState = volatilityRegime(volatility, volume, options);
  const regime = volatilityState === "PANIC_DISLOCATION" ? volatilityState
    : volatilityState === "HIGH_VOLATILITY" ? volatilityState
      : volatilityState === "VOLATILITY_COMPRESSION" ? volatilityState
        : directional;
  const alignment = multiTimeframeAlignment(trend);
  const route = routing(regime, alignment);
  const regimeDigest = sha256Canonical({
    sourceContentDigest: marketFeatures.contentDigest,
    decisionTime: marketFeatures.decisionTime,
    regime,
    directionalRegime: directional,
    volatilityRegime: volatilityState,
    multiTimeframeAlignment: alignment,
    options,
  });

  return deepFreeze({
    schemaVersion: ADAPTIVE_MULTI_EVIDENCE_REGIME_ROUTER_V2_VERSION,
    lineageId: ADAPTIVE_MULTI_EVIDENCE_V2_LINEAGE_ID,
    status: regime === "UNKNOWN" ? "INSUFFICIENT_EVIDENCE_NO_TRADE" : "READY_FOR_STRATEGY_ROUTING_RESEARCH_ONLY",
    decisionTime: marketFeatures.decisionTime,
    sourceContentDigest: marketFeatures.contentDigest,
    regimeDigest,
    regime,
    directionalRegime: directional,
    volatilityRegime: volatilityState,
    multiTimeframeAlignment: alignment,
    routing: route,
    facts: {
      adx: trend.adx,
      emaDirection: trend.emaDirection,
      adxDirection: trend.adxDirection,
      structureTrend: trend.structureTrend,
      atrPct: volatility.atrPct,
      recentToPriorRangeRatio: volatility.recentToPriorRangeRatio,
      abnormalVolatility: volatility.abnormalVolatility,
      abnormalVolume: volume.abnormalVolume,
    },
    uncertainty: [
      "Regime is a point-in-time classification, not a price forecast or profitability claim.",
      alignment === "UNKNOWN" ? "Higher-timeframe context is unavailable." : null,
      alignment === "CONFLICT" ? "Higher-timeframe conflict requires downstream review but is not an automatic veto." : null,
    ].filter(Boolean),
    blockers: [],
    missingEvidence: marketFeatures.missingEvidence ?? [],
    routeAuthority: "RESEARCH_FAMILY_ELIGIBILITY_ONLY",
    independentVoteCredit: 0,
    economicSampleCredit: 0,
    profitabilityProven: false,
    decisionAuthority: "NONE",
    frozenV1Contamination: 0,
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
    executionAuthority: "NONE",
  });
}
