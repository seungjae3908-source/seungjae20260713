import { PredictionInputError } from "./contracts.js";
import { normalizeOptimizerCandles, simulateStockSwingStrategy } from "./stock-swing-optimizer.js";

function summarizeTrades(trades) {
  const returns = trades.map((trade) => Number(trade.netReturn)).filter(Number.isFinite);
  const wins = returns.filter((value) => value > 0);
  const losses = returns.filter((value) => value < 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  for (const value of returns) {
    equity *= Math.max(0.000001, 1 + value);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - equity) / peak : 0);
  }
  return Object.freeze({
    tradeCount: returns.length,
    winRate: returns.length ? wins.length / returns.length : 0,
    expectancy: returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Number.POSITIVE_INFINITY : 0,
    maxDrawdown,
    compoundedReturn: equity - 1,
  });
}

function normalizeDatasets(rawDatasets) {
  if (!Array.isArray(rawDatasets) || rawDatasets.length < 3) {
    throw new PredictionInputError("generalization audit requires at least three holdout datasets");
  }
  const seen = new Set();
  return Object.freeze(rawDatasets.map((dataset, index) => {
    const symbol = String(dataset?.symbol ?? "").trim().toUpperCase();
    if (!symbol || seen.has(symbol)) throw new PredictionInputError("holdout symbols must be non-empty and unique", { index, symbol });
    seen.add(symbol);
    return Object.freeze({ symbol, candles: normalizeOptimizerCandles(dataset.candles) });
  }));
}

function aggregate(results) {
  const trades = results.flatMap((item) => item.simulation.trades.map((trade) => ({ ...trade, symbol: item.symbol })));
  const metrics = summarizeTrades(trades);
  const positiveSymbols = results.filter((item) => item.simulation.metrics.expectancy > 0 && item.simulation.metrics.profitFactor > 1).length;
  return Object.freeze({
    metrics,
    positiveSymbols,
    symbolCount: results.length,
    perSymbol: Object.freeze(Object.fromEntries(results.map((item) => [item.symbol, item.simulation.metrics]))),
  });
}

function evaluateRange(datasets, params, costRatePerSide, startRatio, endRatio) {
  const results = datasets.map((dataset) => {
    const startIndex = Math.max(0, Math.floor(dataset.candles.length * startRatio));
    const endIndex = Math.min(dataset.candles.length - 1, Math.floor(dataset.candles.length * endRatio) - 1);
    return {
      symbol: dataset.symbol,
      simulation: simulateStockSwingStrategy({
        candles: dataset.candles,
        params,
        costRatePerSide,
        startIndex,
        endIndex,
      }),
    };
  });
  return aggregate(results);
}

export function buildRollingAuditWindows(raw = {}) {
  const windowCount = Number(raw.windowCount ?? 5);
  const startRatio = Number(raw.startRatio ?? 0.2);
  if (!Number.isInteger(windowCount) || windowCount < 3 || windowCount > 10) {
    throw new PredictionInputError("windowCount must be an integer from 3 to 10");
  }
  if (!Number.isFinite(startRatio) || startRatio < 0 || startRatio >= 0.6) {
    throw new PredictionInputError("startRatio must be between 0 and 0.6");
  }
  const width = (1 - startRatio) / windowCount;
  return Object.freeze(Array.from({ length: windowCount }, (_, index) => Object.freeze({
    index,
    startRatio: startRatio + width * index,
    endRatio: index === windowCount - 1 ? 1 : startRatio + width * (index + 1),
  })));
}

function passAggregate(summary, minimumTrades) {
  const { metrics, positiveSymbols, symbolCount } = summary;
  return metrics.tradeCount >= minimumTrades
    && metrics.expectancy > 0
    && metrics.profitFactor >= 1.05
    && metrics.maxDrawdown <= 0.35
    && positiveSymbols >= Math.ceil(symbolCount * 2 / 3);
}

export function auditFrozenStockStrategy(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PredictionInputError("generalization audit input must be an object");
  const market = String(raw.market ?? "");
  if (market !== "KR_STOCK" && market !== "US_STOCK") throw new PredictionInputError("market must be KR_STOCK or US_STOCK");
  const datasets = normalizeDatasets(raw.datasets);
  const costRatePerSide = Number(raw.costRatePerSide);
  const stressMultiplier = Number(raw.stressMultiplier ?? 1.5);
  if (!Number.isFinite(costRatePerSide) || costRatePerSide < 0 || costRatePerSide >= 0.05) throw new PredictionInputError("invalid costRatePerSide");
  if (!Number.isFinite(stressMultiplier) || stressMultiplier < 1 || stressMultiplier > 3) throw new PredictionInputError("invalid stressMultiplier");
  const params = raw.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new PredictionInputError("frozen params are required");

  const base = evaluateRange(datasets, params, costRatePerSide, 0, 1);
  const stressed = evaluateRange(datasets, params, costRatePerSide * stressMultiplier, 0, 1);
  const windows = buildRollingAuditWindows({ windowCount: raw.windowCount ?? 5, startRatio: raw.startRatio ?? 0.2 });
  const rolling = windows.map((window) => {
    const summary = evaluateRange(datasets, params, costRatePerSide, window.startRatio, window.endRatio);
    return Object.freeze({ ...window, summary });
  });
  const activeWindows = rolling.filter((window) => window.summary.metrics.tradeCount >= Math.max(3, Math.ceil(datasets.length / 2)));
  const positiveWindows = activeWindows.filter((window) => window.summary.metrics.expectancy > 0 && window.summary.metrics.profitFactor > 1);
  const minimumTrades = Math.max(12, datasets.length * 2);
  const basePassed = passAggregate(base, minimumTrades);
  const stressPassed = passAggregate(stressed, Math.max(10, datasets.length * 2));
  const rollingPassed = activeWindows.length >= Math.ceil(windows.length * 0.6)
    && positiveWindows.length >= Math.ceil(activeWindows.length * 0.6);
  const status = basePassed && stressPassed && rollingPassed ? "generalization_candidate" : "research_hold";

  return Object.freeze({
    schemaVersion: 1,
    market,
    status,
    researchOnly: true,
    liveExecutionAllowed: false,
    privateAccountRequestAllowed: false,
    auditContract: Object.freeze({
      frozenParams: true,
      paramsRetunedOnHoldouts: false,
      holdoutDataUsedForSelection: false,
      auditType: "cross_symbol_holdout_plus_rolling_stability",
    }),
    params: Object.freeze({ ...params }),
    symbols: Object.freeze(datasets.map((dataset) => dataset.symbol)),
    costAssumptions: Object.freeze({ costRatePerSide, stressMultiplier, stressedCostRatePerSide: costRatePerSide * stressMultiplier }),
    base,
    stressed,
    rolling: Object.freeze(rolling),
    rollingSummary: Object.freeze({ activeWindows: activeWindows.length, positiveWindows: positiveWindows.length, totalWindows: windows.length }),
    gates: Object.freeze({ basePassed, stressPassed, rollingPassed }),
    limitations: Object.freeze([
      "holdout symbols are cross-sectional holdouts, not historical constituent membership reconstruction",
      "rolling windows audit fixed-parameter stability and do not constitute a fresh parameter-selection OOS cycle",
      "survivorship and delisting bias remain unresolved until point-in-time universe data is available",
    ]),
  });
}
