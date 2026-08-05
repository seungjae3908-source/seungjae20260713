import { expect, test, type Page, type Request } from '@playwright/test';

const ORDER_ENDPOINT = /\/api\/(?:stocks\/auto-trade|trade-automation|paper-trading|crypto\/[^?]*(?:order|execute)|orders?|cancel)(?:[/?]|$)/i;

type ChartScenario = 'mixed' | 'invalid-only' | 'empty' | 'rate-limited' | 'server-error' | 'normal' | 'timeframe-race';
type MockState = { scenario: ChartScenario };

type BrowserEvidence = {
  consoleErrors: string[];
  expectedConsoleDiagnostics: string[];
  pageErrors: string[];
  unhandledRejections: string[];
  unexpectedRequestFailures: string[];
  apiHttpErrors: Array<{ status: number; url: string }>;
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
    time: 1_775_200_000 + index * step,
    open: base + index,
    high: base + index + 3,
    low: base + index - 2,
    close: base + index + 1,
    volume: 1_000 + index * 10,
    isClosed: true,
  }));
}

function mixedCandles(base: number, timeframe: string) {
  const rows = validCandles(base, timeframe);
  return [
    ...rows,
    { time: '', open: 9_998, high: 10_001, low: 9_997, close: 9_999, volume: 10 },
    { time: 'not-a-time', open: 8_887, high: 8_890, low: 8_886, close: 8_888, volume: 10 },
    { time: 1_775_999_999, open: 7_000, high: 6_990, low: 6_980, close: 7_010, volume: 10 },
  ];
}

function invalidOnlyCandles() {
  return [
    { time: '', open: 100, high: 103, low: 99, close: 101, volume: 100 },
    { time: 'missing-time', open: 101, high: 104, low: 100, close: 102, volume: 110 },
    { time: Number.NaN, open: 102, high: 105, low: 101, close: 103, volume: 120 },
  ];
}

function scannerPayload() {
  return {
    ok: true,
    requestId: 'chart-broadcast-scanner',
    searchRunId: 'chart-broadcast-scanner',
    assetClass: 'stock',
    market: 'KR',
    timeframe: '1D',
    cards: [],
    alerts: [],
    failures: [],
    execution: {
      requestedCount: 0,
      startedCount: 0,
      completedCount: 0,
      excludedCount: 0,
      providerErrorCount: 0,
      timeoutCount: 0,
      partial: false,
      timedOut: false,
      cancelled: false,
      duplicate: false,
      elapsedMs: 1,
      deadlineMs: 12_000,
      itemTimeoutMs: 3_500,
      maxConcurrency: 1,
    },
    universe: {
      totalCount: 0,
      cursor: 0,
      nextCursor: null,
      source: 'fixture',
      partial: false,
      stale: false,
      listingStatusCoverage: 'listed-or-unknown',
    },
    dataState: 'complete',
    message: '검색 결과가 없습니다.',
    generatedAt: '2026-08-05T00:00:00.000Z',
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
}

function monitorBrowser(page: Page): BrowserEvidence {
  const evidence: BrowserEvidence = {
    consoleErrors: [],
    expectedConsoleDiagnostics: [],
    pageErrors: [],
    unhandledRejections: [],
    unexpectedRequestFailures: [],
    apiHttpErrors: [],
    orderRequests: [],
  };
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (text.startsWith('[e2e-unhandledrejection]')) {
      evidence.unhandledRejections.push(text);
      return;
    }
    if (/Failed to load resource.*(?:429|503)/i.test(text)) {
      evidence.expectedConsoleDiagnostics.push(text);
      return;
    }
    evidence.consoleErrors.push(text);
  });
  page.on('pageerror', (error) => evidence.pageErrors.push(error.message));
  page.on('requestfailed', (request: Request) => {
    const errorText = request.failure()?.errorText ?? '';
    if (!/ERR_ABORTED|NS_BINDING_ABORTED/i.test(errorText)) {
      evidence.unexpectedRequestFailures.push(`${request.method()} ${request.url()} ${errorText}`);
    }
  });
  page.on('request', (request) => {
    if (request.method() !== 'GET' && ORDER_ENDPOINT.test(new URL(request.url()).pathname)) {
      evidence.orderRequests.push(`${request.method()} ${request.url()}`);
    }
  });
  page.on('response', (response) => {
    if (response.url().includes('/api/') && response.status() >= 400) {
      evidence.apiHttpErrors.push({ status: response.status(), url: response.url() });
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
  await page.route('**/api/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/market/scan**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(scannerPayload()),
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

    if (state.scenario === 'rate-limited') {
      await route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ message: 'RATE_LIMITED' }) });
      return;
    }
    if (state.scenario === 'server-error') {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'SERVER_FAILURE' }) });
      return;
    }
    if (state.scenario === 'timeframe-race') await wait(timeframe === '1m' ? 900 : 40);
    else if (state.scenario === 'mixed') await wait(350);

    const base = ticker === 'AAPL' ? 3_000 : timeframe === '1m' ? 1_000 : timeframe === '15m' ? 2_000 : 100;
    const candles = state.scenario === 'invalid-only'
      ? invalidOnlyCandles()
      : state.scenario === 'empty'
        ? []
        : state.scenario === 'mixed'
          ? mixedCandles(base, timeframe)
          : validCandles(base, timeframe);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ticker,
        timeframe,
        provider: 'chart-broadcast-fixture',
        fetchedAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
        candles,
      }),
    }).catch(() => undefined);
  });
}

