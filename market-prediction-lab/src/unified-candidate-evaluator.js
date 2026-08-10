import { createHash } from "node:crypto";
import { RESEARCH_BACKTEST_PERIOD, runV1Backtest } from "./multi-market-backtest-engine.js";
import { buildLeakFreeWalkForward, computeWalkForwardStability } from "./automated-research-orchestrator.js";
import { runV3FilteredBacktest } from "./v3-market-filter-optimizer.js";
import { runV4FilteredBacktest } from "./v4-momentum-regime-optimizer.js";
import { runV5FilteredBacktest } from "./v5-price-structure-optimizer.js";
import { calculateV6Signal } from "./v6-independent-breakout-retest-optimizer.js";
import { runIndependentSignalBacktest } from "./independent-strategy-backtest.js";

export const UNIFIED_CANDIDATE_SCHEMA_VERSION = 1;
export const UNIFIED_SUPPORTED_VERSIONS = Object.freeze(["V2", "V3", "V4", "V5", "V6"]);

const TIMEFRAME_MS = Object.freeze({
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
});

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function finite(value) {
  return Number.isFinite(value) ? value : null;
}

function summarizeCosts(trades = []) {
  let fees = 0;
  let spread = 0;
  let slippage = 0;
  let funding = 0;
  let latency = 0;
  for (const trade of trades) {
    const costs = trade?.costs ?? trade?.execution?.costs ?? {};
    fees += (Number.isFinite(costs.entryFee) ? costs.entryFee : 0)
      + (Number.isFinite(costs.exitFee) ? costs.exitFee : 0)
      + (Number.isFinite(costs.tax) ? costs.tax : 0);
    spread += Number.isFinite(costs.spread) ? costs.spread : 0;
    slippage += Number.isFinite(costs.slippage) ? costs.slippage : 0;
    funding += Number.isFinite(costs.funding) ? costs.funding : 0;
    latency += Number.isFinite(costs.latency) ? costs.latency : 0;
  }
  return Object.freeze({ fees, spread, slippage, funding, latency });
}

function concentration(trades = []) {
  const winners = trades.map((trade) => trade.netPnl).filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => b - a);
  const grossProfit = winners.reduce((sum, value) => sum + value, 0);
  if (!(grossProfit > 0)) return Object.freeze({ largestWinnerShare: null, topTwoWinnerShare: null, winningTrades: winners.length });
  return Object.freeze({
    largestWinnerShare: winners[0] / grossProfit,
    topTwoWinnerShare: (winners[0] + (winners[1] ?? 0)) / grossProfit,
    winningTrades: winners.length,
  });
}

function regimeDiagnostics(trades = []) {
  const groups = new Map();
  for (const trade of trades) {
    const key = typeof trade?.regime === "string" ? trade.regime : JSON.stringify(trade?.regime ?? "unknown");
    const previous = groups.get(key) ?? { trades: 0, netPnl: 0 };
    groups.set(key, { trades: previous.trades + 1, netPnl: previous.netPnl + (Number.isFinite(trade?.netPnl) ? trade.netPnl : 0) });
  }
  const rows = [...groups.entries()].map(([regime, row]) => Object.freeze({ regime, ...row })).sort((a, b) => a.regime.localeCompare(b.regime));
  return Object.freeze({
    regimeCount: rows.length,
    profitableRegimeRatio: rows.length ? rows.filter((row) => row.netPnl > 0).length / rows.length : null,
    rows: Object.freeze(rows),
  });
}

