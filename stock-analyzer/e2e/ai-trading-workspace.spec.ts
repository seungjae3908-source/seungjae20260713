import { test, expect, type BrowserContext, type Page, type Route } from '@playwright/test';

const candles = Array.from({ length: 40 }, (_, index) => ({
  time: new Date(Date.UTC(2026, 6, 1, 0, index * 5)).toISOString(),
  open: 70_000 + index * 10,
  high: 70_100 + index * 10,
  low: 69_900 + index * 10,
  close: 70_050 + index * 10,
  volume: 1_000 + index * 20,
  isClosed: index < 39,
}));

const orderbook = {
  ok: true,
  available: true,
  status: 'ready',
  market: 'KR',
  exchange: 'KRX',
  ticker: '005930',
  currency: 'KRW',
  provider: 'kiwoom',
  source: 'ka10004',
  sourceTimestampRaw: '20260805',
  updatedAt: null,
  receivedAt: '2026-08-05T03:30:10.000Z',
  freshness: 'unknown',
  stale: true,
  asks: [
    { rank: 1, price: 70_100, quantity: 120, cumulativeQuantity: 120 },
    { rank: 2, price: 70_200, quantity: 80, cumulativeQuantity: 200 },
  ],
  bids: [
    { rank: 1, price: 70_000, quantity: 150, cumulativeQuantity: 150 },
    { rank: 2, price: 69_900, quantity: 100, cumulativeQuantity: 250 },
  ],
  bestAsk: 70_100,
  bestBid: 70_000,
  spread: 100,
  spreadPercent: 0.14275517487508923,
  displayedAskQuantity: 200,
  displayedBidQuantity: 250,
  totalAskQuantity: 1_200,
  totalBidQuantity: 1_500,
  imbalance: 0.1111111111111111,
  warnings: ['공급자 응답에서 초 단위 갱신 시각을 확인할 수 없어 최신성을 보장하지 않습니다.'],
  reason: null,
  orderSubmitted: false,
  exchangeRequestSent: false,
};

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function mockWorkspace(context: BrowserContext) {
  await context.route('**/api/**', (route) => fulfillJson(route, {}));
  await context.route('**/api/stocks/*/chart**', (route) => {
    const url = new URL(route.request().url());
    return fulfillJson(route, {
      ticker: url.pathname.includes('000660') ? '000660' : '005930',
      timeframe: url.searchParams.get('timeframe') ?? '5m',
      provider: 'fixture',
      fetchedAt: '2026-08-05T03:00:00Z',
      candles,
    });
  });
  await context.route('**/api/quotes**', (route) => fulfillJson(route, {
    quotes: [{ ticker: '^KS11', changePercent: 0.4 }],
  }));
  await context.route('**/api/stocks/*/orderbook**', (route) => fulfillJson(route, orderbook));
}

type SafetyProbe = {
  consoleErrors: string[];
  pageErrors: string[];
  requestFailures: string[];
  unexpectedHttp: string[];
  apiWrites: string[];
  privateRequests: string[];
};

function installSafetyProbe(context: BrowserContext, initialPage: Page): SafetyProbe {
  const probe: SafetyProbe = {
    consoleErrors: [],
    pageErrors: [],
    requestFailures: [],
    unexpectedHttp: [],
    apiWrites: [],
    privateRequests: [],
  };
  const watched = new WeakSet<Page>();
  const watchPage = (page: Page) => {
    if (watched.has(page)) return;
    watched.add(page);
    page.on('console', (message) => {
      if (message.type() === 'error') probe.consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => probe.pageErrors.push(error.message));
    page.on('requestfailed', (request) => {
      const url = new URL(request.url());
      if (!request.failure()?.errorText.toLowerCase().includes('aborted')) {
        probe.requestFailures.push(`${request.method()} ${url.pathname}`);
      }
    });
  };
  watchPage(initialPage);
  context.on('page', watchPage);
  context.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(request.method())) {
      probe.apiWrites.push(`${request.method()} ${url.pathname}`);
    }
    if (
      /\/(?:account|accounts|positions|orders?|auto)(?:\/|$)/.test(url.pathname)
      || url.pathname.startsWith('/api/kiwoom/')
    ) probe.privateRequests.push(url.pathname);
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
  expect(probe.requestFailures).toEqual([]);
  expect(probe.unexpectedHttp).toEqual([]);
  expect(probe.apiWrites).toEqual([]);
  expect(probe.privateRequests).toEqual([]);
}

