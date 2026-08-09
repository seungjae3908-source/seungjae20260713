import test from "node:test";
import assert from "node:assert/strict";
import {
  FORWARD_PROMOTION_POLICY_V1,
  SUCCESS_RATE_DEFINITION,
  buildStandardizedResearchMetrics,
  classifyBarrierOutcome,
  evaluateForwardPromotionGate,
  summarizeTradeOutcomeMetrics,
} from "../src/research-metric-semantics.js";

function trade({ exitReason, netPnl, totalCost = 10 }) {
  return Object.freeze({
    exitReason,
    netPnl,
    costs: Object.freeze({ total: totalCost }),
  });
}

test("TP-before-SL is independent from whether costs made net PnL positive", () => {
  const rows = [
    trade({ exitReason: "take_profit", netPnl: -5 }),
    trade({ exitReason: "stop_loss", netPnl: 25 }),
    trade({ exitReason: "end_of_data", netPnl: 10 }),
  ];
  const metrics = summarizeTradeOutcomeMetrics(rows);
  assert.equal(metrics.successRateDefinition, SUCCESS_RATE_DEFINITION);
  assert.equal(metrics.tpHitCount, 1);
  assert.equal(metrics.slHitCount, 1);
  assert.equal(metrics.barrierResolvedTradeCount, 2);
  assert.equal(metrics.censoredCount, 1);
  assert.equal(metrics.tpBeforeSlRate, 0.5);
  assert.equal(metrics.netProfitableTradeRate, 2 / 3);
});

test("same-bar TP and SL ambiguity remains a stop-loss failure", () => {
  assert.equal(classifyBarrierOutcome({ exitReason: "stop_loss_same_bar" }), "sl");
  assert.equal(classifyBarrierOutcome({ exitReason: "take_profit_gap" }), "tp");
});

test("standardized metrics expose TP success and net-profitable rate separately", () => {
  const rows = [
    trade({ exitReason: "take_profit", netPnl: 100, totalCost: 20 }),
    trade({ exitReason: "stop_loss", netPnl: -50, totalCost: 10 }),
    trade({ exitReason: "end_of_data", netPnl: 10, totalCost: 5 }),
  ];
  const metrics = buildStandardizedResearchMetrics({
    trades: rows,
    initialCapital: 1_000,
    totalReturnPercent: 6,
    profitFactor: 2.2,
    maximumDrawdownPercent: 5,
    expectancy: 20,
  });
  assert.equal(metrics.successRatePercent, 50);
  assert.equal(metrics.tpBeforeSlRatePercent, 50);
  assert.ok(Math.abs(metrics.netProfitableTradeRatePercent - 66.6666666667) < 1e-6);
  assert.equal(metrics.barrierResolvedTradeCount, 2);
  assert.equal(metrics.censoredCount, 1);
  assert.ok(metrics.costStress.x1_5.totalReturnPercent < metrics.totalReturnPercent);
  assert.ok(metrics.costStress.x2.totalReturnPercent < metrics.costStress.x1_5.totalReturnPercent);
});

test("promotion gate is preregistered, conjunctive, and can never auto-enable live", () => {
  const trades = Array.from({ length: 30 }, (_, index) => trade({
    exitReason: index < 15 ? "take_profit" : "stop_loss",
    netPnl: index < 15 ? 100 : -40,
    totalCost: 2,
  }));
  const metrics = buildStandardizedResearchMetrics({
    trades,
    initialCapital: 100_000,
    totalReturnPercent: 0.9,
    profitFactor: 2.5,
    maximumDrawdownPercent: 4,
    expectancy: 30,
  });
  const gate = evaluateForwardPromotionGate({
    metrics,
    elapsedDays: 35,
    safeguards: {
      frozenCandidateOnly: true,
      parametersRetunedAfterHoldout: false,
      orderSubmitted: false,
      privateAccountRequestAllowed: false,
      liveOrderAllowed: false,
    },
  });
  assert.equal(FORWARD_PROMOTION_POLICY_V1.minimumSettledTrades, 30);
  assert.equal(FORWARD_PROMOTION_POLICY_V1.minimumElapsedDays, 28);
  assert.equal(FORWARD_PROMOTION_POLICY_V1.minimumProfitFactor, 1.3);
  assert.equal(gate.passed, true);
  assert.equal(gate.status, "promotion_candidate");
  assert.equal(gate.automaticLivePromotionAllowed, false);
});

test("promotion gate fails closed when sample or safety evidence is incomplete", () => {
  const metrics = buildStandardizedResearchMetrics({
    trades: [trade({ exitReason: "take_profit", netPnl: 100 })],
    initialCapital: 100_000,
    totalReturnPercent: 0.1,
    profitFactor: 2,
    maximumDrawdownPercent: 0,
    expectancy: 100,
  });
  const gate = evaluateForwardPromotionGate({
    metrics,
    elapsedDays: 40,
    safeguards: {
      frozenCandidateOnly: true,
      parametersRetunedAfterHoldout: false,
      orderSubmitted: false,
      privateAccountRequestAllowed: false,
      liveOrderAllowed: false,
    },
  });
  assert.equal(gate.passed, false);
  assert.equal(gate.checks.settledTrades, false);
  assert.equal(gate.status, "shadow_continue");
});
