import { expect, test, type Page } from '@playwright/test';

const CHART_URL = '/ai-chart?assetType=stock&market=KR&symbol=005930&ticker=005930&name=%EC%82%BC%EC%84%B1%EC%A0%84%EC%9E%90&timeframe=5m';
const BASE_TIME = 1_775_000_000;

function candles(count = 120) {
  return Array.from({ length: count }, (_, index) => ({
    time: BASE_TIME + index * 300,
    open: 70_000 + index * 10,
    high: 70_080 + index * 10,
    low: 69_940 + index * 10,
    close: 70_040 + index * 10,
    volume: 1_000 + index * 25,
    isClosed: index < count - 1,
  }));
}

async function installMocks(page: Page) {
  await page.route('**/api/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: '{}',
  }));
  await page.route('**/api/stocks/*/candles**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ticker: '005930',
      timeframe: '5m',
      provider: 'mobile-legend-occlusion-fixture',
      fetchedAt: '2026-09-05T00:00:00.000Z',
      updatedAt: '2026-09-05T00:00:00.000Z',
      candles: candles(),
    }),
  }));
}

test('mobile OHLCV legend never covers the rendered chart canvas', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installMocks(page);
  await page.goto(CHART_URL);

  const chartTab = page.getByRole('tab', { name: '차트', exact: true });
  if (await chartTab.isVisible().catch(() => false)) await chartTab.click();

  const legend = page.getByTestId('chart-crosshair-legend');
  const canvas = page.getByTestId('unified-chart-canvas');
  await expect(legend).toBeVisible();
  await expect(canvas).toBeVisible();

  const [legendBox, canvasBox] = await Promise.all([legend.boundingBox(), canvas.boundingBox()]);
  expect(legendBox).not.toBeNull();
  expect(canvasBox).not.toBeNull();
  expect(legendBox!.y + legendBox!.height).toBeLessThanOrEqual(canvasBox!.y + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
});
