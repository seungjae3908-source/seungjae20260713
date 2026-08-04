import { test, expect, type Page, type Request } from '@playwright/test';

const BASE_TIME = 1_775_500_000;
const STEP_SECONDS = 300;
const DOUBLE_TOP = [100, 104, 110, 104, 100, 103, 109.5, 104, 102, 103, 104];

type BrowserEvidence = {
  consoleErrors: string[];
  pageErrors: string[];
  requestFailures: string[];
  httpErrors: string[];
  orderRequests: string[];
};

function candles(values: number[]) {
  return values.map((close, index) => ({
    time: BASE_TIME + index * STEP_SECONDS,
    open: close,
    high: close + 0.5,
    low: close - 0.5,
    close,
    volume: 1_000 + index * 10,
    isClosed: true,
  }));
}

function fixture(call: number) {
  if (call === 1) return candles(DOUBLE_TOP);
  if (call === 2) return candles([...DOUBLE_TOP, 98]);
  if (call === 3) return candles([...DOUBLE_TOP, 112]);
  return candles(Array.from({ length: 24 }, (_, index) => 80 + index));
}

function monitorBrowser(page: Page): BrowserEvidence {
  const evidence: BrowserEvidence = {
    consoleErrors: [],
    pageErrors: [],
    requestFailures: [],
    httpErrors: [],
    orderRequests: [],
  };
  page.on('console', (message) => {
    if (message.type() === 'error') evidence.consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => evidence.pageErrors.push(error.message));
  page.on('requestfailed', (request: Request) => {
    evidence.requestFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) evidence.httpErrors.push(`${response.status()} ${response.url()}`);
  });
  page.on('request', (request) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return;
    if (/order|trade|automation|approval|execute/i.test(request.url())) {
      evidence.orderRequests.push(`${request.method()} ${request.url()}`);
    }
  });
  return evidence;
}

async function installMocks(page: Page) {
  let chartCalls = 0;
  await page.route('**/api/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: '{}',
  }));
  await page.route('**/api/stocks/*/chart**', (route) => {
    chartCalls += 1;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        provider: 'pattern-overlay-fixture',
        fetchedAt: '2030-01-01T00:00:00.000Z',
        updatedAt: '2030-01-01T00:00:00.000Z',
        candles: fixture(chartCalls),
      }),
    });
  });
  return { chartCalls: () => chartCalls };
}

async function openChart(page: Page) {
  await page.goto('/ai-chart?assetType=stock&market=KR&symbol=005930&ticker=005930&name=%EC%82%BC%EC%84%B1%EC%A0%84%EC%9E%90&timeframe=5m');
  await expect(page.getByRole('heading', { name: 'AI 차트 생중계', level: 1 })).toBeVisible();
  await expect(page.getByTestId('unified-chart-canvas')).toBeVisible();
  await page.getByRole('button', { name: '자동 갱신 중', exact: true }).click();
  await expect(page.getByRole('button', { name: '갱신 일시정지', exact: true })).toBeVisible();
}

function expectNoBrowserErrors(evidence: BrowserEvidence) {
  expect(evidence.consoleErrors, `console errors: ${evidence.consoleErrors.join('\n')}`).toEqual([]);
  expect(evidence.pageErrors, `page errors: ${evidence.pageErrors.join('\n')}`).toEqual([]);
  expect(evidence.requestFailures, `request failures: ${evidence.requestFailures.join('\n')}`).toEqual([]);
  expect(evidence.httpErrors, `HTTP errors: ${evidence.httpErrors.join('\n')}`).toEqual([]);
  expect(evidence.orderRequests, `order requests: ${evidence.orderRequests.join('\n')}`).toEqual([]);
}

