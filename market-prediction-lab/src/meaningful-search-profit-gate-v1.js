const MARKETS = Object.freeze(["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"]);
const STRATEGIES = new Set(["SCALPING", "SWING", "MID_LONG"]);
const FUNNEL_STAGES = Object.freeze([
  "TOTAL_UNIVERSE", "QUOTE_REQUESTED", "QUOTE_SUCCESS", "HISTORY_SUFFICIENT",
  "INDICATORS_READY", "DATA_QUALITY_PASS", "LIQUIDITY_PASS", "HARD_FILTER_PASS",
  "SOFT_CANDIDATE", "REGIME_MATCH", "SETUP_FOUND", "PROFIT_GATE_PASS", "FINAL_SIGNAL_COUNT",
]);

const HARD_REASONS = Object.freeze({
  quoteSuccess: "PROVIDER_FAILURE",
  historySufficient: "INSUFFICIENT_HISTORY",
  indicatorsReady: "MISSING_CLOSED_CANDLE",
  dataQualityPass: "STALE_PRICE",
  tradable: "UNAUTHORIZED_MARKET",
  priceValid: "INVALID_PRICE",
  liquidityPass: "LOW_LIQUIDITY",
  spreadPass: "SPREAD_TOO_WIDE",
});

const MARKET_FEATURES = Object.freeze({
  KR_STOCK: ["marketRelativeStrength", "sectorRelativeStrength", "turnover", "relativeVolume", "trend", "momentum", "volatilityFit"],
  US_STOCK: ["marketRegime", "sectorRelativeStrength", "marketRelativeStrength", "dollarVolume", "relativeVolume", "trend", "momentum", "volatilityFit"],
  CRYPTO_SPOT: ["btcRegime", "btcRelativeStrength", "usdtTrend", "breadth", "turnover", "relativeVolume", "trend", "volatilityFit"],
  CRYPTO_FUTURES: ["trend", "volatilityFit", "basis", "funding", "aggressiveFlow", "orderBookImbalance", "liquidity", "spreadQuality"],
});

const STRATEGY_FEATURES = Object.freeze({
  SCALPING: ["turnover", "relativeVolume", "spreadQuality", "liquidity", "shortMomentum", "executionQuality"],
  SWING: ["marketRelativeStrength", "trend", "pullback", "relativeVolume", "marketRegime", "riskReward"],
  MID_LONG: ["marketRelativeStrength", "longTrend", "volatilityAdjustedStrength", "diversification"],
});

function finite(value) { return typeof value === "number" && Number.isFinite(value); }
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function freeze(value) { return Object.freeze(value); }
function requireMarket(market) { if (!MARKETS.includes(market)) throw new TypeError("supported market is required"); }

export function createSearchFunnel(market) {
  requireMarket(market);
  const counts = Object.fromEntries(FUNNEL_STAGES.map((stage) => [stage, 0]));
  const rejects = {};
  return {
    market,
    increment(stage, amount = 1) {
      if (!FUNNEL_STAGES.includes(stage) || !Number.isInteger(amount) || amount < 0) throw new TypeError("valid funnel increment is required");
      counts[stage] += amount;
    },
    reject(reason, amount = 1) {
      if (typeof reason !== "string" || !reason || !Number.isInteger(amount) || amount < 1) throw new TypeError("valid reject reason is required");
      rejects[reason] = (rejects[reason] ?? 0) + amount;
    },
    snapshot() {
      const searchFailed = counts.TOTAL_UNIVERSE === 0 || counts.QUOTE_REQUESTED === 0 ||
        (counts.QUOTE_REQUESTED > 0 && counts.QUOTE_SUCCESS === 0);
      const completed = !searchFailed && counts.QUOTE_SUCCESS > 0;
      return freeze({
        market, counts: freeze({ ...counts }), rejectReasons: freeze({ ...rejects }),
        outcome: searchFailed ? "SEARCH_FAILURE" : counts.FINAL_SIGNAL_COUNT === 0 ? "VALID_NO_TRADE" : "TRADE_CANDIDATES",
        searchCompleted: completed,
      });
    },
  };
}

export function evaluateHardFilters(candidate) {
  requireMarket(candidate?.market);
  const reasons = [];
  for (const [field, reason] of Object.entries(HARD_REASONS)) if (candidate[field] !== true) reasons.push(reason);
  if (candidate.futureData === true) reasons.push("FUTURE_DATA");
  if (candidate.closedCandleComplete !== true) reasons.push("MISSING_CLOSED_CANDLE");
  return freeze({ pass: reasons.length === 0, reasons: freeze([...new Set(reasons)]) });
}

