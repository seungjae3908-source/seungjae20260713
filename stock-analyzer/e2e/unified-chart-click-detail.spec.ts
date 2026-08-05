import { test, expect, type Page, type Request } from '@playwright/test';

const BASE_TIME = 1_775_000_000;
const CANDLE_COUNT = 80;
const STEP_SECONDS = 300;

function candles(basePrice = 1_000) {
  return Array.from({ length: CANDLE_COUNT }, (_, index) => ({
    time: BASE_TIME + index * STEP_SECONDS,
    open: basePrice + index,
    high: basePrice + index + 5,
    low: basePrice + index - 3,
    close: basePrice + index + 2,
    volume: 1_000 + index * 10,
    isClosed: index < CANDLE_COUNT - 1,
  }));
}

type BrowserEvidence = {
  consoleErrors: string[];
  pageErrors: string[];
  requestFailures: string[];
  httpErrors: string[];
  orderRequests: string[];
};

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
  await page.route('**/api/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: '{}',
  }));
  await page.route('**/api/stocks/*/chart**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      provider: 'click-detail-fixture',
      fetchedAt: '2030-01-01T00:00:00.000Z',
      updatedAt: '2030-01-01T00:00:00.000Z',
      candles: candles(),
    }),
  }));
}

async function openChart(page: Page) {
  await page.goto('/ai-chart?assetType=stock&market=KR&symbol=005930&ticker=005930&name=%EC%82%BC%EC%84%B1%EC%A0%84%EC%9E%90&timeframe=5m');
  await expect(page.getByRole('heading', { name: 'AI 차트 생중계', level: 1 })).toBeVisible();
  await expect(page.getByTestId('unified-chart-canvas')).toBeVisible();
  await expect(page.getByTestId('selected-candle-detail')).toBeVisible();
}

async function selectPastCandle(page: Page, touch = false): Promise<number> {
  const canvas = page.getByTestId('unified-chart-canvas');
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + box!.width * 0.28;
  const y = box!.y + box!.height * 0.55;
  if (touch) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
  await expect(page.getByTestId('selected-candle-mode')).toHaveText('선택한 과거 캔들');
  const selected = Number(await page.getByTestId('selected-candle-detail').getAttribute('data-candle-time'));
  expect(Number.isFinite(selected)).toBe(true);
  return selected;
}

function expectNoBrowserErrors(evidence: BrowserEvidence) {
  expect(evidence.consoleErrors, `console errors: ${evidence.consoleErrors.join('\n')}`).toEqual([]);
  expect(evidence.pageErrors, `page errors: ${evidence.pageErrors.join('\n')}`).toEqual([]);
  expect(evidence.requestFailures, `request failures: ${evidence.requestFailures.join('\n')}`).toEqual([]);
  expect(evidence.httpErrors, `HTTP errors: ${evidence.httpErrors.join('\n')}`).toEqual([]);
  expect(evidence.orderRequests, `order requests: ${evidence.orderRequests.join('\n')}`).toEqual([]);
}

test('chart click selects exact historical OHLCV and indicator detail without changing latest analysis', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const evidence = monitorBrowser(page);
  await installMocks(page);
  await openChart(page);

  const latestTime = BASE_TIME + (CANDLE_COUNT - 1) * STEP_SECONDS;
  const detail = page.getByTestId('selected-candle-detail');
  await expect(page.getByTestId('selected-candle-mode')).toHaveText('최신 캔들');
  await expect(detail).toHaveAttribute('data-candle-time', String(latestTime));
  await expect(page.getByTestId('selected-candle-close')).toContainText('1,081원');

  const selectedTime = await selectPastCandle(page);
  expect(selectedTime).not.toBe(latestTime);
  const selectedIndex = (selectedTime - BASE_TIME) / STEP_SECONDS;
  expect(Number.isInteger(selectedIndex)).toBe(true);
  expect(selectedIndex).toBeGreaterThanOrEqual(0);
  expect(selectedIndex).toBeLessThan(CANDLE_COUNT - 1);

  await expect(page.getByTestId('selected-candle-open')).toContainText(`${(1_000 + selectedIndex).toLocaleString('ko-KR')}원`);
  await expect(page.getByTestId('selected-candle-high')).toContainText(`${(1_005 + selectedIndex).toLocaleString('ko-KR')}원`);
  await expect(page.getByTestId('selected-candle-low')).toContainText(`${(997 + selectedIndex).toLocaleString('ko-KR')}원`);
  await expect(page.getByTestId('selected-candle-close')).toContainText(`${(1_002 + selectedIndex).toLocaleString('ko-KR')}원`);
  await expect(page.getByTestId('selected-candle-volume')).toContainText((1_000 + selectedIndex * 10).toLocaleString('ko-KR'));
  await expect(page.getByTestId('selected-candle-status')).toContainText('완료봉');
  await expect(page.getByTestId('selected-candle-rsi')).not.toContainText('-');
  await expect(page.getByTestId('selected-candle-macd')).not.toContainText('-');
  await expect(page.getByTestId('selected-candle-atr')).not.toContainText('-');

  const latestAnalysisPrice = page.getByText('현재가', { exact: true }).locator('xpath=../..');
  await expect(latestAnalysisPrice).toContainText('1,081원');
  await page.getByRole('button', { name: '최신 캔들 보기', exact: true }).click();
  await expect(page.getByTestId('selected-candle-mode')).toHaveText('최신 캔들');
  await expect(detail).toHaveAttribute('data-candle-time', String(latestTime));

  expectNoBrowserErrors(evidence);
});

test('mobile touch selects candle detail with 44px reset control and no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const evidence = monitorBrowser(page);
  await installMocks(page);
  await openChart(page);

  await selectPastCandle(page, true);
  const reset = page.getByRole('button', { name: '최신 캔들 보기', exact: true });
  const resetBox = await reset.boundingBox();
  expect(resetBox).not.toBeNull();
  expect(resetBox!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await reset.click();
  await expect(page.getByTestId('selected-candle-mode')).toHaveText('최신 캔들');
  expectNoBrowserErrors(evidence);
});
