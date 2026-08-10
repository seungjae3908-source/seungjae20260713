import { RESEARCH_BACKTEST_PERIOD, runV1Backtest } from "./multi-market-backtest-engine.js";
import { runScalpingV1Research } from "./scalping-v1-research.js";
import { buildV3FilterCandidates, runV3FilteredBacktest } from "./v3-market-filter-optimizer.js";
import { buildV4FilterCandidates, runV4FilteredBacktest } from "./v4-momentum-regime-optimizer.js";
import { buildV5FilterCandidates, runV5FilteredBacktest } from "./v5-price-structure-optimizer.js";
import { buildV6Candidates, calculateV6Signal } from "./v6-independent-breakout-retest-optimizer.js";
import { runIndependentSignalBacktest } from "./independent-strategy-backtest.js";
import { evaluateUnifiedCandidate } from "./unified-candidate-evaluator.js";

export const SCALPING_FAMILY_RESEARCH_BUDGET = Object.freeze({
  maxCoarseCandidates: 16,
  promisingRegions: 4,
  maxFineCandidates: 16,
  oosAdmissions: 6,
  maxWalkForwardWindows: 6,
});

export const SCALPING_ADAPTER_CONTRACTS = Object.freeze({
  V2: Object.freeze({ family: "V2_SCALPING", structuralFamily: "EMA_ATR_SHARED", timeframeAssumption: "15m_only", featureLookback: "EMA fast/slow and ATR", entryRule: "directional EMA trend plus bounded pullback", exitRule: "ATR stop plus fixed risk-multiple target", stop: "stopAtrMultiple", takeProfit: "targetRiskMultiple", riskSizing: "existing risk input only", liquidityAssumption: "explicit venue cost model", spreadSlippage: "explicit cost model", fundingApplicability: "futures actual same-venue funding only", parameterProvenance: "15m bounded coarse-promising-fine; no swing parameter copy" }),
  V3: Object.freeze({ family: "V3_RVOL_TREND_SCALPING", structuralFamily: "EMA_ATR_PLUS_RVOL_TREND", timeframeAssumption: "15m_only", featureLookback: "RVOL20, volume expansion5, EMA spread/ATR", entryRule: "15m V2 development seed plus RVOL/volume/trend filter", exitRule: "15m V2 ATR stop/target", stop: "15m V2 seed", takeProfit: "15m V2 seed", riskSizing: "existing risk input only", liquidityAssumption: "RVOL filter plus explicit costs", spreadSlippage: "explicit cost model", fundingApplicability: "futures actual same-venue funding only", parameterProvenance: "15m V2 Development seed plus bounded V3 filter search" }),
  V4: Object.freeze({ family: "V4_REGIME_MOMENTUM_SCALPING", structuralFamily: "EMA_ATR_PLUS_REGIME_MOMENTUM", timeframeAssumption: "15m_only", featureLookback: "EMA200 regime, EMA slope, RSI14, MACD12/26/9", entryRule: "15m V2 development seed plus regime/momentum confirmation", exitRule: "15m V2 ATR stop/target", stop: "15m V2 seed", takeProfit: "15m V2 seed", riskSizing: "existing risk input only", liquidityAssumption: "explicit costs; no daily liquidity inference", spreadSlippage: "explicit cost model", fundingApplicability: "futures actual same-venue funding only", parameterProvenance: "15m V2 Development seed plus bounded V4 filter search" }),
  V5: Object.freeze({ family: "V5_BREAKOUT_RETEST_SCALPING", structuralFamily: "EMA_ATR_PLUS_PRICE_STRUCTURE", timeframeAssumption: "15m_only", featureLookback: "structure lookback, breakout recency, ATR retest tolerance", entryRule: "15m V2 development seed plus price-structure filter", exitRule: "15m V2 ATR stop/target", stop: "15m V2 seed", takeProfit: "15m V2 seed", riskSizing: "existing risk input only", liquidityAssumption: "explicit cost model", spreadSlippage: "explicit cost model", fundingApplicability: "futures actual same-venue funding only", parameterProvenance: "15m V2 Development seed plus bounded V5 filter search" }),
  V6: Object.freeze({ family: "V6_INDEPENDENT_BREAKOUT_SCALPING", structuralFamily: "INDEPENDENT_BREAKOUT_RETEST", timeframeAssumption: "15m_only", featureLookback: "structure lookback, breakout recency, ATR retest confirmation", entryRule: "independent breakout/retest signal", exitRule: "15m-only risk/exit seed", stop: "15m development-derived ATR stop", takeProfit: "15m development-derived risk multiple", riskSizing: "existing risk input only", liquidityAssumption: "explicit cost model", spreadSlippage: "explicit cost model", fundingApplicability: "futures actual same-venue funding only", parameterProvenance: "independent 15m V6 filter search with 15m risk/exit seed" }),
});

