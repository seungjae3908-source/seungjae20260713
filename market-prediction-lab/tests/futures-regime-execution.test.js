import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateFuturesRegimeGate,
  expandFuturesRegimeGrid,
  optimizeFrozenFuturesRegimeExecution,
  simulateFrozenFuturesRegimeExecution,
} from "../src/futures-regime-execution.js";
import {
  FUTURES_REGIME_EXECUTION_CANDIDATE,
  FUTURES_REGIME_EXECUTION_CANDIDATE_SHA256,
} from "../src/futures-regime-execution-candidate.js";

const BAR = 15 * 60 * 1000;

const model = Object.freeze({
  id: "test-futures-regime-model",
  trained: true,
  modelType: "multinomial-logistic-regression",
  featureOrder: Object.freeze(["return5"]),
  normalization: Object.freeze({ mean: Object.freeze([0]), scale: Object.freeze([1]) }),
  temperature: 1,
  classes: Object.freeze({
    bullish: Object.freeze({ bias: 0, weights: Object.freeze([8]) }),
    neutral: Object.freeze({ bias: -1, weights: Object.freeze([0]) }),
    bearish: Object.freeze({ bias: 0, weights: Object.freeze([-8]) }),
  }),
});

function candles(count = 620, phase = 0) {
  const rows = [];
  let close = 100;
  for (let index = 0; index < count; index += 1) {
    const cycle = (index + phase) % 160;
    const drift = cycle < 80 ? 0.18 : -0.16;
    const open = close;
    close = Math.max(20, open + drift);
    rows.push({
      timestamp: Date.UTC(2026, 0, 1) + index * BAR,
      open,
      high: Math.max(open, close) + 0.15,
      low: Math.min(open, close) - 0.15,
      close,
      volume: 1000 + index % 20,
    });
  }
  return rows;
}

function funding(rows, rate = 0) {
  const out = [];
  for (let index = 0; index < rows.length; index += 32) out.push({ timestamp: rows[index].timestamp, rate });
  return out;
}

function records(rows, symbol) {
  const result = [];
  for (let index = 140; index < rows.length - 12; index += 4) {
    const prior = rows[index - 20].close;
    result.push({
      symbol,
      timeframe: "15m",
      anchorTimestamp: rows[index].timestamp,
      features: { return5: rows[index].close >= prior ? 0.2 : -0.2 },
    });
  }
  return result;
}

function dataset(symbol, phase = 0) {
  const rows = candles(620, phase);
  const all = records(rows, symbol);
  const trainEnd = Math.floor(all.length * 0.6);
  const validationEnd = Math.floor(all.length * 0.8);
  return Object.freeze({
    symbol,
    timeframe: "15m",
    candles: rows,
    fundingRates: funding(rows, 0),
    records: all,
    split: Object.freeze({
      train: Object.freeze(all.slice(0, trainEnd)),
      validation: Object.freeze(all.slice(trainEnd, validationEnd)),
      test: Object.freeze(all.slice(validationEnd)),
    }),
  });
}

test("candidate freezes failed execution params and preregisters fresh cross-assets", () => {
  assert.equal(FUTURES_REGIME_EXECUTION_CANDIDATE.sourceStatus, "research_hold");
  assert.equal(FUTURES_REGIME_EXECUTION_CANDIDATE.frozenExecutionParams.minDirectionalProbability, 0.5);
  assert.equal(FUTURES_REGIME_EXECUTION_CANDIDATE.frozenExecutionParams.stopAtrMultiple, 2);
  assert.equal(FUTURES_REGIME_EXECUTION_CANDIDATE.frozenExecutionParams.rewardRisk, 2);
  assert.equal(FUTURES_REGIME_EXECUTION_CANDIDATE_SHA256.length, 64);
  const prior = new Set(FUTURES_REGIME_EXECUTION_CANDIDATE.priorSymbols);
  assert.ok([...FUTURES_REGIME_EXECUTION_CANDIDATE.designSymbols, ...FUTURES_REGIME_EXECUTION_CANDIDATE.holdoutSymbols].every((symbol) => !prior.has(symbol)));
});

