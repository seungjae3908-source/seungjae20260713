import assert from 'node:assert/strict';
import test from 'node:test';

import { runIndependentSignalBacktest } from '../../market-prediction-lab/src/independent-strategy-backtest.js';
import {
  normalizeExtendedExitV1,
  runExtendedExitBacktestV1,
  runExtendedExitFinalHoldoutV1,
} from '../src/extended-exit-backtest-v1.mjs';

function walk(n, { seed = 3, start = Date.UTC(2024, 0, 1), step = 3_600_000, drift = 0 } = {}) {
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const out = [];
  let price = 100;
  for (let i = 0; i < n; i += 1) {
    const open = price;
    const close = Math.max(1, open * (1 + drift + ((rnd() - 0.5) * 0.03)));
    out.push({ timestamp: start + (i * step), open, close,
      high: Math.max(open, close) * (1 + (rnd() * 0.01)), low: Math.min(open, close) * (1 - (rnd() * 0.01)), volume: 1000 });
    price = close;
  }
  return out;
}

const every = (k) => ({ index }) => (index % k === 0 ? { k } : null);

function input({ candles, market = 'CRYPTO_SPOT', side = 'long', parameters, cost, funding = [], leverage = 1 }) {
  return {
    backtestInput: {
      market, side, symbol: { CRYPTO_FUTURES: 'BTCUSDT', KR_STOCK: '005930' }[market] ?? 'KRW-BTC', timeframe: '1h', candles, fundingRates: funding, initialCapital: 1_000_000,
      costModel: cost ?? { entryFeeRate: 0.0005, exitFeeRate: 0.0005, slippageRate: 0.0005 },
      riskModel: { riskPerTrade: 0.01, leverage },
    },
    strategy: 'test', strategyVersion: 'T',
    parameters: { atrPeriod: 14, stopAtrMultiple: 1.5, targetRiskMultiple: 2, timeBars: 24, ...parameters },
    signalEvaluator: every(17),
    period: { startTime: candles[0].timestamp, endTime: candles.at(-1).timestamp },
  };
}

test('plain exits delegate to the canonical backtester (identical object shape and trades)', () => {
  const candles = walk(1500);
  const canonical = runIndependentSignalBacktest(input({ candles }));
  const delegated = runExtendedExitBacktestV1(input({ candles }));
  assert.deepEqual(delegated.trades.map((t) => [t.entryTime, t.exitTime, t.netPnl]), canonical.trades.map((t) => [t.entryTime, t.exitTime, t.netPnl]));
  assert.equal(delegated.strategyVersion, canonical.strategyVersion);
});

test('the extended loop reproduces the canonical loop exactly on plain exits (spot, futures long/short, funding, costs)', () => {
  const cases = [
    { candles: walk(2000, { seed: 5 }) },
    { candles: walk(2000, { seed: 9, drift: 0.0004 }), market: 'CRYPTO_FUTURES', leverage: 5 },
    { candles: walk(2000, { seed: 13, drift: -0.0004 }), market: 'CRYPTO_FUTURES', side: 'short', leverage: 3,
      funding: Array.from({ length: 250 }, (_, i) => ({ timestamp: Date.UTC(2024, 0, 1) + (i * 8 * 3_600_000), rate: (i % 3 === 0 ? 0.0001 : -0.00005) })) },
    { candles: walk(2000, { seed: 21, step: 86_400_000, start: Date.UTC(2019, 0, 1) }), market: 'KR_STOCK', cost: { entryFeeRate: 0.001, exitFeeRate: 0.001, taxRate: 0.002, slippageRate: 0.001, spreadRate: 0.0004 } },
  ];
  for (const row of cases) {
    const canonical = runIndependentSignalBacktest(input(row));
    const forced = runExtendedExitBacktestV1(input(row), { forceExtendedLoop: true });
    assert.ok(canonical.trades.length > 20);
    assert.equal(forced.trades.length, canonical.trades.length);
    forced.trades.forEach((trade, i) => {
      const ref = canonical.trades[i];
      assert.equal(trade.entryTime, ref.entryTime);
      assert.equal(trade.exitTime, ref.exitTime);
      assert.equal(trade.signalTime, ref.signalTime);
      assert.equal(trade.exitReason, ref.exitReason);
      assert.ok(Math.abs(trade.netPnl - ref.netPnl) < 1e-6, `netPnl ${trade.netPnl} vs ${ref.netPnl}`);
      assert.ok(Math.abs(trade.equityBefore - ref.equityBefore) < 1e-6);
    });
  }
});

test('trailing stop ratchets only from finished bars and locks profit in a trend', () => {
  // Steady uptrend then a sharp drop: the trailing stop must exit above entry.
  const start = Date.UTC(2024, 0, 1);
  const candles = [];
  let price = 100;
  for (let i = 0; i < 120; i += 1) {
    const open = price;
    const close = i < 80 ? open * 1.01 : open * 0.97;
    candles.push({ timestamp: start + (i * 3_600_000), open, close, high: Math.max(open, close) * 1.002, low: Math.min(open, close) * 0.998, volume: 10 });
    price = close;
  }
  const signal = ({ index }) => (index === 20 ? { first: true } : null);
  const result = runExtendedExitBacktestV1({
    ...input({ candles, parameters: { timeBars: null, extended: { trailing: { atrMultiple: 2, activationRiskMultiple: 1 } } } }),
    signalEvaluator: signal,
  });
  assert.equal(result.trades.length, 1);
  const trade = result.trades[0];
  assert.match(trade.exitReason, /trailing_stop/u);
  assert.ok(trade.averageExitPrice > trade.entryPrice * 1.3, 'trailing stop kept most of the trend');
  assert.ok(trade.finalStopPrice > trade.initialStopPrice);
  // Exit happened after the top (bar 80), never before it.
  assert.ok(trade.exitTime >= candles[80].timestamp);
});

