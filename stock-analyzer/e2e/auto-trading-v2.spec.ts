import { test, expect, type Page } from '@playwright/test';

function captureBrowserFailures(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const httpErrors: string[] = [];
  const requestFailures: string[] = [];
  const executionMutationRequests: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => {
    if (/\/api\/trade-automation\/v2\/tick(?:\?|$)/.test(request.url())) {
      executionMutationRequests.push(`${request.method()} ${request.url()}`);
    }
  });
  page.on('response', (response) => {
    if (response.url().includes('/api/') && response.status() >= 400) {
      httpErrors.push(`${response.status()} ${response.url()}`);
    }
  });
  page.on('requestfailed', (request) => {
    if (request.url().includes('/api/')) requestFailures.push(`${request.failure()?.errorText ?? 'failed'} ${request.url()}`);
  });
  return { consoleErrors, pageErrors, httpErrors, requestFailures, executionMutationRequests };
}

function expectNoBrowserFailures(failures: ReturnType<typeof captureBrowserFailures>) {
  expect(failures.consoleErrors).toEqual([]);
  expect(failures.pageErrors).toEqual([]);
  expect(failures.httpErrors).toEqual([]);
  expect(failures.requestFailures).toEqual([]);
  expect(failures.executionMutationRequests).toEqual([]);
}

async function mockUserIntegrationsApi(page: Page) {
  await page.route(/\/api\/user-integrations(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        brokerConnections: [],
        telegram: { connected: false, status: 'DISCONNECTED', connectedAt: null },
        preferences: {},
      }),
    });
  });
}

async function verifyCoreSurface(page: Page) {
  await expect(page.getByTestId('auto-trading-v2-panel')).toBeVisible();
  await expect(page.getByText('Auto Trading 2.0 · Crypto Futures')).toBeVisible();
  await expect(page.getByTestId('auto-trading-v2-live-lock')).toContainText('실거래는 현재 비활성화되어 있습니다.');
  await expect(page.getByTestId('auto-trading-v2-live-lock')).toContainText('Real Order 0 · Real Cancel 0 · Private Trading API 0');

  await expect(page.getByTestId('auto-trading-v2-mode-off')).toBeVisible();
  await expect(page.getByTestId('auto-trading-v2-mode-paper')).toBeVisible();
  await expect(page.getByTestId('auto-trading-v2-mode-shadow')).toBeVisible();
  await expect(page.getByTestId('auto-trading-v2-mode-live')).toBeVisible();
  await expect(page.getByTestId('auto-trading-v2-mode-live')).toBeDisabled();

  for (const symbol of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT']) {
    await expect(page.getByTestId(`auto-trading-v2-symbol-${symbol}`)).toBeVisible();
  }

  await expect(page.getByTestId('auto-trading-v2-symbol-BTCUSDT')).toContainText('LONG');
  await expect(page.getByTestId('auto-trading-v2-symbol-BTCUSDT')).toContainText('PROTECTED');
  await expect(page.getByTestId('auto-trading-v2-symbol-BTCUSDT')).toContainText('청산가 시뮬레이션');
  await expect(page.getByTestId('auto-trading-v2-symbol-BTCUSDT')).toContainText('SIMULATION_ONLY_NOT_EXCHANGE_EXACT');
  await expect(page.getByTestId('auto-trading-v2-symbol-SOLUSDT')).toContainText('BLOCK');
  await expect(page.getByText('PARAMETER_STABILITY')).toBeVisible();
  await expect(page.getByText('Closed candle only')).toBeVisible();
  await expect(page.getByText('REAL ORDER', { exact: true })).toBeVisible();
  await expect(page.getByText('REAL CANCEL', { exact: true })).toBeVisible();
  await expect(page.getByText('PRIVATE TRADING API', { exact: true })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await mockUserIntegrationsApi(page);
});

test('Auto Trading 2.0 desktop surface shows Paper/Shadow and hard-locks LIVE', async ({ page }) => {
  const failures = captureBrowserFailures(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/__phase12-trade-automation-e2e');
  await verifyCoreSurface(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expectNoBrowserFailures(failures);
});

for (const width of [360, 390, 412]) {
  test(`Auto Trading 2.0 fits ${width}px mobile with LIVE locked`, async ({ page }) => {
    const failures = captureBrowserFailures(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/__phase12-trade-automation-e2e');
    await verifyCoreSurface(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expectNoBrowserFailures(failures);
  });
}
