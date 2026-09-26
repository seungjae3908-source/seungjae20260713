import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const FOREGROUND_POLLING_SOURCES = [
  'src/hooks/use-stock-data.ts',
  'src/components/unified-analysis-chart.tsx',
  'src/components/chart-broadcast.tsx',
  'src/pages/scanner.tsx',
  'src/components/crypto-trading-workspace.tsx',
  'src/components/futures-market-status-panel.tsx',
] as const;

test('owned live-data queries stop interval polling while the app is in the background', () => {
  let foregroundOnlyQueryCount = 0;

  for (const relativePath of FOREGROUND_POLLING_SOURCES) {
    const source = readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
    expect(source, `${relativePath} must not opt into hidden-tab polling`).not.toMatch(
      /refetchIntervalInBackground:\s*true/,
    );
    foregroundOnlyQueryCount += source.match(/refetchIntervalInBackground:\s*false/g)?.length ?? 0;
  }

  expect(foregroundOnlyQueryCount).toBeGreaterThanOrEqual(24);
});

test('lazy routes render an immediate structured shell without a blocking spinner', async ({ page }) => {
  await page.route('**/src/pages/phase9-ai-review-e2e.tsx*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await route.continue();
  });

  const navigation = page.goto('/__phase9-ai-review-e2e');
  const fallback = page.getByTestId('page-fallback');

  await expect(fallback).toBeVisible();
  await expect(fallback).toHaveAttribute('aria-busy', 'true');
  expect(await fallback.locator('.animate-pulse').count()).toBeGreaterThanOrEqual(6);
  await expect(fallback.locator('.animate-spin')).toHaveCount(0);

  await navigation;
});
