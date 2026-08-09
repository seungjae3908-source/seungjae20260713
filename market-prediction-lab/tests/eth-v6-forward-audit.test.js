import test from "node:test";
import assert from "node:assert/strict";
import {
  FORWARD_OUTCOME_STATES,
  buildEthV6ForwardCycleAudit,
  classifyForwardOutcome,
} from "../src/eth-v6-forward-audit.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const SHA = "a".repeat(40);
const SIGNAL_TIME = Date.UTC(2026, 7, 8);
const ENTRY_TIME = SIGNAL_TIME + DAY_MS;
const CYCLE_TIME = ENTRY_TIME + 60 * 60 * 1000;

function regime() {
  return Object.freeze({
    trend: "bull",
    volatility: "high_volatility",
    liquidity: "not_available_without_orderbook_history",
    pointInTime: true,
    asOf: SIGNAL_TIME,
    usedFutureCandles: false,
  });
}

function trackingRecord() {
  return {
    id: "record-1",
    signalId: `ETH-V6-${SIGNAL_TIME}`,
    status: "tracking",
    strategy: "v6_independent_breakout_retest",
    market: "CRYPTO_FUTURES",
    timeframe: "1d",
    timestamp: SIGNAL_TIME,
    dataTimestamp: SIGNAL_TIME,
    entryPlan: {
      action: "LONG",
      entryTime: ENTRY_TIME,
      entryPrice: 100,
      quantity: 1,
      leverage: 1,
      marketRegime: regime(),
    },
    stop: 95,
    targets: [110],
    feesSlippageModel: {
      entryFeeRate: 0.0006,
      exitFeeRate: 0.0006,
      taxRate: 0,
      spreadRate: 0.0002,
      slippageRate: 0.0002,
      latencyBars: 0,
      latencyDriftRate: 0,
      fundingRates: [],
    },
    subsequentMarketResult: null,
    hypotheticalPnl: null,
    execution: null,
    orderSubmitted: false,
    privateAccountRequested: false,
  };
}

function summary(overrides = {}) {
  return {
    settledTrades: 0,
    barrierResolvedTradeCount: 0,
    tpBeforeSlRatePercent: 0,
    netProfitableTradeRatePercent: 0,
    totalReturnPercent: 0,
    profitFactor: 0,
    maximumDrawdownPercent: 0,
    expectancy: 0,
    ...overrides,
  };
}

function state(records = [], missedSignals = []) {
  return {
    paper: { initialCapital: 1_000_000, equity: 1_000_000 },
    ledger: { version: records.length, records },
    missedSignals,
  };
}

function build(input = {}) {
  const candles = [
    { timestamp: SIGNAL_TIME, open: 99, high: 101, low: 98, close: 100, volume: 1000 },
    { timestamp: ENTRY_TIME, open: 100, high: 101, low: 99, close: 100, volume: 10 },
  ];
  return buildEthV6ForwardCycleAudit({
    state: state([trackingRecord()]),
    previousState: state(),
    summary: summary(),
    researchCodeSha: SHA,
    strategyId: "eth-futures-long-v6",
    strategyVersion: "V6",
    cycleTime: CYCLE_TIME,
    fundingRecords: [{ timestamp: SIGNAL_TIME + 8 * 60 * 60 * 1000, rate: 0.0001 }],
    candles,
    classifyRegime: () => regime(),
    ...input,
  });
}

test("forward audit stores exact provenance, point-in-time regime and modeled entry without live access", () => {
  const audit = build();
  assert.equal(audit.researchCodeSha, SHA);
  assert.equal(audit.disposition, "signals_recorded");
  assert.equal(audit.dataQuality.status, "passed");
  assert.equal(audit.safeguards.parameterChanged, false);
  assert.equal(audit.safeguards.orderSubmitted, false);
  assert.equal(audit.safeguards.privateApiRequested, false);
  const event = audit.recordedSignals[0];
  assert.equal(event.signalId, `ETH-V6-${SIGNAL_TIME}`);
  assert.equal(event.strategyVersion, "V6");
  assert.equal(event.researchCodeSha, SHA);
  assert.equal(event.signalTimestamp, SIGNAL_TIME);
  assert.equal(event.decisionTimestamp, ENTRY_TIME);
  assert.equal(event.marketTimestamp, SIGNAL_TIME);
  assert.equal(event.entryEligibleTimestamp, ENTRY_TIME);
  assert.equal(event.intendedEntry, 100);
  assert.equal(event.nextBarOpen, 100);
  assert.equal(event.takeProfit, 110);
  assert.equal(event.stopLoss, 95);
  assert.equal(event.actualSimulatedEntry, 100 * 1.0001 * 1.0002);
  assert.equal(event.actualSimulatedEntrySource, "deterministic_execution_model");
  assert.equal(event.trendRegime, "bull");
  assert.equal(event.volatilityRegime, "high_volatility");
  assert.equal(event.liquidityEvidence.status, "not_available");
  assert.equal(event.liquidityEvidence.syntheticScoreGenerated, false);
  assert.equal(event.fundingSnapshot.status, "available");
  assert.equal(event.fundingSnapshot.rate, 0.0001);
  assert.equal(event.outcomeState, "tracking");
  assert.equal(event.orderSubmitted, false);
  assert.equal(event.privateAccountRequested, false);
});