function normalizeMetrics(result, period) {
  const trades = Array.isArray(result?.trades) ? result.trades : [];
  const overall = result?.performance?.overall ?? {};
  const averageWin = finite(overall.averageWin ?? result?.averageWin);
  const averageLoss = finite(overall.averageLoss ?? result?.averageLoss);
  const costs = summarizeCosts(trades);
  const exposureMs = trades.reduce((sum, trade) => {
    if (!Number.isFinite(trade?.entryTime) || !Number.isFinite(trade?.exitTime) || trade.exitTime < trade.entryTime) return sum;
    return sum + (trade.exitTime - trade.entryTime);
  }, 0);
  const periodMs = Number.isFinite(period?.startTime) && Number.isFinite(period?.endTime) && period.endTime > period.startTime
    ? period.endTime - period.startTime
    : null;
  const turnover = finite(overall.turnover ?? result?.turnover)
    ?? (Number.isFinite(result?.initialCapital) && result.initialCapital > 0
      ? trades.reduce((sum, trade) => sum + (Number.isFinite(trade?.entryNotional) ? trade.entryNotional : 0), 0) / result.initialCapital
      : null);
  return Object.freeze({
    tradeCount: Number.isFinite(overall.sampleCount) ? overall.sampleCount : Number.isFinite(result?.totalTrades) ? result.totalTrades : trades.length,
    expectancy: finite(overall.expectancy ?? result?.expectancy),
    profitFactor: finite(overall.profitFactor ?? result?.profitFactor),
    totalReturn: finite(overall.totalReturn) ?? (Number.isFinite(result?.totalReturnPercent) ? result.totalReturnPercent / 100 : null),
    maximumDrawdown: finite(overall.maximumDrawdownPercent) ?? (Number.isFinite(result?.maximumDrawdownPercent) ? result.maximumDrawdownPercent / 100 : null),
    sharpe: finite(overall.tradeSharpe ?? result?.tradeSharpe),
    winRate: finite(overall.winRate) ?? (Number.isFinite(result?.successRatePercent) ? result.successRatePercent / 100 : null),
    payoffRatio: Number.isFinite(averageWin) && Number.isFinite(averageLoss) && averageLoss > 0 ? averageWin / averageLoss : null,
    exposure: periodMs && periodMs > 0 ? Math.min(1, exposureMs / periodMs) : null,
    turnover,
    fees: costs.fees,
    spread: costs.spread,
    slippage: costs.slippage,
    funding: costs.funding,
    latency: costs.latency,
    totalExecutionCost: finite(overall.totalExecutionCost) ?? (costs.fees + costs.spread + costs.slippage + costs.funding + costs.latency),
    concentration: concentration(trades),
    regimePerformance: regimeDiagnostics(trades),
  });
}

const EXECUTION_COST_STRESS_MULTIPLIER = 2;
function stressCostModel(model = {}) {
  const stressRates = (row) => Object.freeze({
    ...row,
    entryFeeRate: (row.entryFeeRate ?? 0) * EXECUTION_COST_STRESS_MULTIPLIER,
    exitFeeRate: (row.exitFeeRate ?? 0) * EXECUTION_COST_STRESS_MULTIPLIER,
    taxRate: (row.taxRate ?? 0) * EXECUTION_COST_STRESS_MULTIPLIER,
    slippageRate: (row.slippageRate ?? 0) * EXECUTION_COST_STRESS_MULTIPLIER,
    spreadRate: (row.spreadRate ?? 0) * EXECUTION_COST_STRESS_MULTIPLIER,
    latencyBars: Math.min(100, Math.max(1, Math.round((row.latencyBars ?? 0) * EXECUTION_COST_STRESS_MULTIPLIER))),
    latencyDriftRate: (row.latencyDriftRate ?? 0) * EXECUTION_COST_STRESS_MULTIPLIER,
  });
  return Object.freeze({
    ...stressRates(model),
    ...(Array.isArray(model.schedule) ? { schedule: Object.freeze(model.schedule.map(stressRates)) } : {}),
  });
}

function stressFundingRates(rows = []) {
  return Object.freeze(rows.map((row) => Object.freeze({ ...row, rate: row.rate * EXECUTION_COST_STRESS_MULTIPLIER })));
}

function preferredCandidate(version, optimization) {
  if (!optimization || typeof optimization !== "object") return null;
  if (!optimization.preferred) return null;
  if (version === "V2") return Object.freeze({ parameters: optimization.preferred.parameters });
  if (["V3", "V4", "V5"].includes(version)) {
    if (!optimization.frozenV2Parameters || !optimization.preferred.filter) return null;
    return Object.freeze({ parameters: optimization.frozenV2Parameters, filter: optimization.preferred.filter });
  }
  if (version === "V6") {
    if (!optimization.frozenRiskExitParameters || !optimization.preferred.filter) return null;
    return Object.freeze({ parameters: optimization.frozenRiskExitParameters, filter: optimization.preferred.filter });
  }
  return null;
}

function runCandidate({ version, backtestInput, candidate, period }) {
  if (version === "V2") return runV1Backtest({ ...backtestInput, parameters: candidate.parameters, period });
  if (version === "V3") return runV3FilteredBacktest({ backtestInput, parameters: candidate.parameters, filter: candidate.filter, period });
  if (version === "V4") return runV4FilteredBacktest({ backtestInput, parameters: candidate.parameters, filter: candidate.filter, period });
  if (version === "V5") return runV5FilteredBacktest({ backtestInput, parameters: candidate.parameters, filter: candidate.filter, period });
  if (version === "V6") {
    return runIndependentSignalBacktest({
      backtestInput,
      strategy: "v6_independent_breakout_retest",
      strategyVersion: "V6",
      parameters: candidate.parameters,
      period,
      signalEvaluator: ({ side, candles, atr, index }) => calculateV6Signal({ side, candles, atr, index, filter: candidate.filter }),
    });
  }
  throw new TypeError(`unsupported unified version: ${version}`);
}