test('pattern overlay replaces candidate, confirmed, and invalidated states without stale duplicates', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const evidence = monitorBrowser(page);
  const mock = await installMocks(page);
  await openChart(page);
  await expect.poll(mock.chartCalls).toBe(1);

  const overlay = page.getByTestId('chart-pattern-overlay');
  await expect(overlay).toHaveCount(1);
  await expect(overlay).toHaveAttribute('data-pattern-type', 'double-top');
  await expect(overlay).toHaveAttribute('data-pattern-status', 'candidate');
  const analysisId = await overlay.getAttribute('data-analysis-id');
  expect(analysisId).toBeTruthy();
  await expect(page.getByTestId('unified-chart-wrapper')).toHaveAttribute('data-pattern-overlay-id', analysisId!);

  const anchors = page.getByTestId('chart-pattern-anchor');
  await expect(anchors).toHaveCount(2);
  await expect(anchors.nth(0)).toHaveAttribute('data-anchor-role', 'high');
  await expect(anchors.nth(1)).toHaveAttribute('data-anchor-role', 'high');
  await expect(anchors.nth(0)).toHaveAttribute('data-anchor-time', String(BASE_TIME + 2 * STEP_SECONDS));
  await expect(anchors.nth(1)).toHaveAttribute('data-anchor-time', String(BASE_TIME + 6 * STEP_SECONDS));

  const confirmation = Number(await page.getByTestId('chart-pattern-confirmation-line').getAttribute('data-price'));
  const invalidation = Number(await page.getByTestId('chart-pattern-invalidation-line').getAttribute('data-price'));
  expect(Number.isFinite(confirmation)).toBe(true);
  expect(Number.isFinite(invalidation)).toBe(true);
  expect(confirmation).toBeLessThan(invalidation);

  await page.getByRole('button', { name: /지표 설정/ }).click();
  const markers = page.getByTestId('overlay-markers');
  await expect(markers).toContainText('✓ 분석 마커');
  await markers.click();
  await expect(overlay).toHaveCount(0);
  await expect(page.getByTestId('unified-chart-wrapper')).toHaveAttribute('data-pattern-overlay-id', '');
  await markers.click();
  await expect(overlay).toHaveCount(1);
  await expect(overlay).toHaveAttribute('data-analysis-id', analysisId!);

  const internalCanvas = page.getByTestId('unified-chart-canvas').locator('canvas').first();
  await expect(internalCanvas).toBeAttached();
  const chartSurface = await internalCanvas.elementHandle();
  expect(chartSurface).not.toBeNull();
  const expectSameChartSurface = async () => {
    expect(await chartSurface!.evaluate((element) => (
      element === document.querySelector('[data-testid="unified-chart-canvas"] canvas')
    ))).toBe(true);
  };

  await page.getByRole('button', { name: '차트 새로고침', exact: true }).click();
  await expect.poll(mock.chartCalls).toBe(2);
  await expectSameChartSurface();
  await expect(overlay).toHaveCount(1);
  await expect(overlay).toHaveAttribute('data-analysis-id', analysisId!);
  await expect(overlay).toHaveAttribute('data-pattern-status', 'confirmed');
  await expect(page.getByTestId('chart-pattern-overlay-status')).toHaveText('확정');
  await expect(page.getByTestId('chart-pattern-anchor')).toHaveCount(2);
  await expect(page.getByTestId('chart-pattern-confirmation-line')).toHaveCount(1);
  await expect(page.getByTestId('chart-pattern-invalidation-line')).toHaveCount(1);

  await page.getByRole('button', { name: '차트 새로고침', exact: true }).click();
  await expect.poll(mock.chartCalls).toBe(3);
  await expectSameChartSurface();
  await expect(overlay).toHaveCount(1);
  await expect(overlay).toHaveAttribute('data-analysis-id', analysisId!);
  await expect(overlay).toHaveAttribute('data-pattern-status', 'invalidated');
  await expect(page.getByTestId('chart-pattern-overlay-status')).toHaveText('무효화');
  await expect(page.getByTestId('chart-pattern-anchor')).toHaveCount(2);

  await page.getByRole('button', { name: '차트 새로고침', exact: true }).click();
  await expect.poll(mock.chartCalls).toBe(4);
  await expectSameChartSurface();
  await expect(overlay).toHaveCount(0);
  await expect(page.getByTestId('unified-chart-wrapper')).toHaveAttribute('data-pattern-overlay-id', '');
  await expect(page.getByTestId('chart-pattern-confirmation-line')).toHaveCount(0);
  await expect(page.getByTestId('chart-pattern-invalidation-line')).toHaveCount(0);

  expectNoBrowserErrors(evidence);
});

test('mobile pattern overlay stays inside the viewport and exposes one current analysis', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const evidence = monitorBrowser(page);
  const mock = await installMocks(page);
  await openChart(page);
  await expect.poll(mock.chartCalls).toBe(1);

  const overlay = page.getByTestId('chart-pattern-overlay');
  await expect(overlay).toHaveCount(1);
  await expect(page.getByTestId('chart-pattern-anchor')).toHaveCount(2);
  await expect(page.getByTestId('chart-pattern-confirmation-line')).toHaveCount(1);
  await expect(page.getByTestId('chart-pattern-invalidation-line')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  const box = await overlay.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390.5);
  expectNoBrowserErrors(evidence);
});
