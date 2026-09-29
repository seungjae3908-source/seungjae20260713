import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const pagePath = fileURLToPath(new URL('../src/pages/market-overview.tsx', import.meta.url));

test('market overview never converts missing numeric evidence into zero', async () => {
  const source = await readFile(pagePath, 'utf8');

  expect(source).toContain("if (typeof value === 'number') return Number.isFinite(value) ? value : null;");
  expect(source).toContain("if (typeof value !== 'string') return null;");
  expect(source).toContain("if (!normalized) return null;");
  expect(source).not.toContain('const number = Number(value);');

  expect(source).toContain("if (number == null) return '미확인';");
  expect(source).toContain("change == null");
  expect(source).toContain(".filter((value): value is number => value != null)");
});
