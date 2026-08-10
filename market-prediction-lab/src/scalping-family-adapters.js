import { RESEARCH_BACKTEST_PERIOD, runV1Backtest } from "./multi-market-backtest-engine.js";
import { runScalpingV1Research } from "./scalping-v1-research.js";
import { buildV3FilterCandidates, runV3FilteredBacktest } from "./v3-market-filter-optimizer.js";
import { buildV4FilterCandidates, runV4FilteredBacktest } from "./v4-momentum-regime-optimizer.js";
import { buildV5FilterCandidates, runV5FilteredBacktest } from "./v5-price-structure-optimizer.js";
import { buildV6Candidates } from "./v6-independent-breakout-retest-optimizer.js";
import { evaluateUnifiedCandidate } from "./unified-candidate-evaluator.js";

export const SCALPING_FAMILY_BUDGET = Object.freeze({
  maxCoarseCandidates: 16,
  promisingRegions: 4,
  maxFineCandidates: 16,
  oosAdmissions: 6,
  maxWalkForwardWindows: 6,
});

export const SCALPING_FAMILY_CONTRACTS = Object.freeze({
  V2: Object.freeze({
    family: "V2_SCALPING",
    structuralFamily: "EMA_ATR_SHARED",
    priorCompatibility: "NEEDS_SCALPING_ADAPTER",
    adaptedCompatibility: "SCALPING_COMPATIBLE",
    timeframeAssumption: "15m_only",
    featureLookback: "EMA fast/slow + ATR",
    entryRule: "directional EMA trend with bounded pullback",
    exitRule: "ATR stop and fixed risk-multiple target",
    stop: "stopAtrMultiple",
    takeProfit: "targetRiskMultiple",
    riskSizing: "existing risk engine input; no leverage auto-promotion",
    liquidityAssumption: "explicit spread/slippage cost model supplied by venue",
    fundingApplicability: "futures only; actual historical same-venue funding required",
    parameterProvenance: "15m bounded coarse/fine search; no daily/swing parameter copy",
  }),
  V3: Object.freeze({
    family: "V3_RVOL_TREND_SCALPING",
    structuralFamily: "EMA_ATR_PLUS_RVOL_TREND",
    priorCompatibility: "NEEDS_SCALPING_ADAPTER",
    adaptedCompatibility: "SCALPING_COMPATIBLE",
    timeframeAssumption: "15m_only",
    featureLookback: "RVOL20 + volume expansion5 + EMA spread/ATR",
    entryRule: "15m V2 seed signal plus RVOL/volume-expansion/trend-strength filter",
    exitRule: "15m V2 ATR stop/target; filter affects entry only",
    stop: "V2 15m stopAtrMultiple",
    takeProfit: "V2 15m targetRiskMultiple",
    riskSizing: "existing risk engine input",
    liquidityAssumption: "volume filter plus explicit spread/slippage costs",
    fundingApplicability: "futures same-venue historical funding; spot N/A",
    parameterProvenance: "15m V2 development seed + bounded V3 filter search",
  }),
  V4: Object.freeze({
    family: "V4_REGIME_MOMENTUM_SCALPING",
    structuralFamily: "EMA_ATR_PLUS_REGIME_MOMENTUM",
    priorCompatibility: "NEEDS_SCALPING_ADAPTER",
    adaptedCompatibility: "SCALPING_COMPATIBLE",
    timeframeAssumption: "15m_only",
    featureLookback: "EMA200 regime + EMA slope + RSI14 + MACD12/26/9",
    entryRule: "15m V2 seed signal plus bounded regime/momentum confirmation",
    exitRule: "15m V2 ATR stop/target",
    stop: "V2 15m stopAtrMultiple",
    takeProfit: "V2 15m targetRiskMultiple",
    riskSizing: "existing risk engine input",
    liquidityAssumption: "explicit spread/slippage costs; no liquidity inference from daily bars",
    fundingApplicability: "futures same-venue historical funding; spot N/A",
    parameterProvenance: "15m V2 development seed + bounded V4 filter search",
  }),
  V5: Object.freeze({
    family: "V5_BREAKOUT_RETEST_SCALPING",
    structuralFamily: "EMA_ATR_PLUS_PRICE_STRUCTURE",
    priorCompatibility: "NEEDS_SCALPING_ADAPTER",
    adaptedCompatibility: "SCALPING_COMPATIBLE",
    timeframeAssumption: "15m_only",
    featureLookback: "bounded structure lookback + breakout recency + ATR retest tolerance",
    entryRule: "15m V2 seed signal plus price-structure breakout/retest filter",
    exitRule: "15m V2 ATR stop/target",
    stop: "V2 15m stopAtrMultiple",
    takeProfit: "V2 15m targetRiskMultiple",
    riskSizing: "existing risk engine input",
    liquidityAssumption: "explicit spread/slippage costs",
    fundingApplicability: "futures same-venue historical funding; spot N/A",
    parameterProvenance: "15m V2 development seed + bounded V5 filter search",
  }),
  V6: Object.freeze({
    family: "V6_INDEPENDENT_BREAKOUT_SCALPING",
    structuralFamily: "INDEPENDENT_BREAKOUT_RETEST",
    priorCompatibility: "NEEDS_SCALPING_ADAPTER",
    adaptedCompatibility: "SCALPING_COMPATIBLE",
    timeframeAssumption: "15m_only",
    featureLookback: "bounded structure lookback + breakout recency + ATR retest confirmation",
    entryRule: "independent breakout/retest signal; does not require EMA crossover entry",
    exitRule: "risk/exit parameters recalibrated from 15m development seed only",
    stop: "15m development-derived ATR stop",
    takeProfit: "15m development-derived risk-multiple target",
    riskSizing: "existing risk engine input",
    liquidityAssumption: "explicit spread/slippage costs",
    fundingApplicability: "futures same-venue historical funding; spot N/A",
    parameterProvenance: "independent V6 15m filter search + 15m-only risk/exit seed",
  }),
});

