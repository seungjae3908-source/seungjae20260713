import assert from 'node:assert/strict';
import test from 'node:test';

import { liquidityImpactV1, liquidityProfileV1, verifyCandleDatasetV1 } from '../src/data-integrity-v1.mjs';

function hourly(n, start = Date.UTC(2024, 0, 1)) {
  return Array.from({ length: n }, (_, i) => ({ timestamp: start + (i * 3_600_000), open: 100, high: 101, low: 99, close: 100 + (i % 3), volume: 10 }))
    .map((row) => ({ ...row, high: Math.max(row.high, row.close), low: Math.min(row.low, row.close) }));
}

test('clean data passes with a stable content hash', () => {
  const a = verifyCandleDatasetV1(hourly(500));
  const b = verifyCandleDatasetV1(hourly(500));
  assert.equal(a.status, 'PASS');
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.missingBars, 0);
});

test('duplicates, disorder and impossible OHLC fail closed', () => {
  const rows = hourly(100);
  assert.equal(verifyCandleDatasetV1([...rows.slice(0, 50), rows[49], ...rows.slice(50)]).status, 'FAIL');
  assert.equal(verifyCandleDatasetV1([rows[1], rows[0], ...rows.slice(2)]).status, 'FAIL');
  const bad = rows.map((row, i) => (i === 10 ? { ...row, high: row.low - 1 } : row));
  assert.match(verifyCandleDatasetV1(bad).findings.join(), /OHLC_VIOLATIONS/u);
});

test('missing hours warn then fail; daily data tolerates weekends', () => {
  const rows = hourly(1000);
  const warn = rows.filter((_, i) => !(i > 100 && i < 120));
  assert.equal(verifyCandleDatasetV1(warn).status, 'WARN');
  const fail = rows.filter((_, i) => !(i > 100 && i < 300));
  assert.equal(verifyCandleDatasetV1(fail).status, 'FAIL');
  const weekdays = [];
  for (let d = 0; d < 400; d += 1) {
    const ts = Date.UTC(2024, 0, 1) + (d * 86_400_000);
    const dow = new Date(ts).getUTCDay();
    if (dow !== 0 && dow !== 6) weekdays.push({ timestamp: ts, open: 10, high: 11, low: 9, close: 10, volume: 5 });
  }
  assert.equal(verifyCandleDatasetV1(weekdays, { timeframe: '1d' }).status, 'PASS');
});

test('square-root impact grows with order size, falls with liquidity, and is capped', () => {
  const small = liquidityImpactV1({ notional: 1e6, medianDailyValue: 1e11, dailyVolatility: 0.03 });
  const big = liquidityImpactV1({ notional: 1e8, medianDailyValue: 1e11, dailyVolatility: 0.03 });
  const thin = liquidityImpactV1({ notional: 1e6, medianDailyValue: 1e8, dailyVolatility: 0.03 });
  assert.ok(small < big && small < thin);
  assert.ok(Math.abs(big / small - 10) < 1e-9, 'sqrt law: 100x size = 10x impact');
  assert.equal(liquidityImpactV1({ notional: 1e9, medianDailyValue: 1e6, dailyVolatility: 0.05 }), 0.02);
  assert.equal(liquidityImpactV1({ notional: 1e6, medianDailyValue: null, dailyVolatility: 0.05 }), 0.02, 'unknown liquidity is charged the cap');
});

test('liquidity profile aggregates intraday bars into days', () => {
  const profile = liquidityProfileV1(hourly(24 * 60));
  assert.equal(profile.days, 60);
  assert.ok(Math.abs(profile.medianDailyValue - (24 * 10 * 101)) < 24 * 10 * 2);
  assert.ok(profile.dailyVolatility >= 0);
});
