import { test, expect, type Page } from '@playwright/test';

function captureBrowserFailures(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const httpErrors: string[] = [];
  const requestFailures: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('response', (response) => {
    if (response.url().includes('/api/') && response.status() >= 400) {
      httpErrors.push(`${response.status()} ${response.url()}`);
    }
  });
  page.on('requestfailed', (request) => {
    if (request.url().includes('/api/')) requestFailures.push(`${request.failure()?.errorText ?? 'failed'} ${request.url()}`);
  });
  return { consoleErrors, pageErrors, httpErrors, requestFailures };
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

test.beforeEach(async ({ page }) => {
  await mockUserIntegrationsApi(page);
});

function expectNoBrowserFailures(failures: ReturnType<typeof captureBrowserFailures>) {
  expect(failures.consoleErrors).toEqual([]);
  expect(failures.pageErrors).toEqual([]);
  expect(failures.httpErrors).toEqual([]);
  expect(failures.requestFailures).toEqual([]);
}

for (const width of [360, 390, 430]) {
  test(`four-market automatic controls fit ${width}px mobile without approval queue`, async ({ page }) => {
    const failures = captureBrowserFailures(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/__phase12-trade-automation-e2e');

    await expect(page.getByRole('heading', { name: '자동매매', level: 1 })).toBeVisible();
    const safetySummary = page.getByTestId('auto-trading-safety-summary');
    await expect(safetySummary).toContainText('주문별 승인');
    await expect(safetySummary).toContainText('불필요');
    await expect(safetySummary).toContainText('4시장 개별 ON/OFF');
    await expect(page.getByTestId('trade-approval-queue')).toHaveCount(0);

    await expect(page.getByTestId('automatic-trading-master-toggle')).toHaveAttribute('aria-pressed', 'false');
    for (const market of ['domestic_stock', 'us_stock', 'crypto_spot', 'crypto_futures']) {
      await expect(page.getByTestId(`auto-market-${market}`)).toHaveAttribute('aria-pressed', 'true');
    }

    await expect(page.getByTestId('auto-market-domestic_stock')).toContainText('국내주식');
    await expect(page.getByTestId('auto-market-us_stock')).toContainText('미국주식');
    await expect(page.getByTestId('auto-market-crypto_spot')).toContainText('코인현물');
    await expect(page.getByTestId('auto-market-crypto_futures')).toContainText('코인선물');
    await expect(page.getByTestId('auto-trading-runtime-summary')).toContainText('미국주식');
    await expect(page.getByTestId('auto-trading-runtime-summary')).toContainText('미국주식 실전 자동주문은 검증된 주문 어댑터가 연결되기 전까지 차단됩니다.');

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expectNoBrowserFailures(failures);
  });
}

test('automatic trading is standing authorization with independent market switches and one emergency stop', async ({ page }) => {
  const failures = captureBrowserFailures(page);
  await page.goto('/__phase12-trade-automation-e2e');

  const master = page.getByTestId('automatic-trading-master-toggle');
  await master.click();
  await expect(master).toHaveAttribute('aria-pressed', 'true');

  const us = page.getByTestId('auto-market-us_stock');
  await us.click();
  await expect(us).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('auto-market-domestic_stock')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('auto-market-crypto_spot')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('auto-market-crypto_futures')).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: '설정 저장' }).click();
  const dialog = page.getByRole('dialog', { name: '자동매매 설정 확인' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('주문마다 묻는 승인이 아닙니다.');
  await expect(dialog).toContainText('국내주식, 코인현물, 코인선물');
  await expect(dialog).not.toContainText('국내주식, 미국주식, 코인현물, 코인선물');
  await expect(dialog).toContainText('미국주식');
  await expect(dialog).toContainText('실전 주문은 어댑터 연결 전까지 차단');
  await dialog.getByRole('button', { name: '설정 적용' }).click();
  await expect(page.getByRole('status')).toContainText('테스트 설정이 저장되었습니다.');

  await page.getByRole('button', { name: '긴급정지' }).click();
  await expect(page.getByRole('status')).toContainText('4시장 신규 주문이 모두 차단');
  await expect(master).toHaveAttribute('aria-pressed', 'false');
  for (const market of ['domestic_stock', 'us_stock', 'crypto_spot', 'crypto_futures']) {
    await expect(page.getByTestId(`auto-market-${market}`)).toHaveAttribute('aria-pressed', 'false');
  }
  expectNoBrowserFailures(failures);
});

test('automatic trading surface never exposes per-order approval actions', async ({ page }) => {
  const approvalRequests: string[] = [];
  page.on('request', (request) => {
    if (/\/api\/trade-automation\/plans\/[^/]+\/(approve|approval-status)/u.test(new URL(request.url()).pathname)) {
      approvalRequests.push(`${request.method()} ${request.url()}`);
    }
  });

  await page.goto('/__phase12-trade-automation-e2e');
  await expect(page.getByText('승인형 주문', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /승인/ })).toHaveCount(0);
  await page.getByTestId('automatic-trading-master-toggle').click();
  await page.getByRole('button', { name: '설정 저장' }).click();
  await page.getByRole('dialog', { name: '자동매매 설정 확인' }).getByRole('button', { name: '설정 적용' }).click();
  expect(approvalRequests).toEqual([]);
});
