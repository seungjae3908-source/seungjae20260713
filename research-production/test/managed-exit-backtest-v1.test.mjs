import assert from 'node:assert/strict';
import test from 'node:test';

import { runIndependentSignalBacktest } from '../../market-prediction-lab/src/independent-strategy-backtest.js';
import { normalizeManagedPlanV1, runManagedExitBacktestV1 } from '../src/managed-exit-backtest-v1.mjs';

const HOUR = 3_600_000;
const START = Date.UTC(2024, 0, 1);

function randomWalk(n, seed = 7) {
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const out = [];
  let price = 100;
  for (let i = 0; i < n; i += 1) {
    const open = price;
    const close = Math.max(1, open * (1 + ((rnd() - 0.5) * 0.03)));
    out.push({ timestamp: START + (i * HOUR), open, close,
      high: Math.max(open, close) * (1 + (rnd() * 0.01)), low: Math.min(open, close) * (1 - (rnd() * 0.01)), volume: 100 });
    price = close;
  }
  return out;
}

// Flat bars (range 1, ATR 1) followed by a scripted path.
function scripted(path, { flat = 20, base = 100 } = {}) {
  const rows = [];
  for (let i = 0; i < flat; i += 1) rows.push({ open: base, high: base + 0.5, low: base - 0.5, close: base });
  for (const bar of path) rows.push(bar);
  return rows.map((row, i) => ({ timestamp: START + (i * HOUR), volume: 100, ...row }));
}

const COST = { entryFeeRate: 0.0006, exitFeeRate: 0.0006, slippageRate: 0.0005, spreadRate: 0.0002 };
const FUNDING = Array.from({ length: 200 }, (_, k) => ({ timestamp: START + (k * 8 * HOUR), rate: 0.0001 }));

for (const side of ['long', 'short']) {
  test(`fixed single plan reproduces the canonical backtester (${side})`, () => {
    const candles = randomWalk(1500, side === 'long' ? 11 : 23);
    const signalEvaluator = ({ index }) => (index % 7 === 0 ? { seed: index } : null);
    const input = { market: 'CRYPTO_FUTURES', side, symbol: 'BTCUSDT', timeframe: '1h', candles, fundingRates: FUNDING,
      initialCapital: 10_000, costModel: COST, riskModel: { riskPerTrade: 0.02, leverage: 5 } };
    const canonical = runIndependentSignalBacktest({ backtestInput: input, strategy: 's', strategyVersion: 'V',
      parameters: { atrPeriod: 14, stopAtrMultiple: 1.5, targetRiskMultiple: 2, timeBars: 24 }, signalEvaluator,
      period: { startTime: candles[0].timestamp, endTime: candles.at(-1).timestamp } });
    const managed = runManagedExitBacktestV1({ backtestInput: input, strategy: 's', strategyVersion: 'V', signalEvaluator,
      plan: { exit: { stopAtrMultiple: 1.5, targetR: 2, maxHoldBars: 24 } } });
    assert.ok(canonical.trades.length > 50);
    assert.equal(managed.trades.length, canonical.trades.length);
    canonical.trades.forEach((expected, i) => {
      const actual = managed.trades[i];
      assert.equal(actual.id, expected.id);
      assert.equal(actual.exitReason, expected.exitReason);
      assert.ok(Math.abs(actual.netPnl - expected.netPnl) < 1e-9, `trade ${i} netPnl`);
      assert.ok(Math.abs(actual.costs.funding - expected.costs.funding) < 1e-9);
    });
    assert.ok(Math.abs(managed.finalCapital - canonical.finalCapital) < 1e-6);
  });
}

const firstBar = ({ index }) => (index === 19 ? { go: true } : null);
const run = (candles, plan, side = 'long', extra = {}) => runManagedExitBacktestV1({
  backtestInput: { market: 'CRYPTO_FUTURES', side, symbol: 'BTCUSDT', timeframe: '1h', candles, initialCapital: 10_000,
    riskModel: { riskPerTrade: 0.01, leverage: 5 }, ...extra },
  plan, signalEvaluator: firstBar,
});

test('trailing stop rides a rally and exits on the pullback', () => {
  // ATR ≈ 1 → R = 2 (2 ATR). Price climbs to 120, then falls.
  const path = [{ open: 100, high: 100.5, low: 99.8, close: 100.2 }];
  for (let p = 101; p <= 120; p += 1) path.push({ open: p - 0.8, high: p + 0.3, low: p - 1, close: p });
  path.push({ open: 119, high: 119.2, low: 110, close: 111 });
  const result = run(scripted(path), { exit: { stopAtrMultiple: 2, targetR: null, trailing: { atrMultiple: 3 }, maxHoldBars: 500 } });
  const [trade] = result.trades;
  assert.equal(trade.exitReason, 'trailing_stop');
  assert.ok(trade.requestedExitPrice > 114, `exit ${trade.requestedExitPrice}`);
  assert.ok(trade.rMultiple > 5);
});

test('fixed target caps the same rally', () => {
  const path = [{ open: 100, high: 100.5, low: 99.8, close: 100.2 }];
  for (let p = 101; p <= 120; p += 1) path.push({ open: p - 0.8, high: p + 0.3, low: p - 1, close: p });
  const result = run(scripted(path), { exit: { stopAtrMultiple: 2, targetR: 2, maxHoldBars: 500 } });
  assert.equal(result.trades[0].exitReason, 'take_profit');
  assert.ok(result.trades[0].rMultiple < 2.1);
});

