import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  BITGET_STANDARD_TAKER_RESEARCH_COSTS,
  HISTORICAL_V1_CRYPTO_SPECS,
} from "../src/historical-backtest-data.js";
import {
  RESEARCH_BACKTEST_PERIOD,
  V1_STRATEGY_ID,
  runV1Backtest,
} from "../src/multi-market-backtest-engine.js";
import {
  buildHistoricalDataset,
  buildScannerBacktestQualityArtifact,
  buildScannerBacktestQualityRow,
  classifyBacktestQuality,
} from "../src/long-history-data-layer.js";

const DAY = 24 * 60 * 60 * 1000;
const cacheRoot = resolve(process.argv[2] ?? "long-history-v1");
const researchPath = resolve(process.argv[3] ?? "artifacts/automated-research/v1-long-history.json");
const outputPath = resolve(process.argv[4] ?? "artifacts/automated-research/scanner-backtest-quality-v1.json");
const researchCodeSha = process.env.RESEARCH_CODE_SHA;
if (!/^[0-9a-f]{40}$/i.test(researchCodeSha ?? "")) throw new TypeError("RESEARCH_CODE_SHA must be an immutable 40-character SHA");
const generatedAtMs = Date.now();
const generatedAt = new Date(generatedAtMs).toISOString();

async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }
function median(values) {
  const rows = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!rows.length) return null;
  const middle = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[middle] : (rows[middle - 1] + rows[middle]) / 2;
}
function compact(result) {
  return Object.freeze({
    totalReturn: result.totalReturnPercent / 100,
    winRate: result.successRatePercent / 100,
    expectancy: result.expectancy,
    costAdjustedExpectancy: result.expectancy,
    profitFactor: Number.isFinite(result.profitFactor) ? result.profitFactor : null,
    maximumDrawdown: result.maximumDrawdownPercent / 100,
    tradeCount: result.totalTrades,
    averageWin: result.averageWin,
    averageLoss: result.averageLoss,
    sharpe: result.tradeSharpe,
    costImpact: result.totalExecutionCost,
  });
}
function summarizeWalkForward(walkForward) {
  const windows = walkForward?.windows ?? [];
  const totalTrades = windows.reduce((sum, row) => sum + (Number.isFinite(row.tradeCount) ? row.tradeCount : 0), 0);
  const weighted = (key) => totalTrades > 0
    ? windows.reduce((sum, row) => sum + (Number.isFinite(row[key]) && Number.isFinite(row.tradeCount) ? row[key] * row.tradeCount : 0), 0) / totalTrades
    : null;
  return Object.freeze({
    windowCount: windows.length,
    profitableWindowRatio: walkForward?.stability?.profitableWindowsRatio ?? null,
    medianReturn: median(windows.map((row) => row.totalReturn)),
    medianExpectancy: median(windows.map((row) => row.expectancy)),
    medianProfitFactor: median(windows.map((row) => row.profitFactor)),
    worstMaximumDrawdown: windows.length ? Math.max(...windows.map((row) => Number.isFinite(row.maximumDrawdown) ? row.maximumDrawdown : 0)) : null,
    winRate: weighted("winRate"),
    expectancy: weighted("expectancy"),
    profitFactor: median(windows.map((row) => row.profitFactor)),
    maximumDrawdown: windows.length ? Math.max(...windows.map((row) => Number.isFinite(row.maximumDrawdown) ? row.maximumDrawdown : 0)) : null,
    stabilityScore: walkForward?.stability?.stabilityScore ?? null,
    windows: Object.freeze(windows.map((row) => Object.freeze({ ...row }))),
  });
}
function specFor(datasetId) {
  const spec = HISTORICAL_V1_CRYPTO_SPECS.find((row) => row.id === datasetId);
  if (!spec) throw new Error(`unknown datasetId: ${datasetId}`);
  return spec;
}
function costFlags(market) {
  return Object.freeze({ fee: true, tax: market.endsWith("STOCK"), spread: true, slippage: true, latency: true, funding: market === "CRYPTO_FUTURES" });
}
function rankingDirection(side) { return side === "short" ? "SHORT" : "LONG"; }