function walkForwardDefaults(timeframe, candleCount) {
  const intervalMs = TIMEFRAME_MS[timeframe];
  if (!intervalMs) throw new TypeError(`unsupported unified timeframe: ${timeframe}`);
  const barsPerDay = Math.max(1, Math.round((24 * 60 * 60 * 1000) / intervalMs));
  const trainSize = 365 * barsPerDay;
  const validationSize = 90 * barsPerDay;
  const testSize = 90 * barsPerDay;
  const stepSize = 90 * barsPerDay;
  if (candleCount < trainSize + validationSize + testSize) {
    const unit = Math.max(20, Math.floor(candleCount / 8));
    return Object.freeze({ trainSize: unit * 4, validationSize: unit, testSize: unit, stepSize: unit, embargoMs: intervalMs });
  }
  return Object.freeze({ trainSize, validationSize, testSize, stepSize, embargoMs: intervalMs });
}

function walkForwardWindows(backtestInput, options) {
  const intervalMs = TIMEFRAME_MS[backtestInput.timeframe];
  if (!intervalMs) throw new TypeError(`unsupported unified timeframe: ${backtestInput.timeframe}`);
  const records = (backtestInput.candles ?? [])
    .filter((candle) => candle.timestamp < RESEARCH_BACKTEST_PERIOD.finalHoldoutStartTime)
    .map((candle, index) => Object.freeze({ id: index, anchorTimestamp: candle.timestamp, futureEndTimestamp: candle.timestamp + intervalMs }));
  const folds = buildLeakFreeWalkForward(records, options ?? walkForwardDefaults(backtestInput.timeframe, records.length));
  return Object.freeze(folds.map((fold, index) => Object.freeze({
    index,
    startTime: fold.walkForwardTest[0].anchorTimestamp,
    endTime: fold.walkForwardTest.at(-1).anchorTimestamp,
    leakFree: fold.leakFree,
  })));
}

function sampleQuality(tradeCount) {
  if (!Number.isFinite(tradeCount) || tradeCount < 10) return "low_sample_research_hold";
  return "uncalibrated_not_a_pass";
}

function dependencyDiagnostics({ development, oos, wf }) {
  const topTradeDependency = Number.isFinite(oos?.concentration?.topTwoWinnerShare) && oos.concentration.topTwoWinnerShare > 0.75;
  const regimeDependency = Number.isFinite(oos?.regimePerformance?.profitableRegimeRatio)
    && oos.regimePerformance.regimeCount > 1
    && oos.regimePerformance.profitableRegimeRatio < 0.5;
  const profitableWindowsRatio = wf?.stability?.profitableWindowsRatio;
  const flags = [];
  if ((oos?.tradeCount ?? 0) < 10) flags.push("low_oos_trade_sample");
  if (development?.totalReturn > 0 && !(oos?.totalReturn > 0)) flags.push("development_to_oos_return_collapse");
  if (Number.isFinite(profitableWindowsRatio) && profitableWindowsRatio < 0.5) flags.push("walk_forward_window_dependency");
  if (topTradeDependency) flags.push("top_two_winner_dependency");
  if (regimeDependency) flags.push("regime_dependency");
  return Object.freeze({
    flags: Object.freeze(flags),
    topTradeDependency,
    regimeDependency,
    developmentToOosDegradation: development?.totalReturn > 0 && Number.isFinite(oos?.totalReturn)
      ? (development.totalReturn - oos.totalReturn) / Math.abs(development.totalReturn)
      : null,
    wfWindowDispersion: wf?.stability?.performanceDispersion ?? null,
  });
}