test('partial exits, then breakeven protects the rest', () => {
  // Entry 100, R = 2. Reaches 102.4 (> 1R), then falls to 98.
  const path = [
    { open: 100, high: 100.5, low: 99.6, close: 100.4 },
    { open: 100.4, high: 102.4, low: 100.2, close: 101.5 },
    { open: 101.5, high: 101.6, low: 98, close: 98.2 },
  ];
  const result = run(scripted(path), { exit: { stopAtrMultiple: 2, targetR: 3, partials: [{ atR: 1, fraction: 0.3 }, { atR: 2, fraction: 0.3 }], breakevenAfterR: 1, maxHoldBars: 100 } });
  const [trade] = result.trades;
  assert.equal(trade.partialExits, 1);
  assert.equal(trade.exitReason, 'breakeven_stop');
  const exits = trade.fills.filter((fill) => fill.kind === 'exit');
  assert.ok(Math.abs(exits[0].quantity / trade.quantity - 0.3) < 1e-9);
  assert.ok(Math.abs(exits[1].price - 100) < 1e-9);
  assert.ok(trade.netPnl > 0);
});

test('stop wins when stop and partial share a bar', () => {
  const path = [{ open: 100, high: 103, low: 97, close: 99 }];
  const [trade] = run(scripted(path), { exit: { stopAtrMultiple: 2, targetR: 3, partials: [{ atR: 1, fraction: 0.5 }], maxHoldBars: 100 } }).trades;
  assert.equal(trade.partialExits, 0);
  assert.equal(trade.exitReason, 'stop_loss');
});

test('time stop exits a trade that never works', () => {
  const path = Array.from({ length: 30 }, () => ({ open: 100, high: 100.4, low: 99.6, close: 100 }));
  const [trade] = run(scripted(path), { exit: { stopAtrMultiple: 2, targetR: 2, timeStop: { bars: 12, minFavorableR: 0.5 }, maxHoldBars: 48 } }).trades;
  assert.equal(trade.exitReason, 'time_stop');
  assert.equal(trade.barsHeld, 12);
});

test('pyramid starts small, adds on strength, worst-case add before stop', () => {
  const plan = { exit: { stopAtrMultiple: 2, targetR: 3, maxHoldBars: 100 }, entry: { initialFraction: 0.5, adds: [{ atR: 1, fraction: 0.5 }] } };
  const losing = run(scripted([{ open: 100, high: 100.3, low: 97.5, close: 97.8 }]), plan).trades[0];
  const single = run(scripted([{ open: 100, high: 100.3, low: 97.5, close: 97.8 }]), { exit: plan.exit }).trades[0];
  assert.equal(losing.adds, 0);
  assert.ok(Math.abs(losing.netPnl) < Math.abs(single.netPnl) * 0.6, 'half-size loss when the add never fills');
  // Add level and stop in one bar: add fills, then the stop.
  const whipsaw = run(scripted([{ open: 100, high: 102.5, low: 97.5, close: 98 }]), plan).trades[0];
  assert.equal(whipsaw.adds, 1);
  assert.equal(whipsaw.exitReason, 'stop_loss');
  // Working trade: add, stop to entry, target.
  const winner = run(scripted([
    { open: 100, high: 102.5, low: 99.8, close: 102.2 },
    { open: 102.2, high: 106.5, low: 102, close: 106.2 },
  ]), plan).trades[0];
  assert.equal(winner.adds, 1);
  assert.equal(winner.exitReason, 'take_profit');
  assert.ok(winner.averageEntryPrice > 100);
});

test('short trailing mirrors the long logic', () => {
  const path = [{ open: 100, high: 100.2, low: 99.5, close: 99.8 }];
  for (let p = 99; p >= 85; p -= 1) path.push({ open: p + 0.8, high: p + 1, low: p - 0.3, close: p });
  path.push({ open: 86, high: 92, low: 85.5, close: 91 });
  const [trade] = run(scripted(path), { exit: { stopAtrMultiple: 2, targetR: null, trailing: { atrMultiple: 3 }, maxHoldBars: 500 } }, 'short').trades;
  assert.equal(trade.exitReason, 'trailing_stop');
  assert.ok(trade.rMultiple > 3);
});

test('2026 holdout candles are refused', () => {
  const candles = randomWalk(50).map((row, i) => ({ ...row, timestamp: Date.UTC(2025, 11, 31, 22) + (i * HOUR) }));
  assert.throws(() => runManagedExitBacktestV1({ backtestInput: { market: 'CRYPTO_FUTURES', side: 'long', symbol: 'BTCUSDT', candles },
    plan: { exit: { targetR: 2 } }, signalEvaluator: () => null }), /holdout/i);
});

test('plan validation rejects unsafe shapes', () => {
  assert.throws(() => normalizeManagedPlanV1({ exit: { targetR: null } }), /UNBOUNDED|holding cap/);
  assert.throws(() => normalizeManagedPlanV1({ exit: { targetR: 2, partials: [{ atR: 2, fraction: 0.5 }] } }), /below the final target/);
  assert.throws(() => normalizeManagedPlanV1({ exit: { targetR: 3, partials: [{ atR: 1, fraction: 0.7 }, { atR: 2, fraction: 0.5 }] } }), /exceed/);
});
