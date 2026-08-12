import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceUsStockForwardPnlState,
  createUsStockForwardPnlState,
  summarizeUsStockForwardPnlState,
} from "../src/us-stock-forward-pnl-shadow.js";
import {
  US_STOCK_FORWARD_CANDIDATE,
  US_STOCK_FORWARD_CANDIDATE_SHA256,
  US_STOCK_FORWARD_START,
} from "../src/us-stock-forward-candidate.js";

const DAY = 24 * 60 * 60 * 1000;

function baseCandles(count = 150) {
  return Array.from({ length: count }, (_, index) => {
    const timestamp = US_STOCK_FORWARD_START - 110 * DAY + index * DAY;
    return {
      timestamp,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1000,
      isClosed: true,
      observedAt: timestamp + 8 * 60 * 60 * 1000,
    };
  });
}

function signalAt(rows, index, overrides = {}) {
  const timestamp = rows[index].timestamp;
  return Object.freeze({
    id: `signal-${index}-${overrides.regime ?? "trend"}`,
    status: "pending",
    candidateId: US_STOCK_FORWARD_CANDIDATE.id,
    candidateManifestSha256: US_STOCK_FORWARD_CANDIDATE_SHA256,
    market: "US_STOCK",
    symbol: "AVGO",
    timeframe: "1d",
    signalTimestamp: timestamp,
    observedAt: timestamp + 8 * 60 * 60 * 1000,
    signalClose: 100,
    regime: "trend",
    atr: 2,
    evidence: {},
    usedForSelection: false,
    orderSubmitted: false,
    ...overrides,
  });
}

function signalState(signals) {
  return Object.freeze({
    candidateId: US_STOCK_FORWARD_CANDIDATE.id,
    candidateManifestSha256: US_STOCK_FORWARD_CANDIDATE_SHA256,
    signals: Object.freeze(signals),
  });
}

test("prospective PnL waits for a later cycle and uses next-session open only", () => {
  const rows = baseCandles();
  const index = 120;
  const signal = signalAt(rows, index);
  const signalCycle = signal.observedAt;
  const beforeEntry = rows.slice(0, index + 1).map((row) => ({ ...row, observedAt: Math.min(row.observedAt, signalCycle) }));
  const waiting = advanceUsStockForwardPnlState({
    state: createUsStockForwardPnlState(US_STOCK_FORWARD_START),
    signalState: signalState([signal]),
    candlesBySymbol: { AVGO: beforeEntry },
    cycleTime: signalCycle,
  });
  assert.equal(waiting.trades.length, 0);
  assert.equal(waiting.processedSignalIds.length, 0);

  const entry = { ...rows[index + 1], high: 107, low: 99, close: 105 };
  const nextRows = [...rows.slice(0, index + 1), entry];
  const cycleTime = entry.observedAt;
  const advanced = advanceUsStockForwardPnlState({
    state: waiting,
    signalState: signalState([signal]),
    candlesBySymbol: { AVGO: nextRows },
    cycleTime,
  });
  assert.equal(advanced.trades.length, 1);
  assert.equal(advanced.trades[0].entryTimestamp, entry.timestamp);
  assert.equal(advanced.trades[0].entryOpen, 100);
  assert.equal(advanced.trades[0].status, "settled");
  assert.equal(advanced.trades[0].exitReason, "target");
  assert.equal(advanced.trades[0].rawExit, 106);
});

test("cost and 1.5x stress reduce the same prospective trade PnL", () => {
  const rows = baseCandles();
  const index = 120;
  const signal = signalAt(rows, index);
  const entry = { ...rows[index + 1], high: 107, low: 99, close: 105 };
  const advanced = advanceUsStockForwardPnlState({
    state: createUsStockForwardPnlState(US_STOCK_FORWARD_START),
    signalState: signalState([signal]),
    candlesBySymbol: { AVGO: [...rows.slice(0, index + 1), entry] },
    cycleTime: entry.observedAt,
  });
  const trade = advanced.trades[0];
  assert.ok(trade.grossReturn > trade.baseNetReturn);
  assert.ok(trade.baseNetReturn > trade.stressedNetReturn);
  assert.equal(trade.baseCostRatePerSide, 0.0015);
  assert.ok(Math.abs(trade.stressedCostRatePerSide - 0.00225) < 1e-12);
  const summary = summarizeUsStockForwardPnlState(advanced, { minSettled: 1, minSymbols: 1, minElapsedMs: 0 });
  assert.equal(summary.executionPromotionAllowed, false);
  assert.equal(summary.base.tradeCount, 1);
  assert.equal(summary.stressed.tradeCount, 1);
});

test("same-bar stop and target resolves to the stop conservatively", () => {
  const rows = baseCandles();
  const index = 120;
  const signal = signalAt(rows, index);
  const entry = { ...rows[index + 1], high: 107, low: 95, close: 100 };
  const advanced = advanceUsStockForwardPnlState({
    state: createUsStockForwardPnlState(US_STOCK_FORWARD_START),
    signalState: signalState([signal]),
    candlesBySymbol: { AVGO: [...rows.slice(0, index + 1), entry] },
    cycleTime: entry.observedAt,
  });
  assert.equal(advanced.trades[0].status, "settled");
  assert.equal(advanced.trades[0].exitReason, "stop_same_bar_conservative");
  assert.equal(advanced.trades[0].rawExit, 96);
  assert.ok(advanced.trades[0].baseNetReturn < 0);
});

test("gap beyond frozen 4 percent threshold is skipped rather than backfilled", () => {
  const rows = baseCandles();
  const index = 120;
  const signal = signalAt(rows, index);
  const entry = { ...rows[index + 1], open: 106, high: 107, low: 105, close: 106 };
  const advanced = advanceUsStockForwardPnlState({
    state: createUsStockForwardPnlState(US_STOCK_FORWARD_START),
    signalState: signalState([signal]),
    candlesBySymbol: { AVGO: [...rows.slice(0, index + 1), entry] },
    cycleTime: entry.observedAt,
  });
  assert.equal(advanced.trades.length, 0);
  assert.equal(advanced.skippedSignals.length, 1);
  assert.equal(advanced.skippedSignals[0].reason, "entry_gap_exceeded");
  assert.equal(advanced.processedSignalIds.includes(signal.id), true);
});

test("PnL state rejects candidate mutation and always remains non-executable", () => {
  const state = { ...createUsStockForwardPnlState(US_STOCK_FORWARD_START), candidateManifestSha256: "0".repeat(64) };
  assert.throws(() => advanceUsStockForwardPnlState({
    state,
    signalState: signalState([]),
    candlesBySymbol: {},
    cycleTime: US_STOCK_FORWARD_START + DAY,
  }), /candidate mutation detected/);
  const clean = createUsStockForwardPnlState(US_STOCK_FORWARD_START);
  assert.equal(clean.safeguards.liveOrderAllowed, false);
  assert.equal(clean.safeguards.orderSubmitted, false);
});
