import test from 'node:test';
import assert from 'node:assert/strict';
import { yahooChartParams } from './yahoo';

test('Yahoo intraday requests preserve the requested supported interval', () => {
  assert.deepEqual(yahooChartParams('1m'), { range: '7d', interval: '1m' });
  assert.deepEqual(yahooChartParams('5m'), { range: '1mo', interval: '5m' });
  assert.deepEqual(yahooChartParams('15m'), { range: '1mo', interval: '15m' });
  assert.deepEqual(yahooChartParams('30m'), { range: '1mo', interval: '30m' });
  assert.deepEqual(yahooChartParams('1H'), { range: '2y', interval: '60m' });
});

test('Yahoo rejects unsupported intervals instead of returning mislabeled daily candles', () => {
  assert.throws(() => yahooChartParams('3m'), /YAHOO_UNSUPPORTED_TIMEFRAME:3m/);
  assert.throws(() => yahooChartParams('4H'), /YAHOO_UNSUPPORTED_TIMEFRAME:4H/);
  assert.throws(() => yahooChartParams('unknown'), /YAHOO_UNSUPPORTED_TIMEFRAME:unknown/);
});