test('partial take-profit then break-even: one trade record with two legs', () => {
  const start = Date.UTC(2024, 0, 1);
  const candles = [];
  let price = 100;
  for (let i = 0; i < 80; i += 1) {
    const open = price;
    // Up 8 bars (hits 1.5R partial), then fall back through entry.
    const close = i >= 30 && i < 38 ? open * 1.015 : i >= 38 && i < 50 ? open * 0.985 : open * (1 + ((i % 2) ? 0.002 : -0.002));
    candles.push({ timestamp: start + (i * 3_600_000), open, close, high: Math.max(open, close) * 1.001, low: Math.min(open, close) * 0.999, volume: 10 });
    price = close;
  }
  const result = runExtendedExitBacktestV1({
    ...input({ candles, parameters: { timeBars: 200, extended: { partials: [{ riskMultiple: 1.5, fraction: 0.5 }], finalTargetRiskMultiple: 6 } } }),
    signalEvaluator: ({ index }) => (index === 29 ? { go: 1 } : null),
  });
  assert.equal(result.trades.length, 1);
  const trade = result.trades[0];
  assert.equal(trade.legs.length, 2);
  assert.equal(trade.legs[0].reason, 'partial_take_profit');
  assert.ok(Math.abs(trade.legs[0].quantity - (trade.quantity * 0.5)) < 1e-9);
  assert.ok(trade.finalStopPrice >= trade.entryPrice, 'stop moved to break-even after the first partial');
  assert.ok(trade.legs[1].price >= trade.entryPrice * 0.999);
  assert.ok(trade.netPnl > 0, 'scale-out kept a profit even though price returned to entry');
});

test('stop-first on an ambiguous bar also applies to partial targets', () => {
  const start = Date.UTC(2024, 0, 1);
  const candles = walk(40, { seed: 2 }).map((row, i) => ({ ...row, timestamp: start + (i * 3_600_000) }));
  const entryIndex = 31;
  const base = candles[entryIndex].open;
  // Bar after entry spans both the stop and the partial target.
  candles[entryIndex] = { ...candles[entryIndex], high: base * 1.001, low: base * 0.999, close: base };
  candles[entryIndex + 1] = { timestamp: candles[entryIndex + 1].timestamp, open: base, high: base * 1.5, low: base * 0.5, close: base, volume: 10 };
  const result = runExtendedExitBacktestV1({
    ...input({ candles, parameters: { timeBars: 50, extended: { partials: [{ riskMultiple: 1, fraction: 0.5 }], finalTargetRiskMultiple: 3 } } }),
    signalEvaluator: ({ index }) => (index === entryIndex - 1 ? { go: 1 } : null),
  });
  const trade = result.trades[0];
  assert.equal(trade.legs.length, 1);
  assert.equal(trade.exitReason, 'stop_loss_same_bar');
});

test('holdout stays locked unless the explicit one-time final holdout entry point is used', () => {
  const candles = walk(1500, { start: Date.UTC(2025, 11, 1) });
  const parameters = { extended: { trailing: { atrMultiple: 2 } } };
  assert.throws(() => runExtendedExitBacktestV1({ ...input({ candles, parameters }), period: { startTime: candles[0].timestamp, endTime: candles.at(-1).timestamp } }),
    /INDEPENDENT_HOLDOUT_LOCKED/u);
  assert.throws(() => runExtendedExitFinalHoldoutV1({ ...input({ candles, parameters }), period: { startTime: Date.UTC(2026, 0, 1), endTime: candles.at(-1).timestamp } }),
    /FINAL_HOLDOUT_EXPLICIT_OPT_IN_REQUIRED/u);
  const ok = runExtendedExitFinalHoldoutV1({ ...input({ candles, parameters }), period: { startTime: Date.UTC(2026, 0, 1), endTime: candles.at(-1).timestamp, includeFinalHoldout: true } });
  assert.ok(ok.trades.every((trade) => trade.signalTime >= Date.UTC(2026, 0, 1)));
});

test('invalid extended exits fail closed', () => {
  assert.throws(() => normalizeExtendedExitV1({ partials: [{ riskMultiple: 1, fraction: 0.5 }] }), /EXTENDED_EXIT_WITHOUT_TERMINAL_EXIT/u);
  assert.throws(() => normalizeExtendedExitV1({ partials: [{ riskMultiple: 2, fraction: 0.5 }, { riskMultiple: 1, fraction: 0.2 }], trailing: { atrMultiple: 2 } }), /PARTIALS_NOT_ASCENDING/u);
  assert.throws(() => normalizeExtendedExitV1({ partials: [{ riskMultiple: 1, fraction: 0.6 }, { riskMultiple: 2, fraction: 0.4 }], trailing: { atrMultiple: 2 } }), /PARTIALS_CLOSE_WHOLE_POSITION/u);
  assert.throws(() => normalizeExtendedExitV1({ trailing: { atrMultiple: 0 } }), /TRAILING_ATR_MULTIPLE_INVALID/u);
  assert.equal(normalizeExtendedExitV1(null), null);
});
