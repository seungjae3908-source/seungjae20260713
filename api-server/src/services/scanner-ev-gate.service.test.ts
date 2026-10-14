import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectOutcomeSamples,
  evaluateEvGate,
  simulateTripleBarrierLong,
  sizeEntryByStopDistance,
  summarizeOutcomes,
  type EvCandle,
  type TripleBarrierParams,
} from './scanner-ev-gate.service';

const FREE: TripleBarrierParams = {
  stopPercent: 1,
  targetPercent: 2,
  maxBars: 4,
  feePercentPerSide: 0,
  slippagePercentPerSide: 0,
};

function candle(open: number, high: number, low: number, close: number, index: number): EvCandle {
  return { time: index * 60_000, open, high, low, close, volume: 100 };
}

test('target is hit after entry at the next candle open', () => {
  const candles = [
    candle(100, 100, 100, 100, 0), // signal candle
    candle(100, 101, 99.5, 100.5, 1), // entry at open 100
    candle(100.5, 102.5, 100, 102, 2), // high touches +2%
    candle(102, 102, 101, 101, 3),
    candle(101, 101, 101, 101, 4),
  ];
  const result = simulateTripleBarrierLong(candles, 0, FREE);
  assert.ok(result);
  assert.equal(result.outcome, 'TARGET');
  assert.equal(result.netReturnPercent, 2);
  assert.equal(result.barsHeld, 2);
});

test('stop wins when one candle touches both barriers', () => {
  const candles = [
    candle(100, 100, 100, 100, 0),
    candle(100, 103, 98.5, 100, 1), // spans stop (-1%) and target (+2%)
    candle(100, 100, 100, 100, 2),
    candle(100, 100, 100, 100, 3),
    candle(100, 100, 100, 100, 4),
  ];
  const result = simulateTripleBarrierLong(candles, 0, FREE);
  assert.ok(result);
  assert.equal(result.outcome, 'STOP');
  assert.equal(result.netReturnPercent, -1);
});

test('a candle that gaps below the stop fills at the open', () => {
  const candles = [
    candle(100, 100, 100, 100, 0),
    candle(100, 100.2, 99.9, 100, 1),
    candle(97, 97.5, 96, 96.5, 2), // opens 3% below entry, beyond the 1% stop
    candle(96, 96, 96, 96, 3),
    candle(96, 96, 96, 96, 4),
  ];
  const result = simulateTripleBarrierLong(candles, 0, FREE);
  assert.ok(result);
  assert.equal(result.outcome, 'STOP');
  assert.equal(result.netReturnPercent, -3);
});

test('time barrier exits at the close of the last window candle', () => {
  const candles = [
    candle(100, 100, 100, 100, 0),
    candle(100, 100.4, 99.8, 100.2, 1),
    candle(100.2, 100.5, 99.9, 100.1, 2),
    candle(100.1, 100.6, 99.9, 100.3, 3),
    candle(100.3, 100.7, 100, 100.5, 4),
    candle(100.5, 100.5, 100.5, 100.5, 5),
  ];
  const result = simulateTripleBarrierLong(candles, 0, FREE);
  assert.ok(result);
  assert.equal(result.outcome, 'TIME');
  assert.equal(result.barsHeld, 4);
  assert.equal(result.netReturnPercent, 0.5);
});

test('fees and slippage on both sides reduce the net return', () => {
  const candles = [
    candle(100, 100, 100, 100, 0),
    candle(100, 100.5, 99.9, 100, 1),
    candle(100, 102.5, 100, 102, 2),
    candle(102, 102, 102, 102, 3),
    candle(102, 102, 102, 102, 4),
  ];
  const costly = simulateTripleBarrierLong(candles, 0, {
    ...FREE,
    feePercentPerSide: 0.05,
    slippagePercentPerSide: 0.05,
  });
  assert.ok(costly);
  assert.equal(costly.outcome, 'TARGET');
  // Gross is measured from the already-slipped entry; exit slippage (0.05%)
  // and fees (0.05% x 2) still come off, so net is about 0.15 below gross.
  assert.ok(costly.netReturnPercent < costly.grossReturnPercent - 0.14);
  assert.ok(costly.netReturnPercent > 1.5);
});

test('unresolved trades without a full time window are not samples', () => {
  const candles = [
    candle(100, 100, 100, 100, 0),
    candle(100, 100.2, 99.9, 100, 1),
    candle(100, 100.2, 99.9, 100, 2),
  ];
  assert.equal(simulateTripleBarrierLong(candles, 0, FREE), null);
  assert.equal(simulateTripleBarrierLong(candles, 2, FREE), null);
});

