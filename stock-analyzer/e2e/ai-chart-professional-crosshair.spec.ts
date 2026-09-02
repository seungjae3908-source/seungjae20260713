import { expect, test, type Page, type Request } from '@playwright/test';

const CHART_URL = '/ai-chart?assetType=stock&market=KR&symbol=005930&ticker=005930&name=%EC%82%BC%EC%84%B1%EC%A0%84%EC%9E%90&timeframe=5m';
const BASE_TIME = 1_775_000_000;

function candles() {
  return Array.from({ length: 240 }, (_, index) => ({
    time: BASE_TIME + index * 300,
    open: 70_000 + index * 10,
    high: 70_080 + index * 10,
    low: 69_940 + index * 10,
    close: 70_040 + index * 10,
    volume: 1_000 + index * 25,
    isClosed: index < 239,
  }));
}

function monitor(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  const unexpectedHttp: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request: Request) => {
    const reason = request.failure()?.errorText ?? '';
    if (!/ERR_ABORTED|NS_BINDING_ABORTED/i.test(reason)) {
      requestFailures.push(`${request.method()} ${request.url()} ${reason}`);
    }
  });
  page.on('response', (response) => {
    if (response.status() >= 400) unexpectedHttp.push(`${response.status()} ${response.url()}`);
  });

  return { consoleErrors, pageErrors, requestFailures, unexpectedHttp };
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
      provider: 'professional-crosshair-fixture',
      fetchedAt: '2026-08-04T06:30:00.000Z',
      updatedAt: '2026-08-04T06:30:00.000Z',
      candles: candles(),
    }),
  }));
}

test('crosshair exposes a live OHLCV legend without intercepting chart interaction', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const evidence = monitor(page);
  await installMocks(page);
  await page.goto(CHART_URL);

  const canvas = page.getByTestId('unified-chart-canvas');
  const legend = page.getByTestId('chart-crosshair-legend');
  await expect(canvas).toBeVisible();
  await expect(legend).toBeVisible();
  await expect(legend).toHaveAttribute('data-candle-time', String(BASE_TIME + 239 * 300));
  await expect(legend).toContainText(/시 .* · 고 .* · 저 .* · 종 .* · 거래량/);
  expect(await legend.evaluate((node) => getComputedStyle(node).pointerEvents)).toBe('none');

  const latestTime = await legend.getAttribute('data-candle-time');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width * 0.3, box!.y + box!.height * 0.45);
  await expect.poll(() => legend.getAttribute('data-candle-time')).not.toBe(latestTime);

  expect(evidence.consoleErrors).toEqual([]);
  expect(evidence.pageErrors).toEqual([]);
  expect(evidence.requestFailures).toEqual([]);
  expect(evidence.unexpectedHttp).toEqual([]);
});
