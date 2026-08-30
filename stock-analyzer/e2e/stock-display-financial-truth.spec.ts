import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function source() {
  return readFileSync(resolve(process.cwd(), 'src/lib/stock-display.ts'), 'utf8');
}

test('missing or invalid percent is never fabricated as zero', () => {
  const text = source();
  expect(text).toContain("if (n == null || !Number.isFinite(n)) return '데이터 없음';");
  expect(text).not.toContain("if (!Number.isFinite(n)) return '0.00%';");
  expect(text).not.toContain("        : 0;\n\n  if (!Number.isFinite(n))");
});

test('USDT prices preserve their native currency instead of falling through to KRW', () => {
  const text = source();
  expect(text).toContain("if (currencyCode === 'USDT')");
  expect(text).toContain('} USDT`');
  expect(text).toContain("if (currencyCode === 'KRW')");
});

test('cross-currency display does not invent a hard-coded FX rate', () => {
  const text = source();
  expect(text).not.toContain('const USD_KRW = 1300');
  expect(text).not.toMatch(/\bUSD_KRW\b/);
  expect(text).toContain("const conversionNote = conversionUnavailable ? ' · 환율 미연동' : '';");
});

test('unknown currency labels remain explicit instead of being formatted as won', () => {
  const text = source();
  expect(text).toContain("const label = currencyCode || '통화 미확인';");
  expect(text).toContain('return `${n.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${label}`;');
});