function boundedSample(rows, maximum) {
  if (rows.length <= maximum) return Object.freeze([...rows]);
  const selected = [];
  const seen = new Set();
  for (let index = 0; index < maximum; index += 1) {
    const sourceIndex = Math.round(index * (rows.length - 1) / Math.max(1, maximum - 1));
    if (!seen.has(sourceIndex)) { seen.add(sourceIndex); selected.push(rows[sourceIndex]); }
  }
  return Object.freeze(selected);
}

function developmentPeriod() {
  return Object.freeze({ startTime: RESEARCH_BACKTEST_PERIOD.startTime, endTime: RESEARCH_BACKTEST_PERIOD.developmentEndTime, includeFinalHoldout: false });
}

function compactDevelopment(result) {
  const overall = result?.performance?.overall ?? {};
  return Object.freeze({
    tradeCount: result?.totalTrades ?? overall.sampleCount ?? 0,
    expectancy: result?.expectancy ?? overall.expectancy ?? null,
    profitFactor: result?.profitFactor ?? overall.profitFactor ?? null,
    totalReturn: Number.isFinite(overall.totalReturn) ? overall.totalReturn : Number.isFinite(result?.totalReturnPercent) ? result.totalReturnPercent / 100 : null,
    maximumDrawdown: Number.isFinite(overall.maximumDrawdownPercent) ? overall.maximumDrawdownPercent : Number.isFinite(result?.maximumDrawdownPercent) ? result.maximumDrawdownPercent / 100 : null,
  });
}

function finite(value, fallback) { return Number.isFinite(value) ? value : fallback; }
function compareDevelopment(left, right) {
  const a = left.development; const b = right.development;
  const ap = finite(a.expectancy, -Infinity) > 0 ? 1 : 0;
  const bp = finite(b.expectancy, -Infinity) > 0 ? 1 : 0;
  return bp - ap || finite(b.totalReturn, -Infinity) - finite(a.totalReturn, -Infinity) || finite(b.profitFactor, -Infinity) - finite(a.profitFactor, -Infinity) || finite(a.maximumDrawdown, Infinity) - finite(b.maximumDrawdown, Infinity) || left.id.localeCompare(right.id);
}

function bestDevelopmentSeed(v2) {
  return [...(v2.candidates ?? [])].filter((row) => row?.parameters).sort((a, b) => {
    const ad = a.developmentMetrics ?? {}; const bd = b.developmentMetrics ?? {};
    return finite(bd.totalReturn, -Infinity) - finite(ad.totalReturn, -Infinity) || finite(bd.expectancy, -Infinity) - finite(ad.expectancy, -Infinity) || String(a.id).localeCompare(String(b.id));
  })[0] ?? null;
}

function optimization(version, parameters, filter) {
  if (["V3", "V4", "V5"].includes(version)) return Object.freeze({ status: "candidate", strategyCandidate: SCALPING_ADAPTER_CONTRACTS[version].family, frozenV2Parameters: parameters, preferred: Object.freeze({ filter }) });
  return Object.freeze({ status: "candidate", strategyCandidate: SCALPING_ADAPTER_CONTRACTS.V6.family, frozenRiskExitParameters: parameters, preferred: Object.freeze({ filter }) });
}

function runDevelopmentOnly(version, backtestInput, parameters, filter) {
  const period = developmentPeriod();
  if (version === "V3") return runV3FilteredBacktest({ backtestInput, parameters, filter, period });
  if (version === "V4") return runV4FilteredBacktest({ backtestInput, parameters, filter, period });
  if (version === "V5") return runV5FilteredBacktest({ backtestInput, parameters, filter, period });
  if (version === "V6") return runIndependentSignalBacktest({
    backtestInput,
    strategy: "v6_independent_breakout_retest_scalping",
    strategyVersion: "V6_SCALPING",
    parameters,
    period,
    signalEvaluator: ({ side, candles, atr, index }) => calculateV6Signal({ side, candles, atr, index, filter }),
  });
  return runV1Backtest({ ...backtestInput, parameters, period });
}