test('invalid parameters throw instead of silently producing samples', () => {
  const candles = [candle(100, 100, 100, 100, 0), candle(100, 100, 100, 100, 1)];
  assert.throws(() => simulateTripleBarrierLong(candles, 0, { ...FREE, stopPercent: 0 }), /EV_STOP_PERCENT_INVALID/);
  assert.throws(() => simulateTripleBarrierLong(candles, 0, { ...FREE, maxBars: 0 }), /EV_MAX_BARS_INVALID/);
  assert.throws(() => simulateTripleBarrierLong(candles, 0, { ...FREE, feePercentPerSide: -1 }), /EV_FEE_INVALID/);
});

test('cooldown prevents overlapping trades from inflating samples', () => {
  const candles = Array.from({ length: 40 }, (_, index) => candle(100, 100.3, 99.9, 100, index));
  const always = () => true;
  const samples = collectOutcomeSamples(candles, always, { ...FREE, maxBars: 4 });
  // 39 possible signal indices, one trade per 4-candle window.
  assert.ok(samples.length <= 10);
  assert.ok(samples.length >= 8);
});

test('summary statistics split wins and losses', () => {
  const stats = summarizeOutcomes([2, -1, 2, -1, 2]);
  assert.equal(stats.sampleCount, 5);
  assert.equal(stats.winCount, 3);
  assert.equal(stats.winRate, 0.6);
  assert.equal(stats.averageWinPercent, 2);
  assert.equal(stats.averageLossPercent, -1);
  assert.equal(stats.expectedValuePercent, 0.8);
  assert.deepEqual(summarizeOutcomes([]).sampleCount, 0);
});

test('gate blocks thin samples even when the average looks great', () => {
  const decision = evaluateEvGate([3, 3, 3, 3, 3]);
  assert.equal(decision.allowed, false);
  assert.ok(decision.blockers.includes('EV_SAMPLES_INSUFFICIENT'));
});

test('gate blocks a rule that loses money after costs', () => {
  const returns = Array.from({ length: 60 }, (_, index) => (index % 2 === 0 ? 1 : -1.2));
  const decision = evaluateEvGate(returns);
  assert.equal(decision.allowed, false);
  assert.ok(decision.blockers.includes('EV_NOT_POSITIVE_AFTER_COSTS'));
});

test('gate blocks a noisy positive mean whose lower bound is not positive', () => {
  // Mean is slightly positive but variance is huge: not distinguishable from zero.
  const returns = Array.from({ length: 40 }, (_, index) => (index % 2 === 0 ? 6 : -5.5));
  const decision = evaluateEvGate(returns);
  assert.ok(decision.stats.expectedValuePercent > 0);
  assert.equal(decision.allowed, false);
  assert.ok(decision.blockers.includes('EV_LOWER_BOUND_NOT_POSITIVE'));
});

test('gate allows a consistently profitable rule with enough samples', () => {
  const returns = Array.from({ length: 60 }, (_, index) => (index % 3 === 0 ? -0.8 : 1.4));
  const decision = evaluateEvGate(returns);
  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.blockers, []);
});

test('sizing is capped at the maximum entry amount', () => {
  const sized = sizeEntryByStopDistance({
    accountValueKrw: 100_000_000,
    riskPercent: 1,
    entryPrice: 50_000,
    stopDistance: 500,
    maxEntryKrw: 1_000_000,
  });
  assert.ok(sized);
  assert.equal(sized.cappedByMaxEntry, true);
  assert.equal(sized.notionalKrw, 1_000_000);
  assert.equal(sized.quantity, 20);
});

test('sizing uses the risk budget when it is below the cap', () => {
  const sized = sizeEntryByStopDistance({
    accountValueKrw: 10_000_000,
    riskPercent: 0.5,
    entryPrice: 50_000,
    stopDistance: 5_000,
    maxEntryKrw: 1_000_000,
  });
  assert.ok(sized);
  assert.equal(sized.cappedByMaxEntry, false);
  assert.equal(sized.riskKrw, 50_000);
  assert.equal(sized.quantity, 10);
  assert.equal(sized.notionalKrw, 500_000);
});

test('sizing fails closed on invalid inputs', () => {
  assert.equal(sizeEntryByStopDistance({
    accountValueKrw: 0, riskPercent: 1, entryPrice: 1, stopDistance: 1, maxEntryKrw: 1,
  }), null);
  assert.equal(sizeEntryByStopDistance({
    accountValueKrw: 1, riskPercent: 1, entryPrice: 1, stopDistance: Number.NaN, maxEntryKrw: 1,
  }), null);
});
