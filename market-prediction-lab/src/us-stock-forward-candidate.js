import { createHash } from "node:crypto";

export const US_STOCK_FORWARD_START = Date.parse("2026-08-13T00:00:00.000Z");

export const US_STOCK_FORWARD_CANDIDATE = Object.freeze({
  id: "us-stock-regime-router-v1",
  market: "US_STOCK",
  strategy: "regime_router_trend_plus_range",
  params: Object.freeze({
    regimeLookback: 20,
    regimeMaPeriod: 100,
    trendEfficiencyMin: 0.25,
    rangeEfficiencyMax: 0.20,
    rangeMaxMaSlopePercent: 2,
    trendPullbackLookback: 10,
    trendMaxPullbackAtr: 2.5,
    trendMinRelativeVolume: 0.8,
    trendStopAtr: 2,
    trendRewardRisk: 1.5,
    rangeZPeriod: 20,
    rangeEntryZ: -2,
    rangeExitZ: 0,
    rangeStopAtr: 2,
    maxHoldBars: 20,
    maxGapPercent: 4,
  }),
  seedSymbols: Object.freeze(["AAPL", "MSFT", "NVDA"]),
  historicalHoldoutSymbols: Object.freeze(["AMZN", "GOOGL", "META", "JPM", "XOM"]),
  prospectiveOnlySymbols: Object.freeze(["AVGO", "COST", "LLY", "UNH", "HD", "PG", "KO", "CAT", "WMT", "CVX"]),
  costRatePerSide: 0.0015,
  stressMultiplier: 1.5,
  sourceResearchSha: "999771ff83a2a68e03bba1673c58df7ded582f7a",
  sourceRunId: 31595338653,
  sourceArtifactDigest: "sha256:c5b5079f4d03708ca79365a4e1d396b35e578878e9d74ad740392524238f46d8",
  selectionEvidence: Object.freeze({
    validationPassed: true,
    seedTestPassed: true,
    stressPassed: true,
    holdoutPassed: true,
    holdoutStressPassed: true,
    rollingPassed: true,
  }),
  limitations: Object.freeze([
    "point-in-time constituent membership is not yet integrated",
    "delisted-name survivorship coverage is not yet integrated",
    "prospective-only symbols must never be used for parameter selection or historical retuning",
    "live execution remains prohibited regardless of forward results",
  ]),
});

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const US_STOCK_FORWARD_CANDIDATE_SHA256 = createHash("sha256")
  .update(canonical(US_STOCK_FORWARD_CANDIDATE))
  .digest("hex");