function sampleBounded(rows, maximum) {
  if (rows.length <= maximum) return Object.freeze([...rows]);
  const selected = [];
  const seen = new Set();
  for (let index = 0; index < maximum; index += 1) {
    const sourceIndex = Math.round(index * (rows.length - 1) / Math.max(1, maximum - 1));
    if (!seen.has(sourceIndex)) {
      seen.add(sourceIndex);
      selected.push(rows[sourceIndex]);
    }
  }
  return Object.freeze(selected);
}

function developmentPeriod() {
  return Object.freeze({
    startTime: RESEARCH_BACKTEST_PERIOD.startTime,
    endTime: RESEARCH_BACKTEST_PERIOD.developmentEndTime,
    includeFinalHoldout: false,
  });
}

function finite(value, fallback = Number.NEGATIVE_INFINITY) {
  return Number.isFinite(value) ? value : fallback;
}

function compactDevelopment(result) {
  return Object.freeze({
    trades: result?.totalTrades ?? result?.performance?.overall?.sampleCount ?? 0,
    expectancy: result?.expectancy ?? result?.performance?.overall?.expectancy ?? null,
    profitFactor: result?.profitFactor ?? result?.performance?.overall?.profitFactor ?? null,
    totalReturnPercent: result?.totalReturnPercent ?? ((result?.performance?.overall?.totalReturn ?? 0) * 100),
    maximumDrawdownPercent: result?.maximumDrawdownPercent ?? ((result?.performance?.overall?.maximumDrawdownPercent ?? 0) * 100),
  });
}

function developmentComparator(left, right) {
  const a = left.development;
  const b = right.development;
  const aPositive = finite(a.expectancy, -Infinity) > 0 ? 1 : 0;
  const bPositive = finite(b.expectancy, -Infinity) > 0 ? 1 : 0;
  return bPositive - aPositive
    || finite(b.totalReturnPercent) - finite(a.totalReturnPercent)
    || finite(b.profitFactor) - finite(a.profitFactor)
    || finite(a.maximumDrawdownPercent, Infinity) - finite(b.maximumDrawdownPercent, Infinity)
    || left.id.localeCompare(right.id);
}

function bestV2DevelopmentSeed(v2) {
  const rows = [...(v2.candidates ?? [])].filter((row) => row?.parameters);
  rows.sort((a, b) => {
    const ad = a.developmentMetrics ?? {};
    const bd = b.developmentMetrics ?? {};
    return (finite(bd.totalReturn) - finite(ad.totalReturn))
      || (finite(bd.expectancy) - finite(ad.expectancy))
      || String(a.id).localeCompare(String(b.id));
  });
  return rows[0] ?? null;
}

function optimizationFor(version, parameters, filter) {
  if (version === "V2") return Object.freeze({ status: "candidate", strategyCandidate: "V2_SCALPING", preferred: Object.freeze({ parameters }) });
  if (["V3", "V4", "V5"].includes(version)) return Object.freeze({
    status: "candidate",
    strategyCandidate: SCALPING_FAMILY_CONTRACTS[version].family,
    frozenV2Parameters: parameters,
    preferred: Object.freeze({ filter }),
  });
  return Object.freeze({
    status: "candidate",
    strategyCandidate: SCALPING_FAMILY_CONTRACTS.V6.family,
    frozenRiskExitParameters: parameters,
    preferred: Object.freeze({ filter }),
  });
}

