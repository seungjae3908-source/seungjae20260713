import test from 'node:test';
import assert from 'node:assert/strict';
import { originalMinuteExitFillV2 as fill, originalMinuteLiquidationV2 as liquidation,
  recordOriginalMinuteEquityV2 as mark } from '../src/original-minute-execution-model-v2.js';

const strategy = { stopPercent: 5, targetPercent: 10 };
const costs = { entryFeeRate: 0, exitFeeRate: 0, spreadRate: 0, slippageRate: 0,
  latencyRate: 0, taxRate: 0, fundingRatePerSession: 0 };
const bar = (open, high, low, close) => ({ open, high, low, close, startMs: 60_000, endMs: 120_000 });

test('LONG stop gaps use the opening print, not an optimistic untraded stop', () => {
  const exit = fill(bar(90,91,89,90), 'LONG', 100, strategy);
  assert.deepEqual(exit, { price: 90, reason: 'gap_stop_open', atMs: 60_000 });
  assert.equal(liquidation({ side: 'LONG', entryPrice: 100, quantity: 1 }, exit.price, costs, 'KR_STOCK').net, -10);
});
test('SHORT stop gaps use the opening print symmetrically', () => {
  const exit = fill(bar(110,111,109,110), 'SHORT', 100, strategy);
  assert.deepEqual(exit, { price: 110, reason: 'gap_stop_open', atMs: 60_000 });
  assert.equal(liquidation({ side: 'SHORT', entryPrice: 100, quantity: 1 }, exit.price, costs, 'CRYPTO_FUTURES').net, -10);
});
test('known favorable opening gaps precede a later opposite intrabar extreme', () => {
  assert.equal(fill(bar(112,113,90,100), 'LONG', 100, strategy).reason, 'gap_target_open');
  assert.equal(fill(bar(88,110,87,100), 'SHORT', 100, strategy).reason, 'gap_target_open');
  assert.equal(fill(bar(110,112,94,100), 'LONG', 100, strategy).reason, 'gap_target_open');
});
test('ambiguous intrabar target and stop retain the conservative stop-first contract', () => {
  assert.equal(fill(bar(100,112,94,101), 'LONG', 100, strategy).price, 95);
  assert.equal(fill(bar(100,106,89,99), 'SHORT', 100, strategy).price, 105);
  assert.equal(fill(bar(100,104,96,101), 'LONG', 100, strategy), null);
});
test('invalid OHLC cannot manufacture a modeled exit', () => {
  assert.throws(() => fill(bar(100,90,110,100), 'LONG', 100, strategy), /INPUT_INVALID/);
});
test('liquidation includes fees, spread once, tax, latency and futures funding', () => {
  const position = { side: 'LONG', entryPrice: 100, quantity: 1 };
  const rates = { entryFeeRate: .01, exitFeeRate: .01, spreadRate: .02,
    slippageRate: .01, latencyRate: .01, taxRate: .01, fundingRatePerSession: .01 };
  const result = liquidation(position, 110, rates, 'CRYPTO_FUTURES');
  assert.ok(Math.abs(result.out - 108.9) < 1e-10);
  assert.ok(Math.abs(result.net - (8.9 - 3 - 4.356 - 1)) < 1e-10);
  assert.ok(Math.abs(result.cost - (3 + 4.356 + 1 + 2.089)) < 1e-10);
});
test('MTM drawdown retains an open loss even if the final realized PnL recovers', () => {
  for (const side of ['LONG', 'SHORT']) {
    const state = { peak: 1000, maxDrawdownPercent: 0 };
    const p = { side, entryPrice: 100, quantity: 10 };
    const loss = liquidation(p, side === 'LONG' ? 80 : 120, costs, 'CRYPTO_FUTURES').net;
    mark(state, 1000 + loss);
    mark(state, 1000);
    assert.equal(state.maxDrawdownPercent, 20);
  }
});
test('MTM high water includes open gains before retracement', () => {
  const state = { peak: 1000, maxDrawdownPercent: 0 };
  mark(state, 1200); mark(state, 900);
  assert.equal(state.maxDrawdownPercent, 25);
});

test('malformed or reversed candle clock cannot claim an opening fill', () => {
  for (const broken of [
    { ...bar(90, 91, 89, 90), startMs: undefined },
    { ...bar(90, 91, 89, 90), startMs: 121_000 },
    { ...bar(90, 91, 89, 90), endMs: 60_000 },
    { ...bar(90, 91, 89, 90), endMs: Number.POSITIVE_INFINITY },
  ]) {
    assert.throws(() => fill(broken, 'LONG', 100, strategy), /INPUT_INVALID/);
  }
  assert.throws(() => fill(bar(90, 91, 89, 90), 'LONG', 100,
    { stopPercent: 100, targetPercent: 10 }), /INPUT_INVALID/);
  assert.throws(() => fill(bar(100, 110, 90, 100), 'SHORT', 100,
    { stopPercent: 5, targetPercent: 100 }), /INPUT_INVALID/);
});

test('standalone liquidation never converts an invalid side or negative costs into profit', () => {
  const position = { side: 'LONG', entryPrice: 100, quantity: 1 };
  for (const bad of [
    { ...position, side: 'UNKNOWN' },
    { ...position, quantity: 0 },
    { ...position, quantity: -1 },
    { ...position, entryPrice: Number.NaN },
  ]) {
    assert.throws(() => liquidation(bad, 110, costs, 'CRYPTO_FUTURES'),
      /LIQUIDATION_INPUT_INVALID/);
  }
  for (const bad of [
    { ...costs, exitFeeRate: -0.05 },
    { ...costs, spreadRate: Number.NaN },
    { ...costs, slippageRate: undefined },
    { ...costs, fundingRatePerSession: -0.01 },
    { ...costs, latencyRate: 0.2 },
  ]) {
    assert.throws(() => liquidation(position, 110, bad, 'CRYPTO_FUTURES'),
      /LIQUIDATION_INPUT_INVALID/);
  }
  assert.throws(() => liquidation(position, 110, costs, 'UNKNOWN_MARKET'),
    /LIQUIDATION_INPUT_INVALID/);
  assert.throws(() => liquidation(position, 0, costs, 'CRYPTO_FUTURES'),
    /LIQUIDATION_INPUT_INVALID/);
  assert.throws(() => liquidation(position, 110,
    { ...costs, fundingRatePerSession: 0.01 }, 'KR_STOCK'),
  /LIQUIDATION_INPUT_INVALID/);
});

test('missing or corrupted equity high water cannot hide drawdown', () => {
  for (const invalid of [
    null,
    {},
    { peak: 0, maxDrawdownPercent: 0 },
    { peak: Number.NaN, maxDrawdownPercent: 0 },
    { peak: 1000, maxDrawdownPercent: undefined },
    { peak: 1000, maxDrawdownPercent: -1 },
  ]) {
    assert.throws(() => mark(invalid, 900), /EQUITY_STATE_INVALID/);
  }
});
