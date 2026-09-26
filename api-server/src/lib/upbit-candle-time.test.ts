import assert from 'node:assert/strict';
import test from 'node:test';
import { absoluteUpbitCandleTime } from './upbit-candle-time';

test('Upbit UTC candle time is serialized as an absolute instant', () => {
  const value = absoluteUpbitCandleTime({
    candle_date_time_utc: '2026-09-20T04:15:00',
    candle_date_time_kst: '2026-09-20T13:15:00',
  });

  assert.equal(value, '2026-09-20T04:15:00Z');
  assert.equal(Date.parse(String(value)), Date.UTC(2026, 8, 20, 4, 15, 0));
});

test('Upbit KST fallback keeps the same provider instant', () => {
  const value = absoluteUpbitCandleTime({ candle_date_time_kst: '2026-09-20T13:15:00' });

  assert.equal(value, '2026-09-20T13:15:00+09:00');
  assert.equal(Date.parse(String(value)), Date.UTC(2026, 8, 20, 4, 15, 0));
});
