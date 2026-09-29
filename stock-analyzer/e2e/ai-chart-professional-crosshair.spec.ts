import { expect, test, type Page, type Request } from '@playwright/test';

const CHART_URL = '/ai-chart?assetType=stock&market=KR&symbol=005930&ticker=005930&name=%EC%82%BC%EC%84%B1%EC%A0%84%EC%9E%90&timeframe=5m';
const BASE_TIME = 1_775_000_000;

function candles(count = 240) {
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

async function installMocks(page: Page, candleCount = 240) {
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
      candles: candles(candleCount),
    }),
  }));
}

test('crosshair exposes a live OHLCV legend without intercepting chart interaction', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const evidence = monitor(page);
  await installMocks(page);
  await page.goto(CHART_URL);
  await expect(page.getByRole('heading', { name: /AI 차트 생중계/, level: 1 })).toBeVisible();
  const chartTab = page.getByRole('tab', { name: '차트', exact: true });
  if (await chartTab.isVisible().catch(() => false)) await chartTab.click();

  const canvas = page.getByTestId('unified-chart-canvas');
  const legend = page.getByTestId('chart-crosshair-legend');
  await expect(canvas).toBeVisible();
  await expect(legend).toBeVisible();
  await expect(legend).toHaveAttribute('role', 'group');
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

test('mobile legend remains non-occluding and the chart has no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const evidence = monitor(page);
  await installMocks(page);
  await page.goto(CHART_URL);
  await expect(page.getByRole('heading', { name: /AI 차트 생중계/, level: 1 })).toBeVisible();
  const chartTab = page.getByRole('tab', { name: '차트', exact: true });
  if (await chartTab.isVisible().catch(() => false)) await chartTab.click();

  const canvas = page.getByTestId('unified-chart-canvas');
  const legend = page.getByTestId('chart-crosshair-legend');
  const controls = page.getByTestId('chart-floating-controls');
  await expect(canvas).toBeVisible();
  await expect(legend).toBeVisible();

  const [legendBox, controlsBox] = await Promise.all([legend.boundingBox(), controls.boundingBox()]);
  expect(legendBox).not.toBeNull();
  expect(controlsBox).not.toBeNull();
  const overlapsControls = !(
    legendBox!.x + legendBox!.width <= controlsBox!.x
    || controlsBox!.x + controlsBox!.width <= legendBox!.x
    || legendBox!.y + legendBox!.height <= controlsBox!.y
    || controlsBox!.y + controlsBox!.height <= legendBox!.y
  );
  expect(overlapsControls).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  expect(await legend.evaluate((node) => getComputedStyle(node).pointerEvents)).toBe('none');

  expect(evidence.consoleErrors).toEqual([]);
  expect(evidence.pageErrors).toEqual([]);
  expect(evidence.requestFailures).toEqual([]);
  expect(evidence.unexpectedHttp).toEqual([]);
});

test('five-thousand-candle history keeps crosshair, pan, and zoom responsive', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const evidence = monitor(page);
  await installMocks(page, 5_000);
  const navigationStartedAt = performance.now();
  await page.goto(CHART_URL);

  const canvas = page.getByTestId('unified-chart-canvas');
  const legend = page.getByTestId('chart-crosshair-legend');
  await expect(canvas).toBeVisible();
  await expect(legend).toHaveAttribute('data-candle-time', String(BASE_TIME + 4_999 * 300));
  const interactiveAt = performance.now();
  const initialRange = await page.getByTestId('unified-chart-wrapper').getAttribute('data-visible-logical-range');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();

  const interactionStartedAt = performance.now();
  await page.mouse.move(box!.x + box!.width * 0.35, box!.y + box!.height * 0.45);
  await expect.poll(() => legend.getAttribute('data-candle-time')).not.toBe(String(BASE_TIME + 4_999 * 300));
  await page.mouse.wheel(0, -420);
  await expect.poll(() => page.getByTestId('unified-chart-wrapper').getAttribute('data-visible-logical-range')).not.toBe(initialRange);
  const interactionCompletedAt = performance.now();

  testInfo.annotations.push({
    type: 'professional-chart-local-timing',
    description: JSON.stringify({
      candleCount: 5_000,
      navigationToInteractiveMs: Math.round(interactiveAt - navigationStartedAt),
      hoverAndZoomMs: Math.round(interactionCompletedAt - interactionStartedAt),
    }),
  });
  expect(evidence.consoleErrors).toEqual([]);
  expect(evidence.pageErrors).toEqual([]);
  expect(evidence.requestFailures).toEqual([]);
  expect(evidence.unexpectedHttp).toEqual([]);
});

test('twenty-five timeframe remounts release chart resize observers and canvases', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeResizeObserver = window.ResizeObserver;
    const probe = { created: 0, disconnected: 0, active: 0 };
    Object.defineProperty(window, '__chartLifecycleProbe', { value: probe });
    window.ResizeObserver = class extends NativeResizeObserver {
      private active = false;

      constructor(callback: ResizeObserverCallback) {
        super(callback);
        probe.created += 1;
      }

      override observe(target: Element, options?: ResizeObserverOptions) {
        if (!this.active) {
          this.active = true;
          probe.active += 1;
        }
        super.observe(target, options);
      }

      override disconnect() {
        if (this.active) {
          this.active = false;
          probe.active -= 1;
          probe.disconnected += 1;
        }
        super.disconnect();
      }
    };
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  const evidence = monitor(page);
  await installMocks(page, 1_000);
  await page.goto(CHART_URL);

  const canvasRegion = page.getByTestId('unified-chart-canvas');
  await expect(canvasRegion).toBeVisible();
  const initialCanvasCount = await canvasRegion.locator('canvas').count();
  const initialProbe = await page.evaluate(() => (window as typeof window & {
    __chartLifecycleProbe: { created: number; disconnected: number; active: number };
  }).__chartLifecycleProbe);
  expect(initialProbe.active).toBeGreaterThan(0);

  for (let index = 0; index < 25; index += 1) {
    const timeframe = index % 2 === 0 ? '15m' : '5m';
    await page.getByTestId(`timeframe-${timeframe}`).click();
    await expect(page).toHaveURL(new RegExp(`timeframe=${timeframe}`));
    await expect(canvasRegion).toBeVisible();
  }

  const finalProbe = await page.evaluate(() => (window as typeof window & {
    __chartLifecycleProbe: { created: number; disconnected: number; active: number };
  }).__chartLifecycleProbe);
  expect(await canvasRegion.locator('canvas').count()).toBe(initialCanvasCount);
  expect(finalProbe.active).toBe(initialProbe.active);
  expect(finalProbe.created - finalProbe.disconnected).toBe(finalProbe.active);
  expect(evidence.consoleErrors).toEqual([]);
  expect(evidence.pageErrors).toEqual([]);
  expect(evidence.requestFailures).toEqual([]);
  expect(evidence.unexpectedHttp).toEqual([]);
});
