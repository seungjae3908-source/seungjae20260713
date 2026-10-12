import { expect, test, type BrowserContext } from '@playwright/test';

const chartUrl = '/ai-chart?assetType=stock&market=KR&symbol=005930&ticker=005930&name=%EC%82%BC%EC%84%B1%EC%A0%84%EC%9E%90&timeframe=5m&strategyMode=SCALPING';

function candleRows() {
  const end = Date.now() - 5 * 60_000;
  return Array.from({ length: 90 }, (_, index) => {
    const base = 70_000 + index * 20;
    return {
      time: new Date(end - (89 - index) * 5 * 60_000).toISOString(),
      open: base - 10,
      high: base + 80,
      low: base - 80,
      close: base + 30,
      volume: 1_000 + index * 25,
      isClosed: true,
    };
  });
}

async function installMocks(context: BrowserContext) {
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (/\/api\/stocks\/[^/]+\/(?:chart|candles)$/.test(url.pathname)) {
      const timeframe = url.searchParams.get('tf') ?? '5m';
      const updatedAt = new Date().toISOString();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ticker: '005930',
          timeframe,
          provider: 'ai-chart-mobile-nonocclusion-test',
          fetchedAt: updatedAt,
          updatedAt,
          candles: candleRows(),
        }),
      });
      return;
    }

    if (url.pathname === '/api/quotes') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ quotes: [] }),
      });
      return;
    }

    await route.continue();
  });
}

test('mobile judgment is isolated in its tab and never covers the candle canvas', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installMocks(context);
  await page.goto(chartUrl);

  await page.getByRole('tab', { name: '차트', exact: true }).click();

  const canvas = page.getByTestId('unified-chart-canvas');
  const judgment = page.getByTestId('ai-chart-mobile-judgment');
  await expect(canvas).toBeVisible();
  await expect(judgment).toBeHidden();
  await page.getByRole('tab', { name: '현재 판단', exact: true }).click();
  await expect(judgment).toBeVisible();
  await expect(canvas).toBeHidden();
  await expect(canvas).toHaveCount(1);
  await page.getByRole('tab', { name: '차트', exact: true }).click();
  await expect(canvas).toBeVisible();
  await expect(judgment).toBeHidden();

  const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(horizontalOverflow).toBeLessThanOrEqual(1);
});