async function openChart(page: Page, state: MockState) {
  await page.setViewportSize({ width: 390, height: 844 });
  await installMocks(page, state);
  await page.goto('/ai-chart?assetType=stock&market=KR&symbol=005930&ticker=005930&name=%EC%82%BC%EC%84%B1%EC%A0%84%EC%9E%90&timeframe=5m');
  await expect(page.getByRole('heading', { name: 'AI 차트 생중계', level: 1 })).toBeVisible();
}

test.describe('current mobile AI chart broadcast contract', () => {
  test('drops invalid timestamps, handles explicit failures, and recovers', async ({ page }) => {
    const state: MockState = { scenario: 'mixed' };
    const evidence = monitorBrowser(page);
    await openChart(page, state);

    await expect(page.getByText('차트 불러오는 중', { exact: true })).toBeVisible();
    await expect(page.getByTestId('unified-chart-canvas')).toBeVisible();
    const currentPrice = page.getByText('현재가', { exact: true }).locator('xpath=../..');
    await expect(currentPrice).toContainText('140원');
    await expect(page.getByText('9,999원', { exact: true })).toHaveCount(0);
    await expect(page.getByText('8,888원', { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('chart-data-status')).toContainText('오래된 데이터');
    await page.getByRole('button', { name: '자동 갱신 중', exact: true }).click();

    state.scenario = 'invalid-only';
    await page.getByRole('button', { name: '차트 새로고침', exact: true }).click();
    await expect(page.getByTestId('chart-empty-state')).toBeVisible();
    await expect(page.getByText('현재 생중계 판단', { exact: true }).locator('xpath=..')).toContainText('실제 캔들이 준비되면');

    state.scenario = 'empty';
    await page.getByRole('button', { name: '차트 새로고침', exact: true }).click();
    await expect(page.getByTestId('chart-empty-state')).toBeVisible();

    state.scenario = 'rate-limited';
    await page.getByRole('button', { name: '차트 새로고침', exact: true }).click();
    await expect(page.getByTestId('chart-error-state')).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('RATE_LIMITED');

    state.scenario = 'server-error';
    await page.getByRole('button', { name: '다시 시도', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('SERVER_FAILURE');

    state.scenario = 'normal';
    await page.getByRole('button', { name: '다시 시도', exact: true }).click();
    await expect(page.getByTestId('unified-chart-canvas')).toBeVisible();
    await expect(currentPrice).toContainText('140원');

    state.scenario = 'timeframe-race';
    await page.getByTestId('timeframe-1m').click();
    await page.getByTestId('timeframe-15m').click();
    await expect(currentPrice).toContainText('2,040원');
    await page.waitForTimeout(1_100);
    await expect(currentPrice).toContainText('2,040원');

    await page.getByTestId('market-US').click();
    await expect(page).toHaveURL(/market=US/);
    await expect(currentPrice).toContainText('$3,040.00');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    const unexpectedHttpErrors = evidence.apiHttpErrors.filter(({ status }) => status !== 429 && status !== 503);
    expect(evidence.apiHttpErrors.some(({ status }) => status === 429)).toBe(true);
    expect(evidence.apiHttpErrors.some(({ status }) => status === 503)).toBe(true);
    expect(unexpectedHttpErrors).toEqual([]);
    expect(evidence.consoleErrors).toEqual([]);
    expect(evidence.pageErrors).toEqual([]);
    expect(evidence.unhandledRejections).toEqual([]);
    expect(evidence.unexpectedRequestFailures).toEqual([]);
    expect(evidence.orderRequests).toEqual([]);
  });

  test('technical workspace embeds the same read-only chart without sending an order request', async ({ page }) => {
    const state: MockState = { scenario: 'normal' };
    const evidence = monitorBrowser(page);
    await installMocks(page, state);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/__phase11-technical-workspace-e2e');

    await expect(page.getByRole('heading', { name: 'AI 신호검색기' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'AI 차트 생중계', level: 1 })).toBeVisible();
    await expect(page.getByTestId('unified-chart-canvas')).toBeVisible();
    await expect(page.getByText('공개 시세 읽기 전용', { exact: true })).toBeVisible();
    await page.waitForTimeout(500);

    expect(evidence.orderRequests).toEqual([]);
    expect(evidence.consoleErrors).toEqual([]);
    expect(evidence.pageErrors).toEqual([]);
    expect(evidence.unhandledRejections).toEqual([]);
    expect(evidence.unexpectedRequestFailures).toEqual([]);
    expect(evidence.apiHttpErrors).toEqual([]);
  });
});
