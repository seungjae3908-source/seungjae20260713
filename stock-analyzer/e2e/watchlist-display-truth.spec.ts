import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const pagePath = fileURLToPath(new URL('../src/pages/watchlist.tsx', import.meta.url));

test('watchlist never guesses missing price, market, currency, direction, or alert state', async () => {
  const source = await readFile(pagePath, 'utf8');

  expect(source).toContain('function finite(value: unknown): number | null {');
  expect(source).toContain('if (typeof value === "number") return Number.isFinite(value) ? value : null;');
  expect(source).toContain('if (typeof value !== "string") return null;');
  expect(source).toContain('function knownStockMarket(value: unknown): KnownStockMarket | null {');
  expect(source).toContain('function knownStockCurrency(value: unknown): KnownStockCurrency | null {');

  expect(source).not.toContain('const selectedPrice = Number(selectedQuote?.price);');
  expect(source).not.toContain('const market = row.market === "US" ? "US" : "KR";');
  expect(source).not.toContain('const currency = row.currency === "USD" ? "USD" : "KRW";');
  expect(source).not.toContain('const positive = (row.changePercent ?? 0) >= 0;');

  expect(source).toContain('const currentPrice = finite(selectedQuote?.price);');
  expect(source).toContain('const positive = changePercent == null ? null : changePercent >= 0;');
  expect(source).toContain('"시장 미확인"');
  expect(source).toContain('"통화 미확인"');
  expect(source).toContain('"가격 미확인"');
  expect(source).toContain('"등락 미확인"');
  expect(source).toContain('"조건 미확인"');
  expect(source).toContain('"상태 미확인"');
});
