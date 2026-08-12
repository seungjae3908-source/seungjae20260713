import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceUsStockForwardState,
  createUsStockForwardState,
  summarizeUsStockForwardState,
} from "../src/us-stock-forward-validation.js";
import {
  US_STOCK_FORWARD_CANDIDATE,
  US_STOCK_FORWARD_CANDIDATE_SHA256,
  US_STOCK_FORWARD_START,
} from "../src/us-stock-forward-candidate.js";

const DAY = 24 * 60 * 60 * 1000;

function trendCandles({ count = 180, start = US_STOCK_FORWARD_START - 160 * DAY, observedAt } = {}) {
  const rows = [];
  let close = 100;
  for (let index = 0; index < count; index += 1) {
    const cycle = index % 25;
    const drift = cycle < 18 ? 0.45 : -0.15;
    const open = close;
    close = Math.max(20, open + drift);
    const timestamp = start + index * DAY;
    rows.push({
      timestamp,
      open,
      high: Math.max(open, close) + 0.6,
      low: Math.min(open, close) - 0.6,
      close,
      volume: 100 + (cycle === 18 ? 50 : index % 8),
      isClosed: true,
      observedAt: observedAt ?? timestamp + 8 * 60 * 60 * 1000,
    });
  }
  return rows;
}

function cloneForSymbols(rows, symbols) {
  return Object.fromEntries(symbols.map((symbol, offset) => [symbol, rows.map((row) => ({
    ...row,
    open: row.open + offset,
    high: row.high + offset,
    low: row.low + offset,
    close: row.close + offset,
  }))]));
}

test("forward candidate is immutable and prospective-only symbols are separate from historical selection", () => {
  assert.equal(US_STOCK_FORWARD_CANDIDATE.market, "US_STOCK");
  assert.equal(US_STOCK_FORWARD_CANDIDATE.params.regimeMaPeriod, 100);
  assert.equal(US_STOCK_FORWARD_CANDIDATE.params.rangeEntryZ, -2);
  assert.ok(US_STOCK_FORWARD_CANDIDATE_SHA256.length === 64);
  const historical = new Set([
    ...US_STOCK_FORWARD_CANDIDATE.seedSymbols,
    ...US_STOCK_FORWARD_CANDIDATE.historicalHoldoutSymbols,
  ]);
  assert.ok(US_STOCK_FORWARD_CANDIDATE.prospectiveOnlySymbols.every((symbol) => !historical.has(symbol)));
});

test("forward state refuses to start before the frozen boundary", () => {
  assert.throws(() => createUsStockForwardState(US_STOCK_FORWARD_START - 1), /cannot start before freeze boundary/);
  const state = createUsStockForwardState(US_STOCK_FORWARD_START);
  assert.equal(state.candidateManifestSha256, US_STOCK_FORWARD_CANDIDATE_SHA256);
  assert.equal(state.safeguards.liveOrderAllowed, false);
  assert.equal(state.safeguards.orderSubmitted, false);
});

test("late-discovered signals are never backfilled into forward evidence", () => {
  const symbol = US_STOCK_FORWARD_CANDIDATE.prospectiveOnlySymbols[0];
  const rows = trendCandles();
  const cycleTime = rows.at(-1).timestamp + 5 * DAY;
  const staleRows = rows.map((row) => ({ ...row, observedAt: cycleTime }));
  const state = advanceUsStockForwardState({
    state: createUsStockForwardState(US_STOCK_FORWARD_START),
    candlesBySymbol: { [symbol]: staleRows },
    cycleTime,
    maxSignalLagMs: 12 * 60 * 60 * 1000,
  });
  assert.equal(state.signals.length, 0);
  assert.ok(state.missedSignals.every((row) => row.reason === "late_cycle_no_backfill"));
});

test("fresh forward signals remain research-only and can settle on later closed candles", () => {
  const symbols = US_STOCK_FORWARD_CANDIDATE.prospectiveOnlySymbols.slice(0, 2);
  const first = trendCandles({ count: 166 });
  const firstCycle = first.at(-1).observedAt;
  const initial = advanceUsStockForwardState({
    state: createUsStockForwardState(US_STOCK_FORWARD_START),
    candlesBySymbol: cloneForSymbols(first, symbols),
    cycleTime: firstCycle,
  });
  assert.ok(initial.signals.every((row) => row.orderSubmitted === false));
  assert.ok(initial.signals.every((row) => row.usedForSelection === false));

  const later = trendCandles({ count: 205 });
  const laterCycle = later.at(-1).observedAt;
  const advanced = advanceUsStockForwardState({
    state: initial,
    candlesBySymbol: cloneForSymbols(later, symbols),
    cycleTime: laterCycle,
  });
  assert.ok(advanced.signals.length >= initial.signals.length);
  assert.ok(advanced.signals.some((row) => row.status === "settled") || advanced.signals.length === 0);
  const summary = summarizeUsStockForwardState(advanced, { minSettled: 1, minSymbols: 1, minElapsedMs: 0 });
  assert.equal(summary.executionPromotionAllowed, false);
  assert.ok(summary.blockersBeyondSignalShadow.includes("cost-aware prospective trade PnL shadow must pass separately"));
});

test("candidate-manifest mutation is rejected", () => {
  const state = {
    ...createUsStockForwardState(US_STOCK_FORWARD_START),
    candidateManifestSha256: "0".repeat(64),
  };
  assert.throws(() => advanceUsStockForwardState({
    state,
    candlesBySymbol: {},
    cycleTime: US_STOCK_FORWARD_START + DAY,
  }), /candidate mutation detected/);
});
