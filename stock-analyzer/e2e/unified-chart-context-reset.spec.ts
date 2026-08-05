import { test, expect, type Page, type Request } from '@playwright/test';

const BASE_TIME = 1_775_600_000;
const STEP_SECONDS = 300;
const DOUBLE_TOP = [100, 104, 110, 104, 100, 103, 109.5, 104, 102, 103, 104];

type BrowserEvidence = {
  consoleErrors: string[];
  pageErrors: string[];
  requestFailures: string[];
  httpErrors: string[];
  orderRequests: string[];
};

type UnhandledWindow = Window & {
  __contextResetUnhandled?: string[];
};

function rows(values: number[]) {
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

function trend(base: number, count = 24) {
  return rows(Array.from({ length: count }, (_, index) => base + index));
}

async function monitorBrowser(page: Page): Promise<BrowserEvidence> {
  const evidence: BrowserEvidence = {
    consoleErrors: [],
    pageErrors: [],
    requestFailures: [],
    httpErrors: [],
    orderRequests: [],
  };

  await page.addInitScript(() => {
    const target = window as UnhandledWindow;
    target.__contextResetUnhandled = [];
    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason instanceof Error ? event.reason.message : String(event.reason ?? 'unknown');
      target.__contextResetUnhandled?.push(reason);
    });
  });

  page.on('console', (message) => {
    if (message.type() === 'error') evidence.consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => evidence.pageErrors.push(error.message));
  page.on('requestfailed', (request: Request) => {
    const failure = request.failure()?.errorText ?? '';
    if (/ERR_ABORTED|NS_BINDING_ABORTED/i.test(failure)) return;
    evidence.requestFailures.push(`${request.method()} ${request.url()} ${failure}`);
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

function timeframeFrom(url: string): string {
  const parsed = new URL(url);
  return parsed.searchParams.get('tf') ?? parsed.searchParams.get('granularity') ?? '5m';
}

async function installMocks(page: Page) {
  let oneMinuteCalls = 0;

  await page.route('**/api/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: '{}',
  }));

  await page.route('**/api/stocks/*/chart**', async (route) => {
    const url = route.request().url();
    const parsed = new URL(url);
    const ticker = decodeURIComponent(parsed.pathname.split('/').at(-2) ?? '');
    const timeframe = timeframeFrom(url);

    let provider = 'context-reset-unknown';
    let candles = trend(900);
    let delay = 0;

    if (ticker === '005930' && timeframe === '5m') {
      provider = 'context-reset-kr-5m';
      candles = rows(DOUBLE_TOP);
    } else if (ticker === '005930' && timeframe === '1m') {
      oneMinuteCalls += 1;
      provider = 'context-reset-kr-1m-late';
      candles = trend(10_000);
      delay = 900;
    } else if (ticker === '005930' && timeframe === '15m') {
      provider = 'context-reset-kr-15m';
      candles = trend(20_000);
    } else if (ticker === '000660' && timeframe === '15m') {
      provider = 'context-reset-kr-000660';
      candles = rows(DOUBLE_TOP.map((value) => value + 300));
      delay = 250;
    } else if (ticker === 'AAPL' && timeframe === '15m') {
      provider = 'context-reset-us-aapl';
      candles = trend(500);
    }

    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        provider,
        fetchedAt: '2026-08-04T11:40:00.000Z',
        updatedAt: '2026-08-04T11:40:00.000Z',
        candles,
      }),
    }).catch(() => undefined);
  });

  return {
    oneMinuteCalls: () => oneMinuteCalls,
  };
}

async function openChart(page: Page) {
  await page.goto('/ai-chart?assetType=stock&market=KR&symbol=005930&ticker=005930&name=%EC%82%BC%EC%84%B1%EC%A0%84%EC%9E%90&timeframe=5m');
  await expect(page.getByRole('heading', { name: 'AI 차트 생중계', level: 1 })).toBeVisible();
  await expect(page.getByText('context-reset-kr-5m', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '자동 갱신 중', exact: true }).click();
  await expect(page.getByRole('button', { name: '갱신 일시정지', exact: true })).toBeVisible();
}

async function selectPastCandle(page: Page): Promise<number> {
  const canvas = page.getByTestId('unified-chart-canvas');
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + box!.width * 0.28, box!.y + box!.height * 0.55);
  await expect(page.getByTestId('selected-candle-mode')).toHaveText('선택한 과거 캔들');
  const selected = Number(await page.getByTestId('selected-candle-detail').getAttribute('data-candle-time'));
  expect(Number.isFinite(selected)).toBe(true);
  return selected;
}

function timeline(page: Page) {
  return page.locator('section').filter({ hasText: '분석 상태 타임라인' }).last();
}

function currentAnalysis(page: Page) {
  return page.locator('section').filter({ hasText: '현재 생중계 판단' }).last();
}

async function expectLatestCandle(page: Page, expectedTime: number) {
  await expect(page.getByTestId('selected-candle-mode')).toHaveText('최신 캔들');
  await expect(page.getByTestId('selected-candle-detail')).toHaveAttribute('data-candle-time', String(expectedTime));
}

