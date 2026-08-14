import { expect, test, type Route } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

function source(relativePath: string) {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

function frontendSources(relativeDirectory: string): string[] {
  return readdirSync(path.resolve(process.cwd(), relativeDirectory), { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) return frontendSources(relativePath);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [relativePath] : [];
  });
}

function fulfill(route: Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

test('all frontend interval queries are foreground-only', () => {
  for (const relativePath of frontendSources('src')) {
    expect(source(relativePath), relativePath).not.toContain('refetchIntervalInBackground: true');
  }
});

test('detail query lifecycle forwards cancellation and exposes accessible loading and retry states', () => {
  const detail = source('src/pages/detail.tsx');
  const stockInfo = source('src/pages/stock-info.tsx');

  expect(detail).toContain('queryFn: ({ signal }) => fetchDetail(ticker, signal)');
  expect(detail).toContain('queryFn: ({ signal }) => fetchChartCandles(ticker, timeframe, fallbackRows, signal)');
  expect(detail).toContain('ownerSignal?.addEventListener("abort", abortOwnedRequest');
  expect(detail).toContain('data-testid="detail-page-skeleton"');
  expect(detail).toContain('role="status"');
  expect(detail).toContain('aria-busy="true"');
  expect(detail).toContain('<DetailErrorState onRetry={() => void detail.refetch()} />');
  expect(stockInfo.match(/queryFn: async \(\{ signal \}\)/g)?.length).toBeGreaterThanOrEqual(2);
  expect(stockInfo.match(/\{ cache: 'no-store', signal \}/g)?.length).toBeGreaterThanOrEqual(2);
});

test('delayed first detail load shows a structured skeleton instead of a blocking spinner', async ({ page }) => {
  let delayed = false;
  await page.route('**/api/quotes?**', async (route) => {
    if (!delayed) {
      delayed = true;
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    await fulfill(route, { quotes: [{ ticker: '005930', price: 70000, market: 'KR', currency: 'KRW' }] });
  });
  await page.route('**/api/stocks/005930/**', async (route) => fulfill(route, {}));

  const navigation = page.goto('/stock-info/analysis?asset=stock&market=KR&ticker=005930');
  const skeleton = page.getByTestId('detail-page-skeleton');
  await expect(skeleton).toBeVisible();
  await expect(skeleton).toHaveAttribute('aria-busy', 'true');
  await expect(skeleton.locator('.animate-spin')).toHaveCount(0);
  expect(await skeleton.locator('.animate-pulse').count()).toBeGreaterThanOrEqual(6);
  await navigation;
});

test('rapid detail navigation keeps obsolete responses from replacing the latest symbol', async ({ page }) => {
  await page.route('**/api/quotes?**', async (route) => {
    const url = new URL(route.request().url());
    const ticker = url.searchParams.get('tickers') ?? '';
    if (ticker === '005930') {
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    await fulfill(route, { quotes: [{ ticker, price: ticker === 'AAPL' ? 220 : 70000, market: ticker === 'AAPL' ? 'US' : 'KR', currency: ticker === 'AAPL' ? 'USD' : 'KRW' }] }).catch(() => undefined);
  });
  await page.route('**/api/stocks/**', async (route) => fulfill(route, {}));

  const firstNavigation = page.goto('/stock-info/analysis?asset=stock&market=KR&ticker=005930').catch(() => null);
  await page.waitForTimeout(100);
  await page.goto('/stock-info/analysis?asset=stock&market=US&ticker=AAPL');
  await firstNavigation;
  await expect(page).toHaveURL(/ticker=AAPL/);
  await expect(page.getByText('AAPL', { exact: true }).first()).toBeVisible();
});