export function evaluateUnifiedCandidate({ version, optimization, backtestInput, maxWalkForwardWindows = 8, walkForwardOptions } = {}) {
  if (!UNIFIED_SUPPORTED_VERSIONS.includes(version)) throw new TypeError(`unsupported unified version: ${version}`);
  if (!backtestInput || typeof backtestInput !== "object") throw new TypeError("backtestInput is required");
  if (!Array.isArray(backtestInput.candles) || backtestInput.candles.length === 0) throw new TypeError("real historical candles are required");
  if (!Number.isInteger(maxWalkForwardWindows) || maxWalkForwardWindows <= 0) throw new RangeError("maxWalkForwardWindows must be positive");
  const candidate = preferredCandidate(version, optimization);
  const base = Object.freeze({
    schemaVersion: UNIFIED_CANDIDATE_SCHEMA_VERSION,
    version,
    strategy: optimization?.strategyCandidate ?? version,
    market: backtestInput.market,
    symbol: backtestInput.symbol,
    direction: (backtestInput.side ?? "long").toUpperCase(),
    timeframe: backtestInput.timeframe,
    sourceOptimizationStatus: optimization?.status ?? "missing",
    finalHoldoutStatus: "LOCKED",
    finalHoldoutUsed: false,
    finalHoldoutRetuningAllowed: false,
    liveOrderAllowed: false,
    privateAccountRequestAllowed: false,
    orderSubmitted: false,
  });
  if (!candidate) {
    return Object.freeze({
      ...base,
      candidateId: null,
      parameters: null,
      filter: null,
      development: null,
      oos: null,
      walkForward: null,
      statisticalQuality: Object.freeze({ sampleQuality: "not_evaluable_no_preferred_candidate", statisticalPass: false }),
      overfitDiagnostics: Object.freeze({ flags: Object.freeze(["no_preferred_candidate"]), topTradeDependency: false, regimeDependency: false, developmentToOosDegradation: null, wfWindowDispersion: null }),
      executionCostStress: Object.freeze({ status: "not_evaluated", scenarioId: "double_configured_execution_costs_v1", multiplier: EXECUTION_COST_STRESS_MULTIPLIER, baseline: null, stressed: null, positiveAfterStress: null, selectionAffected: false, finalHoldoutUsed: false, reasons: Object.freeze(["no_preferred_candidate"]) }),
      promotionEligible: false,
      researchStatus: "research_hold",
    });
  }

  const developmentPeriod = Object.freeze({ startTime: RESEARCH_BACKTEST_PERIOD.startTime, endTime: RESEARCH_BACKTEST_PERIOD.developmentEndTime, includeFinalHoldout: false });
  const oosPeriod = Object.freeze({ startTime: RESEARCH_BACKTEST_PERIOD.validationStartTime, endTime: RESEARCH_BACKTEST_PERIOD.validationEndTime, includeFinalHoldout: false });
  const developmentResult = runCandidate({ version, backtestInput, candidate, period: developmentPeriod });
  const oosResult = runCandidate({ version, backtestInput, candidate, period: oosPeriod });
  const development = normalizeMetrics(developmentResult, developmentPeriod);
  const oos = normalizeMetrics(oosResult, oosPeriod);
  const stressedBacktestInput = Object.freeze({
    ...backtestInput,
    costModel: stressCostModel(backtestInput.costModel),
    fundingRates: backtestInput.market === "CRYPTO_FUTURES" ? stressFundingRates(backtestInput.fundingRates ?? []) : (backtestInput.fundingRates ?? []),
  });
  const stressedOos = normalizeMetrics(runCandidate({ version, backtestInput: stressedBacktestInput, candidate, period: oosPeriod }), oosPeriod);
  const positiveAfterStress = stressedOos.totalReturn > 0 && stressedOos.expectancy > 0;
  const executionCostStress = Object.freeze({
    status: positiveAfterStress ? "survived" : "failed",
    scenarioId: "double_configured_execution_costs_v1",
    multiplier: EXECUTION_COST_STRESS_MULTIPLIER,
    baseline: oos,
    stressed: stressedOos,
    positiveAfterStress,
    includes: Object.freeze({ fee: true, spread: true, slippage: true, funding: backtestInput.market === "CRYPTO_FUTURES", latency: true }),
    selectionAffected: false,
    finalHoldoutUsed: false,
    reasons: Object.freeze(positiveAfterStress ? [] : ["non_positive_oos_return_or_expectancy_after_execution_cost_stress"]),
  });
  const windows = walkForwardWindows(backtestInput, walkForwardOptions).slice(-maxWalkForwardWindows);
  const wfRows = windows.map((window) => {
    const period = Object.freeze({ startTime: window.startTime, endTime: window.endTime, includeFinalHoldout: false });
    const metrics = normalizeMetrics(runCandidate({ version, backtestInput, candidate, period }), period);
    return Object.freeze({ window: window.index, startTime: window.startTime, endTime: window.endTime, leakFree: window.leakFree, ...metrics });
  });
  const stabilityInput = wfRows.map((row) => Object.freeze({ totalReturn: row.totalReturn, profitFactor: row.profitFactor, maximumDrawdown: row.maximumDrawdown }));
  const walkForward = Object.freeze({ windows: Object.freeze(wfRows), stability: computeWalkForwardStability(stabilityInput) });
  const wfTradeCount = wfRows.reduce((sum, row) => sum + (Number.isFinite(row.tradeCount) ? row.tradeCount : 0), 0);
  const diagnostics = dependencyDiagnostics({ development, oos, wf: walkForward });
  const quality = Object.freeze({
    developmentTradeCount: development.tradeCount,
    oosTradeCount: oos.tradeCount,
    wfTradeCount,
    totalIndependentTrades: oos.tradeCount,
    independentTradeCountMethod: "OOS only; WF windows may overlap OOS and are not double-counted",
    sampleQuality: sampleQuality(oos.tradeCount),
    statisticalPass: false,
    statisticalPassReason: oos.tradeCount < 10 ? "OOS below existing low-sample reference" : "performance/sample gates require empirical calibration; 10 trades is not a pass threshold",
  });
  const candidateId = `${version}:${digest({ market: backtestInput.market, symbol: backtestInput.symbol, side: backtestInput.side ?? "long", timeframe: backtestInput.timeframe, candidate })}`;
  return Object.freeze({
    ...base,
    candidateId,
    parameters: Object.freeze({ ...candidate.parameters }),
    filter: candidate.filter ? Object.freeze({ ...candidate.filter }) : null,
    development,
    oos,
    walkForward,
    statisticalQuality: quality,
    overfitDiagnostics: diagnostics,
    executionCostStress,
    promotionEligible: false,
    promotionBlockReasons: Object.freeze(["empirical_promotion_thresholds_uncalibrated", ...(positiveAfterStress ? [] : ["execution_cost_stress_failed"])]),
    crossSymbolValidation: "preliminary",
    crossSymbolScope: "per-symbol unified adapter; market-family aggregation required before freeze",
    researchStatus: "research_hold",
  });
}

