import { runAutomatedV1Research } from "./automated-v1-research.js";

export const SCALPING_V1_PARAMETER_BOUNDS = Object.freeze({
  fastPeriod: Object.freeze({ min: 5, max: 24, coarse: Object.freeze([5, 8, 12, 16, 20, 24]), fineStep: 1 }),
  slowPeriod: Object.freeze({ min: 20, max: 96, coarse: Object.freeze([24, 36, 48, 72, 96]), fineStep: 3 }),
  atrPeriod: Object.freeze({ min: 7, max: 28, coarse: Object.freeze([7, 10, 14, 20, 28]), fineStep: 1 }),
  pullbackTolerancePct: Object.freeze({ min: 0.1, max: 1.5, coarse: Object.freeze([0.15, 0.25, 0.5, 0.75, 1, 1.5]), fineStep: 0.1 }),
  stopAtrMultiple: Object.freeze({ min: 0.75, max: 2.5, coarse: Object.freeze([0.75, 1, 1.25, 1.5, 2, 2.5]), fineStep: 0.25 }),
  targetRiskMultiple: Object.freeze({ min: 1, max: 3.5, coarse: Object.freeze([1, 1.25, 1.5, 2, 2.5, 3, 3.5]), fineStep: 0.25 }),
});

export const SCALPING_RESEARCH_BUDGET = Object.freeze({
  maxCoarseCandidates: 36,
  maxFineCandidates: 36,
  developmentSeeds: 8,
  oosCandidates: 8,
  maxWalkForwardWindows: 6,
});

function assertInput(input) {
  if (!input || typeof input !== "object") throw new TypeError("scalping backtest input is required");
  if (input.timeframe !== "15m") throw new TypeError("scalping V1 research requires 15m timeframe");
  if (!new Set(["CRYPTO_SPOT", "CRYPTO_FUTURES"]).has(input.market)) throw new TypeError("unsupported scalping market");
  if (!Array.isArray(input.candles) || input.candles.length === 0) throw new TypeError("DATA_READY real candles are required");
  if (input.market === "CRYPTO_SPOT" && (input.side ?? "long") !== "long") throw new TypeError("spot scalping remains long-only");
  if (input.market === "CRYPTO_FUTURES" && !new Set(["long", "short"]).has(input.side)) throw new TypeError("futures scalping side must be long or short");
  if (input.market === "CRYPTO_FUTURES" && !Array.isArray(input.fundingRates)) throw new TypeError("futures scalping requires explicit funding history");
}

export function classifyScalpingSample(candidate) {
  const oosTradeCount = candidate?.oosMetrics?.tradeCount ?? 0;
  const wfTradeCount = (candidate?.walkForward?.windows ?? []).reduce((sum, row) => sum + (row.tradeCount ?? 0), 0);
  const developmentTradeCount = candidate?.developmentMetrics?.tradeCount ?? 0;
  const totalIndependentTrades = oosTradeCount + wfTradeCount;
  const lowSamplePenalty = oosTradeCount < 10 ? Number((1 - oosTradeCount / 10).toFixed(6)) : 0;
  const sampleQuality = oosTradeCount < 10 ? "critical_low_oos_sample" : "uncalibrated_sample_quality";
  return Object.freeze({
    developmentTradeCount,
    oosTradeCount,
    wfTradeCount,
    totalIndependentTrades,
    sampleQuality,
    lowSamplePenalty,
    tenTradesIsAutomaticPass: false,
  });
}

export function runScalpingV1Research({ backtestInput, budget = SCALPING_RESEARCH_BUDGET } = {}) {
  assertInput(backtestInput);
  const base = runAutomatedV1Research({
    backtestInput,
    parameterBounds: SCALPING_V1_PARAMETER_BOUNDS,
    maxCoarseCandidates: budget.maxCoarseCandidates,
    maxFineCandidates: budget.maxFineCandidates,
    developmentSeeds: budget.developmentSeeds,
    oosCandidates: budget.oosCandidates,
    maxWalkForwardWindows: budget.maxWalkForwardWindows,
  });
  const candidates = base.candidates.map((candidate) => {
    const sample = classifyScalpingSample(candidate);
    const lowSample = sample.oosTradeCount < 10;
    return Object.freeze({
      ...candidate,
      ...sample,
      researchStatus: lowSample ? "research_hold" : candidate.researchStatus,
      promotionBlockedByLowSample: lowSample,
      candidateFreezeAllowed: false,
      finalHoldoutQueueAllowed: false,
    });
  });
  return Object.freeze({
    ...base,
    mode: "automated-v1-scalping-research",
    strategyType: "SCALPING",
    parameterSpace: "SCALPING_V1_PARAMETER_BOUNDS",
    researchBudget: Object.freeze({ ...budget }),
    candidates: Object.freeze(candidates),
    topStrategy: null,
    crossSymbolValidation: "preliminary",
    candidateFreezeAllowed: false,
    finalHoldoutQueueAllowed: false,
    finalHoldoutExecuted: false,
  });
}

export function buildScalpingCrossSymbolDiagnostics(results = []) {
  const groups = new Map();
  for (const result of results) {
    const direction = result.side === "short" ? "SHORT" : "LONG";
    const group = result.market === "CRYPTO_SPOT" ? "CRYPTO_SPOT_SCALPING" : `CRYPTO_FUTURES_SCALPING_${direction}`;
    const rows = groups.get(group) ?? [];
    rows.push(result);
    groups.set(group, rows);
  }
  return Object.freeze([...groups.entries()].map(([group, rows]) => {
    const symbols = [...new Set(rows.map((row) => row.symbol))].sort();
    const byCandidate = new Map();
    for (const row of rows) {
      for (const candidate of row.candidates) {
        const existing = byCandidate.get(candidate.id) ?? [];
        existing.push({ symbol: row.symbol, candidate });
        byCandidate.set(candidate.id, existing);
      }
    }
    const common = [...byCandidate.entries()].filter(([, matches]) => new Set(matches.map((match) => match.symbol)).size === symbols.length).map(([candidateId, matches]) => {
      const positiveReturns = matches.map((match) => Math.max(0, match.candidate.oosMetrics.totalReturn ?? 0));
      const positiveTotal = positiveReturns.reduce((sum, value) => sum + value, 0);
      const symbolDependency = positiveTotal > 0 ? Math.max(...positiveReturns) / positiveTotal : null;
      const qualityScore = matches.reduce((sum, match) => sum + match.candidate.qualityScore, 0) / matches.length;
      const totalOosTrades = matches.reduce((sum, match) => sum + match.candidate.oosTradeCount, 0);
      const status = matches.some((match) => match.candidate.researchStatus === "research_hold") ? "research_hold" : "candidate";
      return Object.freeze({
        candidateId,
        symbols: Object.freeze(matches.map((match) => match.symbol).sort()),
        averageQualityScore: Number(qualityScore.toFixed(6)),
        totalOosTrades,
        symbolDependency,
        status,
      });
    }).sort((a, b) => b.averageQualityScore - a.averageQualityScore || a.candidateId.localeCompare(b.candidateId));
    return Object.freeze({
      group,
      crossSymbolValidation: "preliminary",
      symbols: Object.freeze(symbols),
      symbolCount: symbols.length,
      commonCandidateCount: common.length,
      candidates: Object.freeze(common),
      fullMarketStabilityValidated: false,
      candidateFreezeAllowed: false,
      finalHoldoutQueueAllowed: false,
      topStrategy: null,
    });
  }));
}
