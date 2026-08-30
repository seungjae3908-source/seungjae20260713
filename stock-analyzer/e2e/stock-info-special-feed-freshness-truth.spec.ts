import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const pagePath = fileURLToPath(new URL('../src/pages/stock-info.tsx', import.meta.url));

test('special feed never promotes malformed or future timestamps as fresh evidence', async () => {
  const source = await readFile(pagePath, 'utf8');

  expect(source).toContain("type SpecialFeedFreshness = 'latest' | 'archive' | 'unknown';");
  expect(source).toContain("if (!Number.isFinite(detectedAt) || detectedAt > nowMs) return 'unknown';");
  expect(source).toContain("if (!Number.isFinite(displayAt) || displayAt > nowMs) return 'unknown';");
  expect(source).toContain("return view === 'latest' ? freshness === 'latest' : freshness !== 'latest';");
  expect(source).toContain("return '시각 확인 필요';");
  expect(source).toContain("freshness === 'unknown' ? '시각 확인 필요'");
  expect(source).toContain("freshness === 'archive' ? '보관함' : '시각 미확인'");

  expect(source).not.toContain('Number.POSITIVE_INFINITY');
  expect(source).not.toContain("if (!Number.isFinite(timestamp)) return '방금 전';");
  expect(source).not.toContain('Math.max(0, Math.floor((nowMs - timestamp) / 60_000))');
});

test('stock info never coerces missing numeric evidence into genuine zero', async () => {
  const source = await readFile(pagePath, 'utf8');

  expect(source).toContain('if (value == null || typeof value === \'boolean\') return null;');
  expect(source).toContain("if (typeof value === 'string' && value.trim() === '') return null;");
  expect(source).toContain("tone={finite(quote.data.changePercent) == null ? undefined : Number(quote.data.changePercent) >= 0 ? 'up' : 'down'}");
  expect(source).toContain("tone={finite(selected.changePercent ?? selected.changePercent24h) == null ? undefined : Number(selected.changePercent ?? selected.changePercent24h) >= 0 ? 'up' : 'down'}");
});