const EXECUTION_COST_STRESS_MULTIPLIER = 2;
function stressCostModel(model) {
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
    ...(Array.isArray(model?.schedule) ? { schedule: Object.freeze(model.schedule.map(stressRates)) } : {}),
  });
}
function stressFundingRates(rows) {
  return Object.freeze(rows.map((row) => Object.freeze({ ...row, rate: row.rate * EXECUTION_COST_STRESS_MULTIPLIER })));
}
function buildExecutionCostStress({ spec, candles, fundingRates, candidate, side }) {
  const baseline = candidate.oosMetrics ?? null;
  const stressedResult = runV1Backtest({
    market: spec.market,
    symbol: spec.researchSymbol,
    side,
    timeframe: spec.timeframe,
    initialCapital: RESEARCH_BACKTEST_PERIOD.initialCapital,
    candles,
    fundingRates: spec.market === "CRYPTO_FUTURES" ? stressFundingRates(fundingRates) : fundingRates,
    costModel: stressCostModel(BITGET_STANDARD_TAKER_RESEARCH_COSTS[spec.market]),
    riskModel: { riskPerTrade: 0.01, maximumCapitalFraction: 1, leverage: 1 },
    parameters: candidate.parameters,
    period: {
      startTime: RESEARCH_BACKTEST_PERIOD.validationStartTime,
      endTime: RESEARCH_BACKTEST_PERIOD.validationEndTime,
      includeFinalHoldout: false,
    },
  });
  if (stressedResult.orderSubmitted !== false || stressedResult.privateAccountRequestAllowed !== false || stressedResult.safeguards?.liveOrderAllowed !== false) throw new Error("execution cost stress violated research-only safety contract");
  const stressed = compact(stressedResult);
  const positiveAfterStress = stressed.totalReturn > 0 && stressed.expectancy > 0;
  return Object.freeze({
    status: positiveAfterStress ? "survived" : "failed",
    scenarioId: "double_configured_execution_costs_v1",
    multiplier: EXECUTION_COST_STRESS_MULTIPLIER,
    baseline,
    stressed,
    positiveAfterStress,
    includes: Object.freeze({ fee: true, spread: true, slippage: true, funding: spec.market === "CRYPTO_FUTURES", latency: true }),
    reasons: Object.freeze(positiveAfterStress ? [] : ["non_positive_oos_return_or_expectancy_after_execution_cost_stress"]),
  });
}

const automated = await readJson(researchPath);
if (!Array.isArray(automated.perSymbolResults)) throw new TypeError("automated research artifact must expose perSymbolResults");
const rows = [];
const blocked = [];

for (const resultRow of automated.perSymbolResults) {
  const spec = specFor(resultRow.datasetId);
  const candleBundle = await readJson(resolve(cacheRoot, `${spec.id}.candles.json`));
  const candles = candleBundle.candles ?? [];
  let fundingRates = [];
  if (spec.market === "CRYPTO_FUTURES") {
    const fundingBundle = await readJson(resolve(cacheRoot, `${spec.id}.funding.json`));
    fundingRates = fundingBundle.records ?? [];
  }
  const actualEnd = candles.at(-1)?.timestamp ?? null;
  const dataset = buildHistoricalDataset({
    market: spec.market,
    symbol: spec.researchSymbol,
    timeframe: spec.timeframe,
    source: spec.provider,
    provider: spec.provider,
    providerVersion: spec.provider === "bitget-public-v2" ? "v2" : "monthly-archive-checksum-v1",
    adjustmentMode: "none",
    requestedStart: RESEARCH_BACKTEST_PERIOD.startTime,
    requestedEnd: actualEnd ?? RESEARCH_BACKTEST_PERIOD.validationEndTime,
    generatedAt: generatedAtMs,
    expectedIntervalMs: DAY,
    candles,
    corporateActions: "not_applicable",
    survivorshipSafeguard: "not_applicable",
  });

  const candidate = resultRow.result?.candidates?.[0] ?? null;
  if (!candidate) {
    rows.push(buildScannerBacktestQualityRow({
      market: spec.market, symbol: spec.researchSymbol, strategyType: "SWING", direction: rankingDirection(resultRow.result?.side),
      strategyVersion: V1_STRATEGY_ID, timeframe: spec.timeframe, backtestQuality: "missing", reasons: ["no_frozen_candidate"],
      researchStatus: "missing", dataset, lookaheadSafe: true, researchCodeSha, generatedAt,
      initialCapital: RESEARCH_BACKTEST_PERIOD.initialCapital, costModel: costFlags(spec.market),
      executionCostStress: { status: "not_evaluated", reasons: ["no_frozen_candidate"] },
      promotionEligible: false, promotionBlockReasons: ["no_frozen_candidate"],
    }));
    continue;
  }

  let holdout = Object.freeze({ status: "insufficient_history", metrics: null, startTime: RESEARCH_BACKTEST_PERIOD.finalHoldoutStartTime, endTime: actualEnd });
  if (actualEnd != null && actualEnd > RESEARCH_BACKTEST_PERIOD.finalHoldoutStartTime + 60 * DAY) {
    const holdoutResult = runV1Backtest({
      market: spec.market,
      symbol: spec.researchSymbol,
      side: resultRow.result.side,
      timeframe: spec.timeframe,
      initialCapital: RESEARCH_BACKTEST_PERIOD.initialCapital,
      candles,
      fundingRates,
      costModel: BITGET_STANDARD_TAKER_RESEARCH_COSTS[spec.market],
      riskModel: { riskPerTrade: 0.01, maximumCapitalFraction: 1, leverage: 1 },
      parameters: candidate.parameters,
      period: {
        startTime: RESEARCH_BACKTEST_PERIOD.finalHoldoutStartTime,
        endTime: actualEnd,
        includeFinalHoldout: true,
      },
    });
    if (holdoutResult.orderSubmitted !== false || holdoutResult.privateAccountRequestAllowed !== false || holdoutResult.safeguards?.liveOrderAllowed !== false) throw new Error("holdout violated research-only safety contract");
    holdout = Object.freeze({
      status: "evaluated",
      candidateId: candidate.id,
      frozenBeforeHoldout: true,
      selectionUsesHoldout: false,
      retuningAfterHoldout: false,
      startTime: RESEARCH_BACKTEST_PERIOD.finalHoldoutStartTime,
      endTime: actualEnd,
      metrics: compact(holdoutResult),
    });
  }

  const walkForward = summarizeWalkForward(candidate.walkForward);
  const normalizedCostModel = costFlags(spec.market);
  const executionCostStress = buildExecutionCostStress({ spec, candles, fundingRates, candidate, side: resultRow.result.side });
  const quality = classifyBacktestQuality({
    dataset,
    oosMetrics: candidate.oosMetrics,
    walkForward,
    holdout,
    costModel: normalizedCostModel,
    lookaheadSafe: candidate.walkForward?.windows?.every((window) => window.leakFree === true) === true,
    survivorshipSafeguard: dataset.survivorshipSafeguard,
  });
  rows.push(buildScannerBacktestQualityRow({
    market: spec.market,
    symbol: spec.researchSymbol,
    strategyType: "SWING",
    direction: rankingDirection(resultRow.result.side),
    strategyVersion: V1_STRATEGY_ID,
    timeframe: spec.timeframe,
    backtestQuality: quality.status,
    reasons: quality.reasons,
    development: candidate.developmentMetrics,
    oos: candidate.oosMetrics,
    walkForward,
    holdout,
    regimePerformance: candidate.walkForward?.windows?.map((window) => ({ startTime: window.startTime, endTime: window.endTime, return: window.totalReturn })) ?? [],
    confidence: Number.isFinite(walkForward.stabilityScore) ? Math.round(walkForward.stabilityScore) : null,
    researchStatus: candidate.researchStatus,
    dataset,
    lookaheadSafe: true,
    initialCapital: RESEARCH_BACKTEST_PERIOD.initialCapital,
    costModel: normalizedCostModel,
    executionCostStress,
    promotionEligible: false,
    promotionBlockReasons: ["empirical_promotion_thresholds_uncalibrated"],
    researchCodeSha,
    generatedAt,
  }));
}