test("regime gate accepts aligned trend and rejects crowded same-direction funding", () => {
  const rows = candles();
  const anchorIndex = 190;
  const base = evaluateFuturesRegimeGate({
    candles: rows,
    anchorIndex,
    action: "LONG",
    fundingRates: funding(rows, 0),
    params: { trendMaPeriod: 50, trendSlopeBars: 4, maxAtrFraction: 0.02, fundingCrowdingAbsRate: 0.0003 },
  });
  assert.equal(base.passed, true);
  const crowded = evaluateFuturesRegimeGate({
    candles: rows,
    anchorIndex,
    action: "LONG",
    fundingRates: funding(rows, 0.001),
    params: { trendMaPeriod: 50, trendSlopeBars: 4, maxAtrFraction: 0.02, fundingCrowdingAbsRate: 0.0003 },
  });
  assert.equal(crowded.passed, false);
  assert.ok(crowded.reasons.includes("long_funding_crowded"));
});

test("simulation keeps next-bar execution costs and never retunes the frozen execution contract", () => {
  const data = dataset("BNBUSDT");
  const simulation = simulateFrozenFuturesRegimeExecution({
    symbol: data.symbol,
    timeframe: data.timeframe,
    candles: data.candles,
    fundingRates: data.fundingRates,
    records: data.records,
    model,
    regimeParams: { trendMaPeriod: 50, trendSlopeBars: 4, maxAtrFraction: 0.02, fundingCrowdingAbsRate: 0.0003 },
  });
  assert.deepEqual(simulation.fixedExecutionParams, FUTURES_REGIME_EXECUTION_CANDIDATE.frozenExecutionParams);
  assert.equal(simulation.candidateManifestSha256, FUTURES_REGIME_EXECUTION_CANDIDATE_SHA256);
  assert.ok(simulation.trades.length > 0);
  assert.ok(simulation.trades.every((trade) => trade.entryTimestamp > trade.anchorTimestamp));
  assert.ok(simulation.trades.every((trade) => trade.costsIncluded === true));
  assert.equal(simulation.safeguards.executionParametersRetuned, false);
  assert.equal(simulation.safeguards.actualOrders, 0);
});

test("regime grid is bounded and optimizer never selects on ADA or DOGE holdout", () => {
  assert.equal(expandFuturesRegimeGrid().length, 24);
  const designDatasets = [dataset("BNBUSDT", 0), dataset("XRPUSDT", 13)];
  const holdoutDatasets = [dataset("ADAUSDT", 29), dataset("DOGEUSDT", 41)];
  const result = optimizeFrozenFuturesRegimeExecution({ model, designDatasets, holdoutDatasets });
  assert.equal(result.candidateManifestSha256, FUTURES_REGIME_EXECUTION_CANDIDATE_SHA256);
  assert.deepEqual(result.fixedExecutionParams, FUTURES_REGIME_EXECUTION_CANDIDATE.frozenExecutionParams);
  assert.equal(result.selectionContract.executionParametersRetuned, false);
  assert.equal(result.selectionContract.priorSymbolsUsedForSelection, false);
  assert.equal(result.selectionContract.designTestUsedForSelection, false);
  assert.equal(result.selectionContract.holdoutUsedForSelection, false);
  assert.equal(result.selectionContract.rollingUsedForSelection, false);
  assert.equal(result.safeguards.liveExecutionAllowed, false);
  assert.equal(result.safeguards.actualOrders, 0);
});

test("optimizer rejects reuse of prior BTC ETH SOL symbols", () => {
  const designDatasets = [dataset("BTCUSDT", 0), dataset("XRPUSDT", 13)];
  const holdoutDatasets = [dataset("ADAUSDT", 29), dataset("DOGEUSDT", 41)];
  assert.throws(() => optimizeFrozenFuturesRegimeExecution({ model, designDatasets, holdoutDatasets }), /design symbols must match preregistered/);
});
