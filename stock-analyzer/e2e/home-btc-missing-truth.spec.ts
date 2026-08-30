import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const homePath = fileURLToPath(new URL('../src/pages/home.tsx', import.meta.url));

test('home BTC card never converts missing market evidence into numeric zero', async () => {
  const source = await readFile(homePath, 'utf8');

  expect(source).toContain("if (typeof value === 'number') return Number.isFinite(value) ? value : null;");
  expect(source).toContain("if (typeof value !== 'string') return null;");
  expect(source).toContain("if (!normalized) return null;");
  expect(source).not.toContain('const parsed = Number(value);');

  expect(source).toContain('const btcPrice = btc ? finite(btc.price ?? btc.tradePrice) : null;');
  expect(source).toContain('const btcChangePercent = btc ? finite(btc.changePercent ?? btc.changePercent24h) : null;');
  expect(source).toContain("btcPrice == null ? '가격 미확인' : formatAppPrice(btcPrice, 'KRW')");
  expect(source).toContain("btcChangePercent == null ? '등락 미확인' : formatAppPercent(btcChangePercent)");
});
