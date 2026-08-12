import test from "node:test";
import assert from "node:assert/strict";
import {
  futuresDecisionFromProbabilities,
  simulateFrozenFuturesModel,
} from "../src/futures-model-pnl-audit.js";

function candles(count = 240) {
  const rows = [];
  let close = 100;
  for (let index = 0; index < count; index += 1) {
    const wave = index % 40;
    const drift = wave < 20 ? 0.35 : -0.28;
    const open = close;
    close = Math.max(20, open + drift);
    rows.push({
      timestamp: Date.UTC(2026, 0, 1) + index * 60 * 60 * 1000,
      open,
      high: Math.max(open, close) + 0.5,
      low: Math.min(open, close) - 0.5,
      close,
      volume: 100 + index % 10,
    });
  }
  return rows;
}

const model = Object.freeze({
  id: "test-frozen-model",
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

function records(rows) {
  return rows.slice(30, -20).map((row, index) => ({
    symbol: "BTCUSDT",
    timeframe: "1h",
    anchorTimestamp: row.timestamp,
    features: { return5: index % 2 === 0 ? 0.2 : -0.2 },
  }));
}

test("direction decision requires both probability threshold and directional edge", () => {
  assert.equal(futuresDecisionFromProbabilities({ bullish: 0.4, neutral: 0.3, bearish: 0.3 }, {
    minDirectionalProbability: 0.45,
    minProbabilityEdge: 0.05,
  }), null);
  assert.equal(futuresDecisionFromProbabilities({ bullish: 0.55, neutral: 0.25, bearish: 0.2 }, {
    minDirectionalProbability: 0.45,
    minProbabilityEdge: 0.05,
  })?.action, "LONG");
  assert.equal(futuresDecisionFromProbabilities({ bullish: 0.2, neutral: 0.25, bearish: 0.55 }, {
    minDirectionalProbability: 0.45,
    minProbabilityEdge: 0.05,
  })?.action, "SHORT");
});

test("futures simulation stays two-sided and includes execution/funding costs", () => {
  const rows = candles();
  const fundingRates = [
    { timestamp: rows[70].timestamp, rate: 0.0001 },
    { timestamp: rows[130].timestamp, rate: -0.0001 },
  ];
  const result = simulateFrozenFuturesModel({
    symbol: "BTCUSDT",
    timeframe: "1h",
    candles: rows,
    fundingRates,
    records: records(rows),
    model,
    params: {
      minDirectionalProbability: 0.45,
      minProbabilityEdge: 0.05,
      atrPeriod: 14,
      stopAtrMultiple: 1.5,
      rewardRisk: 1.5,
      maxHoldBars: 4,
      riskPerTrade: 0.005,
    },
    initialCapital: 1_000_000,
  });
  assert.ok(result.trades.length > 0);
  assert.ok(result.metrics.directionCounts.LONG > 0);
  assert.ok(result.metrics.directionCounts.SHORT > 0);
  assert.ok(result.trades.every((trade) => trade.costsIncluded === true));
  assert.ok(result.trades.every((trade) => Number.isFinite(trade.costs.total)));
  assert.equal(result.modelId, "test-frozen-model");
});

test("cost stress never reduces configured fees, spread, slippage or funding magnitude", () => {
  const rows = candles();
  const fundingRates = Array.from({ length: 12 }, (_, index) => ({
    timestamp: rows[40 + index * 10].timestamp,
    rate: 0.00015,
  }));
  const base = simulateFrozenFuturesModel({
    symbol: "BTCUSDT", timeframe: "1h", candles: rows, fundingRates, records: records(rows), model,
    params: { minDirectionalProbability: 0.45, minProbabilityEdge: 0.05, stopAtrMultiple: 1.5, rewardRisk: 1.5, maxHoldBars: 6 },
    costMultiplier: 1,
  });
  const stress = simulateFrozenFuturesModel({
    symbol: "BTCUSDT", timeframe: "1h", candles: rows, fundingRates, records: records(rows), model,
    params: { minDirectionalProbability: 0.45, minProbabilityEdge: 0.05, stopAtrMultiple: 1.5, rewardRisk: 1.5, maxHoldBars: 6 },
    costMultiplier: 1.5,
  });
  assert.equal(base.trades.length, stress.trades.length);
  assert.ok(stress.metrics.totalExecutionCost >= base.metrics.totalExecutionCost);
});
