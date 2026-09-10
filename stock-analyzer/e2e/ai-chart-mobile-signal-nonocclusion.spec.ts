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

test('mobile AI signal badge stays visible below the candle canvas instead of covering it', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installMocks(context);
  await page.goto(chartUrl);

  await page.getByRole('tab', { name: '차트', exact: true }).click();

  const canvas = page.getByTestId('unified-chart-canvas');
  const overlay = page.getByTestId('ai-chart-v2-signal-overlay');
  await expect(canvas).toBeVisible();
  await expect(overlay).toBeVisible();
  await expect(overlay).toContainText('SCALPING');
  await expect(overlay).toContainText('5m');
  await expect(overlay).toHaveAttribute('data-signal-status', /ACTIVE|WEAKENED|INVALIDATED|EXPIRED/);

  const canvasBox = await canvas.boundingBox();
  const overlayBox = await overlay.boundingBox();
  expect(canvasBox).not.toBeNull();
  expect(overlayBox).not.toBeNull();

  const canvasBottom = canvasBox!.y + canvasBox!.height;
  expect(overlayBox!.y).toBeGreaterThanOrEqual(canvasBottom - 1);

  const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(horizontalOverflow).toBeLessThanOrEqual(1);
});
