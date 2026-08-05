import { expect, test, type Locator, type Page, type Request } from '@playwright/test';

const SCAN_ENDPOINT = /\/api\/market\/scan(?:\?|$)/i;
const CHART_ENDPOINT = /\/api\/stocks\/[^/]+\/chart(?:\?|$)/i;
const ORDER_ENDPOINT = /\/api\/.*(?:order|trade|approval|execute|cancel)/i;

type MockState = {
  delayInitialScan: boolean;
  delayOneMinuteChart: boolean;
  scanRequests: string[];
  chartRequests: string[];
};

type Evidence = {
  scanAborts: Array<{ url: string; errorText: string }>;
  chartAborts: Array<{ url: string; errorText: string }>;
  unexpectedRequestFailures: string[];
  consoleErrors: string[];
  pageErrors: string[];
  unhandledRejections: string[];
  unexpectedHttpErrors: Array<{ status: number; url: string }>;
  orderRequests: string[];
};

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function scannerPayload(call: number) {
  return {
    ok: true,
    requestId: `scanner-readiness:${call}`,
    searchRunId: `scanner-readiness:${call}`,
    assetClass: 'stock',
    market: call === 1 ? 'KR' : 'US',
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
      elapsedMs: 10,
      deadlineMs: 12_000,
      itemTimeoutMs: 3_500,
      maxConcurrency: 1,
    },
    universe: {
      totalCount: 0,
      cursor: 0,
      nextCursor: null,
      source: call === 1 ? 'krx-symbol-master' : 'finnhub-symbol-master',
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

function candles(base: number, timeframe: string) {
  const step = timeframe === '1m' ? 60 : timeframe === '15m' ? 900 : 300;
  return Array.from({ length: 40 }, (_, index) => ({
    time: 1_775_300_000 + index * step,
    open: base + index,
    high: base + index + 3,
    low: base + index - 2,
    close: base + index + 1,
    volume: 1_000 + index * 10,
    isClosed: true,
  }));
}

function monitor(page: Page): Evidence {
  const evidence: Evidence = {
    scanAborts: [],
    chartAborts: [],
    unexpectedRequestFailures: [],
    consoleErrors: [],
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
    evidence.consoleErrors.push(text);
  });
  page.on('pageerror', (error) => evidence.pageErrors.push(error.message));
  page.on('requestfailed', (request: Request) => {
    const errorText = request.failure()?.errorText ?? '';
    if (SCAN_ENDPOINT.test(request.url()) && /ERR_ABORTED|NS_BINDING_ABORTED/i.test(errorText)) {
      evidence.scanAborts.push({ url: request.url(), errorText });
      return;
    }
    if (CHART_ENDPOINT.test(request.url()) && /ERR_ABORTED|NS_BINDING_ABORTED/i.test(errorText)) {
      evidence.chartAborts.push({ url: request.url(), errorText });
      return;
    }
    evidence.unexpectedRequestFailures.push(`${request.method()} ${request.url()} ${errorText}`);
  });
  page.on('response', (response) => {
    if (response.url().includes('/api/') && response.status() >= 400) {
      evidence.unexpectedHttpErrors.push({ status: response.status(), url: response.url() });
    }
  });
  page.on('request', (request) => {
    if (request.method() !== 'GET' && ORDER_ENDPOINT.test(new URL(request.url()).pathname)) {
      evidence.orderRequests.push(`${request.method()} ${request.url()}`);
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
  await page.route('**/api/market/scan**', async (route) => {
    const call = state.scanRequests.length + 1;
    state.scanRequests.push(route.request().url());
    if (state.delayInitialScan && call === 1) await wait(2_000);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(scannerPayload(call)),
    }).catch(() => undefined);
  });
  await page.route('**/api/stocks/*/candles**', (route) => route.fulfill({
    status: 404,
    contentType: 'application/json',
    body: JSON.stringify({ message: 'NOT_FOUND' }),
  }));
  await page.route('**/api/stocks/*/chart**', async (route) => {
    const url = new URL(route.request().url());
    const ticker = decodeURIComponent(url.pathname.split('/').at(-2) ?? '005930').toUpperCase();
    const timeframe = url.searchParams.get('tf') ?? '5m';
    state.chartRequests.push(url.toString());
    if (state.delayOneMinuteChart && timeframe === '1m') await wait(2_000);
    const base = ticker === 'AAPL' ? 3_000 : timeframe === '1m' ? 1_000 : timeframe === '15m' ? 2_000 : 100;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ticker,
        timeframe,
        provider: 'scanner-readiness-chart-fixture',
        fetchedAt: '2026-08-05T00:00:00.000Z',
        updatedAt: '2026-08-05T00:00:00.000Z',
        candles: candles(base, timeframe),
      }),
    }).catch(() => undefined);
  });
}