function coarseFilters(version) {
  if (version === "V3") return boundedSample(buildV3FilterCandidates(), SCALPING_FAMILY_RESEARCH_BUDGET.maxCoarseCandidates);
  if (version === "V4") return boundedSample(buildV4FilterCandidates(), SCALPING_FAMILY_RESEARCH_BUDGET.maxCoarseCandidates);
  if (version === "V5") return boundedSample(buildV5FilterCandidates(), SCALPING_FAMILY_RESEARCH_BUDGET.maxCoarseCandidates);
  return boundedSample(buildV6Candidates(), SCALPING_FAMILY_RESEARCH_BUDGET.maxCoarseCandidates);
}

function fineNeighbors(version, filter) {
  const rows = [Object.freeze({ ...filter })];
  const add = (value) => rows.push(Object.freeze(value));
  if (version === "V3") {
    for (const d of [-0.1, 0.1]) add({ ...filter, rvolMin: Math.max(0.1, Number((filter.rvolMin + d).toFixed(2))) });
    for (const d of [-0.1, 0.1]) add({ ...filter, volumeExpansionMin: Math.max(0.1, Number((filter.volumeExpansionMin + d).toFixed(2))) });
    for (const d of [-0.1, 0.1]) add({ ...filter, trendStrengthMin: Math.max(0.05, Number((filter.trendStrengthMin + d).toFixed(2))) });
  } else if (version === "V4") {
    for (const d of [-0.025, 0.025]) add({ ...filter, emaSlopeAtrMin: Math.max(0, Number((filter.emaSlopeAtrMin + d).toFixed(3))) });
    for (const d of [-2.5, 2.5]) add({ ...filter, rsiDirectionalThreshold: Math.min(80, Math.max(50, filter.rsiDirectionalThreshold + d)) });
  } else if (version === "V5") {
    for (const d of [-5, 5]) add({ ...filter, structureLookback: Math.min(250, Math.max(5, filter.structureLookback + d)) });
    for (const d of [-1, 1]) add({ ...filter, breakoutRecencyBars: Math.min(50, Math.max(1, filter.breakoutRecencyBars + d)) });
    for (const d of [-0.125, 0.125]) add({ ...filter, retestToleranceAtr: Math.min(3, Math.max(0, Number((filter.retestToleranceAtr + d).toFixed(3)))) });
  } else {
    for (const d of [-5, 5]) add({ ...filter, structureLookback: Math.min(250, Math.max(5, filter.structureLookback + d)) });
    for (const d of [-1, 1]) add({ ...filter, breakoutRecencyBars: Math.min(20, Math.max(1, filter.breakoutRecencyBars + d)) });
    for (const d of [-0.125, 0.125]) add({ ...filter, retestToleranceAtr: Math.min(2, Math.max(0, Number((filter.retestToleranceAtr + d).toFixed(3)))) });
  }
  return Object.freeze([...new Map(rows.map((row) => [JSON.stringify(row), row])).values()]);
}

function evaluateFamily(version, backtestInput, seed, budget) {
  const coarse = coarseFilters(version).map((filter, index) => Object.freeze({ id: `${version}-coarse-${index}`, stage: "coarse", filter, development: compactDevelopment(runDevelopmentOnly(version, backtestInput, seed.parameters, filter)) })).sort(compareDevelopment);
  const promising = coarse.slice(0, budget.promisingRegions);
  const finePool = boundedSample(promising.flatMap((row) => fineNeighbors(version, row.filter)), budget.maxFineCandidates);
  const fine = finePool.map((filter, index) => Object.freeze({ id: `${version}-fine-${index}`, stage: "fine", filter, development: compactDevelopment(runDevelopmentOnly(version, backtestInput, seed.parameters, filter)) })).sort(compareDevelopment);
  const unique = new Map([...promising, ...fine].sort(compareDevelopment).map((row) => [JSON.stringify(row.filter), row]));
  const admissions = [...unique.values()].sort(compareDevelopment).slice(0, budget.oosAdmissions);
  const candidates = admissions.map((row) => Object.freeze({
    ...evaluateUnifiedCandidate({ version, optimization: optimization(version, seed.parameters, row.filter), backtestInput, maxWalkForwardWindows: budget.maxWalkForwardWindows }),
    family: SCALPING_ADAPTER_CONTRACTS[version].family,
    structuralFamily: SCALPING_ADAPTER_CONTRACTS[version].structuralFamily,
    admissionStage: row.stage,
    developmentAdmissionMetrics: row.development,
    finalHoldoutUsed: false,
  }));
  return Object.freeze({
    version,
    contract: SCALPING_ADAPTER_CONTRACTS[version],
    parameterCount: Object.keys(seed.parameters).length + Object.keys(admissions[0]?.filter ?? {}).length,
    developmentAttempts: coarse.length + fine.length,
    oosAdmissions: candidates.length,
    wfAdmissions: candidates.filter((row) => (row.walkForward?.windows?.length ?? 0) > 0).length,
    totalCandidatesTested: coarse.length + fine.length,
    coarseCandidateCount: coarse.length,
    fineCandidateCount: fine.length,
    candidates: Object.freeze(candidates),
  });
}

