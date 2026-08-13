import { PredictionInputError } from "./contracts.js";
import {
  buildStockOosSegments,
  expandStockParameterGrid,
  normalizeOptimizerCandles,
  simulateStockSwingStrategy,
} from "./stock-swing-optimizer.js";

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
  const expectancy = returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : 0;
  return Object.freeze({
    tradeCount: returns.length,
    winRate: returns.length ? wins.length / returns.length : 0,
    expectancy,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Number.POSITIVE_INFINITY : 0,
    maxDrawdown,
    netReturn: equity - 1,
  });
}

function normalizeDatasets(raw) {
  if (!Array.isArray(raw) || raw.length < 2) throw new PredictionInputError("crypto spot PnL optimizer requires at least two datasets");
  const seen = new Set();
  return Object.freeze(raw.map((dataset, index) => {
    const symbol = String(dataset?.symbol ?? "").trim().toUpperCase();
    if (!symbol || seen.has(symbol)) throw new PredictionInputError("crypto spot symbols must be non-empty and unique", { index, symbol });
    seen.add(symbol);
    return Object.freeze({ symbol, candles: normalizeOptimizerCandles(dataset.candles) });
  }));
}

function aggregate(results) {
  const allTrades = results.flatMap((item) => item.simulation.trades.map((trade) => ({ ...trade, symbol: item.symbol })));
  const metrics = summarizeTrades(allTrades);
  const positiveSymbols = results.filter((item) => item.simulation.metrics.expectancy > 0 && item.simulation.metrics.profitFactor > 1).length;
  return Object.freeze({
    metrics,
    positiveSymbols,
    symbolCount: results.length,
    perSymbol: Object.freeze(Object.fromEntries(results.map((item) => [item.symbol, item.simulation.metrics]))),
  });
}

function evaluate(datasets, params, segmentName, costRatePerSide, multiplier = 1) {
  const results = datasets.map((dataset) => {
    const segment = buildStockOosSegments(dataset.candles.length)[segmentName];
    return {
      symbol: dataset.symbol,
      simulation: simulateStockSwingStrategy({
        candles: dataset.candles,
        params,
        costRatePerSide: costRatePerSide * multiplier,
        startIndex: segment.startIndex,
        endIndex: segment.endIndex,
      }),
    };
  });
  return aggregate(results);
}

function objective(summary) {
  const { metrics, positiveSymbols, symbolCount } = summary;
  if (metrics.tradeCount < Math.max(10, symbolCount * 4)) return -1_000;
  const pf = Number.isFinite(metrics.profitFactor) ? Math.min(metrics.profitFactor, 5) : 5;
  return metrics.expectancy * 120
    + metrics.netReturn * 5
    + (pf - 1) * 2
    + (positiveSymbols / Math.max(1, symbolCount)) * 2
    - metrics.maxDrawdown * 8;
}

function passGate(summary, minimumTrades) {
  return summary.metrics.tradeCount >= minimumTrades
    && summary.metrics.expectancy > 0
    && summary.metrics.profitFactor >= 1.05
    && summary.metrics.maxDrawdown <= 0.35
    && summary.positiveSymbols === summary.symbolCount;
}

export function optimizeCryptoSpotPnl(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PredictionInputError("crypto spot optimizer input must be an object");
  const datasets = normalizeDatasets(raw.datasets);
  const costRatePerSide = Number(raw.costRatePerSide ?? 0.0015);
  const stressMultiplier = Number(raw.stressMultiplier ?? 1.5);
  if (!Number.isFinite(costRatePerSide) || costRatePerSide < 0 || costRatePerSide >= 0.05) throw new PredictionInputError("invalid crypto spot costRatePerSide");
  if (!Number.isFinite(stressMultiplier) || stressMultiplier < 1 || stressMultiplier > 3) throw new PredictionInputError("invalid crypto spot stressMultiplier");
  const grid = expandStockParameterGrid(raw.grid ?? {
    breakoutLookback: [12, 24, 48],
    maPeriod: [24, 60],
    atrStopMultiplier: [1.5, 2, 2.5],
    rewardRisk: [1.5, 2],
    maxHoldBars: [6, 12, 24],
    minRelativeVolume: [1, 1.2],
    maxGapPercent: [2, 4],
  });
  if (!grid.length || grid.length > 2500) throw new PredictionInputError("crypto spot grid must contain 1..2500 candidates");

  const trained = grid.map((params) => ({ params, train: evaluate(datasets, params, "train", costRatePerSide) }))
    .sort((left, right) => objective(right.train) - objective(left.train));
  const finalists = trained.slice(0, Math.min(24, trained.length)).map((candidate) => ({
    ...candidate,
    validation: evaluate(datasets, candidate.params, "validation", costRatePerSide),
  })).sort((left, right) => objective(right.validation) - objective(left.validation));
  const minimumTrades = Math.max(12, datasets.length * 5);
  const selected = finalists.find((candidate) => passGate(candidate.validation, minimumTrades)) ?? finalists[0];
  if (!selected) throw new PredictionInputError("crypto spot optimizer could not select a candidate");

  const test = evaluate(datasets, selected.params, "test", costRatePerSide);
  const stressedTest = evaluate(datasets, selected.params, "test", costRatePerSide, stressMultiplier);
  const validationPassed = passGate(selected.validation, minimumTrades);
  const testPassed = passGate(test, minimumTrades);
  const stressPassed = passGate(stressedTest, Math.max(10, datasets.length * 4));
  const status = validationPassed && testPassed && stressPassed ? "oos_candidate" : "research_hold";

  return Object.freeze({
    schemaVersion: 1,
    market: "CRYPTO_SPOT",
    exchange: "UPBIT",
    status,
    researchOnly: true,
    liveExecutionAllowed: false,
    privateAccountRequestAllowed: false,
    longOnly: true,
    selectionContract: Object.freeze({
      trainGridCandidates: grid.length,
      validationFinalists: finalists.length,
      testUsedForSelection: false,
      nextBarOpenEntry: true,
      sameBarStopTargetPolicy: "stop_first_conservative",
      bothSymbolsMustBePositive: true,
    }),
    costAssumptions: Object.freeze({
      costRatePerSide,
      stressMultiplier,
      stressedCostRatePerSide: costRatePerSide * stressMultiplier,
      note: "research fee+spread+slippage stress assumption; not an exchange fee schedule",
    }),
    params: selected.params,
    train: selected.train,
    validation: selected.validation,
    test,
    stressedTest,
    gates: Object.freeze({ validationPassed, testPassed, stressPassed }),
    limitations: Object.freeze([
      "BTC and ETH only",
      "long-only breakout/ATR strategy family",
      "historical order-book depth is not available in this candle-only harness",
      "shadow confirmation is required before any execution promotion",
    ]),
  });
}