export function buildUnifiedCalibrationRow(candidate) {
  if (!candidate || typeof candidate !== "object") throw new TypeError("candidate is required");
  return Object.freeze({
    market: candidate.market,
    strategy: candidate.strategy,
    version: candidate.version,
    symbol: candidate.symbol,
    direction: candidate.direction,
    timeframe: candidate.timeframe,
    parameters: candidate.parameters,
    filter: candidate.filter,
    developmentTradeCount: candidate.development?.tradeCount ?? null,
    oosTradeCount: candidate.oos?.tradeCount ?? null,
    wfTradeCount: candidate.statisticalQuality?.wfTradeCount ?? null,
    expectancy: candidate.oos?.expectancy ?? null,
    profitFactor: candidate.oos?.profitFactor ?? null,
    totalReturn: candidate.oos?.totalReturn ?? null,
    MDD: candidate.oos?.maximumDrawdown ?? null,
    sharpe: candidate.oos?.sharpe ?? null,
    winRate: candidate.oos?.winRate ?? null,
    payoffRatio: candidate.oos?.payoffRatio ?? null,
    exposure: candidate.oos?.exposure ?? null,
    turnover: candidate.oos?.turnover ?? null,
    fees: candidate.oos?.fees ?? null,
    spread: candidate.oos?.spread ?? null,
    slippage: candidate.oos?.slippage ?? null,
    stability: candidate.walkForward?.stability?.stabilityScore ?? null,
    regimeDependency: candidate.overfitDiagnostics?.regimeDependency ?? null,
    symbolDependency: null,
    topTradeDependency: candidate.overfitDiagnostics?.topTradeDependency ?? null,
    concentrationPenalty: candidate.overfitDiagnostics?.topTradeDependency ? 10 : 0,
    developmentToOosDegradation: candidate.overfitDiagnostics?.developmentToOosDegradation ?? null,
    wfWindowDispersion: candidate.overfitDiagnostics?.wfWindowDispersion ?? null,
    sampleQuality: candidate.statisticalQuality?.sampleQuality ?? null,
    executionCostStressStatus: candidate.executionCostStress?.status ?? "not_evaluated",
    stressedExpectancy: candidate.executionCostStress?.stressed?.expectancy ?? null,
    stressedProfitFactor: candidate.executionCostStress?.stressed?.profitFactor ?? null,
    stressedTotalReturn: candidate.executionCostStress?.stressed?.totalReturn ?? null,
    stressedMaximumDrawdown: candidate.executionCostStress?.stressed?.maximumDrawdown ?? null,
    promotionEligible: candidate.promotionEligible === true,
    researchStatus: candidate.researchStatus,
  });
}
