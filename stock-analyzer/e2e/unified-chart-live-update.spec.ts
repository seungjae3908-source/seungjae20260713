import { test, expect, type Page, type Request } from '@playwright/test';

type BrowserEvidence = {
  consoleErrors: string[];
  pageErrors: string[];
  requestFailures: string[];
  unexpectedHttpErrors: string[];
  orderRequests: string[];
};

function chartCandles(version: number) {
  const rows = Array.from({ length: 80 }, (_, index) => ({
    time: 1_775_000_000 + index * 300,
    open: 1_000 + index,
    high: 1_005 + index,
    low: 997 + index,
    close: 1_002 + index,
    volume: 1_000 + index * 10,
    isClosed: index < 79,
  }));

  if (version >= 2) {
    rows[79] = {
      ...rows[79],
      open: 1_079,
      high: 1_185,
      low: 1_076,
      close: 1_181,
      volume: 2_500,
      isClosed: version >= 3,
    };
  }

  if (version >= 3) {
    rows.push({
      time: rows[79].time + 300,
      open: 1_181,
      high: 1_285,
      low: 1_178,
      close: 1_281,
      volume: 3_000,
      isClosed: false,
    });
  }

  return rows;
}

function monitorBrowser(page: Page): BrowserEvidence {
  const evidence: BrowserEvidence = {
    consoleErrors: [],
    pageErrors: [],
    requestFailures: [],
    unexpectedHttpErrors: [],
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
    if (response.status() >= 400) evidence.unexpectedHttpErrors.push(`${response.status()} ${response.url()}`);
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
        provider: 'live-update-fixture',
        fetchedAt: '2030-01-01T00:00:00.000Z',
        updatedAt: '2030-01-01T00:00:00.000Z',
        candles: chartCandles(chartCalls),
      }),
    });
  });

  return {
    chartCalls: () => chartCalls,
  };
}

test('live refresh replaces the active candle, appends a new candle, and preserves chart state', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const evidence = monitorBrowser(page);
  const mock = await installMocks(page);

  await page.goto('/ai-chart?assetType=stock&market=KR&symbol=005930&ticker=005930&name=%EC%82%BC%EC%84%B1%EC%A0%84%EC%9E%90&timeframe=5m');
  await expect(page.getByRole('heading', { name: 'AI 차트 생중계', level: 1 })).toBeVisible();
  await expect(page.getByTestId('unified-chart-canvas')).toBeVisible();
  await expect.poll(mock.chartCalls).toBe(1);

  await page.getByRole('button', { name: '자동 갱신 중', exact: true }).click();
  await expect(page.getByRole('button', { name: '갱신 일시정지', exact: true })).toBeVisible();

  const currentPrice = page.getByText('현재가', { exact: true }).locator('xpath=../..');
  await expect(currentPrice).toContainText('1,081원');
  await expect(page.getByText('최근 1건', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: /지표 설정/ }).click();
  const sma20 = page.getByTestId('overlay-sma20');
  await expect(sma20).toContainText('✓ SMA20');
  await sma20.click();
  await expect(sma20).toContainText('+ SMA20');

  await page.getByRole('button', { name: '차트 새로고침', exact: true }).click();
  await expect.poll(mock.chartCalls).toBe(2);
  await expect(currentPrice).toContainText('1,181원');
  await expect(page.getByText('최근 1건', { exact: true })).toBeVisible();
  await expect(sma20).toContainText('+ SMA20');
  await expect(page.getByTestId('unified-chart-canvas')).toBeVisible();

  await page.getByRole('button', { name: '차트 새로고침', exact: true }).click();
  await expect.poll(mock.chartCalls).toBe(3);
  await expect(currentPrice).toContainText('1,281원');
  await expect(page.getByText('최근 2건', { exact: true })).toBeVisible();
  await expect(sma20).toContainText('+ SMA20');
  await expect(page.getByTestId('unified-chart-canvas')).toBeVisible();

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(evidence.consoleErrors, `console errors: ${evidence.consoleErrors.join('\n')}`).toEqual([]);
  expect(evidence.pageErrors, `page errors: ${evidence.pageErrors.join('\n')}`).toEqual([]);
  expect(evidence.requestFailures, `request failures: ${evidence.requestFailures.join('\n')}`).toEqual([]);
  expect(evidence.unexpectedHttpErrors, `HTTP errors: ${evidence.unexpectedHttpErrors.join('\n')}`).toEqual([]);
  expect(evidence.orderRequests, `order requests: ${evidence.orderRequests.join('\n')}`).toEqual([]);
});
