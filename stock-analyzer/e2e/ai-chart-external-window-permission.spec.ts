import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const initialUrl = '/ai-chart?assetType=stock&market=KR&symbol=005930&ticker=005930&name=%EC%82%BC%EC%84%B1%EC%A0%84%EC%9E%90&timeframe=5m';

type RuntimeErrors = {
  console: string[];
  page: string[];
  unhandled: string[];
  unexpectedHttp: string[];
  mutations: string[];
  orderRequests: string[];
  accountPositionRequests: string[];
};

async function installUnhandledCapture(context: BrowserContext) {
  await context.addInitScript(() => {
    const state = globalThis as typeof globalThis & { __chartPermissionUnhandled?: string[] };
    state.__chartPermissionUnhandled = [];
    globalThis.addEventListener('unhandledrejection', (event) => {
      state.__chartPermissionUnhandled?.push(String(event.reason));
    });
  });
}

function observe(context: BrowserContext, firstPage: Page): RuntimeErrors & { pages: Page[] } {
  const runtime: RuntimeErrors & { pages: Page[] } = {
    console: [],
    page: [],
    unhandled: [],
    unexpectedHttp: [],
    mutations: [],
    orderRequests: [],
    accountPositionRequests: [],
    pages: [firstPage],
  };
  const attach = (page: Page) => {
    if (!runtime.pages.includes(page)) runtime.pages.push(page);
    page.on('console', (message) => {
      if (message.type() === 'error') runtime.console.push(message.text());
    });
    page.on('pageerror', (error) => runtime.page.push(error.message));
  };
  attach(firstPage);
  context.on('page', attach);
  context.on('response', (response) => {
    const status = response.status();
    const pathname = new URL(response.url()).pathname;
    const expected = (status === 401 && pathname.startsWith('/api/stocks/'))
      || (status === 403 && pathname === '/api/quotes');
    if (status >= 400 && !expected) runtime.unexpectedHttp.push(`${status} ${response.url()}`);
  });
  context.on('request', (request) => {
    const url = request.url();
    if (request.method() !== 'GET' && /\/api\//i.test(url)) runtime.mutations.push(`${request.method()} ${url}`);
    if (/\/(orders?|cancel|auto-trad|trade-automation)(?:\/|\?|$)/i.test(url)) {
      runtime.orderRequests.push(`${request.method()} ${url}`);
    }
    if (/\/(accounts?|positions?)(?:\/|\?|$)/i.test(url)) {
      runtime.accountPositionRequests.push(`${request.method()} ${url}`);
    }
  });
  return runtime;
}

async function assertClean(runtime: RuntimeErrors & { pages: Page[] }) {
  for (const page of runtime.pages) {
    if (page.isClosed()) continue;
    runtime.unhandled.push(...await page.evaluate(() => {
      const state = globalThis as typeof globalThis & { __chartPermissionUnhandled?: string[] };
      return state.__chartPermissionUnhandled ?? [];
    }));
  }
  expect(runtime.console).toEqual([]);
  expect(runtime.page).toEqual([]);
  expect(runtime.unhandled).toEqual([]);
  expect(runtime.unexpectedHttp).toEqual([]);
  expect(runtime.mutations).toEqual([]);
  expect(runtime.orderRequests).toEqual([]);
  expect(runtime.accountPositionRequests).toEqual([]);
}

test('main and external chart windows fail closed on expired authentication or insufficient permission', async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installUnhandledCapture(context);
  await context.route('**/api/stocks/**', (route) => route.fulfill({
    status: 401,
    contentType: 'application/json',
    body: JSON.stringify({ message: '로그인이 만료되었습니다.' }),
  }));
  await context.route('**/api/quotes**', (route) => route.fulfill({
    status: 403,
    contentType: 'application/json',
    body: JSON.stringify({ message: '차트 조회 권한이 없습니다.' }),
  }));
  const runtime = observe(context, page);

  await page.goto(initialUrl);
  await expect(page.getByText('차트 데이터를 불러오지 못했습니다.', { exact: true })).toBeVisible();
  await expect(page.getByText('로그인이 만료되었습니다.', { exact: true })).toBeVisible();

  const popupPromise = context.waitForEvent('page');
  await page.getByTestId('open-external-ai-chart').click();
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded');
  await expect(popup.getByText('외부 AI 차트', { exact: true })).toBeVisible();
  await expect(popup.getByText('차트 데이터를 불러오지 못했습니다.', { exact: true })).toBeVisible();
  await expect(popup.getByText('로그인이 만료되었습니다.', { exact: true })).toBeVisible();
  await popup.close();

  await assertClean(runtime);
});
