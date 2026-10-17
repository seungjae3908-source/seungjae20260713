import test from 'node:test';
import assert from 'node:assert/strict';
import { readOnlyChartTarget } from './ui-chart-navigation';
import { selectionFromSearch } from './analysis-selection';

test('journal and portfolio stocks open the actual read-only chart with correct identity', () => {
  for (const [market, symbol, targetMarket] of [['KR_STOCK','005930','KR'],['US_STOCK','AAPL','US']] as const) {
    const target = readOnlyChartTarget(market, symbol);
    assert.ok(target);
    assert.equal(selectionFromSearch(target.href.split('?')[1])?.market, targetMarket);
    assert.equal(target.selection.action, undefined);
    assert.equal(target.selection.pricePlan, undefined);
  }
});

test('crypto spots normalize Upbit symbol and futures stay distinct', () => {
  assert.equal(readOnlyChartTarget('CRYPTO_SPOT', 'KRW-BTC')?.selection.ticker, 'BTC');
  assert.equal(readOnlyChartTarget('CRYPTO_FUTURES', 'BTCUSDT')?.selection.market, 'BITGET');
});

test('unknown markets, invalid symbols and URL injection fail closed', () => {
  assert.equal(readOnlyChartTarget('RESEARCH', 'BTCUSDT'), null);
  assert.equal(readOnlyChartTarget('KR_STOCK', '../api/order'), null);
  assert.equal(readOnlyChartTarget('KR_STOCK', 'APPLE'), null);
  assert.equal(readOnlyChartTarget('UPBIT', 'BTC?foo=bar'), null);
  assert.equal(readOnlyChartTarget('US_STOCK', ''), null);
});