async function expectTouchTarget(locator: Locator, label: string) {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator, `${label}가 화면에 보여야 합니다.`).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${label}의 bounding box가 있어야 합니다.`).not.toBeNull();
  expect(box!.width, `${label} 너비`).toBeGreaterThanOrEqual(44);
  expect(box!.height, `${label} 높이`).toBeGreaterThanOrEqual(44);
  return box!;
}

function overlaps(
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

async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

async function expectVisiblePanelsInsideViewport(page: Page) {
  const escaped = await page.locator('[role="dialog"]:visible, [data-testid="scanner-readiness-status"]:visible').evaluateAll((elements) => elements
    .map((element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: window.innerWidth, height: window.innerHeight };
    })
    .filter((box) => box.left < 0 || box.top < 0 || box.right > box.width || box.bottom > box.height));
  expect(escaped).toEqual([]);
}

test.describe('scanner readiness and current AI chart integration', () => {
  test('separates scan and chart aborts and keeps mobile controls usable', async ({ page }) => {
    const state: MockState = {
      delayInitialScan: true,
      delayOneMinuteChart: false,
      scanRequests: [],
      chartRequests: [],
    };
    const evidence = monitor(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await installMocks(page, state);
    await page.goto('/__phase11-technical-workspace-e2e');

    await expect(page.getByRole('heading', { name: 'AI 신호검색기' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'AI 차트 생중계', level: 1 })).toBeVisible();
    await expect(page.getByTestId('scanner-loading')).toBeVisible();
    await expect.poll(() => state.scanRequests.length).toBe(1);

    const scannerMarket = page.getByRole('region', { name: '검색 시장' });
    await scannerMarket.getByRole('button', { name: /^미국주식/ }).click();
    await expect.poll(() => state.scanRequests.length).toBeGreaterThanOrEqual(2);
    await expect.poll(() => evidence.scanAborts.length).toBe(1);
    await expect(page.getByTestId('scanner-empty')).toBeVisible();
    await page.waitForTimeout(2_100);
    await expect(page.getByTestId('scanner-empty')).toBeVisible();

    await expect(page.getByTestId('unified-chart-canvas')).toBeVisible();
    await page.getByRole('button', { name: '자동 갱신 중', exact: true }).click();
    state.delayOneMinuteChart = true;
    await page.getByTestId('timeframe-1m').click();
    await expect.poll(() => state.chartRequests.filter((url) => url.includes('tf=1m')).length).toBe(1);
    await page.getByTestId('timeframe-15m').click();
    const currentPrice = page.getByText('현재가', { exact: true }).locator('xpath=../..');
    await expect(currentPrice).toContainText('2,040원');
    await expect.poll(() => evidence.chartAborts.length).toBe(1);
    await page.waitForTimeout(2_100);
    await expect(currentPrice).toContainText('2,040원');

    for (const viewport of [
      { width: 360, height: 800 },
      { width: 390, height: 844 },
      { width: 430, height: 932 },
      { width: 844, height: 390 },
    ]) {
      await page.setViewportSize(viewport);
      const readiness = page.getByTestId('scanner-readiness-status');
      const chartMarket = page.getByTestId('market-US');
      const timeframe = page.getByTestId('timeframe-15m');
      const readinessBox = await readiness.boundingBox();
      const chartMarketBox = await expectTouchTarget(chartMarket, `${viewport.width}px 차트 시장 버튼`);
      const timeframeBox = await expectTouchTarget(timeframe, `${viewport.width}px 시간봉 버튼`);
      expect(readinessBox).not.toBeNull();
      expect(overlaps(readinessBox!, chartMarketBox)).toBe(false);
      expect(overlaps(readinessBox!, timeframeBox)).toBe(false);
      await timeframe.tap();
      await expectNoHorizontalOverflow(page);
      await expectVisiblePanelsInsideViewport(page);
    }

    expect(evidence.scanAborts).toHaveLength(1);
    expect(evidence.chartAborts).toHaveLength(1);
    expect(evidence.unexpectedRequestFailures, evidence.unexpectedRequestFailures.join('\n')).toEqual([]);
    expect(evidence.consoleErrors, evidence.consoleErrors.join('\n')).toEqual([]);
    expect(evidence.pageErrors, evidence.pageErrors.join('\n')).toEqual([]);
    expect(evidence.unhandledRejections, evidence.unhandledRejections.join('\n')).toEqual([]);
    expect(evidence.unexpectedHttpErrors).toEqual([]);
    expect(evidence.orderRequests).toEqual([]);
  });
});