for (const stock of [
  { market: "KR_STOCK", symbol: "005930", providerNeed: "reproducible KR historical OHLCV with adjusted-price, listing/delisting and survivorship provenance" },
  { market: "US_STOCK", symbol: "AAPL", providerNeed: "reproducible US historical OHLCV with split/reverse-split, ticker-change, delisted and survivorship provenance" },
]) {
  const reason = `blocked_provider:${stock.providerNeed}`;
  blocked.push(Object.freeze({ market: stock.market, symbol: stock.symbol, status: "blocked_provider", reason }));
  rows.push(buildScannerBacktestQualityRow({
    market: stock.market, symbol: stock.symbol, strategyType: "SWING", direction: "LONG", strategyVersion: V1_STRATEGY_ID,
    timeframe: "1d", backtestQuality: "blocked_provider", reasons: [reason], researchStatus: "blocked_provider",
    dataset: null, lookaheadSafe: false, initialCapital: RESEARCH_BACKTEST_PERIOD.initialCapital,
    costModel: costFlags(stock.market),
    executionCostStress: { status: "blocked_provider", reasons: [reason] },
    promotionEligible: false, promotionBlockReasons: [reason], researchCodeSha, generatedAt,
  }));
}

for (const pending of [
  ["CRYPTO_SPOT", "USDT-BTC", "LONG"], ["CRYPTO_SPOT", "USDT-ETH", "LONG"],
  ["CRYPTO_FUTURES", "BTCUSDT", "LONG"], ["CRYPTO_FUTURES", "BTCUSDT", "SHORT"],
  ["CRYPTO_FUTURES", "ETHUSDT", "LONG"], ["CRYPTO_FUTURES", "ETHUSDT", "SHORT"],
]) blocked.push(Object.freeze({ market: pending[0], symbol: pending[1], direction: pending[2], strategyType: "SCALPING", status: "blocked_provider", reason: "long-history intraday chunk/cache provider pipeline not yet verified; no 1m/3m/5m/15m metric synthesized" }));

const artifact = buildScannerBacktestQualityArtifact({ researchCodeSha, generatedAt, rows, blocked });
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  status: artifact.rows.some((row) => row.backtestQuality === "verified") ? "ok" : "partial",
  artifact: outputPath,
  schema: artifact.schema,
  rows: artifact.rows.length,
  quality: Object.fromEntries(artifact.rows.map((row) => [`${row.market}:${row.symbol}:${row.direction}`, row.backtestQuality])),
  liveOrderAllowed: false,
  privateApiAllowed: false,
  orderSubmitted: false,
}));