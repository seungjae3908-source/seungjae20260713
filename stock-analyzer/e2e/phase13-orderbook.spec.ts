import { expect, test, type Page, type Route } from '@playwright/test';

const receivedAt = '2026-08-05T03:30:10.000Z';

function readyPayload(overrides: Record<string, unknown> = {}) {
  return {
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
    receivedAt,
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
    warnings: [
      '공급자 응답에서 초 단위 갱신 시각을 확인할 수 없어 최신성을 보장하지 않습니다.',
    ],
    reason: null,
    orderSubmitted: false,
    exchangeRequestSent: false,
    ...overrides,
  };
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

function captureFailures(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  const unexpectedHttpErrors: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => {
    requestFailures.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      const request = response.request();
      unexpectedHttpErrors.push(
        `${response.status()} ${request.method()} ${new URL(response.url()).pathname}`,
      );
    }
  });

  return {
    consoleErrors,
    pageErrors,
    requestFailures,
    unexpectedHttpErrors,
  };
}

async function mockOrderbook(
  page: Page,
  payload: unknown,
) {
  const requests: string[] = [];
  const mutationRequests: string[] = [];
  const privateRequests: string[] = [];

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push(`${request.method()} ${url.pathname}${url.search}`);

    if (request.method() !== 'GET') {
      mutationRequests.push(`${request.method()} ${url.pathname}`);
    }

    if (
      /\/(?:account|accounts|positions|orders?|auto)(?:\/|$)/.test(url.pathname)
      || url.pathname.startsWith('/api/kiwoom/')
    ) {
      privateRequests.push(url.pathname);
      return fulfillJson(route, {
        ok: false,
        error: 'PRIVATE_OR_RAW_PROVIDER_ROUTE_MUST_NOT_BE_CALLED',
      }, 500);
    }

    if (/\/api\/stocks\/[^/]+\/orderbook$/.test(url.pathname)) {
      return fulfillJson(route, payload);
    }

    return fulfillJson(route, {
      ok: false,
      error: 'UNEXPECTED_ROUTE',
    }, 404);
  });

  return {
    requests,
    mutationRequests,
    privateRequests,
  };
}

for (const width of [360, 390, 430]) {
  test(`KR stock orderbook stays usable and read-only on ${width}px mobile`, async ({ page }) => {
    const failures = captureFailures(page);
    const requests = await mockOrderbook(page, readyPayload());

    await page.setViewportSize({ width, height: 844 });
    await page.goto('/__phase13-orderbook-e2e?ticker=005930&market=KR');

    const dialog = page.getByRole('dialog', { name: /005930 호가창/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('읽기 전용')).toBeVisible();
    await expect(dialog.getByText('키움 ka10004')).toBeVisible();
    await expect(dialog.getByText('공급자 최신성 확인 불가')).toBeVisible();
    await expect(dialog.getByTestId('ask-level-1')).toContainText('70,100');
    await expect(dialog.getByTestId('bid-level-1')).toContainText('70,000');
    await expect(dialog.getByText('100', { exact: true }).first()).toBeVisible();
    await expect(dialog.getByRole('button', { name: /매수|매도/ })).toHaveCount(0);
    await expect(dialog.getByText(/주문·취소·계좌 API를 호출하지 않습니다/)).toBeVisible();

    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: '호가창' })).toBeFocused();

    expect(requests.requests.some((request) =>
      request.startsWith('GET /api/stocks/005930/orderbook?market=KR'),
    )).toBe(true);
    expect(requests.mutationRequests).toEqual([]);
    expect(requests.privateRequests).toEqual([]);
    expect(failures.consoleErrors).toEqual([]);
    expect(failures.pageErrors).toEqual([]);
    expect(failures.requestFailures).toEqual([]);
    expect(failures.unexpectedHttpErrors).toEqual([]);
  });
}