function runDevelopment(version, backtestInput, parameters, filter) {
  const period = developmentPeriod();
  if (version === "V2") return runV1Backtest({ ...backtestInput, parameters, period });
  if (version === "V3") return runV3FilteredBacktest({ backtestInput, parameters, filter, period });
  if (version === "V4") return runV4FilteredBacktest({ backtestInput, parameters, filter, period });
  if (version === "V5") return runV5FilteredBacktest({ backtestInput, parameters, filter, period });
  const candidate = evaluateUnifiedCandidate({ version: "V6", optimization: optimizationFor("V6", parameters, filter), backtestInput, maxWalkForwardWindows: 1 });
  return Object.freeze({
    totalTrades: candidate.development?.tradeCount ?? 0,
    expectancy: candidate.development?.expectancy ?? null,
    profitFactor: candidate.development?.profitFactor ?? null,
    totalReturnPercent: Number.isFinite(candidate.development?.totalReturn) ? candidate.development.totalReturn * 100 : null,
    maximumDrawdownPercent: Number.isFinite(candidate.development?.maximumDrawdown) ? candidate.development.maximumDrawdown * 100 : null,
  });
}

function coarseFilters(version) {
  if (version === "V3") return sampleBounded(buildV3FilterCandidates(), SCALPING_FAMILY_BUDGET.maxCoarseCandidates);
  if (version === "V4") return sampleBounded(buildV4FilterCandidates(), SCALPING_FAMILY_BUDGET.maxCoarseCandidates);
  if (version === "V5") return sampleBounded(buildV5FilterCandidates(), SCALPING_FAMILY_BUDGET.maxCoarseCandidates);
  if (version === "V6") return sampleBounded(buildV6Candidates(), SCALPING_FAMILY_BUDGET.maxCoarseCandidates);
  return Object.freeze([]);
}

function fineNeighbors(version, filter) {
  const rows = [filter];
  const push = (value) => rows.push(Object.freeze(value));
  if (version === "V3") {
    for (const delta of [-0.1, 0.1]) push({ ...filter, rvolMin: Math.max(0.1, Number((filter.rvolMin + delta).toFixed(2))) });
    for (const delta of [-0.1, 0.1]) push({ ...filter, volumeExpansionMin: Math.max(0.1, Number((filter.volumeExpansionMin + delta).toFixed(2))) });
    for (const delta of [-0.1, 0.1]) push({ ...filter, trendStrengthMin: Math.max(0.05, Number((filter.trendStrengthMin + delta).toFixed(2))) });
  } else if (version === "V4") {
    for (const delta of [-0.025, 0.025]) push({ ...filter, emaSlopeAtrMin: Math.max(0, Number((filter.emaSlopeAtrMin + delta).toFixed(3))) });
    for (const delta of [-2.5, 2.5]) push({ ...filter, rsiDirectionalThreshold: Math.min(80, Math.max(50, filter.rsiDirectionalThreshold + delta)) });
  } else if (version === "V5") {
    for (const delta of [-5, 5]) push({ ...filter, structureLookback: Math.min(250, Math.max(5, filter.structureLookback + delta)) });
    for (const delta of [-1, 1]) push({ ...filter, breakoutRecencyBars: Math.min(50, Math.max(1, filter.breakoutRecencyBars + delta)) });
    for (const delta of [-0.125, 0.125]) push({ ...filter, retestToleranceAtr: Math.min(3, Math.max(0, Number((filter.retestToleranceAtr + delta).toFixed(3)))) });
  } else if (version === "V6") {
    for (const delta of [-5, 5]) push({ ...filter, structureLookback: Math.min(250, Math.max(5, filter.structureLookback + delta)) });
    for (const delta of [-1, 1]) push({ ...filter, breakoutRecencyBars: Math.min(20, Math.max(1, filter.breakoutRecencyBars + delta)) });
    for (const delta of [-0.125, 0.125]) push({ ...filter, retestToleranceAtr: Math.min(2, Math.max(0, Number((filter.retestToleranceAtr + delta).toFixed(3)))) });
  }
  const unique = new Map(rows.map((row) => [JSON.stringify(row), Object.freeze(row)]));
  return Object.freeze([...unique.values()]);
}

function researchStatus(candidate) {
  if (!candidate?.oos) return "research_hold";
  if ((candidate.oos.tradeCount ?? 0) < 10) return "research_hold";
  if (!(candidate.oos.expectancy > 0) || !(candidate.oos.profitFactor > 1) || !(candidate.oos.totalReturn > 0)) return "research_hold";
  if ((candidate.walkForward?.stability?.profitableWindowsRatio ?? 0) < 0.5) return "research_hold";
  return "candidate";
}

