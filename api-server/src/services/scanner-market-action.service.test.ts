import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveScannerTradeAction } from './scanner-market-action.service';

test('cash and spot scanners expose BUY/SELL while futures expose LONG/SHORT', () => {
  assert.equal(resolveScannerTradeAction('stock', 'LONG'), 'BUY');
  assert.equal(resolveScannerTradeAction('stock', 'SHORT'), 'SELL');
  assert.equal(resolveScannerTradeAction('coin_spot', 'LONG'), 'BUY');
  assert.equal(resolveScannerTradeAction('coin_spot', 'SHORT'), 'SELL');
  assert.equal(resolveScannerTradeAction('coin_futures', 'LONG'), 'LONG');
  assert.equal(resolveScannerTradeAction('coin_futures', 'SHORT'), 'SHORT');
  assert.equal(resolveScannerTradeAction('coin_futures', 'NEUTRAL'), 'NONE');
});
