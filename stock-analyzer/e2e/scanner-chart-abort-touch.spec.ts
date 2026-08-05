import { expect, test, type Locator, type Page, type Request } from '@playwright/test';

const CHART_ENDPOINT = /\/api\/stocks\/[^/]+\/chart(?:\?|$)/i;
const ORDER_ENDPOINT = /\/api\/(?:stocks\/auto-trade|trade-automation|paper-trading|crypto\/[^?]*(?:order|execute)|orders?|cancel)(?:[/?]|$)/i;

type MockState = {
  delayOneMinute: boolean;
  failChart: boolean;
  startedChartRequests: string[];
};

type BrowserEvidence = {
  chartAborts: Array<{ url: string; errorText: string }>;
  unexpectedRequestFailures: string[];
  consoleErrors: string[];
  expectedConsoleDiagnostics: string[];
  pageErrors: string[];
  unhandledRejections: string[];
  unexpectedHttpErrors: Array<{ status: number; url: string }>;
  orderRequests: string[];
};

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function timeframeSeconds(timeframe: string) {
  const values: Record<string, number> = {
    '1m': 60,
    '3m': 180,
    '5m': 300,
    '15m': 900,
    '30m': 1_800,
    '1H': 3_600,
    '4H': 14_400,
    '1D': 86_400,
  };
  return values[timeframe] ?? 300;
}

function validCandles(base: number, timeframe: string) {
  const step = timeframeSeconds(timeframe);
  return Array.from({ length: 40 }, (_, index) => ({
    time: 1_775_100_000 + index * step,
    open: base + index,
    high: base + index + 3,
    low: base + index - 2,
    close: base + index + 1,
    volume: 1_000 + index * 10,
    isClosed: true,
  }));
}

function monitorBrowser(page: Page): BrowserEvidence {
  const evidence: BrowserEvidence = {
    chartAborts: [],
    unexpectedRequestFailures: [],
    consoleErrors: [],
    expectedConsoleDiagnostics: [],
    pageErrors: [],
    unhandledRejections: [],
    unexpectedHttpErrors: [],
    orderRequests: [],
  };

  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (text.startsWith('[e2e-unhandledrejection]')) {
      evidence.unhandledRejections.push(text);
      return;
    }
    if (/Failed to load resource.*503/i.test(text)) {
      evidence.expectedConsoleDiagnostics.push(text);
      return;
    }
    evidence.consoleErrors.push(text);
  });
  page.on('pageerror', (error) => evidence.pageErrors.push(error.message));
  page.on('requestfailed', (request: Request) => {
    const errorText = request.failure()?.errorText ?? '';
    if (CHART_ENDPOINT.test(request.url()) && /ERR_ABORTED|NS_BINDING_ABORTED/i.test(errorText)) {
      evidence.chartAborts.push({ url: request.url(), errorText });
      return;
    }
    evidence.unexpectedRequestFailures.push(`${request.method()} ${request.url()} ${errorText}`);
  });
  page.on('request', (request) => {
    if (request.method() !== 'GET' && ORDER_ENDPOINT.test(new URL(request.url()).pathname)) {
      evidence.orderRequests.push(`${request.method()} ${request.url()}`);
    }
  });
  page.on('response', (response) => {
    if (response.url().includes('/api/') && response.status() >= 400 && response.status() !== 503) {
      evidence.unexpectedHttpErrors.push({ status: response.status(), url: response.url() });
    }
  });

  return evidence;
}

async function installMocks(page: Page, state: MockState) {
  await page.addInitScript(() => {
    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
      console.error(`[e2e-unhandledrejection] ${reason}`);
    });
  });
  await page.route('**/api/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: '{}',
  }));
  await page.route('**/api/stocks/*/candles**', (route) => route.fulfill({
    status: 404,
    contentType: 'application/json',
    body: JSON.stringify({ message: 'NOT_FOUND' }),
  }));
  await page.route('**/api/stocks/*/chart**', async (route) => {
    const requestUrl = new URL(route.request().url());
    const ticker = decodeURIComponent(requestUrl.pathname.split('/').at(-2) ?? '005930').toUpperCase();
    const timeframe = requestUrl.searchParams.get('tf') ?? '5m';
    state.startedChartRequests.push(requestUrl.toString());

    if (state.failChart) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'ABORT_TOUCH_FAILURE' }),
      });
      return;
    }
    if (state.delayOneMinute && timeframe === '1m' && ticker !== 'AAPL') await wait(2_000);

    const base = ticker === 'AAPL' ? 3_000 : timeframe === '1m' ? 1_000 : timeframe === '15m' ? 2_000 : 100;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ticker,
        timeframe,
        provider: 'chart-abort-touch-fixture',
        fetchedAt: '2026-08-05T00:00:00.000Z',
        updatedAt: '2026-08-05T00:00:00.000Z',
        candles: validCandles(base, timeframe),
      }),
    }).catch(() => undefined);
  });
}

async function openChart(page: Page, state: MockState) {
  await page.setViewportSize({ width: 390, height: 844 });
  await installMocks(page, state);
  await page.goto('/ai-chart?assetType=stock&market=KR&symbol=005930&ticker=005930&name=%EC%82%BC%EC%84%B1%EC%A0%84%EC%9E%90&timeframe=5m');
  await expect(page.getByRole('heading', { name: 'AI 차트 생중계', level: 1 })).toBeVisible();
  await expect(page.getByTestId('unified-chart-canvas')).toBeVisible();
}

