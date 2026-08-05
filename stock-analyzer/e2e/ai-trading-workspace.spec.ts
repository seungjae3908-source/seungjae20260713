import { test, expect, type BrowserContext, type Page } from '@playwright/test';

const candles = Array.from({ length: 40 }, (_, index) => ({
  time: new Date(Date.UTC(2026, 6, 1, 0, index * 5)).toISOString(),
  open: 70_000 + index * 10,
  high: 70_100 + index * 10,
  low: 69_900 + index * 10,
  close: 70_050 + index * 10,
  volume: 1_000 + index * 20,
  isClosed: index < 39,
}));

async function mockWorkspace(context: BrowserContext) {
  await context.route('**/api/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: '{}',
  }));
  await context.route('**/api/stocks/*/chart**', (route) => {
    const url = new URL(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ticker: url.pathname.includes('000660') ? '000660' : '005930',
        timeframe: url.searchParams.get('timeframe') ?? '5m',
        provider: 'fixture',
        fetchedAt: '2026-08-05T03:00:00Z',
        candles,
      }),
    });
  });
  await context.route('**/api/quotes**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ quotes: [{ ticker: '^KS11', changePercent: 0.4 }] }),
  }));
}

type SafetyProbe = {
  consoleErrors: string[];
  pageErrors: string[];
  unexpectedHttp: string[];
  apiWrites: string[];
};

function installSafetyProbe(context: BrowserContext, initialPage: Page): SafetyProbe {
  const probe: SafetyProbe = {
    consoleErrors: [],
    pageErrors: [],
    unexpectedHttp: [],
    apiWrites: [],
  };
  const watched = new WeakSet<Page>();
  const watchPage = (page: Page) => {
    if (watched.has(page)) return;
    watched.add(page);
    page.on('console', (message) => {
      if (message.type() === 'error') probe.consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => probe.pageErrors.push(error.message));
  };
  watchPage(initialPage);
  context.on('page', watchPage);
  context.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(request.method())) {
      probe.apiWrites.push(`${request.method()} ${url.pathname}`);
    }
  });
  context.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/') && response.status() >= 400) {
      probe.unexpectedHttp.push(`${response.status()} ${url.pathname}`);
    }
  });
  return probe;
}

function expectSafe(probe: SafetyProbe) {
  expect(probe.consoleErrors).toEqual([]);
  expect(probe.pageErrors).toEqual([]);
  expect(probe.unexpectedHttp).toEqual([]);
  expect(probe.apiWrites).toEqual([]);
}

test('mobile opens the trading workspace in the same tab and keeps mock orders local', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockWorkspace(context);
  const probe = installSafetyProbe(context, page);

  await page.goto('/ai-chart');
  await expect(page.getByRole('heading', { name: 'AI 차트 분석기' })).toBeVisible();
  await page.getByTestId('open-ai-trading-workspace').click();

  await expect(page).toHaveURL(/\/trading-workspace\?/);
  await expect(page.getByRole('heading', { name: 'AI 매매 워크스페이스' })).toBeVisible();
  await expect(page.getByText('005930 · KR · 5m', { exact: true })).toBeVisible();

  await page.getByLabel('모의주문 수량').fill('2');
  await page.getByLabel('모의주문 가격').fill('70000');
  await page.getByLabel('모의주문 가격').press('Enter');
  await expect(page.getByText('2차 확인 대기', { exact: true })).toBeVisible();

  await page.getByLabel('모의주문 가격').press('Enter');
  await expect(page.getByText('pending', { exact: true })).toBeVisible();
  await expect(page.getByText('삼성전자 · 매수', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'pending 취소' }).click();
  await expect(page.getByText('cancelled', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'pending 취소' })).toHaveCount(0);

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await page.getByRole('button', { name: 'AI 차트 분석기로 돌아가기' }).click();
  await expect(page).toHaveURL(/\/ai-chart\?/);
  await expect(page.getByRole('heading', { name: 'AI 차트 분석기' })).toBeVisible();
  expectSafe(probe);
});

test('desktop opens an isolated popup and preserves the selected stock context', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mockWorkspace(context);
  const probe = installSafetyProbe(context, page);

  await page.goto('/ai-chart');
  const popupPromise = page.waitForEvent('popup');
  await page.getByTestId('open-ai-trading-workspace').click();
  const popup = await popupPromise;

  await expect(page).toHaveURL(/\/ai-chart/);
  await expect(popup).toHaveURL(/\/trading-workspace\?/);
  await expect(popup.getByRole('heading', { name: 'AI 매매 워크스페이스' })).toBeVisible();
  await expect(popup.getByText('005930 · KR · 5m', { exact: true })).toBeVisible();
  expect(await popup.evaluate(() => window.opener === null)).toBe(true);
  expect(await popup.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await popup.close();
  expectSafe(probe);
});