export function runScalpingFamilyAdapters({ backtestInput, budget = SCALPING_FAMILY_BUDGET } = {}) {
  if (!backtestInput || backtestInput.timeframe !== "15m") throw new TypeError("15m backtestInput required");
  const v2Base = runScalpingV1Research({ backtestInput, budget: Object.freeze({
    maxCoarseCandidates: budget.maxCoarseCandidates,
    maxFineCandidates: budget.maxFineCandidates,
    developmentSeeds: Math.min(6, budget.promisingRegions + 2),
    oosCandidates: budget.oosAdmissions,
    maxWalkForwardWindows: budget.maxWalkForwardWindows,
  }) });
  const seed = bestV2DevelopmentSeed(v2Base);
  if (!seed) throw new Error("V2_SCALPING_NO_DEVELOPMENT_SEED");
  const families = [];
  const v2Evaluations = (v2Base.candidates ?? []).slice(0, budget.oosAdmissions).map((candidate) => Object.freeze({
    family: "V2_SCALPING",
    structuralFamily: "EMA_ATR_SHARED",
    candidateId: candidate.id,
    parameters: candidate.parameters,
    filter: null,
    development: candidate.developmentMetrics,
    oos: candidate.oosMetrics,
    walkForward: candidate.walkForward,
    statisticalQuality: candidate.statisticalQuality,
    overfitDiagnostics: candidate.overfitDiagnostics,
    researchStatus: candidate.researchStatus,
    finalHoldoutUsed: false,
  }));
  families.push(Object.freeze({
    version: "V2",
    contract: SCALPING_FAMILY_CONTRACTS.V2,
    parameterCount: Object.keys(seed.parameters).length,
    developmentAttempts: v2Base.candidateCounts?.development ?? 0,
    oosAdmissions: v2Evaluations.length,
    wfAdmissions: v2Evaluations.filter((row) => (row.walkForward?.windows?.length ?? 0) > 0).length,
    totalCandidatesTested: (v2Base.candidateCounts?.coarse ?? 0) + (v2Base.candidateCounts?.fine ?? 0),
    candidates: Object.freeze(v2Evaluations),
  }));

  for (const version of ["V3", "V4", "V5", "V6"]) {
    const coarse = coarseFilters(version);
    const developmentRows = coarse.map((filter, index) => Object.freeze({
      id: `${version}-coarse-${index}`,
      filter,
      development: compactDevelopment(runDevelopment(version, backtestInput, seed.parameters, filter)),
      stage: "coarse",
    })).sort(developmentComparator);
    const promising = developmentRows.slice(0, budget.promisingRegions);
    const finePool = sampleBounded(promising.flatMap((row) => fineNeighbors(version, row.filter)), budget.maxFineCandidates);
    const fineRows = finePool.map((filter, index) => Object.freeze({
      id: `${version}-fine-${index}`,
      filter,
      development: compactDevelopment(runDevelopment(version, backtestInput, seed.parameters, filter)),
      stage: "fine",
    })).sort(developmentComparator);
    const admissionsMap = new Map([...promising, ...fineRows].sort(developmentComparator).map((row) => [JSON.stringify(row.filter), row]));
    const admissions = [...admissionsMap.values()].sort(developmentComparator).slice(0, budget.oosAdmissions);
    const evaluated = admissions.map((row) => {
      const candidate = evaluateUnifiedCandidate({
        version,
        optimization: optimizationFor(version, seed.parameters, row.filter),
        backtestInput,
        maxWalkForwardWindows: budget.maxWalkForwardWindows,
      });
      return Object.freeze({
        ...candidate,
        family: SCALPING_FAMILY_CONTRACTS[version].family,
        structuralFamily: SCALPING_FAMILY_CONTRACTS[version].structuralFamily,
        searchStage: row.stage,
        researchStatus: researchStatus(candidate),
        finalHoldoutUsed: false,
      });
    });
    families.push(Object.freeze({
      version,
      contract: SCALPING_FAMILY_CONTRACTS[version],
      parameterCount: Object.keys(seed.parameters).length + Object.keys(admissions[0]?.filter ?? {}).length,
      developmentAttempts: developmentRows.length + fineRows.length,
      oosAdmissions: evaluated.length,
      wfAdmissions: evaluated.filter((row) => (row.walkForward?.windows?.length ?? 0) > 0).length,
      totalCandidatesTested: developmentRows.length + fineRows.length,
      coarseCandidateCount: developmentRows.length,
      fineCandidateCount: fineRows.length,
      candidates: Object.freeze(evaluated),
    }));
  }

  return Object.freeze({
    mode: "bounded-15m-scalping-family-adapters",
    market: backtestInput.market,
    symbol: backtestInput.symbol,
    direction: String(backtestInput.side ?? "long").toUpperCase(),
    timeframe: "15m",
    budget: Object.freeze({ ...budget }),
    v2DevelopmentSeedId: seed.id,
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