test('desktop renders one-sided depth only as partial data', async ({ page }) => {
  const failures = captureFailures(page);
  const requests = await mockOrderbook(
    page,
    readyPayload({
      status: 'partial',
      asks: [],
      bestAsk: null,
      spread: null,
      spreadPercent: null,
      displayedAskQuantity: 0,
      warnings: [
        '매도 또는 매수 한쪽 호가가 비어 있어 부분 데이터로 표시합니다.',
      ],
    }),
  );

  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto('/__phase13-orderbook-e2e?ticker=005930&market=KR');

  const dialog = page.getByRole('dialog', { name: /005930 호가창/ });
  await expect(dialog.getByText(/부분 데이터로 표시합니다/)).toBeVisible();
  await expect(dialog.getByLabel('매도 호가')).toBeEmpty();
  await expect(dialog.getByTestId('bid-level-1')).toBeVisible();

  expect(requests.mutationRequests).toEqual([]);
  expect(requests.privateRequests).toEqual([]);
  expect(failures.consoleErrors).toEqual([]);
  expect(failures.pageErrors).toEqual([]);
  expect(failures.requestFailures).toEqual([]);
  expect(failures.unexpectedHttpErrors).toEqual([]);
});

test('US stock explicitly shows disconnected provider without fake levels', async ({ page }) => {
  const failures = captureFailures(page);
  const requests = await mockOrderbook(page, {
    ...readyPayload(),
    ok: false,
    available: false,
    status: 'unavailable',
    market: 'US',
    exchange: 'US',
    ticker: 'AAPL',
    currency: 'USD',
    provider: null,
    source: null,
    asks: [],
    bids: [],
    bestAsk: null,
    bestBid: null,
    spread: null,
    spreadPercent: null,
    displayedAskQuantity: 0,
    displayedBidQuantity: 0,
    totalAskQuantity: null,
    totalBidQuantity: null,
    imbalance: null,
    warnings: [],
    reason: 'US_ORDERBOOK_PROVIDER_NOT_CONNECTED',
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/__phase13-orderbook-e2e?ticker=AAPL&market=US');

  const dialog = page.getByRole('dialog', { name: /AAPL 호가창/ });
  await expect(dialog.getByText('호가 제공 불가')).toBeVisible();
  await expect(dialog.getByText(/미국 주식 호가 공급자는 아직 연결되지 않았습니다/)).toBeVisible();
  await expect(dialog.getByTestId(/ask-level|bid-level/)).toHaveCount(0);

  expect(requests.mutationRequests).toEqual([]);
  expect(requests.privateRequests).toEqual([]);
  expect(failures.consoleErrors).toEqual([]);
  expect(failures.pageErrors).toEqual([]);
  expect(failures.requestFailures).toEqual([]);
  expect(failures.unexpectedHttpErrors).toEqual([]);
});

test('crossed orderbook is blocked instead of rendered', async ({ page }) => {
  const failures = captureFailures(page);
  const requests = await mockOrderbook(page, {
    ...readyPayload(),
    ok: false,
    available: false,
    status: 'invalid',
    asks: [],
    bids: [],
    bestAsk: null,
    bestBid: null,
    spread: null,
    spreadPercent: null,
    displayedAskQuantity: 0,
    displayedBidQuantity: 0,
    warnings: [
      '최우선 매수호가가 최우선 매도호가 이상인 교차 호가여서 표시를 차단했습니다.',
    ],
    reason: 'ORDERBOOK_CROSSED',
  });

  await page.goto('/__phase13-orderbook-e2e?ticker=005930&market=KR');

  const dialog = page.getByRole('dialog', { name: /005930 호가창/ });
  await expect(dialog.getByText(/교차 호가가 감지되어 안전을 위해 표시를 차단했습니다/)).toBeVisible();
  await expect(dialog.getByText(/교차 호가여서 표시를 차단했습니다/)).toBeVisible();
  await expect(dialog.getByTestId(/ask-level|bid-level/)).toHaveCount(0);

  expect(requests.mutationRequests).toEqual([]);
  expect(requests.privateRequests).toEqual([]);
  expect(failures.consoleErrors).toEqual([]);
  expect(failures.pageErrors).toEqual([]);
  expect(failures.requestFailures).toEqual([]);
  expect(failures.unexpectedHttpErrors).toEqual([]);
});
