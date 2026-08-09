import test from "node:test";
import assert from "node:assert/strict";
import {
  ETH_V6_FORWARD_CANDIDATE,
  ETH_V6_FORWARD_INITIAL_CAPITAL,
  ETH_V6_FORWARD_START,
  advanceEthV6ForwardState,
  compareReplayMetrics,
  createEthV6ForwardState,
  summarizeEthV6ForwardState,
} from "../src/eth-v6-forward-validation.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function breakoutSequence() {
  const start = Date.UTC(2026, 6, 23);
  const rows = [];
  for (let index = 0; index < 15; index += 1) {
    rows.push({ symbol: "ETHUSDT", timestamp: start + index * DAY_MS, open: 100, high: 101, low: 99, close: 100, volume: 1000 });
  }
  rows.push({ symbol: "ETHUSDT", timestamp: start + 15 * DAY_MS, open: 100, high: 105, low: 99.5, close: 104, volume: 2000 });
  rows.push({ symbol: "ETHUSDT", timestamp: start + 16 * DAY_MS, open: 103, high: 106, low: 101.5, close: 105, volume: 1800 });
  rows.push({ symbol: "ETHUSDT", timestamp: start + 17 * DAY_MS, open: 105, high: 105.2, low: 104.8, close: 105, volume: 10 });
  return rows;
}

test("frozen forward candidate is the one surviving ETH futures V6 long candidate", () => {
  assert.equal(ETH_V6_FORWARD_CANDIDATE.id, "eth-futures-long-v6");
  assert.equal(ETH_V6_FORWARD_CANDIDATE.market, "CRYPTO_FUTURES");
  assert.equal(ETH_V6_FORWARD_CANDIDATE.side, "long");
  assert.equal(ETH_V6_FORWARD_CANDIDATE.parameters.stopAtrMultiple, 1);
  assert.equal(ETH_V6_FORWARD_CANDIDATE.parameters.targetRiskMultiple, 2);
});

test("forward state cannot start before the untouched holdout closes", () => {
  assert.throws(() => createEthV6ForwardState(ETH_V6_FORWARD_START - 1), /cannot start before the final holdout closes/u);
  const state = createEthV6ForwardState(ETH_V6_FORWARD_START);
  assert.equal(state.paper.equity, ETH_V6_FORWARD_INITIAL_CAPITAL);
  assert.equal(state.safeguards.liveOrderAllowed, false);
  assert.equal(state.safeguards.privateAccountRequestAllowed, false);
});

test("identical replay metrics pass and any changed metric fails", () => {
  const metrics = { finalCapital: 1_027_745.2, returnPercent: 2.77, successRatePercent: 66.67, profitFactor: 3.55, maximumDrawdownPercent: 1.07, expectancy: 9248, trades: 3 };
  assert.equal(compareReplayMetrics(metrics, { ...metrics }).passed, true);
  const failed = compareReplayMetrics(metrics, { ...metrics, trades: 4 });
  assert.equal(failed.passed, false);
  assert.equal(failed.usedForSelection, false);
  assert.equal(failed.parametersChanged, false);
});

test("a fresh closed V6 signal creates only a hypothetical tracking record at the next open", () => {
  const candles = breakoutSequence();
  const entryTime = candles.at(-1).timestamp;
  const cycleTime = entryTime + 60 * 60 * 1000;
  const state = advanceEthV6ForwardState({
    state: createEthV6ForwardState(ETH_V6_FORWARD_START),
    candles,
    fundingRates: [],
    cycleTime,
  });
  assert.equal(state.ledger.records.length, 1);
  const record = state.ledger.records[0];
  assert.equal(record.status, "tracking");
  assert.equal(record.entryPlan.action, "LONG");
  assert.equal(record.entryPlan.entryTime, entryTime);
  assert.equal(record.entryPlan.entryPrice, candles.at(-1).open);
  assert.equal(record.orderSubmitted, false);
  assert.equal(record.privateAccountRequested, false);
  assert.equal(state.paper.equity, ETH_V6_FORWARD_INITIAL_CAPITAL);
});

test("the same paper position settles conservatively without creating a real order", () => {
  const first = breakoutSequence();
  const entryTime = first.at(-1).timestamp;
  const firstCycle = entryTime + 60 * 60 * 1000;
  const tracking = advanceEthV6ForwardState({
    state: createEthV6ForwardState(ETH_V6_FORWARD_START),
    candles: first,
    fundingRates: [],
    cycleTime: firstCycle,
  });
  const target = tracking.ledger.records[0].targets[0];
  const closedEntry = { ...first.at(-1), high: target + 1, low: first.at(-1).open - 0.2, close: target };
  const next = { symbol: "ETHUSDT", timestamp: entryTime + DAY_MS, open: target, high: target, low: target, close: target, volume: 1 };
  const second = [...first.slice(0, -1), closedEntry, next];
  const settled = advanceEthV6ForwardState({
    state: tracking,
    candles: second,
    fundingRates: [],
    cycleTime: next.timestamp + 60 * 60 * 1000,
  });
  assert.equal(settled.ledger.records[0].status, "settled");
  assert.equal(settled.ledger.records[0].subsequentMarketResult.exitReason, "take_profit");
  assert.equal(settled.ledger.records[0].orderSubmitted, false);
  assert.ok(settled.paper.equity > ETH_V6_FORWARD_INITIAL_CAPITAL);
  const summary = summarizeEthV6ForwardState(settled);
  assert.equal(summary.settledTrades, 1);
  assert.equal(summary.status, "shadow_continue");
  assert.equal(summary.safeguards.liveOrderAllowed, false);
});

test("late cycles never backfill a signal after the hypothetical entry window is gone", () => {
  const candles = breakoutSequence();
  const entryTime = candles.at(-1).timestamp;
  const lateCycle = entryTime + 8 * 60 * 60 * 1000;
  const state = advanceEthV6ForwardState({
    state: createEthV6ForwardState(ETH_V6_FORWARD_START),
    candles,
    fundingRates: [],
    cycleTime: lateCycle,
  });
  assert.equal(state.ledger.records.length, 0);
  assert.equal(state.missedSignals.length, 1);
  assert.equal(state.missedSignals[0].reason, "late_cycle_no_backfill");
});