test('mobile opens workspace in the same tab, reads orderbook, and keeps mock orders local', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockWorkspace(context);
  const probe = installSafetyProbe(context, page);

  await page.goto('/ai-chart?asset=stock&market=KR&ticker=005930&symbol=005930&name=%EC%82%BC%EC%84%B1%EC%A0%84%EC%9E%90&timeframe=5m');
  await expect(page.getByRole('heading', { name: 'AI 차트 생중계', level: 1 })).toBeVisible();
  await page.getByTestId('open-ai-trading-workspace').click();

  await expect(page).toHaveURL(/\/trading-workspace\?/);
  await expect(page.getByRole('heading', { name: 'AI 매매 워크스페이스' })).toBeVisible();
  await expect(page.getByText('005930 · KR · 5m', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '호가창' }).click();
  const dialog = page.getByRole('dialog', { name: /005930 호가창/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('키움 ka10004')).toBeVisible();
  await expect(dialog.getByTestId('ask-level-1')).toContainText('70,100');
  await expect(dialog.getByTestId('bid-level-1')).toContainText('70,000');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  await page.getByLabel('모의주문 수량').fill('2');
  await page.getByLabel('모의주문 가격').fill('70000');
  await page.getByLabel('모의주문 가격').press('Enter');
  await expect(page.getByText('2차 확인 대기', { exact: true })).toBeVisible();
  await page.getByLabel('모의주문 가격').press('Enter');
  await expect(page.getByText('pending', { exact: true })).toBeVisible();
  await expect(page.getByText('삼성전자 · 매수', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'pending 취소' }).click();
  await expect(page.getByText('cancelled', { exact: true })).toBeVisible();

  expect(await page.evaluate(() =>
    document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  )).toBe(true);

  await page.getByRole('button', { name: 'AI 차트 분석기로 돌아가기' }).click();
  await expect(page).toHaveURL(/\/ai-chart\?/);
  await expect(page.getByRole('heading', { name: 'AI 차트 생중계', level: 1 })).toBeVisible();
  expectSafe(probe);
});

test('desktop opens an isolated popup with a fixed read-only orderbook panel', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mockWorkspace(context);
  const probe = installSafetyProbe(context, page);

  await page.goto('/ai-chart?asset=stock&market=KR&ticker=005930&symbol=005930&name=%EC%82%BC%EC%84%B1%EC%A0%84%EC%9E%90&timeframe=5m');
  const popupPromise = page.waitForEvent('popup');
  await page.getByTestId('open-ai-trading-workspace').click();
  const popup = await popupPromise;

  await expect(page).toHaveURL(/\/ai-chart/);
  await expect(popup).toHaveURL(/\/trading-workspace\?/);
  await expect(popup.getByRole('heading', { name: 'AI 매매 워크스페이스' })).toBeVisible();
  const orderbookPanel = popup.getByTestId('instrument-orderbook-panel');
  await expect(orderbookPanel).toBeVisible();
  await expect(orderbookPanel.getByText('키움 ka10004')).toBeVisible();
  await expect(orderbookPanel.getByTestId('ask-level-1')).toContainText('70,100');
  await expect(popup.getByRole('button', { name: '호가창' })).toHaveCount(0);
  expect(await popup.evaluate(() => window.opener === null)).toBe(true);
  expect(await popup.evaluate(() =>
    document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  )).toBe(true);

  await popup.close();
  expectSafe(probe);
});
