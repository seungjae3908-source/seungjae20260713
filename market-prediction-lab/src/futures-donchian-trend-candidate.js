import { createHash } from "node:crypto";

export const FUTURES_DONCHIAN_TREND_CANDIDATE = Object.freeze({
  id: "bitget-futures-donchian-atr-trend-v1",
  market: "CRYPTO_FUTURES",
  exchange: "BITGET",
  timeframe: "15m",
  priorResearchSymbols: Object.freeze([
    "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT",
  ]),
  designSymbols: Object.freeze(["LTCUSDT", "BCHUSDT"]),
  holdoutSymbols: Object.freeze(["LINKUSDT", "DOTUSDT"]),
  fixed: Object.freeze({
    atrPeriod: 14,
    riskPerTrade: 0.005,
    trailingAtrMultiple: 2.5,
    fundingFreshnessMs: 12 * 60 * 60 * 1000,
  }),
  search: Object.freeze({
    breakoutLookback: Object.freeze([20, 40, 80]),
    trendMaPeriod: Object.freeze([100, 200]),
    stopAtrMultiple: Object.freeze([2, 3]),
    maxHoldBars: Object.freeze([32, 64]),
    maxAtrFraction: Object.freeze([0.015, 0.025]),
    fundingCrowdingAbsRate: Object.freeze([0.0003, 0.0006]),
  }),
  selectionContract: Object.freeze({
    designTrainUsedForRanking: true,
    designValidationUsedForSelection: true,
    designTestUsedForSelection: false,
    holdoutUsedForSelection: false,
    holdoutStressUsedForSelection: false,
    rollingUsedForSelection: false,
    priorResearchSymbolsUsedForSelection: false,
    scalarWeightedScoreUsed: false,
  }),
  safeguards: Object.freeze({
    researchOnly: true,
    modelUsed: false,
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

export const FUTURES_DONCHIAN_TREND_CANDIDATE_SHA256 = createHash("sha256")
  .update(canonical(FUTURES_DONCHIAN_TREND_CANDIDATE))
  .digest("hex");
