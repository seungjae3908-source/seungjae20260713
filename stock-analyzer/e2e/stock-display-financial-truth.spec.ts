import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { formatAppPercent, formatAppPrice } from '../src/lib/stock-display';

function source() {
  return readFileSync(resolve(process.cwd(), 'src/lib/stock-display.ts'), 'utf8');
}

test('missing or invalid percent is never fabricated as zero', () => {
  expect(formatAppPercent(null)).toBe('데이터 없음');
  expect(formatAppPercent(undefined)).toBe('데이터 없음');
  expect(formatAppPercent('')).toBe('데이터 없음');
  expect(formatAppPercent('not-a-number')).toBe('데이터 없음');
  expect(formatAppPercent(0)).toBe('0.00%');
  expect(formatAppPercent('1.25%')).toBe('+1.25%');
});

test('USDT prices preserve their native currency instead of falling through to KRW', () => {
  expect(formatAppPrice(1234.5678, 'USDT')).toBe('1,234.57 USDT');
  expect(formatAppPrice(null, 'USDT')).toBe('데이터 없음');
  expect(formatAppPrice(undefined, 'USDT')).toBe('데이터 없음');
});

test('cross-currency display does not invent a hard-coded FX rate', () => {
  const text = source();
  expect(text).not.toContain('const USD_KRW = 1300');
  expect(text).not.toMatch(/\bUSD_KRW\b/);
  expect(text).toContain("const conversionNote = conversionUnavailable ? ' · 환율 미연동' : '';");
});

test('unknown currency labels remain explicit instead of being formatted as won', () => {
  expect(formatAppPrice(42.25, 'EUR')).toBe('42.25 EUR');
  expect(formatAppPrice(42.25, '')).toBe('42.25 통화 미확인');
});