test("zero settled sample is rendered as unavailable instead of fake zero performance", () => {
  const audit = build({ state: state(), previousState: state(), summary: summary() });
  assert.equal(audit.disposition, "no_signal");
  assert.equal(audit.zeroSignalMeansStrategyNoSignal, true);
  assert.equal(audit.metricInterpretation.tpBeforeSl.available, false);
  assert.equal(audit.metricInterpretation.tpBeforeSl.valuePercent, null);
  assert.match(audit.metricInterpretation.tpBeforeSl.display, /N\/A — insufficient resolved sample/u);
  assert.equal(audit.metricInterpretation.netProfitableRate.available, false);
  assert.equal(audit.metricInterpretation.performance.available, false);
  assert.equal(audit.metricInterpretation.performance.returnPercent, null);
  assert.match(audit.metricInterpretation.performance.display, /N\/A — insufficient settled sample/u);
});

test("settled TP and SL outcomes remain distinct from net profitability", () => {
  const tp = {
    ...trackingRecord(),
    status: "settled",
    subsequentMarketResult: { exitReason: "take_profit", exitTimestamp: ENTRY_TIME + DAY_MS },
    hypotheticalPnl: -1,
    execution: { executedEntry: 100.03, costs: { entryFee: 0.06, exitFee: 0.06, tax: 0, spread: 0.02, slippage: 0.04, latency: 0, funding: 0.01, total: 0.19 } },
  };
  const sl = {
    ...trackingRecord(),
    id: "record-2",
    signalId: `ETH-V6-${SIGNAL_TIME + DAY_MS}`,
    timestamp: SIGNAL_TIME + DAY_MS,
    dataTimestamp: SIGNAL_TIME + DAY_MS,
    status: "settled",
    subsequentMarketResult: { exitReason: "stop_loss_same_bar", exitTimestamp: ENTRY_TIME + 2 * DAY_MS },
    hypotheticalPnl: -5,
  };
  assert.equal(classifyForwardOutcome(tp), "TP before SL");
  assert.equal(classifyForwardOutcome(sl), "SL before TP");
  assert.equal(tp.hypotheticalPnl > 0, false);
});

test("missed signals preserve their reason and never invent TP, SL, liquidity or simulated entry", () => {
  const missed = { signalTime: SIGNAL_TIME, entryTime: ENTRY_TIME, reason: "late_cycle_no_backfill", recordedAt: CYCLE_TIME };
  const audit = build({ state: state([], [missed]), previousState: state(), summary: summary() });
  assert.equal(audit.disposition, "signals_missed");
  const event = audit.missedSignals[0];
  assert.equal(event.outcomeState, "missed");
  assert.equal(event.missReason, "late_cycle_no_backfill");
  assert.equal(event.nextBarOpen, 100);
  assert.equal(event.actualSimulatedEntry, null);
  assert.equal(event.takeProfit, null);
  assert.equal(event.stopLoss, null);
  assert.equal(event.liquidityEvidence.status, "not_available");
});

test("funding timestamps fail closed when duplicated, unordered or in the future", () => {
  assert.throws(() => build({
    fundingRecords: [
      { timestamp: SIGNAL_TIME, rate: 0.0001 },
      { timestamp: SIGNAL_TIME, rate: 0.0002 },
    ],
  }), /strictly increasing/u);
  assert.throws(() => build({
    fundingRecords: [{ timestamp: CYCLE_TIME + 1, rate: 0.0001 }],
  }), /timestamp is invalid/u);
});

test("outcome contract explicitly reserves all required research states", () => {
  assert.deepEqual(FORWARD_OUTCOME_STATES, [
    "tracking",
    "TP before SL",
    "SL before TP",
    "expired",
    "missed",
    "invalidated",
    "data unavailable",
  ]);
});