function featureMean(features, names) {
  const values = names.map((name) => features?.[name]).filter(finite).map((value) => clamp(value, 0, 1));
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

export function rankSoftCandidate(candidate) {
  requireMarket(candidate?.market);
  if (!STRATEGIES.has(candidate?.strategy)) throw new TypeError("supported strategy is required");
  const hard = evaluateHardFilters(candidate);
  if (!hard.pass) return freeze({ grade: "REJECT", setupScore: null, reasons: hard.reasons, hardRejected: true });

  const marketScore = featureMean(candidate.features, MARKET_FEATURES[candidate.market]);
  const strategyScore = featureMean(candidate.features, STRATEGY_FEATURES[candidate.strategy]);
  if (!finite(marketScore) || !finite(strategyScore)) {
    return freeze({ grade: "REJECT", setupScore: null, reasons: freeze(["INSUFFICIENT_FEATURE_EVIDENCE"]), hardRejected: false });
  }
  const penalty = clamp((candidate.features?.overextension ?? 0) + (candidate.features?.crowding ?? 0) + (candidate.features?.executionPenalty ?? 0), 0, 2) / 3;
  const setupScore = clamp((marketScore * 0.6 + strategyScore * 0.4 - penalty) * 100, 0, 100);
  const grade = setupScore >= 80 ? "S" : setupScore >= 65 ? "A" : setupScore >= 45 ? "B/WATCH" : "REJECT";
  return freeze({ grade, setupScore, reasons: freeze(grade === "REJECT" ? ["NO_SETUP"] : []), hardRejected: false });
}

export function assertFuturesFeatureParity({ market, runtimeFeatures = [], trainingFeatures = [] } = {}) {
  requireMarket(market);
  if (market !== "CRYPTO_FUTURES") return freeze({ pass: true, allowedFeatures: freeze([...runtimeFeatures]), blockedFeatures: freeze([]) });
  const trained = new Set(trainingFeatures);
  const blockedFeatures = runtimeFeatures.filter((feature) => !trained.has(feature));
  return freeze({ pass: blockedFeatures.length === 0, allowedFeatures: freeze(runtimeFeatures.filter((feature) => trained.has(feature))), blockedFeatures: freeze(blockedFeatures) });
}

function wilsonLower(successes, total, z = 1.96) {
  if (!Number.isInteger(total) || total <= 0 || !Number.isInteger(successes) || successes < 0 || successes > total) return null;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  return (p + (z * z) / (2 * total) - z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total)) / denominator;
}

export function evaluateProfitGate(input) {
  requireMarket(input?.market);
  const reasons = [];
  if (!input?.costs || input.costs.status !== "READY" || !Object.values(input.costs.components ?? {}).every(finite)) reasons.push("COST_NOT_EVIDENCED");
  if (!input?.calibration || input.calibration.status !== "READY") reasons.push("UNCALIBRATED_PROBABILITY");
  if (!Number.isInteger(input?.calibration?.sampleSize) || input.calibration.sampleSize < (input.minimumSample ?? 30)) reasons.push("INSUFFICIENT_SAMPLE");
  if (![input?.probabilities?.tp, input?.probabilities?.sl, input?.probabilities?.expire].every(finite)) reasons.push("UNCALIBRATED_PROBABILITY");
  const probabilitySum = (input?.probabilities?.tp ?? 0) + (input?.probabilities?.sl ?? 0) + (input?.probabilities?.expire ?? 0);
  if (Math.abs(probabilitySum - 1) > 1e-9) reasons.push("INVALID_PROBABILITY_DISTRIBUTION");
  if (input.market === "CRYPTO_FUTURES" && input.featureParity?.pass !== true) reasons.push("FEATURE_PARITY_BLOCKED");
  if (reasons.length) return freeze({ decision: "NO_TRADE", eligible: false, reasons: freeze([...new Set(reasons)]), netEv: null, evLowerBound: null, executionAuthority: "NONE" });

  const totalCost = Object.values(input.costs.components).reduce((sum, value) => sum + value, 0);
  const netEv = input.probabilities.tp * input.returns.target - input.probabilities.sl * Math.abs(input.returns.stop) +
    input.probabilities.expire * input.returns.expire - totalCost;
  const lowerTp = wilsonLower(input.calibration.tpFirstCount, input.calibration.sampleSize);
  if (!finite(lowerTp)) return freeze({ decision: "NO_TRADE", eligible: false, reasons: freeze(["EV_UNCERTAIN"]), netEv, evLowerBound: null, executionAuthority: "NONE" });
  const nonTp = 1 - lowerTp;
  const evLowerBound = lowerTp * input.returns.target - nonTp * Math.abs(input.returns.stop) - totalCost;
  if (netEv <= 0) reasons.push("NEGATIVE_NET_EV");
  if (evLowerBound <= (input.minimumEdge ?? 0)) reasons.push("EV_UNCERTAIN");
  return freeze({ decision: reasons.length ? "NO_TRADE" : "ELIGIBLE", eligible: reasons.length === 0, reasons: freeze(reasons), netEv, evLowerBound, totalCost, executionAuthority: "NONE" });
}

export function runOpportunityAuction(candidates = []) {
  if (!Array.isArray(candidates)) throw new TypeError("candidates array is required");
  const eligible = candidates.filter((candidate) => candidate?.profitGate?.eligible === true && finite(candidate.profitGate.evLowerBound));
  eligible.sort((a, b) => b.profitGate.evLowerBound - a.profitGate.evLowerBound);
  const selected = [];
  const exposure = new Set();
  for (const candidate of eligible) {
    const group = candidate.correlationGroup ?? `${candidate.market}:${candidate.symbol}`;
    if (exposure.has(group)) continue;
    exposure.add(group);
    selected.push(candidate);
  }
  return freeze({ decision: selected.length ? "TRADE_CANDIDATES" : "CASH/NO_TRADE", selected: freeze(selected), considered: candidates.length });
}

export function marketSearchContract() {
  return freeze({ markets: MARKETS, marketFeatures: MARKET_FEATURES, strategyFeatures: STRATEGY_FEATURES, funnelStages: FUNNEL_STAGES, liveTrading: false });
}
