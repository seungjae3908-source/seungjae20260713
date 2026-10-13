import test from 'node:test';
import assert from 'node:assert/strict';
import {
  spotPublicQaProfile, upbitPublicQaCandleUrl, normalizeUpbitPublicQaCandles,
} from '../src/four-market-qa-upbit-candles.mjs';

test('real-data QA spot SWING is exact 4H canonical lane and calls 240m candles', () => {
  const swing = spotPublicQaProfile({ strategy: 'SWING', strategyMode: 'swing', timeframe: '60m' });
  const scalp = spotPublicQaProfile({ strategy: 'SCALPING', strategyMode: 'scalping', timeframe: '15m' });
  assert.equal(swing.timeframe, '4H');
  assert.equal(scalp.timeframe, '15m');
  assert.match(upbitPublicQaCandleUrl('BTC', swing.timeframe), /\/v1\/candles\/minutes\/240\?/u);
  assert.match(upbitPublicQaCandleUrl('BTC', scalp.timeframe), /\/v1\/candles\/minutes\/15\?/u);
  assert.match(upbitPublicQaCandleUrl('BTC', '1D'), /\/v1\/candles\/days\?/u);
  assert.throws(() => upbitPublicQaCandleUrl('BTC', '2H'), /UPBIT_QA_TIMEFRAME_UNSUPPORTED/u);
});

test('Upbit QA must use candle_date_time_utc start, never last tick timestamp', () => {
  const start = '2026-10-13T04:00:00';
  const lastTick = Date.parse('2026-10-13T04:59:59.999Z');
  const rows = normalizeUpbitPublicQaCandles([{
    candle_date_time_utc: start,
    timestamp: lastTick,
    opening_price: 100, high_price: 103, low_price: 98,
    trade_price: 102, candle_acc_trade_volume: 9,
    candle_acc_trade_price: 909,
  }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].time, Date.parse(start + 'Z'));
  assert.notEqual(rows[0].time, lastTick);
  assert.equal(rows[0].close, 102);
});

test('Upbit QA never uses last tick as an implicit fallback when UTC start is absent', () => {
  const rows = normalizeUpbitPublicQaCandles([{
    timestamp: Date.parse('2026-10-13T04:59:59.999Z'),
    opening_price: 100, high_price: 103, low_price: 98,
    trade_price: 102, candle_acc_trade_volume: 9,
  }]);
  assert.deepEqual(rows, []);
});