async function expectNoBrowserErrors(page: Page, evidence: BrowserEvidence) {
  const unhandled = await page.evaluate(() => (
    (window as UnhandledWindow).__contextResetUnhandled ?? []
  ));
  expect(evidence.consoleErrors, `console errors: ${evidence.consoleErrors.join('\n')}`).toEqual([]);
  expect(evidence.pageErrors, `page errors: ${evidence.pageErrors.join('\n')}`).toEqual([]);
  expect(evidence.requestFailures, `request failures: ${evidence.requestFailures.join('\n')}`).toEqual([]);
  expect(evidence.httpErrors, `HTTP errors: ${evidence.httpErrors.join('\n')}`).toEqual([]);
  expect(evidence.orderRequests, `order requests: ${evidence.orderRequests.join('\n')}`).toEqual([]);
  expect(unhandled, `unhandled rejections: ${unhandled.join('\n')}`).toEqual([]);
}

test('timeframe, symbol, and market changes reset detail, overlay, and timeline to one current context', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const evidence = await monitorBrowser(page);
  const mock = await installMocks(page);
  await openChart(page);

  const initialOverlay = page.getByTestId('chart-pattern-overlay');
  await expect(initialOverlay).toHaveCount(1);
  await expect(initialOverlay).toHaveAttribute('data-pattern-type', 'double-top');
  const firstAnalysisId = await initialOverlay.getAttribute('data-analysis-id');
  expect(firstAnalysisId).toBeTruthy();
  await expect(timeline(page)).toContainText('최근 1건');
  await expect(timeline(page)).toContainText('이중천장');

  const firstPastTime = await selectPastCandle(page);
  expect(firstPastTime).toBeGreaterThanOrEqual(BASE_TIME);
  expect(firstPastTime).toBeLessThan(BASE_TIME + (DOUBLE_TOP.length - 1) * STEP_SECONDS);

  await page.getByTestId('timeframe-1m').click();
  await expect(page).toHaveURL(/timeframe=1m/);
  await expect.poll(mock.oneMinuteCalls).toBe(1);
  await expect(page.getByTestId('selected-candle-detail')).toHaveCount(0);
  await expect(page.getByTestId('chart-pattern-overlay')).toHaveCount(0);
  await expect(timeline(page)).toContainText('최근 0건');
  await expect(currentAnalysis(page)).toContainText('실제 캔들이 준비되면');

  await page.getByTestId('timeframe-15m').click();
  await expect(page).toHaveURL(/timeframe=15m/);
  await expect(page.getByText('context-reset-kr-15m', { exact: false })).toBeVisible();
  await expectLatestCandle(page, BASE_TIME + 23 * STEP_SECONDS);
  await expect(page.getByTestId('chart-pattern-overlay')).toHaveCount(0);
  await expect(timeline(page)).toContainText('최근 1건');
  await expect(timeline(page)).not.toContainText('이중천장');
  await expect(currentAnalysis(page)).not.toContainText('실제 캔들이 준비되면');
  const currentPrice = page.getByText('현재가', { exact: true }).locator('xpath=../..');
  await expect(currentPrice).toContainText('20,023원');

  await page.waitForTimeout(1_050);
  await expect(page).toHaveURL(/timeframe=15m/);
  await expect(currentPrice).toContainText('20,023원');
  await expectLatestCandle(page, BASE_TIME + 23 * STEP_SECONDS);
  await expect(timeline(page)).toContainText('최근 1건');

  const secondPastTime = await selectPastCandle(page);
  expect(secondPastTime).toBeGreaterThanOrEqual(BASE_TIME);
  const symbolInput = page.getByLabel('차트 종목 심볼');
  await symbolInput.fill('000660');
  await page.getByTestId('apply-chart-symbol').click();
  await expect(page).toHaveURL(/ticker=000660/);
  await expect(page.getByText('context-reset-kr-000660', { exact: false })).toBeVisible();
  await expectLatestCandle(page, BASE_TIME + (DOUBLE_TOP.length - 1) * STEP_SECONDS);
  const secondOverlay = page.getByTestId('chart-pattern-overlay');
  await expect(secondOverlay).toHaveCount(1);
  await expect(secondOverlay).toHaveAttribute('data-pattern-type', 'double-top');
  const secondAnalysisId = await secondOverlay.getAttribute('data-analysis-id');
  expect(secondAnalysisId).toBeTruthy();
  expect(secondAnalysisId).not.toBe(firstAnalysisId);
  await expect(timeline(page)).toContainText('최근 1건');
  await expect(timeline(page)).toContainText('이중천장');

  const thirdPastTime = await selectPastCandle(page);
  expect(thirdPastTime).toBeGreaterThanOrEqual(BASE_TIME);
  await page.getByTestId('market-US').click();
  await expect(page).toHaveURL(/market=US/);
  await expect(page).toHaveURL(/ticker=AAPL/);
  await expect(page.getByText('context-reset-us-aapl', { exact: false })).toBeVisible();
  await expectLatestCandle(page, BASE_TIME + 23 * STEP_SECONDS);
  await expect(page.getByTestId('chart-pattern-overlay')).toHaveCount(0);
  await expect(timeline(page)).toContainText('최근 1건');
  await expect(timeline(page)).not.toContainText('이중천장');
  await expect(page.getByText('현재가', { exact: true }).locator('xpath=../..')).toContainText('$523.00');
  await expect(page.locator('section').filter({ hasText: '현재 차트 컨텍스트' }).last()).toContainText('AAPL · US · 15m');

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await expectNoBrowserErrors(page, evidence);
});
