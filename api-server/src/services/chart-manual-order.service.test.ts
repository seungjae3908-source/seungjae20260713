import assert from 'node:assert/strict';
import test from 'node:test';
import { parseChartManualOrder } from './chart-manual-order.service';
const base = { requestId: '3fa85f64-5717-4562-b3fc-2c963f66afa6', market: 'US', exchange: 'kiwoom', stockExchange: 'NASDAQ', symbol: 'AAPL', side: 'buy', quantity: 1, limitPrice: 100, stopPrice: 95, targetPrice: 110 };
test('chart order whitelists native intentions; client evidence and automatic mode cannot authorize it', () => {
  const result = parseChartManualOrder({ ...base, accountMode: 'paper', estimatedKrw: 1, marketSnapshot: { availableBalance: 1e9 }, executionMode: 'automatic' }, 3);
  assert.equal(result.accountMode, 'live'); assert.equal(result.orderType, 'limit'); assert.equal(result.limitPrice, 100);
  assert.ok(Number.isNaN(result.estimatedKrw)); assert.ok(Number.isNaN(result.marketSnapshot.availableBalance));
  assert.equal(result.marketSnapshot.halted, true);
});

test('server FX converts KRW prices and amounts; client FX/evidence is never trusted', () => {
  const result = parseChartManualOrder({ ...base, inputCurrency: 'KRW', limitPrice: 140000, stopPrice: 133000, targetPrice: 154000, clientFx: 1 }, 3, { krwPerNativeCurrency: 1400 });
  assert.equal(result.limitPrice, 100); assert.equal(result.stopPrice, 95); assert.deepEqual(result.targetPrices, [110]);
  const amount = parseChartManualOrder({ ...base, sizeMode: 'amount', amount: 280000, inputCurrency: 'KRW', limitPrice: 140000, stopPrice: 133000, targetPrice: 154000 }, 3, { krwPerNativeCurrency: 1400 });
  assert.equal(amount.quantity, 2); assert.equal(amount.limitPrice, 100);
  assert.throws(() => parseChartManualOrder({ ...base, inputCurrency: 'KRW' }, 3), /FRESH_FX_REQUIRED/);
  assert.throws(() => parseChartManualOrder({ ...base, inputCurrency: 'USDT' }, 3), /CURRENCY_INVALID/);
});

test('amount sizing floors to whole shares and confirmed futures quantity steps', () => {
  const stock = parseChartManualOrder({ ...base, market: 'KR', symbol: '005930', sizeMode: 'amount', amount: 249 }, 3);
  assert.equal(stock.quantity, 2); assert.ok(stock.quantity! * stock.limitPrice! <= 249);
  const futures = { ...base, market: 'BITGET', exchange: 'bitget', symbol: 'BTCUSDT', side: 'long', leverage: 3, sizeMode: 'amount', amount: 250 };
  const result = parseChartManualOrder(futures, 3, { quantityStep: 0.3 });
  assert.ok(Math.abs(result.quantity! - 2.4) < 1e-10); assert.ok(result.quantity! * result.limitPrice! <= 250);
  assert.throws(() => parseChartManualOrder(futures, 3), /QUANTITY_RULES_REQUIRED/);
  assert.throws(() => parseChartManualOrder({ ...base, sizeMode: 'margin' }, 3), /SIZE_MODE_INVALID/);
});

test('market choices fail closed instead of silently executing a limit order', () => {
  for (const market of ['KR', 'US', 'UPBIT', 'BITGET']) {
    const exchange = market === 'UPBIT' ? 'upbit' : market === 'BITGET' ? 'bitget' : market === 'US' ? 'kiwoom' : 'toss';
    const symbol = market === 'KR' ? '005930' : market === 'UPBIT' ? 'BTC' : market === 'BITGET' ? 'BTCUSDT' : 'AAPL';
    assert.throws(() => parseChartManualOrder({ ...base, market, exchange, symbol, side: market === 'BITGET' ? 'long' : 'buy', leverage: 3, orderType: 'market' }, 3), /MARKET_VERIFICATION_REQUIRED/);
  }
});
test('four-market sides, quantity, leverage and exit levels fail closed', () => {
  for (const change of [{ exchange: 'toss' }, { exchange: 'upbit' }, { side: 'short' }, { quantity: 0 }, { limitPrice: Infinity }, { stopPrice: 101 }, { targetPrice: 99 }, { requestId: '' }]) assert.throws(() => parseChartManualOrder({ ...base, ...change }, 3));
  const futures = { ...base, market: 'BITGET', exchange: 'bitget', symbol: 'BTCUSDT', side: 'long', leverage: 3 };
  assert.equal(parseChartManualOrder(futures, 3).leverage, 3);
  assert.throws(() => parseChartManualOrder({ ...futures, leverage: 4 }, 3));
  assert.throws(() => parseChartManualOrder({ ...futures, side: 'short' }, 3));
  assert.equal(parseChartManualOrder({ ...futures, side: 'short', reduceOnly: true }, 3).reduceOnly, true);
  assert.equal(parseChartManualOrder({ ...base, market: 'UPBIT', exchange: 'upbit', symbol: 'BTC', side: 'sell' }, 3).symbol, 'KRW-BTC');
});
