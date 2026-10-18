import assert from 'node:assert/strict';
import test from 'node:test';

import { createExchangeSessionCalendarV1 } from '../src/exchange-session-calendar-v1.mjs';

const iso = (ms) => new Date(ms).toISOString();

test('KRX sessions start 09:00 KST on weekdays only', () => {
  const calendar = createExchangeSessionCalendarV1({ holidays: [] });
  // 2025-06-02 (Mon) .. 2025-06-09 (Mon) 00:00Z
  const starts = calendar({ market: 'KR_STOCK', periodStartMs: Date.UTC(2025, 5, 2), periodEndMs: Date.UTC(2025, 5, 9) });
  assert.deepEqual(starts.map(iso), [
    '2025-06-02T00:00:00.000Z', '2025-06-03T00:00:00.000Z', '2025-06-04T00:00:00.000Z',
    '2025-06-05T00:00:00.000Z', '2025-06-06T00:00:00.000Z',
  ]);
});

test('holidays are removed and never guessed', () => {
  const withHoliday = createExchangeSessionCalendarV1({ holidays: ['2025-06-03', '2025-06-06'] });
  const starts = withHoliday({ market: 'KR_STOCK', periodStartMs: Date.UTC(2025, 5, 2), periodEndMs: Date.UTC(2025, 5, 9) });
  assert.equal(starts.length, 3);
  const noList = createExchangeSessionCalendarV1();
  assert.deepEqual(noList({ market: 'KR_STOCK', periodStartMs: Date.UTC(2025, 5, 2), periodEndMs: Date.UTC(2025, 5, 9) }), []);
  assert.deepEqual(createExchangeSessionCalendarV1({ holidays: ['6/3'] })({ market: 'KR_STOCK', periodStartMs: 1, periodEndMs: 2 }), []);
});

test('US sessions follow daylight saving time (09:30 ET)', () => {
  const calendar = createExchangeSessionCalendarV1({ holidays: [] });
  const summer = calendar({ market: 'US_STOCK', periodStartMs: Date.UTC(2025, 5, 2), periodEndMs: Date.UTC(2025, 5, 4) });
  assert.deepEqual(summer.map(iso), ['2025-06-02T13:30:00.000Z', '2025-06-03T13:30:00.000Z']);
  const winter = calendar({ market: 'US_STOCK', periodStartMs: Date.UTC(2025, 0, 6), periodEndMs: Date.UTC(2025, 0, 8) });
  assert.deepEqual(winter.map(iso), ['2025-01-06T14:30:00.000Z', '2025-01-07T14:30:00.000Z']);
  // the weeks around both DST switches keep exactly five sessions
  const spring = calendar({ market: 'US_STOCK', periodStartMs: Date.UTC(2025, 2, 10), periodEndMs: Date.UTC(2025, 2, 15) });
  assert.equal(spring.length, 5);
  assert.equal(iso(spring[0]), '2025-03-10T13:30:00.000Z');
  const autumn = calendar({ market: 'US_STOCK', periodStartMs: Date.UTC(2025, 10, 3), periodEndMs: Date.UTC(2025, 10, 8) });
  assert.equal(autumn.length, 5);
  assert.equal(iso(autumn[0]), '2025-11-03T14:30:00.000Z');
});

test('unknown market and invalid periods give no sessions', () => {
  const calendar = createExchangeSessionCalendarV1({ holidays: [] });
  assert.deepEqual(calendar({ market: 'CRYPTO_SPOT', periodStartMs: 1, periodEndMs: 2 }), []);
  assert.deepEqual(calendar({ market: 'KR_STOCK', periodStartMs: 5, periodEndMs: 5 }), []);
  assert.deepEqual(calendar({ market: 'KR_STOCK', periodStartMs: 0.5, periodEndMs: 9 }), []);
});
