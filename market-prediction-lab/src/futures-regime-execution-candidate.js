import { createHash } from "node:crypto";

export const FUTURES_REGIME_EXECUTION_CANDIDATE = Object.freeze({
  id: "bitget-futures-15m-frozen-execution-regime-gate-v1",
  market: "CRYPTO_FUTURES",
  exchange: "BITGET",
  timeframe: "15m",
  modelGroup: "crypto-futures-15m",
  frozenExecutionParams: Object.freeze({
    minDirectionalProbability: 0.5,
    minProbabilityEdge: 0.08,
    atrPeriod: 14,
    stopAtrMultiple: 2,
    rewardRisk: 2,
    maxHoldBars: 8,
    riskPerTrade: 0.005,
  }),
  sourceResearchSha: "4bdec4fe6c55fd3280eb469b8de45608bfa6bd84",
  sourceRunId: 31636102851,
  sourceArtifactId: 9157145371,
  sourceArtifactDigest: "sha256:0eeadc6f12ad76bf4bb78467645b66a6fbc36e644f24c9b7c44adc22d21e3912",
  sourceStatus: "research_hold",
  sourceGates: Object.freeze({
    validationPassed: true,
    seedTestPassed: false,
    stressPassed: false,
    holdoutPassed: false,
    holdoutStressPassed: false,
    rollingPassed: false,
  }),
  priorSymbols: Object.freeze(["BTCUSDT", "ETHUSDT", "SOLUSDT"]),
  designSymbols: Object.freeze(["BNBUSDT", "XRPUSDT"]),
  holdoutSymbols: Object.freeze(["ADAUSDT", "DOGEUSDT"]),
  regimeSearch: Object.freeze({
    trendMaPeriod: Object.freeze([50, 100]),
    trendSlopeBars: Object.freeze([4, 8]),
    maxAtrFraction: Object.freeze([0.01, 0.015, 0.02]),
    fundingCrowdingAbsRate: Object.freeze([0.0003, 0.0006]),
    executionParametersRetuned: false,
    priorSymbolsUsedForSelection: false,
    holdoutUsedForSelection: false,
  }),
  safeguards: Object.freeze({
    researchOnly: true,
    liveExecutionAllowed: false,
    privateAccountRequestAllowed: false,
    actualOrders: 0,
  }),
});

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const FUTURES_REGIME_EXECUTION_CANDIDATE_SHA256 = createHash("sha256")
  .update(canonical(FUTURES_REGIME_EXECUTION_CANDIDATE))
  .digest("hex");
