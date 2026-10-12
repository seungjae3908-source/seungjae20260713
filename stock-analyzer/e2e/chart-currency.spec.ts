import { test, expect } from '@playwright/test';
import { chartDisplayValue, formatChartMoney } from '../src/lib/chart-currency';

const now = Date.parse('2026-10-11T00:00:00Z');
const quotes = [{ currency: 'USD' as const, krwRate: 1400, source: 'provider', asOf: new Date(now - 60_000).toISOString(), quality: 'DELAYED' }];
test('display conversion never changes native order price and keeps USDT separate', () => {
  expect(chartDisplayValue(100, 'US', 'KRW', quotes, now)).toBe(140000);
  expect(chartDisplayValue(100, 'US', 'USD', quotes, now)).toBe(100);
  expect(chartDisplayValue(100, 'KR', 'USD', quotes, now)).toBe(100);
  expect(chartDisplayValue(100, 'BITGET', 'KRW', quotes, now)).toBeNull();
  expect(formatChartMoney(0, 'US', 'KRW', quotes, now)).toBe('0원');
});
test('missing, expired, malformed and future FX never become zero or one-to-one conversion', () => {
  for (const quote of [undefined, { ...quotes[0], krwRate: 0 }, { ...quotes[0], asOf: 'invalid' }, { ...quotes[0], asOf: new Date(now + 120_000).toISOString() }, { ...quotes[0], asOf: new Date(now - 5 * 86_400_000).toISOString() }]) {
    expect(chartDisplayValue(100, 'US', 'KRW', quote ? [quote] : [], now)).toBeNull();
  }
  expect(formatChartMoney(100, 'US', 'KRW', [], now)).toBe('환율 미제공');
});
