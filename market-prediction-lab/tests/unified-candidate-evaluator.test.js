import test from "node:test";
import assert from "node:assert/strict";
import { RESEARCH_BACKTEST_PERIOD } from "../src/multi-market-backtest-engine.js";
import { buildUnifiedCalibrationRow, evaluateUnifiedCandidate } from "../src/unified-candidate-evaluator.js";

const DAY = 24 * 60 * 60 * 1000;

function candles(symbol) {
  const rows = [];
  let index = 0;
  for (let timestamp = Date.UTC(2019, 8, 1); timestamp <= Date.UTC(2025, 11, 31); timestamp += DAY, index += 1) {
    const base = 100 + index * 0.03 + Math.sin(index / 8) * 4;
    const close = base + Math.sin(index / 3) * 1.2;
    rows.push(Object.freeze({
      symbol,
      timestamp,
      observedAt: timestamp,
      isClosed: true,
      open: base,
      high: Math.max(base, close) + 1.5,
      low: Math.min(base, close) - 1.5,
      close,
      volume: 1_000 + (index % 17) * 25,
    }));
  }
  return Object.freeze(rows);
}

function input() {
  return {
    market: "CRYPTO_SPOT",
    symbol: "USDT-BTC",
    side: "long",
    timeframe: "1d",
    initialCapital: 1_000_000,
    candles: candles("USDT-BTC"),
    fundingRates: [],
    costModel: {
      entryFeeRate: 0.001,
      exitFeeRate: 0.001,
      taxRate: 0,
      slippageRate: 0.0002,
      spreadRate: 0.0002,
      latencyBars: 0,
      latencyDriftRate: 0,
    },
    riskModel: { riskPerTrade: 0.01, maximumCapitalFraction: 1, leverage: 1 },
  };
}

const optimization = Object.freeze({
  strategyCandidate: "V2_MARKET_TUNED_EMA_ATR",
  status: "v2_candidate_frozen_for_holdout",
  preferred: Object.freeze({
    parameters: Object.freeze({
      fastPeriod: 12,
      slowPeriod: 50,
      atrPeriod: 14,
      pullbackTolerancePct: 0.75,
      stopAtrMultiple: 1.5,
      targetRiskMultiple: 2,
    }),
  }),
});

test("unified V2 evaluator is deterministic, leak-free, and never unlocks final holdout", () => {
  const options = {
    version: "V2",
    optimization,
    backtestInput: input(),
    maxWalkForwardWindows: 2,
    walkForwardOptions: { trainSize: 600, validationSize: 180, testSize: 180, stepSize: 180, embargoMs: DAY },
  };
  const first = evaluateUnifiedCandidate(options);
  const second = evaluateUnifiedCandidate(options);
  assert.deepEqual(first, second);
  assert.equal(first.finalHoldoutStatus, "LOCKED");
  assert.equal(first.finalHoldoutUsed, false);
  assert.equal(first.finalHoldoutRetuningAllowed, false);
  assert.equal(first.liveOrderAllowed, false);
  assert.equal(first.privateAccountRequestAllowed, false);
  assert.equal(first.orderSubmitted, false);
  assert.equal(first.researchStatus, "research_hold");
  assert.equal(first.statisticalQuality.statisticalPass, false);
  assert.equal(first.executionCostStress.scenarioId, "double_configured_execution_costs_v1");
  assert.equal(first.executionCostStress.multiplier, 2);
  assert.equal(first.executionCostStress.selectionAffected, false);
  assert.equal(first.executionCostStress.finalHoldoutUsed, false);
  assert.ok(["survived", "failed"].includes(first.executionCostStress.status));
  assert.equal(first.promotionEligible, false);
  assert.ok(first.walkForward.windows.length > 0);
  assert.ok(first.walkForward.windows.every((window) => window.leakFree === true));
  assert.ok(first.walkForward.windows.every((window) => window.endTime < RESEARCH_BACKTEST_PERIOD.finalHoldoutStartTime));
});

test("ten OOS trades cannot become an implicit statistical pass", () => {
  const candidate = evaluateUnifiedCandidate({
    version: "V2",
    optimization,
    backtestInput: input(),
    maxWalkForwardWindows: 1,
    walkForwardOptions: { trainSize: 600, validationSize: 180, testSize: 180, stepSize: 180, embargoMs: DAY },
  });
  assert.equal(candidate.statisticalQuality.statisticalPass, false);
  if (candidate.statisticalQuality.oosTradeCount >= 10) {
    assert.equal(candidate.statisticalQuality.sampleQuality, "uncalibrated_not_a_pass");
  } else {
    assert.equal(candidate.statisticalQuality.sampleQuality, "low_sample_research_hold");
  }
});

test("legacy versions without a preferred candidate fail closed instead of using baseline as a winner", () => {
  const result = evaluateUnifiedCandidate({ version: "V4", optimization: { strategyCandidate: "V4_REGIME_MOMENTUM_FILTER", status: "v4_research_hold", preferred: null }, backtestInput: input() });
  assert.equal(result.candidateId, null);
  assert.equal(result.researchStatus, "research_hold");
  assert.equal(result.statisticalQuality.statisticalPass, false);
  assert.deepEqual(result.overfitDiagnostics.flags, ["no_preferred_candidate"]);
});

test("calibration row keeps sample and performance fields separate", () => {
  const candidate = evaluateUnifiedCandidate({
    version: "V2",
    optimization,
    backtestInput: input(),
    maxWalkForwardWindows: 1,
    walkForwardOptions: { trainSize: 600, validationSize: 180, testSize: 180, stepSize: 180, embargoMs: DAY },
  });
  const row = buildUnifiedCalibrationRow(candidate);
  assert.equal(row.version, "V2");
  assert.equal(row.oosTradeCount, candidate.oos.tradeCount);
  assert.equal(row.sampleQuality, candidate.statisticalQuality.sampleQuality);
  assert.ok(Object.hasOwn(row, "profitFactor"));
  assert.ok(Object.hasOwn(row, "MDD"));
  assert.ok(Object.hasOwn(row, "wfWindowDispersion"));
  assert.equal(row.executionCostStressStatus, candidate.executionCostStress.status);
  assert.equal(row.promotionEligible, false);
});
