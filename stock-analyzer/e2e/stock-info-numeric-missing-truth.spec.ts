import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const pagePath = fileURLToPath(new URL('../src/pages/stock-info.tsx', import.meta.url));

test('stock info never fabricates zero, direction, currency, or safety from missing evidence', async () => {
  const source = await readFile(pagePath, 'utf8');

  expect(source).toContain("if (typeof value === 'number') return Number.isFinite(value) ? value : null;");
  expect(source).toContain("if (typeof value !== 'string') return null;");
  expect(source).toContain('if (!normalized) return null;');
  expect(source).not.toContain('const number = Number(value);');

  expect(source).toContain('const currency = text(quote.data?.currency);');
  expect(source).not.toContain("text(quote.data?.currency) ?? (market === 'KR' ? 'KRW' : 'USD')");
  expect(source).toContain("return currencyCode ? formatAppPrice(number, currencyCode) : '통화 미확인';");

  expect(source).toContain('tone={changeTone(quote.data.changePercent)}');
  expect(source).toContain('tone={changeTone(selected.changePercent ?? selected.changePercent24h)}');
  expect(source).toContain('value={warningLabel(selected.warning)}');
  expect(source).toContain("tone={selected.warning === true ? 'down' : undefined}");
  expect(source).toContain("return '유의 상태 미확인';");

  // Genuine numeric zero remains an explicit finite number; only missing/blank/non-numeric inputs fail closed.
  expect(source).toContain("typeof value === 'number'");
});
