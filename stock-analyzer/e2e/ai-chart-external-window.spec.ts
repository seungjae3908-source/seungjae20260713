import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const candles = Array.from({ length: 48 }, (_, index) => ({
  time: new Date(Date.UTC(2026, 7, 4, 0, index * 5)).toISOString(),
  open: 70000 + index * 20,
  high: 70120 + index * 20,
  low: 69920 + index * 20,
  close: 70060 + index * 20,
  volume: 1000 + index * 10,
  isClosed: index < 47,
}));

async function mockChartApis(context: BrowserContext) {
  await context.route('**/api/stocks/*/chart**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ticker: '005930',
      timeframe: new URL(route.request().url()).searchParams.get('tf') ?? '5m',
      provider: 'external-window-fixture',
      fetchedAt: '2026-08-04T15:00:00.000Z',
      updatedAt: '2026-08-04T15:00:00.000Z',
      candles,
    }),
  }));
  await context.route('**/api/quotes**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ quotes: [{ ticker: '^KS11', changePercent: 0.4 }] }),
  }));
}

function observeRuntime(context: BrowserContext, pages: Page[]) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const unexpectedHttp: string[] = [];
  const forbiddenRequests: string[] = [];
  const orderLike = /\/(orders?|cancel|accounts?|positions?|auto-trad|trade-automation)(?:\/|\?|$)/i;

  context.on('page', (opened) => {
    pages.push(opened);
    opened.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    opened.on('pageerror', (error) => pageErrors.push(error.message));
  });
  context.on('response', (response) => {
    if (response.status() >= 400) unexpectedHttp.push(`${response.status()} ${response.url()}`);
  });
  context.on('request', (request) => {
    if (request.method() !== 'GET' && orderLike.test(request.url())) {
      forbiddenRequests.push(`${request.method()} ${request.url()}`);
    }
  });

  return { consoleErrors, pageErrors, unexpectedHttp, forbiddenRequests };
}

const initialUrl = '/ai-chart?assetType=stock&market=KR&symbol=005930&ticker=005930&name=%EC%82%BC%EC%84%B1%EC%A0%84%EC%9E%90&timeframe=5m';

test('desktop AI chart opens one synchronized external window and cleans it up', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockChartApis(context);
  const pages = [page];
  const runtime = observeRuntime(context, pages);
  page.on('console', (message) => {
    if (message.type() === 'error') runtime.consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => runtime.pageErrors.push(error.message));

  await page.goto(initialUrl);
  await expect(page.getByRole('heading', { name: 'AI 차트 분석기', exact: true })).toBeVisible();
  const externalButton = page.getByRole('button', { name: '외부 창', exact: true });
  await expect(externalButton).toBeVisible();

  const popupPromise = context.waitForEvent('page');
  await externalButton.click();
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded');
  await expect(popup).toHaveURL(/chartWindow=external/);
  await expect(popup.getByRole('heading', { name: 'AI 차트 분석기 · 외부 창', exact: true })).toBeVisible();
  await expect(popup.getByRole('button', { name: '외부 창', exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: '15분', exact: true }).click();
  await expect(popup).toHaveURL(/timeframe=15m/);
  await popup.getByRole('button', { name: '30분', exact: true }).click();
  await expect(page).toHaveURL(/timeframe=30m/);

  const pageCount = context.pages().length;
  await externalButton.click();
  await expect.poll(() => context.pages().length).toBe(pageCount);
  await expect(page.getByRole('status')).toContainText('이미 열린 외부 차트 창');

  await popup.close();
  await expect(page.getByRole('status')).toContainText('외부 차트 창이 닫혔습니다.');

  expect(runtime.consoleErrors).toEqual([]);
  expect(runtime.pageErrors).toEqual([]);
  expect(runtime.unexpectedHttp).toEqual([]);
  expect(runtime.forbiddenRequests).toEqual([]);
});

test('mobile AI chart does not render the external-window control', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockChartApis(context);
  await page.goto(initialUrl);
  await expect(page.getByRole('heading', { name: 'AI 차트 분석기', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '외부 창', exact: true })).toHaveCount(0);
});

test('popup blocking is reported without creating a second chart context', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockChartApis(context);
  await page.addInitScript(() => {
    window.open = () => null;
  });
  await page.goto(initialUrl);
  await page.getByRole('button', { name: '외부 창', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('팝업이 차단되었습니다.');
  expect(context.pages()).toHaveLength(1);
});