async function expectTouchTarget(locator: Locator, label: string) {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator, `${label}가 화면에 보여야 합니다.`).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${label}의 bounding box가 있어야 합니다.`).not.toBeNull();
  expect(box!.height, `${label} 높이`).toBeGreaterThanOrEqual(44);
  expect(box!.width, `${label} 너비`).toBeGreaterThanOrEqual(44);
  return box!;
}

function rectanglesOverlap(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
) {
  return !(
    left.x + left.width <= right.x
    || right.x + right.width <= left.x
    || left.y + left.height <= right.y
    || right.y + right.height <= left.y
  );
}

test.describe('current AI chart abort and touch geometry', () => {
  test('aborts stale chart requests on timeframe and market changes', async ({ page }) => {
    const state: MockState = { delayOneMinute: false, failChart: false, startedChartRequests: [] };
    const evidence = monitorBrowser(page);
    await openChart(page, state);

    await page.getByRole('button', { name: '자동 갱신 중', exact: true }).click();
    state.delayOneMinute = true;
    await page.getByTestId('timeframe-1m').click();
    await expect.poll(() => state.startedChartRequests.filter((url) => url.includes('tf=1m')).length).toBe(1);
    await page.getByTestId('timeframe-15m').click();
    const currentPrice = page.getByText('현재가', { exact: true }).locator('xpath=../..');
    await expect(currentPrice).toContainText('2,040원');
    await expect.poll(() => evidence.chartAborts.filter(({ url }) => url.includes('tf=1m')).length).toBe(1);
    await page.waitForTimeout(2_100);
    await expect(currentPrice).toContainText('2,040원');

    await page.getByTestId('timeframe-1m').click();
    await expect.poll(() => state.startedChartRequests.filter((url) => url.includes('tf=1m')).length).toBe(2);
    await page.getByTestId('market-US').click();
    await expect(page).toHaveURL(/market=US/);
    await expect(currentPrice).toContainText('$3,040.00');
    await expect.poll(() => evidence.chartAborts.filter(({ url }) => url.includes('tf=1m')).length).toBe(2);
    await page.waitForTimeout(2_100);
    await expect(currentPrice).toContainText('$3,040.00');

    expect(evidence.chartAborts).toHaveLength(2);
    expect(evidence.chartAborts.every(({ errorText }) => /ERR_ABORTED|NS_BINDING_ABORTED/i.test(errorText))).toBe(true);
    expect(evidence.unexpectedRequestFailures).toEqual([]);
    expect(evidence.consoleErrors).toEqual([]);
    expect(evidence.pageErrors).toEqual([]);
    expect(evidence.unhandledRejections).toEqual([]);
    expect(evidence.unexpectedHttpErrors).toEqual([]);
    expect(evidence.orderRequests).toEqual([]);
  });

  test('keeps primary mobile chart controls at least 44px without overlap or overflow', async ({ page }) => {
    const state: MockState = { delayOneMinute: false, failChart: false, startedChartRequests: [] };
    const evidence = monitorBrowser(page);
    await openChart(page, state);

    const domestic = page.getByTestId('market-KR');
    const overseas = page.getByTestId('market-US');
    const domesticBox = await expectTouchTarget(domestic, '국내주식 시장 버튼');
    const overseasBox = await expectTouchTarget(overseas, '미국주식 시장 버튼');
    expect(rectanglesOverlap(domesticBox, overseasBox), '시장 버튼 터치 영역 겹침').toBe(false);

    await page.getByRole('button', { name: '자동 갱신 중', exact: true }).click();
    await expectTouchTarget(page.getByRole('button', { name: '갱신 일시정지', exact: true }), '자동 갱신 버튼');
    await expectTouchTarget(page.getByLabel('차트 종목 심볼'), '종목 심볼 입력');
    await expectTouchTarget(page.getByRole('button', { name: '차트 새로고침', exact: true }), '차트 새로고침 버튼');
    await expectTouchTarget(page.getByTestId('timeframe-1m'), '1분 시간봉 버튼');
    await expectTouchTarget(page.getByTestId('timeframe-15m'), '15분 시간봉 버튼');

    state.failChart = true;
    await page.getByRole('button', { name: '차트 새로고침', exact: true }).click();
    await expect(page.getByTestId('chart-error-state')).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('ABORT_TOUCH_FAILURE');
    await expectTouchTarget(page.getByRole('button', { name: '다시 시도', exact: true }), '차트 재시도 버튼');
    state.failChart = false;
    await page.getByRole('button', { name: '다시 시도', exact: true }).click();
    await expect(page.getByTestId('unified-chart-canvas')).toBeVisible();

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.setViewportSize({ width: 844, height: 390 });
    await expectTouchTarget(page.getByTestId('timeframe-15m'), '가로 화면 15분 시간봉 버튼');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    expect(evidence.unexpectedRequestFailures).toEqual([]);
    expect(evidence.consoleErrors).toEqual([]);
    expect(evidence.pageErrors).toEqual([]);
    expect(evidence.unhandledRejections).toEqual([]);
    expect(evidence.unexpectedHttpErrors).toEqual([]);
    expect(evidence.orderRequests).toEqual([]);
  });
});
