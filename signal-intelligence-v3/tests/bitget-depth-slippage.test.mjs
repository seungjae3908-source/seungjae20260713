import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateReferenceSlippage } from '../src/bitget-depth-slippage.mjs';

test('LONG consumes asks and produces non-negative VWAP slippage', () => {
  const result = estimateReferenceSlippage([
    { price: 100, quantity: 5 },
    { price: 101, quantity: 10 },
  ], 'LONG', 1000);
  assert.equal(result.available, true);
  assert.equal(result.bestPrice, 100);
  assert.ok(result.vwap > 100);
  assert.ok(result.slippagePct > 0);
});

test('SHORT consumes bids and produces non-negative VWAP slippage', () => {
  const result = estimateReferenceSlippage([
    { price: 100, quantity: 5 },
    { price: 99, quantity: 10 },
  ], 'SHORT', 1000);
  assert.equal(result.available, true);
  assert.equal(result.bestPrice, 100);
  assert.ok(result.vwap < 100);
  assert.ok(result.slippagePct > 0);
});

test('insufficient public depth never invents slippage', () => {
  const result = estimateReferenceSlippage([{ price: 100, quantity: 1 }], 'LONG', 1000);
  assert.equal(result.available, false);
  assert.equal(result.vwap, null);
  assert.equal(result.slippagePct, null);
  assert.ok(result.unfilledQuoteUsdt > 0);
});