export function runScalpingFamilyResearch({ backtestInput, budget = SCALPING_FAMILY_RESEARCH_BUDGET, versions = Object.keys(SCALPING_ADAPTER_CONTRACTS) } = {}) {
  if (!backtestInput || backtestInput.timeframe !== "15m") throw new TypeError("15m backtestInput required");
  if (!Array.isArray(backtestInput.candles) || backtestInput.candles.length === 0) throw new TypeError("real selection candles required");
  if (backtestInput.candles.some((row) => row.timestamp >= RESEARCH_BACKTEST_PERIOD.finalHoldoutStartTime)) throw new Error("SCALPING_FAMILY_FINAL_HOLDOUT_INPUT_FORBIDDEN");
  if (backtestInput.market === "CRYPTO_FUTURES" && !Array.isArray(backtestInput.fundingRates)) throw new TypeError("actual futures funding required");
  if (!Array.isArray(versions) || versions.length === 0) throw new TypeError("at least one scalping family version is required");
  const requestedVersions = Object.freeze([...new Set(versions)]);
  if (requestedVersions.some((version) => !Object.hasOwn(SCALPING_ADAPTER_CONTRACTS, version))) throw new TypeError("unsupported scalping family version");
  const v2 = runScalpingV1Research({ backtestInput, budget: Object.freeze({ maxCoarseCandidates: budget.maxCoarseCandidates, maxFineCandidates: budget.maxFineCandidates, developmentSeeds: Math.min(6, budget.promisingRegions + 2), oosCandidates: budget.oosAdmissions, maxWalkForwardWindows: budget.maxWalkForwardWindows }) });
  const seed = bestDevelopmentSeed(v2);
  if (!seed) throw new Error("V2_SCALPING_NO_DEVELOPMENT_SEED");
  const v2Candidates = Object.freeze((v2.candidates ?? []).slice(0, budget.oosAdmissions).map((row) => Object.freeze({ ...row, family: "V2_SCALPING", structuralFamily: "EMA_ATR_SHARED", finalHoldoutUsed: false })));
  const families = [];
  if (requestedVersions.includes("V2")) families.push(Object.freeze({ version: "V2", contract: SCALPING_ADAPTER_CONTRACTS.V2, parameterCount: Object.keys(seed.parameters).length, developmentAttempts: v2.candidateCounts?.development ?? 0, oosAdmissions: v2Candidates.length, wfAdmissions: v2Candidates.filter((row) => (row.walkForward?.windows?.length ?? 0) > 0).length, totalCandidatesTested: (v2.candidateCounts?.coarse ?? 0) + (v2.candidateCounts?.fine ?? 0), candidates: v2Candidates }));
  for (const version of requestedVersions.filter((version) => version !== "V2")) families.push(evaluateFamily(version, backtestInput, seed, budget));
  return Object.freeze({
    mode: "bounded-15m-scalping-family-research",
    market: backtestInput.market,
    symbol: backtestInput.symbol,
    direction: String(backtestInput.side ?? "long").toUpperCase(),
    timeframe: "15m",
    budget: Object.freeze({ ...budget }),
    requestedVersions,
    developmentSeedId: seed.id,
    families: Object.freeze(families),
    totalCandidatesTested: families.reduce((sum, row) => sum + row.totalCandidatesTested, 0),
    finalHoldoutStatus: "LOCKED",
    finalHoldoutUsed: false,
    candidateFreezeAllowed: false,
    finalHoldoutQueueAllowed: false,
    topStrategy: null,
    privateApiUsed: false,
    orderSubmitted: false,
  });
}
