import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const homePath = fileURLToPath(new URL('../src/pages/home.tsx', import.meta.url));

test('home market cards never convert missing evidence into numeric or currency facts', async () => {
  const source = await readFile(homePath, 'utf8');

  expect(source).toContain("if (typeof value === 'number') return Number.isFinite(value) ? value : null;");
  expect(source).toContain("if (typeof value !== 'string') return null;");
  expect(source).toContain("if (!normalized) return null;");
  expect(source).not.toContain('const parsed = Number(value);');

  expect(source).toContain('const btcPrice = btc ? finite(btc.price ?? btc.tradePrice) : null;');
  expect(source).toContain('const btcChangePercent = btc ? finite(btc.changePercent ?? btc.changePercent24h) : null;');
  expect(source).toContain("btcPrice == null ? '가격 미확인' : formatAppPrice(btcPrice, 'KRW')");
  expect(source).toContain("btcChangePercent == null ? '등락 미확인' : formatAppPercent(btcChangePercent)");

  expect(source).toContain('const watchlistPrice = finite(item.price);');
  expect(source).toContain('const watchlistChangePercent = finite(item.changePercent);');
  expect(source).toContain("typeof item.currency === 'string' && item.currency.trim()");
  expect(source).toContain("watchlistCurrency == null ? '통화 미확인' : formatAppPrice(watchlistPrice, watchlistCurrency)");
  expect(source).toContain("watchlistChangePercent == null ? '등락 미확인' : formatAppPercent(watchlistChangePercent)");
  expect(source).not.toContain("formatAppPrice(item.price, item.currency ?? 'KRW')");
});
